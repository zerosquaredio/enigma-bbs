'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

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
        badUserNames: ['sysop', 'admin', 'root'],
        requireActivation: false,
        defaultGroups: ['users'],
        failedLogin: { lockAccount: 0 },
    },
    atProto: {
        enabled: true,
        oauth: { clientMode: 'loopback' },
        login: { allowNewUsers: true, secureConnectionsOnly: true, rootDid: '' },
    },
});

const RootDid = 'did:plc:sysop';

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

//  Turn a callback-style call into a Promise so the tests can await it
const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

describe('AT login', () => {
    let previousConfigGet;
    let previousUserDb;
    let previousEmit;
    let previousListenerCount;
    let User;
    let UserProps;
    let AtProtoLogin;
    let db;
    let logins;

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

        //  The last step, userLogin(), also sets up the session (themes,
        //  stats, events). Stand in for it with just its first-factor check,
        //  which is the part AT login changes.
        AtProtoLogin._setUserLogin((client, username, password, options, cb) => {
            logins.push({ username, options });
            client.user.authenticateFactor1(
                { username, password, type: options.authType, did: options.did },
                cb
            );
        });
    });

    after(() => {
        Events.emit = previousEmit;
        Events.listenerCount = previousListenerCount;
        dbModule.dbs.user = previousUserDb;
        db.close();
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(() => {
        testConfig = baseConfig();
        db.exec(
            'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
        );
        logins = [];
    });

    const makeClient = ({ isSecure = true } = {}) => ({
        session: { isSecure, uniqueId: 'session-1' },
        term: { termHeight: 25, termWidth: 80 },
        log: quietLog,
        user: new User(),
    });

    const login = (identity, clientOptions) => {
        const client = makeClient(clientOptions);
        return call(AtProtoLogin.loginWithDid, client, identity).then(() => client);
    };

    //
    //  What the new user application does for an AT applicant: create the
    //  user (|username|, or one suggested from the handle) bound to the DID,
    //  then log in
    //
    const applyAndLogin = async (identity, { username, clientOptions } = {}) => {
        const client = makeClient(clientOptions);
        const newUser = new User();
        newUser.username =
            username || (await call(AtProtoLogin.deriveUsername, identity.handle));
        newUser.properties = { [UserProps.RealName]: 'Applicant' };
        await call(AtProtoLogin.createUserForDid, client, identity, newUser);
        await call(AtProtoLogin.loginWithDid, client, identity);
        return client;
    };

    //  The board's first user is root, and only rootDid may claim it
    const withRootUser = async () => {
        testConfig.atProto.login.rootDid = RootDid;
        return applyAndLogin({ did: RootDid, handle: 'sysop.example.com' });
    };

    const groupsOf = userId =>
        db
            .prepare(
                'SELECT group_name FROM user_group_member WHERE user_id = ? ORDER BY 1'
            )
            .all(userId)
            .map(r => r.group_name);

    const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM user').get().n;

    describe('refusals', () => {
        it('refuses when AT Protocol support is off', async () => {
            testConfig.atProto.enabled = false;
            await assert.rejects(login({ did: 'did:plc:alice', handle: 'alice.test' }), {
                message: /not enabled/,
            });
        });

        it('refuses an insecure connection such as telnet', async () => {
            await assert.rejects(
                login(
                    { did: 'did:plc:alice', handle: 'alice.test' },
                    { isSecure: false }
                ),
                { message: /secure connection/ }
            );
        });

        it('allows an insecure connection when the sysop turns the check off', async () => {
            await withRootUser();
            testConfig.atProto.login.secureConnectionsOnly = false;
            const client = await applyAndLogin(
                { did: 'did:plc:alice', handle: 'alice.test' },
                { clientOptions: { isSecure: false } }
            );
            assert.equal(client.user.username, 'alice');
        });

        it('refuses something that is not a DID', async () => {
            await assert.rejects(login({ did: 'alice.test' }), { message: /DID/ });
        });
    });

    describe('an account with no user', () => {
        beforeEach(withRootUser);

        it('is reported as having no user, and nothing is created', async () => {
            await assert.rejects(login({ did: 'did:plc:alice', handle: 'alice.test' }), {
                reasonCode: ErrorReasons.DoesNotExist,
            });
            assert.equal(userCount(), 1);
        });

        it('may apply when the board takes new users', async () => {
            await call(AtProtoLogin.checkNewUserAllowed, makeClient(), 'did:plc:alice');
        });

        it('may not apply when the sysop turns off new users', async () => {
            testConfig.atProto.login.allowNewUsers = false;
            await assert.rejects(
                call(AtProtoLogin.checkNewUserAllowed, makeClient(), 'did:plc:alice'),
                { message: /not accepting new users/ }
            );
        });

        it('may not apply on a closed system', async () => {
            testConfig.general.closedSystem = true;
            await assert.rejects(
                call(AtProtoLogin.checkNewUserAllowed, makeClient(), 'did:plc:alice'),
                { message: /not accepting new users/ }
            );
        });
    });

    describe('the first user', () => {
        it('cannot be created by AT login when rootDid is empty', async () => {
            await assert.rejects(
                applyAndLogin({ did: RootDid, handle: 'sysop.example.com' }),
                {
                    message: /rootDid/,
                }
            );
            assert.equal(userCount(), 0);
        });

        it('cannot be claimed by any DID other than rootDid', async () => {
            testConfig.atProto.login.rootDid = RootDid;
            await assert.rejects(
                applyAndLogin({ did: 'did:plc:mallory', handle: 'mallory.test' }),
                { message: /rootDid/ }
            );
        });

        it('is created for rootDid, as root and a sysop', async () => {
            const client = await withRootUser();
            assert.equal(client.user.userId, 1);
            assert.equal(client.user.username, 'sysop2'); //  "sysop" is a reserved name
            assert.deepEqual(groupsOf(1), ['sysops', 'users']);
        });
    });

    describe('applicants', () => {
        beforeEach(withRootUser);

        it('are created with the username they chose, bound to the DID', async () => {
            const client = await applyAndLogin(
                { did: 'did:plc:alice', handle: 'alice.bsky.social' },
                { username: 'AliceInChains' }
            );
            assert.equal(client.user.username, 'AliceInChains');
            assert.equal(client.user.isAuthenticated(), true);
            assert.equal(client.user.getProperty(UserProps.AtProtoDid), 'did:plc:alice');
            assert.equal(
                client.user.getProperty(UserProps.AtProtoHandle),
                'alice.bsky.social'
            );
            assert.equal(client.user.getProperty(UserProps.RealName), 'Applicant');
            assert.deepEqual(groupsOf(client.user.userId), ['users']);
        });

        it('log in through the atproto login type with their DID', async () => {
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
            assert.deepEqual(logins.pop(), {
                username: 'alice',
                options: { authType: 'atproto', did: 'did:plc:alice' },
            });
        });

        it('cannot log in with the password they never chose', async () => {
            const client = await applyAndLogin({
                did: 'did:plc:alice',
                handle: 'alice.test',
            });
            const other = new User();
            await assert.rejects(
                call(other.authenticateFactor1.bind(other), {
                    username: client.user.username,
                    password: '',
                }),
                { message: /Access denied/ }
            );
        });

        it('cannot apply twice for one DID', async () => {
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' });
            await assert.rejects(
                applyAndLogin(
                    { did: 'did:plc:alice', handle: 'alice.test' },
                    { username: 'alice-again' }
                ),
                { message: /already linked/ }
            );
        });

        it('are refused at submit if new users were turned off meanwhile', async () => {
            testConfig.atProto.login.allowNewUsers = false;
            await assert.rejects(
                applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' }),
                {
                    message: /not accepting new users/,
                }
            );
            assert.equal(userCount(), 1);
        });
    });

    describe('returning users', () => {
        beforeEach(withRootUser);

        it('are found by DID, keeping their username after a handle change', async () => {
            const first = await applyAndLogin({
                did: 'did:plc:alice',
                handle: 'alice.bsky.social',
            });
            const again = await login({
                did: 'did:plc:alice',
                handle: 'alice.example.com',
            });

            assert.equal(again.user.userId, first.user.userId);
            assert.equal(again.user.username, 'alice');
            await new Promise(resolve => setImmediate(resolve));
            const stored = db
                .prepare(
                    'SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?'
                )
                .get(first.user.userId, UserProps.AtProtoHandle).prop_value;
            assert.equal(stored, 'alice.example.com');
        });

        it('can still log in when new users are turned off', async () => {
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' });
            testConfig.atProto.login.allowNewUsers = false;
            const client = await login({ did: 'did:plc:alice', handle: 'alice.test' });
            assert.equal(client.user.username, 'alice');
        });

        it('are not found by handle: a new DID with an old handle has no user', async () => {
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' });
            await assert.rejects(
                login({ did: 'did:plc:newowner', handle: 'alice.test' }),
                {
                    reasonCode: ErrorReasons.DoesNotExist,
                }
            );
        });

        it('are refused if two users are somehow bound to one DID', async () => {
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' });
            await applyAndLogin({ did: 'did:plc:bob', handle: 'bob.test' });
            db.prepare(
                'UPDATE user_property SET prop_value = ? WHERE prop_name = ? AND prop_value = ?'
            ).run('did:plc:alice', UserProps.AtProtoDid, 'did:plc:bob');

            await assert.rejects(login({ did: 'did:plc:alice', handle: 'alice.test' }), {
                message: /More than one user/,
            });
        });
    });

    describe('the atproto login type', () => {
        beforeEach(withRootUser);

        it('refuses a DID that is not the one bound to the user', async () => {
            const alice = await applyAndLogin({
                did: 'did:plc:alice',
                handle: 'alice.test',
            });
            const other = new User();
            await assert.rejects(
                call(other.authenticateFactor1.bind(other), {
                    username: alice.user.username,
                    type: User.AuthFactor1Types.AtProto,
                    did: 'did:plc:mallory',
                }),
                { message: /AT identity does not match/ }
            );
        });

        it('refuses a user with no DID bound', async () => {
            db.prepare('INSERT INTO user (user_name) VALUES (?)').run('carol');
            const other = new User();
            await assert.rejects(
                call(other.authenticateFactor1.bind(other), {
                    username: 'carol',
                    type: User.AuthFactor1Types.AtProto,
                    did: 'did:plc:carol',
                }),
                { message: /AT identity does not match/ }
            );
        });
    });

    describe('the pending identity', () => {
        it('is kept on the session until cleared', () => {
            const client = makeClient();
            AtProtoLogin.setPendingIdentity(client, {
                did: 'did:plc:alice',
                handle: 'a.test',
            });
            assert.deepEqual(AtProtoLogin.getPendingIdentity(client), {
                did: 'did:plc:alice',
                handle: 'a.test',
            });
            AtProtoLogin.clearPendingIdentity(client);
            assert.equal(AtProtoLogin.getPendingIdentity(client), null);
        });

        it('expires after half an hour', () => {
            const client = makeClient();
            AtProtoLogin.setPendingIdentity(client, { did: 'did:plc:alice' });
            client.atProtoPendingIdentity.provenAt -= 31 * 60 * 1000;
            assert.equal(AtProtoLogin.getPendingIdentity(client), null);
        });
    });

    describe('username suggestions', () => {
        it('start with the handle name, then number it', () => {
            const names = AtProtoLogin.usernameCandidates('alice.bsky.social');
            assert.deepEqual(names.slice(0, 3), ['alice', 'alice2', 'alice3']);
        });

        it('stay within the maximum length', () => {
            const names = AtProtoLogin.usernameCandidates(
                'averyveryverylongname.example'
            );
            assert.equal(names[0], 'averyveryverylon');
            assert.equal(names[1], 'averyveryverylo2');
            assert.ok(names.every(n => n.length <= 16));
        });

        it('fall back to generated names when the handle name is too short', () => {
            const names = AtProtoLogin.usernameCandidates('a.bsky.social');
            assert.equal(names.length, 3);
            assert.ok(names.every(n => /^atuser\d{5}$/.test(n)));
        });

        it('skip reserved and taken names', async () => {
            await withRootUser();
            assert.equal(
                await call(AtProtoLogin.deriveUsername, 'admin.example.com'),
                'admin2'
            );
            await applyAndLogin({ did: 'did:plc:alice', handle: 'alice.test' });
            assert.equal(
                await call(AtProtoLogin.deriveUsername, 'alice.other'),
                'alice2'
            );
        });
    });
});
