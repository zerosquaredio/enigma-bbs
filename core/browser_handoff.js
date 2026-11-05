/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const { Errors } = require('./enig_error.js');
const Log = require('./logger.js').log;
const getServer = require('./listening_server.js').getServer;
const webServerPackageName = require('./servers/content/web.js').moduleInfo.packageName;
const { WellKnownLocations } = require('./servers/content/web.js');
const { buildUrl } = require('./web_util.js');

//  deps
const crypto = require('crypto');
const _ = require('lodash');

//
//  Browser handoff: a generic way for a terminal session to send its user to
//  a web browser for a step a terminal can't do (approving an AT Protocol
//  login, a payment, an ID check), and wait for the result.
//
//  1.  The terminal side calls create() and shows the short URL it returns,
//      e.g. https://bbs.example/_enig/handoff/7F3K-9QXM, then calls wait().
//  2.  Opening the URL calls the creator's |onOpen|, which supplies the page
//      to send the browser to. This happens on open, not on create, because
//      such pages (an OAuth approval request, say) often expire quickly.
//  3.  Whatever finishes the browser step (an OAuth callback, a webhook)
//      calls complete() or fail() with the handoff's |id|, and the waiting
//      session gets the outcome.
//
//  Every handoff ends exactly once: completed, failed, timed out, or
//  cancelled. Handoffs live in memory; a restart ends them along with the
//  sessions waiting on them.
//

exports.create = create;
exports.complete = complete;
exports.fail = fail;
exports.registerRoutes = registerRoutes;
exports.normalizeCode = normalizeCode;
exports.HandoffRoutePrefix = `${WellKnownLocations.Internal}/handoff/`;

//  For tests: substitute the web server, and forget all handoffs
exports._setWebServerGetter = getter => {
    getWebServer = getter;
};
exports._reset = () => {
    for (const handoff of byId.values()) {
        clearTimeout(handoff._timer);
    }
    byId.clear();
    byCode.clear();
    routesRegistered = false;
};
exports._routeOpen = routeOpen;

const DefaultTimeoutSeconds = 5 * 60;
const MaxActiveHandoffs = 1000;
//  Each open asks the creator for a fresh page; link previewers in chat apps
//  may open a link on their own, so allow a few
const MaxOpensPerHandoff = 10;

//  Crockford's base32: no I, L, O, or U, so codes read back unambiguously
const CodeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CodeLength = 8;

const DefaultRateLimit = { windowMs: 10 * 60 * 1000, maxRequests: 20 };

const byId = new Map();
const byCode = new Map();
let routesRegistered = false;

let getWebServer = () => {
    const server = getServer(webServerPackageName);
    return server ? server.instance : null;
};

class Handoff {
    constructor({ purpose, timeoutSeconds, onOpen }) {
        this.id = crypto.randomBytes(16).toString('hex');
        this.code = generateCode();
        this.purpose = purpose;
        this.url = buildUrl(exports.HandoffRoutePrefix + this.code);
        this.expiresAt = new Date(Date.now() + timeoutSeconds * 1000);

        this._onOpen = onOpen;
        this._opens = 0;
        this._outcome = null; //  { err, result } once finished
        this._waiter = null;
        this._timer = setTimeout(
            () =>
                this._finish(
                    Errors.Timeout('The browser step was not completed in time')
                ),
            timeoutSeconds * 1000
        );
        this._timer.unref();
    }

    isFinished() {
        return null !== this._outcome;
    }

    //  |cb(err, result)| is called once, when the handoff ends
    wait(cb) {
        if (this._waiter) {
            return setImmediate(() => cb(Errors.UnexpectedState('Already waiting')));
        }
        this._waiter = cb;
        if (this._outcome) {
            this._deliver();
        }
    }

    //  The terminal user gave up, or their session ended
    cancel() {
        return this._finish(Errors.UserInterrupt('Cancelled'));
    }

    _finish(err, result) {
        if (this._outcome) {
            return false;
        }
        this._outcome = { err: err || null, result };
        clearTimeout(this._timer);
        byId.delete(this.id);
        byCode.delete(this.code);
        if (this._waiter) {
            this._deliver();
        }
        return true;
    }

    _deliver() {
        const { err, result } = this._outcome;
        const waiter = this._waiter;
        setImmediate(() => waiter(err, result));
    }
}

//
//  Start a handoff. Options:
//    purpose         short label for logs, e.g. 'atproto-login'
//    onOpen          (handoff, cb(err, redirectUrl)): the page to send the
//                    browser to when the link is opened
//    timeoutSeconds  how long to wait; default five minutes
//
//  Calls back with a Handoff: { id, code, url, purpose, expiresAt, wait(cb),
//  cancel(), isFinished() }.
//
function create(options, cb) {
    const { purpose, onOpen } = options;
    const timeoutSeconds = _.get(options, 'timeoutSeconds', DefaultTimeoutSeconds);

    if (!_.isString(purpose) || !_.isFunction(onOpen)) {
        return setImmediate(() => cb(Errors.MissingParam('purpose and onOpen required')));
    }
    if (!(timeoutSeconds > 0)) {
        return setImmediate(() => cb(Errors.Invalid('timeoutSeconds must be positive')));
    }
    if (byId.size >= MaxActiveHandoffs) {
        return setImmediate(() =>
            cb(Errors.General('Too many browser handoffs waiting'))
        );
    }

    let handoff;
    try {
        handoff = new Handoff({ purpose, timeoutSeconds, onOpen });
    } catch (err) {
        return setImmediate(() => cb(err));
    }

    byId.set(handoff.id, handoff);
    byCode.set(handoff.code, handoff);

    Log.debug(
        { purpose, handoffId: handoff.id, expiresAt: handoff.expiresAt },
        'Browser handoff created'
    );
    return setImmediate(() => cb(null, handoff));
}

//  End the handoff |id| successfully. Returns false if it is unknown or has
//  already ended, so a second completion can't change the outcome.
function complete(id, result) {
    const handoff = byId.get(id);
    return handoff ? handoff._finish(null, result) : false;
}

//  End the handoff |id| with |err|. Returns false as complete() does.
function fail(id, err) {
    const handoff = byId.get(id);
    return handoff
        ? handoff._finish(err || Errors.General('Browser step failed'))
        : false;
}

//
//  Add the landing route to the web server. Features that use handoffs call
//  this from their own startup, so the route exists only when one of them is
//  enabled. Safe to call more than once.
//
function registerRoutes(cb) {
    if (routesRegistered) {
        return cb(null);
    }

    const webServer = getWebServer();
    if (!webServer || !webServer.isEnabled()) {
        return cb(
            Errors.UnexpectedState('Browser handoff needs the web server to be enabled')
        );
    }

    webServer.addRoute({
        method: 'GET',
        path: /^\/_enig\/handoff\/[A-Za-z0-9-]{1,32}$/,
        handler: routeOpen,
    });
    routesRegistered = true;
    return cb(null);
}

function routeOpen(req, resp) {
    const webServer = getWebServer();

    const rateLimit = _.get(
        Config(),
        'contentServers.web.rateLimits.handoffGet',
        DefaultRateLimit
    );
    if (!webServer.checkRateLimit(req, resp, 'handoffGet', rateLimit)) {
        return;
    }

    const code = normalizeCode(req.url.slice(exports.HandoffRoutePrefix.length));
    const handoff = code && byCode.get(code);
    if (!handoff || handoff.isFinished()) {
        return linkGone(webServer, resp);
    }

    handoff._opens += 1;
    if (handoff._opens > MaxOpensPerHandoff) {
        return linkGone(webServer, resp);
    }

    handoff._onOpen(handoff, (err, redirectUrl) => {
        if (handoff.isFinished()) {
            return linkGone(webServer, resp);
        }
        if (err || !_.isString(redirectUrl)) {
            Log.warn(
                {
                    purpose: handoff.purpose,
                    handoffId: handoff.id,
                    error: err ? err.message : 'no redirect URL',
                },
                'Browser handoff could not continue'
            );
            return webServer.respondWithError(
                resp,
                502,
                'This step could not continue. Return to your terminal and try again.',
                'Could Not Continue',
                NoStoreHeaders
            );
        }

        resp.writeHead(302, Object.assign({ Location: redirectUrl }, NoStoreHeaders));
        return resp.end();
    });
}

//  The code is in the landing URL, so keep it out of caches and out of the
//  Referer header sent to the next site
const NoStoreHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
};

function linkGone(webServer, resp) {
    return webServer.respondWithError(
        resp,
        410,
        'This link has expired or was already used. Return to your terminal and start again.',
        'Link Expired',
        NoStoreHeaders
    );
}

function generateCode() {
    for (let attempt = 0; attempt < 10; ++attempt) {
        let raw = '';
        for (let i = 0; i < CodeLength; ++i) {
            raw += CodeAlphabet[crypto.randomInt(CodeAlphabet.length)];
        }
        const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
        if (!byCode.has(code)) {
            return code;
        }
    }
    throw Errors.UnexpectedState('Could not generate a unique handoff code');
}

//
//  Accept a code as a person might type it: any case, with or without the
//  dash, with O for 0 and I or L for 1. Returns the canonical form, or null.
//
function normalizeCode(input) {
    if (!_.isString(input)) {
        return null;
    }
    const raw = input
        .toUpperCase()
        .replace(/-/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
    if (raw.length !== CodeLength || ![...raw].every(c => CodeAlphabet.includes(c))) {
        return null;
    }
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
