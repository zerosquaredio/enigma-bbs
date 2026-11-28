/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const Log = require('../logger').log;
const { Errors, ErrorReasons } = require('../enig_error');
const { dbs } = require('../database');
const { getBaseUrl } = require('../web_util');
const AtProtoOAuth = require('./oauth_client');
const Splash = require('./splash');
const {
    recordTypes,
    objectTypes,
    DefaultNsidPrefix,
    PostCollection,
    boardScope,
} = require('./const');

//  deps
const crypto = require('crypto');
const net = require('net');
const _ = require('lodash');

//
//  The board's own AT account, and what it publishes (publishing spec,
//  nexus-lounge docs/publishing.md):
//
//  * listing  (<prefix>.leaf.listing, key "self"): who the board is and how
//             to reach it, for the hub and any directory
//  * status   (<prefix>.leaf.status, key "self"): the sysop's declared
//             status, such as planned maintenance
//  * posts    (app.bsky.feed.post): announcements, seen by its followers
//
//  The sysop connects the account once (core/atproto_board_account.js, or
//  connectBoardAccount()), approving it in a browser like an AT login but
//  with write scopes; the write session is kept apart from members' (see
//  oauth_client.js). Nothing about members is ever published here.
//
//  Off unless atProto.publishing.enabled (with atProto.enabled).
//

exports.isEnabled = () => AtProtoOAuth.isPublishingEnabled();
exports.recordTypes = () => recordTypes(nsidPrefix());
exports.getBoardAccount = getBoardAccount;
exports.connectBoardAccount = connectBoardAccount;
exports.disconnectBoardAccount = disconnectBoardAccount;
exports.buildListing = buildListing;
exports.publishListing = publishListing;
exports.setStatus = setStatus;
exports.post = post;
exports.setSplashShown = setSplashShown;
exports.splashState = splashState;
exports.isStockArt = isStockArt;
exports.missingPermissions = missingPermissions;
exports.buildPost = buildPost;
exports.startup = startup;
exports.publishContent = publishContent;
exports.StatusStates = ['up', 'maintenance', 'degraded', 'down'];
//  Content ratings (hub spec §5.4), and the AT self-labels each carries, so
//  ordinary AT apps and moderation services see it too (a first draft of
//  the mapping, from the hub spec)
exports.Ratings = ['general', 'mature', 'adult'];
exports.RatingLabels = {
    general: [],
    mature: ['graphic-media', 'nudity'],
    adult: ['sexual', 'porn'],
};
exports.MaxPostLength = 300;

exports._setStore = s => {
    store = s;
};
exports._setNow = fn => {
    nowMs = fn;
};

let nowMs = () => Date.now();
const nowSeconds = () => Math.floor(nowMs() / 1000);
const iso = seconds => new Date(seconds * 1000).toISOString();

const DefaultMinPostIntervalSeconds = 60;
const DefaultMovedMessage = '{boardName} has moved! Find it now at: {addresses}';
const ListingRefreshMs = 24 * 60 * 60 * 1000;
const ConfigSettleMs = 5 * 1000;

function nsidPrefix(config = Config()) {
    return _.get(config, 'atProto.publishing.nsidPrefix') || DefaultNsidPrefix;
}

//  ── The board account ────────────────────────────────────────────────────

let store = null;
function getStore() {
    if (!store) {
        const db = dbs.atproto;
        const select = db.prepare('SELECT * FROM board_account WHERE id = 1');
        //  reconnecting keeps the sysop's answer about the splash screen
        const upsert = db.prepare(
            `INSERT INTO board_account (id, did, handle, connected_timestamp)
            VALUES (1, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET did = excluded.did, handle = excluded.handle,
                connected_timestamp = excluded.connected_timestamp`
        );
        const del = db.prepare('DELETE FROM board_account WHERE id = 1');
        const listed = db.prepare(
            'UPDATE board_account SET listing_hash = ?, listing_timestamp = ? WHERE id = 1'
        );
        const posted = db.prepare(
            'UPDATE board_account SET post_timestamp = ? WHERE id = 1'
        );
        const splash = db.prepare(
            'UPDATE board_account SET splash_shown = ?, splash_timestamp = ?, splash_sha256 = ? WHERE id = 1'
        );
        const agreed = db.prepare(
            'UPDATE board_account SET splash_sha256 = ? WHERE id = 1'
        );
        const asked = db.prepare(
            'UPDATE board_account SET splash_asked_sha256 = ? WHERE id = 1'
        );
        store = {
            get: () => select.get(),
            set: (did, handle, ts) => upsert.run(did, handle || null, ts),
            del: () => del.run(),
            listed: (hash, ts) => listed.run(hash, ts),
            posted: ts => posted.run(ts),
            splash: (shown, ts, sha256) => splash.run(shown ? 1 : 0, ts, sha256 || null),
            agreed: sha256 => agreed.run(sha256 || null),
            asked: sha256 => asked.run(sha256 || null),
        };
    }
    return store;
}

//  { did, handle, connectedAt, listingPublishedAt, lastPostAt, splashShown,
//  splashAt, splashSha256, splashAskedSha256 }, or null. splashShown is
//  undefined until the sysop answers; splashSha256 is the art they agreed to
//  (null: none was found then; 'adopt': see initAtProtoDatabase)
function getBoardAccount() {
    const row = getStore().get();
    return row
        ? {
              did: row.did,
              handle: row.handle || undefined,
              connectedAt: row.connected_timestamp,
              listingPublishedAt: row.listing_timestamp || undefined,
              lastPostAt: row.post_timestamp || undefined,
              splashShown:
                  null === row.splash_shown || undefined === row.splash_shown
                      ? undefined
                      : 1 === row.splash_shown,
              splashAt: row.splash_timestamp || undefined,
              splashSha256: row.splash_sha256 || null,
              splashAskedSha256: row.splash_asked_sha256 || null,
          }
        : null;
}

function requireAccount() {
    const account = getBoardAccount();
    if (!account) {
        throw Errors.DoesNotExist(
            'No board account is connected',
            ErrorReasons.DoesNotExist
        );
    }
    return account;
}

//  ENiGMA½'s own stock art, by its hashes (misc/stock_art_hashes.js): it
//  belongs to its artists, so it is never offered to a hub by default
let stockArt = null;
function isStockArt(sha256) {
    if (!stockArt) {
        stockArt = new Set(require('./stock_art.json').sha256);
    }
    return stockArt.has(sha256);
}

//
//  |identity| ({ did, handle }) has just approved the board's write access
//  (authorizeBoard()): make it the board account, and publish the listing.
//  Connecting is when the sysop is told whether the hub will show the
//  board's splash screen (the screen says so, and how to change it). The
//  first time, the answer is yes, to the art the board would offer now,
//  unless that is ENiGMA½'s stock art, which isn't the sysop's to give;
//  later connections keep whatever they chose.
//
function connectBoardAccount(identity, cb) {
    let previous;
    try {
        previous = getBoardAccount();
        getStore().set(identity.did, identity.handle, nowSeconds());
        Log.info(
            { did: identity.did, previous: previous ? previous.did : undefined },
            'Board AT account connected'
        );
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    //  the listing first, then, once it's done, the board's art and live
    //  objects in the background: an account connected again may allow
    //  what it didn't before
    const listing = () =>
        publishListing({ force: true }, (err, result) => {
            if (exports.isEnabled() && AtProtoOAuth.isBoardReady()) {
                setImmediate(() => exports.publishContent(_.noop));
            }
            return cb(err, result);
        });
    if (previous && undefined !== previous.splashShown) {
        return listing();
    }
    return Splash.find(Config(), found => {
        try {
            const stock = !!found && isStockArt(found.sha256);
            getStore().splash(
                !stock,
                nowSeconds(),
                found && !stock ? found.sha256 : null
            );
            if (stock) {
                Log.info(
                    { path: found.path },
                    "Board splash screen not offered: it is ENiGMA½'s stock art"
                );
            }
        } catch (err) {
            return cb(err);
        }
        return listing();
    });
}

//
//  What the board account doesn't allow yet, of what the board now asks for
//  (it was connected when the board asked for less), as permission strings:
//  [] when it allows everything, null when it can't tell (no account, or a
//  session that doesn't say). Only the session's granted scope is read.
//
//  missingPermissions(), or null on any error
function publishMissing() {
    try {
        return missingPermissions();
    } catch (e) {
        return null;
    }
}

//  What the account lacks that publishing art needs: all of it but the
//  live objects' type, which an account connected before it was asked for
//  may well not have, and which art doesn't use
function artMissing() {
    const object = `repo:${objectTypes(nsidPrefix(Config())).object}`;
    const missing = publishMissing();
    return missing ? missing.filter(scope => scope !== object) : missing;
}

function missingPermissions(config = Config()) {
    const account = getBoardAccount();
    if (!account) {
        return null;
    }
    const row = dbs.atproto
        .prepare('SELECT session_json FROM oauth_board_session WHERE did = ?')
        .get(account.did);
    let granted;
    try {
        granted = _.get(JSON.parse(row.session_json), 'tokenSet.scope');
    } catch (e) {
        return null;
    }
    if (!_.isString(granted)) {
        return null;
    }
    const have = new Set(granted.split(/\s+/).filter(Boolean));
    return boardScope(nsidPrefix(config))
        .split(' ')
        .filter(scope => !have.has(scope));
}

//
//  The sysop's answer: may the hub show the board's splash screen? Yes is to
//  the art the board would offer now, by its hash: when that art changes,
//  the board stops offering it until they agree again. Kept with when it was
//  given, and the listing published again to say so. Calls back with (err,
//  { written, record }).
//
function setSplashShown(shown, cb) {
    try {
        requireAccount();
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    const answer = found => {
        try {
            getStore().splash(
                !!shown,
                nowSeconds(),
                shown && found ? found.sha256 : null
            );
            Log.info(
                { shown: !!shown, sha256: shown && found ? found.sha256 : undefined },
                'Board splash screen on the hub'
            );
        } catch (err) {
            return cb(err);
        }
        return publishListing({}, cb);
    };
    return shown ? Splash.find(Config(), answer) : answer(null);
}

//
//  Where the splash stands, given the art the board would offer now
//  (|found|, from Splash.find): 'hidden' (the sysop said no, or hasn't been
//  asked), 'shown' (that art, agreed to), 'changed' (they agreed to other
//  art, or to none: not offered until they agree to this), 'stock' (a yes
//  from before consent was to a file, and the art is ENiGMA½'s stock art:
//  not offered either), or 'none' (a yes, but no art found).
//
function splashState(account, found) {
    if (!account || true !== account.splashShown) {
        return 'hidden';
    }
    if (!found) {
        return 'none';
    }
    if ('adopt' === account.splashSha256) {
        return isStockArt(found.sha256) ? 'stock' : 'shown';
    }
    return found.sha256 === account.splashSha256 ? 'shown' : 'changed';
}

//  Default notice writer: one private message to the board's root user (the
//  sysop), so they see it at their next login. Replaceable for tests.
function persistNotice(subject, body, cb) {
    const User = require('../user.js');
    const Message = require('../message.js');
    User.getUserName(User.RootUserID, (err, userName) => {
        if (err) {
            return cb(err);
        }
        const notice = new Message({
            areaTag: Message.WellKnownAreaTags.Private,
            toUserName: userName,
            fromUserName: _.get(Config(), 'general.boardName', 'ENiGMA½ BBS'),
            subject,
            message: body,
        });
        notice.setLocalToUserId(User.RootUserID);
        return notice.persist(cb);
    });
}

let noticeWriter = persistNotice;
exports._setNoticeWriter = writer => {
    const prev = noticeWriter;
    noticeWriter = writer || persistNotice;
    return prev;
};

//  The splash's art isn't what the sysop agreed to: say so once for each
//  new file, in the log and in a private message to the sysop
function splashNotOffered(account, found, state) {
    if (account.splashAskedSha256 === found.sha256) {
        return;
    }
    try {
        getStore().asked(found.sha256);
    } catch (err) {
        return Log.warn({ error: err.message }, 'Could not keep the splash notice');
    }
    const file = require('path').basename(found.path || '') || found.sha256.slice(0, 12);
    const why =
        'stock' === state
            ? `is ENiGMA½'s stock art (${file}), which belongs to its artists`
            : `has changed (it is ${file} now)`;
    Log.warn(
        { path: found.path, sha256: found.sha256, state },
        'Board splash screen not offered to the hub: the sysop has not agreed to this art'
    );
    const body = [
        `The board's login screen ${why}, so the hub has stopped showing it.`,
        '',
        'To show this art on the hub, credited to its artist, choose "splash" on the',
        'board account screen (BA), or run: ./oputil.js atproto splash on',
        '',
        'Only agree if the art is yours to share, or its artist allows it. To show',
        'other art, name it in atProto.publishing.splash.art.',
    ].join('\r\n');
    noticeWriter('The hub has stopped showing your login screen', body, err => {
        if (err) {
            Log.warn({ error: err.message }, 'Could not send the splash notice');
        }
    });
}

//
//  Revoke the board's write access and forget the account. Its records stay
//  where they are: set the status first to say the board is gone, if so.
//
function disconnectBoardAccount(cb) {
    let account;
    try {
        account = requireAccount();
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    AtProtoOAuth.revokeBoard(account.did, err => {
        if (err) {
            //  Forget it anyway: the sysop may revoke it at the host too
            Log.warn(
                { did: account.did, error: err.message },
                'Could not revoke the board account session'
            );
        }
        try {
            getStore().del();
        } catch (e) {
            return cb(e);
        }
        Log.info({ did: account.did }, 'Board AT account disconnected');
        return cb(null);
    });
}

//  ── Writing records ──────────────────────────────────────────────────────

function putSelf(did, collection, record, cb) {
    AtProtoOAuth.boardRequest(
        did,
        'POST',
        'com.atproto.repo.putRecord',
        { repo: did, collection, rkey: 'self', record },
        cb
    );
}

//
//  A host from config is worth listing only if the world can reach it: not
//  a loopback or private address
//
function isPublicHost(host) {
    if (!_.isString(host) || !host) {
        return false;
    }
    //  localhost and its subdomains (RFC 6761), and mDNS names on the LAN
    const name = host.toLowerCase().replace(/\.$/, '');
    if ('localhost' === name || name.endsWith('.localhost') || name.endsWith('.local')) {
        return false;
    }
    const version = net.isIP(host);
    if (4 === version) {
        const [a, b] = host.split('.').map(Number);
        return !(
            10 === a ||
            127 === a ||
            0 === a ||
            (169 === a && 254 === b) ||
            (172 === a && b >= 16 && b <= 31) ||
            (192 === a && 168 === b) ||
            (100 === a && b >= 64 && b <= 127)
        );
    }
    if (6 === version) {
        const h = host.toLowerCase();
        return !(
            '::1' === h ||
            h.startsWith('fc') ||
            h.startsWith('fd') ||
            h.startsWith('fe80')
        );
    }
    return true;
}

//  Ways to connect, from the servers that are enabled
//
//  The web endpoint is at the board's public web address, which behind a
//  proxy, tunnel or hub is contentServers.web.overrideUrlPrefix. SSH and
//  telnet are not carried by those (the hub forwards web traffic only), so
//  they are at the board's own domain, contentServers.web.domain, and only
//  when that is a public name.
//
function derivedEndpoints(config) {
    const endpoints = [];
    let base = null;
    try {
        base = getBaseUrl(config).replace(/\/+$/, '');
    } catch (e) {
        //  no web server configured
    }
    const domain = _.get(config, 'contentServers.web.domain');

    const webHost = base ? new URL(base).hostname : null;
    if (base && isPublicHost(webHost)) {
        if (true === _.get(config, 'atProto.webSignIn.enabled')) {
            endpoints.push({ protocol: 'web', uri: `${base}/_enig/signin` });
        } else if (_.get(config, 'contentServers.web.wsTerm.root')) {
            endpoints.push({ protocol: 'web', uri: `${base}/_enig/ws-term/` });
        }
    }
    if (isPublicHost(domain)) {
        [
            ['ssh', 'loginServers.ssh'],
            ['telnet', 'loginServers.telnet'],
        ].forEach(([protocol, path]) => {
            const server = _.get(config, path, {});
            if (true === server.enabled && server.port) {
                endpoints.push({
                    protocol,
                    uri: `${protocol}://${domain}:${server.port}`,
                });
            }
        });
    }
    return endpoints;
}

//  The hours setting, if it says anything
function hoursFrom(hours) {
    if (!_.isPlainObject(hours)) {
        return undefined;
    }
    const out = {};
    if (_.isString(hours.timezone) && hours.timezone) {
        out.timezone = hours.timezone;
    }
    if (Array.isArray(hours.weekly) && hours.weekly.length > 0) {
        out.weekly = hours.weekly
            .filter(_.isPlainObject)
            .map(w => _.pick(w, ['days', 'from', 'to']));
    }
    if (_.isString(hours.note) && hours.note) {
        out.note = hours.note;
    }
    return out.weekly || out.note ? out : undefined;
}

//
//  The listing record as the config describes the board now. |createdAt| is
//  when the board account was connected, so it doesn't change on every write.
//
//  |splash|: the board's splash screen (splash.js), when the sysop lets the
//  hub show it. |emblem|: the emblem the sysop names, if any
function buildListing(
    config = Config(),
    account = getBoardAccount(),
    splash = null,
    emblem = null
) {
    const listing = _.get(config, 'atProto.publishing.listing', {});
    const Admission = require('./admission');

    const extra = _.castArray(listing.endpoints || []).filter(
        e => _.isPlainObject(e) && _.isString(e.protocol) && _.isString(e.uri)
    );
    const endpoints = _.uniqBy(
        [
            ...(false === listing.deriveEndpoints ? [] : derivedEndpoints(config)),
            ...extra.map(e => _.pick(e, ['protocol', 'uri'])),
        ],
        'uri'
    );

    const record = {
        $type: recordTypes(nsidPrefix(config)).listing,
        name: _.get(config, 'general.boardName', 'ENiGMA½ BBS'),
        endpoints,
        admission: { policy: Admission.policy(config) },
        createdAt: iso(_.get(account, 'connectedAt', nowSeconds())),
    };
    if (_.isString(listing.description) && listing.description) {
        record.description = listing.description;
    }
    const tags = _.castArray(listing.tags || []).filter(t => _.isString(t) && t);
    if (tags.length > 0) {
        record.tags = tags;
    }
    if (_.isString(listing.rules) && listing.rules) {
        record.rules = listing.rules;
    }
    if (_.isString(listing.howToJoin) && listing.howToJoin) {
        record.admission.howToJoin = listing.howToJoin;
    }
    const hours = hoursFrom(listing.hours);
    if (hours) {
        record.hours = hours;
    }
    if (_.isString(listing.sysopDid) && listing.sysopDid.startsWith('did:')) {
        record.sysop = listing.sysopDid;
    }

    //  A misspelt rating stops the listing rather than passing as all ages
    const rating = undefined === listing.rating ? 'general' : listing.rating;
    if (!exports.Ratings.includes(rating)) {
        throw Errors.Invalid(
            `atProto.publishing.listing.rating is "${rating}"; it must be one of ${exports.Ratings.join(', ')}`
        );
    }
    record.rating = rating;
    const fileRef = art => ({
        sha256: art.sha256,
        size: art.size,
        mediaType: art.mediaType,
    });
    if (splash) {
        record.splash = fileRef(splash);
    }
    if (emblem) {
        record.emblem = fileRef(emblem);
    }
    const labels = exports.RatingLabels[rating];
    if (labels.length > 0) {
        record.labels = {
            $type: 'com.atproto.label.defs#selfLabels',
            values: labels.map(val => ({ val })),
        };
    }
    return record;
}

const hashOf = record =>
    crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');

//
//  Write the listing, unless it is what was last written (|options.force|
//  writes it anyway). Calls back with (err, { written, record }).
//
function publishListing(options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    let account;
    try {
        account = requireAccount();
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    //  the splash, found again each time, and offered only when it is the
    //  art the sysop agreed to
    const withSplash = next => {
        if (true !== account.splashShown) {
            return next(null);
        }
        return Splash.find(Config(), found => {
            const state = splashState(account, found);
            if ('shown' === state && 'adopt' === account.splashSha256) {
                //  a yes from before: now to this file
                try {
                    getStore().agreed(found.sha256);
                } catch (err) {
                    Log.warn(
                        { error: err.message },
                        'Could not keep the splash agreed to'
                    );
                }
            }
            if ('changed' === state || 'stock' === state) {
                splashNotOffered(account, found, state);
            }
            return next('shown' === state ? found : null);
        });
    };
    //  naming an emblem is the sysop's consent to offering it
    const withEmblem = next =>
        Splash.emblemNamed(Config()) ? Splash.findEmblem(Config(), next) : next(null);
    withSplash(splash =>
        withEmblem(emblem => writeListing(account, { splash, emblem }, options, cb))
    );
}

function writeListing(account, art, options, cb) {
    let record;
    let hash;
    try {
        record = buildListing(Config(), account, art.splash, art.emblem);
        hash = hashOf(record);
    } catch (err) {
        return cb(err);
    }

    const row = getStore().get();
    if (!options.force && row && row.listing_hash === hash) {
        return cb(null, { written: false, record });
    }

    const moved = _.get(Config(), 'atProto.publishing.triggers.moved', {});
    const watchMoves = true === moved.enabled;

    //  the addresses published now, to tell whether the board has moved
    const before = next =>
        watchMoves ? publishedEndpoints(account.did, record.$type, next) : next(null);

    before(previous => {
        putSelf(account.did, record.$type, record, err => {
            if (err) {
                Log.warn(
                    { did: account.did, error: err.message },
                    'Could not publish the board listing'
                );
                return cb(err);
            }
            getStore().listed(hash, nowSeconds());
            Log.info({ did: account.did }, 'Board listing published');

            const result = { written: true, record };
            if (!watchMoves || !hasMoved(previous, record.endpoints)) {
                return cb(null, result);
            }
            const text = movedMessage(moved.message, record);
            post(text, (err, posted) => {
                if (err) {
                    Log.warn(
                        { did: account.did, error: err.message },
                        'Could not post that the board has moved'
                    );
                    result.movedPost = { error: err.message };
                } else {
                    result.movedPost = posted;
                }
                return cb(null, result);
            });
        });
    });
}

//
//  The endpoints of the listing published now, or null when there is none
//  (or it can't be read: then nothing is posted)
//
function publishedEndpoints(did, collection, cb) {
    AtProtoOAuth.boardRequest(
        did,
        'GET',
        'com.atproto.repo.getRecord',
        { repo: did, collection, rkey: 'self' },
        (err, result) => {
            const endpoints = _.get(result, 'value.endpoints');
            return cb(!err && Array.isArray(endpoints) ? endpoints : null);
        }
    );
}

//  Its addresses changed, from some to others (not to none)
function hasMoved(previous, endpoints) {
    if (!Array.isArray(previous) || 0 === previous.length || 0 === endpoints.length) {
        return false;
    }
    const uris = list =>
        _.sortBy(_.uniq(list.map(e => _.get(e, 'uri')).filter(_.isString)));
    return !_.isEqual(uris(previous), uris(endpoints));
}

//
//  The moved post from its template: {boardName} and {addresses}, dropping
//  addresses from the end until it fits a post
//
function movedMessage(template, record) {
    const text = _.isString(template) && template ? template : DefaultMovedMessage;
    const uris = record.endpoints.map(e => e.uri);
    for (let n = uris.length; n >= 1; --n) {
        const message = text
            .replace(/\{boardName\}/g, record.name)
            .replace(/\{addresses\}/g, uris.slice(0, n).join(' '));
        if ([...message].length <= exports.MaxPostLength) {
            return message;
        }
    }
    return [
        ...text.replace(/\{boardName\}/g, record.name).replace(/\{addresses\}/g, uris[0]),
    ]
        .slice(0, exports.MaxPostLength)
        .join('');
}

//
//  The sysop's declared status: { state, message, until }, |state| one of
//  StatusStates (others are allowed: the list is open), |until| a date
//
function setStatus({ state, message, until } = {}, cb) {
    let account;
    let record;
    try {
        account = requireAccount();
        if (!_.isString(state) || !/^[a-z][a-z0-9-]*$/.test(state)) {
            throw Errors.Invalid('A status needs a state such as "up" or "maintenance"');
        }
        record = {
            $type: recordTypes(nsidPrefix()).status,
            state,
            updatedAt: iso(nowSeconds()),
        };
        if (_.isString(message) && message) {
            record.message = message;
        }
        if (until) {
            const when = new Date(until);
            if (isNaN(when.getTime())) {
                throw Errors.Invalid(`"${until}" is not a date`);
            }
            record.until = when.toISOString();
        }
    } catch (err) {
        return setImmediate(() => cb(err));
    }

    putSelf(account.did, record.$type, record, err => {
        if (err) {
            return cb(err);
        }
        Log.info({ did: account.did, state }, 'Board status published');
        return cb(null, record);
    });
}

//
//  A post record for |text|, with its web links made clickable (Bluesky
//  needs a "facet" for each, by UTF-8 byte offsets)
//
function buildPost(text, config = Config()) {
    const facets = [];
    const re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'}]/g;
    let match;
    while ((match = re.exec(text))) {
        const byteStart = Buffer.byteLength(text.slice(0, match.index), 'utf8');
        facets.push({
            index: {
                byteStart,
                byteEnd: byteStart + Buffer.byteLength(match[0], 'utf8'),
            },
            features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
        });
    }

    const record = {
        $type: PostCollection,
        text,
        createdAt: iso(nowSeconds()),
    };
    const langs = _.castArray(
        _.get(config, 'atProto.publishing.postLangs', ['en'])
    ).filter(_.isString);
    if (langs.length > 0) {
        record.langs = langs;
    }
    if (facets.length > 0) {
        record.facets = facets;
    }
    return record;
}

//
//  Post an announcement from the board account. Plain text, up to
//  MaxPostLength characters; at most one per
//  atProto.publishing.minPostIntervalSeconds, so a mistake can't flood it.
//  Calls back with (err, { uri }).
//
function post(text, cb) {
    let account;
    let record;
    try {
        account = requireAccount();
        const trimmed = _.trim(text);
        if (!trimmed) {
            throw Errors.Invalid('Nothing to post');
        }
        if ([...trimmed].length > exports.MaxPostLength) {
            throw Errors.Invalid(
                `A post can be at most ${exports.MaxPostLength} characters`,
                ErrorReasons.ValueTooLong
            );
        }
        const minInterval = _.get(
            Config(),
            'atProto.publishing.minPostIntervalSeconds',
            DefaultMinPostIntervalSeconds
        );
        if (account.lastPostAt && nowSeconds() - account.lastPostAt < minInterval) {
            throw Errors.AccessDenied(
                `Wait ${minInterval} seconds between posts`,
                ErrorReasons.TooMany
            );
        }
        record = buildPost(trimmed);
    } catch (err) {
        return setImmediate(() => cb(err));
    }

    AtProtoOAuth.boardRequest(
        account.did,
        'POST',
        'com.atproto.repo.createRecord',
        { repo: account.did, collection: PostCollection, record },
        (err, result) => {
            if (err) {
                return cb(err);
            }
            getStore().posted(nowSeconds());
            Log.info({ did: account.did, uri: result.uri }, 'Board announcement posted');
            return cb(null, { uri: result.uri });
        }
    );
}

//  ── While the board runs ─────────────────────────────────────────────────

let started = false;

//
//  Publish the board's art (assets.js), then its live objects (objects.js),
//  as far as the account allows: the art also with none listed, so the last
//  piece taken off the list is taken down (an account that never had any is
//  only read); the objects after the programs they name, and only once the
//  account allows them. Problems are logged; cb() when both are done.
//
function publishContent(cb) {
    let account = null;
    try {
        account = getBoardAccount();
    } catch (e) {
        //  no database yet
    }
    if (!account || (artMissing() || []).length) {
        return setImmediate(() => cb());
    }
    return require('./assets').publishAssets(err => {
        if (err) {
            Log.warn({ error: err.message }, 'Could not publish the board art');
        }
        const object = `repo:${objectTypes(nsidPrefix(Config())).object}`;
        if ((publishMissing() || [object]).includes(object)) {
            return cb();
        }
        return require('./objects').publishObjects(err => {
            if (err) {
                Log.warn(
                    { error: err.message },
                    'Could not publish the board live objects'
                );
            }
            return cb();
        });
    });
}

//
//  Publish the listing now (if it changed), then daily, and soon after the
//  config changes. Never stops the board starting.
//
function startup(cb) {
    if (started || !exports.isEnabled() || !AtProtoOAuth.isBoardReady()) {
        return cb(null);
    }
    started = true;

    const refresh = () => {
        let account = null;
        try {
            account = getBoardAccount();
        } catch (e) {
            //  no database yet
        }
        if (account) {
            publishListing(_.noop);
            exports.publishContent(_.noop);
        }
    };

    setImmediate(refresh);
    setInterval(refresh, ListingRefreshMs).unref();

    const Events = require('../events');
    let pending = null;
    Events.on(Events.getSystemEvents().ConfigChanged, () => {
        clearTimeout(pending);
        pending = setTimeout(refresh, ConfigSettleMs);
        pending.unref();
    });

    return cb(null);
}
