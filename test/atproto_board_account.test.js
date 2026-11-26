'use strict';

const { strict: assert } = require('assert');

describe('the board account screen, once an account is connected', () => {
    const Publishing = require('../core/atproto/publishing.js');
    const Module = require('../core/atproto_board_account.js').getModule;
    let realConnect;

    before(() => {
        realConnect = Publishing.connectBoardAccount;
    });
    after(() => {
        Publishing.connectBoardAccount = realConnect;
    });

    //  a stand-in for the screen: what it shows, and where the focus goes
    function screen() {
        const shown = [];
        const focused = [];
        return {
            shown,
            focused,
            client: { log: { warn() {} } },
            showStatus: (message, values = {}) =>
                shown.push(message.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m)),
            focusActions: Module.prototype.focusActions,
            viewControllers: {
                menu: {
                    getView: id => (4 === id ? { id } : null),
                    switchFocus: id => focused.push(id),
                },
            },
        };
    }

    it('says so, and moves to the actions, saying ESC goes back', () => {
        Publishing.connectBoardAccount = (identity, cb) => cb(null);
        const s = screen();
        Module.prototype.identityProven.call(s, {
            did: 'did:plc:board',
            handle: 'board.example',
        });
        assert.match(
            s.shown[0],
            /^Connected @board\.example, and published its listing\./
        );
        assert.match(s.shown[0], /press ESC to go back/);
        assert.deepEqual(s.focused, [4], 'focus moved to the action bar (HM4)');
    });

    it('moves to the actions too when the listing could not be published', () => {
        Publishing.connectBoardAccount = (identity, cb) => cb(new Error('host down'));
        const s = screen();
        Module.prototype.identityProven.call(s, { did: 'did:plc:board', handle: null });
        assert.match(
            s.shown[0],
            /^Connected did:plc:board, but the listing could not be published: host down\./
        );
        assert.deepEqual(s.focused, [4]);
    });
});
