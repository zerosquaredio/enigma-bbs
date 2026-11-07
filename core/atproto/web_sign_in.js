/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const Log = require('../logger').log;
const { dbs } = require('../database');
const { getBaseUrl } = require('../web_util');
const AtProtoOAuth = require('./oauth_client');
const { createWebSessionStore } = require('./store');
const { ClientModes } = require('./const');

//  deps
const crypto = require('crypto');
const querystring = require('querystring');
const _ = require('lodash');

//
//  Web sign-in: "Sign in with Bluesky" on a page of the board's own web
//  server, then one-click logins from the browser terminal (enig-term).
//
//  The start page (SignInRoutePath) runs AT OAuth in the same tab. The
//  callback (shared with terminal logins, see web_handlers/atproto.js) gives
//  the browser a session cookie and sends it on to enig-term. When enig-term
//  connects, the WebSocket server (servers/login/websocket.js) asks
//  identityForConnection() who the cookie belongs to, and a signed-in caller
//  starts at loginServers.webSocket.firstMenuSignedIn instead of the matrix
//  (core/atproto_web_sign_in.js logs them in as for AT login).
//
//  * The cookie holds a random token; only its hash is stored, with the DID,
//    in atproto.sqlite3 (store.js), so sessions survive restarts and a copy
//    of the database holds no usable cookie.
//  * Browsers attach cookies to WebSocket connections that any site opens,
//    so the cookie is honored only when the connection's Origin is one of
//    the board's own web addresses. Other connections are still accepted,
//    as before, but must log in as usual.
//  * Each use refreshes the member's AT OAuth session, which fails once they
//    have revoked the board's access at their account host; their web
//    sessions then end.
//
//  Off unless atProto.webSignIn.enabled (and AT login itself) is set.
//

exports.SignInRoutePath = '/_enig/signin';
exports.SignOutRoutePath = '/_enig/signout';
exports.SessionCookieName = 'enig_signin';
exports.FlowCookieName = 'enig_signin_flow';

exports.isEnabled = isEnabled;
exports.ownsState = ownsState;
exports.routeStartPage = routeStartPage;
exports.routeSignIn = routeSignIn;
exports.routeSignOut = routeSignOut;
exports.completeSignIn = completeSignIn;
exports.identityForConnection = identityForConnection;
exports.isAllowedOrigin = isAllowedOrigin;
exports.parseCookies = parseCookies;
exports.hashToken = hashToken;

exports._setStore = s => {
    store = s;
};
exports._reset = () => {
    store = null;
    flows.clear();
};

const StatePrefix = 'websignin.';
const FlowTimeoutSeconds = 10 * 60;
const MaxPendingFlows = 1000;
const MaxFormBytes = 2048;
const DefaultSessionDays = 30;
const TermUrl = '/_enig/ws-term/?connect=1';

//  Pages here carry no secrets in their URLs, but there is no reason to
//  cache them or tell the next site where the member came from
const NoStoreHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
};

//  flow id -> { nonce, did, handle, expiresAt }, for sign-ins in progress
const flows = new Map();

let store = null;
const getStore = () => {
    if (!store) {
        store = createWebSessionStore(dbs.atproto);
    }
    return store;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function isEnabled(config = Config()) {
    return (
        true === _.get(config, 'atProto.enabled') &&
        true === _.get(config, 'atProto.webSignIn.enabled')
    );
}

function sessionLifetimeSeconds(config = Config()) {
    const days = _.get(config, 'atProto.webSignIn.sessionDays', DefaultSessionDays);
    return Math.max(1, _.isFinite(days) ? days : DefaultSessionDays) * 24 * 60 * 60;
}

//  ── Cookies and origins ──────────────────────────────────────────────────

//  A Cookie header as { name: value }; the first of a repeated name wins
function parseCookies(header) {
    const cookies = {};
    if (!_.isString(header)) {
        return cookies;
    }
    header.split(';').forEach(part => {
        const eq = part.indexOf('=');
        if (eq < 1) {
            return;
        }
        const name = part.slice(0, eq).trim();
        if (name && !_.has(cookies, name)) {
            cookies[name] = part.slice(eq + 1).trim();
        }
    });
    return cookies;
}

//
//  Host-only (no Domain), so it is sent to every port of this host -- the
//  WebSocket server's included -- and nowhere else. SameSite=Lax: browsers
//  never send it with requests other sites start, apart from following a
//  link here (so the start page knows who you are).
//
function cookie(name, value, maxAgeSeconds) {
    return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

const originOf = url => {
    try {
        return new URL(url).origin;
    } catch (e) {
        return null;
    }
};

//
//  The board's own web addresses: its base URL, the 127.0.0.1 address
//  loopback mode sends callbacks to (and so sets cookies on), and any in
//  atProto.webSignIn.allowedOrigins
//
function allowedOrigins(config = Config()) {
    const origins = new Set();
    const add = url => {
        const origin = originOf(url);
        if (origin && 'null' !== origin) {
            origins.add(origin);
        }
    };

    try {
        add(getBaseUrl(config));
    } catch (e) {
        //  no web server configured
    }

    const port = _.get(config, 'contentServers.web.http.port');
    if (ClientModes.Loopback === _.get(config, 'atProto.oauth.clientMode') && port) {
        add(`http://127.0.0.1:${port}`);
    }

    _.castArray(_.get(config, 'atProto.webSignIn.allowedOrigins', [])).forEach(o => {
        if (_.isString(o)) {
            add(o);
        }
    });
    return origins;
}

function isAllowedOrigin(origin, config = Config()) {
    return _.isString(origin) && allowedOrigins(config).has(origin);
}

//  ── Sign-in flows ────────────────────────────────────────────────────────

function ownsState(state) {
    return _.isString(state) && state.startsWith(StatePrefix);
}

function pruneFlows(now) {
    for (const [id, flow] of flows) {
        if (flow.expiresAt <= now) {
            flows.delete(id);
        }
    }
}

function startFlow(identity) {
    const now = nowSeconds();
    pruneFlows(now);
    if (flows.size >= MaxPendingFlows) {
        return null;
    }
    const id = crypto.randomBytes(16).toString('hex');
    const flow = {
        nonce: randomToken(),
        did: identity.did,
        handle: identity.handle,
        expiresAt: now + FlowTimeoutSeconds,
    };
    flows.set(id, flow);
    return { state: `${StatePrefix}${id}`, flow };
}

//  The flow |state| names, removed: each completes once
function takeFlow(state) {
    if (!ownsState(state)) {
        return null;
    }
    const id = state.slice(StatePrefix.length);
    const flow = flows.get(id);
    flows.delete(id);
    return flow && flow.expiresAt > nowSeconds() ? flow : null;
}

function sameSecret(a, b) {
    if (!_.isString(a) || !_.isString(b)) {
        return false;
    }
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

//  ── Pages ────────────────────────────────────────────────────────────────

const Messages = {
    notFound: 'Could not find that handle. Check it and try again.',
    denied: 'The sign-in was not approved.',
    expired: 'That sign-in took too long or was already used. Start again.',
    otherBrowser: 'Finish signing in in the browser you started in.',
    failed: 'Signing in could not be completed. Try again.',
    busy: 'Too many sign-ins are in progress. Try again in a few minutes.',
    signedOut: 'You are signed out.',
};

function page(title, bodyHtml) {
    const boardName = _.escape(_.get(Config(), 'general.boardName', 'ENiGMA½ BBS'));
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>${_.escape(title)} - ${boardName}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
            form { margin: 1rem 0; }
            input[type=text] { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; }
            button, a.button { display: inline-block; margin-top: 0.75rem; padding: 0.5rem 1rem; font-size: 1rem; }
            .message { padding: 0.5rem; border: 1px solid; }
        </style>
    </head>
    <body>
        <h1>${boardName}</h1>
        ${bodyHtml}
    </body>
</html>`;
}

function sendPage(webServer, resp, title, bodyHtml) {
    return webServer.ok(resp, page(title, bodyHtml), {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        //  Not no-referrer: with that, browsers send "Origin: null" even on
        //  this page's own form posts, which checkFormOrigin() then refuses
        'Referrer-Policy': 'same-origin',
    });
}

function redirect(resp, location, cookies = []) {
    const headers = Object.assign({ Location: location }, NoStoreHeaders);
    if (cookies.length > 0) {
        headers['Set-Cookie'] = cookies;
    }
    resp.writeHead(303, headers);
    return resp.end();
}

const startPageWith = messageKey => `${exports.SignInRoutePath}?m=${messageKey}`;

//  The session a request's cookie names, as { tokenHash, did, handle }, or null
function sessionFromCookies(headers) {
    const token = parseCookies(_.get(headers, 'cookie'))[exports.SessionCookieName];
    if (!token) {
        return null;
    }
    const tokenHash = hashToken(token);
    const entry = getStore().get(tokenHash);
    return entry ? Object.assign({ tokenHash }, entry) : null;
}

//  GET: sign in, or for a signed-in browser, continue to the terminal
function routeStartPage(webServer, req, resp) {
    const query = querystring.parse((req.url.split('?')[1] || '').split('#')[0]);
    const message = _.isString(query.m) && _.has(Messages, query.m) && Messages[query.m];
    const messageHtml = message ? `<p class="message">${_.escape(message)}</p>` : '';

    let session = null;
    try {
        session = sessionFromCookies(req.headers);
    } catch (err) {
        Log.warn({ error: err.message }, 'Web sign-in: could not read session');
    }

    if (session) {
        const who = session.handle ? `@${session.handle}` : session.did;
        return sendPage(
            webServer,
            resp,
            'Signed In',
            `${messageHtml}
        <p>Signed in as <strong>${_.escape(who)}</strong>.</p>
        <p><a class="button" href="${TermUrl}">Continue to the board</a></p>
        <form method="post" action="${exports.SignOutRoutePath}">
            <button type="submit">Sign out</button>
        </form>`
        );
    }

    return sendPage(
        webServer,
        resp,
        'Sign In',
        `${messageHtml}
        <form method="post" action="${exports.SignInRoutePath}">
            <label for="handle">Your Bluesky handle</label>
            <input type="text" id="handle" name="handle" placeholder="alice.bsky.social"
                autocomplete="username" autocapitalize="off" spellcheck="false" required>
            <button type="submit">Sign in with Bluesky</button>
        </form>`
    );
}

//
//  A form POST must come from one of the board's own pages. Browsers send
//  Origin with every POST; one without it is not a browser form, and is
//  refused too.
//
function checkFormOrigin(webServer, req, resp) {
    if (isAllowedOrigin(_.get(req, 'headers.origin'))) {
        return true;
    }
    Log.info(
        { origin: _.get(req, 'headers.origin') },
        'Web sign-in: form posted from another site; refused'
    );
    webServer.accessDenied(resp);
    return false;
}

function readForm(req, cb) {
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
        if (tooBig) {
            return;
        }
        body += chunk;
        if (body.length > MaxFormBytes) {
            tooBig = true;
        }
    });
    req.on('end', () => cb(tooBig ? null : querystring.parse(body)));
    req.on('error', () => cb(null));
}

//  POST: start signing in with the handle given
function routeSignIn(webServer, req, resp) {
    if (!checkFormOrigin(webServer, req, resp)) {
        return;
    }
    if (!AtProtoOAuth.isReady()) {
        return webServer.serviceUnavailable(resp);
    }

    readForm(req, form => {
        if (!form) {
            return webServer.badRequest(resp);
        }
        const input = _.trim(_.isString(form.handle) ? form.handle : '').replace(
            /^@/,
            ''
        );
        if (!input) {
            return redirect(resp, exports.SignInRoutePath);
        }

        AtProtoOAuth.resolveIdentity(input, (err, identity) => {
            if (err) {
                Log.info(
                    { input, error: err.message },
                    'Web sign-in: could not resolve handle'
                );
                return redirect(resp, startPageWith('notFound'));
            }

            const started = startFlow(identity);
            if (!started) {
                Log.warn('Web sign-in: too many sign-ins in progress');
                return redirect(resp, startPageWith('busy'));
            }

            //  Authorizing the DID pins the sign-in to the account named here
            AtProtoOAuth.authorize(
                identity.did,
                { state: started.state },
                (err, authorizeUrl) => {
                    if (err) {
                        takeFlow(started.state);
                        Log.warn(
                            { did: identity.did, error: err.message },
                            'Web sign-in: could not start authorization'
                        );
                        return redirect(resp, startPageWith('failed'));
                    }
                    return redirect(resp, authorizeUrl, [
                        cookie(
                            exports.FlowCookieName,
                            started.flow.nonce,
                            FlowTimeoutSeconds
                        ),
                    ]);
                }
            );
        });
    });
}

//  POST: end this browser's session
function routeSignOut(webServer, req, resp) {
    if (!checkFormOrigin(webServer, req, resp)) {
        return;
    }
    try {
        const session = sessionFromCookies(req.headers);
        if (session) {
            getStore().del(session.tokenHash);
            Log.info({ did: session.did }, 'Web sign-in: signed out');
        }
    } catch (err) {
        Log.warn({ error: err.message }, 'Web sign-in: could not end session');
    }
    return redirect(resp, startPageWith('signedOut'), [
        cookie(exports.SessionCookieName, '', 0),
    ]);
}

//
//  The OAuth callback, for a |state| that ownsState(): |err| from the
//  library, or |result| { did, state }. Gives the browser its session cookie
//  and sends it on to the terminal.
//
function completeSignIn(webServer, req, resp, err, result) {
    const state = err ? err.state : _.get(result, 'state');
    const flow = takeFlow(state);
    const clearFlow = cookie(exports.FlowCookieName, '', 0);

    if (!flow) {
        return redirect(resp, startPageWith('expired'), [clearFlow]);
    }
    if (err) {
        Log.info({ error: err.message }, 'Web sign-in: not approved');
        return redirect(resp, startPageWith('denied'), [clearFlow]);
    }

    //  Started in this browser? Otherwise a link to someone else's sign-in
    //  could sign this browser in as them
    const nonce = parseCookies(_.get(req, 'headers.cookie'))[exports.FlowCookieName];
    if (!sameSecret(nonce, flow.nonce)) {
        Log.warn({ did: flow.did }, 'Web sign-in: finished in a different browser');
        return redirect(resp, startPageWith('otherBrowser'), [clearFlow]);
    }

    if (_.get(result, 'did') !== flow.did) {
        Log.warn(
            { expected: flow.did, approved: _.get(result, 'did') },
            'Web sign-in: approved by a different account'
        );
        return redirect(resp, startPageWith('failed'), [clearFlow]);
    }

    const token = randomToken();
    const lifetimeSeconds = sessionLifetimeSeconds();
    try {
        getStore().add(hashToken(token), {
            did: flow.did,
            handle: flow.handle,
            lifetimeSeconds,
        });
    } catch (e) {
        Log.error({ error: e.message }, 'Web sign-in: could not save session');
        return redirect(resp, startPageWith('failed'), [clearFlow]);
    }

    Log.info({ did: flow.did }, 'Web sign-in: signed in');
    return redirect(resp, TermUrl, [
        clearFlow,
        cookie(exports.SessionCookieName, token, lifetimeSeconds),
    ]);
}

//  ── Connections ──────────────────────────────────────────────────────────

//  The library's errors for a grant that no longer stands
const SessionGoneErrors = ['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'];
const isSessionGone = err => SessionGoneErrors.includes(_.get(err, 'constructor.name'));

//
//  Who a WebSocket connection is signed in as, from its upgrade request's
//  |headers|: calls back with { did, handle } or null. Never fails: anything
//  that doesn't check out leaves the connection to log in as usual.
//
function identityForConnection(headers, cb) {
    if (!isEnabled() || !AtProtoOAuth.isReady()) {
        return setImmediate(() => cb(null, null));
    }

    const token = parseCookies(_.get(headers, 'cookie'))[exports.SessionCookieName];
    if (!token) {
        return setImmediate(() => cb(null, null));
    }

    const origin = _.get(headers, 'origin');
    if (!isAllowedOrigin(origin)) {
        Log.info(
            { origin },
            'Web sign-in: cookie on a connection from another site; ignored'
        );
        return setImmediate(() => cb(null, null));
    }

    let session;
    try {
        session = sessionFromCookies(headers);
    } catch (err) {
        Log.warn({ error: err.message }, 'Web sign-in: could not read session');
        return setImmediate(() => cb(null, null));
    }
    if (!session) {
        return setImmediate(() => cb(null, null));
    }

    AtProtoOAuth.restore(session.did, { refresh: true }, err => {
        if (err) {
            if (isSessionGone(err)) {
                Log.info(
                    { did: session.did, error: err.message },
                    'Web sign-in: AT access ended; signing the member out'
                );
                try {
                    getStore().delAllForDid(session.did);
                } catch (e) {
                    Log.warn({ error: e.message }, 'Web sign-in: could not end sessions');
                }
            } else {
                Log.warn(
                    { did: session.did, error: err.message },
                    'Web sign-in: could not check AT access; log in as usual'
                );
            }
            return cb(null, null);
        }

        try {
            getStore().touch(session.tokenHash, session.handle);
        } catch (e) {
            //  only the last-used time
        }
        return cb(null, { did: session.did, handle: session.handle });
    });
}
