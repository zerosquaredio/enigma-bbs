/* jslint node: true */
'use strict';

//
//  The hub's common space inside the board (F19): what the hub_space menu
//  module shows, kept apart from the screen so it can be tested.
//
//  The board opens two connections to its hub for a member in the door,
//  each with its tunnel token (atProto.hub, as for presence reports) and
//  naming the member as the presence report does, by DID or user name:
//
//    - The live model (/api/bbs/live): who is where on the hub, as a
//      snapshot and then changes, drawn as a short list of places.
//    - The hub's chat room (/api/bbs/chat), an IRC connection through the
//      hub. Only for members who confirmed this board at the hub: the hub
//      never lets a board speak as an account on its word alone. Senders are
//      named by the hub, from the DID the chat server attaches to each
//      message, never by the nick a client chose.
//
//  Text from other boards and people only ever reaches the screen cleaned of
//  control codes, with any pipe code in it escaped.
//

//  ENiGMA½
const HubPresence = require('./hub_presence.js');
const UserProps = require('../user_property.js');

//  deps
const EventEmitter = require('events');
const WebSocket = require('ws');

exports.LivePath = '/api/bbs/live';
exports.ChatTokenPath = '/api/bbs/chat/token';
exports.ChatPeoplePath = '/api/bbs/chat/people';
exports.MutePath = '/api/bbs/mute';
exports.MutesPath = '/api/bbs/mutes';
exports.ReportPath = '/api/bbs/report';
exports.LiveVersion = 1;
//  closed by the hub because access ended: don't just reconnect
exports.AccessEnded = 4403;
exports.MaxChatBytes = 400;

exports.memberQuery = memberQuery;
exports.clean = clean;
exports.pipeSafe = pipeSafe;
exports.SpaceModel = SpaceModel;
exports.renderMap = renderMap;
exports.parseIrc = parseIrc;
exports.hubCall = hubCall;
exports.findPerson = findPerson;

//  test hooks
let fetchImpl = (...args) => fetch(...args);
exports._setFetch = fn => {
    fetchImpl = fn;
};
exports._setRetryMs = fn => {
    retryMs = fn;
};

let retryMs = attempt => Math.min(30, Math.pow(2, attempt)) * 1000;
const RequestTimeoutMs = 15 * 1000;
const MaxFrame = 4 * 1024 * 1024;
const MaxLabelLookups = 50;
const PeopleRefreshMs = 10 * 1000;

const Reasons = {
    notEnabled: 'This board is not connected to a hub.',
    withheld: "The sysop has kept you off the hub's space.",
    notShown:
        "Turn on being shown on the hub first (Hub Presence in your settings): the hub's " +
        'space is for members the board tells it about.',
    noAccount:
        'You have no Bluesky account linked, and this board tells the hub only about ' +
        'members who do.',
};
exports.Reasons = Reasons;

//
//  How the hub knows this member: the board's settings, and the query that
//  names them, as the presence report does. { settings, query } or { reason }
//
function memberQuery(user) {
    if (!HubPresence.isEnabled()) {
        return { reason: Reasons.notEnabled };
    }
    const { settings, reason } = HubPresence.hubSettings();
    if (!settings) {
        return { reason: `${Reasons.notEnabled} (${reason})` };
    }
    if (HubPresence.isWithheld(user)) {
        return { reason: Reasons.withheld };
    }
    if (!HubPresence.isShown(user)) {
        return { reason: Reasons.notShown };
    }
    const did = user.getProperty(UserProps.AtProtoDid);
    if (!did && !settings.includeLocalUsers) {
        return { reason: Reasons.noAccount };
    }
    const query = new URLSearchParams({ bbs: settings.name });
    if (did) {
        query.set('did', did);
    } else {
        query.set('user', user.username);
    }
    return { settings, query, did: did || null };
}

//  Text from elsewhere: no control codes of any kind, at most |max| long
function clean(text, max = 200) {
    return (
        String(text || '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .slice(0, max)
    );
}

//  ...and safe to put into pipe-coded text: '||' is a literal '|'
function pipeSafe(text, max) {
    return clean(text, max).replace(/\|/g, '||');
}

function wsUrl(settings, path, query) {
    return `${settings.origin.replace(/^http/, 'ws')}${path}?${query.toString()}`;
}

//
//  A call to the hub for this member, with the board's token: resolves with
//  { status, body }, body {} when there is none
//
function hubCall(settings, query, method, path, body) {
    return fetchImpl(`${settings.origin}${path}?${query.toString()}`, {
        method,
        headers: Object.assign(
            { Authorization: `Bearer ${settings.token}` },
            body ? { 'Content-Type': 'application/json' } : {}
        ),
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(RequestTimeoutMs),
    }).then(res =>
        res.json().then(
            json => ({
                status: res.status,
                body: json && 'object' === typeof json ? json : {},
            }),
            () => ({ status: res.status, body: {} })
        )
    );
}

//
//  Who a member means, from what they typed after a command: the person
//  whose name starts it (the longest, so "bob via coolbbs" beats "bob"),
//  with or without the @, and what follows it. people: [{ id, label }]
//
function findPerson(people, text) {
    const said = String(text || '').trim();
    const lower = said.toLowerCase();
    let best = null;
    for (const person of people) {
        const label = String(person.label || '');
        for (const name of [label, label.replace(/^@/, '')]) {
            const n = name.toLowerCase();
            if (
                n &&
                (lower === n || lower.startsWith(`${n} `)) &&
                (!best || n.length > best.length)
            ) {
                best = { person, length: n.length };
            }
        }
    }
    return best ? { person: best.person, rest: said.slice(best.length).trim() } : null;
}

//
//  Why the hub refused a connection, if it said: its JSON error, cleaned
//
function refusal(req, res, cb) {
    let text = '';
    let done = false;
    const finish = () => {
        if (done) {
            return;
        }
        done = true;
        req.destroy();
        let error = null;
        try {
            error = JSON.parse(text).error;
        } catch (e) {
            //  no reason given
        }
        return cb('string' === typeof error && error ? clean(error, 300) : null);
    };
    res.setEncoding('utf8');
    res.on('data', d => {
        text += d;
        if (text.length > 4096) {
            finish();
        }
    });
    res.on('end', finish);
    res.on('error', finish);
    res.on('close', finish);
}

//  ── The live model ─────────────────────────────────────────────────────────

const Collections = ['entities', 'presence', 'groups', 'links'];

function SpaceModel() {
    this.reset();
}

SpaceModel.prototype.reset = function () {
    this.ready = false;
    this.you = null;
    this.base = null;
    this.state = {};
    for (const c of Collections) {
        this.state[c] = new Map();
    }
};

//  A message from the stream; true if it changed what is shown
SpaceModel.prototype.apply = function (message) {
    if (
        !message ||
        exports.LiveVersion !== message.version ||
        'string' !== typeof message.$type
    ) {
        return false;
    }
    const each = (list, fn) => (Array.isArray(list) ? list.forEach(fn) : null);
    if (message.$type.endsWith('.snapshot')) {
        this.reset();
        this.ready = true;
        this.you = 'string' === typeof message.you ? message.you : null;
        this.base = message.$type.slice(0, -'.snapshot'.length);
        for (const c of Collections) {
            each(
                message[c],
                x => x && 'string' === typeof x.id && this.state[c].set(x.id, x)
            );
        }
        return true;
    }
    if (!this.ready || !message.$type.endsWith('.change')) {
        return false;
    }
    for (const c of Collections) {
        each(
            (message.put || {})[c],
            x => x && 'string' === typeof x.id && this.state[c].set(x.id, x)
        );
        each((message.remove || {})[c], id => this.state[c].delete(id));
    }
    return true;
};

//  The room first, then boards that are up, then the rest, each by name
SpaceModel.prototype.places = function () {
    const rooms = [];
    const up = [];
    const down = [];
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    for (const e of this.state.entities.values()) {
        if ('room' === e.type) {
            rooms.push(e);
        } else if ('leaf' === e.type) {
            (e.online ? up : down).push(e);
        }
    }
    return [...rooms.sort(byName), ...up.sort(byName), ...down.sort(byName)];
};

//  Who is at a place: the viewer first, then by name
SpaceModel.prototype.peopleAt = function (placeId) {
    const out = [];
    for (const p of this.state.presence.values()) {
        const person = this.state.entities.get(p.person);
        if (p.place === placeId && person && !out.includes(person)) {
            out.push(person);
        }
    }
    return out.sort(
        (a, b) =>
            (b.id === this.you) - (a.id === this.you) ||
            String(a.label).localeCompare(String(b.label))
    );
};

//  The live objects of a place, by id (build spec of the live object slice)
SpaceModel.prototype.objectsAt = function (placeId) {
    const out = [];
    for (const e of this.state.entities.values()) {
        if ('object' === e.type && e.owner === placeId) {
            out.push(e);
        }
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

//  Everyone the model shows, but the viewer: [{ id, label }]
SpaceModel.prototype.people = function () {
    const out = [];
    for (const e of this.state.entities.values()) {
        if ('person' === e.type && e.id !== this.you) {
            out.push({ id: e.id, label: String(e.label || '') });
        }
    }
    return out;
};

//  The label of whoever has this DID, if the model shows them
SpaceModel.prototype.labelFor = function (did) {
    for (const e of this.state.entities.values()) {
        if ('person' === e.type && e.did === did) {
            return e.label;
        }
    }
    return null;
};

//  The weather type's WMO codes in words, by the lowest code of each kind
const Skies = [
    [0, 'clear'],
    [1, 'mainly clear'],
    [2, 'partly cloudy'],
    [3, 'overcast'],
    [45, 'fog'],
    [51, 'drizzle'],
    [61, 'rain'],
    [71, 'snow'],
    [80, 'showers'],
    [85, 'snow showers'],
    [95, 'thunderstorm'],
];

//  A live object's values in words: for the weather, the sky and the
//  temperature in both scales, as a terminal can't offer a choice
function describeObject(o) {
    const v = o.values && 'object' === typeof o.values ? o.values : {};
    const parts = [];
    if ('weather' === o.kind) {
        if (Number.isFinite(v.code)) {
            const sky = Skies.filter(([from]) => v.code >= from).pop();
            if (sky) {
                parts.push(sky[1]);
            }
        }
        if (Number.isFinite(v.temperature)) {
            const c = Math.round(v.temperature * 10) / 10;
            const f = Math.round(v.temperature * 1.8 + 32);
            parts.push(`${c}°C (${f}°F)`);
        }
    }
    return parts.length ? parts.join(', ') : 'no reading yet';
}

//
//  The model as lines of pipe-coded text, one a place: its name, whether it
//  is up, and who is there, then a line for each of its live objects, cut
//  to |width| columns and |height| lines
//
function renderMap(model, { width = 76, height = 8 } = {}) {
    if (!model.ready) {
        return '|08Connecting to the hub...';
    }
    const places = model.places();
    if (!places.length) {
        return '|08Nothing on the hub yet.';
    }
    const NameWidth = 18;
    const StateWidth = 9;
    const room = Math.max(10, width - NameWidth - StateWidth);
    const lines = places
        .map(place => {
            const name =
                'room' === place.type ? place.name : place.title || place.name || '';
            const shown = clean(name, NameWidth - 1).padEnd(NameWidth);
            const state = (
                'room' === place.type ? 'chat' : place.online ? 'online' : 'offline'
            ).padEnd(StateWidth);
            const people = model.peopleAt(place.id);
            let used = 0;
            const names = [];
            for (let i = 0; i < people.length; i++) {
                const label = clean(people[i].label, 40);
                const more = people.length - i - 1;
                const tail = more ? ` +${more}` : '';
                if (used + label.length + (names.length ? 2 : 0) + tail.length > room) {
                    names.push(`|08+${people.length - i} more`);
                    break;
                }
                used += label.length + (names.length ? 2 : 0);
                const color = people[i].id === model.you ? '|14' : '|07';
                names.push(`${color}${label.replace(/\|/g, '||')}`);
            }
            const nameColor =
                'room' === place.type ? '|11' : place.online ? '|15' : '|08';
            const line = `${nameColor}${shown.replace(/\|/g, '||')}|08${state}${
                names.length ? names.join('|08, ') : '|08nobody'
            }`;
            //  its live objects, each on a line of its own beneath it, and the
            //  credit their data needs on one line after them, each named once
            const shownObjects = model.objectsAt(place.id);
            const objects = shownObjects.map(o => {
                const said = `${clean(o.title, 40)}: ${describeObject(o)}${
                    o.stale ? ', not updated lately' : ''
                }`;
                return `  ${o.stale ? '|08' : '|03'}${pipeSafe(said, width - 2)}`;
            });
            const credits = [
                ...new Set(
                    shownObjects.flatMap(o =>
                        ((o.look && o.look.credit) || [])
                            .map(c => c && clean(c.text, 80))
                            .filter(Boolean)
                    )
                ),
            ];
            if (credits.length) {
                objects.push(`  |08${pipeSafe(credits.join('; '), width - 2)}`);
            }
            return [line, ...objects];
        })
        .flat();
    if (lines.length > height) {
        const hidden = lines.length - height + 1;
        return [...lines.slice(0, height - 1), `|08...and ${hidden} more places`].join(
            '\n'
        );
    }
    return lines.join('\n');
}

//  ── Connections ────────────────────────────────────────────────────────────

//
//  The live model for one member. Events: 'change' (the model), 'status'
//  (text), 'ended' (access ended, or the hub said no: not retried)
//
class HubLive extends EventEmitter {
    constructor(settings, query) {
        super();
        this.settings = settings;
        this.query = query;
        this.model = new SpaceModel();
        this.stopped = false;
        this.attempts = 0;
        this.ws = null;
        this.timer = null;
    }

    start() {
        this.connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {});
            this.ws.terminate();
            this.ws = null;
        }
    }

    end(text) {
        this.emit('ended', text);
        this.stop();
    }

    retry() {
        if (this.stopped || this.timer) {
            return;
        }
        const wait = retryMs(++this.attempts);
        this.emit('status', `Reconnecting to the hub in ${Math.round(wait / 1000)}s...`);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.connect();
        }, wait);
        this.timer.unref();
    }

    connect() {
        if (this.stopped) {
            return;
        }
        const ws = new WebSocket(wsUrl(this.settings, exports.LivePath, this.query), {
            headers: { Authorization: `Bearer ${this.settings.token}` },
            perMessageDeflate: false,
            maxPayload: MaxFrame,
            handshakeTimeout: RequestTimeoutMs,
            followRedirects: false,
        });
        this.ws = ws;
        ws.on('unexpected-response', (req, res) => {
            this.ws = null;
            if (![401, 403, 404].includes(res.statusCode)) {
                req.destroy();
                return this.retry();
            }
            //  the hub says why: who blocked them, for one
            return refusal(req, res, why =>
                this.end(
                    why ||
                        (401 === res.statusCode
                            ? 'The hub does not know this board.'
                            : 'The hub does not let you into its space right now.')
                )
            );
        });
        ws.on('message', data => {
            let message;
            try {
                message = JSON.parse(data.toString('utf8'));
            } catch (e) {
                return;
            }
            if (
                message &&
                'string' === typeof message.$type &&
                message.$type.endsWith('.snapshot')
            ) {
                this.attempts = 0;
                this.emit('status', 'live');
            }
            if (this.model.apply(message)) {
                this.emit('change', this.model);
            }
        });
        ws.on('close', (code, reason) => {
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            if (exports.AccessEnded === code) {
                const why = clean(reason, 120);
                return this.end(
                    /^blocked by /.test(why)
                        ? `You were ${why}.`
                        : "You are no longer in the hub's space."
                );
            }
            return this.retry();
        });
        ws.on('error', () => {});
    }
}

//  An IRC line: tags, the sender's nick, the command and its parameters
function parseIrc(line) {
    const out = { tags: {}, nick: '', command: '', params: [] };
    let rest = String(line || '');
    if ('@' === rest[0]) {
        const at = rest.indexOf(' ');
        for (const tag of rest.slice(1, at < 0 ? undefined : at).split(';')) {
            const eq = tag.indexOf('=');
            const key = eq < 0 ? tag : tag.slice(0, eq);
            const value = eq < 0 ? '' : tag.slice(eq + 1);
            out.tags[key] = value.replace(/\\(.)/g, (m, c) =>
                Object.prototype.hasOwnProperty.call(TagEscapes, c) ? TagEscapes[c] : c
            );
        }
        rest = at < 0 ? '' : rest.slice(at + 1);
    }
    if (':' === rest[0]) {
        const at = rest.indexOf(' ');
        out.nick = rest.slice(1, at < 0 ? undefined : at).split('!')[0];
        rest = at < 0 ? '' : rest.slice(at + 1);
    }
    const colon = ':' === rest[0] ? 0 : rest.indexOf(' :');
    const words = (colon < 0 ? rest : rest.slice(0, colon)).split(' ').filter(Boolean);
    if (colon >= 0) {
        words.push(rest.slice(colon + (0 === colon ? 1 : 2)));
    }
    out.command = (words.shift() || '').toUpperCase();
    out.params = words;
    return out;
}
const TagEscapes = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' };

//
//  The hub's chat room for one member, as themselves. Events: 'status'
//  (text, or 'connected'), 'message' ({ label, text, time, own }), 'people'
//  (labels of who is in the room), 'notice' (text), 'ended' (text: not retried)
//
class HubChat extends EventEmitter {
    constructor(settings, query) {
        super();
        this.settings = settings;
        this.query = query;
        this.stopped = false;
        this.attempts = 0;
        this.ticket = null;
        this.ws = null;
        this.timer = null;
        this.labels = new Map();
        //  who is in the room, as the hub last said, and whom this member
        //  muted (by DID): their messages aren't shown
        this.here = [];
        this.muted = new Set();
        //  messages waiting for their sender's name, in order
        this.queue = [];
        this.lookup = null;
        this.peopleTimer = null;
        this.joined = false;
    }

    start() {
        this.login();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        clearTimeout(this.lookup);
        clearInterval(this.peopleTimer);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {});
            this.ws.terminate();
            this.ws = null;
        }
    }

    end(text) {
        this.emit('ended', text);
        this.stop();
    }

    retry() {
        if (this.stopped || this.timer) {
            return;
        }
        this.joined = false;
        const wait = retryMs(++this.attempts);
        this.emit('status', `Reconnecting to chat in ${Math.round(wait / 1000)}s...`);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.login();
        }, wait);
        this.timer.unref();
    }

    url(path) {
        return `${this.settings.origin}${path}?${this.query.toString()}`;
    }

    request(method, url) {
        return fetchImpl(url, {
            method,
            headers: { Authorization: `Bearer ${this.settings.token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(RequestTimeoutMs),
        });
    }

    //  A single-use login from the hub, then the connection
    login() {
        if (this.stopped) {
            return;
        }
        this.request('POST', this.url(exports.ChatTokenPath)).then(
            res =>
                res.json().then(
                    body => {
                        if (
                            403 === res.status ||
                            401 === res.status ||
                            404 === res.status
                        ) {
                            return this.end(
                                clean(
                                    (body && body.error) ||
                                        'The hub does not let you chat right now.'
                                )
                            );
                        }
                        if (!res.ok || !body || 'string' !== typeof body.token) {
                            return this.retry();
                        }
                        return this.open(body);
                    },
                    () => this.retry()
                ),
            () => this.retry()
        );
    }

    raw(line) {
        if (this.ws && WebSocket.OPEN === this.ws.readyState) {
            this.ws.send(`${line}\r\n`);
        }
    }

    open(ticket) {
        this.ticket = ticket;
        this.labels.set(ticket.did, clean(ticket.label, 80));
        const ws = new WebSocket(wsUrl(this.settings, ticket.path, this.query), {
            headers: { Authorization: `Bearer ${this.settings.token}` },
            perMessageDeflate: false,
            maxPayload: 64 * 1024,
            handshakeTimeout: RequestTimeoutMs,
            followRedirects: false,
        });
        this.ws = ws;
        ws.on('unexpected-response', (req, res) => {
            this.ws = null;
            if (![401, 403, 404].includes(res.statusCode)) {
                req.destroy();
                return this.retry();
            }
            return refusal(req, res, why =>
                this.end(why || 'The hub does not let you chat right now.')
            );
        });
        ws.on('open', () => {
            this.raw('CAP LS 302');
            this.raw(`NICK ${ticket.nick}`);
            this.raw('USER chat 0 * :chat');
            this.raw('CAP REQ :sasl message-tags server-time echo-message account-tag');
        });
        ws.on('message', data => {
            String(data)
                .split(/\r?\n/)
                .filter(Boolean)
                .forEach(line => this.onLine(line));
        });
        ws.on('close', () => {
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            clearInterval(this.peopleTimer);
            this.emit('people', []);
            return this.retry();
        });
        ws.on('error', () => {});
    }

    sameRoom(name) {
        return String(name || '').toLowerCase() === this.ticket.room.toLowerCase();
    }

    onLine(line) {
        const m = parseIrc(line);
        const p = m.params;
        const last = p[p.length - 1] || '';
        switch (m.command) {
            case 'PING':
                return this.raw(`PONG :${last}`);
            case 'CAP':
                if ('ACK' === String(p[1] || '').toUpperCase()) {
                    this.raw('AUTHENTICATE ATPROTO-CHALLENGE');
                }
                return;
            case 'AUTHENTICATE':
                return this.raw(
                    `AUTHENTICATE ${Buffer.from(
                        JSON.stringify({
                            did: this.ticket.did,
                            method: 'web-token',
                            signature: this.ticket.token,
                        })
                    ).toString('base64url')}`
                );
            case '903':
                return this.raw('CAP END');
            case '904':
            case '905':
            case '906':
                return this.end('Could not sign in to chat.');
            case '001':
                this.ticket.nick = p[0] || this.ticket.nick;
                return this.raw(`JOIN ${this.ticket.room}`);
            case '433':
                this.ticket.nick = `${this.ticket.nick}_`;
                return this.raw(`NICK ${this.ticket.nick}`);
            case 'JOIN':
                if (
                    this.sameRoom(p[0]) &&
                    m.nick.toLowerCase() === this.ticket.nick.toLowerCase()
                ) {
                    this.attempts = 0;
                    this.joined = true;
                    this.emit('status', 'connected');
                    clearInterval(this.peopleTimer);
                    this.peopleTimer = setInterval(
                        () => this.refreshPeople(),
                        PeopleRefreshMs
                    );
                    this.peopleTimer.unref();
                }
                return this.refreshPeople();
            case 'PART':
            case 'QUIT':
            case 'KICK':
                return this.refreshPeople();
            case 'PRIVMSG':
                if (this.sameRoom(p[0]) && !last.startsWith('\x01')) {
                    this.received(m.tags.account || null, last, m.tags.time || null);
                }
                return;
        }
    }

    //  Each message waits for its sender's name, so they stay in order
    received(did, text, time) {
        if (did && this.muted.has(did)) {
            return;
        }
        this.queue.push({ did, text: clean(text, 1000), time });
        if (did && !this.labels.has(did)) {
            this.lookupSoon();
        }
        this.flush();
    }

    flush() {
        while (this.queue.length) {
            const next = this.queue[0];
            if (next.did && !this.labels.has(next.did)) {
                return;
            }
            this.queue.shift();
            if (next.did && this.muted.has(next.did)) {
                continue;
            }
            this.emit('message', {
                label: next.did ? this.labels.get(next.did) : 'someone',
                text: next.text,
                time: next.time,
                own: !!this.ticket && next.did === this.ticket.did,
            });
        }
    }

    lookupSoon() {
        if (this.lookup) {
            return;
        }
        this.lookup = setTimeout(() => {
            this.lookup = null;
            const wanted = [
                ...new Set(
                    this.queue.map(q => q.did).filter(d => d && !this.labels.has(d))
                ),
            ];
            this.people(wanted.slice(0, MaxLabelLookups), () => {
                //  anyone the hub couldn't name is shown by their DID
                for (const did of wanted) {
                    if (!this.labels.has(did)) {
                        this.labels.set(did, clean(did, 80));
                    }
                }
                this.flush();
            });
        }, 150);
        this.lookup.unref();
    }

    refreshPeople() {
        this.people([], here => {
            if (here) {
                this.emit('people', here);
            }
        });
    }

    //  Who is in the room, and names for |dids|, from the hub
    people(dids, cb) {
        const query = new URLSearchParams(this.query);
        dids.forEach(did => query.append('label', did));
        fetchImpl(
            `${this.settings.origin}${exports.ChatPeoplePath}?${query.toString()}`,
            {
                headers: { Authorization: `Bearer ${this.settings.token}` },
                redirect: 'error',
                signal: AbortSignal.timeout(RequestTimeoutMs),
            }
        )
            .then(res => (res.ok ? res.json() : null))
            .then(
                body => {
                    const labels = (body && body.labels) || {};
                    for (const did of Object.keys(labels)) {
                        this.labels.set(did, clean(labels[did], 80));
                    }
                    if (body && Array.isArray(body.muted)) {
                        this.muted = new Set(
                            body.muted.filter(d => 'string' === typeof d)
                        );
                    }
                    if (body && Array.isArray(body.here)) {
                        this.here = body.here
                            .filter(h => h && 'string' === typeof h.did)
                            .map(h => ({ did: h.did, label: clean(h.label, 80) }));
                    }
                    const here = Array.isArray(body && body.here)
                        ? body.here.map(h => {
                              this.labels.set(h.did, clean(h.label, 80));
                              return clean(h.label, 80);
                          })
                        : null;
                    return cb(here);
                },
                () => cb(null)
            );
    }

    //  Who is in the room but the member: [{ id, label }], as the model names them
    inRoom() {
        const mine = this.ticket ? this.ticket.did : null;
        return this.here
            .filter(h => h.did !== mine)
            .map(h => ({ id: `person:${h.did}`, label: h.label }));
    }

    //  What the member typed; false if it can't be sent
    send(text) {
        const line = clean(text, 2000).trim();
        if (!line || !this.joined) {
            return false;
        }
        if (Buffer.byteLength(line) > exports.MaxChatBytes) {
            this.emit('notice', 'That message is too long.');
            return false;
        }
        this.raw(`PRIVMSG ${this.ticket.room} :${line}`);
        return true;
    }
}

exports.HubLive = HubLive;
exports.HubChat = HubChat;
