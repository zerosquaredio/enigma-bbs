/* jslint node: true */
'use strict';

//
//  "open": anyone who has proven an AT identity. Not on a board closed to
//  the public.
//
module.exports = {
    id: 'open',
    description: 'Anyone with an AT Protocol (Bluesky) account',
    invitationOnly: false,

    mayAdmit: (applicant, ctx, cb) => setImmediate(() => cb(null, true)),

    //  Default groups and account status (users.requireActivation)
    admit: (applicant, ctx, cb) => setImmediate(() => cb(null, {})),
};
