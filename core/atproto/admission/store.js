/* jslint node: true */
'use strict';

//  deps
const crypto = require('crypto');
const _ = require('lodash');

exports.createInviteStore = createInviteStore;
exports.createInviteCodeStore = createInviteCodeStore;
exports.generateCode = generateCode;
exports.normalizeCode = normalizeCode;
exports.hashCode = hashCode;

//
//  Invites and invite codes (core/atproto/admission/), kept in
//  atproto.sqlite3. Synchronous, like every other better-sqlite3 caller.
//
//  Using one up is a conditional update, so two applicants racing for the
//  last use of a code (or an invite opened twice) can't both have it: the
//  loser's update changes nothing, and it is told so.
//

const nowSeconds = () => Math.floor(Date.now() / 1000);

const parseGroups = json => {
    try {
        const groups = JSON.parse(json);
        return Array.isArray(groups) ? groups.filter(_.isString) : [];
    } catch (e) {
        return [];
    }
};

function inviteFromRow(row, now) {
    return {
        id: row.id,
        did: row.did,
        handle: row.handle || undefined,
        groups: parseGroups(row.groups_json),
        createdAt: row.created_timestamp,
        expiresAt: row.expires_timestamp || undefined,
        revokedAt: row.revoked_timestamp || undefined,
        usedAt: row.used_timestamp || undefined,
        usedByUserId: row.used_by_user_id || undefined,
        isUsable:
            !row.revoked_timestamp &&
            !row.used_timestamp &&
            (!row.expires_timestamp || row.expires_timestamp > now),
    };
}

//
//  Invites for one DID each. A DID may have several (say, one revoked and a
//  new one); the newest usable one is the one that counts.
//
function createInviteStore(db, { now = nowSeconds } = {}) {
    const insertStmt = db.prepare(
        `INSERT INTO invite (did, handle, groups_json, created_timestamp, expires_timestamp)
        VALUES (?, ?, ?, ?, ?)`
    );
    const usableForDidStmt = db.prepare(
        `SELECT * FROM invite
        WHERE did = ? AND revoked_timestamp IS NULL AND used_timestamp IS NULL
            AND (expires_timestamp IS NULL OR expires_timestamp > ?)
        ORDER BY id DESC LIMIT 1`
    );
    const listStmt = db.prepare('SELECT * FROM invite ORDER BY id');
    const getStmt = db.prepare('SELECT * FROM invite WHERE id = ?');
    const useStmt = db.prepare(
        `UPDATE invite SET used_timestamp = ?
        WHERE id = ? AND used_timestamp IS NULL AND revoked_timestamp IS NULL`
    );
    const unuseStmt = db.prepare(
        'UPDATE invite SET used_timestamp = NULL, used_by_user_id = NULL WHERE id = ?'
    );
    const usedByStmt = db.prepare('UPDATE invite SET used_by_user_id = ? WHERE id = ?');
    const revokeStmt = db.prepare(
        `UPDATE invite SET revoked_timestamp = ?
        WHERE id = ? AND revoked_timestamp IS NULL AND used_timestamp IS NULL`
    );

    return {
        //  Returns the new invite's id
        add: ({ did, handle, groups, lifetimeSeconds }) => {
            const ts = now();
            const info = insertStmt.run(
                did,
                handle || null,
                JSON.stringify(groups || []),
                ts,
                lifetimeSeconds ? ts + lifetimeSeconds : null
            );
            return Number(info.lastInsertRowid);
        },
        usableFor: did => {
            const row = usableForDidStmt.get(did, now());
            return row ? inviteFromRow(row, now()) : undefined;
        },
        get: id => {
            const row = getStmt.get(id);
            return row ? inviteFromRow(row, now()) : undefined;
        },
        list: () => listStmt.all().map(row => inviteFromRow(row, now())),
        //  true if this call used it up; false if it already was, or revoked
        use: id => 1 === useStmt.run(now(), id).changes,
        unuse: id => {
            unuseStmt.run(id);
        },
        setUsedBy: (id, userId) => {
            usedByStmt.run(userId, id);
        },
        //  true if revoked now; false if unknown, used, or already revoked
        revoke: id => 1 === revokeStmt.run(now(), id).changes,
    };
}

//
//  Codes: 12 characters of Crockford's base32 (no I, L, O or U), about 60
//  bits, shown as XXXX-XXXX-XXXX and accepted as a person might type them
//  (any case, with or without dashes, O for 0, I or L for 1)
//
const CodeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CodeLength = 12;
const HintLength = 4;

function generateCode() {
    let raw = '';
    for (let i = 0; i < CodeLength; ++i) {
        raw += CodeAlphabet[crypto.randomInt(CodeAlphabet.length)];
    }
    return raw.match(/.{4}/g).join('-');
}

//  The canonical form of a typed code (no dashes), or null
function normalizeCode(input) {
    if (!_.isString(input)) {
        return null;
    }
    const raw = input
        .trim()
        .toUpperCase()
        .replace(/[-\s]/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
    if (raw.length !== CodeLength || ![...raw].every(c => CodeAlphabet.includes(c))) {
        return null;
    }
    return raw;
}

function hashCode(normalized) {
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function codeFromRow(row, now) {
    return {
        id: row.id,
        hint: row.hint,
        groups: parseGroups(row.groups_json),
        maxUses: row.max_uses,
        usesLeft: row.uses_left,
        createdAt: row.created_timestamp,
        expiresAt: row.expires_timestamp || undefined,
        revokedAt: row.revoked_timestamp || undefined,
        isUsable:
            !row.revoked_timestamp &&
            row.uses_left > 0 &&
            (!row.expires_timestamp || row.expires_timestamp > now),
    };
}

function createInviteCodeStore(db, { now = nowSeconds } = {}) {
    const insertStmt = db.prepare(
        `INSERT INTO invite_code
            (code_hash, hint, groups_json, max_uses, uses_left, created_timestamp, expires_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const byHashStmt = db.prepare('SELECT * FROM invite_code WHERE code_hash = ?');
    const listStmt = db.prepare('SELECT * FROM invite_code ORDER BY id');
    const useStmt = db.prepare(
        `UPDATE invite_code SET uses_left = uses_left - 1
        WHERE id = ? AND uses_left > 0 AND revoked_timestamp IS NULL
            AND (expires_timestamp IS NULL OR expires_timestamp > ?)`
    );
    const unuseStmt = db.prepare(
        `UPDATE invite_code SET uses_left = MIN(uses_left + 1, max_uses) WHERE id = ?`
    );
    const revokeStmt = db.prepare(
        `UPDATE invite_code SET revoked_timestamp = ?
        WHERE id = ? AND revoked_timestamp IS NULL`
    );
    const anyUsableStmt = db.prepare(
        `SELECT 1 FROM invite_code
        WHERE uses_left > 0 AND revoked_timestamp IS NULL
            AND (expires_timestamp IS NULL OR expires_timestamp > ?)
        LIMIT 1`
    );

    return {
        //  Makes a new code: returns { id, code }. The code itself is not
        //  kept, so this is the only time it can be shown.
        add: ({ groups, maxUses = 1, lifetimeSeconds }) => {
            const ts = now();
            for (let attempt = 0; attempt < 5; ++attempt) {
                const code = generateCode();
                const normalized = normalizeCode(code);
                try {
                    const info = insertStmt.run(
                        hashCode(normalized),
                        normalized.slice(-HintLength),
                        JSON.stringify(groups || []),
                        maxUses,
                        maxUses,
                        ts,
                        lifetimeSeconds ? ts + lifetimeSeconds : null
                    );
                    return { id: Number(info.lastInsertRowid), code };
                } catch (e) {
                    if (!/UNIQUE/.test(e.message)) {
                        throw e;
                    }
                }
            }
            throw new Error('Could not generate a unique invite code');
        },
        //  The code a person typed, if it is one (usable or not)
        find: typed => {
            const normalized = normalizeCode(typed);
            const row = normalized && byHashStmt.get(hashCode(normalized));
            return row ? codeFromRow(row, now()) : undefined;
        },
        list: () => listStmt.all().map(row => codeFromRow(row, now())),
        anyUsable: () => !!anyUsableStmt.get(now()),
        //  true if this call took a use; false if none were left
        use: id => 1 === useStmt.run(id, now()).changes,
        unuse: id => {
            unuseStmt.run(id);
        },
        revoke: id => 1 === revokeStmt.run(now(), id).changes,
    };
}
