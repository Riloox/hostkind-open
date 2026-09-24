'use strict';

/*
 * Hostkind desktop runtime helpers (Electron .exe release plan, Task 1).
 *
 * Everything in this module is plain CommonJS with no Electron dependency, so
 * the normal Node test runner can exercise the full desktop bootstrap
 * contract (paths, config materialisation, port allocation, readiness
 * polling, backend environment) without loading Electron.
 *
 * Disk writes that replace the user config are atomic: the next JSON is
 * written to an adjacent temp file and renamed over the target, so a crash or
 * injected failure mid-write never leaves a truncated config behind.
 */

const cryptoMod = require('crypto');
const fsMod = require('fs');
const netMod = require('net');
const pathMod = require('path');

const HOSTKIND_DIR = 'Hostkind';
const LOOPBACK_HOST = '127.0.0.1';
const AUTH_MODE_PATH = '/api/auth-mode';

/**
 * Resolve every mutable desktop path from the three Electron-owned roots.
 *
 *   userData  -> config.json, data/, running.json, logs/
 *   localData -> <localData>/Hostkind/{installer-cache,runtimes}
 *   documents -> <documents>/Hostkind/{servers,backups}
 *
 * All outputs are absolute and live outside any application/install
 * directory, so a reinstall never destroys user configuration, the SQLite
 * state, downloaded installers, runtimes, servers, or backups.
 */
function resolveDesktopPaths({ userData, localData, documents }) {
  const user = pathMod.resolve(String(userData));
  const local = pathMod.resolve(String(localData));
  const docs = pathMod.resolve(String(documents));
  return {
    // App state (Electron userData).
    configPath: pathMod.join(user, 'config.json'),
    dataDir: pathMod.join(user, 'data'),
    runningPath: pathMod.join(user, 'running.json'),
    logDir: pathMod.join(user, 'logs'),
    // Application updater state. The per-machine install directory is not
    // writable by the user, so it never holds updater state or downloads.
    updateStatePath: pathMod.join(user, 'application-update.json'),
    // Machine-local caches (%LOCALAPPDATA%\Hostkind).
    installerCache: pathMod.join(local, HOSTKIND_DIR, 'installer-cache'),
    runtimesDir: pathMod.join(local, HOSTKIND_DIR, 'runtimes'),
    updateStagingDir: pathMod.join(local, HOSTKIND_DIR, 'updates'),
    // User-managed data (Documents\Hostkind).
    serverDir: pathMod.join(docs, HOSTKIND_DIR, 'servers'),
    backupsDir: pathMod.join(docs, HOSTKIND_DIR, 'backups'),
  };
}

/**
 * Materialise or repair the desktop config without ever touching the shipped
 * template.
 *
 * A missing config is cloned from `templatePath` and opened authless on the
 * loopback interface with the selected numeric port and the Documents-tree
 * defaults for the server parent and backups. An existing config is
 * preserved in full (servers, users, branding, arbitrary keys, and an
 * explicit requireAuth true/false decision) but the
 * host is still forced back to 127.0.0.1, the selected port still wins, and
 * an empty backups.dir receives the desktop default.
 *
 * Writes go through an adjacent temp file plus rename so a failed write or
 * rename leaves the previous JSON intact. Returns the config object itself;
 * non-enumerable `created`/`changed` markers distinguish a fresh profile.
 */
async function ensureDesktopConfig({ configPath, templatePath, port, paths, fsImpl }) {
  const fsx = fsImpl || fsMod;
  const target = pathMod.resolve(String(configPath));
  const existed = fsx.existsSync(target);

  const next = existed
    ? JSON.parse(fsx.readFileSync(target, 'utf8'))
    : JSON.parse(fsx.readFileSync(String(templatePath), 'utf8'));

  const nextPort = Number(port);
  if (!Number.isInteger(nextPort) || nextPort < 0 || nextPort > 65535) {
    throw new Error(`ensureDesktopConfig: invalid panel port ${JSON.stringify(port)}`);
  }

  let changed = !existed;

  // Desktop rules that always apply: loopback only, chosen free port.
  if (next.panelHost !== LOOPBACK_HOST) { next.panelHost = LOOPBACK_HOST; changed = true; }
  if (next.panelPort !== nextPort) { next.panelPort = nextPort; changed = true; }

  // Rule for a brand-new desktop profile only: authless local mode. An
  // explicit requireAuth true/false in an existing config is the user's
  // decision and is never overwritten.
  if (!existed) { next.requireAuth = false; changed = true; }

  // Backup defaults point at the Documents tree, never the install dir.
  if (!next.backups || typeof next.backups !== 'object') { next.backups = {}; changed = true; }
  if (!next.backups.dir || !String(next.backups.dir).trim()) { next.backups.dir = paths.backupsDir; changed = true; }

  // A fresh desktop profile anchors the server parent at the Documents tree
  // the same way backups are (the backend only migrates serverDir into
  // config.servers[] when servers is missing entirely, and the shipped
  // template's servers:[] never triggers that). An existing config's
  // serverDir is the user's decision and is preserved exactly - including an
  // empty one - so legacy upgrade behaviour is unchanged.
  if (!existed) { next.serverDir = paths.serverDir; changed = true; }

  // Never write config.json directly: temp file + rename keeps the previous
  // JSON intact if anything goes wrong between the two steps.
  fsx.mkdirSync(pathMod.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  try {
    fsx.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    try { fsx.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
  try {
    fsx.renameSync(tmp, target);
  } catch (err) {
    try { fsx.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }

  // Return the config object itself (the contract tests consume it directly).
  // `created`/`changed` ride along as non-enumerable markers so the Electron
  // main can distinguish a fresh profile without polluting JSON serialization
  // or deep-equality comparisons.
  Object.defineProperty(next, 'created', { value: !existed, enumerable: false, configurable: true });
  Object.defineProperty(next, 'changed', { value: changed, enumerable: false, configurable: true });
  return next;
}

/**
 * Reserve a free TCP port on 127.0.0.1 by binding port 0, reading the OS
 * assignment, closing, and returning the number. Rather than assuming the
 * panel's default port is free, every desktop launch picks a fresh one.
 * Accepts an injected { net } implementation for tests.
 */
function findFreeLoopbackPort({ net } = {}) {
  const n = net || netMod;
  return new Promise((resolve, reject) => {
    let srv;
    try {
      srv = n.createServer();
    } catch (err) {
      reject(err);
      return;
    }
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    srv.once('error', (err) => finish(reject, err));
    const onListening = () => {
      let port = 0;
      try {
        const addr = srv.address();
        port = addr && typeof addr === 'object' ? addr.port : 0;
      } catch { port = 0; }
      if (!port) {
        try { srv.close(() => finish(reject, new Error('findFreeLoopbackPort: OS assigned no port'))); } catch (err) { finish(reject, err); }
        return;
      }
      try { srv.close(() => finish(resolve, port)); } catch (err) { finish(reject, err); }
    };
    srv.once('listening', onListening);
    srv.listen(0, LOOPBACK_HOST, onListening);
  });
}

/**
 * Poll exactly `${origin}/api/auth-mode` until an HTTP success yields JSON.
 * Bounded by timeoutMs; immediately rejects if the backend child exits first.
 * On settle, the poll timer and exit listener are removed so nothing leaks.
 *
 * Returns the parsed auth-mode body, e.g. { ok: true, authRequired: false }.
 */
async function waitForPanel({ origin, child, timeoutMs = 30000, fetchImpl }) {
  const fetchFn = fetchImpl || ((url) => fetch(url));
  const url = `${origin}${AUTH_MODE_PATH}`;
  let lastStatus = null;
  let lastError = null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(
        `Hostkind panel did not become ready: timed out after ${timeoutMs}ms waiting for ${url}` +
        (lastStatus !== null ? ` (last status: ${lastStatus})` : '') +
        (lastError ? ` (last error: ${lastError.message})` : '')
      ));
    }, timeoutMs);

    const onExit = (code, signal) => {
      finish(new Error(
        `Hostkind panel backend exited before becoming ready (exit code: ${code}, signal: ${signal}) while waiting for ${url}`
      ));
    };
    if (child && typeof child.on === 'function') child.on('exit', onExit);

    function cleanup() {
      clearTimeout(timer);
      if (child && typeof child.removeListener === 'function') child.removeListener('exit', onExit);
    }
    function finish(errOrValue, isError) {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError || errOrValue instanceof Error) reject(errOrValue);
      else resolve(errOrValue);
    }

    (async () => {
      while (!settled) {
        if (settled) return;
        try {
          const res = await fetchFn(url);
          if (res) lastStatus = res.status;
          if (res && res.ok) {
            let body = null;
            try { body = await res.json(); } catch (err) { lastError = err; }
            if (body !== null && body !== undefined) { finish(body); return; }
          }
        } catch (err) {
          lastError = err;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
  });
}

/**
 * The environment contract for the desktop backend child. These variables
 * are the existing backend contracts (server.js reads FLEETDECK_CONFIG,
 * FLEETDECK_DATA_DIR, FLEETDECK_INSTALLER_CACHE, FLEETDECK_RUNTIMES_DIR), so
 * the desktop launcher reuses them instead of adding a second config path.
 * FLEETDECK_DESKTOP=1 is a diagnostic marker for the desktop boot path.
 *
 * The updater variables keep its state and downloads in user-writable
 * locations. HOSTKIND_DESKTOP_UPDATE=1 (packaged builds only) switches the
 * backend to the desktop installer, which hands Setup.exe back to the main
 * process instead of rewriting the install directory itself.
 */
function desktopEnvironment({ paths, configPath, packaged = false }) {
  const env = {
    FLEETDECK_CONFIG: configPath,
    FLEETDECK_DATA_DIR: paths.dataDir,
    FLEETDECK_INSTALLER_CACHE: paths.installerCache,
    FLEETDECK_RUNTIMES_DIR: paths.runtimesDir,
    FLEETDECK_DESKTOP: '1',
    HOSTKIND_UPDATE_STATE_PATH: paths.updateStatePath,
    HOSTKIND_UPDATE_STAGING_DIR: paths.updateStagingDir,
  };
  if (packaged) env.HOSTKIND_DESKTOP_UPDATE = '1';
  return env;
}

const INSTALLER_NAME_RE = /^Hostkind-(0|[1-9]\d*)(\.(0|[1-9]\d*)){2,3}-Setup\.exe$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Validate a backend request to launch an update installer. The backend is
 * trusted code, but the main process still only ever runs a Hostkind
 * Setup.exe directly inside the update staging folder whose bytes match the
 * SHA-256 from the signed manifest. Returns the resolved installer path;
 * throws with a readable reason otherwise.
 */
async function validateInstallerRequest({ message, stagingDir, platform = process.platform, fsImpl = fsMod }) {
  if (platform !== 'win32') throw new Error('in-app installation is only supported on Windows');
  if (!message || typeof message.installerPath !== 'string' || typeof message.sha256 !== 'string') {
    throw new Error('malformed installer request');
  }
  const installerPath = pathMod.resolve(message.installerPath);
  const root = pathMod.resolve(String(stagingDir));
  if (pathMod.dirname(installerPath).toLowerCase() !== root.toLowerCase()) {
    throw new Error('installer is outside the update folder');
  }
  if (!INSTALLER_NAME_RE.test(pathMod.basename(installerPath))) {
    throw new Error('installer file name is not a Hostkind setup');
  }
  const expected = message.sha256.toLowerCase();
  if (!SHA256_RE.test(expected)) throw new Error('installer SHA-256 is malformed');
  const actual = await new Promise((resolve, reject) => {
    const hash = cryptoMod.createHash('sha256');
    const stream = fsImpl.createReadStream(installerPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  if (actual !== expected) throw new Error('installer failed its SHA-256 check');
  return installerPath;
}

module.exports = {
  resolveDesktopPaths,
  ensureDesktopConfig,
  findFreeLoopbackPort,
  waitForPanel,
  desktopEnvironment,
  validateInstallerRequest,
  LOOPBACK_HOST,
  AUTH_MODE_PATH,
};