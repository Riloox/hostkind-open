'use strict';

/*
 * A console command typed in the UI reaches the server the UI is showing.
 *
 * Regression: with sign-in off the socket belongs to the guest principal,
 * which has no row in config.users. The `selectServer` handler looked the
 * caller up there, refused every selection, and left the socket attached to
 * the config's active server - so a command typed on any other server's
 * console was written to the active server's stdin instead.
 *
 * Boots a real panel on a temp config with two echo servers (the second is
 * not the active one), selects the second, and checks that:
 *   1. the selection is accepted (a history frame for it arrives),
 *   2. a command naming the server reaches that server's process,
 *   3. a command without a serverId follows the selection,
 *   4. a command to a stopped server comes back as an error frame.
 *   5. pseudo-console output (how Terraria runs on Windows) reaches the
 *      console clean: no title text, no screen-repaint blank rows.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Echoes every stdin line back as "echo:<line>".
const ECHO = "process.stdin.setEncoding('utf8');let b='';console.log('ready');"
  + "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){console.log('echo:'+b.slice(0,i).trim());b=b.slice(i+1);}});";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitFor(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-ws-console-'));
  const port = await freePort();
  const server = (id, name) => ({
    id, name, type: 'custom', dir: tmp,
    executable: process.execPath, args: ['-e', ECHO],
    healthCheckRegex: '^ready$', stopSignal: 'SIGTERM',
  });
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ...template,
    requireAuth: false,
    users: [],
    servers: [server('srv-a', 'A'), server('srv-b', 'B'), server('srv-c', 'C'), {
      // What a Windows pseudo-console (conhost --headless) writes: rows
      // cleared with ESC[K, and a window title (OSC) glued to the ready line.
      ...server('srv-d', 'D'),
      args: ['-e', "process.stdout.write('\\u001b[K\\r\\n\\u001b[K\\r\\n\\u001b]0;Terraria Server: World\\u0007: Server started\\r\\n\\r\\nafter\\r\\n');setInterval(()=>{},1e6);"],
      healthCheckRegex: '^: Server started$',
    }],
    activeServerId: 'srv-a',
  }, null, 2));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, FLEETDECK_CONFIG: configPath, FLEETDECK_DATA_DIR: path.join(tmp, 'data'), FLEETDECK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });

  let ws;
  let failed = 0;
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(() => /listening|http:\/\/|127\.0\.0\.1:\d+/i.test(log), 'panel boot', 20_000);
    const start = async (id) => {
      let res;
      for (let i = 0; i < 40; i += 1) {
        try {
          res = await fetch(`${base}/api/servers/${id}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `start-${id}-${Date.now()}` },
            body: '{}',
          });
          break;
        } catch (_) { await sleep(250); }
      }
      assert.ok(res && res.ok, `start ${id}: ${res && res.status} ${res && await res.text()}`);
    };
    await start('srv-a');
    await start('srv-b');

    const frames = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => { frames.push(JSON.parse(String(d))); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const lineFrom = (id, text) => frames.some((f) => f.type === 'line' && f.serverId === id && f.line.text === text);

    // 1. Selecting a non-active server is accepted for the guest.
    ws.send(JSON.stringify({ type: 'selectServer', serverId: 'srv-b' }));
    await waitFor(() => frames.some((f) => f.type === 'history' && f.serverId === 'srv-b')
      || frames.some((f) => f.type === 'error'), 'selection reply');
    assert.ok(!frames.some((f) => f.code === 'server_selection_forbidden'), 'guest selection must not be refused');

    await waitFor(() => lineFrom('srv-a', 'ready') || frames.some((f) => f.type === 'history' && f.serverId === 'srv-b'
      && f.lines.some((l) => l.text === 'ready')) || lineFrom('srv-b', 'ready'), 'servers ready');

    // 2. An explicit target reaches that process.
    ws.send(JSON.stringify({ type: 'command', serverId: 'srv-b', cmd: 'explicit' }));
    await waitFor(() => lineFrom('srv-b', 'echo:explicit'), 'explicit command echo');

    // 3. No serverId: the selection decides, not the config's active server.
    ws.send(JSON.stringify({ type: 'command', cmd: 'implicit' }));
    await waitFor(() => lineFrom('srv-b', 'echo:implicit'), 'implicit command echo');
    assert.ok(!lineFrom('srv-a', 'echo:implicit'), 'command must not land on the active server');

    // 4. A stopped server answers with an error frame instead of silence.
    ws.send(JSON.stringify({ type: 'command', serverId: 'srv-c', cmd: 'nobody' }));
    await waitFor(() => frames.some((f) => f.type === 'error' && f.code === 'command_failed' && f.serverId === 'srv-c'), 'command_failed frame');
    const err = frames.find((f) => f.code === 'command_failed');
    assert.ok(typeof err.error === 'string' && err.error.length > 0, 'error frame carries a readable message');

    // 5. Pseudo-console output: the title is stripped so readiness matches,
    // screen-repaint rows are dropped, and a real blank line survives.
    await start('srv-d');
    await waitFor(() => lineFrom('srv-d', 'after'), 'pseudo-console output');
    ws.send(JSON.stringify({ type: 'selectServer', serverId: 'srv-d' }));
    await waitFor(() => frames.some((f) => f.type === 'history' && f.serverId === 'srv-d'), 'srv-d history');
    const texts = frames.filter((f) => f.type === 'history' && f.serverId === 'srv-d').pop().lines
      .map((l) => l.text).filter((t) => !t.startsWith('['));
    assert.deepEqual(texts, [': Server started', '', 'after'], 'clean pseudo-console lines');
    await waitFor(() => frames.some((f) => f.type === 'status' && f.status
      && (f.status.id === 'srv-d' || f.status.serverId === 'srv-d') && f.status.status === 'online'),
    'the ready line behind a window title to be recognised');
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ws-console-target: ${e.message}\n--- panel log ---\n${log.slice(-3000)}`);
  } finally {
    try { ws && ws.close(); } catch (_) { /* */ }
    child.kill();
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  }
  if (failed) process.exit(1);
  console.log('PASS  ws-console-target');
}

main();
