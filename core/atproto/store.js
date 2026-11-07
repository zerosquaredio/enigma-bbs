/* jslint node: true */
'use strict';

//  ENiGMA½
const { StateMaxAgeSeconds } = require('./const');

exports.createStateStore = createStateStore;
exports.createSessionStore = createSessionStore;
exports.createWebSessionStore = createWebSessionStore;

//
//  State and session stores for @atproto/oauth-client-node, kept in
//  atproto.sqlite3.
//
//  The library treats both as simple key/value stores (get/set/del) and
//  accepts plain return values, so these stay synchronous like every other
//  better-sqlite3 caller. Values are the library's own JSON-safe objects and
//  are not interpreted here.
//
//  A session holds the member's refresh token and DPoP private key:
//  atproto.sqlite3 needs the same protection as the other databases.
//

const nowSeconds = () => Math.floor(Date.now() / 1000);

//
//  In-flight authorization requests, keyed by the library's state value. The
//  library deletes an entry when its callback arrives; requests that are
//  never completed are pruned once older than |maxAgeSeconds|.
//
function createStateStore(
    db,
    { maxAgeSeconds = StateMaxAgeSeconds, now = nowSeconds } = {}
) {
    const selectStmt = db.prepare(
        'SELECT state_json, created_timestamp FROM oauth_state WHERE state_key = ?'
    );
    const upsertStmt = db.prepare(
        `REPLACE INTO oauth_state (state_key, state_json, created_timestamp)
        VALUES (?, ?, ?)`
    );
    const deleteStmt = db.prepare('DELETE FROM oauth_state WHERE state_key = ?');
    const pruneStmt = db.prepare('DELETE FROM oauth_state WHERE created_timestamp < ?');

    return {
        get: key => {
            const row = selectStmt.get(key);
            if (!row) {
                return undefined;
            }
            if (now() - row.created_timestamp > maxAgeSeconds) {
                deleteStmt.run(key);
                return undefined;
            }
            return JSON.parse(row.state_json);
        },
        set: (key, value) => {
            const timestamp = now();
            pruneStmt.run(timestamp - maxAgeSeconds);
            upsertStmt.run(key, JSON.stringify(value), timestamp);
        },
        del: key => {
            deleteStmt.run(key);
        },
    };
}

//
//  Logged-in sessions, one per member DID. Token lifetime is the account
//  host's business; the library refreshes or discards sessions itself.
//
function createSessionStore(db, { now = nowSeconds } = {}) {
    const selectStmt = db.prepare('SELECT session_json FROM oauth_session WHERE did = ?');
    const upsertStmt = db.prepare(
        `REPLACE INTO oauth_session (did, session_json, updated_timestamp)
        VALUES (?, ?, ?)`
    );
    const deleteStmt = db.prepare('DELETE FROM oauth_session WHERE did = ?');

    return {
        get: did => {
            const row = selectStmt.get(did);
            return row ? JSON.parse(row.session_json) : undefined;
        },
        set: (did, value) => {
            upsertStmt.run(did, JSON.stringify(value), now());
        },
        del: did => {
            deleteStmt.run(did);
        },
    };
}

//
//  Web sign-in sessions (core/atproto/web_sign_in.js): one per signed-in
//  browser, keyed by a hash of the token in its cookie, so the database
//  never holds a usable cookie. A DID can have several.
//
function createWebSessionStore(db, { now = nowSeconds } = {}) {
    const insertStmt = db.prepare(
        `INSERT INTO web_session
            (token_hash, did, handle, created_timestamp, expires_timestamp, used_timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`
    );
    const selectStmt = db.prepare(
        `SELECT did, handle, expires_timestamp FROM web_session
        WHERE token_hash = ? AND expires_timestamp > ?`
    );
    const touchStmt = db.prepare(
        'UPDATE web_session SET used_timestamp = ?, handle = ? WHERE token_hash = ?'
    );
    const deleteStmt = db.prepare('DELETE FROM web_session WHERE token_hash = ?');
    const deleteDidStmt = db.prepare('DELETE FROM web_session WHERE did = ?');
    const pruneStmt = db.prepare('DELETE FROM web_session WHERE expires_timestamp <= ?');

    return {
        add: (tokenHash, { did, handle, lifetimeSeconds }) => {
            const ts = now();
            pruneStmt.run(ts);
            insertStmt.run(tokenHash, did, handle || null, ts, ts + lifetimeSeconds, ts);
        },
        //  { did, handle, expiresAt } while unexpired, else undefined
        get: tokenHash => {
            const row = selectStmt.get(tokenHash, now());
            return row
                ? {
                      did: row.did,
                      handle: row.handle || undefined,
                      expiresAt: row.expires_timestamp,
                  }
                : undefined;
        },
        touch: (tokenHash, handle) => {
            touchStmt.run(now(), handle || null, tokenHash);
        },
        del: tokenHash => {
            deleteStmt.run(tokenHash);
        },
        delAllForDid: did => {
            deleteDidStmt.run(did);
        },
    };
}
