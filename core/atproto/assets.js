/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const Log = require('../logger').log;
const { Errors } = require('../enig_error');
const AtProtoOAuth = require('./oauth_client');
const { assetTypes, DefaultNsidPrefix } = require('./const');
const Splash = require('./splash');

//  deps
const _ = require('lodash');
const crypto = require('crypto');
const fs = require('graceful-fs');
const paths = require('path');

//
//  The board's art, published from its own AT account as asset records
//  (assets spec §3, §4.3): each piece in atProto.publishing.assets, with its
//  ANSI file uploaded as a blob, and a catalogue of them. A hub fetches the
//  files from the account's host, so the art stays available while the
//  board is offline, then cleans, draws and credits each piece itself.
//
//  Each record is keyed by its file's SHA-256, so unchanged art is never
//  uploaded again; pieces taken off the list are deleted, the last of them
//  too. Everything here is public, and the art must be the board's to
//  share: each piece says its licence.
//
//  A piece may be a 3D model instead (3D slice build spec §3): a binary
//  glTF file (.glb) and the PNG picture that stands for it where a model
//  can't be shown. Both are uploaded, and the one record, keyed by the
//  model's SHA-256, has two versions: the model, then its picture. Only a
//  file's header is checked here, and its size: the hub checks the rest.
//  A listed model that can't be read just now (its file half copied, say)
//  doesn't take down what was published: see publishAssets().
//
//  A piece may also be a program, for live objects (build spec of the live
//  object slice, §3): a WebAssembly module (.wasm), its source, and a
//  manifest saying the sites it reaches, the values it sets and the credit
//  its data needs. Its record, keyed by the module's SHA-256, has two
//  versions, the module then its source, and the manifest beside them. A
//  program must say its licence, and may be copied and remixed when that
//  licence is an open one. Like a model, a listed program that can't be
//  read just now holds back deletions.
//

exports.pieces = pieces;
exports.buildItem = buildItem;
exports.buildModelItem = buildModelItem;
exports.buildProgramItem = buildProgramItem;
exports.publishAssets = publishAssets;
exports.listAll = listAll;
exports.DefaultModelMaxBytes = 8 * 1024 * 1024;
exports.ProgramMaxBytes = 1024 * 1024;
exports.SourceMaxBytes = 256 * 1024;

const GlbMediaType = 'model/gltf-binary';
const PngMediaType = 'image/png';
const WasmMediaType = 'application/wasm';
const SourceMediaType = 'text/plain';
const WasmSignature = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
//  licences under which anyone may copy and remix a program
const OpenLicences = [
    'MIT',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    'ISC',
    'MPL-2.0',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'LGPL-3.0-only',
    'AGPL-3.0-only',
    'CC0-1.0',
    'Unlicense',
];
const HostRe = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
const PngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MB = 1024 * 1024;

//  for pieces that don't give one
const DefaultLicence = {
    id: 'custom',
    text: "Shown with the board's consent. Ask the board before any other use.",
};
const Ratings = ['general', 'mature', 'adult'];
const RkeyRe = /^[0-9a-f]{64}$/;

function nsidPrefix(config) {
    return _.get(config, 'atProto.publishing.nsidPrefix', DefaultNsidPrefix);
}

const text = (value, max) =>
    _.isString(value) && value.trim() ? value.trim().slice(0, max) : undefined;

//
//  The pieces the sysop lists, normalized: { art, name, description,
//  licence, rating, themes, credit }, each naming its art by name or path;
//  a model has { model, image }, both paths, in place of |art|, and a
//  program { program, source, manifest }. Entries that can't be published
//  as written are left out, with a warning.
//
function pieces(config = Config()) {
    return listed(config).pieces;
}

//  What an entry names, for messages about it
const entryLabel = (piece, i) =>
    (_.isPlainObject(piece) &&
        (text(piece.name, 80) ||
            text(piece.model, 1024) ||
            text(piece.program, 1024) ||
            text(piece.art, 1024))) ||
    `entry ${i + 1}`;

//
//  As pieces(), with the entries that can't be published as written:
//  { pieces, refused: [ { entry, reason } ], modelsRefused }, the last
//  counting those of |refused| that are models, or meant as one.
//
function listed(config) {
    const entries = _.castArray(_.get(config, 'atProto.publishing.assets', []));
    const out = [];
    const refused = [];
    let modelsRefused = 0;
    entries.forEach((entry, i) => {
        const piece = _.isString(entry) ? { art: entry } : entry;
        const isModel = _.isPlainObject(piece) && !!text(piece.model, 1024);
        const isProgram = _.isPlainObject(piece) && !!text(piece.program, 1024);
        const refuse = reason => {
            Log.warn(
                { index: i, reason },
                'atProto.publishing.assets: an entry cannot be published; left out'
            );
            refused.push({ entry: entryLabel(piece, i), reason });
            if (_.isPlainObject(piece) && (piece.model || piece.image || piece.program)) {
                modelsRefused += 1;
            }
        };
        if (
            !_.isPlainObject(piece) ||
            (!isModel && !isProgram && !text(piece.art, 1024))
        ) {
            return refuse(
                'it names no art, no model and no program: give "art", or "model" and "image", or "program" and "source"'
            );
        }
        if (isProgram && (isModel || text(piece.art, 1024))) {
            return refuse(
                'it names a program and art or a model: an entry is one of them, so list them apart'
            );
        }
        let manifest = null;
        if (isProgram) {
            if (!text(piece.source, 1024)) {
                return refuse(
                    'a program is published with its source: give "source", its path'
                );
            }
            if (!_.isPlainObject(piece.licence) || !text(piece.licence.id, 64)) {
                return refuse(
                    'a program says its licence: give "licence": { "id": "BSD-2-Clause", say }'
                );
            }
            manifest = programManifest(piece.manifest);
            if (_.isString(manifest)) {
                return refuse(manifest);
            }
        }
        if (isModel && text(piece.art, 1024)) {
            return refuse(
                'it names both art and a model: an entry is one or the other, so list them as two'
            );
        }
        if (isModel && !text(piece.image, 1024)) {
            return refuse(
                'a model needs a preview picture: give "image", the path to a PNG'
            );
        }
        const licence = _.isPlainObject(piece.licence)
            ? _.pickBy(
                  {
                      id: text(piece.licence.id, 64),
                      url: text(piece.licence.url, 512),
                      text: text(piece.licence.text, 500),
                  },
                  _.identity
              )
            : null;
        const rating = Ratings.includes(piece.rating) ? piece.rating : 'general';
        out.push({
            ...(isProgram
                ? { program: piece.program.trim(), source: piece.source.trim(), manifest }
                : isModel
                  ? { model: piece.model.trim(), image: piece.image.trim() }
                  : { art: piece.art.trim() }),
            name: text(piece.name, 80),
            description: text(piece.description, 300),
            licence: licence && licence.id ? licence : DefaultLicence,
            rating,
            themes: _.castArray(piece.themes || [])
                .map(t => text(t, 32))
                .filter(Boolean)
                .slice(0, 10),
            credit: _.isPlainObject(piece.credit)
                ? _.pickBy(
                      {
                          author: text(piece.credit.author, 80),
                          group: text(piece.credit.group, 80),
                          note: text(piece.credit.note, 200),
                      },
                      _.identity
                  )
                : {},
        });
    });
    return { pieces: out, refused, modelsRefused };
}

//  A program's manifest, checked: { fetch, values, credit }, or why not
function programManifest(m) {
    if (!_.isPlainObject(m)) {
        return 'a program has a "manifest": { "fetch": [ sites ], "values": "weather" }';
    }
    const fetch = _.castArray(m.fetch || []);
    if (
        fetch.length > 8 ||
        fetch.some(h => !_.isString(h) || !HostRe.test(h.toLowerCase()))
    ) {
        return 'its manifest\'s "fetch" lists at most 8 sites, by host name only: [ "api.open-meteo.com" ]';
    }
    const values = text(m.values, 32);
    if (!values) {
        return 'its manifest names the "values" it sets, a shared type: "weather", say';
    }
    const credit = [];
    for (const c of _.castArray(m.credit || []).slice(0, 3)) {
        const t = _.isPlainObject(c) && text(c.text, 80);
        const url = _.isPlainObject(c) && text(c.url, 512);
        if (!t || !url || !/^https:\/\/[^\s"'<>]+$/.test(url)) {
            return 'each of its manifest\'s "credit" has a "text" and an https "url"';
        }
        credit.push({ text: t, url });
    }
    return {
        fetch: _.uniq(fetch.map(h => h.toLowerCase())),
        values,
        ...(credit.length ? { credit } : {}),
    };
}

const fileOf = file => ({
    sha256: file.sha256,
    size: file.size,
    mediaType: file.mediaType,
});

//  The record for a piece and its uploaded file
function buildItem(piece, file, blob, config = Config(), now = new Date()) {
    return itemRecord(
        piece,
        file,
        'ANSI art',
        [{ form: 'ansi', file: fileOf(file), blob, made: 'hand' }],
        config,
        now
    );
}

//
//  The record for a model, its preview picture and their uploaded files
//  (|blobs|: { model, image }): the model first, then the picture
//
function buildModelItem(piece, model, image, blobs, config = Config(), now = new Date()) {
    return itemRecord(
        piece,
        model,
        'a 3D model',
        [
            { form: 'model', class: 'light', file: fileOf(model), blob: blobs.model },
            { form: 'image', file: fileOf(image), blob: blobs.image },
        ],
        config,
        now
    );
}

//
//  The record for a program, its source and their uploaded files (|blobs|:
//  { program, source }): the module first, then its source, the manifest
//  beside them
//
function buildProgramItem(
    piece,
    program,
    source,
    blobs,
    config = Config(),
    now = new Date()
) {
    const record = itemRecord(
        piece,
        program,
        'a program for live objects',
        [
            { form: 'program', file: fileOf(program), blob: blobs.program },
            { form: 'source', file: fileOf(source), blob: blobs.source },
        ],
        config,
        now
    );
    const open = OpenLicences.includes(piece.licence.id);
    return {
        ...record,
        kind: 'program',
        manifest: piece.manifest,
        permissions: {
            use: 'anyone',
            copy: open ? 'anyone' : 'nobody',
            restyle: 'nobody',
            remix: open ? 'anyone' : 'nobody',
        },
    };
}

//  A piece's record, named after |file| unless the piece gives a name
function itemRecord(piece, file, what, versions, config, now) {
    const name = piece.name || paths.basename(file.path).replace(/\.[^.]*$/, '');
    const boardName = _.get(config, 'general.boardName', 'ENiGMA½ BBS');
    return {
        $type: assetTypes(nsidPrefix(config)).item,
        name,
        description: {
            short: piece.description || `${name}: ${what} from ${boardName}`,
        },
        kind: 'art',
        themes: piece.themes,
        versions,
        rating: piece.rating,
        licence: piece.licence,
        //  shown by hubs; anything more needs a licence that allows it
        permissions: {
            use: 'anyone',
            copy: 'nobody',
            restyle: 'nobody',
            remix: 'nobody',
        },
        credit: piece.credit,
        createdAt: now.toISOString(),
    };
}

//  The largest model published (atProto.publishing.models.maxBytes)
function modelMaxBytes(config) {
    const max = _.get(config, 'atProto.publishing.models.maxBytes');
    return _.isFinite(max) && max > 0 ? max : exports.DefaultModelMaxBytes;
}

//  a size for messages: in kilobytes under a megabyte, bytes under one
const megabytes = bytes =>
    bytes < 1024
        ? `${bytes} bytes`
        : bytes < MB
          ? `${Math.round((bytes / 1024) * 10) / 10} KB`
          : `${Math.round((bytes / MB) * 10) / 10} MB`;

//  Why |body| isn't a binary glTF file, going by its header; null when it is
function glbProblem(body) {
    if (body.length < 12 || 'glTF' !== body.toString('latin1', 0, 4)) {
        return 'the model is not a binary glTF (.glb) file';
    }
    const version = body.readUInt32LE(4);
    if (2 !== version) {
        return `the model is glTF version ${version}: only version 2 is taken`;
    }
    const declared = body.readUInt32LE(8);
    if (declared !== body.length) {
        return `the model's header says it is ${declared} bytes long, but the file is ${body.length}: it is damaged or cut short`;
    }
    return null;
}

const isPng = body =>
    body.length > PngSignature.length &&
    0 === body.compare(PngSignature, 0, PngSignature.length, 0, PngSignature.length);

//
//  A model's or picture's file, |what| in messages, at most |maxBytes|: a
//  path, absolute or relative to the board's directory, as art's is. Calls
//  back with (problem, file): |file| as art's is ({ sha256, size,
//  mediaType, body, path }); |problem| is { missing } when there is no such
//  file, or { reason }.
//
function readFile(path, what, mediaType, maxBytes, cb) {
    const full = paths.isAbsolute(path) ? path : paths.join(__dirname, '../../', path);
    fs.stat(full, (err, stats) => {
        if (err || !stats.isFile()) {
            return cb({ missing: path });
        }
        const tooLarge = size => ({
            reason: `the ${what} is ${size < 1024 ? megabytes(size) : `${megabytes(size)} (${size} bytes)`}, over the limit of ${megabytes(maxBytes)} (atProto.publishing.models.maxBytes)`,
        });
        if (stats.size > maxBytes) {
            return cb(tooLarge(stats.size));
        }
        fs.readFile(full, (err, body) => {
            if (err) {
                return cb({ missing: path });
            }
            //  it may have grown since
            if (body.length > maxBytes) {
                return cb(tooLarge(body.length));
            }
            return cb(null, {
                sha256: crypto.createHash('sha256').update(body).digest('hex'),
                size: body.length,
                mediaType,
                body,
                path: full,
            });
        });
    });
}

//
//  A piece's files: calls back with { piece, file }, and { image } beside
//  them for a model, or with { missing } or { reason } when it can't be
//  published
//
function findFiles(piece, config, cb) {
    if (piece.program) {
        return readFile(
            piece.program,
            'program',
            WasmMediaType,
            exports.ProgramMaxBytes,
            (problem, program) => {
                if (problem) {
                    return cb(problem);
                }
                if (
                    program.body.length < 8 ||
                    0 !== program.body.compare(WasmSignature, 0, 8, 0, 8)
                ) {
                    return cb({
                        reason: 'the program is not a WebAssembly module (.wasm) of version 1',
                    });
                }
                return readFile(
                    piece.source,
                    'source',
                    SourceMediaType,
                    exports.SourceMaxBytes,
                    (problem, source) => {
                        if (problem) {
                            return cb(problem);
                        }
                        try {
                            new TextDecoder('utf-8', { fatal: true }).decode(source.body);
                        } catch (e) {
                            return cb({
                                reason: "the program's source is not UTF-8 text",
                            });
                        }
                        return cb({ piece, file: program, source });
                    }
                );
            }
        );
    }
    if (!piece.model) {
        return Splash.findNamed(piece.art, config, file =>
            cb(file ? { piece, file } : { missing: piece.art })
        );
    }
    const max = modelMaxBytes(config);
    return readFile(piece.model, 'model', GlbMediaType, max, (problem, model) => {
        if (problem) {
            return cb(problem);
        }
        const reason = glbProblem(model.body);
        if (reason) {
            return cb({ reason });
        }
        return readFile(
            piece.image,
            'preview picture',
            PngMediaType,
            max,
            (problem, image) => {
                if (problem) {
                    return cb(problem);
                }
                if (!isPng(image.body)) {
                    return cb({ reason: 'the preview picture is not a PNG file' });
                }
                return cb({ piece, file: model, image });
            }
        );
    });
}

const versionOf = (record, form) =>
    _.find(_.get(record, 'value.versions'), v => v && form === v.form);

//
//  Upload a piece's files and call back with its record. A model whose
//  picture alone changed (|published|, its record now) keeps the model
//  file the host already has. What the host says when it refuses a model
//  or its picture is passed on, with the file's name.
//
function uploadPiece(account, f, published, config, cb) {
    const upload = (file, next) =>
        AtProtoOAuth.boardUploadBlob(
            account.did,
            file.body,
            file.mediaType,
            (err, blob) => {
                if (err && (f.image || f.source)) {
                    const about = Errors.General(
                        `${paths.basename(file.path)}: ${err.reason || err.message}`,
                        err.reasonCode
                    );
                    about.status = err.status;
                    about.error = err.error;
                    return next(about);
                }
                return next(err, blob);
            }
        );
    if (f.source) {
        return upload(f.file, (err, program) =>
            err
                ? cb(err)
                : upload(f.source, (err, source) =>
                      err
                          ? cb(err)
                          : cb(
                                null,
                                buildProgramItem(
                                    f.piece,
                                    f.file,
                                    f.source,
                                    { program, source },
                                    config
                                )
                            )
                  )
        );
    }
    if (!f.image) {
        return upload(f.file, (err, blob) =>
            err ? cb(err) : cb(null, buildItem(f.piece, f.file, blob, config))
        );
    }
    const withModel = (err, model) => {
        if (err) {
            return cb(err);
        }
        return upload(f.image, (err, image) =>
            err
                ? cb(err)
                : cb(
                      null,
                      buildModelItem(f.piece, f.file, f.image, { model, image }, config)
                  )
        );
    };
    const had = _.get(versionOf(published, 'model'), 'blob');
    return had ? withModel(null, had) : upload(f.file, withModel);
}

//  Every record of |collection| in the account: [{ uri, cid, rkey, value }]
function listAll(did, collection, cb) {
    const out = [];
    const page = cursor =>
        AtProtoOAuth.boardRequest(
            did,
            'GET',
            'com.atproto.repo.listRecords',
            { repo: did, collection, limit: 100, cursor },
            (err, result) => {
                if (err) {
                    return cb(err);
                }
                for (const r of _.get(result, 'records', [])) {
                    out.push({
                        uri: r.uri,
                        cid: r.cid,
                        rkey: String(r.uri).split('/').pop(),
                        value: r.value,
                    });
                }
                return result && result.cursor && out.length < 10000
                    ? page(result.cursor)
                    : cb(null, out);
            }
        );
    return page(undefined);
}

//  |fn| over |list| one at a time; cb(err, results)
function series(list, fn, cb) {
    const results = [];
    const next = i => {
        if (i >= list.length) {
            return cb(null, results);
        }
        fn(list[i], (err, result) => {
            if (err) {
                return cb(err);
            }
            results.push(result);
            return next(i + 1);
        });
    };
    return next(0);
}

//
//  Publish the pieces: upload and write what is new, delete what was taken
//  off the list, and write the catalogue. Calls back with (err, { added,
//  kept, removed, held, missing, refused }), |missing| naming art and files
//  that weren't found, |refused| the entries that can't be published and
//  why ([ { entry, reason } ]): both are left out, and the rest is
//  published.
//
//  With nothing listed, what was published is deleted and the catalogue
//  emptied; an account that never had any art is left as it is.
//
//  A model already published is keyed by its file's hash, so when a listed
//  model can't be read, or fails a check, there is no telling which record
//  was its own. While any listed model is in that state, no model's record
//  is deleted: they are |held|, and stay in the catalogue, so a file
//  missing or half copied when this runs doesn't withdraw a model from the
//  hubs showing it. Taking the entry off the list, or mending it, lets
//  the deletions through.
//
function publishAssets(cb) {
    const config = Config();
    const Publishing = require('./publishing');
    const account = Publishing.getBoardAccount();
    if (!account) {
        return setImmediate(() =>
            cb(Errors.DoesNotExist('No board account is connected'))
        );
    }
    const types = assetTypes(nsidPrefix(config));
    const wanted = listed(config);
    const result = {
        added: [],
        kept: [],
        removed: [],
        held: [],
        missing: [],
        refused: wanted.refused,
    };
    //  listed models that aren't published this time
    let modelsOut = wanted.modelsRefused;

    //  each piece's file, or files
    series(
        wanted.pieces,
        (piece, next) =>
            findFiles(piece, config, found => {
                if ((piece.model || piece.program) && !found.file) {
                    modelsOut += 1;
                }
                if (found.missing) {
                    result.missing.push(found.missing);
                } else if (found.reason) {
                    const entry = piece.name || piece.model || piece.program;
                    Log.warn(
                        { entry, reason: found.reason },
                        'atProto.publishing.assets: an entry cannot be published; left out'
                    );
                    result.refused.push({ entry, reason: found.reason });
                }
                return next(null, found.file ? found : null);
            }),
        (err, found) => {
            const byHash = new Map();
            for (const f of found.filter(Boolean)) {
                //  the same art listed twice is published once
                if (!byHash.has(f.file.sha256)) {
                    byHash.set(f.file.sha256, f);
                }
            }
            listAll(account.did, types.item, (err, existing) => {
                if (err) {
                    return cb(err);
                }
                const have = new Map(existing.map(r => [r.rkey, r]));
                const unlisted = existing.filter(
                    r => !byHash.has(r.rkey) && RkeyRe.test(r.rkey)
                );
                //  a model's record waits while a listed model can't be
                //  published: it may be that one's
                const [held, stale] = _.partition(
                    unlisted,
                    r =>
                        modelsOut > 0 &&
                        (versionOf(r, 'model') || versionOf(r, 'program'))
                );
                //  a model published with another picture is written again
                //  and a program with another source or manifest
                const unchanged = f =>
                    have.has(f.file.sha256) &&
                    (!f.image ||
                        f.image.sha256 ===
                            _.get(
                                versionOf(have.get(f.file.sha256), 'image'),
                                'file.sha256'
                            )) &&
                    (!f.source ||
                        (f.source.sha256 ===
                            _.get(
                                versionOf(have.get(f.file.sha256), 'source'),
                                'file.sha256'
                            ) &&
                            _.isEqual(
                                f.piece.manifest,
                                _.get(have.get(f.file.sha256), 'value.manifest')
                            )));
                const add = [...byHash.values()].filter(f => !unchanged(f));
                const refs = [...byHash.keys()]
                    .filter(hash => unchanged(byHash.get(hash)))
                    .map(hash => {
                        result.kept.push(hash);
                        return { uri: have.get(hash).uri, cid: have.get(hash).cid };
                    });

                series(
                    add,
                    (f, next) =>
                        uploadPiece(
                            account,
                            f,
                            have.get(f.file.sha256),
                            config,
                            (err, record) => {
                                if (err) {
                                    return next(err);
                                }
                                AtProtoOAuth.boardRequest(
                                    account.did,
                                    'POST',
                                    'com.atproto.repo.putRecord',
                                    {
                                        repo: account.did,
                                        collection: types.item,
                                        rkey: f.file.sha256,
                                        record,
                                    },
                                    (err, written) => {
                                        if (err) {
                                            return next(err);
                                        }
                                        result.added.push(f.file.sha256);
                                        refs.push({ uri: written.uri, cid: written.cid });
                                        return next(null);
                                    }
                                );
                            }
                        ),
                    err => {
                        if (err) {
                            return cb(err);
                        }
                        series(
                            stale,
                            (r, next) =>
                                AtProtoOAuth.boardRequest(
                                    account.did,
                                    'POST',
                                    'com.atproto.repo.deleteRecord',
                                    {
                                        repo: account.did,
                                        collection: types.item,
                                        rkey: r.rkey,
                                    },
                                    err => {
                                        if (!err) {
                                            result.removed.push(r.rkey);
                                        }
                                        return next(err);
                                    }
                                ),
                            err => {
                                if (err) {
                                    return cb(err);
                                }
                                for (const r of held) {
                                    result.held.push(r.rkey);
                                    refs.push({ uri: r.uri, cid: r.cid });
                                }
                                const write = () =>
                                    writeCatalogue(account, types, refs, config, err => {
                                        if (err) {
                                            return cb(err);
                                        }
                                        Log.info(
                                            {
                                                added: result.added.length,
                                                kept: result.kept.length,
                                                removed: result.removed.length,
                                                held: result.held.length,
                                                missing: result.missing.length,
                                                refused: result.refused.length,
                                            },
                                            'Board art published'
                                        );
                                        return cb(null, result);
                                    });
                                if (refs.length || result.removed.length) {
                                    return write();
                                }
                                //  nothing to list and nothing deleted: only
                                //  a catalogue still naming pieces is emptied
                                return listAll(
                                    account.did,
                                    types.catalogue,
                                    (err, catalogues) => {
                                        if (err) {
                                            return cb(err);
                                        }
                                        const self = _.find(catalogues, {
                                            rkey: 'self',
                                        });
                                        return _.get(self, 'value.items', []).length
                                            ? write()
                                            : cb(null, result);
                                    }
                                );
                            }
                        );
                    }
                );
            });
        }
    );
}

//  The catalogue: the board's pieces, in the order listed
function writeCatalogue(account, types, refs, config, cb) {
    const boardName = _.get(config, 'general.boardName', 'ENiGMA½ BBS');
    return AtProtoOAuth.boardRequest(
        account.did,
        'POST',
        'com.atproto.repo.putRecord',
        {
            repo: account.did,
            collection: types.catalogue,
            rkey: 'self',
            record: {
                $type: types.catalogue,
                name: `${boardName}'s art`,
                items: refs.map(ref => ({ uri: ref.uri, cid: ref.cid })),
                createdAt: new Date().toISOString(),
            },
        },
        err => cb(err)
    );
}
