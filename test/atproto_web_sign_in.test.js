'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const { initAtProtoDatabase } = require('../core/database.js');
const { createWebSessionStore } = require('../core/atproto/store.js');

const BoardOrigin = 'https://bbs.example';
const LoopbackOrigin = 'http://127.0.0.1:8080';

let testConfig;
const baseConfig = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'Test <BBS>' },
    atProto: {
        enabled: true,
        oauth: { clientMode: 'loopback' },
        webSignIn: { enabled: true, sessionDays: 30, allowedOrigins: [] },
    },
    contentServers: {
        web: {
            domain: 'bbs.example',
            http: { enabled: true, port: 8080 },
            https: { enabled: true, port: 443 },
            rateLimits: {},
        },
    },
});

//  A stand-in for the web server, recording routes and responses
function makeFakeWebServer() {
    const respond = code => resp => {
        resp.writeHead(code, {});
        resp.end('');
    };
    return {
        routes: [],
        isEnabled: () => true,
        addRoute(route) {
            this.routes.push(route);
            return true;
        },
        checkRateLimit: () => true,
        ok(resp, body, headers) {
            resp.writeHead(200, headers);
            resp.end(body);
        },
        respondWithError(resp, code, bodyText, title, headers) {
            resp.writeHead(code, headers);
            resp.end(bodyText);
        },
        accessDenied: respond(401),
        badRequest: respond(400),
        serviceUnavailable: respond(503),
    };
}

//  A request as the web server passes it to a route: |body| is sent as the
//  request's data once the handler is listening
function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers });
    if (undefined !== body) {
        setImmediate(() => {
            req.emit('data', Buffer.from(body));
            req.emit('end');
        });
    }
    return req;
}

//  Run |handler(req, resp)|, resolving with the response once it ends
function run(handler, req) {
    return new Promise(resolve => {
        const resp = {
            statusCode: null,
            headers: {},
            body: '',
            writeHead(code, headers) {
                resp.statusCode = code;
                Object.assign(resp.headers, headers);
            },
            end(body) {
                resp.body = body || '';
                resolve(resp);
            },
        };
        handler(req, resp);
    });
}

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

//  Set-Cookie values from a response, as { name: { value, attributes } }
function setCookies(resp) {
    const cookies = {};
    [].concat(resp.headers['Set-Cookie'] || []).forEach(c => {
        const [pair, ...attrs] = c.split(';').map(s => s.trim());
        const eq = pair.indexOf('=');
        cookies[pair.slice(0, eq)] = { value: pair.slice(eq + 1), attributes: attrs };
    });
    return cookies;
}

describe('AT web sign-in', () => {
    let previousConfigGet;
    let AtProtoOAuth;
    let WebSignIn;
    let Handler;
    let saved;
    let db;
    let clock;
    let store;
    let webServer;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        //  Fresh loads, so these capture the config getter above
        [
            '../core/web_util.js',
            '../core/browser_handoff.js',
            '../core/atproto/oauth_client.js',
            '../core/atproto/web_sign_in.js',
            '../core/servers/content/web_handlers/atproto.js',
        ].forEach(m => delete require.cache[require.resolve(m)]);

        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        WebSignIn = require('../core/atproto/web_sign_in.js');
        Handler = require('../core/servers/content/web_handlers/atproto.js');

        saved = Object.assign({}, AtProtoOAuth);
    });

    after(() => {
        Object.assign(AtProtoOAuth, saved);
        WebSignIn._reset();
        require('../core/browser_handoff.js')._reset();
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(() => {
        testConfig = baseConfig();
        Object.assign(AtProtoOAuth, saved);
        AtProtoOAuth.isReady = () => true;

        db = new Database(':memory:');
        initAtProtoDatabase(db);
        clock = 1_800_000_000;
        store = createWebSessionStore(db, { now: () => clock });
        WebSignIn._reset();
        WebSignIn._setStore(store);
        webServer = makeFakeWebServer();
    });

    afterEach(() => {
        db.close();
    });

    //  A signed-in browser: its cookie header
    const signedIn = (did = 'did:plc:alice', handle = 'alice.test') => {
        const token = `tok-${did}-${Math.random()}`;
        store.add(WebSignIn.hashToken(token), { did, handle, lifetimeSeconds: 3600 });
        return `${WebSignIn.SessionCookieName}=${token}`;
    };

    //  Start a sign-in for |identity| through the start page's form, as a
    //  browser would: the redirect, the flow cookie, and the state passed to
    //  the account host
    async function startSignIn(
        identity = { did: 'did:plc:alice', handle: 'alice.test' }
    ) {
        let state;
        AtProtoOAuth.resolveIdentity = (input, cb) =>
            setImmediate(() => cb(null, identity));
        AtProtoOAuth.authorize = (input, options, cb) => {
            state = options.state;
            setImmediate(() => cb(null, 'https://bsky.social/oauth/authorize?x=1'));
        };
        const resp = await run(
            (req, res) => WebSignIn.routeSignIn(webServer, req, res),
            makeReq({
                method: 'POST',
                url: '/_enig/signin',
                headers: { origin: BoardOrigin },
                body: `handle=${encodeURIComponent('@' + identity.handle)}`,
            })
        );
        return { resp, state, flowCookie: setCookies(resp)[WebSignIn.FlowCookieName] };
    }

    const callback = (cookieHeader, err, result) =>
        run(
            (req, res) => WebSignIn.completeSignIn(webServer, req, res, err, result),
            makeReq({
                url: '/_enig/atproto/callback?code=c',
                headers: cookieHeader ? { cookie: cookieHeader } : {},
            })
        );

    describe('session store', () => {
        it('keeps sessions by token hash, until they expire', () => {
            store.add('h1', { did: 'did:plc:a', handle: 'a.test', lifetimeSeconds: 60 });
            assert.deepEqual(store.get('h1'), {
                did: 'did:plc:a',
                handle: 'a.test',
                expiresAt: clock + 60,
            });
            clock += 60;
            assert.equal(store.get('h1'), undefined);
        });

        it('removes one session, or all of a DID', () => {
            store.add('h1', { did: 'did:plc:a', lifetimeSeconds: 60 });
            store.add('h2', { did: 'did:plc:a', lifetimeSeconds: 60 });
            store.add('h3', { did: 'did:plc:b', lifetimeSeconds: 60 });
            store.del('h1');
            assert.equal(store.get('h1'), undefined);
            store.delAllForDid('did:plc:a');
            assert.equal(store.get('h2'), undefined);
            assert.ok(store.get('h3'));
        });

        it('drops expired sessions when adding one', () => {
            store.add('old', { did: 'did:plc:a', lifetimeSeconds: 10 });
            clock += 20;
            store.add('new', { did: 'did:plc:a', lifetimeSeconds: 10 });
            const rows = db.prepare('SELECT token_hash FROM web_session').all();
            assert.deepEqual(
                rows.map(r => r.token_hash),
                ['new']
            );
        });
    });

    describe('cookies and origins', () => {
        it('parses a Cookie header, first of a name winning', () => {
            assert.deepEqual(WebSignIn.parseCookies('a=1; b=two=2;a=3; =x; junk'), {
                a: '1',
                b: 'two=2',
            });
            assert.deepEqual(WebSignIn.parseCookies(undefined), {});
        });

        it("allows the board's own origin, loopback mode's, and configured ones", () => {
            assert.ok(WebSignIn.isAllowedOrigin(BoardOrigin));
            assert.ok(WebSignIn.isAllowedOrigin(LoopbackOrigin));
            assert.ok(!WebSignIn.isAllowedOrigin('https://evil.example'));
            assert.ok(!WebSignIn.isAllowedOrigin('null'));
            assert.ok(!WebSignIn.isAllowedOrigin(undefined));

            testConfig.atProto.webSignIn.allowedOrigins = ['https://term.example/path'];
            assert.ok(WebSignIn.isAllowedOrigin('https://term.example'));

            testConfig.atProto.oauth.clientMode = 'public';
            assert.ok(!WebSignIn.isAllowedOrigin(LoopbackOrigin));
        });
    });

    describe('start page', () => {
        const startPage = headers =>
            run(
                (req, res) => WebSignIn.routeStartPage(webServer, req, res),
                makeReq({ url: '/_enig/signin?m=constructor', headers })
            );

        it('offers sign-in to a browser that is not signed in', async () => {
            const resp = await startPage({});
            assert.equal(resp.statusCode, 200);
            assert.match(resp.body, /action="\/_enig\/signin"/);
            assert.match(resp.body, /Test &lt;BBS&gt;/);
            assert.doesNotMatch(resp.body, /function|class="message"/);
            assert.equal(resp.headers['Cache-Control'], 'no-store');
            //  Not no-referrer, which would make the form post "Origin: null"
            assert.equal(resp.headers['Referrer-Policy'], 'same-origin');
        });

        it('offers to continue, or sign out, to a signed-in browser', async () => {
            const resp = await startPage({ cookie: signedIn() });
            assert.match(resp.body, /Signed in as <strong>@alice\.test<\/strong>/);
            assert.match(resp.body, /href="\/_enig\/ws-term\/\?connect=1"/);
            assert.match(resp.body, /action="\/_enig\/signout"/);
        });

        it('shows a known message', async () => {
            const resp = await run(
                (req, res) => WebSignIn.routeStartPage(webServer, req, res),
                makeReq({ url: '/_enig/signin?m=denied' })
            );
            assert.match(resp.body, /class="message">The sign-in was not approved/);
        });
    });

    describe('signing in', () => {
        it('sends the browser to the account host with a flow cookie', async () => {
            const { resp, state, flowCookie } = await startSignIn();
            assert.equal(resp.statusCode, 303);
            assert.equal(
                resp.headers.Location,
                'https://bsky.social/oauth/authorize?x=1'
            );
            assert.ok(WebSignIn.ownsState(state));
            assert.ok(flowCookie.value.length >= 40);
            ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'].forEach(a =>
                assert.ok(flowCookie.attributes.includes(a), a)
            );
        });

        it('refuses a form posted from another site, or with no Origin', async () => {
            for (const headers of [{ origin: 'https://evil.example' }, {}]) {
                const resp = await run(
                    (req, res) => WebSignIn.routeSignIn(webServer, req, res),
                    makeReq({ method: 'POST', headers, body: 'handle=alice.test' })
                );
                assert.equal(resp.statusCode, 401);
            }
        });

        it('says so when the handle cannot be found', async () => {
            AtProtoOAuth.resolveIdentity = (input, cb) =>
                setImmediate(() => cb(new Error('nope')));
            const resp = await run(
                (req, res) => WebSignIn.routeSignIn(webServer, req, res),
                makeReq({
                    method: 'POST',
                    headers: { origin: BoardOrigin },
                    body: 'handle=nobody.test',
                })
            );
            assert.equal(resp.headers.Location, '/_enig/signin?m=notFound');
        });

        it('refuses an oversized form', async () => {
            const resp = await run(
                (req, res) => WebSignIn.routeSignIn(webServer, req, res),
                makeReq({
                    method: 'POST',
                    headers: { origin: BoardOrigin },
                    body: `handle=${'a'.repeat(5000)}`,
                })
            );
            assert.equal(resp.statusCode, 400);
        });

        it('gives the browser a session cookie when the account host approves', async () => {
            const { state, flowCookie } = await startSignIn();
            const resp = await callback(
                `${WebSignIn.FlowCookieName}=${flowCookie.value}`,
                null,
                { did: 'did:plc:alice', state }
            );

            assert.equal(resp.statusCode, 303);
            assert.equal(resp.headers.Location, '/_enig/ws-term/?connect=1');
            const cookies = setCookies(resp);
            assert.ok(cookies[WebSignIn.FlowCookieName].attributes.includes('Max-Age=0'));
            const session = cookies[WebSignIn.SessionCookieName];
            assert.ok(session.attributes.includes(`Max-Age=${30 * 24 * 60 * 60}`));
            ['HttpOnly', 'Secure', 'SameSite=Lax'].forEach(a =>
                assert.ok(session.attributes.includes(a), a)
            );

            //  Only a hash of the token is stored
            const stored = store.get(WebSignIn.hashToken(session.value));
            assert.equal(stored.did, 'did:plc:alice');
            assert.equal(stored.handle, 'alice.test');
            assert.equal(store.get(session.value), undefined);
        });

        it('refuses to finish in a browser that did not start the sign-in', async () => {
            const { state } = await startSignIn();
            const resp = await callback(
                `${WebSignIn.FlowCookieName}=someone-else`,
                null,
                {
                    did: 'did:plc:alice',
                    state,
                }
            );
            assert.equal(resp.headers.Location, '/_enig/signin?m=otherBrowser');
            assert.ok(!setCookies(resp)[WebSignIn.SessionCookieName]);
        });

        it('refuses an approval by a different account', async () => {
            const { state, flowCookie } = await startSignIn();
            const resp = await callback(
                `${WebSignIn.FlowCookieName}=${flowCookie.value}`,
                null,
                { did: 'did:plc:mallory', state }
            );
            assert.equal(resp.headers.Location, '/_enig/signin?m=failed');
            assert.ok(!setCookies(resp)[WebSignIn.SessionCookieName]);
        });

        it('completes each sign-in once', async () => {
            const { state, flowCookie } = await startSignIn();
            const cookie = `${WebSignIn.FlowCookieName}=${flowCookie.value}`;
            await callback(cookie, null, { did: 'did:plc:alice', state });
            const again = await callback(cookie, null, { did: 'did:plc:alice', state });
            assert.equal(again.headers.Location, '/_enig/signin?m=expired');
        });

        it('says so when the member denies it', async () => {
            const { state, flowCookie } = await startSignIn();
            const err = new Error('access_denied');
            err.state = state;
            const resp = await callback(
                `${WebSignIn.FlowCookieName}=${flowCookie.value}`,
                err
            );
            assert.equal(resp.headers.Location, '/_enig/signin?m=denied');
        });

        it('signs a browser out', async () => {
            const cookie = signedIn();
            const resp = await run(
                (req, res) => WebSignIn.routeSignOut(webServer, req, res),
                makeReq({ method: 'POST', headers: { origin: BoardOrigin, cookie } })
            );
            assert.equal(resp.headers.Location, '/_enig/signin?m=signedOut');
            assert.ok(
                setCookies(resp)[WebSignIn.SessionCookieName].attributes.includes(
                    'Max-Age=0'
                )
            );
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_session').get().n, 0);
        });
    });

    describe('WebSocket connections', () => {
        let restores;
        beforeEach(() => {
            restores = [];
            AtProtoOAuth.restore = (did, options, cb) => {
                restores.push({ did, options });
                setImmediate(() => cb(null, { did }));
            };
        });

        const identityFor = headers => call(WebSignIn.identityForConnection, headers);

        it('is the signed-in member, after their AT session refreshes', async () => {
            const cookie = signedIn();
            const identity = await identityFor({ cookie, origin: LoopbackOrigin });
            assert.deepEqual(identity, { did: 'did:plc:alice', handle: 'alice.test' });
            assert.deepEqual(restores, [
                { did: 'did:plc:alice', options: { refresh: true } },
            ]);
        });

        it('is nobody without a cookie, or with an unknown one', async () => {
            assert.equal(await identityFor({ origin: BoardOrigin }), null);
            assert.equal(
                await identityFor({
                    origin: BoardOrigin,
                    cookie: `${WebSignIn.SessionCookieName}=forged`,
                }),
                null
            );
            assert.equal(restores.length, 0);
        });

        it("ignores the cookie on a connection from another site's page", async () => {
            const cookie = signedIn();
            assert.equal(
                await identityFor({ cookie, origin: 'https://evil.example' }),
                null
            );
            assert.equal(await identityFor({ cookie }), null);
            assert.equal(restores.length, 0);
        });

        it('is nobody while web sign-in is off', async () => {
            const cookie = signedIn();
            testConfig.atProto.webSignIn.enabled = false;
            assert.equal(await identityFor({ cookie, origin: BoardOrigin }), null);
        });

        it("ends the member's web sessions once they revoke the board's access", async () => {
            class TokenRefreshError extends Error {}
            AtProtoOAuth.restore = (did, options, cb) =>
                setImmediate(() => cb(new TokenRefreshError('The session was revoked')));

            const cookie = signedIn();
            const other = signedIn();
            assert.equal(await identityFor({ cookie, origin: BoardOrigin }), null);
            assert.equal(await identityFor({ cookie: other, origin: BoardOrigin }), null);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_session').get().n, 0);
        });

        it('keeps the sessions when the account host cannot be reached', async () => {
            AtProtoOAuth.restore = (did, options, cb) =>
                setImmediate(() => cb(new Error('ECONNREFUSED')));

            const cookie = signedIn();
            assert.equal(await identityFor({ cookie, origin: BoardOrigin }), null);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_session').get().n, 1);
        });
    });

    describe('web handler', () => {
        const init = async () => {
            const BrowserHandoff = require('../core/browser_handoff.js');
            BrowserHandoff._reset();
            BrowserHandoff._setWebServerGetter(() => webServer);
            const inst = new Handler.getModule();
            await call(inst.init.bind(inst), webServer);
            return inst;
        };
        const routeFor = (method, url) =>
            webServer.routes.find(r => r.method === method && r.path.test(url));

        it('adds the sign-in routes only when web sign-in is on', async () => {
            await init();
            assert.ok(routeFor('GET', '/_enig/signin'));
            assert.ok(routeFor('GET', '/_enig/signin?m=denied'));
            assert.ok(routeFor('POST', '/_enig/signin'));
            assert.ok(routeFor('POST', '/_enig/signout'));
            assert.ok(!routeFor('GET', '/_enig/signinX'));

            testConfig.atProto.webSignIn.enabled = false;
            webServer = makeFakeWebServer();
            await init();
            assert.ok(!routeFor('GET', '/_enig/signin'));
        });

        it('hands web sign-in callbacks to web sign-in', async () => {
            await init();
            const { state, flowCookie } = await startSignIn();
            AtProtoOAuth.handleCallback = (query, cb) =>
                setImmediate(() => cb(null, { did: 'did:plc:alice', state }));

            const resp = await run(
                routeFor('GET', '/_enig/atproto/callback?code=c').handler,
                makeReq({
                    url: '/_enig/atproto/callback?code=c&state=s',
                    headers: {
                        cookie: `${WebSignIn.FlowCookieName}=${flowCookie.value}`,
                    },
                })
            );
            assert.equal(resp.statusCode, 303);
            assert.equal(resp.headers.Location, '/_enig/ws-term/?connect=1');
        });
    });
});
