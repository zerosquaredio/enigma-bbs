/* jslint node: true */
'use strict';

//  ENiGMA½
const User = () => require('../../user');

//
//  "invite-code": the applicant entered a code the sysop made (oputil
//  atproto invite-code add), in the AT application form. Each code has a
//  number of uses and its own groups, and starts the account active. Works
//  on a board closed to the public.
//
module.exports = {
    id: 'invite-code',
    description: 'Has an invite code',
    invitationOnly: true,

    //  Before the application nobody has entered a code yet: anyone might
    //  have one, so long as there is a code that could still be used
    mayAdmit: (applicant, ctx, cb) => {
        let any;
        try {
            any = ctx.codes.anyUsable();
        } catch (err) {
            return setImmediate(() => cb(err));
        }
        return setImmediate(() => cb(null, any));
    },

    admit: (applicant, ctx, cb) => {
        let code;
        try {
            code = applicant.inviteCode && ctx.codes.find(applicant.inviteCode);
        } catch (err) {
            return setImmediate(() => cb(err));
        }
        if (!code || !code.isUsable) {
            return setImmediate(() => cb(null, null));
        }
        return setImmediate(() =>
            cb(null, {
                groups: code.groups.length > 0 ? code.groups : undefined,
                accountStatus: User().AccountStatus.active,
                ref: code.id,
                use: () => ctx.codes.use(code.id),
                undo: () => ctx.codes.unuse(code.id),
            })
        );
    },
};
