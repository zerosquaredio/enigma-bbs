'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');

let testConfig;
const baseConfig = () => ({
    debug: { assertsEnabled: false },
    atProto: {
        enabled: true,
        hub: {
            url: 'https://hub.example.net/',
            name: 'CoolBBS',
            token: 'hub_secret',
            presence: { enabled: true, includeLocalUsers: false },
        },
    },
});

const call = (fn, ...args) =>
    new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );

//  a user as the report reads it
function fakeUser(userId, username, props = {}) {
    const properties = Object.assign(
        {
            [UserProps.AccountStatus]: '2',
            [UserProps.AccountCreated]: '2026-01-02T03:04:05.000Z',
            [UserProps.AtProtoHubPresence]: '1',
        },
        props
    );
    return {
        userId,
        username,
        properties,
        getProperty: name => properties[name],
        persistProperty: (name, value, cb) => {
            properties[name] = value;
            setImmediate(cb, null);
        },
        removeProperty: (name, cb) => {
            delete properties[name];
            setImmediate(cb, null);
        },
    };
}

describe('Presence reports to the hub', () => {
    let previousConfigGet;
    let HubPresence;
    let users;
    let online;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        delete require.cache[require.resolve('../core/atproto/hub_presence.js')];
        HubPresence = require('../core/atproto/hub_presence.js');
        HubPresence._setDeps({
            userIdsShown: cb => setImmediate(cb, null, Object.keys(users).map(Number)),
            loadUser: (userId, cb) => setImmediate(cb, null, users[userId]),
            onlineUserIds: () => online,
        });
    });

    after(() => configModule._popTestConfig(previousConfigGet));

    beforeEach(() => {
        testConfig = baseConfig();
        users = {};
        online = [];
    });

    const settings = () => HubPresence.hubSettings().settings;

    describe('settings', () => {
        it('are on only with AT support and presence both on', () => {
            assert.equal(HubPresence.isEnabled(), true);
            testConfig.atProto.hub.presence.enabled = false;
            assert.equal(HubPresence.isEnabled(), false);
            testConfig.atProto.hub.presence.enabled = true;
            testConfig.atProto.enabled = false;
            assert.equal(HubPresence.isEnabled(), false);
        });

        it('give the report address, and the name in lower case', () => {
            assert.deepEqual(settings(), {
                origin: 'https://hub.example.net',
                reportUrl: 'https://hub.example.net/api/bbs/presence',
                name: 'coolbbs',
                token: 'hub_secret',
                includeLocalUsers: false,
            });
        });

        it('send the token only over https, or to this machine', () => {
            testConfig.atProto.hub.url = 'http://hub.example.net';
            assert.equal(settings(), null);
            assert.match(HubPresence.hubSettings().reason, /https/);
            testConfig.atProto.hub.url = 'http://127.0.0.1:7210';
            assert.equal(settings().reportUrl, 'http://127.0.0.1:7210/api/bbs/presence');
        });

        it('say what is missing', () => {
            testConfig.atProto.hub.token = '';
            assert.match(HubPresence.hubSettings().reason, /token/);
            testConfig.atProto.hub.name = '';
            assert.match(HubPresence.hubSettings().reason, /name/);
            testConfig.atProto.hub.url = 'not a url';
            testConfig.atProto.hub.name = 'x';
            testConfig.atProto.hub.token = 'y';
            assert.match(HubPresence.hubSettings().reason, /not a URL/);
        });
    });

    describe('the report', () => {
        it('lists members who chose to be shown, by DID, and who is on', async () => {
            users = {
                1: fakeUser(1, 'alice', { [UserProps.AtProtoDid]: 'did:plc:alice' }),
                2: fakeUser(2, 'bob', { [UserProps.AtProtoDid]: 'did:plc:bob' }),
            };
            online = [1, 7];
            const report = await call(HubPresence.buildReport, settings());
            assert.deepEqual(report, {
                bbs: 'coolbbs',
                members: [
                    {
                        did: 'did:plc:alice',
                        name: 'alice',
                        memberSince: '2026-01-02T03:04:05.000Z',
                        online: true,
                    },
                    {
                        did: 'did:plc:bob',
                        name: 'bob',
                        memberSince: '2026-01-02T03:04:05.000Z',
                        online: false,
                    },
                ],
            });
        });

        it('leaves out the withheld, inactive accounts, and anyone not choosing it', async () => {
            const did = n => ({ [UserProps.AtProtoDid]: `did:plc:${n}` });
            users = {
                1: fakeUser(
                    1,
                    'withheld',
                    Object.assign(did('a'), { [UserProps.AtProtoHubWithheld]: '1' })
                ),
                2: fakeUser(
                    2,
                    'inactive',
                    Object.assign(did('b'), { [UserProps.AccountStatus]: '1' })
                ),
                3: fakeUser(
                    3,
                    'locked',
                    Object.assign(did('c'), { [UserProps.AccountStatus]: '3' })
                ),
                4: fakeUser(
                    4,
                    'notshown',
                    Object.assign(did('d'), { [UserProps.AtProtoHubPresence]: '0' })
                ),
            };
            const report = await call(HubPresence.buildReport, settings());
            assert.deepEqual(report.members, []);
        });

        it('includes members with no AT account only when the sysop allows it', async () => {
            users = { 5: fakeUser(5, 'Carol') };
            online = [5];
            assert.deepEqual(
                (await call(HubPresence.buildReport, settings())).members,
                []
            );
            testConfig.atProto.hub.presence.includeLocalUsers = true;
            assert.deepEqual((await call(HubPresence.buildReport, settings())).members, [
                {
                    user: 'Carol',
                    name: 'Carol',
                    memberSince: '2026-01-02T03:04:05.000Z',
                    online: true,
                },
            ]);
        });
    });

    describe('sending', () => {
        let sent;
        beforeEach(() => {
            sent = [];
        });
        const reply = (status, body) => (url, init) => {
            sent.push({ url, init });
            return Promise.resolve({
                ok: status < 300,
                status,
                text: () => Promise.resolve(JSON.stringify(body)),
            });
        };

        it('posts the report with the token, following no redirects', async () => {
            HubPresence._setFetch(reply(200, { ok: true }));
            await call(HubPresence.sendReport, settings(), {
                bbs: 'coolbbs',
                members: [],
            });
            assert.equal(sent[0].url, 'https://hub.example.net/api/bbs/presence');
            assert.equal(sent[0].init.method, 'POST');
            assert.equal(sent[0].init.headers.Authorization, 'Bearer hub_secret');
            assert.equal(sent[0].init.redirect, 'error');
            assert.deepEqual(JSON.parse(sent[0].init.body), {
                bbs: 'coolbbs',
                members: [],
            });
        });

        it("passes on the hub's reason for refusing", async () => {
            HubPresence._setFetch(reply(401, { error: 'Not a BBS on this hub' }));
            await assert.rejects(
                call(HubPresence.sendReport, settings(), { bbs: 'coolbbs', members: [] }),
                /refused the report \(401\): Not a BBS on this hub/
            );
        });
    });

    describe("a member's setting, and the sysop's", () => {
        it('are off until turned on', async () => {
            const user = fakeUser(1, 'alice', {
                [UserProps.AtProtoHubPresence]: undefined,
            });
            assert.equal(HubPresence.isShown(user), false);
            await call(HubPresence.setShown, user, true);
            assert.equal(HubPresence.isShown(user), true);
            await call(HubPresence.setShown, user, false);
            assert.equal(HubPresence.isShown(user), false);

            assert.equal(HubPresence.isWithheld(user), false);
            await call(HubPresence.setWithheld, user, true);
            assert.equal(HubPresence.isWithheld(user), true);
            await call(HubPresence.setWithheld, user, false);
            assert.equal(HubPresence.isWithheld(user), false);
        });
    });
});
