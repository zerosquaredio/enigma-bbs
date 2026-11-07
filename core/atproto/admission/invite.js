/* jslint node: true */
'use strict';

//  ENiGMA½
const User = () => require('../../user');

//
//  "invite": the sysop invited this AT identity (oputil atproto invite add).
//  The invite is bound to the DID, so there is nothing secret to leak. It
//  grants the invite's groups, starts the account active, and is used once.
//  Works on a board closed to the public: that is what it is for.
//
module.exports = {
    id: 'invite',
    description: 'Invited by the sysop',
    invitationOnly: true,

    mayAdmit: (applicant, ctx, cb) => {
        let invite;
        try {
            invite = ctx.invites.usableFor(applicant.did);
        } catch (err) {
            return setImmediate(() => cb(err));
        }
        return setImmediate(() => cb(null, !!invite));
    },

    admit: (applicant, ctx, cb) => {
        let invite;
        try {
            invite = ctx.invites.usableFor(applicant.did);
        } catch (err) {
            return setImmediate(() => cb(err));
        }
        if (!invite) {
            return setImmediate(() => cb(null, null));
        }
        return setImmediate(() =>
            cb(null, {
                groups: invite.groups.length > 0 ? invite.groups : undefined,
                accountStatus: User().AccountStatus.active,
                ref: invite.id,
                use: () => ctx.invites.use(invite.id),
                undo: () => ctx.invites.unuse(invite.id),
                used: userId => ctx.invites.setUsedBy(invite.id, userId),
            })
        );
    },
};
