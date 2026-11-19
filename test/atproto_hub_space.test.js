'use strict';

const { strict: assert } = require('assert');
const http = require('http');
const WebSocket = require('ws');

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

function fakeUser(username, props = {}) {
    const properties = Object.assign({ [UserProps.AtProtoHubPresence]: '1' }, props);
    return { username, getProperty: name => properties[name] };
}

const Alice = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const Bob = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 3000) {
    for (let i = 0; i < ms / 10; i++) {
        if (check()) {
            return;
        }
        await wait(10);
    }
    assert.fail(`timed out: ${what}`);
}

function snapshot(extra = {}) {
    return Object.assign(
        {
            $type: 'nexus.cyberspace.dev.space.snapshot',
            version: 1,
            seq: 1,
            you: `person:${Alice}`,
            entities: [
                { id: 'room:#space', type: 'room', name: '#space' },
                {
                    id: 'leaf:coolbbs',
                    type: 'leaf',
                    name: 'coolbbs',
                    title: 'Cool BBS',
                    online: true,
                },
                {
                    id: 'leaf:quietbbs',
                    type: 'leaf',
                    name: 'quietbbs',
                    title: null,
                    online: false,
                },
                {
                    id: `person:${Alice}`,
                    type: 'person',
                    label: '@alice.example',
                    did: Alice,
                    kind: 'account',
                },
                {
                    id: 'person:via:coolbbs:1',
                    type: 'person',
                    label: 'bob via coolbbs',
                    did: null,
                    kind: 'via',
                },
            ],
            presence: [
                {
                    id: 'p1',
                    person: `person:${Alice}`,
                    place: 'leaf:coolbbs',
                    since: null,
                    source: 'bbs',
                },
                {
                    id: 'p2',
                    person: 'person:via:coolbbs:1',
                    place: 'leaf:coolbbs',
                    since: null,
                    source: 'bbs',
                },
                {
                    id: 'p3',
                    person: `person:${Alice}`,
                    place: 'room:#space',
                    since: null,
                    source: 'chat',
                },
            ],
            groups: [],
            links: [],
        },
        extra
    );
}

describe('The hub space door', () => {
    let previousConfigGet;
    let HubSpace;

    before(() => {
        previousConfigGet = configModule._pushTestConfig({});
        configModule.get = () => testConfig;
        delete require.cache[require.resolve('../core/atproto/hub_presence.js')];
        delete require.cache[require.resolve('../core/atproto/hub_space.js')];
        HubSpace = require('../core/atproto/hub_space.js');
        HubSpace._setRetryMs(() => 20);
    });

    after(() => configModule._popTestConfig(previousConfigGet));

    beforeEach(() => {
        testConfig = baseConfig();
    });

    describe('who it is for', () => {
        it('names the member to the hub as the presence report does', () => {
            const found = HubSpace.memberQuery(
                fakeUser('alice', { [UserProps.AtProtoDid]: Alice })
            );
            assert.equal(
                found.query.toString(),
                `bbs=coolbbs&did=${encodeURIComponent(Alice)}`
            );
            assert.equal(found.did, Alice);
            assert.equal(found.settings.origin, 'https://hub.example.net');

            testConfig.atProto.hub.presence.includeLocalUsers = true;
            const local = HubSpace.memberQuery(fakeUser('dave'));
            assert.equal(local.query.toString(), 'bbs=coolbbs&user=dave');
            assert.equal(local.did, null);
        });

        it('says why not, when the hub would not let them in', () => {
            const reason = user => HubSpace.memberQuery(user).reason;
            assert.equal(reason(fakeUser('dave')), HubSpace.Reasons.noAccount);
            assert.equal(
                reason(
                    fakeUser('alice', {
                        [UserProps.AtProtoDid]: Alice,
                        [UserProps.AtProtoHubPresence]: undefined,
                    })
                ),
                HubSpace.Reasons.notShown
            );
            assert.equal(
                reason(
                    fakeUser('alice', {
                        [UserProps.AtProtoDid]: Alice,
                        [UserProps.AtProtoHubWithheld]: '1',
                    })
                ),
                HubSpace.Reasons.withheld
            );
            testConfig.atProto.hub.presence.enabled = false;
            assert.equal(
                reason(fakeUser('alice', { [UserProps.AtProtoDid]: Alice })),
                HubSpace.Reasons.notEnabled
            );
        });
    });

    describe('the map', () => {
        it('keeps the model from a snapshot and its changes', () => {
            const model = new HubSpace.SpaceModel();
            assert.equal(
                model.apply({ $type: 'x.change', version: 1, put: {}, remove: {} }),
                false,
                'nothing before a snapshot'
            );
            assert.equal(model.apply(snapshot()), true);
            assert.deepEqual(
                model.places().map(p => p.id),
                ['room:#space', 'leaf:coolbbs', 'leaf:quietbbs']
            );
            assert.deepEqual(
                model.peopleAt('leaf:coolbbs').map(p => p.label),
                ['@alice.example', 'bob via coolbbs']
            );
            model.apply({
                $type: 'nexus.cyberspace.dev.space.change',
                version: 1,
                put: {},
                remove: { presence: ['p1', 'p2'] },
            });
            assert.deepEqual(model.peopleAt('leaf:coolbbs'), []);
            assert.equal(
                model.apply(Object.assign(snapshot(), { version: 2 })),
                false,
                'only version 1'
            );
        });

        it('draws a line a place, the viewer picked out, cut to fit', () => {
            const model = new HubSpace.SpaceModel();
            model.apply(snapshot());
            const lines = HubSpace.renderMap(model, { width: 76, height: 8 }).split('\n');
            assert.equal(lines.length, 3);
            assert.match(lines[0], /^\|11#space +\|08chat +\|14@alice\.example$/);
            assert.match(
                lines[1],
                /^\|15Cool BBS +\|08online +\|14@alice\.example\|08, \|07bob via coolbbs$/
            );
            assert.match(lines[2], /^\|08quietbbs +\|08offline +\|08nobody$/);

            const crowded = new HubSpace.SpaceModel();
            const people = Array.from({ length: 30 }, (_, i) => ({
                id: `person:v:${i}`,
                type: 'person',
                label: `person-number-${i}`,
                did: null,
                kind: 'via',
            }));
            crowded.apply(
                snapshot({
                    entities: [snapshot().entities[1], ...people],
                    presence: people.map(p => ({
                        id: `${p.id}@`,
                        person: p.id,
                        place: 'leaf:coolbbs',
                    })),
                })
            );
            const line = HubSpace.renderMap(crowded, { width: 76 });
            assert.match(line, /\+\d+ more$/);
            assert.ok(
                require('../core/color_codes.js').pipeStringLength(line) <= 76 + 12
            );

            const many = new HubSpace.SpaceModel();
            many.apply(
                snapshot({
                    entities: Array.from({ length: 12 }, (_, i) => ({
                        id: `leaf:b${i}`,
                        type: 'leaf',
                        name: `b${i}`,
                        online: true,
                    })),
                    presence: [],
                })
            );
            const rows = HubSpace.renderMap(many, { width: 76, height: 8 }).split('\n');
            assert.equal(rows.length, 8);
            assert.match(rows[7], /and 5 more places/);
        });

        it('never lets text from elsewhere through as codes', () => {
            const model = new HubSpace.SpaceModel();
            const evil = '|14|UN\x1b[2J\x07owned';
            model.apply(
                snapshot({
                    entities: [
                        {
                            id: 'leaf:x',
                            type: 'leaf',
                            name: 'x',
                            title: '|05Bad\x1b[H',
                            online: true,
                        },
                        {
                            id: 'person:e',
                            type: 'person',
                            label: evil,
                            did: null,
                            kind: 'via',
                        },
                    ],
                    presence: [{ id: 'p', person: 'person:e', place: 'leaf:x' }],
                    you: null,
                })
            );
            const text = HubSpace.renderMap(model);
            assert.equal(text.includes('\x1b'), false);
            assert.equal(text.includes('\x07'), false);
            assert.ok(text.includes('||14||UN[2Jowned'));
            assert.ok(text.includes('||05Bad[H'));
            assert.equal(HubSpace.pipeSafe('a|b\r\nc'), 'a||bc');
        });
    });

    describe('connections', () => {
        let server;
        let wss;
        let origin;
        let upgrades;
        let onConnection;
        let refuseWith;

        beforeEach(async () => {
            upgrades = [];
            refuseWith = null;
            onConnection = () => {};
            wss = new WebSocket.Server({ noServer: true });
            server = http.createServer((req, res) => res.end());
            server.on('upgrade', (req, socket, head) => {
                upgrades.push({
                    url: req.url,
                    auth: req.headers.authorization,
                    origin: req.headers.origin,
                });
                if (refuseWith) {
                    socket.end(`HTTP/1.1 ${refuseWith} No\r\nContent-Length: 0\r\n\r\n`);
                    return;
                }
                wss.handleUpgrade(req, socket, head, ws => onConnection(ws, req));
            });
            await new Promise(r => server.listen(0, '127.0.0.1', r));
            origin = `http://127.0.0.1:${server.address().port}`;
        });

        afterEach(async () => {
            HubSpace._setFetch((...args) => fetch(...args));
            wss.clients.forEach(c => c.terminate());
            await new Promise(r => server.close(r));
        });

        const settings = () => ({ origin, name: 'coolbbs', token: 'hub_secret' });
        const query = () => new URLSearchParams({ bbs: 'coolbbs', did: Alice });

        it('follows the live model with the board token, as the member', async () => {
            let peer;
            onConnection = ws => {
                peer = ws;
                ws.send(JSON.stringify(snapshot()));
            };
            const live = new HubSpace.HubLive(settings(), query());
            const changes = [];
            const ended = [];
            live.on('change', m => changes.push(m.peopleAt('leaf:coolbbs').length));
            live.on('ended', t => ended.push(t));
            live.start();
            await until(() => changes.length, 'the snapshot');
            assert.deepEqual(upgrades[0], {
                url: `/api/bbs/live?bbs=coolbbs&did=${encodeURIComponent(Alice)}`,
                auth: 'Bearer hub_secret',
                origin: undefined,
            });
            peer.send(
                JSON.stringify({
                    $type: 'nexus.cyberspace.dev.space.change',
                    version: 1,
                    put: {},
                    remove: { presence: ['p2'] },
                })
            );
            await until(() => changes.length > 1, 'a change');
            assert.deepEqual(changes, [2, 1]);

            //  dropped: it comes back, with a fresh snapshot
            peer.terminate();
            await until(() => changes.length > 2, 'reconnecting');
            assert.equal(upgrades.length, 2);

            peer.close(HubSpace.AccessEnded, 'access ended');
            await until(() => ended.length, 'the end');
            await wait(100);
            assert.equal(upgrades.length, 2, 'not after access ended');
            live.stop();
        });

        it('stops when the hub refuses it', async () => {
            refuseWith = 403;
            const live = new HubSpace.HubLive(settings(), query());
            const ended = [];
            live.on('ended', t => ended.push(t));
            live.start();
            await until(() => ended.length, 'the refusal');
            await wait(100);
            assert.equal(upgrades.length, 1);
        });

        it('talks in the room as the member, naming others as the hub does', async () => {
            const asked = [];
            HubSpace._setFetch(async (url, options) => {
                asked.push({
                    url: String(url),
                    method: options.method || 'GET',
                    auth: options.headers.Authorization,
                });
                if (String(url).includes('/api/bbs/chat/token')) {
                    return new Response(
                        JSON.stringify({
                            token: 'tok',
                            did: Alice,
                            nick: 'alice-1234',
                            label: '@alice.example',
                            room: '#space',
                            path: '/api/bbs/chat',
                        }),
                        { status: 200 }
                    );
                }
                return new Response(
                    JSON.stringify({
                        here: [{ did: Alice, label: '@alice.example' }],
                        labels: { [Bob]: '@bob.example' },
                    }),
                    { status: 200 }
                );
            });
            const said = [];
            let peer;
            onConnection = ws => {
                peer = ws;
                ws.on('message', data => {
                    for (const line of String(data).split('\r\n').filter(Boolean)) {
                        said.push(line);
                        if (line.startsWith('CAP REQ')) {
                            ws.send(
                                ':freeq CAP * ACK :sasl message-tags server-time echo-message account-tag\r\n'
                            );
                        } else if ('AUTHENTICATE ATPROTO-CHALLENGE' === line) {
                            ws.send('AUTHENTICATE challenge\r\n');
                        } else if (line.startsWith('AUTHENTICATE ')) {
                            ws.send(':freeq 903 alice-1234 :ok\r\n');
                        } else if ('CAP END' === line) {
                            ws.send(':freeq 001 alice-1234 :welcome\r\n');
                        } else if (line.startsWith('JOIN')) {
                            ws.send(':alice-1234!u@h JOIN #space\r\n');
                        }
                    }
                });
            };
            const chat = new HubSpace.HubChat(settings(), query());
            const messages = [];
            const status = [];
            chat.on('message', m => messages.push(m));
            chat.on('status', s => status.push(s));
            chat.start();
            await until(() => status.includes('connected'), 'joining the room');
            assert.deepEqual(asked[0], {
                url: `${origin}/api/bbs/chat/token?bbs=coolbbs&did=${encodeURIComponent(Alice)}`,
                method: 'POST',
                auth: 'Bearer hub_secret',
            });
            assert.equal(upgrades[0].auth, 'Bearer hub_secret');
            const sasl = said.find(l => /^AUTHENTICATE (?!ATPROTO)/.test(l)).slice(13);
            assert.deepEqual(JSON.parse(Buffer.from(sasl, 'base64url').toString()), {
                did: Alice,
                method: 'web-token',
                signature: 'tok',
            });

            //  named by the DID the server attached, not the nick Bob chose
            peer.send(
                `@account=${Bob};time=2026-11-18T10:00:00.000Z :alice-1234!u@h PRIVMSG #space :hi |14\x1b[2Jthere\r\n`
            );
            await until(() => messages.length, 'the message');
            assert.deepEqual(messages[0], {
                label: '@bob.example',
                text: 'hi |14[2Jthere',
                time: '2026-11-18T10:00:00.000Z',
                own: false,
            });

            assert.equal(chat.send('hello'), true);
            await until(() => said.includes('PRIVMSG #space :hello'), 'what Alice said');
            assert.equal(chat.send('x'.repeat(401)), false);
            chat.stop();
        });

        it('only watches when the hub will not let the member talk', async () => {
            HubSpace._setFetch(
                async () =>
                    new Response(
                        JSON.stringify({
                            error: 'Only members who confirmed this BBS at the hub can chat from it.',
                        }),
                        { status: 403 }
                    )
            );
            const chat = new HubSpace.HubChat(settings(), query());
            const ended = [];
            chat.on('ended', t => ended.push(t));
            chat.start();
            await until(() => ended.length, 'the refusal');
            assert.match(ended[0], /confirmed this BBS/);
            assert.equal(upgrades.length, 0);
        });
    });

    it('reads IRC lines, with their tags', () => {
        assert.deepEqual(
            HubSpace.parseIrc(
                '@account=did:plc:x;msg=a\\sb\\:c :nick!u@h PRIVMSG #space :hello there'
            ),
            {
                tags: { account: 'did:plc:x', msg: 'a b;c' },
                nick: 'nick',
                command: 'PRIVMSG',
                params: ['#space', 'hello there'],
            }
        );
        assert.deepEqual(HubSpace.parseIrc('PING :x').params, ['x']);
    });
});
