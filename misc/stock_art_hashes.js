#!/usr/bin/env node
'use strict';
//
//  Writes core/atproto/stock_art.json: the SHA-256 of every file under art/
//  in upstream ENiGMA½ at a given commit (default upstream/master), as git
//  holds it. The board's splash screen is offered to its hub by default only
//  when it isn't one of these, since ENiGMA½'s stock art belongs to its
//  artists, not to the sysop (development plan F21). Run it again after
//  merging upstream:
//
//      node misc/stock_art_hashes.js [REF]
//
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const paths = require('path');

const ref = process.argv[2] || 'upstream/master';
const root = paths.join(__dirname, '..');
const git = (...args) =>
    execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const commit = git('rev-parse', `${ref}^{commit}`).toString().trim();
const entries = git('ls-tree', '-r', '-z', commit, '--', 'art/')
    .toString()
    .split('\0')
    .filter(Boolean)
    .map(line => {
        const [meta, path] = line.split('\t');
        return { blob: meta.split(' ')[2], path };
    });
const hashes = new Set();
for (const { blob } of entries) {
    const body = git('cat-file', 'blob', blob);
    hashes.add(crypto.createHash('sha256').update(body).digest('hex'));
}
const out = {
    about: "SHA-256 of every file under art/ in upstream ENiGMA½ (misc/stock_art_hashes.js): its stock art, which belongs to its artists",
    commit,
    sha256: [...hashes].sort(),
};
fs.writeFileSync(
    paths.join(root, 'core', 'atproto', 'stock_art.json'),
    JSON.stringify(out, null, 4) + '\n'
);
console.log(`${hashes.size} hashes from ${entries.length} files at ${commit.slice(0, 12)}`);
