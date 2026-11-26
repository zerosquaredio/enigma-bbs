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

//
//  The board's art, published from its own AT account as asset records
//  (assets spec §3, §4.3): each piece in atProto.publishing.assets, with its
//  ANSI file uploaded as a blob, and a catalogue of them. A hub fetches the
//  files from the account's host, so the art stays available while the
//  board is offline, then cleans, draws and credits each piece itself.
//
//  Each record is keyed by its file's SHA-256, so unchanged art is never
//  uploaded again; pieces taken off the list are deleted. Everything here
//  is public, and the art must be the board's to share: each piece says its
//  licence.
//

exports.pieces = pieces;
exports.buildItem = buildItem;
exports.publishAssets = publishAssets;

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
//  licence, rating, themes, credit }, each naming its art by name or path.
//  Entries that don't name any are left out, with a warning.
//
function pieces(config = Config()) {
    const listed = _.castArray(_.get(config, 'atProto.publishing.assets', []));
    const out = [];
    listed.forEach((entry, i) => {
        const piece = _.isString(entry) ? { art: entry } : entry;
        if (!_.isPlainObject(piece) || !text(piece.art, 1024)) {
            Log.warn(
                { index: i },
                'atProto.publishing.assets: an entry names no art; left out'
            );
            return;
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
            art: piece.art.trim(),
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
    return out;
}

//  The record for a piece and its uploaded file
function buildItem(piece, file, blob, config = Config(), now = new Date()) {
    const name =
        piece.name ||
        require('path')
            .basename(file.path)
            .replace(/\.[^.]*$/, '');
    const boardName = _.get(config, 'general.boardName', 'ENiGMA½ BBS');
    return {
        $type: assetTypes(nsidPrefix(config)).item,
        name,
        description: {
            short: piece.description || `${name}: ANSI art from ${boardName}`,
        },
        kind: 'art',
        themes: piece.themes,
        versions: [
            {
                form: 'ansi',
                file: { sha256: file.sha256, size: file.size, mediaType: file.mediaType },
                blob,
                made: 'hand',
            },
        ],
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
//  kept, removed, missing }), |missing| naming art that wasn't found.
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
    const wanted = pieces(config);
    const result = { added: [], kept: [], removed: [], missing: [] };

    //  each piece's file
    series(
        wanted,
        (piece, next) =>
            Splash.findNamed(piece.art, config, file => {
                if (!file) {
                    result.missing.push(piece.art);
                }
                return next(null, file ? { piece, file } : null);
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
                const stale = existing.filter(
                    r => !byHash.has(r.rkey) && RkeyRe.test(r.rkey)
                );
                const add = [...byHash.values()].filter(f => !have.has(f.file.sha256));
                const refs = [...byHash.keys()]
                    .filter(hash => have.has(hash))
                    .map(hash => {
                        result.kept.push(hash);
                        return { uri: have.get(hash).uri, cid: have.get(hash).cid };
                    });

                series(
                    add,
                    (f, next) =>
                        AtProtoOAuth.boardUploadBlob(
                            account.did,
                            f.file.body,
                            f.file.mediaType,
                            (err, blob) => {
                                if (err) {
                                    return next(err);
                                }
                                const record = buildItem(f.piece, f.file, blob, config);
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
                                writeCatalogue(account, types, refs, config, err => {
                                    if (err) {
                                        return cb(err);
                                    }
                                    Log.info(
                                        {
                                            added: result.added.length,
                                            kept: result.kept.length,
                                            removed: result.removed.length,
                                            missing: result.missing.length,
                                        },
                                        'Board art published'
                                    );
                                    return cb(null, result);
                                });
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
