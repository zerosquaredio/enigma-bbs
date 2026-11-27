'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');
const hjson = require('hjson');

const {
    parseAgentConfig,
    applyHubSettings,
    enableLoginMenu,
    enableMainMenu,
    useFrameworkMenuArt,
    resolveSysop,
} = require('../core/oputil/oputil_config_hub.js');

const Templates = paths.join(__dirname, '../misc/menu_templates');

//  as a hub writes it (nexus-lounge hub/control/src/generate.ts)
const Agent = `#  Tunnel agent (frpc) for coolbbs.hub.example, made by the hub.
#  The token is a password for this BBS on the hub: keep this file private.
#  For the board's own setup (ENiGMA½: oputil.js config hub --agent FILE):
#  hub: https://hub.example
#  address: https://coolbbs.hub.example
serverAddr = "hub.example"
serverPort = 7000
user = "coolbbs"
metadatas.token = "hub_abc123"
loginFailExit = false
transport.tls.enable = true
#  check the hub's certificate before sending the token
transport.tls.serverName = "hub.example"
transport.tls.useSystemCa = true
transport.heartbeatInterval = 20
transport.heartbeatTimeout = 60

[[proxies]]
name = "ws"
type = "http"
localIP = "127.0.0.1"
localPort = 9810
subdomain = "coolbbs"
locations = ["/ws"]
requestHeaders.set.x-forwarded-proto = "https"

[[proxies]]
name = "web"
type = "http"
localIP = "127.0.0.1"
localPort = 9080
subdomain = "coolbbs"
locations = ["/_enig/atproto/", "/_enig/handoff/", "/_enig/signin", "/_enig/signout", "/assets/"]
requestHeaders.set.x-forwarded-proto = "https"
`;

describe('oputil config hub', () => {
    describe('reading the agent config', () => {
        it('takes the name, token, ports and addresses', () => {
            assert.deepEqual(parseAgentConfig(Agent), {
                name: 'coolbbs',
                token: 'hub_abc123',
                webPort: 9080,
                wsPort: 9810,
                hubUrl: 'https://hub.example',
                boardUrl: 'https://coolbbs.hub.example',
            });
        });

        it("works out the addresses from the hub's name when a config has no comments for them", () => {
            const older = Agent.replace(/^# {2}(hub|address):.*\n/gm, '');
            const got = parseAgentConfig(older);
            assert.equal(got.hubUrl, 'https://hub.example');
            assert.equal(got.boardUrl, 'https://coolbbs.hub.example');
        });

        it('finds no name or token in something else', () => {
            const got = parseAgentConfig('[common]\nserver_addr = 1.2.3.4\n');
            assert.equal(got.name, null);
            assert.equal(got.token, null);
        });
    });

    describe('the settings', () => {
        const settings = {
            name: 'coolbbs',
            webPort: 9080,
            wsPort: 9810,
            hubUrl: 'https://hub.example',
            boardUrl: 'https://coolbbs.hub.example',
            rootDid: 'did:plc:abcdefghijklmnopqrstuvwx',
            blueskyOnly: false,
        };
        const template = () =>
            hjson.rt.parse(
                fs.readFileSync(
                    paths.join(__dirname, '../misc/config_template.in.hjson'),
                    'utf8'
                )
            );

        it('sets what a hub board needs, and keeps the rest', () => {
            const config = template();
            config.general = { boardName: 'Cool BBS' };
            applyHubSettings(config, settings);
            assert.equal(config.general.boardName, 'Cool BBS');
            assert.equal(config.contentServers.web.domain, 'coolbbs.hub.example');
            assert.equal(
                config.contentServers.web.overrideUrlPrefix,
                'https://coolbbs.hub.example'
            );
            assert.equal(config.contentServers.web.proxied, true);
            assert.deepEqual(
                [
                    config.contentServers.web.http.enabled,
                    config.contentServers.web.http.port,
                ],
                [true, 9080]
            );
            assert.equal(config.contentServers.web.handlers.atProto.enabled, true);
            assert.equal(config.loginServers.webSocket.proxied, true);
            assert.deepEqual(
                [
                    config.loginServers.webSocket.ws.enabled,
                    config.loginServers.webSocket.ws.port,
                ],
                [true, 9810]
            );
            assert.equal(config.atProto.enabled, true);
            assert.equal(config.atProto.oauth.clientMode, 'public');
            assert.equal(config.atProto.login.rootDid, settings.rootDid);
            assert.equal(config.atProto.webSignIn.enabled, true);
            assert.deepEqual(config.atProto.hub, {
                url: 'https://hub.example',
                name: 'coolbbs',
                token: '@file:security/hub_token',
                presence: { enabled: true },
            });
            assert.equal(config.atProto.publishing.enabled, true);
            assert.equal(
                config.users.allowedAuthFactor1Types,
                undefined,
                'passwords kept unless asked'
            );
        });

        it('leaves login types, and a sysop already set, unless told', () => {
            const config = {
                atProto: { login: { rootDid: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' } },
            };
            applyHubSettings(config, Object.assign({}, settings, { rootDid: null }));
            assert.equal(
                config.atProto.login.rootDid,
                'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'
            );
            applyHubSettings(config, Object.assign({}, settings, { blueskyOnly: true }));
            assert.deepEqual(config.users.allowedAuthFactor1Types, ['atproto']);
        });

        it('keeps the comments in the file', () => {
            const config = template();
            applyHubSettings(config, settings);
            const text = hjson.stringify(config, { keepWsc: true });
            assert.match(text, /\/\//, 'comments kept');
            assert.equal(hjson.parse(text).atProto.hub.name, 'coolbbs');
        });
    });

    describe('the menus', () => {
        it('turns on the "bluesky login" option of the login menu template, once', () => {
            const text = fs.readFileSync(paths.join(Templates, 'login.in.hjson'), 'utf8');
            const first = enableLoginMenu(text);
            assert.equal(first.changed, true);
            const menu = hjson.parse(first.text);
            const items = JSON.stringify(menu);
            assert.match(items, /"text":"bluesky login","data":"atproto"/);
            const again = enableLoginMenu(first.text);
            assert.deepEqual(again, { text: first.text, changed: false });
        });

        it('turns on the AT, BA, HP and HS commands of the main menu template, once', () => {
            const text = fs.readFileSync(paths.join(Templates, 'main.in.hjson'), 'utf8');
            const first = enableMainMenu(text);
            assert.equal(first.changed, true);
            const menu = hjson.parse(first.text.replace(/%INCLUDE_FILES%/g, ''));
            const commands = JSON.stringify(menu);
            const hint = menu.prompts.mainMenuCommand.mci.TL52;
            assert.match(hint.text, /HS around/, 'and the hint naming them');
            assert.deepEqual(hint.position, { row: 1, col: 37 });
            assert.equal(menu.menus.mainMenu.prompt, 'mainMenuCommand');
            for (const command of ['AT', 'BA', 'HP', 'HS']) {
                assert.match(commands, new RegExp(`"command":"${command}"`));
                assert.doesNotMatch(
                    JSON.stringify(hjson.parse(text.replace(/%INCLUDE_FILES%/g, ''))),
                    new RegExp(`"command":"${command}"`),
                    'off in the template'
                );
            }
            assert.deepEqual(enableMainMenu(first.text), {
                text: first.text,
                changed: false,
            });
        });

        it('finds nothing to turn on in menus without them', () => {
            assert.equal(enableLoginMenu('{ menus: {} }'), null);
            assert.equal(enableMainMenu('{ menus: {} }'), null);
            //  the menus the commands lead to don't count as the commands
            assert.equal(
                enableMainMenu(
                    '{ menus: {\n  boardAtProtoAccount: { action: @menu:boardAtProtoAccount } } }'
                ),
                null
            );
        });
    });

    describe("the framework's main menu art", () => {
        it("replaces the template's MMENU in the main menu, and nothing else", () => {
            const text = fs.readFileSync(paths.join(Templates, 'main.in.hjson'), 'utf8');
            const result = useFrameworkMenuArt(text);
            assert.equal(result.changed, true);
            const menus = hjson.parse(result.text).menus;
            assert.equal(menus.mainMenu.art, 'CYBMENU');
            //  every other menu as it was
            const before = hjson.parse(text).menus;
            for (const name of Object.keys(before).filter(n => 'mainMenu' !== n)) {
                assert.deepEqual(menus[name], before[name], name);
            }
            //  and again: nothing more to change
            assert.equal(useFrameworkMenuArt(result.text), null);
        });

        it('leaves art the sysop named alone', () => {
            const own = '{ menus: { mainMenu: { desc: Main, art: MYMENU, prompt: x } } }';
            assert.equal(useFrameworkMenuArt(own), null);
            assert.equal(useFrameworkMenuArt('{ menus: {} }'), null);
        });

        it('is art that exists, and draws as the stock menu does', () => {
            const art = fs.readFileSync(
                paths.join(__dirname, '../art/general/CYBMENU.ANS')
            );
            const body = art.subarray(0, art.indexOf(0x1a)).toString('latin1');
            for (const code of ['%BN(l)', '%RR1', '%ND']) {
                assert.ok(body.includes(code), code);
            }
            //  full-width rows wrap, as on a BBS terminal: no line breaks
            assert.ok(!body.includes('\r\n'));
        });
    });

    describe("the sysop's account", () => {
        const Did = 'did:plc:abcdefghijklmnopqrstuvwx';
        const none = {
            resolveTxt: async () => {
                throw Object.assign(new Error('no record'), { code: 'ENODATA' });
            },
            fetchText: async () => {
                throw new Error('404');
            },
        };

        it('takes a DID as it is', async () => {
            assert.equal(await resolveSysop(Did, none), Did);
        });

        it('finds a handle by DNS, then HTTPS', async () => {
            const asked = [];
            const byDns = {
                resolveTxt: async name => {
                    asked.push(name);
                    return [['did=', Did]];
                },
                fetchText: none.fetchText,
            };
            assert.equal(await resolveSysop('@Alice.Example.com', byDns), Did);
            assert.deepEqual(asked, ['_atproto.alice.example.com']);
            const byHttps = {
                resolveTxt: none.resolveTxt,
                fetchText: async () => `${Did}\n`,
            };
            assert.equal(await resolveSysop('alice.bsky.social', byHttps), Did);
        });

        it("says so when it can't", async () => {
            await assert.rejects(
                resolveSysop('alice.bsky.social', none),
                /give its DID instead/
            );
            await assert.rejects(
                resolveSysop('not a handle', none),
                /neither a Bluesky handle nor a DID/
            );
            const junk = { resolveTxt: none.resolveTxt, fetchText: async () => '<html>' };
            await assert.rejects(
                resolveSysop('alice.bsky.social', junk),
                /give its DID instead/
            );
        });
    });
});
