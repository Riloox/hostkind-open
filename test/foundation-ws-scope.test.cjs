'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

/*
 * The WebSocket handshake and live broadcast are embedded in the large server
 * module and cannot be required in isolation, so - like the ws-command suite -
 * assert the per-server scope filtering is actually wired in by inspecting the
 * source. The filter must never regress into "every socket sees every server":
 * that is the leak that makes the operator story untrue.
 */
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const tests = [];

// 1. The meta list on connect is filtered by what the caller may see.
tests.push(() => {
  const conn = SERVER_JS.slice(SERVER_JS.indexOf("wss.on('connection', (ws, req) => {"));
  const handshake = conn.slice(0, conn.indexOf("ws.on('message'"));
  assert.ok(/hasAnyPerServerGrant\(user, s\.id\)/.test(handshake),
    'the meta list must be filtered per server by grant');
  assert.ok(/visibleServers\.map/.test(handshake),
    'the meta list must come from the visible subset, not config.servers');
  assert.ok(!/config\.servers\.map\(\(s\) => \(\{ id: s\.id, name: s\.name \}\)\)/.test(handshake),
    'the handshake must not enumerate every registered server');
});

// 2. The per-server status loop only iterates the visible subset.
tests.push(() => {
  const conn = SERVER_JS.slice(SERVER_JS.indexOf("wss.on('connection', (ws, req) => {"));
  const handshake = conn.slice(0, conn.indexOf("ws.on('message'"));
  assert.ok(/for \(const s of visibleServers\)/.test(handshake),
    'the status burst must iterate only visible servers');
});

// 3. The active server is derived from the visible subset, so an operator is
//    never attached to a server they cannot see.
tests.push(() => {
  const conn = SERVER_JS.slice(SERVER_JS.indexOf("wss.on('connection', (ws, req) => {"));
  const handshake = conn.slice(0, conn.indexOf("ws.on('message'"));
  assert.ok(/visibleServers\.some\(\(s\) => s\.id === config\.activeServerId\)/.test(handshake),
    'the initial selection must require a grant on the active server');
});

// 4. The live broadcast filters per-client frames that name a server.
tests.push(() => {
  const fn = SERVER_JS.slice(SERVER_JS.indexOf('function globalBroadcast(obj) {'));
  const end = fn.indexOf('\n}');
  const body = fn.slice(0, end);
  assert.ok(/frameServerId == null/.test(body),
    'a server-less frame must still reach every socket');
  assert.ok(/obj\.notification && obj\.notification\.serverId/.test(body),
    'a notification frame must be scoped by the server inside its payload');
  assert.ok(/hasAnyPerServerGrant\(ws\.fleetdeckUser \|\| null, frameServerId\)/.test(body),
    'a server-scoped frame must be gated on the socket caller\'s grants');
});

// 5. The notification snapshot sent on connect is filtered the same way.
tests.push(() => {
  const conn = SERVER_JS.slice(SERVER_JS.indexOf("wss.on('connection', (ws, req) => {"));
  const handshake = conn.slice(0, conn.indexOf("ws.on('message'"));
  assert.ok(/notifications\.filter\(\(n\) => notificationVisible\(user, n\)\)/.test(handshake),
    'the handshake must only send notifications the caller may see');
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  ws-scope test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  ws-scope test ${i + 1}: ${e.message}\n${e.stack}`); }
}
if (failed) { console.error(`FAIL  ${failed} ws-scope test(s) failed`); process.exit(1); }
console.log('PASS  foundation-ws-scope');
