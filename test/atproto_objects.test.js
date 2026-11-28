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

describe("AT publishing: the board's programs and live objects", () => {
    const Modules = [
        '../core/web_util.js',
        '../core/atproto/oauth_client.js',
        '../core/atproto/admission/index.js',
        '../core/atproto/splash.js',
        '../core/atproto/publishing.js',
        '../core/atproto/assets.js',
        '../core/atproto/objects.js',
    ];
    let previousConfigGet;
    let previousDb;
    let AtProtoOAuth;
    let Publishing;
    let Assets;
    let Objects;
    let saved;
    let testConfig;
    let root;
    let repo;
    let uploadTypes;

    //  a WebAssembly module's header is all the board checks; the hub checks
    //  the rest
    const Module = Buffer.concat([
        Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
        Buffer.from('a tiny module'),
    ]);
    const Source = Buffer.from('export function step(): void {}\n', 'utf8');
    const Manifest = {
        fetch: ['api.open-meteo.com', 'Geocoding-API.open-meteo.com'],
        values: 'weather',
        credit: [
            { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
        ],
    };
    const Item = 'nexus.cyberspace.dev.asset.item';
    const ObjectType = 'nexus.cyberspace.dev.object';
    const write = (name, body) => {
        fs.writeFileSync(paths.join(root, name), body);
        return paths.join(root, name);
    };
    const program = (more = {}) =>
        Object.assign(
            {
                program: write('weather.wasm', Module),
                source: write('weather.ts', Source),
                name: 'Weather (Open-Meteo)',
                licence: {
                    id: 'BSD-2-Clause',
                    url: 'https://opensource.org/license/bsd-2-clause',
                },
                manifest: Manifest,
            },
            more
        );
    const grant = scope =>
        dbModule.dbs.atproto
            .prepare(
                'REPLACE INTO oauth_board_session (did, session_json, updated_timestamp) VALUES (?, ?, 1)'
            )
            .run(
                'did:plc:board',
                JSON.stringify({ tokenSet: { scope, access_token: 'secret' } })
            );

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        previousDb = dbModule.dbs.atproto;
        Modules.forEach(m => delete require.cache[require.resolve(m)]);
        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        Publishing = require('../core/atproto/publishing.js');
        Assets = require('../core/atproto/assets.js');
        Objects = require('../core/atproto/objects.js');
        saved = Object.assign({}, AtProtoOAuth);
    });

    after(() => {
        Object.assign(AtProtoOAuth, saved);
        dbModule.dbs.atproto = previousDb;
        Modules.forEach(m => delete require.cache[require.resolve(m)]);
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(async () => {
        root = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-objects-'));
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
                publishing: { enabled: true, listing: {}, assets: [], objects: [] },
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
        uploadTypes = {};
        AtProtoOAuth.boardUploadBlob = (did, body, mediaType, cb) => {
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
                    ] = { value: params.record, cid };
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

    describe('programs', () => {
        it('publishes a program: its module and source, keyed by the module, with its manifest', async () => {
            testConfig.atProto.publishing.assets = [program()];
            const result = await call(Assets.publishAssets);
            assert.deepEqual(result.added, [sha(Module)]);
            const r = repo[Item][sha(Module)].value;
            assert.equal(r.kind, 'program');
            assert.deepEqual(
                r.versions.map(v => [v.form, v.name, v.file.sha256, v.file.mediaType]),
                [
                    ['program', undefined, sha(Module), 'application/wasm'],
                    ['source', 'weather.ts', sha(Source), 'text/plain'],
                ]
            );
            assert.deepEqual(r.manifest, {
                fetch: ['api.open-meteo.com', 'geocoding-api.open-meteo.com'],
                values: 'weather',
                credit: Manifest.credit,
            });
            assert.equal(uploadTypes[sha(Module)], 'application/wasm');
            assert.equal(uploadTypes[sha(Source)], 'text/plain');
            //  an open licence: anyone may copy and remix it
            assert.deepEqual(r.permissions, {
                use: 'anyone',
                copy: 'anyone',
                restyle: 'nobody',
                remix: 'anyone',
            });
        });

        it('publishes a source of several files, each under its name, and again when one changes', async () => {
            const Json = Buffer.from('export function parse(): void {}\n', 'utf8');
            const files = () => [write('weather.ts', Source), write('json.ts', Json)];
            testConfig.atProto.publishing.assets = [program({ source: files() })];
            assert.deepEqual((await call(Assets.publishAssets)).added, [sha(Module)]);
            const versions = () =>
                repo[Item][sha(Module)].value.versions
                    .filter(v => 'source' === v.form)
                    .map(v => [v.name, v.file.sha256]);
            assert.deepEqual(versions(), [
                ['weather.ts', sha(Source)],
                ['json.ts', sha(Json)],
            ]);
            assert.deepEqual(
                (await call(Assets.publishAssets)).kept,
                [sha(Module)],
                'unchanged'
            );
            const newer = Buffer.from(
                'export function parse(): i32 { return 1; }\n',
                'utf8'
            );
            testConfig.atProto.publishing.assets = [
                program({
                    source: [write('weather.ts', Source), write('json.ts', newer)],
                }),
            ];
            assert.deepEqual((await call(Assets.publishAssets)).added, [sha(Module)]);
            assert.deepEqual(versions()[1], ['json.ts', sha(newer)]);
        });

        it('refuses a source of too many files, files of the same name or a name hubs do not take, or too much together', async () => {
            const reason = async source => {
                testConfig.atProto.publishing.assets = [program({ source })];
                const result = await call(Assets.publishAssets);
                return (result.refused[0] || {}).reason;
            };
            fs.mkdirSync(paths.join(root, 'a'), { recursive: true });
            assert.match(
                await reason(
                    Array.from({ length: 8 }, (_, i) => write(`f${i}.ts`, Source))
                ),
                /8 files: at most 7/
            );
            assert.match(
                await reason([
                    write('weather.ts', Source),
                    write('a/weather.ts', Source),
                ]),
                /the same name/
            );
            assert.match(
                await reason([write('.hidden.ts', Source)]),
                /a name hubs don't take/
            );
            const big = Buffer.alloc(200 * 1024, 'a');
            assert.match(
                await reason([write('one.ts', big), write('two.ts', big)]),
                /source is [0-9.]+ KB together, over the limit of 256 KB/
            );
        });

        it('lets nobody copy a program whose licence is not an open one', async () => {
            testConfig.atProto.publishing.assets = [
                program({ licence: { id: 'custom', text: 'Ask first' } }),
            ];
            await call(Assets.publishAssets);
            const r = repo[Item][sha(Module)].value;
            assert.equal(r.permissions.copy, 'nobody');
            assert.equal(r.permissions.remix, 'nobody');
        });

        it('refuses a program without its source, a licence, or a manifest it can hold to, or not a module', async () => {
            const cases = [
                [program({ source: undefined }), /published with its source/],
                [program({ licence: undefined }), /says its licence/],
                [program({ manifest: undefined }), /has a "manifest"/],
                [
                    program({
                        manifest: { ...Manifest, fetch: ['api.open-meteo.com/v1'] },
                    }),
                    /by host name only/,
                ],
                [
                    program({ manifest: { ...Manifest, fetch: ['http://example.com'] } }),
                    /by host name only/,
                ],
                [program({ manifest: { fetch: [] } }), /names the "values"/],
                [
                    program({
                        manifest: {
                            ...Manifest,
                            credit: [{ text: 'X', url: 'http://x.example' }],
                        },
                    }),
                    /https "url"/,
                ],
                [program({ art: 'SKULL' }), /a program and art/],
            ];
            for (const [entry, why] of cases) {
                testConfig.atProto.publishing.assets = [entry];
                const result = await call(Assets.publishAssets);
                assert.deepEqual(result.added, []);
                assert.match(result.refused.map(r => r.reason).join(' | '), why);
            }
            testConfig.atProto.publishing.assets = [
                program({ program: write('not.wasm', Buffer.from('MZ not wasm')) }),
            ];
            const result = await call(Assets.publishAssets);
            assert.match(result.refused[0].reason, /not a WebAssembly module/);
            testConfig.atProto.publishing.assets = [
                program({ source: write('bad.ts', Buffer.from([0xff, 0xfe, 0x00])) }),
            ];
            assert.match(
                (await call(Assets.publishAssets)).refused[0].reason,
                /not UTF-8/
            );
        });

        it('publishes a program again when its source or manifest changes, and not otherwise', async () => {
            testConfig.atProto.publishing.assets = [program()];
            await call(Assets.publishAssets);
            assert.deepEqual((await call(Assets.publishAssets)).kept, [sha(Module)]);
            testConfig.atProto.publishing.assets = [
                program({ manifest: { ...Manifest, fetch: ['api.open-meteo.com'] } }),
            ];
            assert.deepEqual((await call(Assets.publishAssets)).added, [sha(Module)]);
            assert.deepEqual(repo[Item][sha(Module)].value.manifest.fetch, [
                'api.open-meteo.com',
            ]);
            const newer = Buffer.from('export function step(): void { /* better */ }\n');
            testConfig.atProto.publishing.assets = [
                program({ source: write('weather2.ts', newer), manifest: Manifest }),
            ];
            assert.deepEqual((await call(Assets.publishAssets)).added, [sha(Module)]);
            assert.equal(
                repo[Item][sha(Module)].value.versions[1].file.sha256,
                sha(newer)
            );
        });
    });

    describe('live objects', () => {
        const berlin = (more = {}) =>
            Object.assign(
                {
                    name: 'berlin',
                    title: 'Weather in Berlin',
                    program: write('weather.wasm', Module),
                    input: { name: 'Berlin' },
                    interval: 900,
                },
                more
            );

        it("publishes an object naming its program by the module's hash and the board's own record", async () => {
            testConfig.atProto.publishing.objects = [berlin()];
            const result = await call(Objects.publishObjects);
            assert.deepEqual(result.added, ['berlin']);
            const r = repo[ObjectType].berlin.value;
            assert.equal(r.$type, ObjectType);
            assert.equal(r.title, 'Weather in Berlin');
            assert.deepEqual(r.program, {
                sha256: sha(Module),
                uri: `at://did:plc:board/${Item}/${sha(Module)}`,
            });
            assert.deepEqual(r.input, { name: 'Berlin' });
            assert.equal(r.interval, 900);
            assert.deepEqual(r.look, { kind: 'badge' });
        });

        it('keeps the interval within a minute and a day', async () => {
            const intervals = async interval => {
                testConfig.atProto.publishing.objects = [berlin({ interval })];
                await call(Objects.publishObjects);
                return repo[ObjectType].berlin.value.interval;
            };
            assert.equal(await intervals(30), 60);
            assert.equal(await intervals(7 * 24 * 60 * 60), 24 * 60 * 60);
            assert.equal(
                await intervals('often'),
                600,
                'not a number: every ten minutes'
            );
        });

        it("names another account's program by its hash and DID", async () => {
            const hash = 'a'.repeat(64);
            testConfig.atProto.publishing.objects = [
                berlin({ program: { sha256: hash, did: 'did:plc:framework' } }),
            ];
            await call(Objects.publishObjects);
            assert.equal(
                repo[ObjectType].berlin.value.program.uri,
                `at://did:plc:framework/${Item}/${hash}`
            );
        });

        it('writes a changed object again, leaves an unchanged one, and deletes one taken off the list', async () => {
            testConfig.atProto.publishing.objects = [
                berlin(),
                berlin({ name: 'paris', title: 'Paris', input: { name: 'Paris' } }),
            ];
            await call(Objects.publishObjects);
            testConfig.atProto.publishing.objects = [
                berlin({ input: { latitude: 52.52, longitude: 13.41 } }),
            ];
            const result = await call(Objects.publishObjects);
            assert.deepEqual(result.changed, ['berlin']);
            assert.deepEqual(result.removed, ['paris']);
            assert.deepEqual(repo[ObjectType].berlin.value.input, {
                latitude: 52.52,
                longitude: 13.41,
            });
            const again = await call(Objects.publishObjects);
            assert.deepEqual(again.kept, ['berlin']);
            assert.deepEqual(again.changed, []);
        });

        it('refuses entries it cannot publish as written, and publishes the rest', async () => {
            testConfig.atProto.publishing.objects = [
                berlin({ name: 'has spaces' }),
                berlin({ name: 'list', input: ['Berlin'] }),
                berlin({ name: 'big', input: { name: 'x'.repeat(2000) } }),
                berlin({ name: 'gone', program: paths.join(root, 'missing.wasm') }),
                berlin({ name: 'badhash', program: { sha256: 'xyz' } }),
                berlin(),
                berlin(),
            ];
            const result = await call(Objects.publishObjects);
            assert.deepEqual(result.added, ['berlin']);
            const reasons = result.refused.map(r => `${r.entry}: ${r.reason}`).join('\n');
            assert.match(reasons, /its "name" is its key/);
            assert.match(reasons, /list: its "input" is an object/);
            assert.match(reasons, /big: its "input" is more than 1024 bytes/);
            assert.match(reasons, /gone: its program, .* can't be read/);
            assert.match(reasons, /badhash: its "program" is a path/);
            assert.match(reasons, /berlin: another object has the same "name"/);
        });

        it('needs the account to allow live objects, and asks to connect it again if not', async () => {
            const { boardScope } = require('../core/atproto/const.js');
            const all = boardScope().split(' ');
            grant(all.filter(s => s !== `repo:${ObjectType}`).join(' '));
            testConfig.atProto.publishing.objects = [berlin()];
            await assert.rejects(call(Objects.publishObjects), /connect it again/);
            assert.deepEqual(Publishing.missingPermissions(), [`repo:${ObjectType}`]);
            grant(all.join(' '));
            assert.deepEqual((await call(Objects.publishObjects)).added, ['berlin']);
        });

        it('publishes the art, then the objects, once the account is connected again', async () => {
            const { boardScope } = require('../core/atproto/const.js');
            const all = boardScope().split(' ');
            testConfig.atProto.publishing.assets = [program()];
            testConfig.atProto.publishing.objects = [berlin()];
            AtProtoOAuth.isBoardReady = () => true;
            const publishContent = Publishing.publishContent;
            const connected = (scope, identity) =>
                new Promise((resolve, reject) => {
                    grant(scope);
                    Publishing.publishContent = cb =>
                        publishContent(() => {
                            cb();
                            resolve();
                        });
                    Publishing.connectBoardAccount(identity, err => err && reject(err));
                });
            try {
                //  without the objects' permission: the art only
                await connected(all.filter(s => s !== `repo:${ObjectType}`).join(' '), {
                    did: 'did:plc:board',
                    handle: 'board.example',
                });
                assert.ok(repo[Item][sha(Module)]);
                assert.equal(undefined, (repo[ObjectType] || {}).berlin);
                //  connected again, allowing them: the object too
                await connected(all.join(' '), {
                    did: 'did:plc:board',
                    handle: 'board.example',
                });
                assert.equal(repo[ObjectType].berlin.value.title, 'Weather in Berlin');
            } finally {
                Publishing.publishContent = publishContent;
                AtProtoOAuth.isBoardReady = saved.isBoardReady;
            }
        });
    });
});
