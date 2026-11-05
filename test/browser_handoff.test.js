'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');

const testConfig = {
    debug: { assertsEnabled: false },
    general: { boardName: 'Test BBS' },
    contentServers: {
        web: {
            domain: 'bbs.example',
            http: { enabled: true, port: 8080 },
            https: { enabled: true, port: 443 },
            rateLimits: { handoffGet: { windowMs: 60000, maxRequests: 100 } },
        },
    },
};

//  A stand-in for the web server, recording what the handoff module asks of it
function makeFakeWebServer({ enabled = true, rateLimited = false } = {}) {
    return {
        routes: [],
        errors: [],
        rateLimitChecks: [],
        isEnabled: () => enabled,
        addRoute(route) {
            this.routes.push(route);
            return true;
        },
        checkRateLimit(req, resp, key, opts) {
            this.rateLimitChecks.push({ key, opts });
            if (rateLimited) {
                resp.writeHead(429);
                resp.end();
                return false;
            }
            return true;
        },
        respondWithError(resp, code, bodyText, title, extraHeaders) {
            this.errors.push({ code, bodyText });
            resp.writeHead(code, extraHeaders);
            resp.end(bodyText);
        },
    };
}

//  Calls |onDone| with the response once the handler has ended it
function makeResponse(onDone) {
    const resp = {
        statusCode: null,
        headers: {},
        writeHead(code, headers) {
            resp.statusCode = code;
            Object.assign(resp.headers, headers);
        },
        end() {
            onDone(resp);
        },
    };
    return resp;
}

//  Turn a callback-style call into a Promise so the tests can await it
const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('browser handoff', () => {
    let previousConfigGet;
    let Handoff;
    let webServer;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        //  Fresh loads, so these capture the config getter above
        delete require.cache[require.resolve('../core/web_util.js')];
        delete require.cache[require.resolve('../core/browser_handoff.js')];
        Handoff = require('../core/browser_handoff.js');
    });

    after(() => {
        Handoff._reset();
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(() => {
        Handoff._reset();
        webServer = makeFakeWebServer();
        Handoff._setWebServerGetter(() => webServer);
    });

    const redirectTo = url => (handoff, cb) => setImmediate(() => cb(null, url));

    const createHandoff = (options = {}) =>
        call(
            Handoff.create,
            Object.assign(
                { purpose: 'test', onOpen: redirectTo('https://auth.example/approve') },
                options
            )
        );

    //  Open |code|'s landing URL and resolve with the response
    const open = code =>
        new Promise(resolve => {
            const req = { method: 'GET', url: `/_enig/handoff/${code}` };
            Handoff._routeOpen(req, makeResponse(resolve));
        });

    describe('create', () => {
        it('gives a short code, a landing URL, and a separate long id', async () => {
            const handoff = await createHandoff();
            assert.match(handoff.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
            assert.equal(
                handoff.url,
                `https://bbs.example/_enig/handoff/${handoff.code}`
            );
            assert.match(handoff.id, /^[0-9a-f]{32}$/);
            assert.equal(handoff.purpose, 'test');
            assert.ok(handoff.expiresAt > new Date());
        });

        it('gives every waiting handoff a different code and id', async () => {
            const handoffs = await Promise.all([...Array(50)].map(() => createHandoff()));
            assert.equal(new Set(handoffs.map(h => h.code)).size, 50);
            assert.equal(new Set(handoffs.map(h => h.id)).size, 50);
        });

        it('requires a purpose and an onOpen function', async () => {
            await assert.rejects(call(Handoff.create, { purpose: 'test' }), {
                message: /Missing parameter/,
            });
            await assert.rejects(call(Handoff.create, { onOpen: () => {} }), {
                message: /Missing parameter/,
            });
        });

        it('rejects a timeout that is not positive', async () => {
            await assert.rejects(createHandoff({ timeoutSeconds: 0 }), {
                reason: /timeoutSeconds/,
            });
        });

        it('refuses new handoffs once too many are waiting', async () => {
            for (let i = 0; i < 1000; ++i) {
                await createHandoff();
            }
            await assert.rejects(createHandoff(), { reason: /Too many/ });
        });
    });

    describe('waiting', () => {
        it('delivers the result passed to complete()', async () => {
            const handoff = await createHandoff();
            const waited = call(handoff.wait.bind(handoff));
            assert.equal(Handoff.complete(handoff.id, { did: 'did:plc:alice' }), true);
            assert.deepEqual(await waited, { did: 'did:plc:alice' });
        });

        it('delivers a result that arrived before wait() was called', async () => {
            const handoff = await createHandoff();
            Handoff.complete(handoff.id, 'early');
            assert.equal(await call(handoff.wait.bind(handoff)), 'early');
        });

        it('delivers the error passed to fail()', async () => {
            const handoff = await createHandoff();
            const waited = call(handoff.wait.bind(handoff));
            Handoff.fail(handoff.id, new Error('Approval denied'));
            await assert.rejects(waited, { message: 'Approval denied' });
        });

        it('times out when nothing completes it', async () => {
            const handoff = await createHandoff({ timeoutSeconds: 0.05 });
            await assert.rejects(call(handoff.wait.bind(handoff)), {
                message: /^Timeout/,
            });
            assert.equal(Handoff.complete(handoff.id, 'late'), false);
        });

        it('ends with an interruption when cancelled', async () => {
            const handoff = await createHandoff();
            const waited = call(handoff.wait.bind(handoff));
            handoff.cancel();
            await assert.rejects(waited, { message: /^User interrupted/ });
        });

        it('accepts only the first outcome', async () => {
            const handoff = await createHandoff();
            const waited = call(handoff.wait.bind(handoff));
            assert.equal(Handoff.complete(handoff.id, 'first'), true);
            assert.equal(Handoff.complete(handoff.id, 'second'), false);
            assert.equal(Handoff.fail(handoff.id, new Error('late')), false);
            assert.equal(handoff.cancel(), false);
            assert.equal(await waited, 'first');
        });

        it('ignores an unknown id', () => {
            assert.equal(Handoff.complete('0'.repeat(32), 'x'), false);
            assert.equal(Handoff.fail('0'.repeat(32)), false);
        });

        it('allows only one waiter', async () => {
            const handoff = await createHandoff();
            handoff.wait(() => {});
            await assert.rejects(call(handoff.wait.bind(handoff)), {
                reason: /Already waiting/,
            });
        });

        it('never calls the waiter synchronously', done => {
            createHandoff().then(handoff => {
                let returned = false;
                handoff.wait(err => {
                    assert.equal(returned, true);
                    return done(err);
                });
                Handoff.complete(handoff.id, 'x');
                returned = true;
            });
        });
    });

    describe('codes typed by people', () => {
        it('accepts any case, with or without the dash', () => {
            assert.equal(Handoff.normalizeCode('7f3k9qxm'), '7F3K-9QXM');
            assert.equal(Handoff.normalizeCode('7F3K-9QXM'), '7F3K-9QXM');
        });

        it('reads O as 0, and I or L as 1', () => {
            assert.equal(Handoff.normalizeCode('O0IL-ABCD'), '0011-ABCD');
        });

        it('rejects the wrong length or characters outside the alphabet', () => {
            assert.equal(Handoff.normalizeCode('7F3K'), null);
            assert.equal(Handoff.normalizeCode('7F3K-9QXMZ'), null);
            assert.equal(Handoff.normalizeCode('7F3K-9QXU'), null);
            assert.equal(Handoff.normalizeCode(undefined), null);
        });
    });

    describe('landing route', () => {
        it('is registered once, as a GET under /_enig/handoff/', async () => {
            await call(Handoff.registerRoutes);
            await call(Handoff.registerRoutes);
            assert.equal(webServer.routes.length, 1);

            const [route] = webServer.routes;
            assert.equal(route.method, 'GET');
            assert.ok(route.path.test('/_enig/handoff/7F3K-9QXM'));
            assert.ok(!route.path.test('/_enig/handoff/7F3K-9QXM?x=1'));
            assert.ok(!route.path.test('/_enig/handoff/'));
        });

        it('is not registered when the web server is off', async () => {
            webServer = makeFakeWebServer({ enabled: false });
            await assert.rejects(call(Handoff.registerRoutes), {
                reason: /web server/,
            });
            assert.equal(webServer.routes.length, 0);
        });

        it('redirects to the page onOpen supplies, without caching or a Referer', async () => {
            const handoff = await createHandoff();
            const resp = await open(handoff.code);
            assert.equal(resp.statusCode, 302);
            assert.equal(resp.headers.Location, 'https://auth.example/approve');
            assert.equal(resp.headers['Cache-Control'], 'no-store');
            assert.equal(resp.headers['Referrer-Policy'], 'no-referrer');
        });

        it('asks onOpen for a fresh page on each open', async () => {
            let opens = 0;
            const handoff = await createHandoff({
                onOpen: (h, cb) => cb(null, `https://auth.example/approve/${++opens}`),
            });
            await open(handoff.code);
            const resp = await open(handoff.code.toLowerCase().replace('-', ''));
            assert.equal(resp.headers.Location, 'https://auth.example/approve/2');
        });

        it('says the link is gone for an unknown code', async () => {
            const resp = await open('ZZZZ-ZZZZ');
            assert.equal(resp.statusCode, 410);
        });

        it('says the link is gone once the handoff has ended', async () => {
            const handoff = await createHandoff();
            Handoff.complete(handoff.id, 'done');
            assert.equal((await open(handoff.code)).statusCode, 410);
        });

        it('stops after ten opens of one link', async () => {
            const handoff = await createHandoff();
            for (let i = 0; i < 10; ++i) {
                assert.equal((await open(handoff.code)).statusCode, 302);
            }
            assert.equal((await open(handoff.code)).statusCode, 410);
        });

        it('reports a page that could not be prepared, and leaves the handoff waiting', async () => {
            const handoff = await createHandoff({
                onOpen: (h, cb) => cb(new Error('authorization server unreachable')),
            });
            const resp = await open(handoff.code);
            assert.equal(resp.statusCode, 502);
            assert.equal(handoff.isFinished(), false);
        });

        it('applies the configured rate limit', async () => {
            webServer = makeFakeWebServer({ rateLimited: true });
            const handoff = await createHandoff();
            const resp = await open(handoff.code);
            assert.equal(resp.statusCode, 429);
            assert.deepEqual(webServer.rateLimitChecks, [
                { key: 'handoffGet', opts: { windowMs: 60000, maxRequests: 100 } },
            ]);
        });
    });
});
