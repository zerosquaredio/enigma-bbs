/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const User = require('./user.js');
const theme = require('./theme.js');
const { login, enterOrKick } = require('./system_menu_method.js');
const Config = require('./config.js').get;
const messageArea = require('./message_area.js');
const { getISOTimestampString } = require('./database.js');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');
const moment = require('moment');

exports.moduleInfo = {
    name: 'NUA',
    desc: 'New User Application',
};

const MciViewIds = {
    userName: 1,
    password: 9,
    confirm: 10,
    errMsg: 11,
    atProtoIdentity: 13, //  AT application only: whose account this is
};

//  Loaded when needed, so password-only boards never touch it
const AtProtoLogin = () => require('./atproto/login.js');

exports.getModule = class NewUserAppModule extends MenuModule {
    constructor(options) {
        super(options);

        const self = this;

        this.menuMethods = {
            //
            //  Validation stuff
            //
            validatePassConfirmMatch: function (data, cb) {
                const passwordView = self.viewControllers.menu.getView(
                    MciViewIds.password
                );
                return cb(
                    passwordView.getData() === data
                        ? null
                        : new Error('Passwords do not match')
                );
            },

            viewValidationListener: function (err, cb) {
                const errMsgView = self.viewControllers.menu.getView(MciViewIds.errMsg);

                let newFocusId;
                if (err) {
                    errMsgView.setText(err.friendlyText);
                    err.view.clearText();

                    if (err.view.getId() === MciViewIds.confirm) {
                        newFocusId = MciViewIds.password;
                        self.viewControllers.menu
                            .getView(MciViewIds.password)
                            .clearText();
                    }
                } else {
                    errMsgView.clearText();
                }

                return cb(err, newFocusId);
            },

            //
            //  Submit handlers
            //
            submitApplication: function (formData, extraArgs, cb) {
                const newUser = new User();
                const config = Config();

                newUser.username = formData.value.username;

                //
                //  We have to disable ACS checks for initial default areas as the user is not yet ready
                //
                let confTag = messageArea.getDefaultMessageConferenceTag(
                    self.client,
                    true
                ); //  true=disableAcsCheck
                let areaTag = messageArea.getDefaultMessageAreaTagByConfTag(
                    self.client,
                    confTag,
                    true
                ); //  true=disableAcsCheck

                //  can't store undefined!
                confTag = confTag || '';
                areaTag = areaTag || '';

                newUser.properties = {
                    [UserProps.RealName]: formData.value.realName || '',
                    [UserProps.Birthdate]: getISOTimestampString(
                        formData.value.birthdate || moment()
                    ),
                    [UserProps.Sex]: formData.value.sex || '',
                    [UserProps.Location]: formData.value.location || '',
                    [UserProps.Affiliations]: formData.value.affils || '',
                    [UserProps.EmailAddress]: formData.value.email || '',
                    [UserProps.WebAddress]: formData.value.web || '',
                    [UserProps.AccountCreated]: getISOTimestampString(),

                    //  New users get a newscan floor at their join date so they
                    //  don't see years of backlog on a busy BBS.
                    [UserProps.NewScanMinTimestamp]: getISOTimestampString(),

                    [UserProps.MessageConfTag]: confTag,
                    [UserProps.MessageAreaTag]: areaTag,

                    [UserProps.TermHeight]: self.client.term.termHeight,
                    [UserProps.TermWidth]: self.client.term.termWidth,

                    //  :TODO: Other defaults
                    //  :TODO: should probably have a place to create defaults/etc.
                };

                const defaultTheme = _.get(config, 'theme.default');
                if ('*' === defaultTheme) {
                    newUser.properties[UserProps.ThemeId] = theme.getRandomTheme();
                } else {
                    newUser.properties[UserProps.ThemeId] = defaultTheme;
                }

                //  An applicant who proved an AT identity gets no password of
                //  their own; the user is bound to the DID instead
                const createUser = cb => {
                    if (self.atProtoIdentity) {
                        return AtProtoLogin().createUserForDid(
                            self.client,
                            self.atProtoIdentity,
                            newUser,
                            cb
                        );
                    }

                    //  :TODO: User.create() should validate email uniqueness!
                    const createUserInfo = {
                        password: formData.value.password,
                        sessionId: self.client.session.uniqueId, //  used for events/etc.
                    };
                    return newUser.create(createUserInfo, cb);
                };

                createUser(err => {
                    if (err) {
                        self.client.log.warn(
                            { error: err, username: formData.value.username },
                            'New user creation failed'
                        );

                        self.gotoMenu(extraArgs.error, err => {
                            if (err) {
                                return self.prevMenu(cb);
                            }
                            return cb(null);
                        });
                    } else {
                        self.client.log.info(
                            { username: formData.value.username, userId: newUser.userId },
                            `New user "${formData.value.username}" created`
                        );

                        //  Cache SysOp information now
                        //  :TODO: Similar to bbs.js. DRY
                        if (newUser.isSysOp()) {
                            config.general.sysOp = {
                                username: formData.value.username,
                                properties: newUser.properties,
                            };
                        }

                        if (self.atProtoIdentity) {
                            return self.loginAtProtoApplicant(newUser, extraArgs, cb);
                        }

                        if (
                            User.AccountStatus.inactive ===
                            self.client.user.properties[UserProps.AccountStatus]
                        ) {
                            return self.gotoMenu(extraArgs.inactive, cb);
                        } else {
                            //
                            //  If active now, we need to call login() to authenticate
                            //
                            return login(self, formData, extraArgs, cb);
                        }
                    }
                });
            },
        };
    }

    initSequence() {
        const config = _.get(this, 'menuConfig.config', {});

        //  Applying after an AT (Bluesky) login: no password, bound to the
        //  DID the caller just proved (see core/atproto_login.js)
        if (config.atProto) {
            this.atProtoIdentity = AtProtoLogin().getPendingIdentity(this.client);
            if (!this.atProtoIdentity) {
                this.client.log.warn('AT application without a proven AT identity');
                return this.prevMenu(_.noop);
            }
            return super.initSequence();
        }

        //  Otherwise new users get a password, so there is no applying this
        //  way on a board that does not accept password logins
        //  (users.allowedAuthFactor1Types). Send them to AT login, if the
        //  board takes it, to prove their account before applying.
        if (!User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.Password)) {
            this.client.log.info(
                'Password application refused: password logins not allowed'
            );
            const menu =
                (User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.AtProto) &&
                    config.atProtoLogin) ||
                config.loginTypeNotAllowed;
            return menu ? this.gotoMenu(menu, _.noop) : this.prevMenu(_.noop);
        }
        return super.initSequence();
    }

    mciReady(mciData, cb) {
        this.standardMCIReadyHandler(mciData, err => {
            if (err) {
                return cb(err);
            }

            if (this.atProtoIdentity) {
                return this.validateMCIByViewIds(
                    'menu',
                    [MciViewIds.userName, MciViewIds.errMsg],
                    err => {
                        if (err) {
                            return cb(err);
                        }
                        return this.prefillAtProtoApplication(cb);
                    }
                );
            }

            return this.validateMCIByViewIds(
                'menu',
                [
                    MciViewIds.userName,
                    MciViewIds.password,
                    MciViewIds.confirm,
                    MciViewIds.errMsg,
                ],
                cb
            );
        });
    }

    //  Show whose account this is, and suggest a username from the handle
    prefillAtProtoApplication(cb) {
        const { did, handle } = this.atProtoIdentity;
        const identityView = this.viewControllers.menu.getView(
            MciViewIds.atProtoIdentity
        );
        if (identityView) {
            identityView.setText(handle ? `@${handle}` : did);
        }

        AtProtoLogin().deriveUsername(handle, (err, username) => {
            if (!err) {
                const view = this.viewControllers.menu.getView(MciViewIds.userName);
                if (view) {
                    view.setText(username);
                }
            }
            //  Drawing leaves the terminal cursor at the end of the last
            //  field drawn; put it back after the username
            this.repositionCursorToFocusedView('menu');
            return cb(null);
        });
    }

    loginAtProtoApplicant(newUser, extraArgs, cb) {
        const identity = this.atProtoIdentity;
        AtProtoLogin().clearPendingIdentity(this.client);

        if (User.AccountStatus.inactive === newUser.properties[UserProps.AccountStatus]) {
            return this.gotoMenu(extraArgs.inactive, cb);
        }

        AtProtoLogin().loginWithDid(this.client, identity, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Login after AT application failed'
                );
                return this.gotoMenu(extraArgs.error, err => {
                    return err ? this.prevMenu(cb) : cb(null);
                });
            }
            return enterOrKick(this, cb);
        });
    }
};
