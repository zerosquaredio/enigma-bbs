/* jslint node: true */
'use strict';

//  The base AT Protocol OAuth scope. The BBS needs only proof of identity,
//  never permission to write to a member's repository, so nothing broader is
//  ever requested.
exports.OAuthScope = 'atproto';

exports.ClientModes = {
    //  Development: no public URL, hosted metadata, or keys required
    Loopback: 'loopback',
};

//  Where the web server serves the OAuth redirect back to the BBS
exports.CallbackRoutePath = '/_enig/atproto/callback';

//  Abandoned authorization requests are dropped after this long
exports.StateMaxAgeSeconds = 60 * 60;

//  What identity resolution reports for a handle that does not verify
exports.HandleInvalid = 'handle.invalid';
