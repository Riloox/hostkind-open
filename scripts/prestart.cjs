'use strict';

/*
 * npm prestart: fail fast when the panel would come up with no SPA to serve.
 * server.js serves public/ statically and falls back to public/index.html for
 * SPA routes, so on a fresh clone without `npm run build` the panel starts but
 * renders nothing. We do not auto-build - builds are slow and surprising - we
 * refuse and tell the operator what to run.
 */

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const index = path.join(publicDir, 'index.html');
const problems = [];
if (!fs.existsSync(index)) {
  problems.push('public/index.html is missing - the SPA has not been built.');
}
// An index.html alone is not a working SPA: a stale or partial `vite build`
// (or a lone hand-written file) leaves the panel serving a shell with no
// bundle. Require at least one built .js chunk under public/assets/.
let assetCount = 0;
try {
  const assetsDir = path.join(publicDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const entry of fs.readdirSync(assetsDir)) {
      if (entry.endsWith('.js')) assetCount += 1;
    }
  }
} catch (_) { /* unreadable assets dir counts as zero assets */ }
if (assetCount === 0) {
  problems.push('public/assets/ has no built .js bundle - the SPA build is missing or incomplete.');
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`Hostkind: ${problem}`);
  console.error('Run `npm run build` first, then start the panel again.');
  process.exit(1);
}
