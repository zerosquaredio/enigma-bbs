'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');

const testConfig = {
    debug: { assertsEnabled: false },
    atProto: { enabled: true, oauth: { clientMode: 'loopback' } },
    contentServers: {
        web: {
            domain: 'bbs.example',
            http: { enabled: true, port: 8080 },
            https: { enabled: false },
            rateLimits: {},
        },
    },
};

//  A stand-in for the web server, recording routes and responses
function makeFakeWebServer() {
    return {
        routes: [],
        isEnabled: () => true,
        addRoute(route) {
            this.routes.push(route);
            return true;
        },
        checkRateLimit: () => true,
        serviceUnavailable(resp) {
            resp.writeHead(503);
            resp.end();
        },
        respondWithError(resp, code, bodyText, title, headers) {
            resp.writeHead(code, headers);
            resp.end(bodyText);
        },
        ok(resp, body, headers) {
            resp.writeHead(200, headers);
            resp.end(body);
        },
    };
}

function request(handler, url) {
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
        handler({ method: 'GET', url }, resp);
    });
}

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('AT login web handler', () => {
    let previousConfigGet;
    let AtProtoOAuth;
    let BrowserHandoff;
    let Handler;
    let saved;
    let webServer;
    let handler;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        //  Fresh loads, so these capture the config getter above
        [
            '../core/web_util.js',
            '../core/browser_handoff.js',
            '../core/atproto/oauth_client.js',
            '../core/servers/content/web_handlers/atproto.js',
        ].forEach(m => delete require.cache[require.resolve(m)]);

        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        BrowserHandoff = require('../core/browser_handoff.js');
        Handler = require('../core/servers/content/web_handlers/atproto.js');

        saved = {
            isReady: AtProtoOAuth.isReady,
            handleCallback: AtProtoOAuth.handleCallback,
        };
    });

    after(() => {
        Object.assign(AtProtoOAuth, saved);
        BrowserHandoff._reset();
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(async () => {
        testConfig.atProto.enabled = true;
        BrowserHandoff._reset();
        webServer = makeFakeWebServer();
        BrowserHandoff._setWebServerGetter(() => webServer);
        AtProtoOAuth.isReady = () => true;

        const inst = new Handler.getModule();
        await call(inst.init.bind(inst), webServer);
        const route = webServer.routes.find(r => r.path.test('/_enig/atproto/callback'));
        handler = route && route.handler;
    });

    const startHandoff = () =>
        call(BrowserHandoff.create, {
            purpose: 'atproto-login',
            onOpen: (h, cb) => cb(null, 'https://bsky.social/oauth/authorize'),
        });

    it('adds the callback route and the handoff route', () => {
        assert.ok(handler);
        assert.ok(webServer.routes.some(r => r.path.test('/_enig/handoff/7F3K-9QXM')));
        const callback = webServer.routes.find(r => r.handler === handler);
        assert.ok(callback.path.test('/_enig/atproto/callback?code=x&state=y&iss=z'));
        assert.ok(!callback.path.test('/_enig/atproto/callbackX'));
    });

    it('adds no routes when atProto.enabled is false', async () => {
        testConfig.atProto.enabled = false;
        webServer = makeFakeWebServer();
        const inst = new Handler.getModule();
        await call(inst.init.bind(inst), webServer);
        assert.equal(webServer.routes.length, 0);
    });

    it('completes the waiting handoff with the approved DID', async () => {
        const handoff = await startHandoff();
        let seenQuery;
        AtProtoOAuth.handleCallback = (query, cb) => {
            seenQuery = query;
            setImmediate(() => cb(null, { did: 'did:plc:alice', state: handoff.id }));
        };

        const waited = call(handoff.wait.bind(handoff));
        const resp = await request(
            handler,
            '/_enig/atproto/callback?code=c&state=s&iss=i'
        );

        assert.equal(seenQuery, 'code=c&state=s&iss=i');
        assert.equal(resp.statusCode, 200);
        assert.match(resp.body, /return to your terminal/);
        assert.equal(resp.headers['Cache-Control'], 'no-store');
        assert.deepEqual(await waited, { did: 'did:plc:alice' });
    });

    it('ends the waiting handoff when the member denies the login', async () => {
        const handoff = await startHandoff();
        AtProtoOAuth.handleCallback = (query, cb) => {
            const err = new Error('access_denied');
            err.state = handoff.id;
            setImmediate(() => cb(err));
        };

        const waited = call(handoff.wait.bind(handoff));
        const resp = await request(
            handler,
            '/_enig/atproto/callback?error=access_denied'
        );

        assert.equal(resp.statusCode, 400);
        await assert.rejects(waited, { message: /Login not approved/ });
    });

    it('reports a failed callback it cannot match to a handoff', async () => {
        AtProtoOAuth.handleCallback = (query, cb) =>
            setImmediate(() => cb(new Error('Unknown authorization session')));
        const resp = await request(handler, '/_enig/atproto/callback?state=stale');
        assert.equal(resp.statusCode, 400);
    });

    it('says the login expired when the handoff has already ended', async () => {
        const handoff = await startHandoff();
        handoff.cancel();
        AtProtoOAuth.handleCallback = (query, cb) =>
            setImmediate(() => cb(null, { did: 'did:plc:alice', state: handoff.id }));
        const resp = await request(handler, '/_enig/atproto/callback?code=c');
        assert.equal(resp.statusCode, 410);
    });

    it('is unavailable until AT support has started', async () => {
        AtProtoOAuth.isReady = () => false;
        const resp = await request(handler, '/_enig/atproto/callback?code=c');
        assert.equal(resp.statusCode, 503);
    });
});
