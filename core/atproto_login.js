/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { Errors, ErrorReasons } = require('./enig_error.js');
const Config = require('./config.js').get;
const AtProtoOAuth = require('./atproto/oauth_client.js');
const AtProtoLogin = require('./atproto/login.js');
const BrowserHandoff = require('./browser_handoff.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'AT Protocol Login',
    desc: 'Log in with an AT Protocol (Bluesky) account',
    author: 'zerosquaredio',
};

//
//  Asks for a handle, sends the caller to a browser to approve the login
//  at their account host (core/browser_handoff.js), waits, then logs them in
//  as the user bound to that identity (core/atproto/login.js).
//
//  The menu's |next| works as for the password login menu (e.g. on to 2FA),
//  and config.tooNodeMenu / inactive / disabled / locked name the menus for
//  those account states.
//

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    handle: 1,
    status: 2,
};

const DefaultHandoffTimeoutSeconds = 5 * 60;

const Messages = {
    instructions: 'Enter your handle, e.g. alice.bsky.social, then press ENTER.',
    notAvailable: 'AT Protocol login is not available right now.',
    resolving: 'Looking up {handle}...',
    notFound: 'Could not find that handle. Check it and try again.',
    openLink:
        'Open this link in a web browser to approve the login:\r\n\r\n  {url}\r\n\r\n' +
        'Waiting for approval. Press ESC to cancel.',
    wrongAccount:
        'That approval was for a different account than the handle you entered.',
    timedOut: 'The link expired before the login was approved. Try again.',
    cancelled: 'Cancelled.',
    notApproved: 'The login was not approved. Try again, or press ESC to go back.',
    refused: 'This board does not allow that AT login. ({reason})',
    failed: 'The login could not be completed. Try again, or press ESC to go back.',
};

exports.getModule = class AtProtoLoginModule extends MenuModule {
    constructor(options) {
        super(options);

        this.handoff = null;

        this.menuMethods = {
            startLogin: (formData, extraArgs, cb) => this.startLogin(formData, cb),
            cancel: (formData, extraArgs, cb) => this.cancel(cb),
        };
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
                    [MciViewIds.handle, MciViewIds.status],
                    err => {
                        if (err) {
                            return cb(err);
                        }

                        this.showStatus(
                            AtProtoOAuth.isReady()
                                ? Messages.instructions
                                : Messages.notAvailable
                        );
                        return cb(null);
                    }
                );
            });
        });
    }

    leave() {
        //  The caller hung up or moved on; stop waiting for the browser
        this.endHandoff();
        super.leave();
    }

    showStatus(message, values = {}) {
        const view = this.getView('menu', MciViewIds.status);
        if (view) {
            view.setText(
                message.replace(/\{(\w+)\}/g, (m, key) => _.get(values, key, m))
            );
        }
    }

    endHandoff() {
        if (this.handoff) {
            this.handoff.cancel();
            this.handoff = null;
        }
    }

    startLogin(formData, cb) {
        if (this.handoff) {
            return cb(null); //  already waiting on one
        }
        if (!AtProtoOAuth.isReady()) {
            this.showStatus(Messages.notAvailable);
            return cb(null);
        }

        const input = _.trim(_.get(formData, 'value.handle', '')).replace(/^@/, '');
        if (!input) {
            this.showStatus(Messages.instructions);
            return cb(null);
        }

        this.showStatus(Messages.resolving, { handle: input });

        AtProtoOAuth.resolveIdentity(input, (err, identity) => {
            if (err) {
                this.client.log.info(
                    { input, error: err.message },
                    'AT login: could not resolve handle'
                );
                this.showStatus(Messages.notFound);
                return cb(null);
            }

            const timeoutSeconds = _.get(
                Config(),
                'atProto.login.handoffTimeoutSeconds',
                DefaultHandoffTimeoutSeconds
            );

            BrowserHandoff.create(
                {
                    purpose: 'atproto-login',
                    timeoutSeconds,
                    //  The approval request is made when the link is opened,
                    //  as it expires within minutes. Authorizing the DID
                    //  pins the login to the account the caller named.
                    onOpen: (handoff, next) =>
                        AtProtoOAuth.authorize(identity.did, { state: handoff.id }, next),
                },
                (err, handoff) => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message },
                            'AT login: could not start browser handoff'
                        );
                        this.showStatus(Messages.failed);
                        return cb(null);
                    }

                    this.handoff = handoff;
                    this.showStatus(Messages.openLink, { url: handoff.url });

                    handoff.wait((err, result) => {
                        this.handoff = null;
                        return this.finishLogin(err, result, identity);
                    });

                    return cb(null);
                }
            );
        });
    }

    finishLogin(err, result, identity) {
        if (err) {
            if (Errors.UserInterrupt().code === err.code) {
                return this.showStatus(Messages.cancelled);
            }
            if (Errors.Timeout().code === err.code) {
                return this.showStatus(Messages.timedOut);
            }
            this.client.log.info({ error: err.message }, 'AT login: not approved');
            return this.showStatus(Messages.notApproved);
        }

        //  Whoever opens the link chooses the account that approves it, so
        //  only accept the account the caller asked for in the terminal
        if (_.get(result, 'did') !== identity.did) {
            this.client.log.warn(
                { expected: identity.did, approved: _.get(result, 'did') },
                'AT login: approved by a different account'
            );
            return this.showStatus(Messages.wrongAccount);
        }

        AtProtoLogin.loginWithDid(
            this.client,
            { did: identity.did, handle: identity.handle },
            err => {
                if (err) {
                    return this.loginFailed(err);
                }
                return require('./system_menu_method.js').enterOrKick(this, err => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message },
                            'AT login: could not continue after login'
                        );
                    }
                });
            }
        );
    }

    loginFailed(err) {
        //  Account states that have their own menus, as for password login
        const menuKey = {
            [ErrorReasons.AlreadyLoggedIn]: 'tooNodeMenu',
            [ErrorReasons.Disabled]: 'disabled',
            [ErrorReasons.Inactive]: 'inactive',
            [ErrorReasons.Locked]: 'locked',
            [ErrorReasons.LoginTypeNotAllowed]: 'loginTypeNotAllowed',
        }[err.reasonCode];
        const menu = menuKey && _.get(this, ['menuConfig', 'config', menuKey]);
        if (menu) {
            return this.gotoMenu(menu, () => {});
        }

        this.client.log.info({ error: err.message }, 'AT login refused');
        if (ErrorReasons.NotAllowed === err.reasonCode) {
            return this.showStatus(Messages.refused, { reason: err.reason });
        }
        return this.showStatus(Messages.failed);
    }

    cancel(cb) {
        if (this.handoff) {
            this.endHandoff();
            return cb(null);
        }
        return this.prevMenu(cb);
    }
};
