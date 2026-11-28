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

describe("AT publishing: the board's splash screen", () => {
    //  loaded afresh here, against the stand-in config
    const Modules = [
        '../core/web_util.js',
        '../core/atproto/oauth_client.js',
        '../core/atproto/admission/index.js',
        '../core/atproto/splash.js',
        '../core/atproto/publishing.js',
    ];
    let previousConfigGet;
    let previousDb;
    let AtProtoOAuth;
    let Publishing;
    let Splash;
    let saved;
    let requests;
    let testConfig;
    let root;

    const Connect = Buffer.from('\x1b[1;35mWELCOME\x1b[0m\r\n', 'latin1');
    const Matrix = Buffer.from('\x1b[36mLOGIN %VM1\x1b[0m\r\n', 'latin1');
    const write = (dir, name, body) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(paths.join(dir, name), body);
    };

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        previousDb = dbModule.dbs.atproto;
        Modules.forEach(m => delete require.cache[require.resolve(m)]);
        AtProtoOAuth = require('../core/atproto/oauth_client.js');
        Splash = require('../core/atproto/splash.js');
        Publishing = require('../core/atproto/publishing.js');
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

    beforeEach(() => {
        root = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-splash-'));
        testConfig = {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            paths: {
                themes: paths.join(root, 'themes'),
                art: paths.join(root, 'general'),
            },
            theme: { default: 'mytheme', preLogin: 'mytheme' },
            atProto: {
                enabled: true,
                oauth: { clientMode: 'loopback' },
                admission: { policy: ['open'] },
                publishing: {
                    enabled: true,
                    listing: {},
                    splash: { art: ['CONNECT', 'MATRIX'] },
                },
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
        Splash._reset();
        requests = [];
        AtProtoOAuth.boardRequest = (did, method, nsid, params, cb) => {
            requests.push({ did, method, nsid, params });
            setImmediate(() => cb(null, { uri: `at://${did}/x/1`, cid: 'c' }));
        };
    });

    afterEach(() => {
        dbModule.dbs.atproto.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const Board = { did: 'did:plc:board', handle: 'board.example.com' };
    const lastListing = () =>
        requests.filter(r => r.nsid === 'com.atproto.repo.putRecord').pop();

    describe('which art it is', () => {
        it("is the theme's CONNECT art, as it is, by its hash", async () => {
            write(paths.join(root, 'themes', 'mytheme'), 'connect.ans', Connect);
            write(paths.join(root, 'themes', 'mytheme'), 'MATRIX.ANS', Matrix);
            const found = await new Promise(r => Splash.find(r));
            assert.equal(found.sha256, sha(Connect));
            assert.equal(found.size, Connect.length);
            assert.equal(found.mediaType, 'text/x-ansi');
            assert.deepEqual(Splash.served(sha(Connect)), Connect);
            assert.equal(
                Splash.served(sha(Matrix)),
                null,
                'only the splash itself is served'
            );
        });

        it("is the framework's own connect screen on the stock theme, which isn't stock art", async () => {
            //  the real art folders, as a board on ENiGMA½'s stock theme has them
            testConfig.paths.themes = paths.join(__dirname, '..', 'art', 'themes');
            testConfig.paths.art = paths.join(__dirname, '..', 'art', 'general');
            testConfig.theme = {
                default: 'luciano_blocktronics',
                preLogin: 'luciano_blocktronics',
            };
            const found = await new Promise(r => Splash.find(r));
            assert.equal(paths.basename(found.path), 'CONNECT.ANS');
            assert.equal(paths.basename(paths.dirname(found.path)), 'general');
            assert.equal(Publishing.isStockArt(found.sha256), false, 'ours to offer');
        });

        it('is the login matrix when there is no CONNECT art, from the general art if need be', async () => {
            write(paths.join(root, 'general'), 'MATRIX1.ANS', Matrix);
            const found = await new Promise(r => Splash.find(r));
            assert.equal(
                found.sha256,
                sha(Matrix),
                "a theme's first random variant counts"
            );
        });

        it('can be other art, or a file, as the sysop names it', async () => {
            write(paths.join(root, 'general'), 'WELCOME.ANS', Connect);
            write(root, 'mine.ans', Matrix);
            testConfig.atProto.publishing.splash.art = [paths.join(root, 'mine.ans')];
            assert.equal((await new Promise(r => Splash.find(r))).sha256, sha(Matrix));
            testConfig.atProto.publishing.splash.art = 'WELCOME';
            assert.equal((await new Promise(r => Splash.find(r))).sha256, sha(Connect));
        });

        it('is found again when asked for a file it has not looked up, as after oputil', async () => {
            write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', Connect);
            //  nothing looked up in this process yet
            assert.equal(Splash.served(sha(Connect)), null);
            const found = await new Promise(r => Splash.lookup(sha(Connect), r));
            assert.deepEqual(found, { kind: 'splash', body: Connect });
            assert.equal(
                await new Promise(r => Splash.lookup(sha(Matrix), r)),
                null,
                'only the splash'
            );
        });

        it('is none when there is no art, or only art it would not offer', async () => {
            assert.equal(await new Promise(r => Splash.find(r)), null);
            write(
                paths.join(root, 'general'),
                'CONNECT.ANS',
                Buffer.alloc(Splash.MaxBytes + 1, 0x41)
            );
            write(root, 'pic.png', Connect);
            testConfig.atProto.publishing.splash.art = [
                'CONNECT',
                paths.join(root, 'pic.png'),
            ];
            assert.equal(
                await new Promise(r => Splash.find(r)),
                null,
                'too large, or not ANSI'
            );
            assert.equal(Splash.served(sha(Connect)), null);
        });
    });

    describe('the sysop agreeing to it', () => {
        beforeEach(() =>
            write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', Connect)
        );

        it('is asked on connecting: yes the first time, and the listing names the splash', async () => {
            await call(Publishing.connectBoardAccount, Board);
            const account = Publishing.getBoardAccount();
            assert.equal(account.splashShown, true);
            assert.ok(account.splashAt);
            assert.deepEqual(lastListing().params.record.splash, {
                sha256: sha(Connect),
                size: Connect.length,
                mediaType: 'text/x-ansi',
            });
        });

        it('can be taken back, and then the listing names none, also after connecting again', async () => {
            await call(Publishing.connectBoardAccount, Board);
            const off = await call(Publishing.setSplashShown, false);
            assert.equal(off.written, true);
            assert.equal(off.record.splash, undefined);
            assert.equal(Publishing.getBoardAccount().splashShown, false);

            await call(Publishing.connectBoardAccount, { did: 'did:plc:other' });
            assert.equal(
                Publishing.getBoardAccount().splashShown,
                false,
                "the sysop's answer stands"
            );
            assert.equal(lastListing().params.record.splash, undefined);

            const on = await call(Publishing.setSplashShown, true);
            assert.equal(on.record.splash.sha256, sha(Connect));
        });

        it('stops offering it when the art changes, tells the sysop once, and offers the new art once they agree', async () => {
            const notices = [];
            const previous = Publishing._setNoticeWriter((subject, body, cb) => {
                notices.push({ subject, body });
                setImmediate(() => cb(null));
            });
            try {
                await call(Publishing.connectBoardAccount, Board);
                assert.equal(Publishing.getBoardAccount().splashSha256, sha(Connect));
                write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', Matrix);
                const changed = await call(Publishing.publishListing, {});
                assert.equal(changed.written, true);
                assert.equal(changed.record.splash, undefined, 'not offered');
                assert.equal(
                    Publishing.getBoardAccount().splashShown,
                    true,
                    'the yes stands'
                );
                assert.equal(
                    Publishing.splashState(Publishing.getBoardAccount(), {
                        sha256: sha(Matrix),
                    }),
                    'changed'
                );
                assert.equal(notices.length, 1);
                assert.match(notices[0].subject, /stopped showing your login screen/);
                assert.match(notices[0].body, /has changed \(it is CONNECT\.ANS now\)/);
                assert.match(notices[0].body, /atproto splash on/);

                //  told once for each new file
                await call(Publishing.publishListing, { force: true });
                assert.equal(notices.length, 1);

                const agreed = await call(Publishing.setSplashShown, true);
                assert.equal(agreed.record.splash.sha256, sha(Matrix));
                assert.equal(Publishing.getBoardAccount().splashSha256, sha(Matrix));
            } finally {
                Publishing._setNoticeWriter(previous);
            }
        });

        it("isn't offered by default when the art is ENiGMA½'s stock art", async () => {
            const stock = fs.readFileSync(
                paths.join(
                    __dirname,
                    '..',
                    'art',
                    'themes',
                    'luciano_blocktronics',
                    'MATRIX.ANS'
                )
            );
            assert.ok(Publishing.isStockArt(sha(stock)), 'in the list of stock art');
            assert.ok(!Publishing.isStockArt(sha(Connect)));
            write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', stock);
            await call(Publishing.connectBoardAccount, Board);
            const account = Publishing.getBoardAccount();
            assert.equal(account.splashShown, false);
            assert.equal(account.splashSha256, null);
            assert.equal(lastListing().params.record.splash, undefined);
            //  the sysop may still say yes, as for any art
            const yes = await call(Publishing.setSplashShown, true);
            assert.equal(yes.record.splash.sha256, sha(stock));
        });

        it('is to no art when none was found, and asks again once some is', async () => {
            fs.rmSync(paths.join(root, 'themes', 'mytheme', 'CONNECT.ANS'));
            const previous = Publishing._setNoticeWriter((s, b, cb) =>
                setImmediate(() => cb(null))
            );
            try {
                await call(Publishing.connectBoardAccount, Board);
                assert.equal(Publishing.getBoardAccount().splashShown, true);
                assert.equal(Publishing.getBoardAccount().splashSha256, null);
                write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', Connect);
                const later = await call(Publishing.publishListing, {});
                assert.equal(later.record.splash, undefined);
            } finally {
                Publishing._setNoticeWriter(previous);
            }
        });

        it('is not assumed for a board connected before it was asked', () => {
            //  an account table from before version 5, with a board in it
            const db = new Database(':memory:');
            db.exec(`CREATE TABLE board_account (
                id INTEGER PRIMARY KEY CHECK (id = 1), did VARCHAR NOT NULL, handle VARCHAR,
                connected_timestamp INTEGER NOT NULL, listing_hash VARCHAR,
                listing_timestamp INTEGER, post_timestamp INTEGER)`);
            db.prepare(
                'INSERT INTO board_account (id, did, connected_timestamp) VALUES (1, ?, 1)'
            ).run(Board.did);
            dbModule.initAtProtoDatabase(db);
            dbModule.dbs.atproto.close();
            dbModule.dbs.atproto = db;
            Publishing._setStore(null);
            assert.equal(Publishing.getBoardAccount().splashShown, undefined);
            assert.equal(db.pragma('user_version', { simple: true }), 6);
        });

        //  a version 5 table, with the sysop's yes given before it was to a file
        const fromVersion5 = () => {
            const db = new Database(':memory:');
            db.exec(`CREATE TABLE board_account (
                id INTEGER PRIMARY KEY CHECK (id = 1), did VARCHAR NOT NULL, handle VARCHAR,
                connected_timestamp INTEGER NOT NULL, listing_hash VARCHAR,
                listing_timestamp INTEGER, post_timestamp INTEGER,
                splash_shown INTEGER, splash_timestamp INTEGER)`);
            db.prepare(
                'INSERT INTO board_account (id, did, connected_timestamp, splash_shown, splash_timestamp) VALUES (1, ?, 1, 1, 1)'
            ).run(Board.did);
            dbModule.initAtProtoDatabase(db);
            dbModule.dbs.atproto.close();
            dbModule.dbs.atproto = db;
            Publishing._setStore(null);
        };

        it('takes a yes from before it was to a file as a yes to the art offered now', async () => {
            fromVersion5();
            assert.equal(Publishing.getBoardAccount().splashSha256, 'adopt');
            const listed = await call(Publishing.publishListing, {});
            assert.equal(listed.record.splash.sha256, sha(Connect));
            assert.equal(Publishing.getBoardAccount().splashSha256, sha(Connect));
        });

        it('but not when that art is the stock art', async () => {
            const stock = fs.readFileSync(
                paths.join(
                    __dirname,
                    '..',
                    'art',
                    'themes',
                    'luciano_blocktronics',
                    'MATRIX.ANS'
                )
            );
            write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', stock);
            fromVersion5();
            const notices = [];
            const previous = Publishing._setNoticeWriter((subject, body, cb) => {
                notices.push(body);
                setImmediate(() => cb(null));
            });
            try {
                const listed = await call(Publishing.publishListing, {});
                assert.equal(listed.record.splash, undefined);
                assert.equal(notices.length, 1);
                assert.match(notices[0], /stock art/);
            } finally {
                Publishing._setNoticeWriter(previous);
            }
        });
    });
    describe("the account's permissions", () => {
        const grant = scope =>
            dbModule.dbs.atproto
                .prepare(
                    'REPLACE INTO oauth_board_session (did, session_json, updated_timestamp) VALUES (?, ?, 1)'
                )
                .run(
                    Board.did,
                    JSON.stringify({ tokenSet: { scope, access_token: 'secret' } })
                );

        it('says what an account connected before lacks, and nothing once it has it all', async () => {
            await call(Publishing.connectBoardAccount, Board);
            assert.equal(
                Publishing.missingPermissions(),
                null,
                'no session: it cannot tell'
            );
            grant(
                'atproto repo:nexus.cyberspace.dev.leaf.listing repo:nexus.cyberspace.dev.leaf.status repo:app.bsky.feed.post blob:image/*'
            );
            assert.deepEqual(Publishing.missingPermissions(), [
                'repo:nexus.cyberspace.dev.asset.item',
                'repo:nexus.cyberspace.dev.asset.catalogue',
                'repo:nexus.cyberspace.dev.asset.view',
                'repo:nexus.cyberspace.dev.object',
                'blob:*/*',
            ]);
            const { boardScope } = require('../core/atproto/const.js');
            grant(boardScope().split(' ').reverse().join('  '));
            assert.deepEqual(Publishing.missingPermissions(), []);
        });

        describe('asked for as a permission set', () => {
            const Set = 'nexus.cyberspace.dev.authBoard';
            beforeEach(() => {
                testConfig.atProto.publishing.permissionSet = Set;
            });
            afterEach(() => {
                delete testConfig.atProto.publishing.permissionSet;
            });

            it('asks for the set, with posts and files beside it', () => {
                const {
                    boardScope,
                    permissionWords,
                } = require('../core/atproto/const.js');
                assert.equal(
                    boardScope('nexus.cyberspace.dev', Set),
                    `atproto include:${Set} repo:app.bsky.feed.post blob:*/*`
                );
                assert.equal(
                    permissionWords(`include:${Set}`),
                    'its listing, status, art and live objects'
                );
                //  a name that isn't one: each type by name, as without
                assert.equal(
                    boardScope('nexus.cyberspace.dev', 'not a set'),
                    boardScope('nexus.cyberspace.dev')
                );
            });

            it('takes the set as granted, as itself or as the types it names', async () => {
                await call(Publishing.connectBoardAccount, Board);
                grant('atproto repo:app.bsky.feed.post blob:*/*');
                assert.deepEqual(Publishing.missingPermissions(), [`include:${Set}`]);
                grant(`atproto include:${Set} repo:app.bsky.feed.post blob:*/*`);
                assert.deepEqual(Publishing.missingPermissions(), []);
                grant(
                    'atproto repo:nexus.cyberspace.dev.leaf.listing repo:nexus.cyberspace.dev.leaf.status repo:app.bsky.feed.post blob:*/*'
                );
                assert.deepEqual(Publishing.missingPermissions(), []);
                //  the live objects' type is then not asked about: the set
                //  says, and publishing finds out
                grant(`atproto include:${Set} repo:app.bsky.feed.post`);
                assert.deepEqual(Publishing.missingPermissions(), ['blob:*/*']);
            });
        });
    });

    describe('the emblem', () => {
        const Emblem = Buffer.from('\x1b[1;35m<>\x1b[0m\r\n', 'latin1');

        it('is none until the sysop names one', async () => {
            write(paths.join(root, 'general'), 'EMBLEM.ANS', Emblem);
            assert.equal(Splash.emblemNamed(), false);
            assert.equal(await new Promise(r => Splash.findEmblem(r)), null);
            await call(Publishing.connectBoardAccount, Board);
            assert.equal(lastListing().params.record.emblem, undefined);
        });

        it('is offered once named, by name or path, whatever the splash answer', async () => {
            write(paths.join(root, 'general'), 'EMBLEM.ANS', Emblem);
            testConfig.atProto.publishing.emblem = { art: 'EMBLEM' };
            await call(Publishing.connectBoardAccount, Board);
            await call(Publishing.setSplashShown, false);
            assert.deepEqual(lastListing().params.record.emblem, {
                sha256: sha(Emblem),
                size: Emblem.length,
                mediaType: 'text/x-ansi',
            });
            assert.deepEqual(Splash.served(sha(Emblem)), Emblem);

            write(root, 'mine.ans', Connect);
            testConfig.atProto.publishing.emblem = { art: paths.join(root, 'mine.ans') };
            const again = await call(Publishing.publishListing, {});
            assert.equal(again.record.emblem.sha256, sha(Connect));
        });

        it('is told apart from the splash when looked up', async () => {
            write(paths.join(root, 'themes', 'mytheme'), 'CONNECT.ANS', Connect);
            write(paths.join(root, 'general'), 'EMBLEM.ANS', Emblem);
            testConfig.atProto.publishing.emblem = { art: 'EMBLEM' };
            const kind = hash =>
                new Promise(r => Splash.lookup(hash, found => r(found && found.kind)));
            assert.equal(await kind(sha(Connect)), 'splash');
            assert.equal(await kind(sha(Emblem)), 'emblem');
            assert.equal(await kind(sha(Matrix)), null);
        });
    });
});
