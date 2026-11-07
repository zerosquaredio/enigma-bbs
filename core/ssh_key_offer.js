/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const User = require('./user.js');
const UserProps = require('./user_property.js');

//  deps
const ssh2 = require('ssh2');
const crypto = require('crypto');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'SSH Key Offer',
    desc: 'Offer to save the SSH key a caller connected with',
    author: 'zerosquaredio',
};

//
//  A caller who connects over SSH as a new user name (e.g. "new") and then
//  logs in another way, such as with Bluesky, may have proven an SSH key on
//  the way in (core/servers/login/ssh.js). Offer to save it, so they can
//  connect as themselves with that key next time.
//
//  Goes straight on to |next| when there is nothing to offer: no proven
//  key, the key is already saved, or SSH key logins are not accepted
//  (users.allowedAuthFactor1Types). Offered once per connection.
//

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    key: 1,
    username: 2,
    answer: 3,
    status: 4,
};

const Messages = {
    replaces: 'This replaces the SSH key saved for you now.',
    failed: 'The key could not be saved.',
};

//  "<type> <base64>" of an OpenSSH key line, for comparing keys
const keyIdentity = key => (key || '').trim().split(/\s+/).slice(0, 2).join(' ');

//  The key to offer |client|'s user, or null
function keyToOffer(client) {
    const key = client.provenPublicKey;
    if (!key || !client.user || !client.user.isAuthenticated()) {
        return null;
    }
    if (!User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.SSHPubKey)) {
        return null;
    }
    if (keyIdentity(client.user.getProperty(UserProps.SSHPubKey)) === keyIdentity(key)) {
        return null;
    }
    return key;
}

exports.keyToOffer = keyToOffer;

function keyDescription(key) {
    const parsed = ssh2.utils.parseKey(key);
    const keyObject = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!keyObject || keyObject instanceof Error) {
        return key.split(/\s+/)[0];
    }
    const fingerprint = crypto
        .createHash('sha256')
        .update(keyObject.getPublicSSH())
        .digest('base64')
        .replace(/=+$/, '');
    return `${keyObject.type} SHA256:${fingerprint}`;
}

exports.getModule = class SSHKeyOfferModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            saveKey: (formData, extraArgs, cb) => this.saveKey(cb),
            skip: (formData, extraArgs, cb) => this.skip(cb),
        };
    }

    initSequence() {
        this.key = keyToOffer(this.client);

        //  Whatever the answer, don't ask again on this connection
        delete this.client.provenPublicKey;

        if (!this.key) {
            return this.nextMenu(_.noop);
        }
        return super.initSequence();
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            this.prepViewController('menu', FormIds.menu, mciData.menu, err => {
                if (err) {
                    return cb(err);
                }

                this.setViewText('menu', MciViewIds.key, keyDescription(this.key));
                this.setViewText('menu', MciViewIds.username, this.client.user.username);
                if (this.client.user.getProperty(UserProps.SSHPubKey)) {
                    this.setViewText('menu', MciViewIds.status, Messages.replaces);
                }
                return cb(null);
            });
        });
    }

    saveKey(cb) {
        this.client.user.setPublicSSHKey(this.key, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Failed saving offered SSH key'
                );
                this.setViewText('menu', MciViewIds.status, Messages.failed);
                return cb(null);
            }

            this.client.log.info('User saved the SSH key they connected with');
            return this.nextMenu(cb);
        });
    }

    skip(cb) {
        return this.nextMenu(cb);
    }
};
