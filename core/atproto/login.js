/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../config').get;
const { Errors, ErrorReasons } = require('../enig_error');
const User = require('../user');
const UserProps = require('../user_property');
const { validateUserNameAvail } = require('../system_view_validate');
const { getISOTimestampString } = require('../database');
const theme = require('../theme');
const AtProtoOAuth = require('./oauth_client');

//  deps
const async = require('async');
const crypto = require('crypto');
const _ = require('lodash');

//
//  Log a terminal session in as the local user bound to an AT Protocol
//  identity, creating that user on first login.
//
//  |identity.did| must already be proven by an AT OAuth login (see
//  oauth_client.js handleCallback()); nothing here checks it again with the
//  account host. Users are found by DID only, never by handle: handles can
//  change hands, DIDs can't.
//

exports.loginWithDid = loginWithDid;
exports.findUserIdByDid = findUserIdByDid;
exports.deriveUsername = deriveUsername;
exports.usernameCandidates = usernameCandidates;

//  For tests: substitute the final login step
exports._setUserLogin = fn => {
    userLogin = fn;
};

let userLogin = (...args) => require('../user_login').userLogin(...args);

//  Numbered alternatives tried when the name from a handle is taken
const MaxNumberedCandidates = 98;

function loginSettings() {
    return Object.assign(
        { allowNewUsers: true, secureConnectionsOnly: true, rootDid: '' },
        _.get(Config(), 'atProto.login')
    );
}

//
//  |identity| is { did, handle }; |handle| is the verified handle, or null.
//  Calls back as userLogin() does: on success |client.user| is logged in
//  (or awaiting 2FA, if the user has it on).
//
function loginWithDid(client, identity, cb) {
    const did = _.get(identity, 'did');
    const handle = _.get(identity, 'handle') || null;
    const settings = loginSettings();

    if (!AtProtoOAuth.isEnabled()) {
        return cb(
            Errors.AccessDenied(
                'AT Protocol login is not enabled',
                ErrorReasons.NotEnabled
            )
        );
    }
    if (!_.isString(did) || !did.startsWith('did:')) {
        return cb(Errors.Invalid('A DID is required'));
    }
    if (settings.secureConnectionsOnly && true !== _.get(client, 'session.isSecure')) {
        return cb(
            Errors.AccessDenied(
                'AT Protocol login needs a secure connection',
                ErrorReasons.NotAllowed
            )
        );
    }

    async.waterfall(
        [
            callback => {
                return findUserIdByDid(did, callback);
            },
            (userId, callback) => {
                if (userId) {
                    return User.getUserName(userId, callback);
                }
                return createUser(client, { did, handle }, settings, callback);
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

function createUser(client, { did, handle }, settings, cb) {
    const config = Config();

    if (!settings.allowNewUsers || true === _.get(config, 'general.closedSystem')) {
        return cb(
            Errors.AccessDenied(
                'No user is linked to this AT identity',
                ErrorReasons.NotAllowed
            )
        );
    }

    async.waterfall(
        [
            callback => {
                return User.getUserCount(callback);
            },
            (userCount, callback) => {
                //  The first user is root and a sysop, so a fresh board must
                //  not hand that to whoever logs in first
                if (0 === userCount && did !== settings.rootDid) {
                    return callback(
                        Errors.AccessDenied(
                            'Only atProto.login.rootDid may become the first user',
                            ErrorReasons.NotAllowed
                        )
                    );
                }
                return deriveUsername(handle, callback);
            },
            (username, callback) => {
                const newUser = new User();
                newUser.username = username;
                newUser.properties = {
                    [UserProps.AtProtoDid]: did,
                    [UserProps.AccountCreated]: getISOTimestampString(),
                    //  as for other new users: no backlog of years of mail
                    [UserProps.NewScanMinTimestamp]: getISOTimestampString(),
                    [UserProps.TermHeight]: _.get(client, 'term.termHeight', 25),
                    [UserProps.TermWidth]: _.get(client, 'term.termWidth', 80),
                };
                if (handle) {
                    newUser.properties[UserProps.AtProtoHandle] = handle;
                }

                const defaultTheme = _.get(config, 'theme.default');
                newUser.properties[UserProps.ThemeId] =
                    '*' === defaultTheme ? theme.getRandomTheme() : defaultTheme;

                //  ENiGMA½ always stores a password. Nobody knows this one, so
                //  password login stays closed unless the user sets their own.
                const createUserInfo = {
                    password: crypto.randomBytes(32).toString('hex'),
                    sessionId: _.get(client, 'session.uniqueId'),
                };

                newUser.create(createUserInfo, err => {
                    if (err) {
                        return callback(err);
                    }

                    client.log.info(
                        { username, userId: newUser.userId, did },
                        `New user "${username}" created by AT login`
                    );

                    if (newUser.isSysOp()) {
                        config.general.sysOp = {
                            username,
                            properties: newUser.properties,
                        };
                    }
                    return callback(null, username);
                });
            },
        ],
        cb
    );
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
