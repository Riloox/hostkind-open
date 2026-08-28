'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Minecraft player heads are fetched from Minotar by the Players view. Keep the
// security policy aligned with that intentional image source so the browser does
// not reject the image and leave the reserved head slot blank.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const playersViewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'PlayersView.jsx'), 'utf8');
const helmetBlock = serverSource.match(/app\.use\(helmet\(\{[\s\S]*?\}\)\);/);
assert.ok(helmetBlock, 'the server must configure its Helmet policy');
assert.match(
  helmetBlock[0],
  /imgSrc:\s*\[[^\]]*['"]https:\/\/minotar\.net['"]\s*\]/,
  'CSP img-src must allow the Minotar origin used for player heads'
);
assert.match(
  playersViewSource,
  /<Head name=\{name\} px=\{44\}/,
  'the player list card must render its head through the shared Head component'
);
assert.match(
  playersViewSource,
  /<Head name=\{name \|\| ''\} px=\{72\}/,
  'the player detail dialog must render its head through the shared Head component'
);
assert.match(
  playersViewSource,
  /const headUrl = \(name, px\) => `https:\/\/minotar\.net\/helm\//,
  'both player-head views must use the Minotar URL builder'
);

console.log('PASS player-head-csp');
