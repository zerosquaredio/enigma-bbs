'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const { initAtProtoDatabase } = require('../core/database.js');
const { createStateStore, createSessionStore } = require('../core/atproto/store.js');

function freshDb() {
    const db = new Database(':memory:');
    initAtProtoDatabase(db);
    return db;
}

function rowCount(db, table) {
    return db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get().cnt;
}

describe('atproto database', () => {
    it('creates the OAuth state and session tables', () => {
        const db = freshDb();
        const tables = db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
            .all()
            .map(r => r.name);
        assert.deepEqual(tables, ['oauth_session', 'oauth_state']);
        db.close();
    });

    it('records schema version 1', () => {
        const db = freshDb();
        assert.equal(db.pragma('user_version', { simple: true }), 1);
        db.close();
    });

    it('can be initialized again without losing anything', () => {
        const db = freshDb();
        createSessionStore(db).set('did:plc:abc', { tokenSet: { sub: 'did:plc:abc' } });
        initAtProtoDatabase(db);
        assert.equal(rowCount(db, 'oauth_session'), 1);
        assert.equal(db.pragma('user_version', { simple: true }), 1);
        db.close();
    });
});

describe('atproto OAuth state store', () => {
    const MaxAge = 600;
    let db;
    let clock;
    let store;

    beforeEach(() => {
        db = freshDb();
        clock = 1000000;
        store = createStateStore(db, { maxAgeSeconds: MaxAge, now: () => clock });
    });

    afterEach(() => db.close());

    it('returns undefined for an unknown request', () => {
        assert.equal(store.get('missing'), undefined);
    });

    it('returns what was stored', () => {
        const value = {
            iss: 'https://bsky.social',
            dpopJwk: { kty: 'EC', crv: 'P-256' },
        };
        store.set('k1', value);
        assert.deepEqual(store.get('k1'), value);
    });

    it('replaces a request stored twice under one key', () => {
        store.set('k1', { n: 1 });
        store.set('k1', { n: 2 });
        assert.deepEqual(store.get('k1'), { n: 2 });
        assert.equal(rowCount(db, 'oauth_state'), 1);
    });

    it('forgets a deleted request', () => {
        store.set('k1', { n: 1 });
        store.del('k1');
        assert.equal(store.get('k1'), undefined);
    });

    it('keeps a request up to the maximum age', () => {
        store.set('k1', { n: 1 });
        clock += MaxAge;
        assert.deepEqual(store.get('k1'), { n: 1 });
    });

    it('treats a request older than the maximum age as gone, and removes it', () => {
        store.set('k1', { n: 1 });
        clock += MaxAge + 1;
        assert.equal(store.get('k1'), undefined);
        assert.equal(rowCount(db, 'oauth_state'), 0);
    });

    it('prunes abandoned requests when a new one is stored', () => {
        store.set('old', { n: 1 });
        clock += MaxAge + 1;
        store.set('new', { n: 2 });
        assert.equal(rowCount(db, 'oauth_state'), 1);
        assert.deepEqual(store.get('new'), { n: 2 });
    });
});

describe('atproto OAuth session store', () => {
    let db;
    let store;

    beforeEach(() => {
        db = freshDb();
        store = createSessionStore(db);
    });

    afterEach(() => db.close());

    it('returns undefined for a DID with no session', () => {
        assert.equal(store.get('did:plc:nobody'), undefined);
    });

    it('returns the stored session for its DID only', () => {
        store.set('did:plc:alice', { tokenSet: { sub: 'did:plc:alice' } });
        store.set('did:plc:bob', { tokenSet: { sub: 'did:plc:bob' } });
        assert.deepEqual(store.get('did:plc:alice'), {
            tokenSet: { sub: 'did:plc:alice' },
        });
        assert.deepEqual(store.get('did:plc:bob'), { tokenSet: { sub: 'did:plc:bob' } });
    });

    it('replaces a session when its tokens are refreshed', () => {
        store.set('did:plc:alice', { tokenSet: { access_token: 'one' } });
        store.set('did:plc:alice', { tokenSet: { access_token: 'two' } });
        assert.deepEqual(store.get('did:plc:alice'), {
            tokenSet: { access_token: 'two' },
        });
        assert.equal(rowCount(db, 'oauth_session'), 1);
    });

    it('forgets a deleted session', () => {
        store.set('did:plc:alice', { tokenSet: {} });
        store.del('did:plc:alice');
        assert.equal(store.get('did:plc:alice'), undefined);
    });

    it('survives a restart: a new store reads what an old one wrote', () => {
        store.set('did:plc:alice', { tokenSet: { sub: 'did:plc:alice' } });
        const reopened = createSessionStore(db);
        assert.deepEqual(reopened.get('did:plc:alice'), {
            tokenSet: { sub: 'did:plc:alice' },
        });
    });
});
