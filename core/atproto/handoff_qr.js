/* jslint node: true */
'use strict';

//  deps
const qrGen = require('qrcode-generator');

//
//  A QR code for a browser handoff link (core/browser_handoff.js), drawn in
//  the terminal with half-block characters, so a caller at a computer can
//  approve on their phone by pointing its camera at the screen.
//
//  Two modules make one character cell: ▀ ▄ █ or a space, white on black,
//  with a one-module light border (the quiet zone) so a camera finds it on a
//  dark screen. The scheme and host are written in capitals, which QR codes
//  store more compactly (alphanumeric mode), and which mean the same in a
//  URL; the path keeps its case. A typical handoff link then fits a version
//  3 code: 29 modules, 31 with the border, 16 rows of text.
//

//  QR's alphanumeric mode: what it can hold
const AlphanumericRe = /^[0-9A-Z $%*+\-./:]*$/;
const QuietZone = 1;

//  The code's modules, true where dark, including the border
function qrModules(url) {
    const qr = qrGen(0, 'L');
    let head = '';
    let rest = url;
    try {
        const parsed = new URL(url);
        const origin = `${parsed.protocol}//${parsed.host}`.toUpperCase();
        if (AlphanumericRe.test(origin) && url.toUpperCase().startsWith(origin)) {
            head = origin;
            rest = url.slice(origin.length);
        }
    } catch (e) {
        //  not a URL: all of it as bytes
    }
    if (head) {
        qr.addData(head, 'Alphanumeric');
    }
    if (rest) {
        qr.addData(rest, 'Byte');
    }
    qr.make();

    const count = qr.getModuleCount();
    const size = count + 2 * QuietZone;
    const modules = [];
    for (let y = 0; y < size; ++y) {
        const row = [];
        for (let x = 0; x < size; ++x) {
            const qx = x - QuietZone;
            const qy = y - QuietZone;
            row.push(qx >= 0 && qy >= 0 && qx < count && qy < count && qr.isDark(qy, qx));
        }
        modules.push(row);
    }
    return modules;
}

//
//  The code as lines of text, two module rows to a line: light modules are
//  drawn (white), dark ones left as the black background. Below the last
//  module row counts as dark, as the screen around it is.
//
function qrLines(url) {
    const modules = qrModules(url);
    const lines = [];
    for (let y = 0; y < modules.length; y += 2) {
        const top = modules[y];
        const bottom = modules[y + 1];
        let line = '';
        for (let x = 0; x < top.length; ++x) {
            const topLight = !top[x];
            const bottomLight = bottom ? !bottom[x] : false;
            line +=
                topLight && bottomLight ? '█' : topLight ? '▀' : bottomLight ? '▄' : ' ';
        }
        lines.push(line);
    }
    return lines;
}

exports.qrModules = qrModules;
exports.qrLines = qrLines;
