/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const Log = require('../logger').log;
const { Errors, ErrorReasons } = require('../enig_error');
const { dbs } = require('../database');
const { getBaseUrl, getWebDomain } = require('../web_util');
const AtProtoOAuth = require('./oauth_client');
const { recordTypes, DefaultNsidPrefix, PostCollection } = require('./const');

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
exports.buildPost = buildPost;
exports.startup = startup;
exports.StatusStates = ['up', 'maintenance', 'degraded', 'down'];
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
        const upsert = db.prepare(
            `REPLACE INTO board_account (id, did, handle, connected_timestamp)
            VALUES (1, ?, ?, ?)`
        );
        const del = db.prepare('DELETE FROM board_account WHERE id = 1');
        const listed = db.prepare(
            'UPDATE board_account SET listing_hash = ?, listing_timestamp = ? WHERE id = 1'
        );
        const posted = db.prepare(
            'UPDATE board_account SET post_timestamp = ? WHERE id = 1'
        );
        store = {
            get: () => select.get(),
            set: (did, handle, ts) => upsert.run(did, handle || null, ts),
            del: () => del.run(),
            listed: (hash, ts) => listed.run(hash, ts),
            posted: ts => posted.run(ts),
        };
    }
    return store;
}

//  { did, handle, connectedAt, listingPublishedAt, lastPostAt }, or null
function getBoardAccount() {
    const row = getStore().get();
    return row
        ? {
              did: row.did,
              handle: row.handle || undefined,
              connectedAt: row.connected_timestamp,
              listingPublishedAt: row.listing_timestamp || undefined,
              lastPostAt: row.post_timestamp || undefined,
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

//
//  |identity| ({ did, handle }) has just approved the board's write access
//  (authorizeBoard()): make it the board account, and publish the listing
//
function connectBoardAccount(identity, cb) {
    try {
        const previous = getBoardAccount();
        getStore().set(identity.did, identity.handle, nowSeconds());
        Log.info(
            { did: identity.did, previous: previous ? previous.did : undefined },
            'Board AT account connected'
        );
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    return publishListing({ force: true }, cb);
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
    if (!_.isString(host) || !host || 'localhost' === host.toLowerCase()) {
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
function derivedEndpoints(config) {
    const endpoints = [];
    let base = null;
    let domain = null;
    try {
        base = getBaseUrl(config).replace(/\/+$/, '');
        domain = getWebDomain(config);
    } catch (e) {
        //  no web server configured
    }

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
function buildListing(config = Config(), account = getBoardAccount()) {
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
    let record;
    let hash;
    try {
        account = requireAccount();
        record = buildListing(Config(), account);
        hash = hashOf(record);
    } catch (err) {
        return setImmediate(() => cb(err));
    }

    const row = getStore().get();
    if (!options.force && row && row.listing_hash === hash) {
        return setImmediate(() => cb(null, { written: false, record }));
    }

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
        return cb(null, { written: true, record });
    });
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
