'use strict';

const { strict: assert } = require('assert');

//
//  Removing a saved SSH key (core/user_ssh_key_config.js): never when it is
//  the user's only way to log in, and saying truthfully what is left.
//
describe('SSH key config: removing a key', () => {
    let User;
    let UserProps;
    let Module;
    let savedIsAllowed;
    let allowed;

    before(() => {
        delete require.cache[require.resolve('../core/user_ssh_key_config.js')];
        Module = require('../core/user_ssh_key_config.js').getModule;
        User = require('../core/user.js');
        UserProps = require('../core/user_property.js');
        savedIsAllowed = User.isAuthFactor1TypeAllowed;
        User.isAuthFactor1TypeAllowed = type => allowed.includes(type);
    });

    after(() => {
        User.isAuthFactor1TypeAllowed = savedIsAllowed;
    });

    //  The module with a fake user and views, recording what it shows
    const makeMenu = ({ did } = {}) => {
        const properties = {
            [UserProps.SSHPubKey]: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@host',
        };
        if (did) {
            properties[UserProps.AtProtoDid] = did;
        }
        const menu = Object.create(Module.prototype);
        menu.status = null;
        menu.client = {
            log: { info() {}, warn() {} },
            user: {
                getProperty: name => properties[name],
                setPublicSSHKey: (key, cb) => {
                    properties[UserProps.SSHPubKey] = key || undefined;
                    cb(null);
                },
            },
        };
        menu.properties = properties;
        menu.showStatus = message => {
            menu.status = message;
        };
        menu.refreshInfoText = () => {};
        return menu;
    };

    const remove = menu => new Promise(resolve => menu.removeKey(resolve));

    it('removes it while passwords are allowed, and says so', async () => {
        allowed = ['password', 'sshPubKey', 'atproto'];
        const menu = makeMenu();
        await remove(menu);
        assert.equal(menu.properties[UserProps.SSHPubKey], undefined);
        assert.match(menu.status, /Password authentication remains available/);
    });

    it('removes it on an AT-only board when Bluesky is linked, and says so', async () => {
        allowed = ['atproto', 'sshPubKey'];
        const menu = makeMenu({ did: 'did:plc:alice' });
        await remove(menu);
        assert.equal(menu.properties[UserProps.SSHPubKey], undefined);
        assert.match(menu.status, /log in with Bluesky/);
        assert.doesNotMatch(menu.status, /Password/);
    });

    it('refuses when it is the only way to log in', async () => {
        allowed = ['atproto', 'sshPubKey'];
        const menu = makeMenu();
        await remove(menu);
        assert.ok(menu.properties[UserProps.SSHPubKey]);
        assert.match(menu.status, /only way to log in; link Bluesky/);
    });

    it('does not suggest Bluesky where the board does not take it', async () => {
        allowed = ['sshPubKey'];
        const menu = makeMenu({ did: 'did:plc:alice' });
        await remove(menu);
        assert.ok(menu.properties[UserProps.SSHPubKey]);
        assert.equal(
            menu.status,
            'This key is your only way to log in, so it cannot be removed.'
        );
    });

    it('fits each message in the 70-column status line', async () => {
        const cases = [
            [['password', 'sshPubKey'], {}],
            [['atproto', 'sshPubKey'], { did: 'did:plc:alice' }],
            [['atproto', 'sshPubKey'], {}],
            [['sshPubKey'], {}],
        ];
        for (const [types, options] of cases) {
            allowed = types;
            const menu = makeMenu(options);
            await remove(menu);
            assert.ok(menu.status.length <= 70, menu.status);
        }
    });
});
