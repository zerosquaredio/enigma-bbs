/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const AtProtoLoginModule = require('./atproto_login.js').getModule;
const { gotoAccountStateMenu } = require('./atproto_login.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'AT Protocol Web Sign-In',
    desc: 'Log in a caller who signed in with Bluesky on the board web page',
    author: 'zerosquaredio',
};

//
//  The first menu (loginServers.webSocket.firstMenuSignedIn) for a browser
//  terminal connection whose web sign-in cookie checked out
//  (core/atproto/web_sign_in.js). The identity was proven in the browser,
//  so it goes straight to AT login's next steps: a linked user is logged in,
//  an account with no user yet goes on to link or apply, and account states
//  go to their menus, all as for AT login. Anything else falls back to
//  config.fallback (the login matrix) to log in as usual.
//
//  config: as for the AT login menu (linkAccount, newUserApplication,
//  tooNodeMenu, inactive, ...), plus fallback. Art is optional (e.g. the
//  CONNECT screen); the menu has no views.
//

exports.getModule = class AtProtoWebSignInModule extends AtProtoLoginModule {
    constructor(options) {
        super(options);
        this.menuMethods = {};
    }

    initSequence() {
        //  Used once: a later visit to this menu proves nothing
        this.identity = this.client.webSignInIdentity || null;
        this.client.webSignInIdentity = null;

        if (!this.identity) {
            this.client.log.warn('Web sign-in menu without a signed-in identity');
            return this.fallBack();
        }

        //  The terminal connection itself must meet AT login's rules
        const secureOnly =
            false !== _.get(Config(), 'atProto.login.secureConnectionsOnly');
        if (secureOnly && true !== _.get(this.client, 'session.isSecure')) {
            this.client.log.info(
                { did: this.identity.did },
                'Web sign-in over an insecure connection; log in as usual'
            );
            return this.fallBack();
        }

        return super.initSequence();
    }

    //  No views, so none of AT login's
    mciReady(mciData, cb) {
        return MenuModule.prototype.mciReady.call(this, mciData, cb);
    }

    finishedLoading() {
        this.client.log.info({ did: this.identity.did }, 'Web sign-in: logging in');
        return this.identityProven(this.identity);
    }

    //
    //  We leave the menu ourselves, once the login is done. With no form,
    //  ThemeManager sets runtime.autoNext for this menu, and the automatic
    //  move to |next| would otherwise race the login: the caller could reach
    //  the logged-in sequence before (or without) being logged in.
    //
    autoNextMenu() {
        //  intentionally nothing; see above
    }

    //  AT login shows these in its status view; there is none here
    showStatus() {}

    noUserForIdentity(identity) {
        const config = _.get(this, 'menuConfig.config', {});
        if (!config.linkAccount && !config.newUserApplication) {
            this.client.log.info(
                { did: identity.did },
                'Web sign-in: no user linked, and nowhere to apply; log in as usual'
            );
            return this.fallBack();
        }
        return super.noUserForIdentity(identity);
    }

    loginFailed(err) {
        if (gotoAccountStateMenu(this, err)) {
            return;
        }
        this.client.log.info({ error: err.message }, 'Web sign-in: login refused');
        return this.fallBack();
    }

    fallBack() {
        const menu = _.get(this, 'menuConfig.config.fallback', 'matrix');
        return this.gotoMenu(menu, err => {
            if (err) {
                this.client.log.warn(
                    { menu, error: err.message },
                    'Web sign-in: could not fall back to the login menu'
                );
            }
        });
    }
};
