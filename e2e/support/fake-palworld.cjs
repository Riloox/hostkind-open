'use strict';

/*
 * A stand-in Palworld dedicated server for the browser tests.
 *
 * Hostkind's palworld module proves readiness from the REST API, because on
 * Windows the real server writes its console to its own window and the
 * "Running Palworld dedicated server" line never reaches the panel's pipe. So
 * this script never prints that line by default - only FAKE_READY=1 turns it
 * on. What it always does is serve a real /v1/api health surface on the port
 * the panel has been configured with, which is what a start relies on to
 * promote starting -> online through the module's own polling.
 *
 *   FAKE_REST_PORT   the port to serve the API on (default 8212)
 *   FAKE_REST_MS     delay before the API starts answering (default 0)
 *   FAKE_READY=1     print the console readiness line after FAKE_BOOT_MS
 */

const http = require('http');

const bootMs = Number(process.env.FAKE_BOOT_MS || 100);
const restMs = Number(process.env.FAKE_REST_MS || 0);
const ready = process.env.FAKE_READY === '1';
const restPort = Number(process.env.FAKE_REST_PORT || 8212);

function say(line) {
  process.stdout.write(`${line}\n`);
}

say('[fake] booting');
setTimeout(() => {
  if (ready) say('Running Palworld dedicated server on :8211');
}, bootMs);

const players = [
  {
    name: 'Lamball',
    userid: 'steam_1',
    accountName: 'steam_account',
    // The real Palworld REST API sends FLAT location_x/location_y fields and
    // (as of v1.0.2.x) omits location_z entirely - the map projects the
    // horizontal plane only. Serving the real shape keeps the adapter's
    // flat-field fallback (and the missing-z tolerance) under test.
    // FAKE_PLAYER_X/Y let a spec place the player anywhere in the world - e.g.
    // on a known grid line to pin which world axis the map projects where.
    location_x: Number(process.env.FAKE_PLAYER_X ?? 10),
    location_y: Number(process.env.FAKE_PLAYER_Y ?? 20),
    level: 12,
    ping: 42,
  },
];

let online = false;

const server = http.createServer((req, res) => {
  const endpoint = (req.url || '').replace(/^\/v1\/api/, '');
  if (req.method === 'POST' && endpoint === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK' }));
    say('[fake] stopping');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (!online) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not ready' }));
    return;
  }
  const base = { status: 'OK' };
  let body;
  if (endpoint === '/info') {
    body = { ...base, version: 'v0.6.2', servername: 'Fake Palworld', description: 'fixture' };
  } else if (endpoint === '/metrics') {
    body = { ...base, days: 2, uptime: 1000, currentplayernum: players.length, maxplayernum: 32, serverfps: 60, serverframetime: 16.6, basecampnum: 2 };
  } else if (endpoint === '/players') {
    body = { ...base, players };
  } else {
    body = base;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  say(`[fake] REST accessed endpoint ${req.url} OK`);
});

setTimeout(() => {
  online = true;
  server.listen(restPort, '127.0.0.1', () => say(`[fake] REST API started on port ${restPort}`));
}, restMs);

// A stop that arrives as a signal rather than the shutdown endpoint still shuts
// down cleanly, which is what the panel falls back to when REST is unreachable.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    say('[fake] stopping');
    process.exit(0);
  });
}

// Keep the event loop alive even if stdin closes.
setInterval(() => {}, 1 << 30);
