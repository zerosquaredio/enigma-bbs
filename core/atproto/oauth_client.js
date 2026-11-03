/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const { Errors } = require('../enig_error');
const { dbs } = require('../database');
const { createStateStore, createSessionStore } = require('./store');
const { OAuthScope, ClientModes, CallbackRoutePath, HandleInvalid } = require('./const');

//  deps
const _ = require('lodash');

//
//  Callback-style adapter around @atproto/oauth-client-node.
//
//  The library is ESM-only and Promise-based. It is loaded with import(),
//  which works on every Node 22 release, and only when atProto.enabled is
//  true. Its Promises stay inside this module: callers get ordinary
//  (err, result) callbacks like everywhere else in ENiGMA½.
//

const LibraryPackage = '@atproto/oauth-client-node';

let loadLibrary = () => import(LibraryPackage);
let client = null;

exports.startup = startup;
exports.isEnabled = isEnabled;
exports.isReady = isReady;
exports.buildClientMetadata = buildClientMetadata;
exports.resolveIdentity = resolveIdentity;
exports.authorize = authorize;
exports.handleCallback = handleCallback;
exports.restore = restore;
exports.revoke = revoke;

//  For tests: substitute the library, and forget the client between cases
exports._setLibraryLoader = loader => {
    loadLibrary = loader;
};
exports._reset = () => {
    client = null;
};

function isEnabled() {
    return true === _.get(Config(), 'atProto.enabled');
}

function isReady() {
    return null !== client;
}

function startup(cb) {
    if (!isEnabled()) {
        return cb(null);
    }

    let clientMetadata;
    try {
        clientMetadata = buildClientMetadata();
    } catch (err) {
        return cb(err);
    }

    return settle(
        () =>
            loadLibrary().then(lib => {
                client = new lib.NodeOAuthClient({
                    clientMetadata,
                    stateStore: createStateStore(dbs.atproto),
                    sessionStore: createSessionStore(dbs.atproto),
                    //  ENiGMA½ is a single process, so an in-process lock is
                    //  enough to keep two token refreshes from racing
                    requestLock: lib.requestLocalLock,
                });
            }),
        cb
    );
}

function buildClientMetadata() {
    const config = Config();
    const clientMode = _.get(config, 'atProto.oauth.clientMode');

    if (ClientModes.Loopback !== clientMode) {
        throw Errors.Invalid(`Unsupported atProto.oauth.clientMode "${clientMode}"`);
    }

    //  A loopback client is identified by its redirect URI and scope alone.
    //  AT OAuth requires the redirect to use 127.0.0.1, not "localhost".
    const port = _.get(config, 'contentServers.web.http.port');
    if (!_.isInteger(port)) {
        throw Errors.MissingConfig(
            'Loopback AT Protocol login requires contentServers.web.http.port'
        );
    }

    const redirectUri = `http://127.0.0.1:${port}${CallbackRoutePath}`;
    return {
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(
            redirectUri
        )}&scope=${OAuthScope}`,
        redirect_uris: [redirectUri],
        scope: OAuthScope,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        dpop_bound_access_tokens: true,
    };
}

//
//  Resolve a handle or DID to { did, handle, pdsUrl }. A handle is verified in
//  both directions (it names the DID, and the DID document names it back);
//  |handle| is null when that check fails.
//
function resolveIdentity(input, cb) {
    return withClient(
        () =>
            client.oauthResolver.resolveIdentity(input).then(info => ({
                did: info.did,
                handle: HandleInvalid === info.handle ? null : info.handle,
                pdsUrl: getPdsUrl(info.didDoc),
            })),
        cb
    );
}

//
//  Begin a login for a handle, DID, or account host URL. Calls back with the
//  URL the member opens to approve it. |options.state| is returned unchanged
//  by handleCallback(), so a waiting session can be matched to its approval.
//
function authorize(input, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    const authorizeOptions = { scope: OAuthScope };
    if (options.state) {
        authorizeOptions.state = options.state;
    }

    return withClient(
        () => client.authorize(input, authorizeOptions).then(url => url.toString()),
        cb
    );
}

//
//  Complete a login from the redirect's query parameters (a URLSearchParams,
//  query string, or plain object). Calls back with { did, state }.
//
function handleCallback(params, cb) {
    return withClient(
        () =>
            client.callback(new URLSearchParams(params)).then(result => ({
                did: result.session.did,
                state: result.state,
            })),
        cb
    );
}

//
//  Load a stored session, refreshing its tokens if they are about to expire.
//  Calls back with { did, issuer, scope, expiresAt }; |issuer| is the member's
//  authorization server.
//
function restore(did, cb) {
    return withClient(
        () =>
            client.restore(did).then(session =>
                session.getTokenInfo().then(info => ({
                    did: session.did,
                    issuer: info.iss,
                    scope: info.scope,
                    expiresAt: info.expiresAt,
                }))
            ),
        cb
    );
}

//  Revoke a member's tokens at their account host and forget the session
function revoke(did, cb) {
    return withClient(() => client.revoke(did), cb);
}

//  ── Helpers ──────────────────────────────────────────────────────────────

function withClient(fn, cb) {
    if (!client) {
        const err = Errors.UnexpectedState('AT Protocol support is not enabled');
        return setImmediate(() => cb(err));
    }
    return settle(fn, cb);
}

//
//  Run a Promise-returning |fn| and deliver its outcome to a Node-style |cb|.
//  The callback runs outside the Promise chain, so an exception it throws is
//  neither swallowed nor turned into a second call.
//
function settle(fn, cb) {
    Promise.resolve()
        .then(fn)
        .then(
            result => setImmediate(() => cb(null, result)),
            err => setImmediate(() => cb(err))
        );
}

function getPdsUrl(didDoc) {
    const service = _.find(
        _.get(didDoc, 'service'),
        s => _.isString(s.id) && s.id.endsWith('#atproto_pds')
    );
    return service && _.isString(service.serviceEndpoint)
        ? service.serviceEndpoint
        : null;
}
