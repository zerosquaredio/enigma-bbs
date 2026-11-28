/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const Log = require('../logger').log;
const { Errors } = require('../enig_error');
const AtProtoOAuth = require('./oauth_client');
const { assetTypes, objectTypes, DefaultNsidPrefix } = require('./const');

//  deps
const _ = require('lodash');
const crypto = require('crypto');
const fs = require('graceful-fs');
const paths = require('path');

//
//  The board's live objects, published from its own AT account (build spec
//  of the live object slice, §3): each entry in atProto.publishing.objects
//  becomes a record of its own, keyed by the name the sysop gives it,
//  naming a program (by its module's hash, and the record that publishes
//  it) and the program's input. A hub that runs live objects runs the
//  program, if its admin has vetted it, and shows what it computes.
//
//  The program is published as art is (assets.js, an entry with "program"
//  and "source"); an object names it by its module's path, which is hashed
//  here, or by { sha256, did } for a program another account publishes.
//
//  Everything here is public, the input too: a place name or coordinates
//  given to a weather program, say, is there for anyone to read.
//  Objects taken off the list are deleted.
//

exports.objects = objects;
exports.buildObject = buildObject;
exports.publishObjects = publishObjects;
exports.MaxInputBytes = 1024;
exports.MinInterval = 60;
exports.MaxInterval = 24 * 60 * 60;

const RkeyRe = /^[A-Za-z0-9._~-]{1,64}$/;
const DidRe = /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,200}$/;
const Sha256Re = /^[0-9a-f]{64}$/;

function nsidPrefix(config) {
    return _.get(config, 'atProto.publishing.nsidPrefix', DefaultNsidPrefix);
}

//  |value| trimmed and cut to |max| characters (code points, which never
//  outnumber what a person sees as characters, so it fits the Lexicons'
//  grapheme limits); undefined when empty
const text = (value, max) =>
    _.isString(value) && value.trim()
        ? Array.from(value.trim()).slice(0, max).join('')
        : undefined;

//
//  The objects the sysop lists, normalized: { name, title, program: { path }
//  or { sha256, did }, input, interval }. Calls back with { objects,
//  refused: [ { entry, reason } ] }; a program named by its path is read
//  and hashed here.
//
function objects(config, cb) {
    const entries = _.castArray(_.get(config, 'atProto.publishing.objects', []));
    const out = [];
    const refused = [];
    const seen = new Set();
    const refuse = (entry, reason) => {
        Log.warn(
            { entry, reason },
            'atProto.publishing.objects: an entry cannot be published; left out'
        );
        refused.push({ entry, reason });
    };
    const next = i => {
        if (i >= entries.length) {
            return cb({ objects: out, refused });
        }
        const e = entries[i];
        const label = (_.isPlainObject(e) && text(e.name, 64)) || `entry ${i + 1}`;
        if (!_.isPlainObject(e)) {
            refuse(
                label,
                'it is not an object: give "name", "title", "program" and "input"'
            );
            return next(i + 1);
        }
        const name = text(e.name, 100);
        if (!name || !RkeyRe.test(name)) {
            refuse(
                label,
                'its "name" is its key: 1 to 64 letters, digits, ".", "_", "~" or "-"'
            );
            return next(i + 1);
        }
        if (seen.has(name)) {
            refuse(label, 'another object has the same "name"');
            return next(i + 1);
        }
        const input = undefined === e.input ? {} : e.input;
        if (!_.isPlainObject(input)) {
            refuse(
                label,
                'its "input" is an object, as its program expects: { "name": "Berlin" }, say'
            );
            return next(i + 1);
        }
        if (Buffer.byteLength(JSON.stringify(input)) > exports.MaxInputBytes) {
            refuse(
                label,
                `its "input" is more than ${exports.MaxInputBytes} bytes as JSON`
            );
            return next(i + 1);
        }
        //  every ten minutes unless it says; within a minute and a day
        const interval = _.isInteger(e.interval)
            ? Math.min(Math.max(e.interval, exports.MinInterval), exports.MaxInterval)
            : 600;
        const keep = program => {
            seen.add(name);
            out.push({
                name,
                title: text(e.title, 60) || name,
                program,
                input,
                interval,
            });
            return next(i + 1);
        };
        const program = e.program;
        if (_.isPlainObject(program)) {
            const sha256 = text(program.sha256, 64);
            const did = text(program.did, 260);
            if (!sha256 || !Sha256Re.test(sha256) || (did && !DidRe.test(did))) {
                refuse(
                    label,
                    'its "program" is a path to the module, or { "sha256": …, "did": … }'
                );
                return next(i + 1);
            }
            return keep({ sha256, did });
        }
        const path = text(program, 1024);
        if (!path) {
            refuse(label, 'it names no "program": give the path to its module (.wasm)');
            return next(i + 1);
        }
        const full = paths.isAbsolute(path)
            ? path
            : paths.join(__dirname, '../../', path);
        return fs.readFile(full, (err, body) => {
            if (err) {
                refuse(label, `its program, ${path}, can't be read`);
                return next(i + 1);
            }
            return keep({
                sha256: crypto.createHash('sha256').update(body).digest('hex'),
            });
        });
    };
    return next(0);
}

//  An object's record, for the board's account |did|
function buildObject(o, did, config = Config(), now = new Date()) {
    const prefix = nsidPrefix(config);
    const sha256 = o.program.sha256;
    return {
        $type: objectTypes(prefix).object,
        title: o.title,
        program: {
            sha256,
            uri: `at://${o.program.did || did}/${assetTypes(prefix).item}/${sha256}`,
        },
        input: o.input,
        interval: o.interval,
        look: { kind: 'badge' },
        createdAt: now.toISOString(),
    };
}

//  Whether a published record says the same as |record|, but for its time
const same = (published, record) =>
    _.isEqual(
        _.omit(_.get(published, 'value'), ['createdAt']),
        _.omit(record, ['createdAt'])
    );

//  |fn| over |list| one at a time; cb(err)
function series(list, fn, cb) {
    const next = i =>
        i >= list.length ? cb(null) : fn(list[i], err => (err ? cb(err) : next(i + 1)));
    return next(0);
}

//
//  Publish the objects: write what is new or changed, delete what was taken
//  off the list. Calls back with (err, { added, changed, kept, removed,
//  refused }). Needs the account to allow the object record type: one
//  connected before it was asked for is connected again first.
//
function publishObjects(cb) {
    const config = Config();
    const Publishing = require('./publishing');
    const Assets = require('./assets');
    const account = Publishing.getBoardAccount();
    if (!account) {
        return setImmediate(() =>
            cb(Errors.DoesNotExist('No board account is connected'))
        );
    }
    const collection = objectTypes(nsidPrefix(config)).object;
    if ((Publishing.missingPermissions(config) || []).includes(`repo:${collection}`)) {
        return setImmediate(() =>
            cb(
                Errors.AccessDenied(
                    "The board account doesn't allow publishing live objects yet: connect it again from the board account menu"
                )
            )
        );
    }
    return objects(config, wanted => {
        const result = {
            added: [],
            changed: [],
            kept: [],
            removed: [],
            refused: wanted.refused,
        };
        Assets.listAll(account.did, collection, (err, existing) => {
            if (err) {
                return cb(err);
            }
            const have = new Map(existing.map(r => [r.rkey, r]));
            const listed = new Set(wanted.objects.map(o => o.name));
            series(
                wanted.objects,
                (o, next) => {
                    const record = buildObject(o, account.did, config);
                    const published = have.get(o.name);
                    if (published && same(published, record)) {
                        result.kept.push(o.name);
                        return next(null);
                    }
                    return AtProtoOAuth.boardRequest(
                        account.did,
                        'POST',
                        'com.atproto.repo.putRecord',
                        { repo: account.did, collection, rkey: o.name, record },
                        err => {
                            if (!err) {
                                (published ? result.changed : result.added).push(o.name);
                            }
                            return next(err);
                        }
                    );
                },
                err => {
                    if (err) {
                        return cb(err);
                    }
                    series(
                        existing.filter(r => !listed.has(r.rkey)),
                        (r, next) =>
                            AtProtoOAuth.boardRequest(
                                account.did,
                                'POST',
                                'com.atproto.repo.deleteRecord',
                                { repo: account.did, collection, rkey: r.rkey },
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
                            Log.info(
                                {
                                    added: result.added.length,
                                    changed: result.changed.length,
                                    kept: result.kept.length,
                                    removed: result.removed.length,
                                    refused: result.refused.length,
                                },
                                'Board live objects published'
                            );
                            return cb(null, result);
                        }
                    );
                }
            );
        });
    });
}
