/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//  ENiGMA½
const {
    printUsageAndSetExitCode,
    argv,
    ExitCodes,
    initConfigAndDatabases,
} = require('./oputil_common.js');
const getHelpFor = require('./oputil_help.js').getHelpFor;

//  deps
const _ = require('lodash');
const moment = require('moment');

exports.handleAtProtoCommand = handleAtProtoCommand;

//
//  oputil.js atproto: AT Protocol admission (core/atproto/admission/)
//
//    invite add HANDLE|DID [--groups G1,G2] [--days N]
//    invite list
//    invite revoke ID
//    invite-code add [--uses N] [--groups G1,G2] [--days N]
//    invite-code list
//    invite-code revoke ID
//

const Admission = () => require('../atproto/admission');

function fail(message) {
    process.exitCode = ExitCodes.ERROR;
    console.error(message);
}

//  --groups "a, b" as ["a", "b"]; none: the board's default groups
function groupsArg() {
    if (undefined === argv.groups || true === argv.groups) {
        return [];
    }
    return _.uniq(
        String(argv.groups)
            .split(',')
            .map(g => g.trim())
            .filter(Boolean)
    );
}

//  --days N as seconds, undefined for none, or null if not a positive number
function lifetimeArg() {
    if (undefined === argv.days) {
        return undefined;
    }
    const days = Number(argv.days);
    return _.isFinite(days) && days > 0 ? Math.round(days * 24 * 60 * 60) : null;
}

const when = ts => (ts ? moment.unix(ts).format('YYYY-MM-DD HH:mm') : '-');
const groupsText = groups => (groups.length > 0 ? groups.join(',') : '(default)');

//
//  The DID |input| names: as is, if it is one; otherwise looked up as a
//  handle, which needs AT support started (atProto.enabled)
//
function resolveIdentity(input, cb) {
    const value = String(input).trim().replace(/^@/, '');
    if (/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value)) {
        return cb(null, { did: value });
    }

    const AtProtoOAuth = require('../atproto/oauth_client');
    if (!AtProtoOAuth.isEnabled()) {
        return cb(new Error('Looking up a handle needs atProto.enabled; give a DID'));
    }
    AtProtoOAuth.startup(err => {
        if (err) {
            return cb(err);
        }
        return AtProtoOAuth.resolveIdentity(value, cb);
    });
}

function inviteAdd(target) {
    const lifetimeSeconds = lifetimeArg();
    if (null === lifetimeSeconds) {
        return fail('--days must be a positive number');
    }

    resolveIdentity(target, (err, identity) => {
        if (err) {
            return fail(`Could not find "${target}": ${err.message}`);
        }
        const id = Admission().inviteStore().add({
            did: identity.did,
            handle: identity.handle,
            groups: groupsArg(),
            lifetimeSeconds,
        });
        const who = identity.handle
            ? `@${identity.handle} (${identity.did})`
            : identity.did;
        console.info(`Invite ${id} made for ${who}.`);
        console.info(
            'They can now log in with Bluesky and apply. Let them know yourself: the board does not send invites.'
        );
        if (!Admission().policy().includes('invite')) {
            console.info(
                'Note: atProto.admission.policy does not include "invite", so the invite is not used until it does.'
            );
        }
    });
}

function inviteList() {
    const invites = Admission().inviteStore().list();
    if (0 === invites.length) {
        return console.info('No invites.');
    }
    invites.forEach(i => {
        const state = i.usedAt
            ? `used ${when(i.usedAt)}${i.usedByUserId ? ` by user ${i.usedByUserId}` : ''}`
            : i.revokedAt
              ? `revoked ${when(i.revokedAt)}`
              : i.isUsable
                ? `open, expires ${when(i.expiresAt)}`
                : `expired ${when(i.expiresAt)}`;
        const who = i.handle ? `@${i.handle}` : i.did;
        console.info(
            `${String(i.id).padStart(4)}  ${who}  groups: ${groupsText(i.groups)}  made ${when(i.createdAt)}  ${state}`
        );
    });
}

function codeAdd() {
    const lifetimeSeconds = lifetimeArg();
    if (null === lifetimeSeconds) {
        return fail('--days must be a positive number');
    }
    const maxUses = undefined === argv.uses ? 1 : Number(argv.uses);
    if (!_.isInteger(maxUses) || maxUses < 1) {
        return fail('--uses must be a whole number, 1 or more');
    }

    const { id, code } = Admission().inviteCodeStore().add({
        groups: groupsArg(),
        maxUses,
        lifetimeSeconds,
    });
    console.info(`Invite code ${id}: ${code}`);
    console.info(
        `Good for ${maxUses} ${1 === maxUses ? 'use' : 'uses'}${
            lifetimeSeconds ? `, until ${when(moment().unix() + lifetimeSeconds)}` : ''
        }. Only a hash of it is kept, so note it now: it can't be shown again.`
    );
    if (!Admission().policy().includes('invite-code')) {
        console.info(
            'Note: atProto.admission.policy does not include "invite-code", so codes are not asked for until it does.'
        );
    }
}

function codeList() {
    const codes = Admission().inviteCodeStore().list();
    if (0 === codes.length) {
        return console.info('No invite codes.');
    }
    codes.forEach(c => {
        const state = c.revokedAt
            ? `revoked ${when(c.revokedAt)}`
            : c.usesLeft <= 0
              ? 'used up'
              : c.isUsable
                ? `open, expires ${when(c.expiresAt)}`
                : `expired ${when(c.expiresAt)}`;
        console.info(
            `${String(c.id).padStart(4)}  ...${c.hint}  uses left: ${c.usesLeft}/${c.maxUses}  groups: ${groupsText(c.groups)}  made ${when(c.createdAt)}  ${state}`
        );
    });
}

function revoke(store, idArg, what) {
    const id = parseInt(idArg, 10);
    if (!_.isInteger(id) || String(id) !== String(idArg).trim()) {
        return fail(`Give the ${what}'s number, as "list" shows it`);
    }
    if (store.revoke(id)) {
        return console.info(`${_.upperFirst(what)} ${id} revoked.`);
    }
    return fail(`No ${what} ${id} that can still be revoked`);
}

function handleAtProtoCommand() {
    if (true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('AtProto'), ExitCodes.SUCCESS);
    }

    const [, kind, action, arg] = argv._;
    const usage = () => printUsageAndSetExitCode(getHelpFor('AtProto'), ExitCodes.ERROR);

    const commands = {
        invite: {
            add: () => (arg ? inviteAdd(arg) : usage()),
            list: inviteList,
            revoke: () =>
                arg ? revoke(Admission().inviteStore(), arg, 'invite') : usage(),
        },
        'invite-code': {
            add: codeAdd,
            list: codeList,
            revoke: () =>
                arg ? revoke(Admission().inviteCodeStore(), arg, 'invite code') : usage(),
        },
    };

    const command = _.get(commands, [kind, action]);
    if (!command) {
        return usage();
    }

    initConfigAndDatabases(err => {
        if (err) {
            return fail(`Could not start: ${err.message}`);
        }
        try {
            return command();
        } catch (e) {
            return fail(e.message);
        }
    });
}
