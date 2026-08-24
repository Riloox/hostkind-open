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

const index = path.join(__dirname, '..', 'public', 'index.html');
if (!fs.existsSync(index)) {
  console.error('Hostkind: public/index.html is missing - the SPA has not been built.');
  console.error('Run `npm run build` first, then start the panel again.');
  process.exit(1);
}
