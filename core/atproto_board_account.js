/* jslint node: true */
'use strict';

//  ENiGMA½
const AtProtoLoginModule = require('./atproto_login.js').getModule;
const AtProtoOAuth = require('./atproto/oauth_client.js');
const Publishing = require('./atproto/publishing.js');
const Splash = require('./atproto/splash.js');
const { ErrorReasons } = require('./enig_error.js');

//  deps
const _ = require('lodash');
const paths = require('path');

exports.moduleInfo = {
    name: 'AT Protocol Board Account',
    desc: "Connect the board's own AT Protocol (Bluesky) account, and publish",
    author: 'zerosquaredio',
};

//
//  For the sysop: connect the board's own AT (Bluesky) account, which
//  publishes its listing and status and posts announcements
//  (core/atproto/publishing.js). Connecting approves the board's write
//  access in a browser, as AT login does (this module extends it).
//
//  Sysops only: the menu should be gated by its config.acs (GM[sysops] in
//  the template, or ID1 for root alone), and the module refuses anyone else.
//
//  Views as for AT login (ET1 handle, MT2 status), plus ET3, an
//  announcement, and HM4 [connect, post, publish, splash, disconnect,
//  cancel]. "splash" turns the hub's showing of the board's splash screen
//  on or off (core/atproto/splash.js); connecting the first time turns it
//  on, and says so.
//

const MciViewIds = {
    announcement: 3,
    actions: 4,
};

const Messages = {
    connected: 'Board account: {account}.',
    notConnected: 'No board account is connected.',
    lastListing: 'Listing last published {when}.',
    instructions:
        "To connect one, enter the board account's handle and press ENTER, then approve it in a browser. ESC goes back.",
    actions: 'Type an announcement and choose "post"; "publish" updates the listing now.',
    splashShown: 'Splash screen: shown on the hub ({file}).',
    splashShownNone: 'Splash screen: shown on the hub, but no art was found to offer.',
    splashHidden: 'Splash screen: not shown on the hub. Choose "splash" to show it.',
    splashOnConnect:
        'Its login screen will be shown on the hub, credited to its artist; choose "splash" to stop that.',
    splashOn:
        'The hub may show the board\'s login screen ({file}), credited to its artist. Choose "splash" again to stop.',
    splashOnNone:
        "The hub may show the board's login screen, but no art was found to offer: see atProto.publishing.splash.art.",
    splashOff: "The hub won't show the board's login screen any more.",
    notEnabled:
        'Publishing is off: set atProto.publishing.enabled (and restart) to use a board account.',
    nowConnected:
        'Connected {account}, and published its listing.{splash} Choose an action below, or press ESC to go back.',
    connectedNotListed:
        'Connected {account}, but the listing could not be published: {error}. Choose an action below, or press ESC to go back.',
    posted: 'Posted.',
    published: 'Listing published.',
    disconnected: 'Disconnected. Its records stay on the account until you remove them.',
    noAccount: 'No board account is connected.',
    failed: 'That did not work: {error}',
};

exports.getModule = class AtProtoBoardAccountModule extends AtProtoLoginModule {
    constructor(options) {
        super(options);

        Object.assign(this.menuMethods, {
            post: (formData, extraArgs, cb) => this.postAnnouncement(formData, cb),
            publish: (formData, extraArgs, cb) => this.publishNow(cb),
            splash: (formData, extraArgs, cb) => this.toggleSplash(cb),
            disconnect: (formData, extraArgs, cb) => this.disconnect(cb),
        });
    }

    initSequence() {
        const user = this.client.user;
        if (!user.isSysOp() && !user.isGroupMember('sysops')) {
            this.client.log.warn('Board account screen opened by a non-sysop');
            return this.prevMenu(_.noop);
        }
        return super.initSequence();
    }

    unavailableMessage() {
        if (!AtProtoOAuth.isBoardReady()) {
            return Messages.notEnabled;
        }
        return super.unavailableMessage();
    }

    //  The account, as shown: @handle, or its DID
    accountText(account = Publishing.getBoardAccount()) {
        if (!account) {
            return null;
        }
        return account.handle ? `@${account.handle}` : account.did;
    }

    showInitialStatus() {
        if (undefined === this.offeredSplash) {
            //  once, then draw again with the file's name
            this.offeredSplash = null;
            return Splash.find(found => {
                this.offeredSplash = found;
                return this.showInitialStatus();
            });
        }
        let account = null;
        try {
            account = AtProtoOAuth.isBoardReady() ? Publishing.getBoardAccount() : null;
        } catch (e) {
            //  shown as not connected
        }

        const lines = [
            account
                ? Messages.connected.replace('{account}', this.accountText(account))
                : Messages.notConnected,
        ];
        if (account && account.listingPublishedAt) {
            lines.push(
                Messages.lastListing.replace(
                    '{when}',
                    new Date(account.listingPublishedAt * 1000).toLocaleString()
                )
            );
        }
        if (account) {
            lines.push(this.splashLine(account));
        }
        lines.push('', this.unavailableMessage() || Messages.instructions);
        if (account) {
            lines.push(Messages.actions);
        }
        this.showStatus(lines.join('\r\n'));
    }

    //  Whether the hub may show the splash screen, and which file it is
    splashLine(account) {
        if (true !== account.splashShown) {
            return Messages.splashHidden;
        }
        const offered = this.offeredSplash;
        return offered
            ? Messages.splashShown.replace('{file}', paths.basename(offered.path))
            : Messages.splashShownNone;
    }

    authorizeIdentity(did, options, cb) {
        return AtProtoOAuth.authorizeBoard(did, options, cb);
    }

    //  The board's account is named by its handle, never a member's username
    acceptsUsernames() {
        return false;
    }

    identityProven(identity) {
        const account = identity.handle ? `@${identity.handle}` : identity.did;
        Publishing.connectBoardAccount(identity, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Board account connected, listing not published'
                );
                this.showStatus(Messages.connectedNotListed, {
                    account,
                    error: err.message,
                });
                return this.focusActions();
            }
            const shown = true === _.get(Publishing.getBoardAccount(), 'splashShown');
            this.showStatus(Messages.nowConnected, {
                account,
                splash: shown ? ` ${Messages.splashOnConnect}` : '',
            });
            return this.focusActions();
        });
    }

    //  The handle has done its job: on to the actions (post, publish,
    //  cancel...), so the arrow keys move among them and ENTER picks one
    focusActions() {
        const vc = _.get(this, 'viewControllers.menu');
        if (vc && vc.getView(MciViewIds.actions)) {
            vc.switchFocus(MciViewIds.actions);
        }
    }

    failed(err) {
        if (ErrorReasons.DoesNotExist === err.reasonCode) {
            return this.showStatus(Messages.noAccount);
        }
        return this.showStatus(Messages.failed, { error: err.reason || err.message });
    }

    postAnnouncement(formData, cb) {
        const text = _.get(formData, 'value.announcement', '');
        Publishing.post(text, err => {
            if (err) {
                this.failed(err);
                return cb(null);
            }
            const view = this.getView('menu', MciViewIds.announcement);
            if (view) {
                view.setText('');
            }
            this.showStatus(Messages.posted);
            return cb(null);
        });
    }

    publishNow(cb) {
        Publishing.publishListing({ force: true }, err => {
            if (err) {
                this.failed(err);
                return cb(null);
            }
            this.showStatus(Messages.published);
            return cb(null);
        });
    }

    toggleSplash(cb) {
        const account = Publishing.getBoardAccount();
        if (!account) {
            this.showStatus(Messages.noAccount);
            return cb(null);
        }
        const shown = true !== account.splashShown;
        Publishing.setSplashShown(shown, (err, result) => {
            if (err) {
                this.failed(err);
                return cb(null);
            }
            const splash = _.get(result, 'record.splash');
            if (!shown) {
                this.showStatus(Messages.splashOff);
            } else if (splash) {
                this.showStatus(Messages.splashOn, { file: this.splashFile(splash) });
            } else {
                this.showStatus(Messages.splashOnNone);
            }
            return cb(null);
        });
    }

    //  The file name of the splash the listing names
    splashFile(splash) {
        const found = Splash.current();
        return found && found.sha256 === splash.sha256
            ? paths.basename(found.path)
            : splash.sha256.slice(0, 12);
    }

    disconnect(cb) {
        Publishing.disconnectBoardAccount(err => {
            if (err) {
                this.failed(err);
                return cb(null);
            }
            this.showStatus(Messages.disconnected);
            return cb(null);
        });
    }
};
