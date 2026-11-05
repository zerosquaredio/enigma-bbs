'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');

//
//  A stand-in for the parts of @atproto/oauth-client-node that public mode
//  uses: the client, and JoseKey for making and loading the signing key.
//
function makeFakeLibrary() {
    const calls = [];
    const fakeKey = jwk => ({
        kid: jwk.kid,
        privateJwk: jwk,
        publicJwk: { kid: jwk.kid, kty: 'EC', x: 'pub' },
    });

    class NodeOAuthClient {
        constructor(options) {
            calls.push(['constructor', options]);
            this.options = options;
        }
        get clientMetadata() {
            return this.options.clientMetadata;
        }
        get jwks() {
            return { keys: (this.options.keyset || []).map(k => k.publicJwk) };
        }
    }

    const JoseKey = {
        generate: async (algs, kid) => {
            calls.push(['generate', algs, kid]);
            return fakeKey({ kid, kty: 'EC', d: 'private-part' });
        },
        fromJWK: async jwk => {
            calls.push(['fromJWK', jwk]);
            return fakeKey(jwk);
        },
    };

    return { calls, lib: { NodeOAuthClient, JoseKey, requestLocalLock: () => {} } };
}

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('atproto OAuth client in public mode', () => {
    let testConfig;
    let previousConfigGet;
    let previousDb;
    let OAuthClient;
    let fake;
    let securityDir;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        delete require.cache[require.resolve('../core/atproto/oauth_client.js')];
        OAuthClient = require('../core/atproto/oauth_client.js');

        previousDb = dbModule.dbs.atproto;
    });

    after(() => {
        configModule._popTestConfig(previousConfigGet);
        dbModule.dbs.atproto = previousDb;
    });

    beforeEach(() => {
        securityDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-atproto-'));
        testConfig = {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            paths: { security: securityDir },
            atProto: { enabled: true, oauth: { clientMode: 'public' } },
            contentServers: {
                web: {
                    domain: 'bbs.example',
                    overrideUrlPrefix: 'https://coolbbs.hub.example/',
                    http: { enabled: true, port: 8080 },
                    https: { enabled: false },
                },
            },
        };

        const db = new Database(':memory:');
        dbModule.initAtProtoDatabase(db);
        dbModule.dbs.atproto = db;

        fake = makeFakeLibrary();
        OAuthClient._reset();
        OAuthClient._setLibraryLoader(async () => fake.lib);
    });

    afterEach(() => {
        dbModule.dbs.atproto.close();
        fs.rmSync(securityDir, { recursive: true, force: true });
    });

    const keyPath = () => paths.join(securityDir, 'atproto_oauth_key.json');

    it('builds metadata identifying the BBS by its own https address', () => {
        const meta = OAuthClient.buildClientMetadata();
        assert.equal(
            meta.client_id,
            'https://coolbbs.hub.example/_enig/atproto/client-metadata.json'
        );
        assert.deepEqual(meta.redirect_uris, [
            'https://coolbbs.hub.example/_enig/atproto/callback',
        ]);
        assert.equal(
            meta.jwks_uri,
            'https://coolbbs.hub.example/_enig/atproto/jwks.json'
        );
        assert.equal(meta.client_name, 'Test BBS');
        assert.equal(meta.client_uri, 'https://coolbbs.hub.example');
        assert.equal(meta.application_type, 'web');
        assert.equal(meta.token_endpoint_auth_method, 'private_key_jwt');
        assert.equal(meta.token_endpoint_auth_signing_alg, 'ES256');
        assert.equal(meta.scope, 'atproto');
        assert.equal(meta.dpop_bound_access_tokens, true);
    });

    it('uses the https web server address when there is no override', () => {
        delete testConfig.contentServers.web.overrideUrlPrefix;
        testConfig.contentServers.web.https = { enabled: true, port: 443 };
        assert.equal(
            OAuthClient.buildClientMetadata().client_id,
            'https://bbs.example/_enig/atproto/client-metadata.json'
        );
    });

    it('refuses an address that is not https', async () => {
        testConfig.contentServers.web.overrideUrlPrefix = 'http://coolbbs.example';
        await assert.rejects(call(OAuthClient.startup), { reason: /https:\/\// });
        assert.equal(OAuthClient.isReady(), false);
    });

    it('makes a signing key on first start and saves it for the BBS user only', async () => {
        await call(OAuthClient.startup);

        assert.ok(
            fake.calls.some(([name, algs]) => name === 'generate' && algs[0] === 'ES256')
        );
        const saved = JSON.parse(fs.readFileSync(keyPath(), 'utf8'));
        assert.equal(saved.d, 'private-part');
        assert.equal(fs.statSync(keyPath()).mode & 0o777, 0o600);

        const [, options] = fake.calls.find(([name]) => name === 'constructor');
        assert.equal(options.keyset.length, 1);
        assert.equal(options.keyset[0].kid, saved.kid);
    });

    it('reuses the saved key on later starts', async () => {
        fs.writeFileSync(
            keyPath(),
            JSON.stringify({ kid: 'enig-1', kty: 'EC', d: 'kept' })
        );
        await call(OAuthClient.startup);

        assert.ok(!fake.calls.some(([name]) => name === 'generate'));
        const [, options] = fake.calls.find(([name]) => name === 'constructor');
        assert.equal(options.keyset[0].kid, 'enig-1');
    });

    it('fails to start rather than replace a key file it cannot read', async () => {
        fs.writeFileSync(keyPath(), 'not json');
        await assert.rejects(call(OAuthClient.startup));
        assert.equal(fs.readFileSync(keyPath(), 'utf8'), 'not json');
    });

    it('serves the metadata and only the public keys once started', async () => {
        assert.equal(OAuthClient.getClientMetadata(), null);
        assert.equal(OAuthClient.getJwks(), null);

        await call(OAuthClient.startup);
        assert.match(OAuthClient.getClientMetadata().client_id, /client-metadata\.json$/);
        const jwks = OAuthClient.getJwks();
        assert.equal(jwks.keys.length, 1);
        assert.equal(jwks.keys[0].d, undefined);
    });

    it('needs no key in loopback mode', async () => {
        testConfig.atProto.oauth.clientMode = 'loopback';
        await call(OAuthClient.startup);
        const [, options] = fake.calls.find(([name]) => name === 'constructor');
        assert.equal(options.keyset, undefined);
        assert.equal(fs.existsSync(keyPath()), false);
    });
});
