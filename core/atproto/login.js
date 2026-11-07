/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const { Errors, ErrorReasons } = require('../enig_error');
const User = require('../user');
const UserProps = require('../user_property');
const { validateUserNameAvail } = require('../system_view_validate');
const AtProtoOAuth = require('./oauth_client');

//  deps
const async = require('async');
const crypto = require('crypto');
const _ = require('lodash');

//
//  Log a terminal session in as the local user bound to an AT Protocol
//  identity, and create that user from the new user application.
//
//  |identity.did| must already be proven by an AT OAuth login (see
//  oauth_client.js handleCallback()); nothing here checks it again with the
//  account host. Users are found by DID only, never by handle: handles can
//  change hands, DIDs can't.
//
//  A first AT login does not create a user by itself: the login screen
//  checks checkNewUserAllowed(), keeps the proven identity on the session
//  (setPendingIdentity()), and sends the caller to the new user
//  application, which calls createUserForDid() on submit.
//
//  An existing user can be linked to an AT identity instead: right after an
//  AT login finds no user, by logging in with their password once
//  (loginLinkingExistingUser()), or from their settings when logged in
//  (linkDidToUser()). One DID is linked to one user at most.
//

exports.loginWithDid = loginWithDid;
exports.findUserIdByDid = findUserIdByDid;
exports.checkNewUserAllowed = checkNewUserAllowed;
exports.createUserForDid = createUserForDid;
exports.loginLinkingExistingUser = loginLinkingExistingUser;
exports.linkDidToUser = linkDidToUser;
exports.unlinkDidFromUser = unlinkDidFromUser;
exports.setDidForUser = setDidForUser;
exports.setPendingIdentity = setPendingIdentity;
exports.getPendingIdentity = getPendingIdentity;
exports.clearPendingIdentity = clearPendingIdentity;
exports.deriveUsername = deriveUsername;
exports.usernameCandidates = usernameCandidates;

//  For tests: substitute the final login step
exports._setUserLogin = fn => {
    userLogin = fn;
};

let userLogin = (...args) => require('../user_login').userLogin(...args);

//  Numbered alternatives tried when the name from a handle is taken
const MaxNumberedCandidates = 98;

//  How long an approved identity may wait on the application form
const PendingIdentityMaxAgeMs = 30 * 60 * 1000;

function loginSettings() {
    return Object.assign(
        { allowNewUsers: true, secureConnectionsOnly: true, rootDid: '' },
        _.get(Config(), 'atProto.login')
    );
}

//  Refusals common to logging in and applying
function checkCanUse(client, did) {
    if (!AtProtoOAuth.isEnabled()) {
        return Errors.AccessDenied(
            'AT Protocol login is not enabled',
            ErrorReasons.NotEnabled
        );
    }
    if (!User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.AtProto)) {
        return Errors.AccessDenied(
            'AT Protocol login is not an allowed login type',
            ErrorReasons.LoginTypeNotAllowed
        );
    }
    if (!_.isString(did) || !did.startsWith('did:')) {
        return Errors.Invalid('A DID is required');
    }
    if (
        loginSettings().secureConnectionsOnly &&
        true !== _.get(client, 'session.isSecure')
    ) {
        return Errors.AccessDenied(
            'AT Protocol login needs a secure connection',
            ErrorReasons.NotAllowed
        );
    }
    return null;
}

//
//  |identity| is { did, handle }; |handle| is the verified handle, or null.
//  Calls back as userLogin() does: on success |client.user| is logged in
//  (or awaiting 2FA, if the user has it on). With no user bound to the DID,
//  calls back with ErrorReasons.DoesNotExist: the caller may apply.
//
function loginWithDid(client, identity, cb) {
    const did = _.get(identity, 'did');
    const handle = _.get(identity, 'handle') || null;

    const refused = checkCanUse(client, did);
    if (refused) {
        return cb(refused);
    }

    async.waterfall(
        [
            callback => {
                return findUserIdByDid(did, callback);
            },
            (userId, callback) => {
                if (!userId) {
                    return callback(
                        Errors.DoesNotExist(
                            'No user is linked to this AT identity',
                            ErrorReasons.DoesNotExist
                        )
                    );
                }
                return User.getUserName(userId, callback);
            },
            (username, callback) => {
                return userLogin(
                    client,
                    username,
                    null,
                    { authType: User.AuthFactor1Types.AtProto, did },
                    callback
                );
            },
        ],
        err => {
            if (err) {
                return cb(err);
            }

            //  Remember the handle for display; it plays no part in lookup
            if (handle && handle !== client.user.getProperty(UserProps.AtProtoHandle)) {
                client.user.persistProperty(UserProps.AtProtoHandle, handle, err => {
                    if (err) {
                        client.log.warn(
                            { error: err.message },
                            'Failed to record AT handle'
                        );
                    }
                });
            }
            return cb(null);
        }
    );
}

//  Calls back with the user ID bound to |did|, or null if there is none
function findUserIdByDid(did, cb) {
    User.getUserIdsWithProperty(UserProps.AtProtoDid, did, (err, userIds) => {
        if (err) {
            return cb(err);
        }
        if (userIds.length > 1) {
            //  Should never happen; refuse rather than pick one
            return cb(Errors.UnexpectedState(`More than one user is bound to ${did}`));
        }
        return cb(null, userIds[0] || null);
    });
}

//
//  May |did| apply for a new user? Checked before the application is shown,
//  so nobody fills in a form that can't succeed, and again on submit.
//  Whether they are admitted, and how, is up to atProto.admission
//  (core/atproto/admission/). Calls back with (err, info):
//  * info.firstUser: they would be the first user (root), as rootDid
//  * info.takesInviteCodes: the application should ask for an invite code
//
function checkNewUserAllowed(client, did, cb) {
    const refused = checkCanUse(client, did);
    if (refused) {
        return cb(refused);
    }

    const settings = loginSettings();

    async.waterfall(
        [
            callback => {
                return findUserIdByDid(did, callback);
            },
            (userId, callback) => {
                if (userId) {
                    return callback(
                        Errors.AccessDenied(
                            'A user is already linked to this AT identity',
                            ErrorReasons.AlreadyThere
                        )
                    );
                }
                return User.getUserCount(callback);
            },
            (userCount, callback) => {
                //  The first user is root and a sysop, so a fresh board must
                //  not hand that to whoever applies first. rootDid is let in
                //  whatever the admission policy says.
                if (0 === userCount) {
                    if (did !== settings.rootDid) {
                        return callback(
                            Errors.AccessDenied(
                                'Only atProto.login.rootDid may become the first user',
                                ErrorReasons.NotAllowed
                            )
                        );
                    }
                    return callback(null, { firstUser: true, takesInviteCodes: false });
                }

                Admission().canApply({ did }, (err, result) => {
                    if (err) {
                        return callback(err);
                    }
                    if (!result.canApply) {
                        return callback(notAdmittedError());
                    }
                    return callback(null, {
                        firstUser: false,
                        takesInviteCodes: result.takesInviteCodes,
                    });
                });
            },
        ],
        (err, info) => cb(err || null, info)
    );
}

//  Loaded when needed, so boards without AT login never touch it
const Admission = () => require('./admission');

function notAdmittedError() {
    const inviteOnly = Admission()
        .policy()
        .some(id => true === Admission().getVerifier(id).invitationOnly);
    return Errors.AccessDenied(
        inviteOnly
            ? 'This board is invitation only'
            : 'This board is not accepting new users',
        ErrorReasons.NotAllowed
    );
}

//
//  Create |newUser| (a User with its username and application properties
//  set, not yet saved) bound to |identity|, if admitted: with the groups
//  and account status the admission policy decides. |options.inviteCode| is
//  a code the applicant entered, if any. A code that is no use is refused
//  with ErrorReasons.ValueInvalid.
//
function createUserForDid(client, identity, newUser, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }
    const { did, handle } = identity;
    const inviteCode = _.trim(_.get(options, 'inviteCode', '')) || undefined;

    async.waterfall(
        [
            callback => checkNewUserAllowed(client, did, callback),
            (info, callback) => {
                if (info.firstUser) {
                    //  root: User.create() makes them active and a sysop
                    return callback(null, { verifier: 'root', use: () => true });
                }
                Admission().admit({ did, handle, inviteCode }, (err, decision) => {
                    if (err) {
                        return callback(err);
                    }
                    if (!decision) {
                        return callback(
                            inviteCode && info.takesInviteCodes
                                ? Errors.AccessDenied(
                                      'That invite code cannot be used',
                                      ErrorReasons.ValueInvalid
                                  )
                                : notAdmittedError()
                        );
                    }
                    return callback(null, decision);
                });
            },
            (decision, callback) => {
                //  Take the invite (or a use of the code) before creating the
                //  user, so two applicants can't both have the last one
                let taken;
                try {
                    taken = decision.use();
                } catch (err) {
                    return callback(err);
                }
                if (!taken) {
                    return callback(
                        Errors.AccessDenied(
                            'That invite was used up a moment ago',
                            ErrorReasons.ValueInvalid
                        )
                    );
                }

                newUser.properties[UserProps.AtProtoDid] = did;
                if (handle) {
                    newUser.properties[UserProps.AtProtoHandle] = handle;
                }

                //  ENiGMA½ always stores a password. Nobody knows this one, so
                //  password login stays closed unless the user sets their own.
                const createUserInfo = {
                    password: crypto.randomBytes(32).toString('hex'),
                    sessionId: _.get(client, 'session.uniqueId'),
                    groups: decision.groups,
                    accountStatus: decision.accountStatus,
                };

                newUser.create(createUserInfo, err => {
                    if (err) {
                        (decision.undo || _.noop)();
                        return callback(err);
                    }
                    (decision.used || _.noop)(newUser.userId);

                    client.log.info(
                        {
                            username: newUser.username,
                            userId: newUser.userId,
                            did,
                            admittedBy: decision.verifier,
                            ref: decision.ref,
                        },
                        `New user "${newUser.username}" created by AT login`
                    );
                    return callback(null);
                });
            },
        ],
        err => cb(err || null)
    );
}

//
//  Log in as the existing user |username|, proven by |password|, and link
//  |identity| (just proven, with no user yet) to them. For callers who have
//  an account here from before AT login. Counts a wrong password as a failed
//  login. A DID the user had before is replaced. Calls back as loginWithDid()
//  does, or with:
//  * ErrorReasons.AlreadyThere: another user is already linked to this DID
//  * ErrorReasons.TwoFactorEnabled: the user has 2FA; they must link from
//    their settings after logging in (a password alone can't link them)
//
function loginLinkingExistingUser(client, identity, username, password, cb) {
    const did = _.get(identity, 'did');
    const handle = _.get(identity, 'handle') || null;

    const refused = checkCanUse(client, did);
    if (refused) {
        return cb(refused);
    }

    async.series(
        [
            callback => checkDidUnlinked(did, null, callback),
            callback => {
                return userLogin(
                    client,
                    username,
                    password,
                    {
                        authType: User.AuthFactor1Types.AtProto,
                        did,
                        linkWithPassword: true,
                    },
                    callback
                );
            },
            //  Again, in case another session linked it meanwhile
            callback => checkDidUnlinked(did, client.user.userId, callback),
            callback => setDidForUser(client.user, { did, handle }, callback),
        ],
        err => {
            if (err) {
                return cb(err);
            }
            client.log.info(
                { userId: client.user.userId, did },
                'AT identity linked to existing user at login'
            );
            return cb(null);
        }
    );
}

//
//  Link |identity| (just proven) to the logged in user, replacing any DID
//  they had. Refused with ErrorReasons.AlreadyThere if another user has it.
//
function linkDidToUser(client, identity, cb) {
    const did = _.get(identity, 'did');
    const refused = checkCanUse(client, did);
    if (refused) {
        return cb(refused);
    }
    if (!client.user.isAuthenticated()) {
        return cb(Errors.AccessDenied('Not logged in'));
    }

    checkDidUnlinked(did, client.user.userId, err => {
        if (err) {
            return cb(err);
        }
        setDidForUser(client.user, identity, err => {
            if (err) {
                return cb(err);
            }
            client.log.info({ did }, 'User linked their AT identity');
            return cb(null);
        });
    });
}

//
//  Unlink the logged in user's AT identity, but only if they keep a way to
//  log in: their password (|password| must be right, and password logins
//  allowed) or a saved SSH key (with SSH key logins allowed). Users created
//  by AT login have a password nobody knows, so they set one, or an SSH
//  key, first. Refused with ErrorReasons.NotAllowed if no way would be left,
//  or ErrorReasons.ValueInvalid if |password| is given and wrong.
//
function unlinkDidFromUser(client, password, cb) {
    const user = client.user;
    if (!user.isAuthenticated()) {
        return cb(Errors.AccessDenied('Not logged in'));
    }
    if (!user.getProperty(UserProps.AtProtoDid)) {
        return cb(
            Errors.DoesNotExist('No AT identity is linked', ErrorReasons.DoesNotExist)
        );
    }

    const keepsSshKey =
        User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.SSHPubKey) &&
        !!user.getProperty(UserProps.SSHPubKey);

    const checkPassword = callback => {
        if (!password) {
            return callback(null, false);
        }
        User.passwordMatches(user.userId, password, (err, matches) => {
            if (err) {
                return callback(err);
            }
            if (!matches) {
                return callback(
                    Errors.BadLogin('Invalid password', ErrorReasons.ValueInvalid)
                );
            }
            return callback(
                null,
                User.isAuthFactor1TypeAllowed(User.AuthFactor1Types.Password)
            );
        });
    };

    checkPassword((err, keepsPassword) => {
        if (err) {
            return cb(err);
        }
        if (!keepsPassword && !keepsSshKey) {
            return cb(
                Errors.AccessDenied(
                    'Unlinking would leave no way to log in',
                    ErrorReasons.NotAllowed
                )
            );
        }

        const did = user.getProperty(UserProps.AtProtoDid);
        user.removeProperties([UserProps.AtProtoDid, UserProps.AtProtoHandle], err => {
            if (err) {
                return cb(err);
            }
            client.log.info({ did }, 'User unlinked their AT identity');
            return cb(null);
        });
    });
}

//
//  Save |identity| ({ did, handle }) as |user|'s AT identity, as is: the
//  caller checks it may be linked. Also used by oputil, which can't prove it.
//
function setDidForUser(user, identity, cb) {
    const properties = { [UserProps.AtProtoDid]: identity.did };
    if (identity.handle) {
        properties[UserProps.AtProtoHandle] = identity.handle;
    }
    user.persistProperties(properties, err => {
        if (err || identity.handle) {
            return cb(err || null);
        }
        //  An old handle would belong to the previous DID
        return user.removeProperty(UserProps.AtProtoHandle, cb);
    });
}

//  Calls back with ErrorReasons.AlreadyThere if a user other than
//  |exceptUserId| is linked to |did|
function checkDidUnlinked(did, exceptUserId, cb) {
    findUserIdByDid(did, (err, userId) => {
        if (err) {
            return cb(err);
        }
        if (userId && userId !== exceptUserId) {
            return cb(
                Errors.AccessDenied(
                    'A user is already linked to this AT identity',
                    ErrorReasons.AlreadyThere
                )
            );
        }
        return cb(null);
    });
}

//
//  The identity the caller just proved, kept on their session (never in
//  menu arguments, which come from configuration) until they apply.
//
function setPendingIdentity(client, identity) {
    client.atProtoPendingIdentity = {
        did: identity.did,
        handle: identity.handle || null,
        provenAt: Date.now(),
    };
}

//  The pending identity, or null if there is none or it is too old
function getPendingIdentity(client) {
    const pending = client.atProtoPendingIdentity;
    if (!pending || Date.now() - pending.provenAt > PendingIdentityMaxAgeMs) {
        return null;
    }
    return { did: pending.did, handle: pending.handle };
}

function clearPendingIdentity(client) {
    delete client.atProtoPendingIdentity;
}

//
//  Usernames to try for |handle|, best first: the handle's first label
//  ("alice" for alice.bsky.social), then numbered versions of it, then a
//  few random ones for handles that give nothing usable.
//
function usernameCandidates(handle) {
    const config = Config();
    const min = _.get(config, 'users.usernameMin', 2);
    const max = _.get(config, 'users.usernameMax', 16);

    const candidates = [];
    const base = (_.isString(handle) ? handle.split('.')[0] : '').slice(0, max);
    if (base.length >= min) {
        candidates.push(base);
        for (let n = 2; n < MaxNumberedCandidates + 2; ++n) {
            const suffix = String(n);
            candidates.push(base.slice(0, max - suffix.length) + suffix);
        }
    }
    for (let i = 0; i < 3; ++i) {
        candidates.push(`atuser${crypto.randomInt(10000, 100000)}`.slice(0, max));
    }
    return candidates;
}

//  Calls back with the first candidate that is a valid, unused username
function deriveUsername(handle, cb) {
    async.detectSeries(
        usernameCandidates(handle),
        (name, next) => {
            return validateUserNameAvail(name, err => next(null, !err));
        },
        (err, username) => {
            if (err) {
                return cb(err);
            }
            if (!username) {
                return cb(
                    Errors.UnexpectedState('No username available for this AT identity')
                );
            }
            return cb(null, username);
        }
    );
}
