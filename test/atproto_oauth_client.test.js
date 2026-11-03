'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');

//
//  A stand-in for @atproto/oauth-client-node, recording what the adapter asks
//  of it. Tests replace individual behaviours as needed; nothing touches the
//  network.
//
function makeFakeLibrary(overrides = {}) {
    const calls = [];
    const behaviour = Object.assign(
        {
            resolveIdentity: async input => ({
                did: 'did:plc:alice',
                handle: input,
                didDoc: {
                    id: 'did:plc:alice',
                    service: [
                        {
                            id: '#atproto_pds',
                            type: 'AtprotoPersonalDataServer',
                            serviceEndpoint: 'https://pds.example',
                        },
                    ],
                },
            }),
            authorize: async () =>
                new URL('https://bsky.social/oauth/authorize?request_uri=urn%3Aexample'),
            callback: async params => ({
                session: { did: 'did:plc:alice' },
                state: params.get('state') === 'abc' ? 'handoff-7F3K' : null,
            }),
            restore: async did => ({
                did,
                getTokenInfo: async () => ({
                    iss: 'https://bsky.social',
                    scope: 'atproto',
                    expiresAt: new Date(0),
                    sub: did,
                }),
            }),
            revoke: async () => undefined,
        },
        overrides
    );

    const requestLocalLock = () => {};

    class NodeOAuthClient {
        constructor(options) {
            calls.push(['constructor', options]);
            this.options = options;
            this.oauthResolver = {
                resolveIdentity: input => {
                    calls.push(['resolveIdentity', input]);
                    return behaviour.resolveIdentity(input);
                },
            };
        }
        authorize(input, options) {
            calls.push(['authorize', input, options]);
            return behaviour.authorize(input, options);
        }
        callback(params) {
            calls.push(['callback', params]);
            return behaviour.callback(params);
        }
        restore(did) {
            calls.push(['restore', did]);
            return behaviour.restore(did);
        }
        revoke(did) {
            calls.push(['revoke', did]);
            return behaviour.revoke(did);
        }
    }

    return { calls, lib: { NodeOAuthClient, requestLocalLock } };
}

//  Turn a callback-style call into a Promise so the tests can await it
const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

const enabledConfig = () => ({
    debug: { assertsEnabled: false },
    atProto: { enabled: true, oauth: { clientMode: 'loopback' } },
    contentServers: { web: { http: { port: 8080 } } },
});

describe('atproto OAuth client adapter', () => {
    let testConfig;
    let previousConfigGet;
    let previousDb;
    let OAuthClient;
    let fake;
    let loads;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        //  Fresh load, so the adapter captures the config getter above
        delete require.cache[require.resolve('../core/atproto/oauth_client.js')];
        OAuthClient = require('../core/atproto/oauth_client.js');

        previousDb = dbModule.dbs.atproto;
    });

    after(() => {
        configModule._popTestConfig(previousConfigGet);
        dbModule.dbs.atproto = previousDb;
    });

    beforeEach(() => {
        testConfig = enabledConfig();

        const db = new Database(':memory:');
        dbModule.initAtProtoDatabase(db);
        dbModule.dbs.atproto = db;

        fake = makeFakeLibrary();
        loads = 0;
        OAuthClient._reset();
        OAuthClient._setLibraryLoader(async () => {
            loads += 1;
            return fake.lib;
        });
    });

    afterEach(() => dbModule.dbs.atproto.close());

    const startedClient = () => call(OAuthClient.startup);

    describe('when atProto.enabled is false', () => {
        beforeEach(() => {
            testConfig.atProto.enabled = false;
        });

        it('starts without loading the OAuth library', async () => {
            await call(OAuthClient.startup);
            assert.equal(loads, 0);
            assert.equal(OAuthClient.isEnabled(), false);
            assert.equal(OAuthClient.isReady(), false);
        });

        it('starts without loading it when the atProto block is missing entirely', async () => {
            delete testConfig.atProto;
            await call(OAuthClient.startup);
            assert.equal(loads, 0);
        });

        it('refuses every call rather than loading the library on demand', async () => {
            await call(OAuthClient.startup);
            await assert.rejects(call(OAuthClient.resolveIdentity, 'alice.bsky.social'), {
                message: /not enabled/,
            });
            await assert.rejects(call(OAuthClient.authorize, 'alice.bsky.social'), {
                message: /not enabled/,
            });
            assert.equal(loads, 0);
        });
    });

    describe('startup', () => {
        it('loads the library once and is then ready', async () => {
            await startedClient();
            assert.equal(loads, 1);
            assert.equal(OAuthClient.isReady(), true);
        });

        it('builds a loopback client that redirects to the local web server', async () => {
            await startedClient();
            const [, options] = fake.calls.find(([name]) => name === 'constructor');
            const meta = options.clientMetadata;

            const redirectUri = 'http://127.0.0.1:8080/_enig/atproto/callback';
            assert.deepEqual(meta.redirect_uris, [redirectUri]);
            assert.equal(
                meta.client_id,
                `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=atproto`
            );
            assert.equal(meta.scope, 'atproto');
            assert.equal(meta.token_endpoint_auth_method, 'none');
            assert.equal(meta.dpop_bound_access_tokens, true);
        });

        it('uses the in-process lock from the library', async () => {
            await startedClient();
            const [, options] = fake.calls.find(([name]) => name === 'constructor');
            assert.equal(options.requestLock, fake.lib.requestLocalLock);
        });

        it('gives the library stores backed by the atproto database', async () => {
            await startedClient();
            const [, options] = fake.calls.find(([name]) => name === 'constructor');

            options.sessionStore.set('did:plc:alice', {
                tokenSet: { sub: 'did:plc:alice' },
            });
            options.stateStore.set('state-1', { iss: 'https://bsky.social' });

            const db = dbModule.dbs.atproto;
            assert.equal(
                db.prepare('SELECT COUNT(*) AS cnt FROM oauth_session').get().cnt,
                1
            );
            assert.equal(
                db.prepare('SELECT COUNT(*) AS cnt FROM oauth_state').get().cnt,
                1
            );
        });

        it('rejects an unknown client mode without loading the library', async () => {
            testConfig.atProto.oauth.clientMode = 'bogus';
            await assert.rejects(startedClient(), { message: /clientMode "bogus"/ });
            assert.equal(loads, 0);
            assert.equal(OAuthClient.isReady(), false);
        });

        it('requires the web server port for a loopback client', async () => {
            delete testConfig.contentServers;
            await assert.rejects(startedClient(), {
                message: /contentServers\.web\.http\.port/,
            });
            assert.equal(loads, 0);
        });

        it('reports a library that fails to load, and stays not ready', async () => {
            OAuthClient._setLibraryLoader(async () => {
                throw new Error('Cannot find package');
            });
            await assert.rejects(startedClient(), { message: /Cannot find package/ });
            assert.equal(OAuthClient.isReady(), false);
        });
    });

    describe('resolveIdentity', () => {
        beforeEach(startedClient);

        it('returns the DID, verified handle, and PDS', async () => {
            const identity = await call(OAuthClient.resolveIdentity, 'alice.bsky.social');
            assert.deepEqual(identity, {
                did: 'did:plc:alice',
                handle: 'alice.bsky.social',
                pdsUrl: 'https://pds.example',
            });
        });

        it('reports a handle that fails two-way verification as null', async () => {
            fake = makeFakeLibrary({
                resolveIdentity: async () => ({
                    did: 'did:plc:alice',
                    handle: 'handle.invalid',
                    didDoc: { id: 'did:plc:alice' },
                }),
            });
            OAuthClient._reset();
            await startedClient();

            const identity = await call(OAuthClient.resolveIdentity, 'did:plc:alice');
            assert.equal(identity.handle, null);
            assert.equal(identity.pdsUrl, null);
        });

        it('passes a resolution failure to the callback', async () => {
            fake = makeFakeLibrary({
                resolveIdentity: async () => {
                    throw new Error('Handle "nobody.example" does not resolve to a DID');
                },
            });
            OAuthClient._reset();
            await startedClient();

            await assert.rejects(call(OAuthClient.resolveIdentity, 'nobody.example'), {
                message: /does not resolve/,
            });
        });
    });

    describe('authorize', () => {
        beforeEach(startedClient);

        it('calls back with the approval URL as a string', async () => {
            const url = await call(OAuthClient.authorize, 'alice.bsky.social', {});
            assert.equal(typeof url, 'string');
            assert.match(url, /^https:\/\/bsky\.social\/oauth\/authorize\?/);
        });

        it('requests only the base atproto scope', async () => {
            await call(OAuthClient.authorize, 'alice.bsky.social', {});
            const [, input, options] = fake.calls.find(([name]) => name === 'authorize');
            assert.equal(input, 'alice.bsky.social');
            assert.deepEqual(options, { scope: 'atproto' });
        });

        it('passes the state through when the caller gives one', async () => {
            await call(OAuthClient.authorize, 'alice.bsky.social', {
                state: 'handoff-7F3K',
            });
            const [, , options] = fake.calls.find(([name]) => name === 'authorize');
            assert.deepEqual(options, { scope: 'atproto', state: 'handoff-7F3K' });
        });

        it('may be called without options', async () => {
            const url = await call(OAuthClient.authorize, 'alice.bsky.social');
            assert.match(url, /^https:\/\//);
        });
    });

    describe('handleCallback', () => {
        beforeEach(startedClient);

        it('accepts plain query parameters and returns the DID and state', async () => {
            const result = await call(OAuthClient.handleCallback, {
                code: 'xyz',
                state: 'abc',
                iss: 'https://bsky.social',
            });
            assert.deepEqual(result, { did: 'did:plc:alice', state: 'handoff-7F3K' });

            const [, params] = fake.calls.find(([name]) => name === 'callback');
            assert.ok(params instanceof URLSearchParams);
            assert.equal(params.get('code'), 'xyz');
        });

        it('accepts a raw query string', async () => {
            const result = await call(OAuthClient.handleCallback, 'code=xyz&state=abc');
            assert.equal(result.state, 'handoff-7F3K');
        });

        it('passes a rejected callback to the caller', async () => {
            fake = makeFakeLibrary({
                callback: async () => {
                    throw new Error('Unknown authorization session');
                },
            });
            OAuthClient._reset();
            await startedClient();

            await assert.rejects(call(OAuthClient.handleCallback, { state: 'stale' }), {
                message: /Unknown authorization session/,
            });
        });
    });

    describe('restore and revoke', () => {
        beforeEach(startedClient);

        it('restores a session and reports its issuer and scope', async () => {
            const info = await call(OAuthClient.restore, 'did:plc:alice');
            assert.deepEqual(info, {
                did: 'did:plc:alice',
                issuer: 'https://bsky.social',
                scope: 'atproto',
                expiresAt: new Date(0),
            });
        });

        it('revokes a session at the account host', async () => {
            await call(OAuthClient.revoke, 'did:plc:alice');
            assert.ok(
                fake.calls.some(
                    ([name, did]) => name === 'revoke' && did === 'did:plc:alice'
                )
            );
        });
    });

    describe('callbacks', () => {
        beforeEach(startedClient);

        it('are never called synchronously', done => {
            let returned = false;
            OAuthClient.resolveIdentity('alice.bsky.social', err => {
                assert.equal(returned, true);
                return done(err);
            });
            returned = true;
        });

        it('are not called synchronously when refusing, either', done => {
            OAuthClient._reset();
            let returned = false;
            OAuthClient.resolveIdentity('alice.bsky.social', err => {
                assert.equal(returned, true);
                assert.match(err.message, /not enabled/);
                return done();
            });
            returned = true;
        });
    });
});
