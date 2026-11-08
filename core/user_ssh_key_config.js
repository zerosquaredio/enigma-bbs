//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const UserProps = require('./user_property.js');
const User = require('./user.js');

//  deps
const ssh2 = require('ssh2');
const crypto = require('crypto');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'User SSH Key Configuration',
    desc: 'Module for managing SSH public key authentication',
    author: 'stlalpha/spaceman@themcbros.com',
};

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    infoText: 1,
    publicKey: 2,
    submit: 3,
    statusText: 4,
};

const Messages = {
    instructions: [
        'Paste a single-line OpenSSH public key and choose "save/update key".',
    ],
    //  The second instruction line, by the ways left to log in without a key
    removeInstructions: {
        password: 'Use "remove key" to return to password-only logins.',
        atProto: 'Use "remove key" to log in with Bluesky only.',
    },
    saved: 'SSH public key saved. Test an SSH login to confirm.',
    removedStillPassword:
        'SSH public key removed. Password authentication remains available.',
    removedStillAtProto: 'SSH public key removed. You can still log in with Bluesky.',
    //  The status line is 70 columns in the default theme
    lastWayIn: 'This key is your only way to log in, so it cannot be removed.',
    lastWayInLinkFirst:
        'This key is your only way to log in; link Bluesky before removing it.',
    missingKeyInput: 'A valid OpenSSH public key is required before saving.',
    noKeyToRemove: 'No SSH public key is currently stored for this account.',
    invalidKey: 'The provided SSH public key could not be parsed.',
};

exports.getModule = class UserSSHKeyConfigModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            saveKey: (formData, extraArgs, cb) => this.saveKey(formData, cb),
            removeKey: (formData, extraArgs, cb) => this.removeKey(cb),
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            this.prepViewController('menu', FormIds.menu, mciData.menu, prepErr => {
                if (prepErr) {
                    return cb(prepErr);
                }

                this.validateMCIByViewIds(
                    'menu',
                    [MciViewIds.publicKey, MciViewIds.submit],
                    err => {
                        if (err) {
                            return cb(err);
                        }

                        this.refreshInfoText();
                        this.showStatus('');

                        const submitView = this.getView('menu', MciViewIds.submit);
                        if (submitView) {
                            submitView.setFocusItemIndex(0);
                        }

                        const publicKeyView = this.getView('menu', MciViewIds.publicKey);
                        if (publicKeyView) {
                            publicKeyView.setFocus(true);
                        }

                        return cb(null);
                    }
                );
            });
        });
    }

    refreshInfoText() {
        const infoView = this.getView('menu', MciViewIds.infoText);
        if (!infoView) {
            return;
        }

        const storedKey = this.client.user.getProperty(UserProps.SSHPubKey);
        let infoLines = [...Messages.instructions];

        const otherWays = this.otherWaysToLogIn();
        if (otherWays.password) {
            infoLines.push(Messages.removeInstructions.password);
        } else if (otherWays.atProto) {
            infoLines.push(Messages.removeInstructions.atProto);
        }

        if (storedKey) {
            const details = this.formatKeyDetails(storedKey);
            infoLines = infoLines.concat(details);
        } else {
            infoLines.push('Current key: none on file.');
        }

        infoView.setText(infoLines.join('\r\n'));
    }

    showStatus(message) {
        const statusView = this.getView('menu', MciViewIds.statusText);
        if (statusView) {
            statusView.setText(message || '');
        }
    }

    clearPublicKeyInput() {
        const publicKeyView = this.getView('menu', MciViewIds.publicKey);
        if (publicKeyView) {
            publicKeyView.setText('');
            publicKeyView.setFocus(true);
        }
    }

    saveKey(formData, cb) {
        const publicKey = _.get(formData, 'value.publicKey', '');
        const trimmedKey = _.isString(publicKey) ? publicKey.trim() : '';

        if (!trimmedKey) {
            this.showStatus(Messages.missingKeyInput);
            return cb(null);
        }

        this.client.user.setPublicSSHKey(trimmedKey, err => {
            if (err) {
                this.client.log.warn({ error: err.message }, 'Failed saving SSH key');
                this.showStatus(Messages.invalidKey);
                return cb(null);
            }

            this.client.log.info('User updated SSH public key');
            this.clearPublicKeyInput();
            this.refreshInfoText();
            this.showStatus(Messages.saved);
            return cb(null);
        });
    }

    //
    //  How the user could still log in without their key, as the board is
    //  configured (users.allowedAuthFactor1Types): by password, or with
    //  their linked AT (Bluesky) account
    //
    otherWaysToLogIn() {
        const types = User.AuthFactor1Types;
        return {
            password: User.isAuthFactor1TypeAllowed(types.Password),
            atProto:
                User.isAuthFactor1TypeAllowed(types.AtProto) &&
                !!this.client.user.getProperty(UserProps.AtProtoDid),
        };
    }

    removeKey(cb) {
        const storedKey = this.client.user.getProperty(UserProps.SSHPubKey);
        if (!storedKey) {
            this.showStatus(Messages.noKeyToRemove);
            return cb(null);
        }

        //  Never leave a user with no way back in
        const otherWays = this.otherWaysToLogIn();
        if (!otherWays.password && !otherWays.atProto) {
            this.client.log.info('SSH key removal refused: no other way to log in');
            const canLink = User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.AtProto);
            this.showStatus(canLink ? Messages.lastWayInLinkFirst : Messages.lastWayIn);
            return cb(null);
        }

        this.client.user.setPublicSSHKey('', err => {
            if (err) {
                this.client.log.warn({ error: err.message }, 'Failed removing SSH key');
                this.showStatus(Messages.invalidKey);
                return cb(null);
            }

            this.client.log.info('User removed SSH public key');
            this.refreshInfoText();
            this.showStatus(
                otherWays.password
                    ? Messages.removedStillPassword
                    : Messages.removedStillAtProto
            );
            return cb(null);
        });
    }

    formatKeyDetails(key) {
        const parts = key.split(/\s+/);
        const algo = parts[0] || 'unknown';
        const comment = parts.length > 2 ? parts.slice(2).join(' ') : '';

        const parsed = ssh2.utils.parseKey(key);
        const keyObject = Array.isArray(parsed) ? parsed[0] : parsed;
        let fingerprint = 'unavailable';

        if (
            keyObject &&
            !(keyObject instanceof Error) &&
            _.isFunction(keyObject.getPublicSSH)
        ) {
            fingerprint = crypto
                .createHash('sha256')
                .update(keyObject.getPublicSSH())
                .digest('base64');
        }

        const details = [`Current key: ${algo} (SHA256:${fingerprint})`];
        if (comment) {
            details.push(`Comment: ${comment}`);
        }

        return details;
    }
};
