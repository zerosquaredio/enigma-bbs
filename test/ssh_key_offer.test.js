/* jslint node: true */
'use strict';

const { strict: assert } = require('assert');
const crypto = require('crypto');
const ssh2 = require('ssh2');

const configModule = require('../core/config.js');
const defaultConfig = require('../core/config_default.js')();

//  ssh.js binds Config at require time; see ssh_untrusted_term_size.test.js
const previousConfig = configModule._pushTestConfig(defaultConfig);
const { provenPublicKey } = require('../core/servers/login/ssh.js');
configModule._popTestConfig(previousConfig);

//  A key pair as ssh2 sees it, and an authentication attempt signed with it
const makeKey = (type, options) =>
    ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync(type, options).private);

const signedAttempt = (key, hashAlgo) => {
    const blob = crypto.randomBytes(64);
    return {
        method: 'publickey',
        key: { algo: key.type, data: key.getPublicSSH() },
        blob,
        signature: key.sign(blob, hashAlgo),
        hashAlgo,
    };
};

const openSsh = key => `${key.type} ${key.getPublicSSH().toString('base64')}`;

describe('SSH proven public keys', () => {
    const ed25519 = makeKey('ed25519');

    it('returns the OpenSSH form of a key whose signature verifies', () => {
        assert.equal(provenPublicKey(signedAttempt(ed25519)), openSsh(ed25519));
    });

    it('works for RSA keys signed with SHA-256', () => {
        const rsa = makeKey('rsa', { bits: 2048 });
        assert.equal(provenPublicKey(signedAttempt(rsa, 'sha256')), openSsh(rsa));
    });

    it('ignores a key query with no signature', () => {
        const ctx = signedAttempt(ed25519);
        delete ctx.signature;
        assert.equal(provenPublicKey(ctx), null);
    });

    it('ignores a signature made with another key', () => {
        const ctx = signedAttempt(ed25519);
        ctx.signature = makeKey('ed25519').sign(ctx.blob);
        assert.equal(provenPublicKey(ctx), null);
    });

    it('ignores other authentication methods', () => {
        assert.equal(provenPublicKey({ method: 'password', password: 'x' }), null);
    });
});

describe('SSH key offer', () => {
    let previousConfigGet;
    let testConfig;
    let keyToOffer;
    let ed25519Key;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;

        //  Fresh loads, so user.js captures the config above
        ['../core/user.js', '../core/ssh_key_offer.js'].forEach(
            m => delete require.cache[require.resolve(m)]
        );
        keyToOffer = require('../core/ssh_key_offer.js').keyToOffer;
        ed25519Key = openSsh(makeKey('ed25519'));
    });

    after(() => {
        configModule._popTestConfig(previousConfigGet);
    });

    beforeEach(() => {
        testConfig = {
            users: {
                allowedAuthFactor1Types: [
                    'password',
                    'sshPubKey',
                    'tlsClientAuth',
                    'atproto',
                ],
            },
        };
    });

    const client = ({ key = ed25519Key, stored, authenticated = true } = {}) => ({
        provenPublicKey: key,
        user: {
            isAuthenticated: () => authenticated,
            getProperty: () => stored,
        },
    });

    it('offers a proven key to a logged in user with none saved', () => {
        assert.equal(keyToOffer(client()), ed25519Key);
    });

    it('offers a different key to replace the saved one', () => {
        const other = openSsh(makeKey('ed25519'));
        assert.equal(keyToOffer(client({ stored: other })), ed25519Key);
    });

    it('offers nothing when the key is already saved, comment or not', () => {
        assert.equal(keyToOffer(client({ stored: `${ed25519Key} me@laptop` })), null);
    });

    it('offers nothing without a proven key', () => {
        assert.equal(keyToOffer(client({ key: null })), null);
    });

    it('offers nothing before the caller has logged in', () => {
        assert.equal(keyToOffer(client({ authenticated: false })), null);
    });

    it('offers nothing when SSH key logins are not accepted', () => {
        testConfig.users.allowedAuthFactor1Types = ['atproto'];
        assert.equal(keyToOffer(client()), null);
    });
});
