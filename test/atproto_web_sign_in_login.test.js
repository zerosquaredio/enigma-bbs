'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const defaultConfig = require('../core/config_default.js')();

//
//  The connection side of web sign-in: which menu a WebSocket caller starts
//  at, and the menu that logs a signed-in caller in. The sign-in itself is
//  in atproto_web_sign_in.test.js.
//

describe('AT web sign-in: logging in', () => {
    describe('WebSocket first menu', () => {
        let WebSocketClient;
        let previousConfig;

        before(() => {
            //  websocket.js and telnet.js bind Config at require time
            previousConfig = configModule._pushTestConfig(defaultConfig);
            [
                '../core/servers/login/telnet.js',
                '../core/servers/login/websocket.js',
            ].forEach(m => delete require.cache[require.resolve(m)]);
            WebSocketClient =
                require('../core/servers/login/websocket.js').WebSocketClient;
        });

        after(() => {
            configModule._popTestConfig(previousConfig);
        });

        //  A client as far as _clientReady() cares, recording 'ready'
        const makeClient = fields => {
            const client = Object.create(WebSocketClient.prototype);
            client.readies = [];
            client.emit = (event, options) => client.readies.push([event, options]);
            return Object.assign(client, fields);
        };

        it('is the telnet one for a caller who is not signed in', () => {
            const client = makeClient({
                webSignInPending: false,
                webSignInIdentity: null,
            });
            client._clientReady();
            assert.deepEqual(client.readies, [
                ['ready', { firstMenu: 'telnetConnected' }],
            ]);
        });

        it('is the signed-in one for a caller signed in on the web', () => {
            const client = makeClient({
                webSignInPending: false,
                webSignInIdentity: { did: 'did:plc:alice' },
            });
            client._clientReady();
            client._clientReady(); //  once only
            assert.deepEqual(client.readies, [
                ['ready', { firstMenu: 'webSignInConnected' }],
            ]);
        });

        it('waits for the cookie check to finish', () => {
            const client = makeClient({ webSignInPending: true });
            client._clientReady();
            assert.deepEqual(client.readies, []);
            assert.equal(client.webSignInReadyWaiting, true);
        });
    });

    describe('web sign-in menu', () => {
        let Module;
        let previousConfig;
        let testConfig;

        before(() => {
            testConfig = { atProto: { login: { secureConnectionsOnly: true } } };
            previousConfig = configModule._pushTestConfig(testConfig);
            configModule.get = () => testConfig;
            delete require.cache[require.resolve('../core/atproto_web_sign_in.js')];
            Module = require('../core/atproto_web_sign_in.js').getModule;
        });

        after(() => {
            configModule._popTestConfig(previousConfig);
        });

        const quietLog = { info() {}, warn() {}, debug() {} };

        //  The module with a fake client, recording the menus it goes to
        const makeMenu = ({ identity, isSecure = true, config = {} } = {}) => {
            const menu = Object.create(Module.prototype);
            menu.client = {
                log: quietLog,
                session: { isSecure },
                webSignInIdentity: identity,
            };
            menu.menuConfig = { config: Object.assign({ fallback: 'matrix' }, config) };
            menu.wentTo = [];
            menu.gotoMenu = (name, cb) => {
                menu.wentTo.push(name);
                return cb && cb(null);
            };
            return menu;
        };

        it('falls back to the login matrix without a signed-in identity', () => {
            const menu = makeMenu();
            menu.initSequence();
            assert.deepEqual(menu.wentTo, ['matrix']);
        });

        it('uses the identity once', () => {
            const menu = makeMenu({
                identity: { did: 'did:plc:alice' },
                isSecure: false,
            });
            menu.initSequence();
            assert.equal(menu.client.webSignInIdentity, null);
        });

        it('falls back on an insecure connection when AT login needs a secure one', () => {
            const menu = makeMenu({
                identity: { did: 'did:plc:alice' },
                isSecure: false,
            });
            menu.initSequence();
            assert.deepEqual(menu.wentTo, ['matrix']);
        });

        it('never moves on by itself, only once the login is done', () => {
            const menu = makeMenu();
            menu.autoNextMenu(() => assert.fail('moved on'));
            assert.deepEqual(menu.wentTo, []);
        });

        it('falls back when the login is refused', () => {
            const menu = makeMenu();
            menu.loginFailed(new Error('refused'));
            assert.deepEqual(menu.wentTo, ['matrix']);
        });

        it('goes to the menu for an account state, as AT login does', () => {
            const { ErrorReasons, Errors } = require('../core/enig_error.js');
            const menu = makeMenu({
                config: { disabled: 'loginAttemptAccountDisabled' },
            });
            menu.loginFailed(Errors.AccessDenied('disabled', ErrorReasons.Disabled));
            assert.deepEqual(menu.wentTo, ['loginAttemptAccountDisabled']);
        });

        it('falls back for an unknown account when there is nowhere to link or apply', () => {
            const menu = makeMenu();
            menu.noUserForIdentity({ did: 'did:plc:nobody' });
            assert.deepEqual(menu.wentTo, ['matrix']);
        });
    });
});
