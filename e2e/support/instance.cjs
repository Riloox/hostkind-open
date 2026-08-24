'use strict';

/*
 * Boots a throwaway Hostkind panel for the browser tests.
 *
 * Each instance gets its own temp directory holding the config file and the
 * SQLite data dir, and listens on its own port, so nothing it does can reach
 * the real install. server.js finds them through two env vars:
 *
 *   FLEETDECK_CONFIG   - the config.json to read and write (and where
 *                        running.json is kept)
 *   FLEETDECK_DATA_DIR - the foundation database and its snapshots
 *
 * Booting costs ~2s (node startup plus the SQLite migrations), which is why
 * the default instance is shared per worker; see support/fixtures.cjs.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server.js');

/*
 * Every instance directory carries the id of the run that made it, so global
 * teardown can sweep this run's leftovers without touching another run's.
 * A worker that is killed outright - an out-of-memory browser, Ctrl-C - never
 * runs its fixture teardown, and that is exactly when a directory survives.
 */
const RUN_ID = process.env.E2E_RUN_ID || 'adhoc';
const DIR_PREFIX = `fleetdeck-e2e-${RUN_ID}-`;

// How long to wait for /api/auth-mode to answer before calling the boot failed.
// A lone panel is up in ~2s; this has room for a machine that is booting
// several at once, each with its own SQLite migration pass.
const BOOT_TIMEOUT_MS = 60_000;

/*
 * Windows refuses to remove a directory that a process is using as its cwd,
 * and the panel's game-server children are spawned detached, so they outlive
 * the panel and hold the instance's server folders open (EBUSY on teardown).
 * Take the whole tree down before removing the instance, and retry the
 * removal: a just-exited process can keep a handle for a moment, and the
 * runner's real-time AV scan adds latency.
 */
function removeInstanceTree(pid, target) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch { /* the tree may already be gone */ }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const BOOT_POLL_MS = 100;

// The seeded accounts. Passwords are hashed here rather than set through the
// API so a test never depends on the panel's password policy or on the
// first-run default admin.
const ADMIN = Object.freeze({
  username: 'e2e-admin',
  email: 'e2e-admin@fleetdeck.test',
  name: 'Ada Rooke',
  password: 'E2Epassw0rd!',
  role: 'admin',
});

const OPERATOR = Object.freeze({
  username: 'e2e-operator',
  email: 'e2e-operator@fleetdeck.test',
  name: 'Bo Reyes',
  password: 'E2Eoperat0r!',
  role: 'operator',
});

// Same scheme as server.js: scrypt over a random salt, stored "salt:hash".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

function seedUser(account) {
  return {
    id: crypto.randomUUID(),
    username: account.username,
    email: account.email,
    name: account.name,
    role: account.role,
    passwordHash: hashPassword(account.password),
  };
}

// Ask the OS for a free port. There is a gap between closing this probe and
// the panel binding, so startInstance() retries on EADDRINUSE.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function baseConfig({ port, requireAuth, users, servers, backupsDir }) {
  return {
    appName: 'Hostkind',
    serverDir: '',
    jar: '',
    javaArgs: ['-Xmx1G', '-Xms1G'],
    mcVersion: '',
    stopTimeoutSeconds: 30,
    panelPort: port,
    panelHost: '127.0.0.1',
    jwtSecret: crypto.randomBytes(32).toString('hex'),
    sessionHours: 168,
    requireAuth,
    consoleHistoryLines: 500,
    playerListIntervalSeconds: 30,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    scheduledRestart: { enabled: false, cron: '0 4 * * *', warnMinutes: [5, 1] },
    backups: { dir: backupsDir, maxCount: 10, maxSizeMB: 0, scheduledEnabled: false, scheduledCron: '0 3 * * *', worlds: [] },
    servers,
    activeServerId: servers.length ? servers[0].id : null,
    users,
  };
}

async function waitForBoot(url, child, log) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`panel exited with code ${child.exitCode} during boot:\n${log()}`);
    }
    try {
      const response = await fetch(`${url}/api/auth-mode`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS));
  }
  throw new Error(`panel did not answer within ${BOOT_TIMEOUT_MS}ms:\n${log()}`);
}

/**
 * Start an isolated panel.
 *
 * @param {object}  [options]
 * @param {boolean} [options.requireAuth=true] false boots the panel in guest mode.
 * @param {Array}   [options.users]            Accounts to seed; defaults to ADMIN.
 * @param {Array|Function} [options.servers=[]] Registered servers. A function is
 *   called with { root, servers, backups } - temp directories that live and die
 *   with the instance - and returns the entries; see support/seed.cjs.
 * @param {object|Function} [options.env]      Extra env vars, e.g. DEFAULT_LANGUAGE.
 *   A function is called with the same `dirs` as `servers`, for vars that need
 *   a path inside the instance (the installer cache, the runtimes folder).
 * @param {Function} [options.config]          Last-chance mutation of the config object.
 */
async function startInstance(options = {}) {
  const {
    requireAuth = true,
    // Both roles by default, so a spec can check what an operator is denied
    // without having to arrange a second account first.
    users = [ADMIN, OPERATOR],
    servers: serverSpec = [],
    env: envSpec = {},
    config: patch,
  } = options;

  // Canonicalize through realpath (see test/_setup.cjs): os.tmpdir() can carry
  // an 8.3 short name on Windows runners, while the panel resolves paths to
  // their long form. A canonical root keeps spec-vs-panel path comparisons
  // consistent on every platform.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX)));
  const dataDir = path.join(root, 'data');
  const configPath = path.join(root, 'config.json');
  const dirs = {
    root,
    servers: path.join(root, 'servers'),
    backups: path.join(root, 'backups'),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(dirs.servers, { recursive: true });
  fs.mkdirSync(dirs.backups, { recursive: true });

  // Built once, not per attempt: the builders write to disk, and a retry only
  // needs a different port.
  const servers = typeof serverSpec === 'function' ? serverSpec(dirs) : serverSpec;
  const env = typeof envSpec === 'function' ? envSpec(dirs) : envSpec;

  let lastError = null;
  let lastChildPid = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const config = baseConfig({ port, requireAuth, users: users.map(seedUser), servers, backupsDir: dirs.backups });
    if (typeof patch === 'function') patch(config);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const output = [];
    const record = (chunk) => { output.push(String(chunk)); };
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...env,
        FLEETDECK_CONFIG: configPath,
        FLEETDECK_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    lastChildPid = child.pid;

    const log = () => output.join('').trim();
    const url = `http://127.0.0.1:${port}`;

    try {
      await waitForBoot(url, child, log);
    } catch (error) {
      child.kill();
      // A port that was free a moment ago can be taken by the time the panel
      // binds it; that one is worth another go, anything else is a real fault.
      if (/EADDRINUSE/.test(log())) { lastError = error; continue; }
      removeInstanceTree(child.pid, root);
      throw error;
    }

    return {
      url,
      port,
      root,
      dirs,
      configPath,
      dataDir,
      admin: ADMIN,
      operator: OPERATOR,
      /** The seeded server entries, in the order they were built. */
      servers,
      /** Look one up by the name it was seeded with. */
      server: (name) => servers.find((entry) => entry.name === name) || null,
      /** The config as it stands on disk right now (the panel rewrites it). */
      readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
      /** Everything the panel has printed so far - handy in failure messages. */
      log,
      async stop() {
        if (child.exitCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill();
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        }
        removeInstanceTree(child.pid, root);
      },
    };
  }

  removeInstanceTree(lastChildPid, root);
  throw lastError || new Error('could not start an isolated panel');
}

/**
 * Remove instance directories left in the OS temp folder.
 *
 * With no argument it sweeps this run's; `{ olderThanMs }` sweeps any run's
 * that has not been touched for that long, which is how a crashed earlier run
 * gets cleaned up at the start of the next one without disturbing a run
 * happening right now.
 */
function sweepInstanceDirs({ olderThanMs = null } = {}) {
  const tmp = os.tmpdir();
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch { return removed; }

  for (const name of entries) {
    const matchesThisRun = name.startsWith(DIR_PREFIX);
    const matchesAnyRun = name.startsWith('fleetdeck-e2e-');
    if (olderThanMs == null ? !matchesThisRun : !matchesAnyRun) continue;

    const target = path.join(tmp, name);
    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) continue;
      if (olderThanMs != null && Date.now() - stat.mtimeMs < olderThanMs) continue;
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(target)) removed.push(target);
    } catch { /* someone else's, or in use - leave it */ }
  }
  return removed;
}

module.exports = { startInstance, sweepInstanceDirs, hashPassword, ADMIN, OPERATOR, REPO_ROOT, RUN_ID };
