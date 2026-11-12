'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config.cjs');
const parser = require('./parser.cjs');
const output = require('./output.cjs');
const { createClient } = require('./http.cjs');
const ws = require('./ws.cjs');

const SPECIAL_COMMANDS = [
  { group: 'auth', action: 'login', name: 'login', special: 'login', summary: 'Sign in and save a credential profile', args: [], aliases: ['auth login'] },
  { group: 'auth', action: 'logout', name: 'logout', special: 'logout', summary: 'Remove saved credentials', args: [], aliases: ['auth logout'] },
  { group: 'auth', action: 'doctor', name: 'doctor', special: 'doctor', summary: 'Check the panel, credentials, and CLI configuration', args: [], aliases: ['auth doctor'] },
  { group: 'api', action: '', name: 'api', special: 'api', summary: 'Call any panel endpoint directly', args: ['method', 'path'] },
  { group: 'commands', action: '', name: 'commands', special: 'commands', summary: 'List every CLI command (or one group)', args: ['group'] },
  { group: 'completion', action: '', name: 'completion', special: 'completion', summary: 'Print shell completion for bash, zsh, or fish', args: ['shell'] },
  { group: 'serve', action: '', name: 'serve', special: 'serve', summary: 'Run the Hostkind panel in this terminal', args: [] },
  { group: 'version', action: '', name: 'version', special: 'version', summary: 'Show CLI and protocol versions', args: [] },
  { group: 'wait', action: '', name: 'wait', special: 'wait', summary: 'Follow a durable operation until it finishes', args: ['operationId'] },
  { group: 'profile', action: 'list', name: 'profile list', special: 'profile-list', summary: 'List saved profiles', args: [] },
  { group: 'profile', action: 'use', name: 'profile use', special: 'profile-use', summary: 'Select the default profile', args: ['name'] },
  { group: 'profile', action: 'show', name: 'profile show', special: 'profile-show', summary: 'Show one profile without secrets', args: ['name'] },
  { group: 'profile', action: 'set', name: 'profile set', special: 'profile-set', summary: 'Create or edit a profile', args: ['name'] },
  { group: 'profile', action: 'remove', name: 'profile remove', special: 'profile-remove', summary: 'Delete a profile', args: ['name'] },
  { group: 'console', action: 'tail', name: 'console tail', special: 'console-tail', summary: 'Stream console history and live lines', args: [] },
  { group: 'console', action: 'history', name: 'console history', special: 'console-history', summary: 'Print console history and exit', args: [] },
  { group: 'console', action: 'watch', name: 'console watch', special: 'console-watch', summary: 'Stream status, stats, and notifications', args: [] },
];

const FAILED_STATES = new Set(['failed', 'cancelled', 'recovery_required']);
const TERMINAL_STATES = new Set(['succeeded', ...FAILED_STATES]);

function packageVersion() {
  try { return require('../package.json').version; } catch (_) { return '0.0.0'; }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(Object.assign(new Error('No password supplied and stdin is not a TTY.'), { code: 'missing_password' }));
      return;
    }
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (buffer) => {
      const text = buffer.toString('utf8');
      for (const char of text) {
        if (char === '\u0003' || (char === '\u0004' && !value)) { cleanup(); process.stderr.write('\n'); reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' })); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stderr.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') { if (value) value = value.slice(0, -1); continue; }
        if (char === '\u001b') continue;
        value += char;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw || false); } catch (_) { /* ignore */ }
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { resolve(answer.trim()); rl.close(); });
    rl.on('close', () => resolve(''));
  });
}

// Print a sentence for a person at a terminal, the structured payload otherwise.
function report(ctx, payload, message) {
  if (message && output.isHuman(ctx.flags)) process.stdout.write(`${message}\n`);
  else output.printResult(payload, ctx.flags);
}

function timeoutMs(flags) {
  if (flags.timeout === undefined) return 30_000;
  const seconds = Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw Object.assign(new Error('--timeout must be a non-negative number of seconds.'), { code: 'invalid_timeout' });
  }
  return seconds === 0 ? 0 : seconds * 1000;
}

function boolFlag(flags, name) {
  return flags[name] === true;
}

function normalizeOutputFlags(flags) {
  if (flags.format === 'json') flags.json = true;
  if (flags.format === 'table') flags.table = true;
  if (flags.format === 'raw' || flags.format === 'plain') flags.raw = true;
  if (flags.stdout) flags.output = '-';
  return flags;
}

function buildContext({ flags, args, cfg, profileName, index }) {
  normalizeOutputFlags(flags);
  const url = config.resolveUrl(flags, cfg, profileName);
  const credentials = config.resolveCredentials(flags, cfg, profileName);
  const server = config.resolveServer(flags, cfg, profileName);
  const client = createClient({
    baseUrl: url,
    token: credentials.auth,
    authType: credentials.type,
    server,
    timeoutMs: timeoutMs(flags),
    verbose: boolFlag(flags, 'verbose'),
    userAgent: `hostkind-cli/${packageVersion()}`,
  });
  return { flags, args, cfg, profileName, index, url, credentials, server, client };
}

function saveLogin(ctx, patch, { setDefault = true } = {}) {
  const cfg = ctx.cfg;
  config.setProfile(cfg, ctx.profileName, { url: ctx.url, ...patch });
  if (setDefault) cfg.defaultProfile = ctx.profileName;
  config.saveConfig(cfg);
}

async function login(ctx) {
  const { flags } = ctx;
  const publicClient = createClient({
    baseUrl: ctx.url,
    server: null,
    timeoutMs: timeoutMs(flags),
    userAgent: `hostkind-cli/${packageVersion()}`,
  });
  let apiKey = flags['api-key'] || process.env.HOSTKIND_API_KEY || null;
  if (apiKey) {
    const keyClient = createClient({
      baseUrl: ctx.url,
      token: apiKey,
      authType: 'api-key',
      timeoutMs: timeoutMs(flags),
      userAgent: `hostkind-cli/${packageVersion()}`,
    });
    const me = await keyClient.request('GET', '/api/me', { noServer: true });
    const keyUser = me && me.user ? me.user : null;
    saveLogin(ctx, { apiKey, token: undefined, username: keyUser ? keyUser.username : undefined });
    report(ctx,
      { ok: true, url: ctx.url, profile: ctx.profileName, auth: 'api-key', user: keyUser || me },
      `Signed in to ${ctx.url} with an API key${keyUser && keyUser.username ? ` as ${keyUser.username}` : ''}. Saved to profile "${ctx.profileName}".`);
    return output.EXIT.OK;
  }

  let mode = null;
  try { mode = await publicClient.request('GET', '/api/auth-mode', { noServer: true }); } catch (_) { /* older panel */ }
  if (mode && mode.authRequired === false) {
    saveLogin(ctx, { token: undefined, apiKey: undefined, username: undefined });
    report(ctx,
      { ok: true, url: ctx.url, profile: ctx.profileName, auth: 'guest', authRequired: false, message: 'Sign-in is disabled on this panel.' },
      `Sign-in is disabled on ${ctx.url}; no credentials needed. Saved to profile "${ctx.profileName}".`);
    return output.EXIT.OK;
  }

  let username = flags.username || flags.email || process.env.HOSTKIND_USERNAME || null;
  if (!username && process.stdin.isTTY && !flags.password && !flags['password-stdin']) {
    username = await promptVisible(`Username for ${ctx.url} (admin): `);
  }
  if (!username) username = 'admin';
  let password = flags.password || process.env.HOSTKIND_PASSWORD || null;
  if (!password && flags['password-stdin']) password = (await readStdin()).trim();
  const localAllowed = String(username).toLowerCase() === 'admin';
  if (!password && localAllowed) {
    const local = localPasswordForUrl(ctx.url);
    if (local) password = local;
  }
  if (!password) password = await promptHidden(`Password for ${username}: `);

  const result = await publicClient.request('POST', '/api/login', {
    json: { username, password, lang: flags.lang },
    noServer: true,
  });
  if (!result || !result.token) {
    throw Object.assign(new Error('The panel did not return a session token.'), { code: 'login_failed' });
  }
  const user = result.user || {};
  saveLogin(ctx, { token: result.token, apiKey: undefined, username: user.username || username });
  report(ctx, {
    ok: true,
    url: ctx.url,
    profile: ctx.profileName,
    auth: 'token',
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      language: user.language,
    },
  }, `Signed in to ${ctx.url} as ${user.username || username}${user.role ? ` (${user.role})` : ''}. Saved to profile "${ctx.profileName}".`);
  return output.EXIT.OK;
}

function localPasswordForUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return null;
    return config.localInitialPassword();
  } catch (_) {
    return null;
  }
}

function logout(ctx) {
  if (boolFlag(ctx.flags, 'all')) {
    for (const name of Object.keys(ctx.cfg.profiles)) {
      config.removeProfile(ctx.cfg, name);
    }
    config.saveConfig(ctx.cfg);
    report(ctx, { ok: true, removed: 'all profiles' }, 'Removed every saved profile.');
    return output.EXIT.OK;
  }
  if (!ctx.cfg.profiles[ctx.profileName]) {
    report(ctx, { ok: true, removed: null, profile: ctx.profileName }, `Profile "${ctx.profileName}" has no saved credentials.`);
    return output.EXIT.OK;
  }
  // Keep the URL and server default: logging out should not erase the profile
  // someone would immediately log back into.
  config.setProfile(ctx.cfg, ctx.profileName, { token: undefined, apiKey: undefined });
  config.saveConfig(ctx.cfg);
  report(ctx, { ok: true, removed: 'credentials', profile: ctx.profileName },
    `Signed out of profile "${ctx.profileName}". Its URL and default server are kept.`);
  return output.EXIT.OK;
}

async function doctor(ctx) {
  const checks = [];
  const add = (name, ok, detail, extra = {}) => checks.push({ name, ok, detail, ...extra });
  add('cli_config', true, config.configPath());
  add('panel_url', true, ctx.url);
  add('profile', true, ctx.profileName);
  add('credential', !!ctx.credentials.auth, ctx.credentials.type || 'none');

  let mode = null;
  try {
    mode = await ctx.client.request('GET', '/api/auth-mode', { noServer: true });
    add('reachable', true, `authRequired=${mode && mode.authRequired}`);
    add('auth_mode', true, mode && mode.authRequired === false ? 'sign-in disabled' : 'sign-in required');
  } catch (err) {
    add('reachable', false, err.message);
  }

  let me = null;
  try {
    me = await ctx.client.request('GET', '/api/me', { noServer: true });
    add('authenticated', true, me && me.user ? `${me.user.username} (${me.user.role})` : 'ok');
  } catch (err) {
    const expected = mode && mode.authRequired === false;
    add('authenticated', expected, err.status === 401 ? 'no valid credential' : err.message);
  }

  if (me) {
    try {
      const modules = await ctx.client.request('GET', '/api/modules', { noServer: true });
      add('modules', true, `${(modules && modules.modules ? modules.modules : []).length} modules`);
    } catch (err) {
      add('modules', false, err.message);
    }
    try {
      const servers = await ctx.client.request('GET', '/api/servers', { noServer: true });
      add('servers', true, `${(servers && servers.servers ? servers.servers : []).length} visible`);
    } catch (err) {
      add('servers', false, err.message);
    }
    if (me.user && me.user.role === 'admin') {
      try {
        const foundation = await ctx.client.request('GET', '/api/foundation/status', { noServer: true });
        add('foundation', true, foundation && foundation.foundation ? 'ok' : 'ok');
      } catch (err) {
        add('foundation', false, err.message);
      }
    }
  }

  const ok = checks.every((check) => check.ok || check.name === 'foundation');
  if (ctx.flags.json) {
    output.printResult({ ok, url: ctx.url, profile: ctx.profileName, checks }, ctx.flags);
  } else {
    for (const check of checks) {
      const mark = check.ok ? output.green(ctx.flags, 'ok  ') : output.red(ctx.flags, 'fail');
      process.stdout.write(`${mark} ${check.name.padEnd(15)} ${check.detail || ''}\n`);
    }
    process.stdout.write(`\n${ok ? output.green(ctx.flags, 'doctor: healthy') : output.red(ctx.flags, 'doctor: problems found')}\n`);
  }
  return ok ? output.EXIT.OK : output.EXIT.ERROR;
}

function listProfiles(ctx) {
  const profiles = Object.entries(ctx.cfg.profiles).map(([name, profile]) => ({
    name,
    default: name === ctx.cfg.defaultProfile,
    ...config.publicProfile(profile),
  }));
  if (!profiles.length) profiles.push({ name: null, default: true, url: ctx.url, message: 'no saved profiles; environment/default URL in use' });
  output.printResult({ profile: ctx.profileName, defaultProfile: ctx.cfg.defaultProfile, profiles }, ctx.flags);
  return output.EXIT.OK;
}

function useProfile(ctx) {
  const name = ctx.args[0];
  if (!name) throw Object.assign(new Error('Missing argument: <name>'), { code: 'missing_argument' });
  if (!ctx.cfg.profiles[name]) {
    throw Object.assign(new Error(`Profile "${name}" does not exist.`), {
      code: 'profile_not_found',
      hint: 'Run `hostkind profile list`, or create it with `hostkind login --profile <name>`.',
    });
  }
  ctx.cfg.defaultProfile = name;
  config.saveConfig(ctx.cfg);
  report(ctx, { ok: true, defaultProfile: name, profile: config.publicProfile(ctx.cfg.profiles[name]) },
    `Now using profile "${name}" (${ctx.cfg.profiles[name].url || 'default URL'}).`);
  return output.EXIT.OK;
}

function showProfile(ctx) {
  const name = ctx.args[0] || ctx.profileName;
  const profile = config.getProfile(ctx.cfg, name);
  output.printResult({
    name,
    default: name === ctx.cfg.defaultProfile,
    exists: !!ctx.cfg.profiles[name],
    ...config.publicProfile(profile),
  }, ctx.flags);
  return ctx.cfg.profiles[name] ? output.EXIT.OK : output.EXIT.ERROR;
}

function setProfile(ctx) {
  const name = ctx.args[0];
  if (!name) throw Object.assign(new Error('Missing argument: <name>'), { code: 'missing_argument' });
  const patch = {};
  if (ctx.flags.url) patch.url = ctx.flags.url;
  if (ctx.flags.token) patch.token = ctx.flags.token;
  if (ctx.flags['api-key']) patch.apiKey = ctx.flags['api-key'];
  if (ctx.flags.server) patch.server = ctx.flags.server;
  if (ctx.flags.username) patch.username = ctx.flags.username;
  config.setProfile(ctx.cfg, name, patch);
  config.saveConfig(ctx.cfg);
  output.printResult({ ok: true, name, ...config.publicProfile(ctx.cfg.profiles[name]) }, ctx.flags);
  return output.EXIT.OK;
}

function removeProfile(ctx) {
  const name = ctx.args[0];
  if (!name) throw Object.assign(new Error('Missing argument: <name>'), { code: 'missing_argument' });
  const existed = config.removeProfile(ctx.cfg, name);
  config.saveConfig(ctx.cfg);
  report(ctx, { ok: true, removed: existed ? name : null },
    existed ? `Removed profile "${name}".` : `No profile named "${name}".`);
  return existed ? output.EXIT.OK : output.EXIT.ERROR;
}

// Next words for every command prefix: '' -> top-level words, 'servers' ->
// its actions, and so on. Shells complete one word at a time, so candidates
// must be single words.
function completionTree(index) {
  const tree = new Map();
  for (const key of index.byKey.keys()) {
    const parts = key.split(' ');
    for (let i = 0; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join(' ');
      if (!tree.has(prefix)) tree.set(prefix, new Set());
      tree.get(prefix).add(parts[i]);
    }
  }
  return tree;
}

const COMPLETION_FLAGS = [
  '--help', '--json', '--table', '--quiet', '--yes', '--preview', '--wait', '--server',
  '--profile', '--url', '--data', '--query', '--file', '--output', '--timeout', '--verbose',
];

function completion(ctx) {
  const shell = String(ctx.args[0] || 'bash').toLowerCase();
  const tree = completionTree(ctx.index);
  const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
  const cases = [...tree.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, words]) => [prefix, [...words].sort().join(' ')]);
  if (shell === 'bash' || shell === 'zsh') {
    const lines = [];
    // zsh reuses the bash function through bashcompinit; load it with
    // `source <(hostkind completion zsh)` from ~/.zshrc.
    if (shell === 'zsh') lines.push('autoload -U +X compinit && compinit', 'autoload -U +X bashcompinit && bashcompinit');
    lines.push('_hostkind() {');
    lines.push('  local cur="${COMP_WORDS[COMP_CWORD]}" key="" words="" i');
    lines.push('  for ((i = 1; i < COMP_CWORD; i++)); do');
    lines.push('    [[ "${COMP_WORDS[i]}" == -* ]] && break');
    lines.push('    key+="${key:+ }${COMP_WORDS[i]}"');
    lines.push('  done');
    lines.push('  if [[ "$cur" == -* ]]; then');
    lines.push(`    words=${quote(COMPLETION_FLAGS.join(' '))}`);
    lines.push('  else');
    lines.push('    case "$key" in');
    for (const [prefix, words] of cases) lines.push(`      ${quote(prefix)}) words=${quote(words)} ;;`);
    lines.push('    esac');
    lines.push('  fi');
    lines.push('  COMPREPLY=($(compgen -W "$words" -- "$cur"))');
    lines.push('}');
    lines.push('complete -o default -F _hostkind hostkind');
    return `${lines.join('\n')}\n`;
  }
  if (shell === 'fish') {
    const lines = [];
    lines.push('function __hostkind_complete');
    lines.push('  set -l tokens (commandline -opc)[2..-1]');
    lines.push('  set -l key (string join " " -- (string match -v -- "-*" $tokens))');
    lines.push('  switch "$key"');
    for (const [prefix, words] of cases) {
      lines.push(`    case ${quote(prefix)}`);
      lines.push(`      string split " " -- ${quote(words)}`);
    }
    lines.push('  end');
    lines.push('end');
    lines.push("complete -c hostkind -f -a '(__hostkind_complete)'");
    for (const flag of COMPLETION_FLAGS) lines.push(`complete -c hostkind -l ${flag.slice(2)}`);
    return `${lines.join('\n')}\n`;
  }
  throw Object.assign(new Error(`Unsupported shell "${shell}". Use bash, zsh, or fish.`), { code: 'invalid_shell' });
}

async function waitForOperation(ctx, operationId, { timeoutSeconds = 0, intervalSeconds = 1, flags = ctx.flags, stderr = process.stderr } = {}) {
  const started = Date.now();
  const maxMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
  let lastState = '';
  let lastPhase = '';
  for (;;) {
    const payload = await ctx.client.request('GET', `/api/operations/${encodeURIComponent(operationId)}`, { noServer: true });
    const operation = payload && payload.operation ? payload.operation : payload;
    const state = operation && operation.state ? operation.state : 'unknown';
    const phase = operation && operation.phase ? operation.phase : '';
    const fraction = operation && Number(operation.progress);
    const progress = fraction > 0 && fraction < 1 ? ` ${Math.round(fraction * 100)}%` : '';
    if (!flags.quiet && !flags.json && (state !== lastState || phase !== lastPhase)) {
      stderr.write(`${output.dim(flags, `operation ${operationId}:`)} ${state}${phase && phase !== state ? ` (${phase}${progress})` : ''}\n`);
    }
    lastState = state;
    lastPhase = phase;
    if (TERMINAL_STATES.has(state)) return operation;
    if (maxMs && Date.now() - started >= maxMs) {
      throw Object.assign(new Error(`Operation ${operationId} did not finish within ${timeoutSeconds}s.`), {
        code: 'wait_timeout',
        details: { operationId, state },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(200, intervalSeconds * 1000)));
  }
}

async function waitCommand(ctx) {
  const id = ctx.args[0];
  if (!id) throw Object.assign(new Error('Missing argument: <operationId>'), { code: 'missing_argument' });
  const seconds = Number(ctx.flags['wait-timeout'] || 0);
  const interval = Number(ctx.flags.interval || 1);
  const operation = await waitForOperation(ctx, id, { timeoutSeconds: seconds, intervalSeconds: interval, flags: ctx.flags });
  output.printResult(operation, ctx.flags);
  return operation && FAILED_STATES.has(operation.state) ? output.EXIT.ERROR : output.EXIT.OK;
}

async function api(ctx) {
  const args = [...ctx.args];
  let method = 'GET';
  let target = null;
  const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  if (args.length && methods.has(String(args[0]).toUpperCase())) {
    method = String(args.shift()).toUpperCase();
    target = args.shift();
  } else {
    target = args.shift();
  }
  if (!target) throw Object.assign(new Error('Missing argument: <path>'), { code: 'missing_argument', hint: 'Example: hostkind api GET /api/servers' });
  if (args.length) throw Object.assign(new Error(`Unexpected arguments: ${args.join(' ')}`), { code: 'too_many_arguments' });
  if (target.startsWith('/api/') === false && target.startsWith('/') === false) target = `/${target}`;

  const flags = ctx.flags;
  let data;
  if (flags.data !== undefined) data = parser.parseData(flags.data);
  else if (flags['data-file']) data = parser.parseData(`@${flags['data-file']}`);
  const query = parser.parseQuery(flags.query);
  const headers = parser.parseHeaders(flags.header);
  const isWrite = !['GET', 'HEAD'].includes(method);
  if (isWrite && data !== undefined && !flags['idempotency-key']) {
    headers['Idempotency-Key'] = require('crypto').randomUUID();
  }
  if (flags['idempotency-key']) headers['Idempotency-Key'] = String(flags['idempotency-key']);

  const files = flags.file === undefined ? [] : (Array.isArray(flags.file) ? flags.file : [flags.file]).map((file) => ({ path: file, field: 'file' }));
  const fields = parser.parseFields(flags.field);
  const options = { query, headers, noServer: false };

  let result;
  if (flags.output || flags.stdout) {
    const downloaded = await ctx.client.download(method, target, {
      ...options,
      json: data,
      output: flags.output,
      timeout: flags.timeout ? timeoutMs(flags) : 0,
    });
    output.printResult({ ok: true, file: downloaded.filename, bytes: downloaded.bytes }, flags);
    return output.EXIT.OK;
  }
  if (flags.ndjson) {
    result = await ctx.client.requestNdjson(method, target, {
      ...options,
      json: data,
      onEvent: (event) => output.printNdjsonEvent(event, flags),
    });
    output.printResult(result.last, flags);
    return output.EXIT.OK;
  }
  if (files.length) {
    const form = await ctx.client.multipart(files, fields);
    result = await ctx.client.request(method, target, { ...options, form });
  } else if (data !== undefined && (method === 'GET' || method === 'HEAD')) {
    const queryFromData = { ...query };
    if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(queryFromData, data);
    result = await ctx.client.request(method, target, { ...options, query: queryFromData });
  } else {
    result = await ctx.client.request(method, target, { ...options, json: data });
  }
  if (flags.wait && result && result.operationId) {
    result = await waitForOperation(ctx, result.operationId, {
      timeoutSeconds: Number(flags['wait-timeout'] || 0),
      intervalSeconds: Number(flags.interval || 1),
      flags,
    });
  }
  output.printResult(result, flags);
  return result && FAILED_STATES.has(result.state) ? output.EXIT.ERROR : output.EXIT.OK;
}

function serve(ctx) {
  const root = path.resolve(__dirname, '..');
  const server = path.join(root, 'server.js');
  if (!fs.existsSync(server)) {
    throw Object.assign(new Error(`server.js was not found at ${server}`), { code: 'server_missing' });
  }
  const env = { ...process.env };
  if (ctx.flags.port) env.FLEETDECK_PORT = String(ctx.flags.port);
  if (ctx.flags.config) env.FLEETDECK_CONFIG = path.resolve(String(ctx.flags.config));
  const child = spawn(process.execPath, [server], { cwd: root, env, stdio: 'inherit' });
  const forward = (signal) => { try { child.kill(signal); } catch (_) { /* ignore */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) process.stderr.write(`hostkind serve: child exited on ${signal}\n`);
      resolve(code == null ? 1 : code);
    });
    child.on('error', (err) => {
      process.stderr.write(`hostkind serve: ${err.message}\n`);
      resolve(1);
    });
  });
}

async function runSpecial(spec, ctx) {
  switch (spec.special) {
    case 'login': return login(ctx);
    case 'logout': return logout(ctx);
    case 'doctor': return doctor(ctx);
    case 'commands': {
      const filter = ctx.args[0] || null;
      process.stdout.write(`${require('./help.cjs').renderCommands(ctx.index, filter, ctx.flags)}\n`);
      return output.EXIT.OK;
    }
    case 'completion': {
      process.stdout.write(completion(ctx));
      return output.EXIT.OK;
    }
    case 'version': {
      const info = {
        name: 'hostkind',
        version: packageVersion(),
        node: process.version,
        commands: ctx.index.commands.length,
        profiles: Object.keys(ctx.cfg.profiles),
        config: config.configPath(),
      };
      report(ctx, info, `hostkind ${info.version} (Node ${process.version.slice(1)}, ${info.commands} commands)\nConfig: ${info.config}`);
      return output.EXIT.OK;
    }
    case 'serve': return serve(ctx);
    case 'wait': return waitCommand(ctx);
    case 'api': return api(ctx);
    case 'profile-list': return listProfiles(ctx);
    case 'profile-use': return useProfile(ctx);
    case 'profile-show': return showProfile(ctx);
    case 'profile-set': return setProfile(ctx);
    case 'profile-remove': return removeProfile(ctx);
    case 'console-tail': {
      const serverId = ctx.server ? await ctx.client.resolveServerId() : null;
      return ws.tail({ client: ctx.client, serverId, flags: ctx.flags, stdout: process.stdout, stderr: process.stderr });
    }
    case 'console-history': {
      ctx.flags.follow = false;
      const serverId = ctx.server ? await ctx.client.resolveServerId() : null;
      return ws.tail({ client: ctx.client, serverId, flags: ctx.flags, stdout: process.stdout, stderr: process.stderr });
    }
    case 'console-watch': {
      const serverId = ctx.server ? await ctx.client.resolveServerId() : null;
      return ws.watch({ client: ctx.client, serverId, flags: ctx.flags, stdout: process.stdout, stderr: process.stderr });
    }
    default:
      throw Object.assign(new Error(`Unknown special command ${spec.special}`), { code: 'unknown_command' });
  }
}

module.exports = {
  SPECIAL_COMMANDS,
  runSpecial,
  waitForOperation,
  buildContext,
  timeoutMs,
  packageVersion,
  normalizeOutputFlags,
  readStdin,
  promptHidden,
  TERMINAL_STATES,
};
