/* jslint node: true */
'use strict';

//  ENiGMA½
const AtProtoLoginModule = require('./atproto_login.js').getModule;
const AtProtoLogin = require('./atproto/login.js');
const { ErrorReasons } = require('./enig_error.js');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'AT Protocol Account Config',
    desc: 'Link or unlink an AT Protocol (Bluesky) account',
    author: 'zerosquaredio',
};

//
//  For a logged in user: link an AT (Bluesky) account, so either login
//  works, or unlink it. Linking proves the account in a browser, as AT
//  login does (this module extends it). Unlinking needs the user's password,
//  or a saved SSH key, so they keep a way to log in.
//
//  Views as for AT login (ET1 handle, MT2 status), plus ET3 password (for
//  unlinking) and HM4 [link, unlink, cancel].
//

const MciViewIds = {
    password: 3,
};

const Messages = {
    linked: 'Linked to {account}.',
    notLinked: 'No Bluesky account is linked.',
    instructions:
        'To link one, enter its handle, e.g. alice.bsky.social, then press ENTER.',
    unlinkHint: 'To unlink it, enter your password and choose unlink.',
    nowLinked: 'Done. You can now log in with Bluesky as {account}.',
    didTaken: 'Another user here is already linked to that Bluesky account.',
    unlinked: 'Unlinked. Log in with your password or SSH key from now on.',
    nothingToUnlink: 'No Bluesky account is linked.',
    wrongPassword: 'Wrong password.',
    wouldLockOut:
        'Unlinking would leave you no way to log in. Enter your password, or ' +
        'set one (or an SSH key) first.',
    failed: 'That could not be done. Try again, or press ESC to go back.',
};

exports.getModule = class AtProtoAccountConfigModule extends AtProtoLoginModule {
    constructor(options) {
        super(options);

        this.menuMethods.unlink = (formData, extraArgs, cb) => this.unlink(formData, cb);
    }

    linkedAccount() {
        const user = this.client.user;
        const did = user.getProperty(UserProps.AtProtoDid);
        if (!did) {
            return null;
        }
        const handle = user.getProperty(UserProps.AtProtoHandle);
        return handle ? `@${handle}` : did;
    }

    showInitialStatus() {
        const account = this.linkedAccount();
        const lines = [
            account ? Messages.linked.replace('{account}', account) : Messages.notLinked,
            '',
            this.unavailableMessage() || Messages.instructions,
        ];
        if (account) {
            lines.push(Messages.unlinkHint);
        }
        this.showStatus(lines.join('\r\n'));
    }

    identityProven(identity) {
        AtProtoLogin.linkDidToUser(this.client, identity, err => {
            if (err) {
                this.client.log.info({ error: err.message }, 'AT account link refused');
                return this.showStatus(
                    ErrorReasons.AlreadyThere === err.reasonCode
                        ? Messages.didTaken
                        : Messages.failed
                );
            }
            return this.showStatus(Messages.nowLinked, { account: this.linkedAccount() });
        });
    }

    unlink(formData, cb) {
        const password = _.get(formData, 'value.password', '');
        AtProtoLogin.unlinkDidFromUser(this.client, password, err => {
            const passwordView = this.getView('menu', MciViewIds.password);
            if (passwordView) {
                passwordView.setText('');
            }

            if (err) {
                this.client.log.info({ error: err.message }, 'AT account unlink refused');
                this.showStatus(
                    {
                        [ErrorReasons.DoesNotExist]: Messages.nothingToUnlink,
                        [ErrorReasons.NotAllowed]: Messages.wouldLockOut,
                        [ErrorReasons.ValueInvalid]: Messages.wrongPassword,
                    }[err.reasonCode] || Messages.failed
                );
                return cb(null);
            }

            this.showStatus(Messages.unlinked);
            return cb(null);
        });
    }
};
