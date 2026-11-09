'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');

let testConfig;
const baseConfig = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'Test BBS' },
    atProto: {
        enabled: true,
        oauth: { clientMode: 'loopback' },
        admission: { policy: ['invite', 'open'] },
        publishing: {
            enabled: true,
            minPostIntervalSeconds: 60,
            postLangs: ['en'],
            listing: {},
        },
    },
    contentServers: {
        web: {
            domain: 'bbs.example.com',
            http: { enabled: false, port: 8080 },
            https: { enabled: true, port: 443 },
            wsTerm: { root: 'ws-term' },
        },
    },
    loginServers: {
        ssh: { enabled: true, port: 8889 },
        telnet: { enabled: false, port: 8888 },
    },
});

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('AT publishing (the board account)', () => {
    let previousConfigGet;
    let previousDb;
    let AtProtoOAuth;
    let Publishing;
    let saved;
    let requests;
    let revoked;
    let clock;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        previousDb = dbModule.dbs.atproto;

        [
            '../core/web_util.js',
            '../core/atproto/oauth_client.js',
            '../core/atproto/admission/index.js',
            '../core/atproto/publishing.js',
        ].forEach(m => delete require.cache[require.resolve(m)]);
        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        Publishing = require('../core/atproto/publishing.js');
        saved = Object.assign({}, AtProtoOAuth);
    });

    after(() => {
        Object.assign(AtProtoOAuth, saved);
        dbModule.dbs.atproto = previousDb;
        Publishing._setNow(() => Date.now());
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(() => {
        testConfig = baseConfig();
        const db = new Database(':memory:');
        dbModule.initAtProtoDatabase(db);
        dbModule.dbs.atproto = db;
        Publishing._setStore(null);

        clock = Date.UTC(2026, 10, 7, 12, 0, 0);
        Publishing._setNow(() => clock);

        requests = [];
        revoked = [];
        AtProtoOAuth.boardRequest = (did, method, nsid, params, cb) => {
            requests.push({ did, method, nsid, params });
            setImmediate(() => cb(null, { uri: `at://${did}/x/1`, cid: 'c' }));
        };
        AtProtoOAuth.revokeBoard = (did, cb) => {
            revoked.push(did);
            setImmediate(() => cb(null));
        };
    });

    afterEach(() => dbModule.dbs.atproto.close());

    const Board = { did: 'did:plc:board', handle: 'board.example.com' };
    const connect = () => call(Publishing.connectBoardAccount, Board);

    describe('the listing', () => {
        it('describes the board from its config', async () => {
            await connect();
            testConfig.atProto.publishing.listing = {
                description: 'A test board',
                tags: ['retro', 'ansi'],
                rules: 'Be nice',
                howToJoin: 'Ask for an invite',
                hours: {
                    timezone: 'America/Los_Angeles',
                    weekly: [{ days: ['fri'], from: '19:00', to: '23:00', extra: 1 }],
                    note: 'Friday nights',
                },
                endpoints: [{ protocol: 'telnet', uri: 'telnet://bbs.example.com:23' }],
                sysopDid: 'did:plc:sysop',
            };
            const listing = Publishing.buildListing();
            assert.deepEqual(listing, {
                $type: 'nexus.cyberspace.dev.leaf.listing',
                name: 'Test BBS',
                description: 'A test board',
                tags: ['retro', 'ansi'],
                rules: 'Be nice',
                endpoints: [
                    { protocol: 'web', uri: 'https://bbs.example.com/_enig/ws-term/' },
                    { protocol: 'ssh', uri: 'ssh://bbs.example.com:8889' },
                    { protocol: 'telnet', uri: 'telnet://bbs.example.com:23' },
                ],
                admission: { policy: ['invite', 'open'], howToJoin: 'Ask for an invite' },
                hours: {
                    timezone: 'America/Los_Angeles',
                    weekly: [{ days: ['fri'], from: '19:00', to: '23:00' }],
                    note: 'Friday nights',
                },
                sysop: 'did:plc:sysop',
                createdAt: '2026-11-07T12:00:00.000Z',
            });
        });

        it('points at web sign-in when it is on', () => {
            testConfig.atProto.webSignIn = { enabled: true };
            const web = Publishing.buildListing().endpoints.find(
                e => 'web' === e.protocol
            );
            assert.equal(web.uri, 'https://bbs.example.com/_enig/signin');
        });

        it('never lists a private or loopback address', () => {
            ['192.168.50.233', '10.0.0.5', '127.0.0.1', 'localhost'].forEach(domain => {
                testConfig.contentServers.web.domain = domain;
                assert.deepEqual(Publishing.buildListing().endpoints, [], domain);
            });
        });

        it('lists only the given endpoints when deriving is off', () => {
            testConfig.atProto.publishing.listing = {
                deriveEndpoints: false,
                endpoints: [{ protocol: 'ssh', uri: 'ssh://elsewhere:22' }, 'junk'],
            };
            assert.deepEqual(Publishing.buildListing().endpoints, [
                { protocol: 'ssh', uri: 'ssh://elsewhere:22' },
            ]);
        });

        it('uses the configured record name prefix', () => {
            testConfig.atProto.publishing.nsidPrefix = 'nexus.cyberspace';
            assert.equal(
                Publishing.buildListing().$type,
                'nexus.cyberspace.leaf.listing'
            );
        });

        it('is published on connecting, then only when it changes', async () => {
            await connect();
            assert.equal(requests.length, 1);
            assert.equal(requests[0].nsid, 'com.atproto.repo.putRecord');
            assert.equal(requests[0].params.rkey, 'self');
            assert.equal(
                requests[0].params.collection,
                'nexus.cyberspace.dev.leaf.listing'
            );

            clock += 60 * 1000; //  createdAt stays put
            const again = await call(Publishing.publishListing, {});
            assert.equal(again.written, false);
            assert.equal(requests.length, 1);

            testConfig.atProto.publishing.listing.description = 'New description';
            assert.equal((await call(Publishing.publishListing, {})).written, true);
            assert.equal(
                (await call(Publishing.publishListing, { force: true })).written,
                true
            );
            assert.equal(requests.length, 3);
        });

        it('needs a connected account', async () => {
            await assert.rejects(call(Publishing.publishListing, {}), {
                message: /No board account/,
            });
        });
    });

    describe('status', () => {
        it('publishes the declared state, message and end', async () => {
            await connect();
            const record = await call(Publishing.setStatus, {
                state: 'maintenance',
                message: 'New hardware',
                until: '2026-12-01T20:00:00Z',
            });
            assert.deepEqual(record, {
                $type: 'nexus.cyberspace.dev.leaf.status',
                state: 'maintenance',
                message: 'New hardware',
                until: '2026-12-01T20:00:00.000Z',
                updatedAt: '2026-11-07T12:00:00.000Z',
            });
            assert.equal(requests.pop().params.rkey, 'self');
        });

        it('refuses a state or date that makes no sense', async () => {
            await connect();
            await assert.rejects(call(Publishing.setStatus, { state: 'Up Now!' }));
            await assert.rejects(
                call(Publishing.setStatus, { state: 'down', until: 'tomorrowish' }),
                { message: /not a date/ }
            );
        });
    });

    describe('announcements', () => {
        it('posts text, with its links made clickable by byte offsets', async () => {
            await connect();
            const text =
                'Doors night 🎮 at https://bbs.example.com/_enig/signin. See you!';
            const result = await call(Publishing.post, text);
            assert.equal(result.uri, 'at://did:plc:board/x/1');

            const { params } = requests.pop();
            assert.equal(params.collection, 'app.bsky.feed.post');
            assert.equal(params.record.text, text);
            assert.deepEqual(params.record.langs, ['en']);
            const [facet] = params.record.facets;
            const bytes = Buffer.from(text, 'utf8');
            assert.equal(
                bytes.subarray(facet.index.byteStart, facet.index.byteEnd).toString(),
                'https://bbs.example.com/_enig/signin'
            );
            assert.equal(facet.features[0].uri, 'https://bbs.example.com/_enig/signin');
        });

        it('refuses an empty or over-long post', async () => {
            await connect();
            await assert.rejects(call(Publishing.post, '   '), {
                message: /Nothing to post/,
            });
            await assert.rejects(call(Publishing.post, 'x'.repeat(301)), {
                message: /at most 300/,
            });
        });

        it('posts at most once a minute', async () => {
            await connect();
            await call(Publishing.post, 'One');
            await assert.rejects(call(Publishing.post, 'Two'), {
                message: /Wait 60 seconds/,
            });
            clock += 60 * 1000;
            await call(Publishing.post, 'Three');
        });
    });

    describe('the account', () => {
        it('is remembered, and forgotten (and revoked) on disconnecting', async () => {
            await connect();
            assert.equal(Publishing.getBoardAccount().did, Board.did);
            assert.equal(Publishing.getBoardAccount().handle, Board.handle);

            await call(Publishing.disconnectBoardAccount);
            assert.deepEqual(revoked, [Board.did]);
            assert.equal(Publishing.getBoardAccount(), null);
        });

        it('replaces the previous account when another is connected', async () => {
            await connect();
            await call(Publishing.connectBoardAccount, { did: 'did:plc:other' });
            assert.equal(Publishing.getBoardAccount().did, 'did:plc:other');
            assert.equal(Publishing.getBoardAccount().handle, undefined);
        });
    });
});
