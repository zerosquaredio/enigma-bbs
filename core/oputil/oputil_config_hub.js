/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//
//  `oputil.js config hub`: set a board up to run behind a Cyberspace hub,
//  from the agent config the hub gave its sysop. Writes the settings a hub
//  board needs into config.hjson, keeps the hub token in a file of its own,
//  and turns on the menu entries for Bluesky login and the hub (commented
//  out in the templates). Safe to run again: it sets the same values, and
//  menus already on are left as they are.
//

const { getConfigPath, argv, getAnswers, writeConfig } = require('./oputil_common.js');

const fs = require('graceful-fs');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');
const dns = require('dns').promises;

exports.handleHubSetup = handleHubSetup;
exports.parseAgentConfig = parseAgentConfig;
exports.applyHubSettings = applyHubSettings;
exports.enableLoginMenu = enableLoginMenu;
exports.enableMainMenu = enableMainMenu;
exports.resolveSysop = resolveSysop;
exports.TokenFile = 'security/hub_token';

const TokenFile = exports.TokenFile;
const DidRe = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+)$/;
const HandleRe =
    /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$/;

//
//  What the board needs from the hub's agent config (frpc, TOML, as the hub
//  writes it): its name on the hub (the proxies' subdomain), the token, the
//  local ports the agent forwards to, and, from the comment lines a hub
//  adds for this, the hub's own address and the board's.
//
function parseAgentConfig(text) {
    const value = key => {
        const m = new RegExp(
            `^\\s*${key.replace(/\./g, '\\.')}\\s*=\\s*"([^"]*)"\\s*$`,
            'm'
        ).exec(text);
        return m ? m[1] : null;
    };
    const comment = key => {
        const m = new RegExp(`^#\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(text);
        return m ? m[1] : null;
    };

    //  each [[proxies]] section: its name and local port
    const proxies = {};
    text.split(/^\s*\[\[proxies\]\]\s*$/m)
        .slice(1)
        .forEach(section => {
            const name = /^\s*name\s*=\s*"([^"]*)"/m.exec(section);
            const port = /^\s*localPort\s*=\s*(\d+)/m.exec(section);
            const subdomain = /^\s*subdomain\s*=\s*"([^"]*)"/m.exec(section);
            if (name && port) {
                proxies[name[1]] = {
                    port: parseInt(port[1], 10),
                    subdomain: subdomain ? subdomain[1] : null,
                };
            }
        });

    const name =
        _.get(proxies, 'web.subdomain') ||
        _.get(proxies, 'ws.subdomain') ||
        value('user');
    const serverName = value('transport.tls.serverName') || value('serverAddr');
    const hubUrl = comment('hub') || (serverName ? `https://${serverName}` : null);
    const boardUrl =
        comment('address') ||
        (name && serverName ? `https://${name}.${serverName}` : null);

    return {
        name,
        token: value('metadatas.token'),
        webPort: _.get(proxies, 'web.port', 8080),
        wsPort: _.get(proxies, 'ws.port', 8810),
        hubUrl,
        boardUrl,
    };
}

//
//  The settings, into |config| (as read with hjson.rt, so its comments
//  stay). Only these keys change; everything else is left as it was.
//
function applyHubSettings(config, settings) {
    const host = new URL(settings.boardUrl).hostname;
    const set = (path, value) => _.set(config, path, value);

    set('contentServers.web.domain', host);
    set('contentServers.web.overrideUrlPrefix', settings.boardUrl);
    set('contentServers.web.proxied', true);
    set('contentServers.web.http.enabled', true);
    set('contentServers.web.http.port', settings.webPort);
    set('contentServers.web.handlers.atProto.enabled', true);

    set('loginServers.webSocket.proxied', true);
    set('loginServers.webSocket.ws.enabled', true);
    set('loginServers.webSocket.ws.port', settings.wsPort);

    if (settings.blueskyOnly) {
        set('users.allowedAuthFactor1Types', ['atproto']);
    }

    set('atProto.enabled', true);
    set('atProto.oauth.clientMode', 'public');
    if (settings.rootDid) {
        set('atProto.login.rootDid', settings.rootDid);
    }
    set('atProto.webSignIn.enabled', true);
    set('atProto.hub.url', settings.hubUrl);
    set('atProto.hub.name', settings.name);
    set('atProto.hub.token', `@file:${TokenFile}`);
    set('atProto.hub.presence.enabled', true);
    set('atProto.publishing.enabled', true);
    return config;
}

//
//  The login menu with its "bluesky login" option on: the template has it
//  commented out. Returns { text, changed }, or null if the option isn't
//  there at all.
//
function enableLoginMenu(text) {
    const commented = /\/\*\s*(\{\s*text:\s*bluesky login\s*data:\s*atproto\s*\})\s*\*\//;
    if (commented.test(text)) {
        return { text: text.replace(commented, '$1'), changed: true };
    }
    return /text:\s*bluesky login/.test(stripComments(text))
        ? { text, changed: false }
        : null;
}

//
//  The main menu with its AT, BA, HP and HS commands on: the template has
//  them in one commented out block. Returns { text, changed }, or null if
//  they aren't there.
//
function enableMainMenu(text) {
    const commented =
        /\/\*((?:(?!\*\/)[\s\S])*?command:\s*"AT"(?:(?!\*\/)[\s\S])*?@menu:hubSpace\s*\})\s*\*\//;
    if (commented.test(text)) {
        return { text: text.replace(commented, '$1'), changed: true };
    }
    return /@menu:boardAtProtoAccount/.test(stripMenuDefinitions(stripComments(text)))
        ? { text, changed: false }
        : null;
}

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

//  the main menu's commands, without the menus they lead to (which name
//  each other too)
function stripMenuDefinitions(text) {
    const at = text.search(/^\s*boardAtProtoAccount\s*:/m);
    return at < 0 ? text : text.slice(0, at);
}

//
//  The sysop's DID, from a handle or a DID: a handle by DNS
//  (_atproto.<handle>), then HTTPS (/.well-known/atproto-did), as AT
//  resolves handles.
//
async function resolveSysop(input, lookup = {}) {
    const resolveTxt = lookup.resolveTxt || (name => dns.resolveTxt(name));
    const fetchText = lookup.fetchText || defaultFetchText;

    const wanted = (input || '').trim().replace(/^@/, '');
    if (DidRe.test(wanted)) {
        return wanted;
    }
    if (!HandleRe.test(wanted)) {
        throw new Error(`"${input}" is neither a Bluesky handle nor a DID`);
    }
    const handle = wanted.toLowerCase();
    try {
        const records = await resolveTxt(`_atproto.${handle}`);
        for (const parts of records) {
            const m = /^did=(\S+)$/.exec(parts.join(''));
            if (m && DidRe.test(m[1])) {
                return m[1];
            }
        }
    } catch (e) {
        //  no TXT record: try HTTPS
    }
    try {
        const text = (
            await fetchText(`https://${handle}/.well-known/atproto-did`)
        ).trim();
        if (DidRe.test(text)) {
            return text;
        }
    } catch (e) {
        //  answered below
    }
    throw new Error(`Couldn't find the account for ${handle}; give its DID instead`);
}

async function defaultFetchText(url) {
    const res = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`${res.status}`);
    }
    return (await res.text()).slice(0, 256);
}

//  the menu files the board uses: its main menu, and what it includes
function menuFiles(config, configDir) {
    const mainPath = paths.resolve(configDir, _.get(config, 'general.menuFile', ''));
    let includes = [];
    try {
        const main = hjson.parse(fs.readFileSync(mainPath, 'utf8'));
        includes = (main.includes || []).map(f =>
            paths.resolve(paths.dirname(mainPath), f)
        );
    } catch (e) {
        //  reported by the caller, which reads it again
    }
    return { mainPath, includes };
}

function ask(questions) {
    return new Promise(resolve => getAnswers(questions, resolve));
}

async function handleHubSetup() {
    const fail = msg => {
        console.error(msg);
        process.exitCode = 1;
    };

    const configPath = getConfigPath();
    const configDir = paths.dirname(configPath);
    let config;
    try {
        config = hjson.rt.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        return fail(
            `Can't read ${configPath} (${e.message}). Make one first: ./oputil.js config new`
        );
    }

    const interactive = process.stdin.isTTY && true !== argv.yes;

    //  the agent config the hub gave
    let agentPath = argv.agent;
    if (!agentPath && interactive) {
        agentPath = (
            await ask([
                { name: 'agent', message: "Path to the hub's agent config (.toml):" },
            ])
        ).agent;
    }
    if (!agentPath) {
        return fail("Give the hub's agent config: --agent PATH");
    }
    let agent;
    try {
        agent = parseAgentConfig(fs.readFileSync(paths.resolve(agentPath), 'utf8'));
    } catch (e) {
        return fail(`Can't read ${agentPath}: ${e.message}`);
    }
    if (!agent.name || !agent.token) {
        return fail(
            `${agentPath} doesn't look like a hub's agent config: no subdomain or token in it`
        );
    }
    const hubUrl = argv.hub || agent.hubUrl;
    const boardUrl = argv.address || agent.boardUrl;
    for (const [what, url] of [
        ['hub', hubUrl],
        ['address', boardUrl],
    ]) {
        if (!url || !/^https:\/\/[^/]+\/?$/.test(url)) {
            return fail(
                `The ${what} address (${url || 'none'}) isn't an https:// address; give it with --${what}`
            );
        }
    }

    //  the sysop
    let sysop = argv.sysop || _.get(config, 'atProto.login.rootDid') || '';
    if (!argv.sysop && interactive) {
        sysop = (
            await ask([
                {
                    name: 'sysop',
                    message:
                        'Your own Bluesky handle or DID (you become the sysop at your first login):',
                    default: sysop || undefined,
                },
            ])
        ).sysop;
    }
    let rootDid = null;
    if (sysop) {
        try {
            rootDid = await resolveSysop(sysop);
        } catch (e) {
            return fail(e.message);
        }
    }

    let blueskyOnly = true === argv['bluesky-only'];
    if (undefined === argv['bluesky-only'] && interactive) {
        blueskyOnly = (
            await ask([
                {
                    name: 'only',
                    type: 'confirm',
                    message:
                        'Bluesky login only, no passwords? (No, if anyone here logs in with a password now)',
                    default: false,
                },
            ])
        ).only;
    }

    const settings = {
        name: agent.name,
        webPort: agent.webPort,
        wsPort: agent.wsPort,
        hubUrl: hubUrl.replace(/\/$/, ''),
        boardUrl: boardUrl.replace(/\/$/, ''),
        rootDid,
        blueskyOnly,
    };

    //  the token, in a file only the board's user reads
    const tokenPath = paths.join(configDir, TokenFile);
    try {
        fs.mkdirSync(paths.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, agent.token + '\n', { mode: 0o600 });
        fs.chmodSync(tokenPath, 0o600);
    } catch (e) {
        return fail(`Can't write the token to ${tokenPath}: ${e.message}`);
    }

    applyHubSettings(config, settings);
    if (!writeConfig(config, configPath)) {
        return fail(`Can't write ${configPath}`);
    }

    //  the menus
    const notes = [];
    const { mainPath, includes } = menuFiles(config, configDir);
    const edit = (path, enable, what) => {
        let text;
        try {
            text = fs.readFileSync(path, 'utf8');
        } catch (e) {
            notes.push(`Couldn't read ${path} to turn on ${what}: ${e.message}`);
            return false;
        }
        const result = enable(text);
        if (!result) {
            return false;
        }
        if (result.changed) {
            fs.writeFileSync(path, result.text, 'utf8');
            console.info(`Turned on ${what} in ${path}`);
        }
        return true;
    };
    if (!edit(mainPath, enableMainMenu, 'the AT, BA, HP and HS commands')) {
        notes.push(
            `The AT, BA, HP and HS commands weren't found in ${mainPath}; add them from misc/menu_templates/main.in.hjson`
        );
    }
    if (
        !includes.some(path => edit(path, enableLoginMenu, 'the "bluesky login" option'))
    ) {
        notes.push(
            'The "bluesky login" option wasn\'t found in the login menu; add it from misc/menu_templates/login.in.hjson'
        );
    }

    console.info(`
Set up for the hub: ${settings.boardUrl} (on ${settings.hubUrl})
  web port ${settings.webPort}, WebSocket port ${settings.wsPort}
  token in ${tokenPath}
  sysop ${rootDid || '(not set: atProto.login.rootDid)'}
  ${blueskyOnly ? 'Bluesky login only' : 'Bluesky login, and passwords as before'}`);
    notes.forEach(note => console.error(`\n  * ${note}`));
    console.info(`
Next: start (or restart) the board and the tunnel agent, open ${settings.boardUrl},
log in with Bluesky, then connect the board's own account from BA in the main menu.
Describe the board for the directory in atProto.publishing.listing (see docs).`);
}
