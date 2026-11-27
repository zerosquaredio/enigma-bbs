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
const { recordTypes, DefaultNsidPrefix, PostCollection, boardScope } = require('./const');

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
exports.missingPermissions = missingPermissions;
exports.buildPost = buildPost;
exports.startup = startup;
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
            'UPDATE board_account SET splash_shown = ?, splash_timestamp = ? WHERE id = 1'
        );
        store = {
            get: () => select.get(),
            set: (did, handle, ts) => upsert.run(did, handle || null, ts),
            del: () => del.run(),
            listed: (hash, ts) => listed.run(hash, ts),
            posted: ts => posted.run(ts),
            splash: (shown, ts) => splash.run(shown ? 1 : 0, ts),
        };
    }
    return store;
}

//  { did, handle, connectedAt, listingPublishedAt, lastPostAt, splashShown,
//  splashAt }, or null. splashShown is undefined until the sysop answers
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
//  (authorizeBoard()): make it the board account, and publish the listing.
//  Connecting is when the sysop is told the hub will show the board's splash
//  screen (the screen says so, and how to stop it): the first time, that
//  is their answer, yes; later connections keep whatever they chose.
//
function connectBoardAccount(identity, cb) {
    try {
        const previous = getBoardAccount();
        getStore().set(identity.did, identity.handle, nowSeconds());
        if (!previous || undefined === previous.splashShown) {
            getStore().splash(true, nowSeconds());
        }
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
//  The sysop's answer: may the hub show the board's splash screen? Kept with
//  when it was given, and the listing published again to say so. Calls back
//  with (err, { written, record }).
//
function setSplashShown(shown, cb) {
    try {
        requireAccount();
        getStore().splash(!!shown, nowSeconds());
        Log.info({ shown: !!shown }, 'Board splash screen on the hub');
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    return publishListing({}, cb);
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
    //  the splash, found again each time, so new art is offered by itself
    const withSplash = next =>
        true === account.splashShown ? Splash.find(Config(), next) : next(null);
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
            //  the board's art (assets.js): also with none listed, so the
            //  last piece taken off the list is taken down; an account
            //  that never had any is only read
            if (!(publishMissing() || []).length) {
                require('./assets').publishAssets(err => {
                    if (err) {
                        Log.warn(
                            { error: err.message },
                            'Could not publish the board art'
                        );
                    }
                });
            }
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
