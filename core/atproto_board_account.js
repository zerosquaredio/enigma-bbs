/* jslint node: true */
'use strict';

//  ENiGMA½
const AtProtoLoginModule = require('./atproto_login.js').getModule;
const AtProtoOAuth = require('./atproto/oauth_client.js');
const Publishing = require('./atproto/publishing.js');
const { ErrorReasons } = require('./enig_error.js');

//  deps
const _ = require('lodash');

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
//  announcement, and HM4 [connect, post, publish, disconnect, cancel].
//

const MciViewIds = {
    announcement: 3,
};

const Messages = {
    connected: 'Board account: {account}.',
    notConnected: 'No board account is connected.',
    lastListing: 'Listing last published {when}.',
    instructions:
        "To connect one, enter the board account's handle and press ENTER, then approve it in a browser.",
    actions: 'Type an announcement and choose "post"; "publish" updates the listing now.',
    notEnabled:
        'Publishing is off: set atProto.publishing.enabled (and restart) to use a board account.',
    nowConnected: 'Connected {account}, and published its listing.',
    connectedNotListed:
        'Connected {account}, but the listing could not be published: {error}',
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
        lines.push('', this.unavailableMessage() || Messages.instructions);
        if (account) {
            lines.push(Messages.actions);
        }
        this.showStatus(lines.join('\r\n'));
    }

    authorizeIdentity(did, options, cb) {
        return AtProtoOAuth.authorizeBoard(did, options, cb);
    }

    identityProven(identity) {
        const account = identity.handle ? `@${identity.handle}` : identity.did;
        Publishing.connectBoardAccount(identity, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Board account connected, listing not published'
                );
                return this.showStatus(Messages.connectedNotListed, {
                    account,
                    error: err.message,
                });
            }
            return this.showStatus(Messages.nowConnected, { account });
        });
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
