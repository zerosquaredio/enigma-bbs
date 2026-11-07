const WebHandlerModule = require('../../../web_handler_module');
const { Errors } = require('../../../enig_error');
const EngiAssert = require('../../../enigma_assert');
const Config = require('../../../config').get;
const Log = require('../../../logger').log;
const AtProtoOAuth = require('../../../atproto/oauth_client');
const WebSignIn = require('../../../atproto/web_sign_in');
const BrowserHandoff = require('../../../browser_handoff');
const {
    CallbackRoutePath,
    ClientMetadataRoutePath,
    JwksRoutePath,
    ClientModes,
} = require('../../../atproto/const');

// deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'AtProto',
    desc: 'AT Protocol (Bluesky) login routes',
    author: 'zerosquaredio',
    packageName: 'codes.l33t.enigma.web.handler.atproto',
};

//
//  Routes for AT login: the OAuth callback the member's account host
//  redirects to after they approve, and (through core/browser_handoff.js)
//  the short link the terminal shows them. In public client mode, also the
//  client metadata document and public signing keys that account hosts
//  fetch. With atProto.webSignIn.enabled, also the web sign-in start page
//  and sign-out (core/atproto/web_sign_in.js), whose OAuth callbacks come
//  here too. Enabled with contentServers.web.handlers.atProto.enabled, and
//  needs atProto.enabled.
//
const DefaultRateLimit = { windowMs: 10 * 60 * 1000, maxRequests: 20 };
const DefaultSignInRateLimit = { windowMs: 10 * 60 * 1000, maxRequests: 60 };

exports.getModule = class AtProtoWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        this.webServer = webServer;
        EngiAssert(webServer, 'AT Protocol Web Handler init without webServer');

        if (!AtProtoOAuth.isEnabled()) {
            Log.warn(
                'contentServers.web.handlers.atProto is enabled but atProto.enabled is not; AT login routes not added'
            );
            return cb(null);
        }

        this.webServer.addRoute({
            method: 'GET',
            path: new RegExp(`^${_.escapeRegExp(CallbackRoutePath)}(\\?.*)?$`),
            handler: this._callbackHandler.bind(this),
        });

        if (ClientModes.Public === _.get(Config(), 'atProto.oauth.clientMode')) {
            [
                [ClientMetadataRoutePath, () => AtProtoOAuth.getClientMetadata()],
                [JwksRoutePath, () => AtProtoOAuth.getJwks()],
            ].forEach(([routePath, getDocument]) => {
                this.webServer.addRoute({
                    method: 'GET',
                    path: new RegExp(`^${_.escapeRegExp(routePath)}$`),
                    handler: (req, resp) => this._jsonHandler(resp, getDocument()),
                });
            });
        }

        if (WebSignIn.isEnabled()) {
            const route = (method, routePath, fn) =>
                this.webServer.addRoute({
                    method,
                    path: new RegExp(`^${_.escapeRegExp(routePath)}(\\?.*)?$`),
                    handler: (req, resp) => {
                        if (this._checkSignInRateLimit(req, resp)) {
                            return fn(this.webServer, req, resp);
                        }
                    },
                });
            route('GET', WebSignIn.SignInRoutePath, WebSignIn.routeStartPage);
            route('POST', WebSignIn.SignInRoutePath, WebSignIn.routeSignIn);
            route('POST', WebSignIn.SignOutRoutePath, WebSignIn.routeSignOut);
        }

        return BrowserHandoff.registerRoutes(cb);
    }

    _checkSignInRateLimit(req, resp) {
        const rateLimit = _.get(
            Config(),
            'contentServers.web.rateLimits.atProtoSignIn',
            DefaultSignInRateLimit
        );
        return this.webServer.checkRateLimit(req, resp, 'atProtoSignIn', rateLimit);
    }

    //  |document| is null until AT support has started
    _jsonHandler(resp, document) {
        if (!document) {
            return this.webServer.serviceUnavailable(resp);
        }
        return this.webServer.ok(resp, JSON.stringify(document), {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=600',
        });
    }

    _callbackHandler(req, resp) {
        const rateLimit = _.get(
            Config(),
            'contentServers.web.rateLimits.atProtoCallback',
            DefaultRateLimit
        );
        if (!this.webServer.checkRateLimit(req, resp, 'atProtoCallback', rateLimit)) {
            return;
        }

        //  AT support starts after the web server, and may have failed to
        if (!AtProtoOAuth.isReady()) {
            return this.webServer.serviceUnavailable(resp);
        }

        const queryIndex = req.url.indexOf('?');
        const query = queryIndex > -1 ? req.url.slice(queryIndex + 1) : '';

        AtProtoOAuth.handleCallback(query, (err, result) => {
            //  A browser signing in on the board's own page, not a terminal
            const state = err ? err.state : _.get(result, 'state');
            if (WebSignIn.ownsState(state)) {
                return WebSignIn.completeSignIn(this.webServer, req, resp, err, result);
            }

            if (err) {
                //  The library returns the handoff id we gave as |state|
                //  when it knows it, e.g. when the member pressed Deny
                if (_.isString(err.state)) {
                    BrowserHandoff.fail(
                        err.state,
                        Errors.AccessDenied('Login not approved')
                    );
                }
                Log.info({ error: err.message }, 'AT login callback failed');
                return this._page(
                    resp,
                    400,
                    'Login Not Completed',
                    'The login was not completed. Return to your terminal to try again.'
                );
            }

            if (!BrowserHandoff.complete(result.state, { did: result.did })) {
                return this._page(
                    resp,
                    410,
                    'Link Expired',
                    'This login expired or was already used. Return to your terminal and start again.'
                );
            }

            return this._page(
                resp,
                200,
                'Login Approved',
                'Login approved. You can close this window and return to your terminal.'
            );
        });
    }

    _page(resp, code, title, text) {
        const headers = {
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        };
        if (200 !== code) {
            return this.webServer.respondWithError(resp, code, text, title, headers);
        }

        const body = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body>
        <article>
            <h2>${text}</h2>
        </article>
    </body>
</html>`;
        return this.webServer.ok(
            resp,
            body,
            Object.assign({ 'Content-Type': 'text/html' }, headers)
        );
    }
};
