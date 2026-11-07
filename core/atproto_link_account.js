/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { ErrorReasons } = require('./enig_error.js');
const AtProtoLogin = require('./atproto/login.js');
const { gotoAccountStateMenu } = require('./atproto_login.js');
const { enterOrKick, logoff } = require('./system_menu_method.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'AT Protocol Link Account',
    desc: 'Link an AT Protocol (Bluesky) login to an existing user, or apply',
    author: 'zerosquaredio',
};

//
//  Reached from AT login (core/atproto_login.js, config.linkAccount) when the
//  caller has proven an AT identity that no user is linked to yet. A caller
//  who has a user here from before enters its name and password once to
//  link it, and is logged in; anyone else goes on to apply.
//
//  The menu's |next| works as for the AT login menu. config:
//  * newUserApplication: where applicants go (as for AT login)
//  * tooNodeMenu / inactive / disabled / locked / toomany /
//    loginTypeNotAllowed: menus for those account states; with no toomany
//    menu, too many wrong passwords disconnect, as for password login
//

const FormIds = {
    menu: 0,
};

//  TM2 asks whether the caller already has an account here: [yes, no]. Yes
//  moves on to the user name and password, and submitting the password
//  links; no applies. ESC cancels.
const MciViewIds = {
    identity: 1,
    choice: 2,
    username: 3,
    password: 4,
    status: 5,
};

const Messages = {
    linkInstructions:
        'Enter the user name and password of your account here. ' +
        'TAB goes back to the question.',
    badLogin: 'Wrong user name or password.',
    didTaken: 'Another user here is already linked to this Bluesky account.',
    twoFactor:
        'That account uses two-factor authentication. Log in with your password ' +
        'instead, then link your Bluesky account from your settings.',
    noNewUsers: 'This board is not accepting new users.',
    failed: 'That could not be done. Try again, or press ESC to go back.',
};

exports.getModule = class AtProtoLinkAccountModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            startLink: (formData, extraArgs, cb) => this.startLink(cb),
            link: (formData, extraArgs, cb) => this.link(formData, cb),
            apply: (formData, extraArgs, cb) => this.apply(cb),
            cancel: (formData, extraArgs, cb) => this.cancel(cb),
        };
    }

    initSequence() {
        this.identity = AtProtoLogin.getPendingIdentity(this.client);
        if (!this.identity) {
            this.client.log.warn('AT account link without a proven AT identity');
            return this.prevMenu(_.noop);
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

                this.validateMCIByViewIds(
                    'menu',
                    [
                        MciViewIds.choice,
                        MciViewIds.username,
                        MciViewIds.password,
                        MciViewIds.status,
                    ],
                    err => {
                        if (err) {
                            return cb(err);
                        }

                        const { did, handle } = this.identity;
                        const identityView = this.getView('menu', MciViewIds.identity);
                        if (identityView) {
                            identityView.setText(handle ? `@${handle}` : did);
                        }
                        return cb(null);
                    }
                );
            });
        });
    }

    showStatus(message) {
        const view = this.getView('menu', MciViewIds.status);
        if (view) {
            view.setText(message);
            this.repositionCursorToFocusedView('menu');
        }
    }

    clearPassword() {
        const view = this.getView('menu', MciViewIds.password);
        if (view) {
            view.setText('');
        }
    }

    startLink(cb) {
        //  Focus first: showStatus() puts the cursor back in the focused view
        this.viewControllers.menu.switchFocus(MciViewIds.username);
        this.showStatus(Messages.linkInstructions);
        return cb(null);
    }

    link(formData, cb) {
        const username = _.trim(_.get(formData, 'value.username', ''));
        const password = _.get(formData, 'value.password', '');
        if (!username || !password) {
            this.showStatus(Messages.linkInstructions);
            return cb(null);
        }

        AtProtoLogin.loginLinkingExistingUser(
            this.client,
            this.identity,
            username,
            password,
            err => {
                this.clearPassword();
                if (err) {
                    return this.linkFailed(err, cb);
                }
                AtProtoLogin.clearPendingIdentity(this.client);
                return enterOrKick(this, cb);
            }
        );
    }

    linkFailed(err, cb) {
        if (gotoAccountStateMenu(this, err)) {
            return cb(null);
        }
        if (ErrorReasons.TooMany === err.reasonCode) {
            return logoff(this, {}, {}, cb);
        }

        this.client.log.info({ error: err.message }, 'AT account link refused');
        this.showStatus(
            {
                [ErrorReasons.AlreadyThere]: Messages.didTaken,
                [ErrorReasons.TwoFactorEnabled]: Messages.twoFactor,
                [ErrorReasons.NotAllowed]: Messages.failed,
                [ErrorReasons.NotEnabled]: Messages.failed,
            }[err.reasonCode] || Messages.badLogin
        );
        return cb(null);
    }

    apply(cb) {
        AtProtoLogin.checkNewUserAllowed(this.client, this.identity.did, err => {
            if (err) {
                this.client.log.info({ error: err.message }, 'AT application refused');
                this.showStatus(
                    ErrorReasons.NotAllowed === err.reasonCode
                        ? Messages.noNewUsers
                        : Messages.failed
                );
                return cb(null);
            }

            const menu = _.get(this, 'menuConfig.config.newUserApplication');
            if (!menu) {
                this.client.log.warn(
                    'AT account link: no newUserApplication menu configured'
                );
                this.showStatus(Messages.noNewUsers);
                return cb(null);
            }
            this.client.log.info(
                { did: this.identity.did },
                'AT login: new user applying'
            );
            return this.gotoMenu(menu, cb);
        });
    }

    cancel(cb) {
        AtProtoLogin.clearPendingIdentity(this.client);
        return this.prevMenu(cb);
    }
};
