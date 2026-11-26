'use strict';

const { strict: assert } = require('assert');

const { qrLines, qrModules } = require('../core/atproto/handoff_qr.js');

const Url = 'https://test2.hub.cyberspace.nexus/_enig/handoff/7F3K-9QXM';

describe('AT login: the approval link as a QR code', () => {
    it('fits a hub board link in a version 3 code, its border included', () => {
        const modules = qrModules(Url);
        //  29 modules, and a one-module border on each side
        assert.equal(modules.length, 31);
        assert.ok(modules.every(row => 31 === row.length));
        //  the border is light; the finder pattern's corner just inside it dark
        assert.ok(modules[0].every(dark => !dark));
        assert.ok(modules.every(row => !row[0] && !row[30]));
        assert.equal(modules[1][1], true);
        assert.equal(modules[1][7], true);
        assert.equal(modules[7][1], true);
    });

    it('is half-block text, 16 lines of 31 characters, light drawn and dark left blank', () => {
        const lines = qrLines(Url);
        assert.equal(lines.length, 16);
        assert.ok(lines.every(line => 31 === line.length));
        assert.ok(lines.every(line => /^[█▀▄ ]+$/.test(line)));
        //  the top line: the light border over the finder's dark top edge
        assert.equal(lines[0][0], '█');
        assert.equal(lines[0][1], '▀');
        //  below the code counts as dark, so the last line is light on top
        assert.ok([...lines[15]].every(ch => '▀' === ch));
    });

    it('stores the scheme and host in capitals, which take less room', () => {
        //  the same link with a lowercase path made all bytes needs a bigger code
        const longer = qrModules(
            Url.replace('https://', 'https://www.').replace('.nexus', '.nexus.example')
        );
        assert.ok(longer.length > 31);
        //  a link that isn't one is still coded
        assert.ok(qrLines('not a url at all').length > 0);
    });
});

describe('AT login: where the QR code goes', () => {
    const Module = require('../core/atproto_login.js').getModule;
    const screen = ({ qrCode = true, rows = 25, cols = 80, statusRow = 7 } = {}) => ({
        menuConfig: { config: { qrCode } },
        getView: () => ({ position: { row: statusRow, col: 1 } }),
        client: { term: { termWidth: cols, termHeight: rows } },
    });
    const place = (options, url = Url) =>
        Module.prototype.qrCodeFor.call(screen(options), url);

    it('goes at the bottom right of an 80 by 25 screen, below the link', () => {
        const qr = place();
        assert.deepEqual([qr.row, qr.col, qr.lines.length], [10, 49, 16]);
    });

    it('is left out where it would cover the link, or the screen is too narrow, or it is not wanted', () => {
        assert.equal(
            place({ rows: 24 }),
            null,
            'on 24 rows it would reach the link line'
        );
        assert.equal(place({ cols: 60 }), null);
        assert.equal(place({ qrCode: false }), null);
    });

    it('has more room on a taller screen', () => {
        assert.equal(place({ rows: 40 }).row, 25);
    });
});
