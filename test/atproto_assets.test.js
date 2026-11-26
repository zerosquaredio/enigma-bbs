'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );
const sha = body => crypto.createHash('sha256').update(body).digest('hex');

describe("AT publishing: the board's art", () => {
    //  loaded afresh here, against the stand-in config
    const Modules = [
        '../core/web_util.js',
        '../core/atproto/oauth_client.js',
        '../core/atproto/admission/index.js',
        '../core/atproto/splash.js',
        '../core/atproto/publishing.js',
        '../core/atproto/assets.js',
    ];
    let previousConfigGet;
    let previousDb;
    let AtProtoOAuth;
    let Publishing;
    let Assets;
    let saved;
    let testConfig;
    let root;
    //  the account's repo: collection -> rkey -> { value, cid }
    let repo;
    let uploads;

    const Skull = Buffer.from('\x1b[1;32mSKULL\x1b[0m\r\n', 'latin1');
    const Logo = Buffer.from('\x1b[1;35mLOGO\x1b[0m\r\n', 'latin1');
    const write = (dir, name, body) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(paths.join(dir, name), body);
    };
    const Item = 'nexus.cyberspace.dev.asset.item';
    const Catalogue = 'nexus.cyberspace.dev.asset.catalogue';
    const items = () => Object.entries(repo[Item] || {});

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        previousDb = dbModule.dbs.atproto;
        Modules.forEach(m => delete require.cache[require.resolve(m)]);
        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        Publishing = require('../core/atproto/publishing.js');
        Assets = require('../core/atproto/assets.js');
        saved = Object.assign({}, AtProtoOAuth);
    });

    after(() => {
        Object.assign(AtProtoOAuth, saved);
        dbModule.dbs.atproto = previousDb;
        //  loaded here against the stand-in config: loaded afresh by later
        //  tests, not as they were here
        Modules.forEach(m => delete require.cache[require.resolve(m)]);
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(async () => {
        root = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-assets-'));
        testConfig = {
            debug: { assertsEnabled: false },
            general: { boardName: 'Cool BBS' },
            paths: {
                themes: paths.join(root, 'themes'),
                art: paths.join(root, 'general'),
            },
            theme: { default: 'mytheme', preLogin: 'mytheme' },
            atProto: {
                enabled: true,
                oauth: { clientMode: 'loopback' },
                admission: { policy: ['open'] },
                publishing: { enabled: true, listing: {}, assets: [] },
            },
            contentServers: {
                web: { domain: 'bbs.example.com', https: { enabled: true, port: 443 } },
            },
            loginServers: {},
        };
        const db = new Database(':memory:');
        dbModule.initAtProtoDatabase(db);
        dbModule.dbs.atproto = db;
        Publishing._setStore(null);
        repo = {};
        uploads = [];
        AtProtoOAuth.boardUploadBlob = (did, body, mediaType, cb) => {
            uploads.push(sha(body));
            setImmediate(() =>
                cb(null, {
                    $type: 'blob',
                    ref: { $link: `cid-${sha(body).slice(0, 8)}` },
                    mimeType: mediaType,
                    size: body.length,
                })
            );
        };
        AtProtoOAuth.boardRequest = (did, method, nsid, params, cb) => {
            const at = (collection, rkey) => `at://${did}/${collection}/${rkey}`;
            setImmediate(() => {
                if ('com.atproto.repo.listRecords' === nsid) {
                    const records = Object.entries(repo[params.collection] || {}).map(
                        ([rkey, r]) => ({
                            uri: at(params.collection, rkey),
                            cid: r.cid,
                            value: r.value,
                        })
                    );
                    return cb(null, { records });
                }
                if ('com.atproto.repo.putRecord' === nsid) {
                    const cid = `cid-${sha(Buffer.from(JSON.stringify(params.record))).slice(0, 8)}`;
                    (repo[params.collection] = repo[params.collection] || {})[
                        params.rkey
                    ] = {
                        value: params.record,
                        cid,
                    };
                    return cb(null, { uri: at(params.collection, params.rkey), cid });
                }
                if ('com.atproto.repo.deleteRecord' === nsid) {
                    delete (repo[params.collection] || {})[params.rkey];
                    return cb(null, {});
                }
                return cb(null, {});
            });
        };
        await call(Publishing.connectBoardAccount, {
            did: 'did:plc:board',
            handle: 'board.example',
        });
    });

    afterEach(() => {
        dbModule.dbs.atproto.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('takes the pieces as listed, by name alone or in full, with a licence always', () => {
        testConfig.atProto.publishing.assets = [
            'SKULL',
            {
                art: 'LOGO',
                name: 'Our logo',
                licence: { id: 'CC-BY-4.0' },
                rating: 'mature',
                credit: { author: 'Ana' },
            },
            { name: 'no art' },
            { art: 'X', rating: 'spicy' },
        ];
        const listed = Assets.pieces();
        assert.equal(listed.length, 3, 'one names no art');
        assert.equal(listed[0].art, 'SKULL');
        assert.equal(
            listed[0].licence.id,
            'custom',
            "the board's consent, without a licence"
        );
        assert.deepEqual(listed[1].licence, { id: 'CC-BY-4.0' });
        assert.equal(listed[1].rating, 'mature');
        assert.deepEqual(listed[1].credit, { author: 'Ana' });
        assert.equal(
            listed[2].rating,
            'general',
            'a rating it does not know is the gentlest'
        );
    });

    it('uploads each piece, publishes it keyed by its hash, and lists them in a catalogue', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        write(root, 'logo.ans', Logo);
        testConfig.atProto.publishing.assets = [
            'SKULL',
            {
                art: paths.join(root, 'logo.ans'),
                name: 'Our logo',
                licence: { id: 'CC-BY-4.0' },
            },
            'NOWHERE',
        ];
        const result = await call(Assets.publishAssets);
        assert.deepEqual(result.added.sort(), [sha(Skull), sha(Logo)].sort());
        assert.deepEqual(result.missing, ['NOWHERE']);
        assert.deepEqual(
            items()
                .map(([rkey]) => rkey)
                .sort(),
            [sha(Skull), sha(Logo)].sort()
        );

        const skull = repo[Item][sha(Skull)].value;
        assert.equal(skull.$type, Item);
        assert.equal(skull.name, 'SKULL');
        assert.equal(skull.description.short, 'SKULL: ANSI art from Cool BBS');
        assert.deepEqual(skull.versions[0].file, {
            sha256: sha(Skull),
            size: Skull.length,
            mediaType: 'text/x-ansi',
        });
        assert.equal(skull.versions[0].blob.mimeType, 'text/x-ansi');
        assert.equal(repo[Item][sha(Logo)].value.name, 'Our logo');

        const catalogue = repo[Catalogue].self.value;
        assert.equal(catalogue.name, "Cool BBS's art");
        assert.deepEqual(
            catalogue.items.map(i => i.uri.split('/').pop()).sort(),
            [sha(Skull), sha(Logo)].sort()
        );
        assert.ok(catalogue.items.every(i => i.cid));
    });

    it('uploads nothing unchanged again, and deletes what was taken off the list', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        write(paths.join(root, 'general'), 'LOGO.ANS', Logo);
        testConfig.atProto.publishing.assets = ['SKULL', 'LOGO'];
        await call(Assets.publishAssets);
        uploads.length = 0;

        testConfig.atProto.publishing.assets = ['SKULL'];
        const again = await call(Assets.publishAssets);
        assert.deepEqual(uploads, [], 'nothing uploaded again');
        assert.deepEqual(again.kept, [sha(Skull)]);
        assert.deepEqual(again.removed, [sha(Logo)]);
        assert.deepEqual(
            items().map(([rkey]) => rkey),
            [sha(Skull)]
        );
        assert.equal(repo[Catalogue].self.value.items.length, 1);
    });

    it('leaves alone records it did not make, and publishes the same art once', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        (repo[Item] = {})['hand-made'] = { value: { name: 'by hand' }, cid: 'c1' };
        testConfig.atProto.publishing.assets = ['SKULL', 'SKULL'];
        const result = await call(Assets.publishAssets);
        assert.deepEqual(result.added, [sha(Skull)]);
        assert.ok(
            repo[Item]['hand-made'],
            'a record not keyed by a hash is not ours to delete'
        );
    });

    it('needs a connected account', async () => {
        await call(Publishing.disconnectBoardAccount).catch(() => {});
        AtProtoOAuth.revokeBoard = (did, cb) => setImmediate(() => cb(null));
        await assert.rejects(call(Assets.publishAssets), /No board account/);
    });
});
