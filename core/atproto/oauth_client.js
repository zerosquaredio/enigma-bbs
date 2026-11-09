/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const { Errors } = require('../enig_error');
const { dbs } = require('../database');
const { getBaseUrl } = require('../web_util');
const { createStateStore, createSessionStore } = require('./store');
const {
    OAuthScope,
    DefaultNsidPrefix,
    boardScope,
    ClientModes,
    CallbackRoutePath,
    ClientMetadataRoutePath,
    JwksRoutePath,
    SigningKeyFile,
    SigningAlg,
    HandleInvalid,
} = require('./const');

//  deps
const _ = require('lodash');
const fs = require('fs');
const paths = require('path');

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

//
//  With atProto.publishing.enabled, a second client for the board's own
//  account (core/atproto/publishing.js). It has the same client metadata
//  but its own stores: its sessions are kept apart from members' (both are
//  keyed by DID), and its in-flight requests are namespaced, so a callback
//  can be handed to the client that started it.
//
let boardClient = null;
let boardStateStore = null;
const BoardStateNamespace = 'board:';

exports.startup = startup;
exports.isEnabled = isEnabled;
exports.isReady = isReady;
exports.isPublishingEnabled = isPublishingEnabled;
exports.isBoardReady = isBoardReady;
exports.buildClientMetadata = buildClientMetadata;
exports.getClientMetadata = getClientMetadata;
exports.getJwks = getJwks;
exports.resolveIdentity = resolveIdentity;
exports.authorize = authorize;
exports.authorizeBoard = authorizeBoard;
exports.handleCallback = handleCallback;
exports.restore = restore;
exports.revoke = revoke;
exports.boardRequest = boardRequest;
exports.revokeBoard = revokeBoard;

//  For tests: substitute the library, and forget the clients between cases
exports._setLibraryLoader = loader => {
    loadLibrary = loader;
};
exports._reset = () => {
    client = null;
    boardClient = null;
    boardStateStore = null;
};

function isEnabled() {
    return true === _.get(Config(), 'atProto.enabled');
}

function isReady() {
    return null !== client;
}

function isPublishingEnabled(config = Config()) {
    return (
        true === _.get(config, 'atProto.enabled') &&
        true === _.get(config, 'atProto.publishing.enabled')
    );
}

function isBoardReady() {
    return null !== boardClient;
}

function nsidPrefix(config = Config()) {
    return _.get(config, 'atProto.publishing.nsidPrefix') || DefaultNsidPrefix;
}

//
//  What the client may ask for: member logins only need |OAuthScope|; with
//  publishing on, the board account's scopes too (members are still asked
//  for |OAuthScope| alone)
//
function clientScope(config = Config()) {
    return isPublishingEnabled(config) ? boardScope(nsidPrefix(config)) : OAuthScope;
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

    const isPublic = ClientModes.Public === _.get(Config(), 'atProto.oauth.clientMode');

    return settle(
        () =>
            loadLibrary().then(lib =>
                (isPublic ? loadSigningKey(lib) : Promise.resolve(null)).then(key => {
                    const common = {
                        clientMetadata,
                        keyset: key ? [key] : undefined,
                        //  ENiGMA½ is a single process, so an in-process lock
                        //  is enough to keep two token refreshes from racing
                        requestLock: lib.requestLocalLock,
                    };
                    client = new lib.NodeOAuthClient(
                        Object.assign({}, common, {
                            stateStore: createStateStore(dbs.atproto),
                            sessionStore: createSessionStore(dbs.atproto),
                        })
                    );
                    if (isPublishingEnabled()) {
                        boardStateStore = createStateStore(dbs.atproto, {
                            namespace: BoardStateNamespace,
                        });
                        boardClient = new lib.NodeOAuthClient(
                            Object.assign({}, common, {
                                stateStore: boardStateStore,
                                sessionStore: createSessionStore(dbs.atproto, {
                                    table: 'oauth_board_session',
                                }),
                            })
                        );
                    }
                })
            ),
        cb
    );
}

//  The metadata and public keys the web handler serves in public mode, or
//  null until AT support has started
function getClientMetadata() {
    return client ? client.clientMetadata : null;
}

function getJwks() {
    return client ? client.jwks : null;
}

function buildClientMetadata() {
    const config = Config();
    const clientMode = _.get(config, 'atProto.oauth.clientMode');

    if (ClientModes.Public === clientMode) {
        return buildPublicClientMetadata(config);
    }
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
    const scope = clientScope(config);
    return {
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(
            redirectUri
        )}&scope=${encodeURIComponent(scope)}`,
        redirect_uris: [redirectUri],
        scope,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        dpop_bound_access_tokens: true,
    };
}

//
//  A public client is identified by the URL of its metadata document, served
//  by the BBS itself. Every URL comes from the web server's base URL (as the
//  browser handoff links do), which must be https://: behind a proxy or the
//  hub, set contentServers.web.overrideUrlPrefix to the public address.
//
function buildPublicClientMetadata(config) {
    const base = getBaseUrl(config).replace(/\/+$/, '');
    if (!base.startsWith('https://')) {
        throw Errors.Invalid(
            `Public AT Protocol login needs an https:// address, not "${base}"; set contentServers.web.overrideUrlPrefix`
        );
    }

    return {
        client_id: `${base}${ClientMetadataRoutePath}`,
        client_name: _.get(config, 'general.boardName'),
        client_uri: base,
        redirect_uris: [`${base}${CallbackRoutePath}`],
        scope: clientScope(config),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: SigningAlg,
        dpop_bound_access_tokens: true,
        jwks_uri: `${base}${JwksRoutePath}`,
    };
}

//
//  Public mode's signing key: loaded from paths.security, or made and saved
//  there (readable by the BBS's user only) on first start. Losing it only
//  means making a new one; members' sessions refresh against the new key.
//
function loadSigningKey(lib) {
    const keyPath = paths.join(_.get(Config(), 'paths.security'), SigningKeyFile);

    return fs.promises.readFile(keyPath, 'utf8').then(
        text => lib.JoseKey.fromJWK(JSON.parse(text)),
        err => {
            if ('ENOENT' !== err.code) {
                throw err;
            }
            return lib.JoseKey.generate([SigningAlg], `enig-${Date.now()}`).then(key =>
                fs.promises
                    .mkdir(paths.dirname(keyPath), { recursive: true })
                    .then(() =>
                        fs.promises.writeFile(
                            keyPath,
                            JSON.stringify(key.privateJwk, null, 4),
                            { mode: 0o600, flag: 'wx' }
                        )
                    )
                    .then(() => key)
            );
        }
    );
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
//  As authorize(), for the board's own account: asks for its write scopes,
//  and the session it ends in is kept apart from members' (see boardClient)
//
function authorizeBoard(input, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }
    if (!boardClient) {
        const err = Errors.UnexpectedState(
            'Publishing (atProto.publishing) is not enabled'
        );
        return setImmediate(() => cb(err));
    }

    const authorizeOptions = { scope: boardScope(nsidPrefix()) };
    if (options.state) {
        authorizeOptions.state = options.state;
    }
    return settle(
        () => boardClient.authorize(input, authorizeOptions).then(url => url.toString()),
        cb
    );
}

//
//  Complete a login from the redirect's query parameters (a URLSearchParams,
//  query string, or plain object). Calls back with { did, state, board }:
//  |board| is true when it was the board account's (authorizeBoard()).
//
function handleCallback(params, cb) {
    const searchParams = new URLSearchParams(params);

    //  The library's own state key names the client that started it
    let forBoard = false;
    try {
        forBoard = !!boardClient && boardStateStore.has(searchParams.get('state') || '');
    } catch (e) {
        //  read as a member login
    }
    const owner = forBoard ? boardClient : client;

    return withClient(
        () =>
            owner.callback(searchParams).then(result => ({
                did: result.session.did,
                state: result.state,
                board: forBoard,
            })),
        cb
    );
}

//
//  Load a stored session, refreshing its tokens if they are about to expire.
//  Calls back with { did, issuer, scope, expiresAt }; |issuer| is the member's
//  authorization server.
//
//  With |options.refresh|, the tokens are refreshed now whatever their age,
//  which asks the account host whether the member's grant still stands: it
//  fails once they have revoked access (and the session is then forgotten).
//
function restore(did, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }
    const refresh = true === _.get(options, 'refresh') ? true : 'auto';

    return withClient(
        () =>
            client.restore(did, refresh).then(session =>
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

//
//  An XRPC call to the board account's own account host, authenticated as
//  the board account |did|: |method| "GET" (a query, |params| in the query
//  string) or "POST" (a procedure, |params| as its JSON body). Calls back
//  with the parsed response; a failure carries |status| and the host's
//  |error| name (e.g. "InvalidRequest").
//
function boardRequest(did, method, nsid, params, cb) {
    if (!boardClient) {
        const err = Errors.UnexpectedState(
            'Publishing (atProto.publishing) is not enabled'
        );
        return setImmediate(() => cb(err));
    }

    const isQuery = 'GET' === method;
    const query =
        isQuery && params ? `?${new URLSearchParams(_.omitBy(params, _.isNil))}` : '';
    const init = isQuery
        ? { method }
        : {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(params || {}),
          };

    return settle(
        () =>
            boardClient.restore(did).then(session =>
                session.fetchHandler(`/xrpc/${nsid}${query}`, init).then(resp =>
                    resp.text().then(text => {
                        let body = {};
                        try {
                            body = text ? JSON.parse(text) : {};
                        } catch (e) {
                            body = { message: text };
                        }
                        if (!resp.ok) {
                            const err = Errors.General(
                                `${nsid} failed (${resp.status}): ${
                                    body.message || body.error || 'no detail'
                                }`
                            );
                            err.status = resp.status;
                            err.error = body.error;
                            throw err;
                        }
                        return body;
                    })
                )
            ),
        cb
    );
}

//  Revoke the board account's tokens and forget its session
function revokeBoard(did, cb) {
    if (!boardClient) {
        return setImmediate(() => cb(null));
    }
    return settle(() => boardClient.revoke(did), cb);
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
