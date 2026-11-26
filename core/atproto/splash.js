/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;

//  deps
const _ = require('lodash');
const crypto = require('crypto');
const fs = require('graceful-fs');
const paths = require('path');

//
//  The board's art for its hub (assets spec §4.3): its splash screen and its
//  emblem. The board offers each file as it is, named in its listing by its
//  SHA-256 and served at /assets/<sha256>; the hub cleans it, blanks
//  ENiGMA½'s menu codes, draws it, and credits it from its SAUCE.
//
//  The splash screen is the ANSI art a caller first sees, shown on the hub's
//  directory and the board's own page, with the sysop's consent
//  (publishing.js). By default it is the board's CONNECT art, if its
//  pre-login theme or the general art directory has one, otherwise its
//  login matrix (MATRIX): atProto.publishing.splash.art names others, in
//  order, or files by path.
//
//  The emblem is a small logo that stands for the board on the hub's map.
//  There is none by default: the sysop names it in
//  atProto.publishing.emblem.art, which is their consent to offering it.
//

//  as the hub takes ANSI art (hub/control/src/ansi.ts)
const MaxBytes = 64 * 1024;
const DefaultSplashArt = ['CONNECT', 'MATRIX'];
const AssetPathRe = /^\/assets\/([0-9a-f]{64})$/;

exports.MaxBytes = MaxBytes;
exports.AssetPathRe = AssetPathRe;
exports.find = find;
exports.findEmblem = findEmblem;
exports.emblemNamed = emblemNamed;
exports.served = served;
exports.lookup = lookup;
exports.current = () => current.splash;
exports.currentEmblem = () => current.emblem;
exports._reset = () => {
    current = { splash: null, emblem: null };
};

//  the art last found, by kind, served at /assets/<its sha256>
let current = { splash: null, emblem: null };

function names(value) {
    return _.castArray(value)
        .filter(n => _.isString(n) && n.trim())
        .map(n => n.trim());
}

function splashNames(config) {
    return names(_.get(config, 'atProto.publishing.splash.art', DefaultSplashArt));
}

function emblemNames(config) {
    return names(_.get(config, 'atProto.publishing.emblem.art', []));
}

//  Whether the sysop has named an emblem
function emblemNamed(config = Config()) {
    return emblemNames(config).length > 0;
}

//  The theme callers see before logging in: none when it is random
function preLoginTheme(config) {
    const theme = _.get(config, 'theme.preLogin');
    const chosen = '*' === theme || !theme ? _.get(config, 'theme.default') : theme;
    return _.isString(chosen) && chosen && '*' !== chosen ? chosen : null;
}

//  Where a named piece of art may be: the pre-login theme, then the general
//  art directory (as ENiGMA½ looks for a menu's art)
function directories(config) {
    const out = [];
    const theme = preLoginTheme(config);
    if (theme && _.isString(_.get(config, 'paths.themes'))) {
        out.push(paths.join(config.paths.themes, theme));
    }
    if (_.isString(_.get(config, 'paths.art'))) {
        out.push(config.paths.art);
    }
    return out;
}

//  The ANSI file for |name| in |dir|: NAME.ANS, or ENiGMA½'s first random
//  variant, NAME1.ANS, in any case
function fileIn(dir, name, cb) {
    fs.readdir(dir, (err, files) => {
        if (err) {
            return cb(null);
        }
        const wanted = [`${name}.ANS`, `${name}1.ANS`].map(f => f.toUpperCase());
        for (const want of wanted) {
            const found = files.find(f => f.toUpperCase() === want);
            if (found) {
                return cb(paths.join(dir, found));
            }
        }
        return cb(null);
    });
}

function read(path, cb) {
    fs.readFile(path, (err, body) => {
        if (err || body.length === 0 || body.length > MaxBytes) {
            return cb(null);
        }
        return cb({
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
            size: body.length,
            mediaType: 'text/x-ansi',
            body,
            path,
        });
    });
}

//  The first of |wanted| that can be offered, remembered as |kind|
function findArt(kind, wanted, config, cb) {
    const dirs = directories(config);
    const tryName = i => {
        if (i >= wanted.length) {
            current[kind] = null;
            return cb(null);
        }
        const name = wanted[i];
        const next = () => tryName(i + 1);
        const done = found => {
            if (!found) {
                return next();
            }
            current[kind] = found;
            return cb(found);
        };
        //  a path, absolute or relative to the board's directory
        if (name.includes('/')) {
            if ('.ans' !== paths.extname(name).toLowerCase()) {
                return next();
            }
            const full = paths.isAbsolute(name)
                ? name
                : paths.join(__dirname, '../../', name);
            return read(full, done);
        }
        const tryDir = j => {
            if (j >= dirs.length) {
                return next();
            }
            fileIn(dirs[j], name, path => (path ? read(path, done) : tryDir(j + 1)));
        };
        return tryDir(0);
    };
    return tryName(0);
}

const withConfig = (config, cb) =>
    !cb && _.isFunction(config) ? [Config(), config] : [config || Config(), cb];

//
//  The splash, as { sha256, size, mediaType, body, path }, or null when the
//  board has none it can offer (none found, not ANSI, or too large)
//
function find(config, cb) {
    [config, cb] = withConfig(config, cb);
    return findArt('splash', splashNames(config), config, cb);
}

//  The emblem, likewise; null when the sysop names none
function findEmblem(config, cb) {
    [config, cb] = withConfig(config, cb);
    return findArt('emblem', emblemNames(config), config, cb);
}

//  Which art has this hash, of what was last found: 'splash', 'emblem' or null
function kindOf(sha256) {
    return _.findKey(current, found => found && found.sha256 === sha256) || null;
}

//  The bytes of the art with this hash, if it is offered now
function served(sha256) {
    const kind = kindOf(sha256);
    return kind ? current[kind].body : null;
}

//
//  As served(), but looking for the art again when this hash isn't what
//  was last found: the listing may have been published by another process
//  (oputil), or the art changed since. Calls back with { kind, body } or
//  null.
//
function lookup(sha256, config, cb) {
    [config, cb] = withConfig(config, cb);
    const known = kindOf(sha256);
    if (known) {
        return setImmediate(() => cb({ kind: known, body: current[known].body }));
    }
    return find(config, splash => {
        if (splash && splash.sha256 === sha256) {
            return cb({ kind: 'splash', body: splash.body });
        }
        return findEmblem(config, emblem =>
            cb(
                emblem && emblem.sha256 === sha256
                    ? { kind: 'emblem', body: emblem.body }
                    : null
            )
        );
    });
}
