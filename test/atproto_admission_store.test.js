'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const { initAtProtoDatabase } = require('../core/database.js');
const {
    createInviteStore,
    createInviteCodeStore,
    generateCode,
    normalizeCode,
    hashCode,
} = require('../core/atproto/admission/store.js');

describe('AT admission store', () => {
    let db;
    let clock;
    let invites;
    let codes;

    beforeEach(() => {
        db = new Database(':memory:');
        initAtProtoDatabase(db);
        clock = 1_800_000_000;
        invites = createInviteStore(db, { now: () => clock });
        codes = createInviteCodeStore(db, { now: () => clock });
    });

    afterEach(() => {
        db.close();
    });

    describe('codes', () => {
        it('are 12 characters of Crockford base32, in groups of four', () => {
            for (let i = 0; i < 50; ++i) {
                assert.match(
                    generateCode(),
                    /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
                );
            }
        });

        it('are read as a person might type them', () => {
            assert.equal(normalizeCode('abcd-efgh-jk01'), 'ABCDEFGHJK01');
            assert.equal(normalizeCode(' ABCD EFGH JKO1 '), 'ABCDEFGHJK01');
            assert.equal(normalizeCode('abcdefghjkl1'), 'ABCDEFGHJK11');
            assert.equal(normalizeCode('ABCD-EFGH-JK0U'), null); //  no U
            assert.equal(normalizeCode('ABCD-EFGH'), null);
            assert.equal(normalizeCode(undefined), null);
        });

        it('are kept only as a hash, with their last characters', () => {
            const { id, code } = codes.add({ groups: ['users'], maxUses: 2 });
            const row = db.prepare('SELECT * FROM invite_code WHERE id = ?').get(id);
            assert.equal(row.code_hash, hashCode(normalizeCode(code)));
            assert.equal(row.hint, code.slice(-4));
            assert.ok(!JSON.stringify(row).includes(code.replace(/-/g, '')));
            assert.equal(codes.find(code).id, id);
        });

        it('are used no more times than they allow', () => {
            const { id } = codes.add({ maxUses: 2 });
            assert.equal(codes.use(id), true);
            assert.equal(codes.use(id), true);
            assert.equal(codes.use(id), false);
            codes.unuse(id);
            assert.equal(codes.list()[0].usesLeft, 1);
            codes.unuse(id);
            codes.unuse(id);
            assert.equal(codes.list()[0].usesLeft, 2); //  never more than given
        });

        it('cannot be used once revoked or expired', () => {
            const revoked = codes.add({ maxUses: 1 });
            codes.revoke(revoked.id);
            assert.equal(codes.use(revoked.id), false);

            const expiring = codes.add({ maxUses: 1, lifetimeSeconds: 60 });
            assert.equal(codes.anyUsable(), true);
            clock += 60;
            assert.equal(codes.use(expiring.id), false);
            assert.equal(codes.anyUsable(), false);
        });
    });

    describe('invites', () => {
        it('are found for their DID while usable', () => {
            const id = invites.add({
                did: 'did:plc:alice',
                handle: 'alice.test',
                groups: ['users'],
                lifetimeSeconds: 60,
            });
            assert.equal(invites.usableFor('did:plc:alice').id, id);
            assert.equal(invites.usableFor('did:plc:bob'), undefined);
            clock += 60;
            assert.equal(invites.usableFor('did:plc:alice'), undefined);
        });

        it('are used once, and can be given back', () => {
            const id = invites.add({ did: 'did:plc:alice' });
            assert.equal(invites.use(id), true);
            assert.equal(invites.use(id), false);
            invites.unuse(id);
            assert.equal(invites.usableFor('did:plc:alice').id, id);
        });

        it('cannot be revoked once used', () => {
            const id = invites.add({ did: 'did:plc:alice' });
            invites.use(id);
            invites.setUsedBy(id, 7);
            assert.equal(invites.revoke(id), false);
            assert.equal(invites.get(id).usedByUserId, 7);
        });

        it('prefer the newest when a DID has several', () => {
            const old = invites.add({ did: 'did:plc:alice', groups: ['a'] });
            const newer = invites.add({ did: 'did:plc:alice', groups: ['b'] });
            assert.equal(invites.usableFor('did:plc:alice').id, newer);
            invites.revoke(newer);
            assert.equal(invites.usableFor('did:plc:alice').id, old);
        });
    });
});
