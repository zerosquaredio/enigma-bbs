'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');
const Events = require('../core/events.js');
const { ErrorReasons } = require('../core/enig_error.js');

let testConfig;
const baseConfig = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'Test BBS', closedSystem: false },
    theme: { default: 'test_theme' },
    users: {
        usernameMin: 2,
        usernameMax: 16,
        usernamePattern: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+ .]+$',
        newUserNames: ['new', 'apply'],
        badUserNames: ['sysop'],
        requireActivation: false,
        defaultGroups: ['users'],
        failedLogin: { lockAccount: 3, disconnect: 0 },
        allowedAuthFactor1Types: ['password', 'sshPubKey', 'tlsClientAuth', 'atproto'],
    },
    atProto: {
        enabled: true,
        oauth: { clientMode: 'loopback' },
        login: {
            allowNewUsers: true,
            secureConnectionsOnly: false,
            rootDid: 'did:plc:root',
        },
    },
});

function applyUserSchema(db) {
    db.exec(`
        CREATE TABLE user (
            id          INTEGER PRIMARY KEY,
            user_name   VARCHAR NOT NULL,
            UNIQUE(user_name)
        );
        CREATE TABLE user_property (
            user_id     INTEGER NOT NULL,
            prop_name   VARCHAR NOT NULL,
            prop_value  VARCHAR,
            UNIQUE(user_id, prop_name),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE user_group_member (
            group_name  VARCHAR NOT NULL,
            user_id     INTEGER NOT NULL,
            UNIQUE(group_name, user_id)
        );
    `);
}

const quietLog = { info() {}, warn() {}, debug() {}, trace() {}, error() {} };

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('allowed login types (users.allowedAuthFactor1Types)', () => {
    let previousConfigGet;
    let previousUserDb;
    let previousEmit;
    let previousListenerCount;
    let User;
    let UserProps;
    let AtProtoLogin;
    let db;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        testConfig = baseConfig();

        previousUserDb = dbModule.dbs.user;
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyUserSchema(db);
        dbModule.dbs.user = db;

        previousEmit = Events.emit;
        previousListenerCount = Events.listenerCount;
        Events.emit = () => {};
        Events.listenerCount = () => 0;

        //  Fresh loads, so these capture the config and database above
        [
            '../core/user_group.js',
            '../core/user.js',
            '../core/system_view_validate.js',
            '../core/atproto/oauth_client.js',
            '../core/atproto/login.js',
        ].forEach(m => delete require.cache[require.resolve(m)]);

        User = require('../core/user.js');
        UserProps = require('../core/user_property.js');
        AtProtoLogin = require('../core/atproto/login.js');
        AtProtoLogin._setUserLogin((client, username, password, options, cb) =>
            client.user.authenticateFactor1(
                { username, password, type: options.authType, did: options.did },
                cb
            )
        );
    });

    after(() => {
        Events.emit = previousEmit;
        Events.listenerCount = previousListenerCount;
        dbModule.dbs.user = previousUserDb;
        db.close();
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(async () => {
        testConfig = baseConfig();
        db.exec(
            'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
        );

        const alice = new User();
        alice.username = 'alice';
        alice.properties = {};
        await call(alice.create.bind(alice), { password: 'correct horse' });
    });

    const allowOnly = (...types) => {
        testConfig.users.allowedAuthFactor1Types = types;
    };

    const passwordLogin = password => {
        const user = new User();
        return call(user.authenticateFactor1.bind(user), {
            username: 'alice',
            password,
        }).then(() => user);
    };

    const failedAttempts = () => {
        const row = db
            .prepare(
                'SELECT prop_value FROM user_property WHERE user_id = 1 AND prop_name = ?'
            )
            .get(UserProps.FailedLoginAttempts);
        return row ? parseInt(row.prop_value, 10) : 0;
    };

    it('accepts every login type by default, so nothing changes', async () => {
        const user = await passwordLogin('correct horse');
        assert.equal(user.username, 'alice');
        ['password', 'sshPubKey', 'tlsClientAuth', 'atproto'].forEach(type =>
            assert.equal(User.isAuthFactor1TypeAllowed(type), true)
        );
    });

    it('accepts every login type when the setting is missing', async () => {
        delete testConfig.users.allowedAuthFactor1Types;
        assert.equal(User.isAuthFactor1TypeAllowed('password'), true);
        await passwordLogin('correct horse');
    });

    it('refuses a password login when password is left out', async () => {
        allowOnly('atproto');
        await assert.rejects(passwordLogin('correct horse'), {
            reasonCode: ErrorReasons.LoginTypeNotAllowed,
        });
    });

    it('does not count a refused login type as a failed login', async () => {
        allowOnly('atproto');
        for (let i = 0; i < 4; ++i) {
            await assert.rejects(passwordLogin('wrong'));
        }
        assert.equal(failedAttempts(), 0);
    });

    it('refuses an SSH key login when sshPubKey is left out', async () => {
        allowOnly('password');
        const user = new User();
        await assert.rejects(
            call(user.authenticateFactor1.bind(user), {
                username: 'alice',
                type: User.AuthFactor1Types.SSHPubKey,
                pubKey: {},
            }),
            { reasonCode: ErrorReasons.LoginTypeNotAllowed }
        );
    });

    it('refuses AT login when atproto is left out, before creating a user', async () => {
        allowOnly('password');
        const client = {
            session: { isSecure: true, uniqueId: 's1' },
            term: { termHeight: 25, termWidth: 80 },
            log: quietLog,
            user: new User(),
        };
        await assert.rejects(
            call(AtProtoLogin.loginWithDid, client, {
                did: 'did:plc:root',
                handle: 'r.test',
            }),
            { reasonCode: ErrorReasons.LoginTypeNotAllowed }
        );
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user').get().n, 1);
    });

    describe('the login menu', () => {
        let SystemMenuMethod;
        let navigation;

        before(() => {
            //  Fresh loads, so these capture the config getter above
            ['../core/user_login.js', '../core/system_menu_method.js'].forEach(
                m => delete require.cache[require.resolve(m)]
            );
            SystemMenuMethod = require('../core/system_menu_method.js');
        });

        const loginFrom = menuConfig =>
            new Promise(resolve => {
                navigation = [];
                const callingMenu = {
                    menuConfig,
                    client: {
                        user: {
                            authenticateFactor1: (info, cb) =>
                                new User().authenticateFactor1(info, cb),
                        },
                        log: quietLog,
                        remoteAddress: '127.0.0.1',
                        friendlyRemoteAddress: () => '127.0.0.1',
                    },
                    gotoMenu: (name, cb) => {
                        navigation.push(['goto', name]);
                        cb(null);
                    },
                    prevMenu: cb => {
                        navigation.push(['prev']);
                        cb(null);
                    },
                };
                SystemMenuMethod.login(
                    callingMenu,
                    { value: { username: 'alice', password: 'correct horse' } },
                    {},
                    () => resolve(navigation)
                );
            });

        it('goes to its loginTypeNotAllowed menu rather than disconnecting', async () => {
            allowOnly('atproto');
            const nav = await loginFrom({
                config: { loginTypeNotAllowed: 'loginAttemptLoginTypeNotAllowed' },
            });
            assert.deepEqual(nav, [['goto', 'loginAttemptLoginTypeNotAllowed']]);
        });

        it('goes back when no such menu is configured', async () => {
            allowOnly('atproto');
            const nav = await loginFrom({ config: {} });
            assert.deepEqual(nav, [['prev']]);
        });
    });
});

describe('users.allowedAuthFactor1Types in config.hjson', function () {
    let savedGet;
    let savedReload;
    let tempDir;

    before(() => {
        savedGet = configModule.get;
        savedReload = configModule.reload;
        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-login-types-'));
    });

    after(() => {
        //  Config.create() rebinds these module-level exports
        configModule.get = savedGet;
        configModule.reload = savedReload;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function load(hjsonText, cb) {
        const path = paths.join(tempDir, `config-${Date.now()}-${Math.random()}.hjson`);
        fs.writeFileSync(path, hjsonText);
        configModule.Config.create(
            path,
            { hotReload: false, reportValidation: false },
            err => cb(err, configModule.get())
        );
    }

    it('keeps every login type when unset', done => {
        load('{\n}\n', (err, config) => {
            assert.ifError(err);
            assert.deepEqual(config.users.allowedAuthFactor1Types, [
                'password',
                'sshPubKey',
                'tlsClientAuth',
                'atproto',
            ]);
            return done();
        });
    });

    it('replaces the default list rather than adding to it', done => {
        load(
            '{\n    users: {\n        allowedAuthFactor1Types: [ "atproto" ]\n    }\n}\n',
            (err, config) => {
                assert.ifError(err);
                assert.deepEqual(config.users.allowedAuthFactor1Types, ['atproto']);
                return done();
            }
        );
    });
});
