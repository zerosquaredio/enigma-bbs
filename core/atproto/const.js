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

//  The board's art, as assets (assets spec §3): each piece, a catalogue of
//  them, and the board's view
exports.assetTypes = (nsidPrefix = exports.DefaultNsidPrefix) => ({
    item: `${nsidPrefix}.asset.item`,
    catalogue: `${nsidPrefix}.asset.catalogue`,
    view: `${nsidPrefix}.asset.view`,
});

//  The board's live objects (compute spec; build spec of the live object
//  slice, §3): each a record of its own, naming a program and its input
exports.objectTypes = (nsidPrefix = exports.DefaultNsidPrefix) => ({
    object: `${nsidPrefix}.object`,
});

//
//  What the board account is asked to allow. Permissions name record types
//  exactly, so adding one, or the record names becoming final, means every
//  board connects its account again: the list is meant to change rarely.
//  Files of any kind may be uploaded, as a file does nothing until one of
//  these records names it (ANSI art, pictures, and later models).
//
exports.boardScope = (nsidPrefix = exports.DefaultNsidPrefix) => {
    const types = exports.recordTypes(nsidPrefix);
    const assets = exports.assetTypes(nsidPrefix);
    return [
        exports.OAuthScope,
        `repo:${types.listing}`,
        `repo:${types.status}`,
        `repo:${exports.PostCollection}`,
        `repo:${assets.item}`,
        `repo:${assets.catalogue}`,
        `repo:${assets.view}`,
        `repo:${exports.objectTypes(nsidPrefix).object}`,
        'blob:*/*',
    ].join(' ');
};

//  A permission, in words, for the sysop
exports.permissionWords = (scope, nsidPrefix = exports.DefaultNsidPrefix) => {
    const types = exports.recordTypes(nsidPrefix);
    const assets = exports.assetTypes(nsidPrefix);
    const words = {
        [`repo:${types.listing}`]: 'its listing',
        [`repo:${types.status}`]: 'its status',
        [`repo:${exports.PostCollection}`]: 'posts',
        [`repo:${assets.item}`]: 'its art',
        [`repo:${assets.catalogue}`]: 'its art',
        [`repo:${assets.view}`]: 'its view',
        [`repo:${exports.objectTypes(nsidPrefix).object}`]: 'its live objects',
        'blob:*/*': 'files for its art',
    };
    return words[scope] || scope;
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
