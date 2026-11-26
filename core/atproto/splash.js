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
//  The board's splash screen: the ANSI art a caller first sees, which its
//  hub may show on its directory and the board's own page, with the sysop's
//  consent (publishing.js, assets spec §4.3). The board offers the file as
//  it is, named in its listing by its SHA-256 and served at
//  /assets/<sha256>; the hub cleans it, blanks ENiGMA½'s menu codes, draws
//  it, and credits it from its SAUCE.
//
//  By default it is the board's CONNECT art, if its pre-login theme or the
//  general art directory has one, otherwise its login matrix (MATRIX):
//  atProto.publishing.splash.art names others, in order, or files by path.
//

//  as the hub takes ANSI art (hub/control/src/ansi.ts)
const MaxBytes = 64 * 1024;
const DefaultArt = ['CONNECT', 'MATRIX'];
const AssetPathRe = /^\/assets\/([0-9a-f]{64})$/;

exports.MaxBytes = MaxBytes;
exports.AssetPathRe = AssetPathRe;
exports.find = find;
exports.served = served;
exports.lookup = lookup;
exports.current = () => current;
exports._reset = () => {
    current = null;
};

//  the splash last found, served at /assets/<its sha256>
let current = null;

function artNames(config) {
    const names = _.castArray(_.get(config, 'atProto.publishing.splash.art', DefaultArt));
    return names.filter(n => _.isString(n) && n.trim()).map(n => n.trim());
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

//
//  The splash, as { sha256, size, mediaType, body, path }, or null when the
//  board has none it can offer (none found, not ANSI, or too large)
//
function find(config = Config(), cb) {
    if (!cb && _.isFunction(config)) {
        cb = config;
        config = Config();
    }
    const names = artNames(config);
    const dirs = directories(config);

    const tryName = i => {
        if (i >= names.length) {
            current = null;
            return cb(null);
        }
        const name = names[i];
        const next = () => tryName(i + 1);
        const done = found => {
            if (!found) {
                return next();
            }
            current = found;
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

//  The bytes of the splash with this hash, if it is the one offered now
function served(sha256) {
    return current && current.sha256 === sha256 ? current.body : null;
}

//
//  As served(), but looking for the splash again when this hash isn't the
//  one last found: the listing may have been published by another process
//  (oputil), or the art changed since. Calls back with the bytes or null.
//
function lookup(sha256, config, cb) {
    if (!cb && _.isFunction(config)) {
        cb = config;
        config = Config();
    }
    const known = served(sha256);
    if (known) {
        return setImmediate(() => cb(known));
    }
    return find(config, found =>
        cb(found && found.sha256 === sha256 ? found.body : null)
    );
}
