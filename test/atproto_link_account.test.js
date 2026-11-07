'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');
const Events = require('../core/events.js');
const { ErrorReasons } = require('../core/enig_error.js');

//
//  Linking AT identities to existing users: at AT login, with the user's
//  password (loginLinkingExistingUser), and from a logged in user's settings
//  (linkDidToUser, unlinkDidFromUser). See atproto_login.test.js for AT
//  login itself.
//

let testConfig;
const baseConfig = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'Test BBS', closedSystem: false },
    theme: { default: 'test_theme' },
    users: {
        usernameMin: 2,
        usernameMax: 16,
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

const Alice = { did: 'did:plc:alice', handle: 'alice.bsky.social' };
const Password = 'correct horse battery';

describe('Linking AT identities to existing users', function () {
    //  Each password check derives a key the slow way, on purpose
    this.timeout(20000);

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

        //  As in atproto_login.test.js: userLogin() down to its first factor
        AtProtoLogin._setUserLogin((client, username, password, options, cb) => {
            client.user.authenticateFactor1(
                {
                    username,
                    password,
                    type: options.authType,
                    did: options.did,
                    linkWithPassword: true === options.linkWithPassword,
                },
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

    let bob; //  an existing password user (user #2; #1 is root)

    beforeEach(async () => {
        testConfig = baseConfig();
        db.exec(
            'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
        );
        await createPasswordUser('sysop1');
        bob = await createPasswordUser('bob');
    });

    async function createPasswordUser(username, properties = {}) {
        const user = new User();
        user.username = username;
        user.properties = Object.assign({ [UserProps.RealName]: username }, properties);
        await call(user.create.bind(user), { password: Password, sessionId: 's' });
        return user;
    }

    const makeClient = ({ isSecure = true } = {}) => ({
        session: { isSecure, uniqueId: 'session-1' },
        term: { termHeight: 25, termWidth: 80 },
        log: quietLog,
        user: new User(),
    });

    const propOf = (userId, name) => {
        const row = db
            .prepare(
                'SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?'
            )
            .get(userId, name);
        return row ? row.prop_value : undefined;
    };

    const linkAtLogin = (identity, username, password, clientOptions) => {
        const client = makeClient(clientOptions);
        return call(
            AtProtoLogin.loginLinkingExistingUser,
            client,
            identity,
            username,
            password
        ).then(() => client);
    };

    //  A user logged in by password, as from the settings menu
    const loggedIn = async (username = 'bob') => {
        const client = makeClient();
        await call(client.user.authenticateFactor1.bind(client.user), {
            username,
            password: Password,
        });
        return client;
    };

    describe('at AT login, with a password', () => {
        it('links the user and logs them in; AT login finds them after', async () => {
            const client = await linkAtLogin(Alice, 'bob', Password);
            assert.equal(client.user.userId, bob.userId);
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), Alice.did);
            assert.equal(propOf(bob.userId, UserProps.AtProtoHandle), Alice.handle);

            const again = makeClient();
            await call(AtProtoLogin.loginWithDid, again, Alice);
            assert.equal(again.user.userId, bob.userId);
        });

        it('refuses a wrong password, counting it as a failed login', async () => {
            await assert.rejects(linkAtLogin(Alice, 'bob', 'wrong'), {
                message: /Invalid password/,
            });
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), undefined);
            assert.equal(propOf(bob.userId, UserProps.FailedLoginAttempts), '1');
        });

        it('replaces a DID the user had before', async () => {
            await linkAtLogin({ did: 'did:plc:old' }, 'bob', Password);
            await linkAtLogin(Alice, 'bob', Password);
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), Alice.did);
        });

        it('refuses a DID another user has, before checking the password', async () => {
            await linkAtLogin(Alice, 'bob', Password);
            await createPasswordUser('carol');
            await assert.rejects(linkAtLogin(Alice, 'carol', 'wrong'), {
                reasonCode: ErrorReasons.AlreadyThere,
            });
        });

        it('refuses users with 2FA, without counting a failed login', async () => {
            await call(bob.persistProperty.bind(bob), UserProps.AuthFactor2OTP, 'totp');
            await assert.rejects(linkAtLogin(Alice, 'bob', Password), {
                reasonCode: ErrorReasons.TwoFactorEnabled,
            });
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), undefined);
            assert.equal(propOf(bob.userId, UserProps.FailedLoginAttempts), undefined);
        });

        it('works on a board that accepts AT logins only', async () => {
            testConfig.users.allowedAuthFactor1Types = ['atproto'];
            const client = await linkAtLogin(Alice, 'bob', Password);
            assert.equal(client.user.userId, bob.userId);
        });

        it('is refused when AT login is not an allowed login type', async () => {
            testConfig.users.allowedAuthFactor1Types = ['password'];
            await assert.rejects(linkAtLogin(Alice, 'bob', Password), {
                reasonCode: ErrorReasons.LoginTypeNotAllowed,
            });
        });

        it('is refused on an insecure connection', async () => {
            await assert.rejects(
                linkAtLogin(Alice, 'bob', Password, { isSecure: false }),
                { message: /secure connection/ }
            );
        });
    });

    describe('from settings', () => {
        it('links the logged in user', async () => {
            const client = await loggedIn();
            await call(AtProtoLogin.linkDidToUser, client, Alice);
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), Alice.did);
            assert.equal(client.user.getProperty(UserProps.AtProtoHandle), Alice.handle);
        });

        it('refuses a DID another user has', async () => {
            await linkAtLogin(Alice, 'sysop1', Password);
            const client = await loggedIn();
            await assert.rejects(call(AtProtoLogin.linkDidToUser, client, Alice), {
                reasonCode: ErrorReasons.AlreadyThere,
            });
        });

        it("replaces the user's DID, dropping the old handle", async () => {
            const client = await loggedIn();
            await call(AtProtoLogin.linkDidToUser, client, Alice);
            await call(AtProtoLogin.linkDidToUser, client, { did: 'did:plc:new' });
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), 'did:plc:new');
            assert.equal(propOf(bob.userId, UserProps.AtProtoHandle), undefined);
        });

        it('needs a logged in user', async () => {
            await assert.rejects(call(AtProtoLogin.linkDidToUser, makeClient(), Alice), {
                message: /Not logged in/,
            });
        });
    });

    describe('unlinking', () => {
        let client;
        beforeEach(async () => {
            client = await loggedIn();
            await call(AtProtoLogin.linkDidToUser, client, Alice);
        });

        const unlink = password => call(AtProtoLogin.unlinkDidFromUser, client, password);

        it('removes the DID and handle, given the right password', async () => {
            await unlink(Password);
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), undefined);
            assert.equal(propOf(bob.userId, UserProps.AtProtoHandle), undefined);
        });

        it('refuses a wrong password', async () => {
            await assert.rejects(unlink('wrong'), {
                reasonCode: ErrorReasons.ValueInvalid,
            });
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), Alice.did);
        });

        it('refuses with no password and no SSH key: no way in would be left', async () => {
            await assert.rejects(unlink(''), { reasonCode: ErrorReasons.NotAllowed });
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), Alice.did);
        });

        it('allows no password for a user with a saved SSH key', async () => {
            client.user.setProperty(
                UserProps.SSHPubKey,
                'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'
            );
            await unlink('');
            assert.equal(propOf(bob.userId, UserProps.AtProtoDid), undefined);
        });

        it('refuses when the board does not accept password logins', async () => {
            testConfig.users.allowedAuthFactor1Types = ['atproto', 'sshPubKey'];
            await assert.rejects(unlink(Password), {
                reasonCode: ErrorReasons.NotAllowed,
            });
        });

        it('reports when nothing is linked', async () => {
            await unlink(Password);
            await assert.rejects(unlink(Password), {
                reasonCode: ErrorReasons.DoesNotExist,
            });
        });
    });
});
