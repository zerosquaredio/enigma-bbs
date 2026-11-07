/* jslint node: true */
'use strict';

//  ENiGMA½
const User = () => require('../../user');

//
//  "sysop-approval": anyone, but their account starts inactive until the
//  sysop activates it (ENiGMA½'s own activation, as users.requireActivation
//  does for every new user). Not on a board closed to the public.
//
module.exports = {
    id: 'sysop-approval',
    description: 'Anyone, once the sysop approves them',
    invitationOnly: false,

    mayAdmit: (applicant, ctx, cb) => setImmediate(() => cb(null, true)),

    admit: (applicant, ctx, cb) =>
        setImmediate(() => cb(null, { accountStatus: User().AccountStatus.inactive })),
};
