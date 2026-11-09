/* jslint node: true */
'use strict';

//  The base AT Protocol OAuth scope. The BBS needs only proof of identity,
//  never permission to write to a member's repository, so nothing broader is
//  ever requested from members.
exports.OAuthScope = 'atproto';

//
//  The board's own account (core/atproto/publishing.js) writes its listing
//  and status records and posts announcements, so it asks for exactly
//  that: granular scopes, never transition:generic. Images (blob) are for
//  ANSI art posts.
//
//  Record types are named under |nsidPrefix| (atProto.publishing.nsidPrefix):
//  "nexus.cyberspace.dev" while the record shapes are drafts, the real
//  "nexus.cyberspace" once they are final, since published names are
//  permanent.
//
exports.DefaultNsidPrefix = 'nexus.cyberspace.dev';
exports.PostCollection = 'app.bsky.feed.post';

exports.recordTypes = (nsidPrefix = exports.DefaultNsidPrefix) => ({
    listing: `${nsidPrefix}.leaf.listing`,
    status: `${nsidPrefix}.leaf.status`,
});

exports.boardScope = (nsidPrefix = exports.DefaultNsidPrefix) => {
    const types = exports.recordTypes(nsidPrefix);
    return [
        exports.OAuthScope,
        `repo:${types.listing}`,
        `repo:${types.status}`,
        `repo:${exports.PostCollection}`,
        'blob:image/*',
    ].join(' ');
};

exports.ClientModes = {
    //  Development: no public URL, hosted metadata, or keys required
    Loopback: 'loopback',
    //  Production: identified by its client metadata URL on the BBS's own
    //  public https:// address, and authenticates with a signing key
    Public: 'public',
};

//  Where the web server serves the OAuth redirect back to the BBS
exports.CallbackRoutePath = '/_enig/atproto/callback';

//  Public mode: the client metadata document (its URL is the client ID) and
//  the public half of the signing key
exports.ClientMetadataRoutePath = '/_enig/atproto/client-metadata.json';
exports.JwksRoutePath = '/_enig/atproto/jwks.json';

//  Public mode: the private signing key, kept in paths.security
exports.SigningKeyFile = 'atproto_oauth_key.json';
exports.SigningAlg = 'ES256';

//  Abandoned authorization requests are dropped after this long
exports.StateMaxAgeSeconds = 60 * 60;

//  What identity resolution reports for a handle that does not verify
exports.HandleInvalid = 'handle.invalid';
