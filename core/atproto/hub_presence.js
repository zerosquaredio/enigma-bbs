/* jslint node: true */
'use strict';

//
//  Presence reports to the board's hub (F18): with atProto.hub.presence on,
//  the board tells its hub which of its members have chosen to be shown in
//  the hub's common space, and which of them are on now.
//
//  Each report is the whole list, so a member who turns it off, or whom the
//  sysop withholds, is simply missing from the next one, and the hub forgets
//  them. Reports go to the hub over HTTPS with the board's tunnel token (the
//  one in the agent config the hub gave): after a login or logoff, after a
//  member changes their setting, and every minute, so the hub knows the
//  board is still there. The hub takes a report only for the board whose
//  token sent it, and shows a member by DID as themselves only once they
//  confirm this board at the hub.
//
//  Members are reported by their linked AT identity (DID). With
//  includeLocalUsers, those without one are reported by user name too; the
//  hub decides whether to show them (as alice@board).
//

//  ENiGMA½
const Config = require('../config.js').get;
const UserProps = require('../user_property.js');
const Log = require('../logger.js').log;

//  deps
const _ = require('lodash');

exports.isEnabled = isEnabled;
exports.hubSettings = hubSettings;
exports.buildReport = buildReport;
exports.sendReport = sendReport;
exports.reportSoon = reportSoon;
exports.isShown = isShown;
exports.setShown = setShown;
exports.isWithheld = isWithheld;
exports.setWithheld = setWithheld;
exports.startup = startup;
exports.recordAnswer = recordAnswer;
exports.hubActiveAt = hubActiveAt;
exports.hubIdleSeconds = hubIdleSeconds;
exports.isBusyOnHub = isBusyOnHub;
exports.ReportPath = '/api/bbs/presence';
exports.ReportIntervalMs = 60 * 1000;

//  test hooks
exports._setFetch = fn => {
    fetchImpl = fn;
};
exports._setDeps = deps => {
    Object.assign(deps_, deps);
};

let fetchImpl = (...args) => fetch(...args);

//  what the report needs from the rest of the board, so tests can stand in
const deps_ = {
    userIdsShown: cb => {
        const User = require('../user.js');
        return User.getUserIdsWithProperty(UserProps.AtProtoHubPresence, '1', cb);
    },
    loadUser: (userId, cb) => {
        const User = require('../user.js');
        return User.getUser(userId, cb);
    },
    onlineUserIds: () => {
        const { getActiveConnections } = require('../client_connections.js');
        //  visible ones only: an invisible member counts as not on
        return getActiveConnections({
            authUsersOnly: true,
            visibleOnly: true,
            availOnly: false,
        }).map(c => c.user.userId);
    },
};

const ReportDelayMs = 2 * 1000;
const RequestTimeoutMs = 15 * 1000;

function isEnabled() {
    const atProto = Config().atProto || {};
    return true === atProto.enabled && true === _.get(atProto, 'hub.presence.enabled');
}

//
//  The hub settings, checked; null with a reason when they are incomplete.
//  The token is sent only over https://, or plain http:// to this machine
//  (a development hub)
//
function hubSettings() {
    const hub = _.get(Config(), 'atProto.hub', {});
    const fail = reason => ({ settings: null, reason });
    if (!_.isString(hub.url) || !hub.url || !_.isString(hub.name) || !hub.name) {
        return fail('atProto.hub.url and atProto.hub.name must be set');
    }
    if (!_.isString(hub.token) || !hub.token) {
        return fail('atProto.hub.token must be set (the token in the hub agent config)');
    }
    let url;
    try {
        url = new URL(hub.url);
    } catch (e) {
        return fail(`atProto.hub.url "${hub.url}" is not a URL`);
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!('https:' === url.protocol || ('http:' === url.protocol && loopback))) {
        return fail('atProto.hub.url must be https:// (or http:// to 127.0.0.1)');
    }
    return {
        settings: {
            origin: url.origin,
            reportUrl: new URL(exports.ReportPath, url.origin).toString(),
            name: hub.name.toLowerCase(),
            token: hub.token,
            includeLocalUsers: true === _.get(hub, 'presence.includeLocalUsers'),
        },
    };
}

//  ── A member's own setting, and the sysop's ───────────────────────────────

function isShown(user) {
    return '1' === user.getProperty(UserProps.AtProtoHubPresence);
}

function setShown(user, shown, cb) {
    const done = err => {
        if (!err) {
            reportSoon();
        }
        return cb(err);
    };
    return shown
        ? user.persistProperty(UserProps.AtProtoHubPresence, '1', done)
        : user.removeProperty(UserProps.AtProtoHubPresence, done);
}

function isWithheld(user) {
    return '1' === user.getProperty(UserProps.AtProtoHubWithheld);
}

function setWithheld(user, withheld, cb) {
    return withheld
        ? user.persistProperty(UserProps.AtProtoHubWithheld, '1', cb)
        : user.removeProperty(UserProps.AtProtoHubWithheld, cb);
}

//  ── The report ──────────────────────────────────────────────────────────────

//
//  Every member who chose to be shown, isn't withheld, and whose account is
//  active; by DID, or by user name with includeLocalUsers
//
function buildReport(settings, cb) {
    deps_.userIdsShown((err, userIds) => {
        if (err) {
            return cb(err);
        }
        const online = new Set(deps_.onlineUserIds());
        const members = [];
        const next = i => {
            if (i >= userIds.length) {
                return cb(null, { bbs: settings.name, members });
            }
            deps_.loadUser(userIds[i], (err, user) => {
                if (!err && user) {
                    const entry = memberEntry(user, online, settings);
                    if (entry) {
                        members.push(entry);
                    }
                }
                return setImmediate(next, i + 1);
            });
        };
        return next(0);
    });
}

function memberEntry(user, online, settings) {
    const User = require('../user.js');
    if (!isShown(user) || isWithheld(user)) {
        return null;
    }
    const status = parseInt(user.getProperty(UserProps.AccountStatus), 10);
    if (status !== User.AccountStatus.active) {
        return null;
    }
    const did = user.getProperty(UserProps.AtProtoDid);
    if (!did && !settings.includeLocalUsers) {
        return null;
    }
    const created = Date.parse(user.getProperty(UserProps.AccountCreated));
    return Object.assign(did ? { did } : { user: user.username }, {
        name: user.username,
        memberSince: new Date(Number.isNaN(created) ? 0 : created).toISOString(),
        online: online.has(user.userId),
    });
}

function sendReport(settings, report, cb) {
    fetchImpl(settings.reportUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.token}`,
        },
        body: JSON.stringify(report),
        redirect: 'error',
        signal: AbortSignal.timeout(RequestTimeoutMs),
    }).then(
        res =>
            res.text().then(text => {
                if (!res.ok) {
                    let reason = text;
                    try {
                        reason = JSON.parse(text).error || text;
                    } catch (e) {
                        //  not JSON
                    }
                    return cb(
                        new Error(`The hub refused the report (${res.status}): ${reason}`)
                    );
                }
                let answer = null;
                try {
                    answer = JSON.parse(text);
                } catch (e) {
                    //  an older hub, or no answer: nothing more to learn
                }
                return cb(null, answer);
            }),
        err => cb(err)
    );
}

//  ── Members busy on the hub (F20, hub H19) ───────────────────────────────
//
//  The hub's answer to each report lists the members who are in its common
//  space now (its map, its chat, another board's door), each with when they
//  last did something there. While it does, that counts as activity here, so
//  a member chatting on the hub isn't logged off the board they left open.
//  What the hub said goes stale once reports stop reaching it.
//
const AnswerStaleMs = 3 * 60 * 1000;
let busy = new Map(); //  DID -> ms of their last action on the hub
let answeredAt = 0;

function recordAnswer(answer, nowMs = Date.now()) {
    const next = new Map();
    const active = answer && Array.isArray(answer.active) ? answer.active : [];
    for (const a of active) {
        const at =
            a && _.isString(a.did) && _.isString(a.activeAt)
                ? Date.parse(a.activeAt)
                : NaN;
        if (!Number.isNaN(at)) {
            next.set(a.did, Math.min(at, nowMs)); //  never from the future
        }
    }
    busy = next;
    answeredAt = nowMs;
}

//  When this member last did something on the hub, while the hub says they
//  are there; else null
function hubActiveAt(user, nowMs = Date.now()) {
    if (!isEnabled() || nowMs - answeredAt > AnswerStaleMs) {
        return null;
    }
    const did = user && user.getProperty(UserProps.AtProtoDid);
    return (did && busy.get(did)) || null;
}

//  The idle limit for a member busy on the hub, in seconds:
//  atProto.hub.presence.hubIdleMinutes (30 by default). 0 turns this off
function hubIdleSeconds() {
    const minutes = _.get(Config(), 'atProto.hub.presence.hubIdleMinutes', 30);
    return _.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
}

//
//  Whether a session that looks idle by the board's own limit stays on
//  because its member is busy on the hub: their latest action, here or
//  there, is within the longer of the two limits.
//
function isBusyOnHub({
    lastActivityMs,
    hubActiveMs,
    idleLogoutSeconds,
    hubIdleSecs,
    nowMs,
}) {
    if (!hubActiveMs || !(hubIdleSecs > 0)) {
        return false;
    }
    const limitMs = Math.max(idleLogoutSeconds, hubIdleSecs) * 1000;
    return nowMs - Math.max(lastActivityMs, hubActiveMs) < limitMs;
}

//  ── While the board runs ─────────────────────────────────────────────────

let started = false;
let pending = null;
let sending = false;
let again = false;
let lastError = null;

function reportNow() {
    pending = null;
    if (sending) {
        again = true;
        return;
    }
    const { settings, reason } = hubSettings();
    if (!settings) {
        return reportProblem(new Error(reason));
    }
    sending = true;
    buildReport(settings, (err, report) => {
        if (err) {
            sending = false;
            return reportProblem(err);
        }
        sendReport(settings, report, (err, answer) => {
            sending = false;
            if (err) {
                reportProblem(err);
            } else {
                recordAnswer(answer);
                if (lastError) {
                    Log.info('Presence reports reach the hub again');
                }
                lastError = null;
            }
            if (again) {
                again = false;
                reportSoon();
            }
        });
    });
}

//  the same problem is logged once, not every minute
function reportProblem(err) {
    if (err.message !== lastError) {
        Log.warn({ error: err.message }, 'Could not report presence to the hub');
    }
    lastError = err.message;
}

//  after a short pause, so a burst of changes makes one report
function reportSoon() {
    if (!started || pending) {
        return;
    }
    pending = setTimeout(reportNow, ReportDelayMs);
    pending.unref();
}

function startup(cb) {
    if (started || !isEnabled()) {
        return cb(null);
    }
    const { settings, reason } = hubSettings();
    if (!settings) {
        Log.warn({ reason }, 'Hub presence reports are on, but not set up');
    }
    started = true;

    const Events = require('../events.js');
    const SystemEvents = Events.getSystemEvents();
    for (const event of [SystemEvents.UserLogin, SystemEvents.UserLogoff]) {
        Events.on(event, reportSoon);
    }
    Events.on(SystemEvents.ConfigChanged, reportSoon);

    setImmediate(reportSoon);
    setInterval(reportSoon, exports.ReportIntervalMs).unref();
    return cb(null);
}
