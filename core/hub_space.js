/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const HubSpace = require('./atproto/hub_space.js');
const { pipeToAnsi } = require('./color_codes.js');
const { wordWrapText } = require('./word_wrap.js');

//  deps
const async = require('async');
const moment = require('moment');

exports.moduleInfo = {
    name: 'Hub Space',
    desc: "The hub's common space: who is where, and its chat room",
    author: 'zerosquaredio',
};

//
//  The hub's common space inside the board (F19; core/atproto/hub_space.js):
//  who is around on the hub's boards and in its chat room, kept up to date
//  while the member watches, and the room itself. Members who confirmed this
//  board at the hub can talk there; others can watch who is around.
//
//  Needs atProto.hub.presence, and the member shown on the hub (Hub Presence).
//
//  Views: MT1 who is where, MT2 the chat log, ET3 what to say, TL4 status.
//

const FormIds = {
    main: 0,
};

const MciViewIds = {
    map: 1,
    chatLog: 2,
    input: 3,
    status: 4,
};

//  the map is drawn again at most this often, however busy the hub is
const RedrawMs = 1000;

exports.getModule = class HubSpaceModule extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);
        this.config.maxScrollbackLines = this.config.maxScrollbackLines || 300;

        this.live = null;
        this.chat = null;
        this.redrawTimer = null;
        this.lastRedraw = 0;
        this.statusText = { live: '', chat: '' };

        Object.assign(this.menuMethods, {
            sendChatMessage: (formData, extraArgs, cb) => {
                const input = this.getView('main', MciViewIds.input);
                const text = input ? input.getData() : '';
                if (text && this.chat) {
                    this.chat.send(text);
                } else if (text) {
                    this.addLine('|08You can only watch from here.');
                }
                if (input) {
                    input.clearText();
                }
                return cb(null);
            },
            movementKeyPressed: (formData, extraArgs, cb) => {
                const log = this.getView('main', MciViewIds.chatLog);
                if (log && formData.key) {
                    if ('page up' === formData.key.name) {
                        log.keyPressPageUp();
                    } else if ('page down' === formData.key.name) {
                        log.keyPressPageDown();
                    }
                }
                this.viewControllers.main.switchFocus(MciViewIds.input);
                return cb(null);
            },
            quit: (formData, extraArgs, cb) => this.prevMenu(cb),
        });
    }

    initSequence() {
        async.series(
            [
                callback => this.beforeArt(callback),
                callback =>
                    this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen: true },
                        callback
                    ),
            ],
            err => {
                if (err) {
                    this.client.log.warn(
                        { error: err.message },
                        'Hub space could not start'
                    );
                } else {
                    this.startSpace();
                }
                this.finishedLoading();
            }
        );
    }

    startSpace() {
        const found = HubSpace.memberQuery(this.client.user);
        if (!found.settings) {
            this.setStatus('live', '');
            this.drawMap(`|07${HubSpace.pipeSafe(found.reason, 400)}`);
            return;
        }

        //  a chat room: no idle logoff while they watch, unless the sysop
        //  sets one (as MRC does)
        const idle = parseInt(this.config.idleLogoutSeconds, 10);
        if (!isNaN(idle) && idle >= 60) {
            this.client.overrideIdleLogoutSeconds(idle);
        } else {
            this.client.stopIdleMonitor();
        }

        this.live = new HubSpace.HubLive(found.settings, found.query);
        this.live.on('change', () => this.redrawSoon());
        this.live.on('status', text =>
            this.setStatus('live', 'live' === text ? '' : text)
        );
        this.live.on('ended', text => {
            //  what was shown no longer holds
            clearTimeout(this.redrawTimer);
            this.live = null;
            this.setStatus('live', '');
            this.drawMap(`|07${HubSpace.pipeSafe(text, 400)}`);
        });
        this.live.start();
        this.drawMap(HubSpace.renderMap(this.live.model, this.mapSize()));

        if (!found.did) {
            this.addLine('|08Members with a linked Bluesky account can talk here.');
            return;
        }
        this.chat = new HubSpace.HubChat(found.settings, found.query);
        this.chat.on('status', text => {
            if ('connected' === text) {
                this.setStatus('chat', '');
                this.addLine(
                    `|08You are in |11${HubSpace.pipeSafe(this.chat.ticket.room, 40)}|08.`
                );
            } else {
                this.setStatus('chat', text);
            }
        });
        this.chat.on('message', m => this.addMessage(m));
        this.chat.on('notice', text => this.addLine(`|08${HubSpace.pipeSafe(text)}`));
        this.chat.on('ended', text => {
            this.addLine(`|08${HubSpace.pipeSafe(text, 300)}`);
            this.setStatus('chat', '');
            this.chat = null;
        });
        this.chat.start();
    }

    leave() {
        clearTimeout(this.redrawTimer);
        if (this.live) {
            this.live.stop();
            this.live = null;
        }
        if (this.chat) {
            this.chat.stop();
            this.chat = null;
        }
        this.client.restoreIdleLogoutSeconds();
        this.client.startIdleMonitor();
        return super.leave();
    }

    mapSize() {
        const view = this.getView('main', MciViewIds.map);
        const dimens = (view && view.dimens) || {};
        return { width: dimens.width || 76, height: dimens.height || 8 };
    }

    //  At most once a RedrawMs, the last change winning
    redrawSoon() {
        if (this.redrawTimer) {
            return;
        }
        const wait = Math.max(0, this.lastRedraw + RedrawMs - Date.now());
        this.redrawTimer = setTimeout(() => {
            this.redrawTimer = null;
            this.lastRedraw = Date.now();
            if (this.live) {
                this.drawMap(HubSpace.renderMap(this.live.model, this.mapSize()));
            }
        }, wait);
    }

    drawMap(pipeText) {
        const view = this.getView('main', MciViewIds.map);
        if (view) {
            view.setPipeText(pipeText, () => {
                view.redraw();
                this.typeHere();
            });
        }
    }

    setStatus(which, text) {
        this.statusText[which] = text;
        const view = this.getView('main', MciViewIds.status);
        if (view) {
            const shown = [this.statusText.live, this.statusText.chat]
                .filter(Boolean)
                .join(' ');
            view.setText(HubSpace.clean(shown, 200));
            this.typeHere();
        }
    }

    addMessage(m) {
        const when = moment(m.time || undefined);
        const time = (when.isValid() ? when : moment()).format('HH:mm');
        const color = m.own ? '|14' : '|11';
        this.addLine(
            `|08${time} ${color}${HubSpace.pipeSafe(m.label, 60)}|08: |07${HubSpace.pipeSafe(m.text, 1000)}`
        );
    }

    //  A line of pipe-coded text in the chat log, wrapped to it
    addLine(pipeText) {
        const log = this.getView('main', MciViewIds.chatLog);
        if (!log) {
            return;
        }
        const width = (log.dimens && log.dimens.width) || 76;
        const { wrapped } = wordWrapText(pipeText, { width, pipeCodeSupport: true });
        for (const line of wrapped) {
            log.addText(pipeToAnsi(line, this.client), { scrollMode: 'end' });
            if (log.getLineCount() > this.config.maxScrollbackLines) {
                log.deleteLine(0);
            }
        }
        this.typeHere();
    }

    //  the cursor back where the member types
    typeHere() {
        if (this.viewControllers.main) {
            this.viewControllers.main.switchFocus(MciViewIds.input);
        }
    }
};
