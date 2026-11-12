'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { COMMANDS } = require('../cli/endpoints.cjs');
const { SPECIAL_COMMANDS } = require('../cli/specials.cjs');
const parser = require('../cli/parser.cjs');
const { buildRequest } = require('../cli/main.cjs');

const CLI = path.join(__dirname, '..', 'bin', 'hostkind.cjs');
const SERVER_ID = '22222222-2222-4222-8222-222222222222';
const CREATIVE_ID = '33333333-3333-4333-8333-333333333333';

let server;
let baseUrl;
let tempDir;
let configPath;
let requests = [];
let operationPolls = 0;

function resetRequests() {
  requests = [];
  operationPolls = 0;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-cli-test-'));
  configPath = path.join(tempDir, 'cli.json');
  server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: raw.toString('utf8'),
    };
    requests.push(record);
    const pathname = req.url.split('?')[0];

    if (pathname === '/api/auth-mode') {
      return sendJson(res, { authRequired: true, branding: { name: 'Hostkind' } });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (body.username === 'admin' && body.password === 'secret') {
        return sendJson(res, { token: 'jwt-token', user: { id: 'u1', username: 'admin', role: 'admin', language: 'en' } });
      }
      return sendJson(res, { error: 'wrong credentials' }, 401);
    }
    if (pathname === '/api/me') {
      return sendJson(res, { user: { id: 'u1', username: 'admin', role: 'admin' }, permissions: [] });
    }
    if (pathname === '/api/modules') {
      return sendJson(res, { modules: [{ id: 'minecraft' }, { id: 'terraria' }] });
    }
    if (pathname === '/api/foundation/status') {
      return sendJson(res, { ok: true, foundation: { migrations: 20 } });
    }
    if (pathname === '/api/servers') {
      return sendJson(res, {
        activeServerId: SERVER_ID,
        servers: [
          { id: SERVER_ID, name: 'Survival', status: 'online', type: 'minecraft' },
          { id: CREATIVE_ID, name: 'Creative', status: 'offline', type: 'minecraft' },
        ],
      });
    }
    if (pathname === '/api/command' && req.method === 'POST') {
      return sendJson(res, {
        ok: true,
        body: JSON.parse(raw.toString('utf8') || '{}'),
        serverId: req.headers['x-hostkind-server-id'],
        auth: req.headers.authorization,
      });
    }
    if (pathname === '/api/no-content') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.url.startsWith('/api/echo') && req.method === 'POST') {
      return sendJson(res, { received: JSON.parse(raw.toString('utf8') || '{}') });
    }
    if (pathname === '/api/worlds/w1/delete/preview' && req.method === 'POST') {
      return sendJson(res, { ok: true, preview: { token: 'preview-token', name: 'w1' } });
    }
    if (pathname === '/api/worlds/w1' && req.method === 'DELETE') {
      return sendJson(res, { ok: true, operationId: 'op1', body: JSON.parse(raw.toString('utf8') || '{}') }, 202);
    }
    if (pathname === '/api/worlds/w2/archive' && req.method === 'POST') {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (body.preview) return sendJson(res, { ok: true, preview: { action: 'archive', sizeBytes: 10 } });
      return sendJson(res, { ok: true, operationId: 'op-archive' }, 202);
    }
    if (pathname === '/api/operations/op1' && req.method === 'GET') {
      operationPolls += 1;
      if (operationPolls === 1) return sendJson(res, { ok: true, operation: { id: 'op1', state: 'running', phase: 'commit', progress: 0.5 }, events: [] });
      return sendJson(res, { ok: true, operation: { id: 'op1', state: 'succeeded', phase: 'done', progress: 1 }, events: [] });
    }
    if (req.url.startsWith('/api/files/download')) {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="world.zip"');
      return res.end(Buffer.from('zip-bytes'));
    }
    if (req.url.startsWith('/api/files/upload') && req.method === 'POST') {
      return sendJson(res, { ok: true, length: raw.length, content: raw.toString('utf8') });
    }
    if (pathname === '/api/create' && req.method === 'POST') {
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(`${JSON.stringify({ type: 'phase', phase: 'downloading' })}\n`);
      res.write(`${JSON.stringify({ type: 'progress', received: 5, total: 10 })}\n`);
      res.write(`${JSON.stringify({ type: 'done', server: { id: 's1', name: 'Demo', status: 'offline' } })}\n`);
      return res.end();
    }
    return sendJson(res, { error: `not found ${req.method} ${req.url}` }, 404);
  });
  server.on('upgrade', (req, socket) => {
    if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    const frame = (value) => {
      const payload = Buffer.from(JSON.stringify(value));
      const header = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, payload]));
    };
    frame({ type: 'meta', activeServerId: SERVER_ID, servers: [{ id: SERVER_ID, name: 'Survival' }] });
    frame({ type: 'history', serverId: SERVER_ID, lines: [{ ts: Date.now(), text: 'hello history' }] });
    setTimeout(() => {
      try { frame({ type: 'line', serverId: SERVER_ID, line: { ts: Date.now(), text: 'live line' } }); } catch (_) { /* closed */ }
    }, 40);
    setTimeout(() => { try { socket.end(); } catch (_) { /* closed */ } }, 800);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRequests();
  try { fs.rmSync(configPath, { force: true }); } catch (_) { /* ignore */ }
});

function runCli(args, { env = {}, input = null, token = 'test-token' } = {}) {
  const childEnv = {
    ...process.env,
    HOSTKIND_CLI_CONFIG: configPath,
    HOSTKIND_URL: baseUrl,
    ...env,
  };
  if (token === null) {
    delete childEnv.HOSTKIND_TOKEN;
    delete childEnv.HOSTKIND_API_KEY;
  } else if (token !== undefined) {
    childEnv.HOSTKIND_TOKEN = token;
  }
  delete childEnv.HOSTKIND_SERVER;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [CLI, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (input !== null) child.stdin.end(input);
  else child.stdin.end();
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(result) {
  try { return JSON.parse(result.stdout); } catch (err) {
    throw new Error(`Expected JSON stdout, got:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

test('catalog is complete, unique, and covers every route', () => {
  const names = [...COMMANDS, ...SPECIAL_COMMANDS].map((command) => command.name);
  assert.equal(new Set(names).size, names.length, 'command names must be unique');
  assert.ok(COMMANDS.length > 250, `expected a broad surface, got ${COMMANDS.length}`);
  assert.ok(COMMANDS.some((command) => command.name === 'backups restore'));
  assert.ok(COMMANDS.some((command) => command.name === 'terraria worlds delete'));
  assert.ok(COMMANDS.some((command) => command.name === 'palworld updates apply'));

  // Parse the route modules and compare the real HTTP surface with the catalog.
  const mounts = {
    'addons.cjs': '/api/addons',
    'application-update.cjs': '/api',
    'audit.cjs': '/api/audit',
    'backups.cjs': '/api/backups',
    'bug-reports.cjs': '/api',
    'configs.cjs': '/api/configs',
    'crashes.cjs': '/api/crashes',
    'create.cjs': '/api',
    'files.cjs': '/api/files',
    'health.cjs': '/api/health',
    'minecraft-content.cjs': '/api',
    'minecraft-portability.cjs': '/api/portability/minecraft',
    'modpacks.cjs': '/api',
    'notifications.cjs': '/api/notifications',
    'operations.cjs': '/api/operations',
    'palworld-mods.cjs': '/api',
    'palworld-players.cjs': '/api/palworld',
    'palworld-settings.cjs': '/api/palworld',
    'palworld-updates.cjs': '/api',
    'panel-config.cjs': '/api',
    'players.cjs': '',
    'product.cjs': '/api/product',
    'servers.cjs': '/api',
    'system.cjs': '/api',
    'tasks.cjs': '/api/tasks',
    'terraria-config.cjs': '/api/terraria',
    'terraria-mods.cjs': '/api/terraria/mods',
    'terraria-tshock.cjs': '/api/terraria/tshock',
    'terraria.cjs': '/api/terraria/worlds',
    'trash.cjs': '/api/trash',
    'users.cjs': '/api',
    'valheim.cjs': '/api/valheim/worlds',
    'worlds.cjs': '/api/worlds',
  };
  const normalize = (value) => value.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const actual = new Set();
  const routePattern = /\b(?:router|r)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const [file, mount] of Object.entries(mounts)) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', file), 'utf8');
    let match;
    while ((match = routePattern.exec(text))) {
      const route = match[3];
      if (route.includes('${suffix}')) {
        for (const suffix of ['acknowledge', 'unacknowledge']) {
          actual.add(`${match[1].toUpperCase()} ${normalize(`${mount}/${route.replace('${suffix}', suffix)}`)}`);
        }
      } else {
        actual.add(`${match[1].toUpperCase()} ${normalize(`${mount}/${route}`)}`);
      }
    }
  }
  {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', 'updates.cjs'), 'utf8');
    let match;
    while ((match = routePattern.exec(text))) actual.add(`${match[1].toUpperCase()} ${normalize(`/api/updates/${match[3]}`)}`);
  }
  {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'templates.cjs'), 'utf8');
    const cloneStart = text.indexOf('function cloneRouter');
    let match;
    while ((match = routePattern.exec(text))) {
      const mount = match.index > cloneStart ? '/api/servers' : '/api/templates';
      actual.add(`${match[1].toUpperCase()} ${normalize(`${mount}/${match[3]}`)}`);
    }
  }
  {
    const text = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const inlinePattern = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
    let match;
    while ((match = inlinePattern.exec(text))) {
      if (match[3].startsWith('/api/')) actual.add(`${match[1].toUpperCase()} ${normalize(match[3])}`);
    }
  }
  const declared = new Set(COMMANDS.map((command) => `${command.method} ${command.path}`));
  const intentionallySpecial = new Set(['POST /api/login']);
  const missing = [...actual].filter((route) => !declared.has(route) && !intentionallySpecial.has(route)).sort();
  assert.deepEqual(missing, [], `route(s) without a CLI command:\n${missing.join('\n')}`);
});

test('parser supports flags, negation, repeats, and positionals', () => {
  const parsed = parser.parseOptions(
    ['--name', 'survival', '--yes', '--include-mods', '--tag', 'one', '--tag=two', '--no-follow', 'extra'],
    { options: { 'include-mods': { type: 'boolean' }, tag: { type: 'string' } } },
  );
  assert.deepEqual(parsed.positionals, ['extra']);
  assert.equal(parsed.flags.name, 'survival');
  assert.equal(parsed.flags.yes, true);
  assert.equal(parsed.flags['include-mods'], true);
  assert.deepEqual(parsed.flags.tag, ['one', 'two']);
  assert.equal(parsed.flags.follow, false);
  assert.deepEqual(parser.parseHeaders(['X-Test: yes', 'X-Other=1']), { 'X-Test': 'yes', 'X-Other': '1' });
});

test('buildRequest maps path, body, query, data, and idempotency', () => {
  const spec = {
    method: 'POST',
    path: '/api/worlds/:id/delete',
    bodyArgs: ['name'],
    args: ['id', 'name'],
  };
  const built = buildRequest(spec, {
    args: ['world/one', 'Display Name'],
    flags: { 'include-mods': true, data: '{"radius":10}' },
  });
  assert.equal(built.path, '/api/worlds/world%2Fone/delete');
  assert.deepEqual(built.body, { name: 'Display Name', includeMods: true, radius: 10 });
  assert.ok(built.headers['Idempotency-Key']);

  const read = buildRequest({
    method: 'GET',
    path: '/api/files/read',
    args: ['path'],
    queryArgs: ['path'],
  }, { args: ['server.properties'], flags: { range: 'day' } });
  assert.equal(read.query.path, 'server.properties');
  assert.equal(read.query.range, 'day');
});

test('servers list authenticates, resolves a server name, and prints JSON', async () => {
  const result = await runCli(['servers', 'list', '--json'], { env: { HOSTKIND_SERVER: 'Survival' } });
  assert.equal(result.code, 0, result.stderr);
  const data = parseJson(result);
  assert.equal(data.servers.length, 2);
  assert.equal(requests[0].headers.authorization, 'Bearer test-token');
  const last = requests[requests.length - 1];
  assert.equal(last.headers['x-hostkind-server-id'], SERVER_ID);
});

test('console run sends one command to the selected server', async () => {
  const result = await runCli(['console', 'run', 'say hello', '--server', 'Creative', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const data = parseJson(result);
  assert.equal(data.body.cmd, 'say hello');
  assert.equal(data.serverId, CREATIVE_ID);
  assert.equal(requests[requests.length - 1].method, 'POST');
});

test('destructive commands require --yes and preview before applying', async () => {
  const blocked = await runCli(['worlds', 'delete', 'w1', '--json']);
  assert.equal(blocked.code, 4);
  assert.equal(requests.length, 0, 'confirmation is checked before any request');
  assert.ok(!requests.some((request) => request.url.includes('delete/preview')));

  resetRequests();
  const preview = await runCli(['worlds', 'delete', 'w1', '--preview', '--json']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(parseJson(preview).preview.token, 'preview-token');
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), ['POST /api/worlds/w1/delete/preview']);

  resetRequests();
  const applied = await runCli(['worlds', 'delete', 'w1', '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    'POST /api/worlds/w1/delete/preview',
    'DELETE /api/worlds/w1',
  ]);
  const remove = requests[1];
  assert.equal(JSON.parse(remove.body).token, 'preview-token');
  assert.ok(remove.headers['idempotency-key']);
  assert.equal(parseJson(applied).operationId, 'op1');
});

test('a preview without a token still previews before applying', async () => {
  const result = await runCli(['worlds', 'archive', 'w2', '--yes', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseJson(result).operationId, 'op-archive');
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    'POST /api/worlds/w2/archive',
    'POST /api/worlds/w2/archive',
  ]);
  assert.equal(JSON.parse(requests[0].body).preview, true);
  const appliedBody = requests[1].body ? JSON.parse(requests[1].body) : {};
  assert.equal(appliedBody.preview, undefined);
});

test('--wait follows an operation to a terminal state', async () => {
  const result = await runCli(['worlds', 'delete', 'w1', '--yes', '--wait', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const final = parseJson(result);
  assert.equal(final.state, 'succeeded');
  assert.equal(operationPolls, 2);
});

test('api forwards method, JSON body, and query parameters', async () => {
  const result = await runCli(['api', 'POST', '/api/echo', '--data', '{"answer":42}', '--query', 'trace=1', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseJson(result).received.answer, 42);
  const request = requests[requests.length - 1];
  assert.equal(request.url, '/api/echo?trace=1');
  assert.equal(JSON.parse(request.body).answer, 42);
  assert.ok(request.headers['idempotency-key']);
});

test('downloads write a file and uploads use multipart', async () => {
  const outDir = fs.mkdtempSync(path.join(tempDir, 'download-'));
  const download = await runCli(['files', 'download', 'plugins/test.jar', '--output', outDir, '--json']);
  assert.equal(download.code, 0, download.stderr);
  const downloaded = parseJson(download);
  assert.equal(fs.readFileSync(downloaded.file, 'utf8'), 'zip-bytes');
  assert.equal(downloaded.bytes, 9);

  const uploadFile = path.join(tempDir, 'example.jar');
  fs.writeFileSync(uploadFile, 'jar-bytes');
  const upload = await runCli(['files', 'upload', '--file', uploadFile, '--path', 'plugins', '--json']);
  assert.equal(upload.code, 0, upload.stderr);
  assert.equal(parseJson(upload).ok, true);
  const request = requests[requests.length - 1];
  assert.match(request.url, /^\/api\/files\/upload\?path=plugins/);
  assert.match(request.body, /name="files"/);
  assert.match(request.body, /jar-bytes/);
});

test('servers create streams NDJSON progress and returns the created server', async () => {
  const result = await runCli([
    'servers', 'create', '--type', 'vanilla', '--name', 'Demo',
    '--version', '1.20.4', '--accept-eula', '--yes', '--json',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'phase' && event.phase === 'downloading'));
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.server.name, 'Demo');
  const request = requests[requests.length - 1];
  const body = JSON.parse(request.body);
  assert.equal(body.type, 'vanilla');
  assert.equal(body.name, 'Demo');
  assert.equal(body.mcVersion, '1.20.4');
  assert.equal(body.eula, true);
});

test('login saves a profile and logout keeps its URL', async () => {
  const login = await runCli(['login', '--username', 'admin', '--password', 'secret', '--json'], { token: null });
  assert.equal(login.code, 0, login.stderr);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.profiles.default.token, 'jwt-token');
  assert.equal(saved.profiles.default.url, baseUrl);

  resetRequests();
  const who = await runCli(['whoami', '--json'], { token: null });
  assert.equal(who.code, 0, who.stderr);
  assert.equal(parseJson(who).user.username, 'admin');
  assert.equal(requests[0].headers.authorization, 'Bearer jwt-token');

  resetRequests();
  const doctor = await runCli(['doctor', '--json'], { token: null });
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(parseJson(doctor).ok, true);

  const logout = await runCli(['logout', '--json'], { token: null });
  assert.equal(logout.code, 0, logout.stderr);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(after.profiles.default.token, undefined);
  assert.equal(after.profiles.default.url, baseUrl);
});

test('table output renders server rows', async () => {
  const result = await runCli(['servers', 'list', '--table']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Survival/);
  assert.match(result.stdout, /Creative/);
  assert.match(result.stdout, /status/);
});

test('console history and tail read the WebSocket stream', async () => {
  const history = await runCli(['console', 'history', '--json']);
  assert.equal(history.code, 0, history.stderr);
  const historyLine = history.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(historyLine.some((line) => line.text === 'hello history'));

  const tail = await runCli(['console', 'tail', '--until', 'live line', '--timeout', '5', '--json']);
  assert.equal(tail.code, 0, tail.stderr);
  const lines = tail.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.text === 'hello history'));
  assert.ok(lines.some((line) => line.text === 'live line'));
});

test('commands --json is a machine-readable manifest', async () => {
  const result = await runCli(['commands', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = parseJson(result);
  assert.equal(manifest.commands.length, COMMANDS.length + SPECIAL_COMMANDS.length);
  assert.ok(manifest.commands.every((command) => command.name));
  assert.ok(manifest.commands.some((command) => command.name === 'api'));
});

test('mistyped commands fail as usage errors with a suggestion', async () => {
  const index = parser.buildIndex([...SPECIAL_COMMANDS, ...COMMANDS].map((command) => ({ ...command })));
  // `servers` is an alias for `servers list`; a stray word is a typo, not an argument.
  const typo = parser.matchCommand(['servers', 'lst'], index);
  assert.equal(typo.kind, 'error');
  assert.match(typo.hint, /servers list/);
  assert.match(parser.matchCommand(['worlds', 'delet', 'x'], index).hint, /worlds delete/);
  assert.match(parser.matchCommand(['logn'], index).hint, /hostkind login/);

  const result = await runCli(['servers', 'lst', '--json']);
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'unknown_command');
  assert.match(error.hint, /servers list/);
});

test('console run joins the remaining words into one command', () => {
  const spec = COMMANDS.find((command) => command.name === 'console run');
  const built = buildRequest(spec, { args: ['say', 'hello', 'world'], flags: {} });
  assert.equal(built.body.cmd, 'say hello world');
  assert.equal(buildRequest(spec, { args: ['say hi'], flags: {} }).body.cmd, 'say hi');
});

test('confirmation errors explain how to proceed', async () => {
  const result = await runCli(['worlds', 'delete', 'w1', '--json']);
  assert.equal(result.code, 4);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'confirmation_required');
  assert.match(error.hint, /--yes/);
});

test('shell completion offers one word at a time', async () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const result = await runCli(['completion', shell]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /'servers'\)? ?(words=)?/);
  }
  const bash = await runCli(['completion', 'bash']);
  // No candidate may contain a space; shells would insert it as one word.
  const caseLines = bash.stdout.split('\n').filter((line) => /^ {6}'.*'\) words=/.test(line));
  assert.ok(caseLines.length > 10);
  const servers = caseLines.find((line) => line.startsWith("      'servers')"));
  assert.match(servers, /words='[^']*\blist\b[^']*'/);
  assert.doesNotMatch(servers, /servers list/);
});

test('a command with no output still prints JSON when piped', async () => {
  const result = await runCli(['api', 'POST', '/api/no-content', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});
