/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const HubPresence = require('./atproto/hub_presence.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'Hub Presence Config',
    desc: "Choose whether you are shown in the hub's common space",
    author: 'zerosquaredio',
};

//
//  For a logged in user: whether the board tells its hub that they are on,
//  so they appear in the hub's common space (core/atproto/hub_presence.js).
//  Off until they turn it on. The sysop can keep anyone off the hub
//  (oputil.js user hub USERNAME withhold), whatever they choose here.
//
//  Views: MT1 status, HM2 [show, hide, back].
//

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    status: 1,
};

const Messages = {
    notEnabled: 'This board does not report to a hub.',
    shown: 'On: the hub can show that you are here.',
    hidden: 'Off: the hub is not told when you are here.',
    withheld: 'The sysop has kept you off the hub, so you are not shown there.',
    noAccount:
        'You have no Bluesky account linked, and this board reports only members ' +
        'who do. Link one first (Bluesky Account in your settings).',
    asLocal:
        'With no Bluesky account linked, you are reported by your user name here; ' +
        'the hub decides whether to show you.',
    asAccount:
        'You are reported by your Bluesky account. Until you confirm this board at ' +
        'the hub, you appear there only by your user name here.',
    choose: 'Choose "show" or "hide".',
    failed: 'That did not work. Try again, or press ESC to go back.',
};

exports.getModule = class HubPresenceConfigModule extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);

        Object.assign(this.menuMethods, {
            show: (formData, extraArgs, cb) => this.setShown(true, cb),
            hide: (formData, extraArgs, cb) => this.setShown(false, cb),
        });
    }

    initSequence() {
        async.series(
            [
                callback => this.beforeArt(callback),
                callback =>
                    this.displayArtAndPrepViewController(
                        'menu',
                        FormIds.menu,
                        { clearScreen: true },
                        callback
                    ),
            ],
            () => {
                this.showStatus();
                this.finishedLoading();
            }
        );
    }

    statusText() {
        if (!HubPresence.isEnabled()) {
            return Messages.notEnabled;
        }
        const user = this.client.user;
        const lines = [HubPresence.isShown(user) ? Messages.shown : Messages.hidden, ''];
        if (HubPresence.isWithheld(user)) {
            lines.push(Messages.withheld);
        } else if (user.getProperty(UserProps.AtProtoDid)) {
            lines.push(Messages.asAccount);
        } else {
            const { settings } = HubPresence.hubSettings();
            lines.push(
                settings && settings.includeLocalUsers
                    ? Messages.asLocal
                    : Messages.noAccount
            );
        }
        lines.push('', Messages.choose);
        return lines.join('\r\n');
    }

    showStatus(extra) {
        const view = this.getView('menu', MciViewIds.status);
        if (view) {
            view.setText(
                extra ? `${extra}\r\n\r\n${this.statusText()}` : this.statusText()
            );
        }
    }

    setShown(shown, cb) {
        if (!HubPresence.isEnabled()) {
            this.showStatus();
            return cb(null);
        }
        HubPresence.setShown(this.client.user, shown, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Hub presence setting failed'
                );
                this.showStatus(Messages.failed);
                return cb(null);
            }
            this.client.log.info({ shown }, 'Hub presence setting changed');
            this.showStatus();
            return cb(null);
        });
    }
};
