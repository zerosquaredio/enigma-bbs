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
    //  the media type each upload was declared as, by its hash
    let uploadTypes;

    const Skull = Buffer.from('\x1b[1;32mSKULL\x1b[0m\r\n', 'latin1');
    const Logo = Buffer.from('\x1b[1;35mLOGO\x1b[0m\r\n', 'latin1');
    const write = (dir, name, body) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(paths.join(dir, name), body);
    };
    //  a binary glTF file: its 12-byte header, then its JSON chunk, padded
    //  to four bytes with spaces
    const glb = (json = { asset: { version: '2.0' } }, version = 2) => {
        let chunk = Buffer.from(JSON.stringify(json), 'utf8');
        chunk = Buffer.concat([chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4, 0x20)]);
        const head = Buffer.alloc(20);
        head.write('glTF', 0, 'latin1');
        head.writeUInt32LE(version, 4);
        head.writeUInt32LE(20 + chunk.length, 8);
        head.writeUInt32LE(chunk.length, 12);
        head.write('JSON', 16, 'latin1');
        return Buffer.concat([head, chunk]);
    };
    const Clock = glb();
    //  a PNG of one pixel
    const Preview = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
    );
    //  the listed entry for a model and its picture, written under |root|
    const model = (body, picture, more = {}) => {
        write(root, 'clock.glb', body);
        write(root, 'clock.png', picture);
        return Object.assign(
            {
                model: paths.join(root, 'clock.glb'),
                image: paths.join(root, 'clock.png'),
            },
            more
        );
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
        uploadTypes = {};
        AtProtoOAuth.boardUploadBlob = (did, body, mediaType, cb) => {
            uploads.push(sha(body));
            uploadTypes[sha(body)] = mediaType;
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

    it('takes a model and its picture in place of art, and never both', async () => {
        testConfig.atProto.publishing.assets = [
            {
                model: ' models/clock.glb ',
                image: 'models/clock.png',
                name: 'Brass Clock',
                licence: { id: 'CC-BY-4.0' },
                rating: 'mature',
                credit: { author: 'Ana' },
                description: 'A brass mantel clock',
            },
            { model: 'models/both.glb', image: 'models/both.png', art: 'SKULL' },
            { model: 'models/bare.glb', name: 'Bare' },
            { image: 'models/alone.png' },
        ];
        const listed = Assets.pieces();
        assert.equal(listed.length, 1, 'only the first can be published');
        assert.equal(listed[0].model, 'models/clock.glb');
        assert.equal(listed[0].image, 'models/clock.png');
        assert.equal(listed[0].art, undefined);
        assert.equal(listed[0].name, 'Brass Clock');
        assert.deepEqual(listed[0].licence, { id: 'CC-BY-4.0' });
        assert.equal(listed[0].rating, 'mature');
        assert.deepEqual(listed[0].credit, { author: 'Ana' });
        assert.equal(listed[0].description, 'A brass mantel clock');

        //  and publishing says why the others were left out
        const result = await call(Assets.publishAssets);
        assert.deepEqual(
            result.refused.map(r => r.entry),
            ['models/both.glb', 'Bare', 'entry 4']
        );
        assert.match(result.refused[0].reason, /both art and a model/);
        assert.match(result.refused[1].reason, /preview picture.*"image"/);
        assert.match(result.refused[2].reason, /no art and no model/);
        assert.deepEqual(result.missing, ['models/clock.glb']);
        assert.deepEqual(uploads, []);
    });

    it('uploads a model and its picture, and publishes one record keyed by the model', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        testConfig.atProto.publishing.assets = [
            'SKULL',
            model(Clock, Preview, {
                name: 'Brass Clock',
                description: 'A brass mantel clock, its pendulum swinging',
                licence: {
                    id: 'CC-BY-4.0',
                    url: 'https://creativecommons.org/licenses/by/4.0/',
                },
                credit: { author: 'Ana' },
            }),
        ];
        const result = await call(Assets.publishAssets);
        assert.deepEqual(result.added.sort(), [sha(Skull), sha(Clock)].sort());
        assert.deepEqual(result.missing, []);
        assert.deepEqual(result.refused, []);
        assert.deepEqual(uploads, [sha(Skull), sha(Clock), sha(Preview)]);
        assert.equal(uploadTypes[sha(Clock)], 'model/gltf-binary');
        assert.equal(uploadTypes[sha(Preview)], 'image/png');
        assert.deepEqual(
            items()
                .map(([rkey]) => rkey)
                .sort(),
            [sha(Skull), sha(Clock)].sort(),
            'the picture has no record of its own'
        );

        const clock = repo[Item][sha(Clock)].value;
        assert.equal(clock.$type, Item);
        assert.equal(clock.name, 'Brass Clock');
        assert.equal(clock.kind, 'art');
        assert.equal(clock.rating, 'general');
        assert.deepEqual(clock.licence, {
            id: 'CC-BY-4.0',
            url: 'https://creativecommons.org/licenses/by/4.0/',
        });
        assert.deepEqual(clock.credit, { author: 'Ana' });
        assert.deepEqual(clock.description, {
            short: 'A brass mantel clock, its pendulum swinging',
        });
        assert.deepEqual(clock.versions, [
            {
                form: 'model',
                class: 'light',
                file: {
                    sha256: sha(Clock),
                    size: Clock.length,
                    mediaType: 'model/gltf-binary',
                },
                blob: {
                    $type: 'blob',
                    ref: { $link: `cid-${sha(Clock).slice(0, 8)}` },
                    mimeType: 'model/gltf-binary',
                    size: Clock.length,
                },
            },
            {
                form: 'image',
                file: {
                    sha256: sha(Preview),
                    size: Preview.length,
                    mediaType: 'image/png',
                },
                blob: {
                    $type: 'blob',
                    ref: { $link: `cid-${sha(Preview).slice(0, 8)}` },
                    mimeType: 'image/png',
                    size: Preview.length,
                },
            },
        ]);

        //  art beside it is as it was
        assert.equal(repo[Item][sha(Skull)].value.versions[0].form, 'ansi');
        assert.equal(repo[Catalogue].self.value.items.length, 2);
    });

    it('names a model after its file, and says what it is, unless told', async () => {
        testConfig.atProto.publishing.assets = [model(Clock, Preview)];
        await call(Assets.publishAssets);
        const clock = repo[Item][sha(Clock)].value;
        assert.equal(clock.name, 'clock');
        assert.equal(clock.description.short, 'clock: a 3D model from Cool BBS');
        assert.equal(clock.licence.id, 'custom');
    });

    it('refuses a model that is not a binary glTF file, or a picture that is not a PNG', async () => {
        const refusal = async (body, picture) => {
            testConfig.atProto.publishing.assets = [
                model(body, picture, { name: 'Brass Clock' }),
            ];
            const result = await call(Assets.publishAssets);
            assert.deepEqual(result.added, []);
            assert.deepEqual(uploads, [], 'nothing is uploaded');
            assert.equal(result.refused.length, 1);
            assert.equal(result.refused[0].entry, 'Brass Clock');
            return result.refused[0].reason;
        };
        assert.match(
            await refusal(Buffer.from('{"asset":{"version":"2.0"}}'), Preview),
            /not a binary glTF/
        );
        assert.match(await refusal(Clock.subarray(0, 8), Preview), /not a binary glTF/);
        assert.match(await refusal(glb(undefined, 1), Preview), /version 1/);
        assert.match(
            await refusal(Buffer.concat([Clock, Buffer.from('more')]), Preview),
            new RegExp(`says it is ${Clock.length} bytes.*file is ${Clock.length + 4}`)
        );
        assert.match(
            await refusal(Clock.subarray(0, Clock.length - 4), Preview),
            /bytes/
        );
        assert.match(await refusal(Clock, Skull), /not a PNG/);
        assert.match(await refusal(Clock, Buffer.alloc(0)), /not a PNG/);
        assert.equal(items().length, 0);
    });

    it('refuses a model over the limit, naming the limit', async () => {
        testConfig.atProto.publishing.models = { maxBytes: Clock.length - 1 };
        testConfig.atProto.publishing.assets = [model(Clock, Preview)];
        let result = await call(Assets.publishAssets);
        assert.deepEqual(uploads, []);
        assert.equal(result.refused.length, 1);
        assert.equal(
            result.refused[0].reason,
            `the model is ${Clock.length} bytes, over the limit of ${Clock.length - 1} bytes (atProto.publishing.models.maxBytes)`
        );

        //  8 MB unless set
        delete testConfig.atProto.publishing.models;
        assert.equal(Assets.DefaultModelMaxBytes, 8 * 1024 * 1024);
        const big = Buffer.alloc(8 * 1024 * 1024 + 1);
        Clock.copy(big);
        testConfig.atProto.publishing.assets = [model(big, Preview)];
        result = await call(Assets.publishAssets);
        assert.deepEqual(uploads, []);
        assert.match(result.refused[0].reason, /over the limit of 8 MB/);
    });

    it('leaves out a model whose file or picture is not there', async () => {
        const entry = model(Clock, Preview);
        fs.rmSync(entry.image);
        testConfig.atProto.publishing.assets = [entry];
        let result = await call(Assets.publishAssets);
        assert.deepEqual(result.missing, [entry.image]);
        fs.rmSync(entry.model);
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.missing, [entry.model]);
        assert.deepEqual(uploads, []);
    });

    it("passes on what the account's host says when it refuses a file", async () => {
        const upload = AtProtoOAuth.boardUploadBlob;
        AtProtoOAuth.boardUploadBlob = (did, body, mediaType, cb) => {
            if ('model/gltf-binary' !== mediaType) {
                return upload(did, body, mediaType, cb);
            }
            const err = new Error(
                'com.atproto.repo.uploadBlob failed (413): This file is too large. It is 9MB but the maximum size is 5MB.'
            );
            err.status = 413;
            return setImmediate(() => cb(err));
        };
        testConfig.atProto.publishing.assets = [model(Clock, Preview)];
        await assert.rejects(call(Assets.publishAssets), err => {
            assert.match(
                err.reason || err.message,
                /clock\.glb: .*\(413\): This file is too large\. It is 9MB but the maximum size is 5MB\./
            );
            assert.equal(err.status, 413);
            return true;
        });
        assert.equal(items().length, 0, 'no record without its file');
    });

    it('uploads no model again unchanged, only a changed picture, and deletes one taken off the list', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        testConfig.atProto.publishing.assets = ['SKULL', model(Clock, Preview)];
        await call(Assets.publishAssets);
        uploads.length = 0;

        const again = await call(Assets.publishAssets);
        assert.deepEqual(uploads, [], 'nothing uploaded again');
        assert.deepEqual(again.kept.sort(), [sha(Skull), sha(Clock)].sort());
        assert.deepEqual(again.added, []);

        //  another picture for the same model: the record is written
        //  again, naming the model file the host has
        const Other = Buffer.concat([Preview, Buffer.from('more')]);
        testConfig.atProto.publishing.assets = ['SKULL', model(Clock, Other)];
        const changed = await call(Assets.publishAssets);
        assert.deepEqual(uploads, [sha(Other)], 'the picture alone');
        assert.deepEqual(changed.added, [sha(Clock)]);
        assert.deepEqual(changed.kept, [sha(Skull)]);
        const versions = repo[Item][sha(Clock)].value.versions;
        assert.equal(versions[0].blob.ref.$link, `cid-${sha(Clock).slice(0, 8)}`);
        assert.equal(versions[1].file.sha256, sha(Other));
        assert.equal(repo[Catalogue].self.value.items.length, 2);
        assert.equal(
            repo[Catalogue].self.value.items.find(i => i.uri.endsWith(sha(Clock))).cid,
            repo[Item][sha(Clock)].cid,
            'the catalogue names the record as it is now'
        );

        //  taken off the list
        testConfig.atProto.publishing.assets = ['SKULL'];
        const without = await call(Assets.publishAssets);
        assert.deepEqual(without.removed, [sha(Clock)]);
        assert.deepEqual(
            items().map(([rkey]) => rkey),
            [sha(Skull)]
        );
        assert.equal(repo[Catalogue].self.value.items.length, 1);
    });

    it('takes down the last piece when the list is emptied, and leaves an account without art alone', async () => {
        let writes = 0;
        const request = AtProtoOAuth.boardRequest;
        AtProtoOAuth.boardRequest = (did, method, nsid, params, cb) => {
            writes += 'POST' === method ? 1 : 0;
            return request(did, method, nsid, params, cb);
        };

        //  never any art: nothing is written
        let result = await call(Assets.publishAssets);
        assert.deepEqual(result.removed, []);
        assert.equal(writes, 0);
        assert.equal(repo[Catalogue], undefined, 'no catalogue made for nothing');

        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        testConfig.atProto.publishing.assets = ['SKULL', model(Clock, Preview)];
        await call(Assets.publishAssets);
        assert.equal(items().length, 2);

        testConfig.atProto.publishing.assets = [];
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.removed.sort(), [sha(Skull), sha(Clock)].sort());
        assert.equal(items().length, 0);
        assert.deepEqual(repo[Catalogue].self.value.items, []);

        //  and again: nothing left to do
        writes = 0;
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.removed, []);
        assert.equal(writes, 0);

        //  a catalogue left naming pieces that are gone is emptied
        repo[Catalogue].self.value.items = [{ uri: 'at://x/y/z', cid: 'c' }];
        await call(Assets.publishAssets);
        assert.deepEqual(repo[Catalogue].self.value.items, []);
    });

    it('says why when the only entry cannot be published as written', async () => {
        const reasons = async entry => {
            testConfig.atProto.publishing.assets = [entry];
            assert.equal(Assets.pieces().length, 0);
            const result = await call(Assets.publishAssets);
            assert.deepEqual(uploads, []);
            return result.refused.map(r => `${r.entry}: ${r.reason}`).join('\n');
        };
        assert.match(await reasons({ model: 'a.glb' }), /^a\.glb: .*preview picture/);
        assert.match(
            await reasons({ model: 'a.glb', image: 'a.png', art: 'SKULL' }),
            /^a\.glb: .*both art and a model/
        );
        assert.match(await reasons({ model: 5, image: 'x' }), /^entry 1: .*no art/);
        assert.match(await reasons({ name: 'Nothing' }), /^Nothing: .*no art/);
        assert.match(await reasons(7), /^entry 1: .*no art/);
    });

    it('keeps a published model while its entry, still listed, cannot be read or is refused', async () => {
        write(paths.join(root, 'general'), 'SKULL.ANS', Skull);
        write(paths.join(root, 'general'), 'LOGO.ANS', Logo);
        const entry = model(Clock, Preview, { name: 'Brass Clock' });
        testConfig.atProto.publishing.assets = ['SKULL', 'LOGO', entry];
        await call(Assets.publishAssets);
        uploads.length = 0;
        const published = JSON.stringify(repo[Item][sha(Clock)]);
        const kept = (result, others) => {
            assert.deepEqual(result.held, [sha(Clock)]);
            assert.equal(JSON.stringify(repo[Item][sha(Clock)]), published);
            assert.deepEqual(
                repo[Catalogue].self.value.items.map(i => i.uri.split('/').pop()).sort(),
                [...others, sha(Clock)].sort(),
                'and it stays in the catalogue'
            );
            assert.deepEqual(uploads, []);
        };

        //  half copied: the header gives a length the file doesn't have
        write(root, 'clock.glb', Clock.subarray(0, Clock.length - 4));
        let result = await call(Assets.publishAssets);
        assert.equal(result.refused.length, 1);
        assert.deepEqual(result.removed, []);
        kept(result, [sha(Skull), sha(Logo)]);

        //  art taken off the list goes all the same
        testConfig.atProto.publishing.assets = ['SKULL', entry];
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.removed, [sha(Logo)]);
        kept(result, [sha(Skull)]);

        //  the picture gone
        write(root, 'clock.glb', Clock);
        fs.rmSync(entry.image);
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.missing, [entry.image]);
        assert.deepEqual(result.removed, []);
        kept(result, [sha(Skull)]);

        //  the model gone
        write(root, 'clock.png', Preview);
        fs.rmSync(entry.model);
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.missing, [entry.model]);
        kept(result, [sha(Skull)]);

        //  the entry no longer one that can be published as written
        write(root, 'clock.glb', Clock);
        testConfig.atProto.publishing.assets = [
            'SKULL',
            Object.assign({}, entry, { art: 'LOGO' }),
        ];
        result = await call(Assets.publishAssets);
        assert.equal(result.refused.length, 1);
        kept(result, [sha(Skull)]);

        //  mended: as it was, nothing held
        testConfig.atProto.publishing.assets = ['SKULL', entry];
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.held, []);
        assert.deepEqual(result.kept.sort(), [sha(Skull), sha(Clock)].sort());

        //  replaced by another model that can't be read yet: the old one
        //  stays until the new one is published, and then goes
        const Other = glb({ asset: { version: '2.0' }, scenes: [] });
        write(root, 'clock.glb', Other.subarray(0, Other.length - 4));
        result = await call(Assets.publishAssets);
        kept(result, [sha(Skull)]);
        write(root, 'clock.glb', Other);
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.held, []);
        assert.deepEqual(result.removed, [sha(Clock)]);
        assert.deepEqual(result.added, [sha(Other)]);

        //  broken, then taken off the list: nothing holds it any longer
        write(root, 'clock.glb', Other.subarray(0, Other.length - 4));
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.held, [sha(Other)]);
        testConfig.atProto.publishing.assets = ['SKULL'];
        result = await call(Assets.publishAssets);
        assert.deepEqual(result.held, []);
        assert.deepEqual(result.removed, [sha(Other)]);
        assert.deepEqual(
            items().map(([rkey]) => rkey),
            [sha(Skull)]
        );
    });

    it('writes no record when the host refuses the picture, and names it', async () => {
        const upload = AtProtoOAuth.boardUploadBlob;
        AtProtoOAuth.boardUploadBlob = (did, body, mediaType, cb) => {
            if ('image/png' !== mediaType) {
                return upload(did, body, mediaType, cb);
            }
            const err = new Error('com.atproto.repo.uploadBlob failed (500): boom');
            err.status = 500;
            return setImmediate(() => cb(err));
        };
        testConfig.atProto.publishing.assets = [model(Clock, Preview)];
        await assert.rejects(call(Assets.publishAssets), err => {
            assert.match(err.reason || err.message, /clock\.png: .*\(500\): boom/);
            assert.equal(err.status, 500);
            return true;
        });
        assert.deepEqual(uploads, [sha(Clock)], 'the model had gone up');
        assert.equal(items().length, 0, 'no record without its picture');
        assert.equal(repo[Catalogue], undefined);
    });

    it('refuses a preview picture over the limit, naming the limit', async () => {
        const big = Buffer.concat([Preview, Buffer.alloc(2048)]);
        testConfig.atProto.publishing.models = { maxBytes: 2047 };
        testConfig.atProto.publishing.assets = [model(Clock, big)];
        const result = await call(Assets.publishAssets);
        assert.deepEqual(uploads, []);
        assert.equal(result.refused.length, 1);
        assert.match(
            result.refused[0].reason,
            new RegExp(
                `the preview picture is [0-9.]+ KB \\(${big.length} bytes\\), over the limit of [0-9.]+ KB \\(atProto\\.publishing\\.models\\.maxBytes\\)`
            )
        );

        //  small sizes are given as they are, never as "0 MB"
        testConfig.atProto.publishing.models = { maxBytes: Preview.length - 1 };
        testConfig.atProto.publishing.assets = [model(Clock, Preview)];
        assert.equal(
            (await call(Assets.publishAssets)).refused[0].reason,
            `the preview picture is ${Preview.length} bytes, over the limit of ${Preview.length - 1} bytes (atProto.publishing.models.maxBytes)`
        );
    });

    it("takes a model's paths relative to the board's directory", async () => {
        const entry = model(Clock, Preview);
        const board = paths.join(__dirname, '..');
        const relative = paths.relative(board, entry.model);
        assert.ok(!paths.isAbsolute(relative));
        testConfig.atProto.publishing.assets = [
            { model: relative, image: paths.relative(board, entry.image) },
        ];
        const result = await call(Assets.publishAssets);
        assert.deepEqual(result.missing, []);
        assert.deepEqual(result.added, [sha(Clock)]);
        assert.deepEqual(uploads, [sha(Clock), sha(Preview)]);
    });

    it('needs a connected account', async () => {
        await call(Publishing.disconnectBoardAccount).catch(() => {});
        AtProtoOAuth.revokeBoard = (did, cb) => setImmediate(() => cb(null));
        await assert.rejects(call(Assets.publishAssets), /No board account/);
    });
});
