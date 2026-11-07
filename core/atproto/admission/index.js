/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../../config').get;
const Log = require('../../logger').log;
const { dbs } = require('../../database');
const { createInviteStore, createInviteCodeStore } = require('./store');

//  deps
const async = require('async');
const _ = require('lodash');

//
//  Admission: whether an AT identity with no user yet may become one, and
//  with which groups and account status. Asked when an AT applicant starts
//  (canApply) and again when their user is created (admit); existing users
//  are never asked, so a stricter policy leaves them as they are.
//
//  atProto.admission.policy lists verifiers by id, in order; the first that
//  admits the applicant decides. Each verifier (a module in this directory,
//  or one registered by a mod) answers two questions:
//
//    mayAdmit(applicant, ctx, cb)  might it admit them? Asked before the
//                                  application, with no side effects
//    admit(applicant, ctx, cb)     does it? Calls back with null, or
//                                  { groups, accountStatus, ref, use, undo,
//                                    used }
//
//  |applicant| is { did, handle, inviteCode }. A verifier marked
//  invitationOnly still admits on a board closed to the public
//  (atProto.login.allowNewUsers false, or general.closedSystem); the others
//  don't. An admitted user also joins "verified-<id>", so access rules can
//  tell how they got in: in v1, these groups are the attestations.
//
//  Applicants no verifier admits are refused, or with
//  atProto.admission.provisionalGroup set (and the board open), created in
//  that group only, instead of users.defaultGroups.
//

exports.registerVerifier = registerVerifier;
exports.getVerifier = id => verifiers.get(id);
exports.policy = policy;
exports.isOpenToPublic = isOpenToPublic;
exports.takesInviteCodes = takesInviteCodes;
exports.canApply = canApply;
exports.admit = admit;
exports.checkInviteCode = checkInviteCode;
exports.inviteStore = () => context().invites;
exports.inviteCodeStore = () => context().codes;
exports.VerifiedGroupPrefix = 'verified-';

exports._setStores = (invites, codes) => {
    stores = invites || codes ? { invites, codes } : null;
};

const verifiers = new Map();
const DefaultPolicy = ['open'];

//  Opened on first use, so a policy that never looks at invites ("open")
//  never touches the database
let stores = null;
function context() {
    return {
        config: Config(),
        get invites() {
            if (!stores) {
                stores = {};
            }
            if (!stores.invites) {
                stores.invites = createInviteStore(dbs.atproto);
            }
            return stores.invites;
        },
        get codes() {
            if (!stores) {
                stores = {};
            }
            if (!stores.codes) {
                stores.codes = createInviteCodeStore(dbs.atproto);
            }
            return stores.codes;
        },
    };
}

function registerVerifier(verifier) {
    if (!_.isString(verifier.id) || !_.isFunction(verifier.admit)) {
        throw new Error('A verifier needs an id and admit()');
    }
    verifiers.set(verifier.id, verifier);
}

[
    require('./open'),
    require('./invite'),
    require('./invite_code'),
    require('./sysop_approval'),
].forEach(registerVerifier);

const warnedUnknown = new Set();

//  The verifiers atProto.admission.policy names, in order
function policy(config = Config()) {
    const ids = _.get(config, 'atProto.admission.policy', DefaultPolicy);
    return _.castArray(ids).filter(id => {
        if (verifiers.has(id)) {
            return true;
        }
        if (!warnedUnknown.has(id)) {
            warnedUnknown.add(id);
            Log.warn(
                { verifier: id },
                'atProto.admission.policy names an unknown verifier; ignored'
            );
        }
        return false;
    });
}

function isOpenToPublic(config = Config()) {
    return (
        false !== _.get(config, 'atProto.login.allowNewUsers') &&
        true !== _.get(config, 'general.closedSystem')
    );
}

//  The verifiers that count on this board as it is configured now
function activeVerifiers(config) {
    const open = isOpenToPublic(config);
    return policy(config)
        .map(id => verifiers.get(id))
        .filter(v => open || true === v.invitationOnly);
}

function takesInviteCodes(config = Config()) {
    return activeVerifiers(config).some(v => 'invite-code' === v.id);
}

function provisionalGroup(config) {
    const group = _.get(config, 'atProto.admission.provisionalGroup');
    return isOpenToPublic(config) && _.isString(group) && group ? group : null;
}

//
//  Before the application: might |applicant| ({ did, handle }) be admitted?
//  Calls back with (err, { canApply, takesInviteCodes })
//
function canApply(applicant, cb) {
    const ctx = context();
    const candidates = activeVerifiers(ctx.config);
    const result = { canApply: false, takesInviteCodes: takesInviteCodes(ctx.config) };

    if (provisionalGroup(ctx.config)) {
        result.canApply = true;
        return setImmediate(() => cb(null, result));
    }

    async.someSeries(
        candidates,
        (verifier, next) => {
            const mayAdmit = verifier.mayAdmit || ((a, c, done) => done(null, true));
            mayAdmit(applicant, ctx, (err, may) => next(err, true === may));
        },
        (err, may) => {
            if (err) {
                return cb(err);
            }
            result.canApply = may;
            return cb(null, result);
        }
    );
}

//
//  When the user is created: is |applicant| admitted, and how? Calls back
//  with (err, decision), decision null if refused, else:
//    verifier       the id that admitted them ("provisional" for that)
//    groups         the user's groups, "verified-<id>" included
//    accountStatus  a User.AccountStatus, or undefined for the default
//    ref            the verifier's reference (invite id, code id, ...)
//    use()          take it: false if someone else just did (say, the last
//                   use of a code); call before creating the user
//    undo()         give it back, if creating the user failed
//    used(userId)   note who it went to, once created
//
function admit(applicant, cb) {
    const ctx = context();
    const defaultGroups = [..._.get(ctx.config, 'users.defaultGroups', ['users'])];

    let decision = null;
    async.someSeries(
        activeVerifiers(ctx.config),
        (verifier, next) => {
            verifier.admit(applicant, ctx, (err, admitted) => {
                if (err || !admitted) {
                    return next(err, false);
                }
                const groups = admitted.groups || defaultGroups;
                decision = {
                    verifier: verifier.id,
                    groups: _.uniq([
                        ...groups,
                        `${exports.VerifiedGroupPrefix}${verifier.id}`,
                    ]),
                    accountStatus: admitted.accountStatus,
                    ref: admitted.ref,
                    use: admitted.use || (() => true),
                    undo: admitted.undo || _.noop,
                    used: admitted.used || _.noop,
                };
                return next(null, true);
            });
        },
        err => {
            if (err) {
                return cb(err);
            }
            if (!decision) {
                const group = provisionalGroup(ctx.config);
                if (group) {
                    decision = {
                        verifier: 'provisional',
                        groups: [group],
                        use: () => true,
                        undo: _.noop,
                        used: _.noop,
                    };
                }
            }
            return cb(null, decision);
        }
    );
}

//
//  For the application form: is |typed| a code that would admit someone
//  now? Calls back with (err, reason): null if so, else 'unknown', 'used',
//  'expired' or 'revoked'
//
function checkInviteCode(typed, cb) {
    const ctx = context();
    let code;
    try {
        code = ctx.codes.find(typed);
    } catch (err) {
        return setImmediate(() => cb(err));
    }
    let reason = null;
    if (!code) {
        reason = 'unknown';
    } else if (code.revokedAt) {
        reason = 'revoked';
    } else if (code.usesLeft <= 0) {
        reason = 'used';
    } else if (!code.isUsable) {
        reason = 'expired';
    }
    return setImmediate(() => cb(null, reason));
}
