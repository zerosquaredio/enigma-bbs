'use strict';

const { strict: assert } = require('assert');

describe('the board account screen, once an account is connected', () => {
    const Publishing = require('../core/atproto/publishing.js');
    const Module = require('../core/atproto_board_account.js').getModule;
    const real = {};

    before(() => {
        for (const name of ['connectBoardAccount', 'getBoardAccount', 'setSplashShown']) {
            real[name] = Publishing[name];
        }
    });
    after(() => {
        Object.assign(Publishing, real);
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
            failed: Module.prototype.failed,
            splashFile: Module.prototype.splashFile,
            viewControllers: {
                menu: {
                    getView: id => (4 === id ? { id } : null),
                    switchFocus: id => focused.push(id),
                },
            },
        };
    }

    it('says so, and that the hub will show its login screen, then moves to the actions', () => {
        Publishing.connectBoardAccount = (identity, cb) => cb(null);
        Publishing.getBoardAccount = () => ({ did: 'did:plc:board', splashShown: true });
        const s = screen();
        Module.prototype.identityProven.call(s, {
            did: 'did:plc:board',
            handle: 'board.example',
        });
        assert.match(
            s.shown[0],
            /^Connected @board\.example, and published its listing\. Its login screen will be shown on the hub, credited to its artist; choose "splash" to stop that\./
        );
        assert.match(s.shown[0], /press ESC to go back/);
        assert.deepEqual(s.focused, [4], 'focus moved to the action bar (HM4)');
    });

    it('says nothing about the splash when the sysop said no before', () => {
        Publishing.connectBoardAccount = (identity, cb) => cb(null);
        Publishing.getBoardAccount = () => ({ did: 'did:plc:board', splashShown: false });
        const s = screen();
        Module.prototype.identityProven.call(s, {
            did: 'did:plc:board',
            handle: 'b.example',
        });
        assert.doesNotMatch(s.shown[0], /splash|login screen/);
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

    it('"splash" turns the hub\'s showing of the login screen off, and on again', async () => {
        const answers = [];
        let shownNow = true;
        Publishing.getBoardAccount = () => ({
            did: 'did:plc:board',
            splashShown: shownNow,
        });
        Publishing.setSplashShown = (shown, cb) => {
            answers.push(shown);
            shownNow = shown;
            const record = shown ? { splash: { sha256: 'ab'.repeat(32) } } : {};
            setImmediate(() => cb(null, { written: true, record }));
        };
        const s = screen();
        const toggle = () => new Promise(r => Module.prototype.toggleSplash.call(s, r));
        await toggle();
        await toggle();
        assert.deepEqual(answers, [false, true]);
        assert.equal(s.shown[0], "The hub won't show the board's login screen any more.");
        assert.match(
            s.shown[1],
            /^The hub may show the board's login screen \(abababababab\), credited to its artist\./
        );
    });

    it('goes to the actions on an empty handle line once an account is connected', async () => {
        const s = screen();
        s.connectedAccount = () => ({ did: 'did:plc:board' });
        let connecting = 0;
        const Login = require('../core/atproto_login.js').getModule;
        const realStart = Login.prototype.startLogin;
        Login.prototype.startLogin = (formData, cb) => {
            connecting++;
            cb(null);
        };
        try {
            const start = value =>
                new Promise(r => Module.prototype.startLogin.call(s, { value }, r));
            await start({ handle: '   ' });
            assert.deepEqual(s.focused, [4], 'on to the action bar');
            assert.equal(connecting, 0);
            await start({ handle: 'board.example' });
            assert.equal(connecting, 1, 'a handle connects, as before');
            s.connectedAccount = () => null;
            await start({ handle: '' });
            assert.equal(
                connecting,
                2,
                'with no account, the login screen says what to do'
            );
        } finally {
            Login.prototype.startLogin = realStart;
        }
    });

    it('sends ENTER in the handle line to connect, whatever the action bar shows', () => {
        const hjson = require('hjson');
        const fs = require('fs');
        const template = hjson.parse(
            fs.readFileSync(
                require.resolve('../misc/menu_templates/main.in.hjson'),
                'utf8'
            )
        );
        const form = template.menus.boardAtProtoAccount.form[0];
        assert.deepEqual(form.submit[1], [
            { value: 'handle', action: '@method:startLogin' },
        ]);
        assert.equal(form.mci.ET1.argName, 'handle');
        assert.equal(form.mci.HM4.items[3], 'splash');
    });

    it('shows the approval link as a QR code too, clear of the handle and the action bar', () => {
        //  as the board account art lays it out: status (MT2) from row 6
        const qr = Module.prototype.qrCodeFor.call(
            {
                menuConfig: { config: { qrCode: true } },
                getView: () => ({ position: { row: 6, col: 1 } }),
                client: { term: { termWidth: 80, termHeight: 25 } },
            },
            'https://test2.hub.cyberspace.nexus/_enig/handoff/7F3K-9QXM'
        );
        assert.deepEqual(
            [qr.row, qr.col],
            [10, 49],
            'below the link line, right of the actions'
        );
    });

    it('draws its fields again once the QR code is cleared, and only then', () => {
        const writes = [];
        let redrawn = 0;
        const s = {
            client: { term: { write: out => writes.push(out) } },
            repositionCursorToFocusedView: () => {},
            viewControllers: { menu: { redrawAll: () => redrawn++ } },
            qrShown: { row: 10, col: 49, lines: ['ab', 'cd'] },
        };
        Module.prototype.clearQrCode.call(s);
        assert.equal(redrawn, 1);
        assert.equal(s.qrShown, null);
        assert.match(writes[0], /\x1b\[10;49H {2}/);
        Module.prototype.clearQrCode.call(s);
        assert.equal(redrawn, 1, 'nothing shown, nothing to draw again');
    });

    it('"splash" needs a connected account', async () => {
        Publishing.getBoardAccount = () => null;
        const s = screen();
        await new Promise(r => Module.prototype.toggleSplash.call(s, r));
        assert.equal(s.shown[0], 'No board account is connected.');
    });
});
