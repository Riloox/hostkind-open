'use strict';

/*
 * Hostkind - lightweight web panel to manage Minecraft servers on Windows,
 * Linux, and macOS.
 *
 * A single Node process:
 *   - Express serves the REST API and the static files in public/
 *   - ws exposes a WebSocket for the console stream, status, players and resources
 *   - Each registered server is launched with child_process.spawn (no shell) so paths
 *     with "N" and spaces are handled correctly.
 *
 * Multi-server model:
 *   - config.servers[] holds the registered servers (id, name, dir, jar, javaArgs, ...).
 *   - One ServerManager instance per registered server (managers Map), so several can run.
 *   - config.activeServerId is the server the console/players/plugins/configs/backups
 *     views target by default. Endpoints also accept ?serverId= to override.
 *
 * Global settings (panel port, password, backups dir, ...) live in config.json.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const zlib = require('zlib');

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const pidusage = require('pidusage');
const archiver = require('archiver');
const {
  findForgeLaunchTarget,
  installerFailureMessage,
  runForgeInstaller: runForgeInstallerProcess,
} = require('./lib/serverInstaller.cjs');
const { appendConsoleLine } = require('./lib/consoleHistory.cjs');

// Minecraft servers and plugins sometimes emit ANSI colour escapes even when
// their stdout/stderr is captured by a web panel (player "left/joined the game"
// lines, coloured command output, etc.). Strip them at the source so the live
// WebSocket frame, the join/leave parser (_inspectLine), and the level
// classifier all see plain text — and the broadcast we send to clients matches
// the normalized text we already persist in the console history.
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~])/g;
const { extractRuntimeArchive } = require('./lib/runtimeArchive.cjs');
const {
  readMrpackIndex,
  manifestToSpec,
  serverSideFiles,
  fileCountByEnv,
  extractOverrides,
  downloadAndVerify,
  safeResolve: mrpackSafeResolve,
} = require('./lib/mrpack.cjs');
const { bootFoundation, foundationStatus } = require('./lib/foundation.cjs');
const { router: operationsRouter } = require('./lib/routes/operations.cjs');
const foundationAudit = require('./lib/audit.cjs');
const auditRouter = require('./lib/routes/audit.cjs');
const foundationCapabilities = require('./lib/capabilities.cjs');
const branding = require('./lib/branding.cjs');
const apiKeys = require('./lib/apiKeys.cjs');
const crashIntelligence = require('./lib/crashes.cjs');
const updateCenter = require('./lib/updates.cjs');
const modpackLifecycle = require('./lib/modpacks.cjs');
const foundationSnapshots = require('./lib/snapshots.cjs');
const foundationOperations = require('./lib/operations.cjs');
const recovery = require('./lib/recovery.cjs');
const health = require('./lib/health.cjs');
const healthRouter = require('./lib/routes/health.cjs');
const worlds = require('./lib/worlds.cjs');
const worldsRouter = require('./lib/routes/worlds.cjs');
const templatesRouter = require('./lib/routes/templates.cjs');
const { createRegistry } = require('./lib/modules/registry.cjs');
const { createModuleGate } = require('./lib/modules/gating.cjs');
const { validateManualRegistration } = require('./lib/modules/registration.cjs');
const valheimLaunch = require('./lib/modules/valheim/launch.cjs');
const { valheimRouteCapability } = require('./lib/modules/valheim/routes.cjs');
const valheimWorlds = require('./lib/valheim-worlds.cjs');
const valheimWorldsRouter = require('./lib/routes/valheim.cjs');
const { terrariaRouteCapability } = require('./lib/modules/terraria/routes.cjs');
const terrariaVariants = require('./lib/modules/terraria/variants.cjs');
const terrariaInstall = require('./lib/terraria-install.cjs');
const terrariaConfig = require('./lib/terraria-config.cjs');
const terrariaWorlds = require('./lib/terraria-worlds.cjs');
const terrariaWorldsRouter = require('./lib/routes/terraria.cjs');
const terrariaImport = require('./lib/terraria-import.cjs');
const terrariaModsRouter = require('./lib/routes/terraria-mods.cjs');
const terrariaTshockRouter = require('./lib/routes/terraria-tshock.cjs');
const { installDedicatedServer } = require('./lib/dedicatedServerInstaller.cjs');
const { CAPABILITIES, requireCap } = foundationCapabilities;
const palworldOperations = require('./lib/palworld-operations.cjs');
const palworldSettings = require('./lib/palworld-settings.cjs');
const palworldMap = require('./lib/palworld-map.cjs');
const palworldUpdates = require('./lib/palworld-updates.cjs');
const valheimInstall = require('./lib/valheim-install.cjs');
const palworldMods = require('./lib/palworld-mods.cjs');
const palworldWorkshop = require('./lib/palworld-workshop.cjs');
const palworldPlatform = require('./lib/palworld-platform.cjs');
const palworldPortability = require('./lib/palworld-portability.cjs');
const palworldConnectivity = require('./lib/palworld-connectivity.cjs');
const minecraftPortabilityRouter = require('./lib/routes/minecraft-portability.cjs');
const serverPresentation = require('./lib/serverPresentation.cjs');
const trash = require('./lib/trash.cjs');
const pathSafety = require('./lib/pathSafety.cjs');
const automation = require('./lib/palworld-automation.cjs');
const { pickFolder, PICKER_BUSY, PICKER_UNAVAILABLE, PICKER_TIMEOUT } = require('./lib/folderPicker.cjs');
const palworldReplays = palworldOperations.createReplayStore({});
const limitPalworldAnnouncements = palworldOperations.createRateLimiter({ limit: 5, windowMs: 60_000 });
const limitPalworldPlayers = palworldOperations.createRateLimiter({ limit: 10, windowMs: 60_000 });


// pidusage on Windows shells out to wmic.exe, which Microsoft removed from
// Windows 11, so every pidusage() call throws `spawn wmic ENOENT` and process
// CPU/memory silently degrade to 0. procUsage() replaces it on win32 with a
// Get-CimInstance probe (KernelModeTime / UserModeTime / WorkingSetSize) and
// falls back to pidusage on other platforms. Results are cached ~1s so the 2s
// live stats stream and the 60s metrics sampler don't spawn PowerShell each
// overlap.
const procUsageHistory = {}; // { [pid]: { ctime, uptime } }
const procUsageCache = {};    // { [pid]: { ts, val } }
function procUsage(pid) {
  return new Promise((resolve) => {
    if (pid == null || pid < 0) return resolve(null);
    const now = Date.now();
    const cached = procUsageCache[pid];
    if (cached && (now - cached.ts) < 900) return resolve(cached.val);

    const finish = (val) => {
      if (val) procUsageCache[pid] = { ts: now, val };
      resolve(val);
    };

    if (process.platform !== 'win32') {
      return pidusage(pid).then(finish, () => resolve(null));
    }

    const psCmd =
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
      `Select-Object -Property KernelModeTime,UserModeTime,WorkingSetSize | ` +
      `ConvertTo-Json -Compress`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) { delete procUsageCache[pid]; return resolve(null); }
        let data;
        try { data = JSON.parse((stdout || '').trim()); } catch (_) { return resolve(null); }
        if (!data || data.KernelModeTime == null) return resolve(null);
        const kernel = Number(data.KernelModeTime);
        const user = Number(data.UserModeTime);
        const memory = Number(data.WorkingSetSize);
        // Kernel/User time are in 100-ns ticks; convert to ms.
        const totalMs = (kernel + user) / 10000;
        const uptime = Math.floor(os.uptime() || (Date.now() / 1000));
        const hst = procUsageHistory[pid];
        let cpu = 0;
        if (hst) {
          const dCpu = totalMs - hst.ctime;
          const dSec = uptime - hst.uptime;
          if (dSec > 0) cpu = (dCpu / 1000 / dSec) * 100;
        }
        procUsageHistory[pid] = { ctime: totalMs, uptime };
        finish({
          cpu,
          memory,
          pid,
          ctime: totalMs,
          timestamp: now,
        });
      }
    );
  });
}
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const i18n = require('./i18n.cjs');
// Panel version, stamped on every bug report so support can map an issue to a
// release without asking the reporter.
const PANEL_VERSION = require('./package.json').version;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Normally the config lives beside the panel. FLEETDECK_CONFIG points it
// somewhere else so a throwaway instance (the browser tests boot one per
// worker) can run against its own users, port, and servers without touching
// the real install.
const CONFIG_PATH = process.env.FLEETDECK_CONFIG
  ? path.resolve(process.env.FLEETDECK_CONFIG)
  : path.join(__dirname, 'config.json');

// A fresh checkout has no config.json: the private edition commits one, but
// the open edition git-ignores it (secrets, machine paths) and the packaged
// release ships none. The example doubles as a bootstrap template, so a
// missing config is materialised instead of crashing the boot - the same
// thing a first-time operator would do by hand. ensureSafeJwtSecret() below
// then rotates the placeholder secret before the panel signs anything.
const CONFIG_TEMPLATE_PATH = path.join(__dirname, 'config.example.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Plain console.log, not log(): config is not assigned yet and log()
    // reads config.appName. Likewise, write the file directly instead of
    // via saveConfig(): the `config` binding is still in its temporal dead
    // zone while this initializer runs.
    console.log(`[Hostkind] no config at ${CONFIG_PATH}; creating one from the shipped template. Nothing is configured yet - use the setup wizard or edit the file.`);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(JSON.parse(fs.readFileSync(CONFIG_TEMPLATE_PATH, 'utf8')), null, 2), 'utf8');
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

let config = loadConfig();

function saveConfig(next) {
  config = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// The shipped template carries a fixed placeholder so the panel boots with no
// config edits, but a published secret is forgeable: anyone who reads the repo
// can mint admin tokens. The first boot after an upgrade must replace it (or a
// missing/too-short value) with an unguessable one before it signs a session.
const DEFAULT_JWT_SECRET = 'CHANGE-THIS-SECRET-TO-SOMETHING-LONG-AND-RANDOM';
const MIN_JWT_SECRET_LENGTH = 32;

function ensureSafeJwtSecret() {
  const current = config.jwtSecret;
  const needsReplacement = typeof current !== 'string' || !current ||
    current === DEFAULT_JWT_SECRET || current.length < MIN_JWT_SECRET_LENGTH;
  if (!needsReplacement) return;
  log('config.json is missing a safe jwtSecret; generating a fresh one. This invalidates all existing sessions.');
  saveConfig({ ...config, jwtSecret: crypto.randomBytes(48).toString('hex') });
  // The generation path cannot produce an unsafe value, but refuse to boot
  // rather than keep running on one if it somehow does.
  if (typeof config.jwtSecret !== 'string' || config.jwtSecret === DEFAULT_JWT_SECRET || config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    console.error(`[${config.appName || 'Hostkind'}] REFUSING TO START: could not establish a safe jwtSecret. Set a strong random jwtSecret in config.json and restart.`);
    throw new Error('refusing to start without a safe jwtSecret');
  }
}
ensureSafeJwtSecret();

// --- running-server state (git-ignored) ------------------------------------
// We persist each spawned server's { pid, startedAt } so that after a panel
// restart we can re-attach to children we intentionally left alive (see
// shutdown()). This turns "panel restart orphans your servers" into "panel
// restart re-adopts them".
// Kept beside the config it describes, so an instance pointed at a throwaway
// config also tracks its children there instead of in the real install.
const RUNSTATE_PATH = path.join(path.dirname(CONFIG_PATH), 'running.json');

// Downloaded installers (SteamCMD, dedicated-server archives) and managed Java
// runtimes are caches, not user data. They live beside the panel by default;
// pointing them elsewhere lets a throwaway instance install a real server
// without writing anything into the real one - which is what the browser
// tests do, so an interrupted install leaves nothing behind to clean up.
const INSTALLER_CACHE_DIR = process.env.FLEETDECK_INSTALLER_CACHE
  ? path.resolve(process.env.FLEETDECK_INSTALLER_CACHE)
  : path.join(__dirname, 'resources', 'installers');
const RUNTIMES_DIR = process.env.FLEETDECK_RUNTIMES_DIR
  ? path.resolve(process.env.FLEETDECK_RUNTIMES_DIR)
  : path.join(__dirname, 'runtimes');
function loadRunState() {
  try { return JSON.parse(fs.readFileSync(RUNSTATE_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function setRunRecord(id, rec) {
  const s = loadRunState();
  if (rec) s[id] = rec; else delete s[id];
  try { fs.writeFileSync(RUNSTATE_PATH, JSON.stringify(s, null, 2), 'utf8'); }
  catch (e) { log('run-state save failed:', e.message); }
}

function genId() {
  return crypto.randomUUID();
}

const SERVER_NAME_MAX_LENGTH = 30;

function slugify(s) {
  const source = String(s || 'server');
  let value = '';
  let unsafeRun = false;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    const allowed = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 95 || code === 45;
    if (allowed) {
      value += source[i];
      unsafeRun = false;
    } else if (!unsafeRun) {
      value += '-';
      unsafeRun = true;
    }
  }
  let start = 0;
  while (start < value.length && value[start] === '-') start += 1;
  let end = value.length;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end).slice(0, 40) || 'server';
}

// --- user passwords (scrypt, salted; stored as "salt:hash") ---
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  let test;
  try {
    test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  } catch (_) {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function findUser(id) {
  return (config.users || []).find((u) => u.id === id) || null;
}
function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return (config.users || []).find((u) => (u.email || '').toLowerCase() === e) || null;
}
function findUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return (config.users || []).find((x) => (x.username || '').toLowerCase() === u) || null;
}
// Find a user by the login field, which can be either an email or a username.
function findUserByLogin(identifier) {
  const v = String(identifier || '').trim().toLowerCase();
  if (!v) return null;
  if (v.includes('@')) return findUserByEmail(v);
  return findUserByUsername(v) || findUserByEmail(v);
}
function publicUser(u) {
  return {
    id: u.id,
    email: u.email || '',
    username: u.username || '',
    name: u.name || '',
    role: u.role === 'operator' ? 'operator' : 'admin',
    language: i18n.normalizeLang(u.language),
  };
}

function publicPermissions(u) {
  if (!u || u.role === 'admin') return { admin: !!u, grants: [] };
  return {
    admin: false,
    grants: foundationCapabilities.listForUser(u.id).map((grant) => ({
      serverId: grant.server_id,
      capability: grant.capability,
    })),
  };
}

// Same shape as publicPermissions, for a principal that is a key rather than an
// account. Kept separate because a key is not in config.users and never has a
// profile - sharing publicPermissions would mean pretending it does.
function publicKeyPermissions(key) {
  if (!key) return { admin: false, grants: [] };
  if (key.role === 'admin') return { admin: true, grants: [] };
  return {
    admin: false,
    grants: foundationCapabilities.listForUser(key.id).map((grant) => ({
      serverId: grant.server_id,
      capability: grant.capability,
    })),
  };
}

function isAdmin(u) {
  return !!u && u.role === 'admin';
}
function adminCount() {
  return (config.users || []).filter((u) => u.role === 'admin').length;
}

// --- guest access (config.requireAuth === false) ---
// An admin can turn sign-in off (Users > Sign-in). While off, every request
// runs as this synthetic admin so the panel stays fully usable and the
// setting can be turned back on at any time. The guest is never stored in
// config.users, cannot sign in, and is blocked from profile/password edits.
const GUEST_USER = Object.freeze({
  id: 'guest',
  username: 'guest',
  name: 'Guest',
  role: 'admin',
});
function isGuestUser(u) {
  return !!u && u.id === GUEST_USER.id;
}
// The guest identity is only a fallback: a valid token still resolves to the
// real user first, so audit trails keep real names for signed-in sessions.
function guestUser() {
  return config.requireAuth === false ? GUEST_USER : null;
}

// --- password policy ---
// A short blocklist of the most common weak passwords. The point isn't to be
// exhaustive (that's what length + character variety enforce) but to reject the
// handful of passwords that show up first in every credential-stuffing list.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', '11111111', '00000000', 'iloveyou', 'minecraft',
  'letmein123', 'administrator', 'changeme', 'welcome1', 'admin123', 'abc12345',
  'baseball', 'football', 'sunshine', 'superman', 'trustno1', 'passw0rd',
]);
const MIN_PASSWORD_LENGTH = 8;

// First-run admin account. A fresh install gets a random, policy-satisfying
// password (see the helpers below); it is printed once at startup and saved
// to a one-time file next to config.json, then cleared on first sign-in.
const DEFAULT_ADMIN_EMAIL = 'admin@fleetdeck.local';
const DEFAULT_ADMIN_USERNAME = 'admin';

// First-run admin password handling. A fresh install gets a random password
// (never a repo-known default like the old 'Hostkind1'): the plaintext is
// written to a mode-0600 file next to config.json and printed once in the
// startup banner. The file is deleted on the first successful sign-in, so a
// missed console scroll doesn't lock the operator out - they can open the
// file. `initialAdminPassword` is the in-memory fallback for when the file
// cannot be written (e.g. a read-only install dir).
const INITIAL_PASSWORD_FILE = path.join(path.dirname(CONFIG_PATH), 'initial-admin-password.txt');
let initialAdminPassword = null;
function writeInitialPasswordFile(password) {
  initialAdminPassword = password;
  try {
    fs.writeFileSync(INITIAL_PASSWORD_FILE,
      `Hostkind first-run admin password. Sign in once and this file is deleted automatically.\n\n${password}\n`,
      { mode: 0o600 });
  } catch (err) { log('could not write initial admin password file:', err.message); }
}
function readInitialPasswordFile() {
  try { return fs.readFileSync(INITIAL_PASSWORD_FILE, 'utf8').trim().split('\n').pop() || null; } catch (_) { return null; }
}
function clearInitialPasswordFile() {
  initialAdminPassword = null;
  try { fs.unlinkSync(INITIAL_PASSWORD_FILE); } catch (_) { /* already gone */ }
}
// Returns an i18n error key when the password is unacceptable, or null when ok.
function passwordIssue(pw) {
  if (typeof pw !== 'string') return 'passwordTooShort';
  if (pw.length < MIN_PASSWORD_LENGTH) return 'passwordTooShort';
  if (pw.length > 200) return 'passwordTooLong';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'passwordTooCommon';
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes < 2) return 'passwordTooWeak';
  return null;
}

// Migrate a legacy single-server config (serverDir/jar/...) into config.servers[].
function migrateConfig() {
  let changed = false;
  // Safe-by-default bind: only listen on all interfaces when the operator
  // explicitly sets panelHost to 0.0.0.0 (e.g. a VPS that wants the panel on
  // the network). The docs and startup log claim localhost, so the default
  // must match.
  if (config.panelHost === undefined) {
    config.panelHost = '127.0.0.1';
    changed = true;
  }
  if (!Array.isArray(config.allowedOrigins)) {
    config.allowedOrigins = [];
    changed = true;
  }
  if (!config.appName || config.appName === 'Lodestone') {
    config.appName = 'Hostkind';
    changed = true;
  }
  if (!Array.isArray(config.servers)) {
    config.servers = [];
    if (config.serverDir) {
      config.servers.push({
        id: genId(),
        name: path.basename(config.serverDir) || 'Server',
        dir: config.serverDir,
        jar: config.jar || '',
        javaArgs: config.javaArgs || ['-Xmx2G', '-Xms2G'],
        mcVersion: config.mcVersion || '',
        stopTimeoutSeconds: config.stopTimeoutSeconds || 30,
        worlds: (config.backups && config.backups.worlds) || ['world', 'world_nether', 'world_the_end'],
        watchdog: config.watchdog || { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      });
    }
    changed = true;
  }
  if (!config.activeServerId && config.servers.length) {
    config.activeServerId = config.servers[0].id;
    changed = true;
  }
  // Propagate the legacy global `config.map.url` into each existing server
  // (only for servers that don't already have a mapUrl set), then drop the
  // global field. Per-server mapUrl is the source of truth from now on.
  if (config.map && typeof config.map.url === 'string' && config.map.url) {
    for (const s of config.servers) {
      if (!s.mapUrl) s.mapUrl = config.map.url;
    }
    delete config.map;
    changed = true;
  }
  for (const s of config.servers) {
    if (typeof s.mapUrl !== 'string') s.mapUrl = '';
    // Every server predates the module system until this field is set; treat
    // it as a Minecraft server (the only type that used to exist) so nothing
    // already registered loses functionality.
    if (!s.type) { s.type = 'minecraft'; changed = true; }
    if (s.type === 'valheim' && s.valheimSchema !== 1) {
      const migrated = valheimLaunch.migrateDescriptor(s);
      Object.assign(s, migrated);
      changed = true;
    }
  }
  if (!config.backups) {
    config.backups = { dir: path.join(os.homedir(), 'mc-backups'), maxCount: 10, maxSizeMB: 0 };
    changed = true;
  } else {
    // Backwards-compat: older configs used `retainCount` for the per-server
    // count cap. Rename to `maxCount` and add the new `maxSizeMB` knob (0 =
    // unlimited, the default).
    if (config.backups.retainCount !== undefined && config.backups.maxCount === undefined) {
      config.backups.maxCount = config.backups.retainCount;
      delete config.backups.retainCount;
      changed = true;
    }
    if (config.backups.maxCount === undefined) { config.backups.maxCount = 10; changed = true; }
    if (config.backups.maxSizeMB === undefined) { config.backups.maxSizeMB = 0; changed = true; }
    if (!config.backups.dir) {
      config.backups.dir = path.join(os.homedir(), 'mc-backups');
      changed = true;
    }
  }
  // Migrate the legacy single global password into a first user account.
  // Fresh installs (no legacy password) get a random one: repo-known defaults
  // are forgeable by anyone who reads the source.
  if (!Array.isArray(config.users) || !config.users.length) {
    const initialPassword = config.password || crypto.randomBytes(18).toString('base64url');
    if (!config.password) writeInitialPasswordFile(initialPassword);
    config.users = [{
      id: genId(),
      username: DEFAULT_ADMIN_USERNAME,
      email: DEFAULT_ADMIN_EMAIL,
      name: 'Admin',
      role: 'admin',
      passwordHash: hashPassword(initialPassword),
    }];
    delete config.password;
    changed = true;
  }
  // Every account must have a role. Accounts that predate the role system
  // (or any malformed value) become admins, so existing single-user setups
  // keep full access after the upgrade.
  for (const u of config.users) {
    if (u.email === 'admin@lodestone.io') { u.email = DEFAULT_ADMIN_EMAIL; changed = true; }
    if (u.role !== 'admin' && u.role !== 'operator') { u.role = 'admin'; changed = true; }
  }
  // Never leave a config without at least one admin (e.g. a hand-edited file
  // where every account was set to operator): promote the first account.
  if (config.users.length && !config.users.some((u) => u.role === 'admin')) {
    config.users[0].role = 'admin';
    changed = true;
  }
  if (config.geoLanguageDetection === undefined) { config.geoLanguageDetection = false; changed = true; }
  
  // Bug-report GitHub integration defaults: disabled until an administrator
  // configures it, destination Riloox/hostkind-open. The token is never stored
  // in the block - it comes from FLEETDECK_GITHUB_TOKEN (see the bug-report
  // wiring section further down). Prefer the config module's DEFAULTS when it
  // has landed; fall back to the documented literals so a partially-deployed
  // tree still boots.
  if (!config.bugReports || typeof config.bugReports !== 'object' || Array.isArray(config.bugReports)) {
    let bugReportDefaults = { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'] };
    try {
      const bugReportConfig = require('./lib/bug-report-config.cjs');
      if (bugReportConfig && bugReportConfig.DEFAULTS) bugReportDefaults = bugReportConfig.DEFAULTS;
    } catch (_) { /* config module not landed yet; literals above match its DEFAULTS */ }
    config.bugReports = bugReportDefaults;
    changed = true;
  }
  if (changed) saveConfig(config);
}

migrateConfig();

// ---------------------------------------------------------------------------
// Platform foundation (docs/roadmap/README.md "Shared platform foundation")
//
// Boot order:
//   1. config.json is loaded and migrateConfig() has normalized it.
//   2. open the SQLite database, run migrations, sweep stale operations,
//      sweep orphan staging directories, record the one-shot metrics.json
//      import.
//   3. /api/operations is mounted once the auth middleware is in place
//      (see below). The boot itself happens here, before any routes, so
//      the foundation tables exist by the time any handler runs.
//
// Boot is best-effort: a database failure logs a warning but does not
// abort the panel. Per spec: "Database failure must not affect process
// supervision; emit a safe panel warning and retry a bounded queued
// capture."
// ---------------------------------------------------------------------------

const _foundationBoot = bootFoundation({ servers: config.servers || [], users: config.users || [], logFn: log });
if (!_foundationBoot.ok) {
  log('foundation: boot reported failures; panel running with reduced capability:',
    _foundationBoot.steps.filter((s) => !s.ok).map((s) => `${s.step}:${s.error}`).join('; '));
} else {
  log('foundation: ready (db=' + require('./lib/db.cjs').dbPath() +
    ', applied=' + (_foundationBoot.steps.find((s) => s.step === 'migrate') || {}).applied + ')');
}

// Expired world previews, and the archives uploaded for import previews that
// were never applied, are scratch: drop them at boot so a cancelled import does
// not leave a multi-gigabyte zip behind forever.
function sweepWorldImports() {
  try {
    worlds.purgeExpiredPreviews();
    const dir = path.join(require('./lib/db.cjs').dataDir(), 'world-imports');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - worlds.PREVIEW_TTL;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true, recursive: true });
      } catch (_) { /* locked: try again next boot */ }
    }
  } catch (err) {
    log(`World import sweep failed: ${err.message}`);
  }
  // The same rule for Terraria world uploads: a `.wld` that was previewed and
  // never imported is scratch.
  try {
    const removed = terrariaWorlds.sweepImportStaging();
    if (removed.length) log(`Swept ${removed.length} abandoned Terraria world upload(s)`);
  } catch (err) {
    log(`Terraria world import sweep failed: ${err.message}`);
  }
  // The same rule for Valheim world-pair uploads.
  try {
    const removed = valheimWorlds.sweepImportStaging();
    if (removed.length) log(`Swept ${removed.length} abandoned Valheim world upload(s)`);
  } catch (err) {
    log(`Valheim world import sweep failed: ${err.message}`);
  }
}
sweepWorldImports();

// The same rule for Palworld mod archives: an upload that was previewed but
// never imported is scratch.
function sweepPalworldModImports() {
  try {
    const dir = path.join(require('./lib/db.cjs').dataDir(), 'palworld-mod-imports');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true, recursive: true });
      } catch (_) { /* locked: try again next boot */ }
    }
  } catch (err) {
    log(`Palworld mod import sweep failed: ${err.message}`);
  }
}
sweepPalworldModImports();

function findServer(id) {
  return config.servers.find((s) => s.id === id) || null;
}
function backupsDir() {
  return config.backups.dir || path.join(os.homedir(), 'mc-backups');
}

// ---------------------------------------------------------------------------
// Panel log (not to be confused with a Minecraft server console)
// ---------------------------------------------------------------------------

function log(...args) {
  const ts = new Date().toISOString();
  // The panel's own name on the terminal, derived from config so a branded
  // install does not narrate its boot under the stock product name.
  console.log(`[${config.appName || 'Hostkind'} ${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// Discord integration removed (batch E). notifyDiscord is retained as a
// no-op because the Minecraft module and several server-manager call sites
// still reference it; those callers will be cleaned up in a future batch.
// ---------------------------------------------------------------------------

function notifyDiscord() {}

// ---------------------------------------------------------------------------
// Server modules: everything specific to one kind of managed process
// (Minecraft today; more types register here later) lives behind this
// registry instead of being hardcoded into ServerManager. See
// lib/modules/base.cjs for the module contract.
// ---------------------------------------------------------------------------

const moduleRegistry = createRegistry({
  requiredJavaMajor,
  jarJavaMajor,
  resolveJavaForServer,
  ensureRuntime,
  readServerBind,
  probePortInUse,
  eKey,
  getConfig: () => config,
  notifyDiscord,
  fetchText: (url) => fetchText(url),
  downloadToFile: (url, dest, onProgress, signal) => downloadToFile(url, dest, onProgress, signal),
  installerCacheDir: INSTALLER_CACHE_DIR,
});

// Capabilities are resolved per registered server, not per game type: see
// lib/modules/gating.cjs (Terraria's variants expose different features).
const moduleGate = createModuleGate({
  registry: moduleRegistry,
  findServer: (id) => findServer(id),
  requestServerId: (req) => requestServerId(req),
});
const moduleCapabilitiesFor = moduleGate.capabilitiesFor;
const requireModuleCapability = moduleGate.requireModuleCapability;
const requireTerrariaServer = moduleGate.requireGameType('terraria');

// ---------------------------------------------------------------------------
// Server manager: supervises one process (one per registered server),
// delegating anything module-specific (Minecraft launch/console parsing/
// stop sequence/...) to moduleRegistry.get(desc.type).
// ---------------------------------------------------------------------------

const STATUS = {
  OFFLINE: 'offline',
  STARTING: 'starting',
  ONLINE: 'online',
  STOPPING: 'stopping',
};

class ServerManager {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.status = STATUS.OFFLINE;
    this.startedAt = null;
    this.manualStop = false;
    this.history = []; // { ts, text, level }
    // Per-module state bag (e.g. the Minecraft module keeps its players Set,
    // maxPlayers, and TPS tracking here) — see lib/modules/base.cjs.
    this.moduleState = {};
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.restartTimestamps = []; // for the watchdog (crash-loop guard)
    this.killTimer = null;
    this.readinessTimer = null;
    this.pollInterval = null;
    this.broadcast = () => {};
    // Adoption: set when we re-attach to a child left alive by a previous panel
    // session. Such a process has no stdin/stdout pipes we can reach, so its
    // console is detached; we can still monitor liveness and stop it by signal.
    this.adopted = false;
    this.adoptedPid = null;
    this.adoptedWatch = null;
    // Console line subscribers. Long operations that drive the server through
    // its console (world pre-generation) read progress from here instead of
    // re-parsing the history buffer.
    this.lineWatchers = new Set();
  }

  // Subscribe to console lines. Returns the unsubscribe function; a watcher
  // that throws is dropped rather than allowed to break the console pump.
  watchLines(fn) {
    this.lineWatchers.add(fn);
    return () => this.lineWatchers.delete(fn);
  }

  // The OS pid of the running server, whether we spawned it this session
  // (this.proc) or re-adopted it after a panel restart (this.adoptedPid).
  pid() {
    return this.proc ? this.proc.pid : (this.adoptedPid || null);
  }

  desc() {
    return findServer(this.id) || {};
  }
  name() {
    return this.desc().name || this.id;
  }
  dir() {
    return this.desc().dir;
  }
  // The module for this server's type (defaults to 'minecraft' for legacy
  // entries — see the `type` migration shim in migrateConfig()).
  module() {
    return moduleRegistry.get(this.desc().type);
  }
  addonsDir(kind) {
    const mod = this.module();
    return mod.addonsDir ? mod.addonsDir(this.desc(), kind) : path.join(this.dir(), kind === 'mods' ? 'mods' : 'plugins');
  }
  watchdogCfg() {
    // A server with no watchdog of its own inherits the panel-level switch,
    // so the watchdog settings dialog governs new and legacy servers alike.
    return this.desc().watchdog || config.watchdog || { enabled: false, maxRestarts: 3, windowMinutes: 10 };
  }

  isRunning() {
    return this.status === STATUS.STARTING || this.status === STATUS.ONLINE || this.status === STATUS.STOPPING;
  }

  uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  statusPayload() {
    const wd = this.watchdogCfg();
    const mod = this.module();
    const moduleFields = mod.statusFields ? mod.statusFields(this) : {};
    return {
      serverId: this.id,
      name: this.name(),
      status: this.status,
      pid: this.pid(),
      startedAt: this.startedAt,
      uptimeMs: this.uptimeMs(),
      watchdog: {
        enabled: !!wd.enabled,
        recentRestarts: this._recentRestartCount(),
        maxRestarts: wd.maxRestarts,
      },
      ...moduleFields,
    };
  }

  pushLine(text, level = 'info') {
    const mod = this.module();
    if (mod.redactLine) text = mod.redactLine(text);
    // The console stream is user-visible, so a white-labelled install must not
    // narrate its supervision under the stock product name. Every panel-authored
    // line carries a leading "[Hostkind] " tag; rewrite it from config.appName
    // at the single funnel instead of touching two dozen literals.
    const tag = `[${config.appName || 'Hostkind'}]`;
    const entry = { ts: Date.now(), text: text.replace(/^\[Hostkind\]/, tag), level };
    const max = config.consoleHistoryLines || 500;
    if (!appendConsoleLine(this.history, entry, max)) return;
    this.broadcast({ type: 'line', line: entry });
  }

  setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    this.broadcast({ type: 'status', status: this.statusPayload() });
  }

  classify(line) {
    if (/\/(ERROR|SEVERE|FATAL)\]/.test(line) || /\b(SEVERE|FATAL)\b/.test(line)) return 'error';
    if (/\/WARN\]/.test(line) || /\[WARNING\]/.test(line)) return 'warn';
    return 'info';
  }

  // -- start / stop -------------------------------------------------------

  start() {
    if (this.isRunning()) {
      return { ok: false, error: eKey('errors.alreadyRunning') };
    }
    // Everything module-specific (jar/launchArgs resolution, Java runtime
    // management, ...) lives in the module now; see lib/modules/base.cjs.
    return this.module().start(this);
  }

  // Called by module.start() once it has a concrete binary + args to run.
  // Handles the generic pre-flight check (module.preLaunch) and spawn.
  // `options.env` adds process-environment entries for runtimes that need them
  // (a Wine prefix, for example). Values never reach the console or the logs.
  _launch(bin, args, options = {}) {
    const d = this.desc();
    const cwd = d.cwd || d.dir;
    const mod = this.module();
    const visibleArgs = mod.displayLaunchArgs ? mod.displayLaunchArgs(args) : args;
    log(`Starting "${this.name()}":`, bin, visibleArgs.join(' '), 'in', cwd);
    if (mod.resetState) mod.resetState(this);
    this.manualStop = false;
    this.setStatus(STATUS.STARTING);
    this.pushLine(`[Hostkind] Starting "${this.name()}": ${bin} ${visibleArgs.join(' ')}`, 'info');

    const preLaunch = mod.preLaunch ? mod.preLaunch(this) : { ok: true };
    Promise.resolve(preLaunch).then((res) => {
      if (res && res.ok === false) {
        this.setStatus(STATUS.OFFLINE);
        this.pushLine(`[Hostkind] ${res.error}`, 'error');
        return;
      }
      this._spawn(bin, args, options);
    }).catch(() => {
      // If the pre-flight check itself failed, don't block the launch — just try.
      this._spawn(bin, args, options);
    });

    return { ok: true };
  }

  _spawn(bin, args, options = {}) {
    const d = this.desc();
    const mod = this.module();
    let proc;
    try {
      const spawnOptions = {
        cwd: d.cwd || d.dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      if (mod.spawnOptions) Object.assign(spawnOptions, mod.spawnOptions(this));
      if (options.env) spawnOptions.env = { ...process.env, ...options.env };
      proc = spawn(bin, args, spawnOptions);
    } catch (err) {
      this.setStatus(STATUS.OFFLINE);
      this.pushLine(`[Hostkind] Could not launch: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }

    this.proc = proc;
    this.startedAt = Date.now();
    this.adopted = false;
    this.adoptedPid = null;
    markServerStarted(this.id);
    // Persist the pid so a future panel restart can re-adopt this child.
    setRunRecord(this.id, { pid: proc.pid, startedAt: this.startedAt });

    proc.stdout.on('data', (b) => this._onData(b, 'stdout'));
    proc.stderr.on('data', (b) => this._onData(b, 'stderr'));

    proc.on('error', (err) => {
      this.pushLine(`[Hostkind] Process error: ${err.message}`, 'error');
    });

    proc.on('exit', (code, signal) => this._onExit(code, signal));

    if (mod.readinessTimeoutMs) {
      this.readinessTimer = setTimeout(() => {
        this.readinessTimer = null;
        if (this.status === STATUS.STARTING && this.proc && mod.onReadinessTimeout) {
          mod.onReadinessTimeout(this);
          this.broadcast({ type: 'status', status: this.statusPayload() });
        }
      }, mod.readinessTimeoutMs);
    }

    if (this.status === STATUS.STARTING && mod.detectOnline && mod.detectOnline(null, this)) {
      this.setStatus(STATUS.ONLINE);
      if (mod.onOnline) mod.onOnline(this);
    }

    return { ok: true };
  }

  _onData(buf, stream) {
    const key = stream === 'stdout' ? 'stdoutBuf' : 'stderrBuf';
    this[key] += buf.toString('utf8');
    let idx;
    while ((idx = this[key].indexOf('\n')) !== -1) {
      let line = this[key].slice(0, idx);
      this[key] = this[key].slice(idx + 1);
      line = line.replace(/\r$/, '').replace(ANSI_ESCAPE_RE, '');
      if (line.length === 0) {
        this.pushLine('', 'info');
        continue;
      }
      const level = stream === 'stderr' ? 'error' : this.classify(line);
      this.pushLine(line, level);
      this._inspectLine(line);
    }
  }

  _inspectLine(line) {
    // Fan out first: the parsing below returns early on the lines it claims,
    // and a subscriber must see every line regardless of what this method
    // makes of it. A watcher that throws is dropped, never allowed to break
    // the console pump.
    for (const watcher of this.lineWatchers) {
      try { watcher(line); }
      catch (err) {
        this.lineWatchers.delete(watcher);
        log(`Console watcher removed after an error: ${err.message}`);
      }
    }

    const mod = this.module();

    // "Process ready" detection is module-specific (Minecraft's "Done (Xs)!").
    if (this.status === STATUS.STARTING && mod.detectOnline && mod.detectOnline(line, this)) {
      if (this.readinessTimer) {
        clearTimeout(this.readinessTimer);
        this.readinessTimer = null;
      }
      this.setStatus(STATUS.ONLINE);
      if (mod.onOnline) mod.onOnline(this);
    }

    if (mod.inspectLine) mod.inspectLine(line, this);
  }

  _afterPlayerChange() {
    this.broadcast({ type: 'status', status: this.statusPayload() });
  }

  _startModulePolling() {
    this._stopModulePolling();
    const mod = this.module();
    if (!mod.pollCommands) return;
    const sec = config.playerListIntervalSeconds || 30;
    this.pollInterval = setInterval(() => {
      if (this.status !== STATUS.ONLINE) return;
      const cmds = mod.pollCommands(this) || [];
      for (const cmd of cmds) this.sendCommand(cmd, true);
    }, sec * 1000);
  }

  _stopModulePolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  sendCommand(cmd, silent = false) {
    if (this.adopted) {
      return { ok: false, error: eKey('errors.consoleDetached') };
    }
    if (!this.proc || !this.proc.stdin.writable) {
      return { ok: false, error: eKey('errors.notRunning') };
    }
    const trimmed = String(cmd).replace(/[\r\n]+$/, '');
    if (!silent) this.pushLine(`> ${trimmed}`, 'cmd');
    try {
      this.proc.stdin.write(trimmed + '\n');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  stop(force = false) {
    if (!this.isRunning()) {
      return { ok: false, error: eKey('errors.notRunning') };
    }
    this.manualStop = true;
    if (force) {
      this.pushLine('[Hostkind] Force killing the process.', 'warn');
      this._kill();
      return { ok: true };
    }
    this.setStatus(STATUS.STOPPING);
    if (this.adopted) {
      // A detached child has no stdin to receive a graceful-stop command;
      // SIGTERM triggers the process's own shutdown hook (e.g. Minecraft
      // still saves the world on SIGTERM).
      this.pushLine(`[Hostkind] Stopping detached "${this.name()}" (pid ${this.adoptedPid}) with SIGTERM...`, 'info');
      try { process.kill(this.adoptedPid, 'SIGTERM'); } catch (_) { /* already gone */ }
    } else {
      const mod = this.module();
      const seq = mod.buildStopSequence ? mod.buildStopSequence(this) : null;
      if (seq && seq.execute) {
        this.pushLine('[Hostkind] Stopping (graceful)...', 'info');
        Promise.resolve(seq.execute()).catch((err) => {
          if (!this.isRunning() || !this.proc) return;
          this.pushLine(`[Hostkind] Graceful stop failed (${err.message}); sending SIGTERM.`, 'warn');
          try { this.proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
        });
      } else if (seq && seq.command) {
        this.pushLine('[Hostkind] Stopping (graceful)...', 'info');
        this.sendCommand(seq.command, true);
      } else if (seq && seq.signal && this.proc) {
        this.pushLine(`[Hostkind] Stopping (${seq.signal})...`, 'info');
        try { this.proc.kill(seq.signal); } catch (_) { /* already gone */ }
      } else if (this.proc) {
        this.pushLine('[Hostkind] Stopping (SIGTERM)...', 'info');
        try { this.proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
      }
    }

    const timeoutSec = this.desc().stopTimeoutSeconds || config.stopTimeoutSeconds || 30;
    this.killTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.pushLine(`[Hostkind] Did not close within ${timeoutSec}s, killing process.`, 'warn');
        this._kill();
      }
    }, timeoutSec * 1000);
    return { ok: true };
  }

  _kill() {
    { const mod = this.module(); if (mod.onForcedStop) mod.onForcedStop(this); }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch (_) { /* noop */ }
    } else if (this.adopted && this.adoptedPid) {
      try {
        process.kill(this.adoptedPid, 'SIGKILL');
      } catch (_) { /* noop */ }
    }
  }

  async restart() {
    if (this.isRunning()) {
      this.pushLine('[Hostkind] Restart requested: stopping...', 'info');
      const exited = this._waitForExit();
      this.stop(false);
      await exited;
      // small pause so the OS releases ports/handles
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.pushLine('[Hostkind] Restart: starting again...', 'info');
    return this.start();
  }

  _waitForExit() {
    return new Promise((resolve) => {
      if (this.proc) return void this.proc.once('exit', () => resolve());
      if (this.adopted && this.adoptedPid) {
        // No 'exit' event for a process we didn't spawn; poll liveness. Run the
        // exit handler ourselves the moment we see it die so callers (restart)
        // observe OFFLINE before we resolve, rather than racing the 3s watcher.
        const iv = setInterval(() => {
          if (!this.adopted) { clearInterval(iv); return resolve(); }
          let alive = true;
          try { process.kill(this.adoptedPid, 0); } catch (_) { alive = false; }
          if (!alive) { clearInterval(iv); this._onAdoptedExit(); resolve(); }
        }, 500);
        return;
      }
      resolve();
    });
  }

  _onExit(code, signal) {
    const wasManual = this.manualStop;
    const statusBeforeExit = this.status;
    const crashOccurredAt = Date.now();
    const crashRuntimeMs = this.startedAt ? crashOccurredAt - this.startedAt : null;
    const crashHistory = this.history.slice();
    this._stopModulePolling();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }
    this.pushLine(`[Hostkind] "${this.name()}" exited (code=${code}, signal=${signal || 'none'}).`, wasManual ? 'info' : 'warn');
    this.proc = null;
    this.startedAt = null;
    { const mod = this.module(); if (mod.onExit) mod.onExit(this, { code, signal, manual: wasManual, statusBeforeExit }); }
    setRunRecord(this.id, null);
    this.setStatus(STATUS.OFFLINE);

    if (wasManual) {
      const mod = this.module();
      const clean = mod.id !== 'terraria' || this.moduleState?.lastStop?.clean;
      queueCrashCapture({ serverId: this.id, root: this.dir(), history: this.history.slice(), exitCode: code, signal, occurredAt: crashOccurredAt, runtimeMs: crashRuntimeMs,
        lifecycle: clean ? 'operator_stop' : 'unclean_stop',
        sources: mod.crashEvidence ? mod.crashEvidence(this.desc()) : undefined,
        rules: mod.crashRules ? mod.crashRules(this.desc()) : undefined });
    } else {
      // Unexpected crash
      const mod = this.module();
      queueCrashCapture({ serverId: this.id, root: this.dir(), history: crashHistory, exitCode: code, signal, occurredAt: crashOccurredAt, runtimeMs: crashRuntimeMs,
        lifecycle: statusBeforeExit === STATUS.STARTING ? 'failed_start' : 'crash',
        sources: mod.crashEvidence ? mod.crashEvidence(this.desc()) : undefined,
        rules: mod.crashRules ? mod.crashRules(this.desc()) : undefined });
      notifyDiscord(this.id, 'unexpected_exit', `:red_circle: "${this.name()}" **crashed** unexpectedly (code=${code}).`);
      addNotification('server_crashed', 'Server Crashed', `Server "${this.name()}" crashed unexpectedly (code=${code}).`, this.id);
      this._maybeWatchdogRestart();
    }
  }

  // -- adoption (re-attach to a child left alive across a panel restart) ---

  // Called on boot after pidMatches() confirms the recorded pid is still our
  // server. We can't recover the console (no pipes), but we can show it online,
  // monitor liveness, and stop it by signal.
  _adopt(pid, startedAt) {
    this.adopted = true;
    this.adoptedPid = pid;
    this.proc = null;
    this.manualStop = false;
    this.startedAt = startedAt || Date.now();
    { const mod = this.module(); if (mod.onAdopt) mod.onAdopt(this); }
    this.setStatus(STATUS.ONLINE);
    this.pushLine(`[Hostkind] Re-attached to "${this.name()}" (pid ${pid}) left running by a previous panel session. Console is detached — commands are unavailable until you restart the server, but Stop still works.`, 'warn');
    this._startAdoptedWatch();
  }

  _startAdoptedWatch() {
    this._stopAdoptedWatch();
    this.adoptedWatch = setInterval(() => {
      if (!this.adopted) return this._stopAdoptedWatch();
      let alive = true;
      try { process.kill(this.adoptedPid, 0); } catch (_) { alive = false; }
      if (!alive) this._onAdoptedExit();
    }, 3000);
  }

  _stopAdoptedWatch() {
    if (this.adoptedWatch) {
      clearInterval(this.adoptedWatch);
      this.adoptedWatch = null;
    }
  }

  _onAdoptedExit() {
    if (this.adoptedPid == null) return; // already handled (watcher vs. _waitForExit race)
    const wasManual = this.manualStop;
    const crashOccurredAt = Date.now();
    const crashRuntimeMs = this.startedAt ? crashOccurredAt - this.startedAt : null;
    this._stopAdoptedWatch();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.pushLine(`[Hostkind] Detached "${this.name()}" (pid ${this.adoptedPid}) has exited.`, wasManual ? 'info' : 'warn');
    this.adopted = false;
    this.adoptedPid = null;
    this.startedAt = null;
    { const mod = this.module(); if (mod.onExit) mod.onExit(this, {
      code: null, signal: null, manual: wasManual, statusBeforeExit: STATUS.ONLINE,
    }); }
    setRunRecord(this.id, null);
    this.setStatus(STATUS.OFFLINE);

    if (!wasManual) {
      { const mod = this.module(); queueCrashCapture({ serverId: this.id, root: this.dir(), history: this.history.slice(), exitCode: null, signal: null, occurredAt: crashOccurredAt, runtimeMs: crashRuntimeMs,
        lifecycle: 'crash', sources: mod.crashEvidence ? mod.crashEvidence(this.desc()) : undefined, rules: mod.crashRules ? mod.crashRules(this.desc()) : undefined }); }
      notifyDiscord(this.id, 'unexpected_exit', `:red_circle: "${this.name()}" **crashed** unexpectedly (was running detached).`);
      this._maybeWatchdogRestart();
    }
  }

  // -- watchdog -----------------------------------------------------------

  _recentRestartCount() {
    const windowMs = (this.watchdogCfg().windowMinutes || 10) * 60000;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < windowMs);
    return this.restartTimestamps.length;
  }

  _maybeWatchdogRestart() {
    const wd = this.watchdogCfg();
    if (!wd.enabled) return;
    const recent = this._recentRestartCount();
    if (recent >= (wd.maxRestarts || 3)) {
      this.pushLine(`[Hostkind] Watchdog: ${recent} restarts within the window, NOT relaunching (possible crash-loop).`, 'error');
      notifyDiscord(this.id, 'watchdog_action', `:no_entry: Watchdog "${this.name()}": restart limit reached (${recent}). Not relaunching to avoid a crash-loop.`);
      addNotification('watchdog_limit', 'Watchdog Crash Limit', `Server "${this.name()}" hit the watchdog restart limit (${recent}). Not relaunching to avoid a crash-loop.`, this.id);
      return;
    }
    this.restartTimestamps.push(Date.now());
    this.pushLine('[Hostkind] Watchdog: relaunching the server in 5s...', 'warn');
    notifyDiscord(this.id, 'watchdog_action', `:yellow_circle: Watchdog "${this.name()}": relaunching automatically...`);
    addNotification('watchdog_restart', 'Watchdog Restart', `Server "${this.name()}" crashed and will be automatically restarted in 5s.`, this.id);
    setTimeout(() => {
      if (!this.isRunning()) this.start();
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Manager registry
// ---------------------------------------------------------------------------

const managers = new Map();

function getManager(id) {
  if (!id) return null;
  if (!managers.has(id)) {
    const m = new ServerManager(id);
    m.broadcast = (obj) => globalBroadcast({ ...obj, serverId: id });
    managers.set(id, m);
  }
  return managers.get(id);
}

function activeManager() {
  return getManager(config.activeServerId);
}

function targetManager(req) {
  const id = req.get('X-Hostkind-Server-Id') || (req.query && req.query.serverId) || (req.body && req.body.serverId) || config.activeServerId;
  return getManager(id);
}

// Pre-create a manager (offline) for every registered server.
function ensureManagers() {
  for (const s of config.servers) getManager(s.id);
}
ensureManagers();

// Confirm a recorded pid is still alive AND is the same process we spawned
// (guarding against the OS recycling the pid onto something unrelated). We
// verify identity by matching the process's start time to the one we recorded,
// derived from pidusage's `elapsed`. If we can't verify (pidusage unavailable,
// e.g. wmic-less Windows), we conservatively decline to adopt.
async function pidMatches(pid, startedAt) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (_) { return false; } // ESRCH => dead
  try {
    const u = await pidusage(pid);
    if (!u || typeof u.elapsed !== 'number' || !startedAt) return false;
    const apparentStart = Date.now() - u.elapsed;
    return Math.abs(apparentStart - startedAt) < 5 * 60 * 1000; // 5-min tolerance
  } catch (_) {
    return false;
  }
}

// On boot, re-attach to any server child we intentionally left alive when the
// previous panel process exited (see shutdown()). Stale/mismatched records are
// dropped so we never signal an unrelated pid.
async function adoptOrphans() {
  const state = loadRunState();
  for (const [id, rec] of Object.entries(state)) {
    if (!findServer(id) || !rec || !rec.pid) { setRunRecord(id, null); continue; }
    if (await pidMatches(rec.pid, rec.startedAt)) {
      getManager(id)._adopt(rec.pid, rec.startedAt);
      log(`Adopted still-running server "${findServer(id).name}" (pid ${rec.pid}).`);
    } else {
      setRunRecord(id, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Express + HTTP + WebSocket
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '24mb' }));
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));

// ---------------------------------------------------------------------------
// HTTP security headers + cross-origin defense
// ---------------------------------------------------------------------------

// Security headers via helmet. CSP is tuned for the built SPA: React's inline
// style attributes need 'unsafe-inline' for style-src; the console/map views
// render data:/blob: images; the realtime channel is same-origin ws:/wss:.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Cross-origin request defense. The panel authenticates with a Bearer token
// (not ambient cookies), so cross-origin *reads* are already blocked by the
// browser; what remains is login CSRF and cross-origin state changes from a
// malicious page that can reach the panel on a LAN or exposed host. Reject
// state-changing requests whose Origin is present but not one of ours.
// Absent Origin (curl, non-browser clients) is allowed - those cannot ride
// ambient credentials.
//
// Allowed: loopback hosts on the panel's own port (same-origin), plus any
// hostname listed in config.allowedOrigins (e.g. a reverse-proxy domain or a
// sponsor host). The same rule gates the WebSocket upgrade below.
function originAllowed(origin) {
  if (!origin || typeof origin !== 'string') return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (loopback) {
      // A loopback origin is only ours when it uses the panel's own port.
      // http://127.0.0.1:<other-port> is a different app on the same host.
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (port === String(config.panelPort)) return true;
    }
    for (const entry of config.allowedOrigins || []) {
      try {
        const eh = new URL(entry).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (eh === hostname) return true;
      } catch (_) { /* bare hostname strings allowed too */ }
      if (String(entry).toLowerCase() === hostname) return true;
    }
    return false;
  } catch (_) { return false; }
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) {
      return res.status(403).json({ error: 'origin not allowed' });
    }
  }
  next();
});

// Routes must never echo raw fs/network errors verbatim: err.message embeds
// absolute paths and other internals. Log the full message server-side and
// return a path-stripped copy to the client.
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string' || !msg) return 'Internal server error';
  return msg
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')          // Windows paths
    .replace(/https?:\/\/[^\s'"]+/g, '<url>')           // URLs
    .replace(/\/[\w@.:-]+(?:\/[\w@.:-]+)+/g, '<path>')  // POSIX paths (2+ segments)
    .slice(0, 300);
}
function httpError(res, req, err, status = 500, fallback) {
  const detail = (err && err.message) || fallback || 'Internal server error';
  log(`http ${status} error:`, detail);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: sanitizeErrorMessage(detail) });
}

// ---------------------------------------------------------------------------
// Language detection (login IP → country → en/es) and translated errors
// ---------------------------------------------------------------------------

// Pre-login default language, e.g. for a self-host serving mostly Spanish
// users. DEFAULT_LANGUAGE=ES/EN (case-insensitive); unset or invalid falls
// back to English via normalizeLang(). Only affects the language shown
// before sign-in - a stored browser preference or an authenticated user's
// saved language always wins.
const DEFAULT_LANGUAGE = i18n.normalizeLang(process.env.DEFAULT_LANGUAGE);

// Resolves a tag like "es-AR" or "es" to one of the supported languages.
function langFromAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return null;
  const tags = header.split(',').map((s) => {
    const [tag, ...rest] = s.trim().split(';');
    const q = rest.find((p) => p.trim().startsWith('q='));
    const qv = q ? parseFloat(q.split('=')[1]) : 1;
    return { tag: tag.toLowerCase(), q: Number.isFinite(qv) ? qv : 1 };
  }).sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const base = tag.split('-')[0];
    if (i18n.SUPPORTED_LANGS.includes(base)) return base;
  }
  return null;
}

// Treat loopback and private/ULA addresses as "no public IP" - geolocation
// would be useless and the user is most likely sitting at the panel itself.
function isPrivateOrLoopback(ip) {
  if (!ip) return true;
  const s = String(ip).trim();
  if (s === '::1' || s === '::ffff:127.0.0.1') return true;
  if (s.startsWith('127.')) return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(s)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(s)) return true;
  return false;
}

function pickRequestIp(req, bodyClientIp) {
  // Prefer the IP the browser chose to report (it knows its real public IP,
  // the server only sees 127.0.0.1 when the panel runs on localhost). Fall
  // back to the socket IP, then to the X-Forwarded-For header so the panel
  // works behind a reverse proxy that sets it.
  if (bodyClientIp && !isPrivateOrLoopback(bodyClientIp)) return bodyClientIp;
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff && !isPrivateOrLoopback(xff)) return xff;
  const sock = req.socket && (req.socket.remoteAddress || '');
  if (sock) {
    // Node returns IPv6-mapped IPv4 as "::ffff:1.2.3.4" - strip the prefix.
    const cleaned = sock.replace(/^::ffff:/i, '');
    return cleaned;
  }
  return '';
}

// ipwho.is is free, HTTPS, no key. Cache results for 24h so a single panel
// login doesn't pay the round-trip on every refresh. Failure is silent and
// degrades to the user's stored language (or the default).
// geolocateIp removed (batch C) — was dead code, never called.

// Decide which language to use for a user. Order:
//   1. user.language (already set explicitly or on a previous login)
//   2. body.lang / Accept-Language header (manual override for this request)
//   3. geolocate the client IP and map country → language
//   4. default ('en')
function pickUserLanguage(user, req, body) {
  if (user && user.language && i18n.SUPPORTED_LANGS.includes(user.language)) return user.language;
  if (body && i18n.SUPPORTED_LANGS.includes(body.lang)) return body.lang;
  const al = langFromAcceptLanguage(req.headers['accept-language']);
  if (al) return al;
  return i18n.DEFAULT_LANG;
}

// Convenience: translate a key for the user's language, falling back to en
// automatically. `user` may be null on the login endpoint itself.
function tErr(user, key, vars) {
  const lang = (user && user.language) || i18n.DEFAULT_LANG;
  return i18n.t(lang, key, vars);
}

// Build a structured error object: { __i18n: true, key, vars }. Routes pass
// this through `localizeErr(user, err)` to get a translated message. Plain
// strings pass through unchanged so ad-hoc messages (e.g. "HTTP 500") still
// work.
function eKey(key, vars) {
  return { __i18n: true, key, vars: vars || null };
}

function localizeErr(user, err) {
  if (err && typeof err === 'object' && !Array.isArray(err) && err.__i18n) return tErr(user, err.key, err.vars || undefined);
  if (err && typeof err === 'object' && !Array.isArray(err) && err.key) return tErr(user, err.key, err.vars || undefined);
  return String(err == null ? '' : err);
}

// --- auth ---
function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, lang: i18n.normalizeLang(user.language) }, config.jwtSecret, {
    expiresIn: `${config.sessionHours || 168}h`,
  });
}

// Returns the decoded payload, or null when the token is missing/invalid.
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (_) {
    return null;
  }
}

// Resolve the live user behind a token (so deleting a user revokes its sessions).
function userFromToken(token) {
  const payload = token ? verifyToken(token) : null;
  return payload ? findUser(payload.sub) : null;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  // An API key is checked first and only when the token is shaped like one, so
  // a JWT never touches the key table and a key never reaches jwt.verify.
  const user = (apiKeys.looksLikeApiKey(token) ? apiKeys.verify(token) : userFromToken(token)) || guestUser();
  if (!user) {
    return res.status(401).json({ error: tErr(user, 'errors.unauthorized') });
  }
  req.user = user;
  next();
}

/*
 * Routes a machine principal may not reach. A key that could mint another key
 * turns one leaked provisioning credential into permanent, unrevokable access -
 * revoking the leaked key leaves the one it created behind. Key management
 * stays with a human who signed in, including for admin-role keys.
 */
function requireHuman(req, res, next) {
  if (apiKeys.isApiKeyPrincipal(req.user)) {
    return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
  }
  next();
}

// Require an admin account. Used to gate account management, the server
// registry, and global settings. Authorization is always enforced server-side;
// the UI hiding these for operators is only a convenience.
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
  }
  next();
}

// --- login brute-force throttling (in-memory; single-process panel) ---
// Two independent counters: one per account identifier (so guessing one
// account's password can't be done indefinitely) and one per client IP (so a
// single host can't spray many accounts). Both reset on a successful login.
const LOGIN_MAX_ATTEMPTS = 5;       // per identifier
const LOGIN_IP_MAX_ATTEMPTS = 15;   // per IP across all identifiers
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key -> { count, firstAt, lockUntil }

function clientKey(req, body) {
  // Prefer the socket's remote address (can't be spoofed by a request header).
  // Fall back to the browser-reported IP only when the socket address is
  // missing, which shouldn't normally happen.
  const ip = (req.socket && req.socket.remoteAddress) || (body && body.clientIp) || 'unknown';
  return String(ip);
}

function loginLockRemainingMs(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockUntil && rec.lockUntil > now) return rec.lockUntil - now;
  // Window expired: forget the record so counts don't accumulate forever.
  if (now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
}

function noteLoginFailure(key, max) {
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= max) rec.lockUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, rec);
}

function clearLoginFailures(...keys) {
  for (const k of keys) loginAttempts.delete(k);
}

app.post('/api/login', async (req, res) => {
  const { email, username, password, clientIp, lang } = req.body || {};
  const identifier = (username != null && String(username).trim()) || (email != null && String(email).trim()) || '';
  const ipKey = `ip:${clientKey(req, req.body)}`;
  const idKey = `id:${identifier.toLowerCase()}`;

  // Refuse early when either counter is locked, without revealing whether the
  // account exists. Surface a retry-after hint so the client can show minutes.
  const lockMs = Math.max(loginLockRemainingMs(ipKey), identifier ? loginLockRemainingMs(idKey) : 0);
  if (lockMs > 0) {
    res.set('Retry-After', String(Math.ceil(lockMs / 1000)));
    const minutes = Math.max(1, Math.ceil(lockMs / 60000));
    return res.status(429).json({ error: tErr({ language: lang }, 'errors.tooManyAttempts', { minutes }) });
  }

  const user = findUserByLogin(identifier);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    noteLoginFailure(ipKey, LOGIN_IP_MAX_ATTEMPTS);
    if (identifier) noteLoginFailure(idKey, LOGIN_MAX_ATTEMPTS);
    try { foundationAudit.record({ action: 'auth.login', outcome: 'failure', metadata: { reason: 'invalid_credentials' } }); }
    catch (err) { log('audit: login failure capture failed:', err.message); }
    return res.status(401).json({ error: tErr({ language: lang }, 'errors.wrongCredentials') });
  }
  clearLoginFailures(ipKey, idKey);
  // First successful sign-in clears the one-time first-run password file.
  clearInitialPasswordFile();

  // Decide which language to use for this session:
  //   - An explicit `lang` field on the body (manual switcher before login) wins.
  //   - Otherwise, if the user already has a language set, keep it.
  //   - Otherwise, fall back to the default (English).
  let chosen = i18n.normalizeLang(lang);
  if (chosen === i18n.DEFAULT_LANG && i18n.SUPPORTED_LANGS.includes(user.language)) {
    chosen = user.language;
  }
  // The panel defaults to English. We only ever switch away from it when the
  // user explicitly picks a language (this request's `lang`, or one they saved
  // before) - no IP geolocation guessing, so the default stays predictable.
  user.language = chosen;

  try { foundationAudit.record({ actorId: user.id, actorUsername: user.username, action: 'auth.login', targetType: 'session', outcome: 'success' }); }
  catch { return res.status(503).json({ error: 'Could not record security event' }); }

  res.json({ token: signToken(user), user: { ...publicUser(user), permissions: publicPermissions(user) } });
});

// Unauthenticated bootstrap: the SPA asks this before deciding between the
// login screen and the app shell. It only reveals whether sign-in is on,
// which any visitor can already infer by calling any other endpoint.
// Branding rides along because the login screen needs it too - it is the one
// screen rendered before any token exists, and a provider's customers must not
// see someone else's wordmark on the way in.
app.get('/api/auth-mode', (req, res) => {
  res.json({
    ok: true,
    authRequired: config.requireAuth !== false,
    defaultLanguage: DEFAULT_LANGUAGE,
    geoLanguageDetection: config.geoLanguageDetection === true,
    branding: branding.resolve(config),
    // Raw map for the Settings picker (which games have a custom hex and what
    // it is); resolved ramps for application. The picker cannot round-trip the
    // hex out of a resolved theme - a theme only carries the hue.
    gameAccents: config.gameAccents || {},
    gameThemes: branding.resolveGameAccents(config),
  });
});

// Everything else under /api requires a token
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/auth-mode') return next();
  return authMiddleware(req, res, next);
});

function requestServerId(req) {
  if (req.path.startsWith('/crashes/')) {
    const parts = req.path.split('/');
    const id = decodeURIComponent(parts[2] === 'groups' ? parts[3] || '' : parts[2] || '');
    try {
      const item = crashIntelligence.detail(id);
      if (item) return item.group.serverId;
    } catch (_) {}
  }
  const pathMatch = req.path.match(/^\/servers\/([^/]+)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const taskMatch = req.path.match(/^\/tasks\/([^/]+)/);
  if (taskMatch) {
    const task = (config.tasks || []).find((item) => item.id === decodeURIComponent(taskMatch[1]));
    if (task) return task.serverId;
  }
  const requested = req.get('X-Hostkind-Server-Id') || (req.query && req.query.serverId) || (req.body && req.body.serverId);
  if (requested) return requested;
  if (/^\/(?:server|status|metrics|health|crashes|command|players|playerlists|whitelist|palworld|terraria|addons|modrinth|modpacks|configs|files|backups|tasks|worlds)(?:\/|$)/.test(req.path)) {
    return config.activeServerId || null;
  }
  return null;
}

function capabilityForRequest(req) {
  const p = req.path;
  const method = req.method;
  if (p === '/login' || p.startsWith('/me') || p.startsWith('/foundation/') || p.startsWith('/operations')) return null;
  if (/^\/users(?:\/|$)/.test(p)) return foundationCapabilities.CAPABILITIES.USERS_MANAGE;
  // Minting a machine principal is the same trust level as creating an account,
  // so it rides the same global capability rather than inventing a new one.
  if (/^\/api-keys(?:\/|$)/.test(p)) return foundationCapabilities.CAPABILITIES.USERS_MANAGE;
  if (/^\/servers\/[^/]+\/clone(?:-preview)?$/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_MANAGE;
  // Panel presentation is per-server cosmetics, not server registration.
  if (/^\/servers\/[^/]+\/presentation(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.SERVER_VIEW : CAPABILITIES.SERVER_MANAGE;
  // Recoverable deletion: listing trash is a read, restoring or purging is not.
  if (/^\/trash(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.FILES_VIEW : CAPABILITIES.SERVER_MANAGE;
  if (/^\/portability(?:\/|$)/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_REGISTER;
  // The fleet list is visible to anyone with a per-server grant on something;
  // the handler filters it. Everything else under /servers (including creating
  // an entry on the exact path) stays behind SERVER_REGISTER.
  if (/^\/servers(?:\/|$)/.test(p) && !(method === 'GET' && p === '/servers') && !/^\/servers\/[^/]+\/(?:start|stop|restart)$/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_REGISTER;
  if (/^\/(?:server\/(?:start|stop|restart)|servers\/[^/]+\/(?:start|stop|restart))$/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_CONTROL;
  if (p === '/command') return foundationCapabilities.CAPABILITIES.COMMANDS_RUN;
  // A profile export carries save data and settings, so it is a server-management
  // action, not a console action; connectivity is a read.
  if (/^\/palworld\/profile(?:\/|$)/.test(p)) return CAPABILITIES.SERVER_MANAGE;
  if (/^\/palworld\/integrations(?:\/|$)/.test(p)) return CAPABILITIES.SERVER_MANAGE;
  if (/^\/palworld\/connectivity(?:\/|$)/.test(p)) return CAPABILITIES.SERVER_VIEW;
  if (/^\/palworld\/settings\/history(?:\/|$)/.test(p) && method === 'POST') return CAPABILITIES.CONFIGS_RESTORE;
  if (/^\/palworld\/mods(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.CONTENT_VIEW : CAPABILITIES.PLUGINS_MANAGE;
  if (/^\/palworld\/platform(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.SERVER_VIEW : CAPABILITIES.SERVER_MANAGE;
  if (/^\/palworld\/updates\/policy$/.test(p)) return method === 'GET' ? CAPABILITIES.UPDATES_VIEW : CAPABILITIES.UPDATES_POLICY;
  if (/^\/palworld\/updates\/apply$/.test(p)) return CAPABILITIES.UPDATES_APPLY;
  if (/^\/palworld\/updates(?:\/|$)/.test(p)) return CAPABILITIES.UPDATES_VIEW;
  if (/^\/palworld\/settings(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.CONFIGS_VIEW : CAPABILITIES.CONFIGS_EDIT;
  if (/^\/palworld\/players(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.PLAYERS_VIEW : CAPABILITIES.PLAYERS_MANAGE;
  if (/^\/palworld\/map\/calibration(?:\/|$)/.test(p)) return CAPABILITIES.MAP_MANAGE;
  if (/^\/palworld\/map(?:\/|$)/.test(p)) return CAPABILITIES.MAP_VIEW;
  if (/^\/palworld\/(?:kick|ban|unban)$/.test(p)) return CAPABILITIES.PLAYERS_MANAGE;
  if (p === '/palworld/announcements' || p === '/palworld/announce') return CAPABILITIES.ANNOUNCEMENTS_SEND;
  if (p === '/palworld/save') return CAPABILITIES.BACKUPS_CREATE;
  if (/^\/palworld(?:\/|$)/.test(p)) return CAPABILITIES.COMMANDS_RUN;
  // Terraria's mapping lives in its own module so a test can enumerate it, and
  // so an unmapped Terraria path denies by default (server.manage) instead of
  // inheriting a weaker capability from a fall-through.
  if (/^\/terraria\/import(?:\/|$)/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_REGISTER;
  const terraria = terrariaRouteCapability(p, method);
  if (terraria) return terraria;
  // Same rule for Valheim's worlds surface; other /valheim/* paths (updates,
  // etc.) are unaffected - the table only answers for /valheim/worlds.
  const valheim = valheimRouteCapability(p, method);
  if (valheim) return valheim;
  if (/^\/(?:players|playerlists|whitelist)(?:\/|$)/.test(p)) return method === 'GET' ? CAPABILITIES.PLAYERS_VIEW : CAPABILITIES.PLAYERS_MANAGE;
  if (/^\/modpacks(?:\/|$)/.test(p)) {
    if (method === 'GET') return foundationCapabilities.CAPABILITIES.CONTENT_VIEW;
    if (/\/clone$/.test(p)) return foundationCapabilities.CAPABILITIES.SERVER_MANAGE;
    if (/\/update(?:\/|$)/.test(p) || /\/rollback$/.test(p)) return foundationCapabilities.CAPABILITIES.UPDATES_APPLY;
    return foundationCapabilities.CAPABILITIES.CONTENT_INSTALL;
  }
  if (/^\/addons(?:\/|$)/.test(p) || p === '/modrinth/install') return method === 'GET' ? foundationCapabilities.CAPABILITIES.FILES_VIEW : foundationCapabilities.CAPABILITIES.PLUGINS_MANAGE;
  if (/^\/configs(?:\/|$)/.test(p)) return method === 'GET' ? foundationCapabilities.CAPABILITIES.CONFIGS_VIEW : foundationCapabilities.CAPABILITIES.CONFIGS_MANAGE;
  if (/^\/files(?:\/|$)/.test(p)) return method === 'GET' ? foundationCapabilities.CAPABILITIES.FILES_VIEW : foundationCapabilities.CAPABILITIES.FILES_MANAGE;
  if (/^\/backups(?:\/|$)/.test(p)) return method === 'GET' ? foundationCapabilities.CAPABILITIES.FILES_VIEW : foundationCapabilities.CAPABILITIES.BACKUPS_MANAGE;
  // Schedules gate the task record itself; the invoked action's own capability
  // is checked separately (see requireTaskActionCapability).
  if (/^\/tasks(?:\/|$)/.test(p)) {
    return method === 'GET' ? CAPABILITIES.SCHEDULES_VIEW : CAPABILITIES.SCHEDULES_MANAGE;
  }
  if (p === '/status' || p === '/metrics' || /^\/(?:health|crashes)(?:\/|$)/.test(p)) return method === 'GET' ? foundationCapabilities.CAPABILITIES.HEALTH_VIEW : foundationCapabilities.CAPABILITIES.HEALTH_MANAGE;
  return null;
}

app.use('/api', (req, res, next) => {
  const sensitiveRead = req.method === 'GET' && /^\/(?:users|configs|files|backups|audit|templates)(?:\/|$)/.test(req.path);
  if (req.user && req.method !== 'HEAD' && (req.method !== 'GET' || sensitiveRead)) {
    const startedAt = Date.now();
    res.on('finish', () => {
      try {
        foundationAudit.record({
          actorId: req.user.id,
          actorUsername: req.user.username,
          serverId: requestServerId(req),
          action: `${req.method.toLowerCase()} ${req.path}`,
          target: { path: req.path },
          outcome: res.statusCode < 400 ? 'success' : 'failure',
          requestId: req.requestId,
          metadata: { statusCode: res.statusCode, durationMs: Date.now() - startedAt },
        });
      } catch (err) { log('foundation: audit capture failed:', err.message); }
    });
  }
  next();
});

app.get('/api/modules', (req, res) => {
  res.json({ modules: moduleRegistry.list() });
});

app.use('/api/players', requireModuleCapability('players'));
app.use('/api/playerlists', requireModuleCapability('players'));
app.use('/api/whitelist', requireModuleCapability('players'));
app.use('/api/addons', requireModuleCapability('addons'));
app.use('/api/modrinth', requireModuleCapability('content-install'));
app.use('/api/modpacks', requireModuleCapability('content-install'));
app.use('/api/worlds', requireModuleCapability('worlds'));
app.use('/api/palworld', requireModuleCapability('rest-api'));
// Reserved for the Terraria surface (docs/terraria/00-baseline-contracts.md).
// `console` is the capability every Terraria variant has, but it is a
// capability every *game* has too, so the prefix also requires the targeted
// server to actually be a Terraria one. The variant-specific routes gate
// themselves further (mods on tModLoader, TShock administration on TShock)
// through their own capability string.
//
// `/api/terraria/versions` is the exception: it describes what exists upstream,
// not a registered server, and the create wizard calls it before any Terraria
// server exists. Its own capability (updates.view, mapped in the module's route
// table) still applies through the check below.
const exceptVersions = (middleware) => (req, res, next) => {
  if (/^\/import(?:\/|$)/.test(req.path)) return next();
  return /^\/versions(?:\/|$)/.test(req.path) ? next() : middleware(req, res, next);
};
app.use('/api/terraria', exceptVersions(requireTerrariaServer), exceptVersions(requireModuleCapability('console')));
app.use('/api/terraria/mods', requireModuleCapability('terraria-mods'));
app.use('/api/terraria/tshock', requireModuleCapability('terraria-tshock'));

app.use('/api', (req, res, next) => {
  const capability = capabilityForRequest(req);
  if (!capability) return next();
  const globalCapability = capability === foundationCapabilities.CAPABILITIES.USERS_MANAGE;
  const serverId = globalCapability ? null : requestServerId(req);
  if (!foundationCapabilities.has(req.user, serverId, capability)) {
    return res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability });
  }
  next();
});

// --- Terraria ----------------------------------------------------------------

function sendTerrariaError(res, error) {
  res.status(error.status || 500).json({ error: error.message, code: error.code || 'terraria_error' });
}

app.post('/api/terraria/import/preview', requireAdmin, (req, res) => {
  try {
    res.json(terrariaImport.preview({
      dir: req.body?.dir,
      variant: req.body?.variant,
      actorId: req.user.id,
      servers: config.servers,
    }));
  } catch (error) { sendTerrariaError(res, error); }
});

app.post('/api/terraria/import', requireAdmin, (req, res) => {
  let result = null;
  const previousActive = config.activeServerId;
  try {
    result = terrariaImport.adopt({
      token: req.body?.token,
      actorId: req.user.id,
      name: req.body?.name,
      variant: req.body?.variant,
      fixes: req.body?.fixes,
      servers: config.servers,
    });
    const entry = {
      id: genId(),
      watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      ...result.descriptor,
    };
    config.servers.push(entry);
    config.activeServerId = entry.id;
    try {
      saveConfig(config);
      getManager(entry.id);
    } catch (error) {
      config.servers = config.servers.filter((server) => server.id !== entry.id);
      config.activeServerId = previousActive;
      result.rollback();
      throw error;
    }
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: entry.id,
      action: 'terraria.import',
      targetType: 'server',
      targetId: entry.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: {
        directory: entry.dir,
        variant: entry.terrariaVariant,
        evidence: result.inspection.variant.evidence,
        appliedFixes: result.appliedFixes,
      },
    });
    addNotification('server_added', 'Terraria Server Adopted', `Existing Terraria server "${entry.name}" has been adopted.`, entry.id);
    res.json({ ok: true, server: serverWithStatus(entry), issues: result.inspection.issues, appliedFixes: result.appliedFixes });
  } catch (error) { sendTerrariaError(res, error); }
});

/*
 * The installable builds of one Terraria variant, resolved from upstream at
 * request time (docs/terraria/01-installation-versions.md).
 *
 * Unsupported entries stay in the response with the reason they cannot be
 * installed here - the wizard disables them visibly rather than hiding them,
 * because "TShock has no arm64 build" is an answer and an empty list is not.
 * `force=1` is the "check again" button; without it the ten-minute cache
 * answers.
 */
app.get('/api/terraria/versions', async (req, res) => {
  const variant = String(req.query.variant || 'vanilla').toLowerCase();
  if (!terrariaVariants.isVariant(variant)) {
    return res.status(400).json({ error: `Unknown Terraria variant: ${variant}`, code: 'unknown_variant' });
  }
  try {
    const list = await terrariaInstall.listVersions(variant, { force: req.query.force === '1' || req.query.force === 'true' });
    res.json({ ok: true, ...list });
  } catch (error) {
    sendTerrariaError(res, error);
  }
});

function terrariaConfigTarget(req, res) {
  const manager = targetManager(req);
  const desc = manager && manager.desc();
  if (!manager || !desc || desc.type !== 'terraria') {
    res.status(404).json({ error: 'Terraria configuration is not available for this server.' });
    return null;
  }
  return { id: manager.id, dir: manager.dir(), desc, manager };
}

function sendTerrariaConfigError(res, error) {
  const payload = {
    error: error?.message || 'Terraria configuration request failed.',
    code: error?.code || 'terraria_config_error',
  };
  if (error?.key) payload.key = error.key;
  res.status(Number(error?.status) || 500).json(payload);
}

app.get('/api/terraria/config', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try {
    const result = terrariaConfig.read(server);
    result.restartRequired = !!server.manager.moduleState?.configRestartRequired;
    res.json(result);
  } catch (error) { sendTerrariaConfigError(res, error); }
});

app.post('/api/terraria/config/preview', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try { res.json(terrariaConfig.preview(server, req.user.id, req.body || {})); }
  catch (error) { sendTerrariaConfigError(res, error); }
});

app.put('/api/terraria/config', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try {
    const result = terrariaConfig.apply(server, req.user.id, req.body || {}, req.get('Idempotency-Key'));
    if (result.restartRequired) (server.manager.moduleState ||= {}).configRestartRequired = true;
    foundationAudit.record({
      actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
      action: 'configs.edit', targetType: 'terraria-config', outcome: 'success',
      metadata: { changedKeys: [] },
    });
    res.json(result);
  } catch (error) { sendTerrariaConfigError(res, error); }
});

app.get('/api/terraria/config/raw', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try { res.json(terrariaConfig.readRaw(server, String(req.query.file || ''))); }
  catch (error) { sendTerrariaConfigError(res, error); }
});

app.put('/api/terraria/config/raw', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try {
    const result = terrariaConfig.writeRaw(server, req.user.id, req.body || {});
    if (result.restartRequired) (server.manager.moduleState ||= {}).configRestartRequired = true;
    foundationAudit.record({
      actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
      action: 'configs.edit', targetType: 'terraria-config-raw',
      targetId: String(req.body?.file || ''), outcome: 'success',
    });
    res.json(result);
  } catch (error) { sendTerrariaConfigError(res, error); }
});

app.get('/api/terraria/config/history', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try { res.json({ ok: true, history: terrariaConfig.history(server) }); }
  catch (error) { sendTerrariaConfigError(res, error); }
});

app.post('/api/terraria/config/history/:id/restore', (req, res) => {
  const server = terrariaConfigTarget(req, res);
  if (!server) return;
  try {
    const result = terrariaConfig.restore(server, req.params.id);
    (server.manager.moduleState ||= {}).configRestartRequired = true;
    foundationAudit.record({
      actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
      action: 'configs.restore', targetType: 'terraria-config',
      targetId: req.params.id, outcome: 'success',
    });
    res.json(result);
  } catch (error) { sendTerrariaConfigError(res, error); }
});

// Palworld's official administration API is never proxied to a user-supplied
// address. The module always connects to the configured port on 127.0.0.1,
// authenticates with the generated admin password, and keeps that credential
// out of responses and logs.
app.get('/api/palworld/status', async (req, res) => {
  const manager = targetManager(req);
  if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  try {
    await manager.module().refresh(manager);
    res.json({ ok: true, status: manager.statusPayload() });
  } catch (_) {
    res.status(503).json({ error: 'Palworld REST API is unavailable.' });
  }
});

function palworldSettingsTarget(req, res) {
  const manager = targetManager(req);
  if (!manager) {
    res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    return null;
  }
  return { id: manager.id, dir: manager.dir(), manager };
}

function sendPalworldSettingsError(res, error) {
  const status = Number(error?.status) || 500;
  res.status(status).json({ error: error?.message || 'Palworld settings request failed.', code: error?.code || 'settings_error' });
}

app.get('/api/palworld/settings', (req, res) => {
  const server = palworldSettingsTarget(req, res);
  if (!server) return;
  try {
    const result = palworldSettings.read(server);
    result.restartRequired = !!server.manager.moduleState?.settingsRestartRequired;
    res.json(result);
  } catch (error) {
    sendPalworldSettingsError(res, error);
  }
});

app.post('/api/palworld/settings/preview', (req, res) => {
  const server = palworldSettingsTarget(req, res);
  if (!server) return;
  try {
    const result = palworldSettings.preview(server, req.user.id, req.body || {});
    res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    sendPalworldSettingsError(res, error);
  }
});

app.put('/api/palworld/settings', (req, res) => {
  const server = palworldSettingsTarget(req, res);
  if (!server) return;
  try {
    const result = palworldSettings.apply(server, req.user.id, req.body || {}, req.get('Idempotency-Key'));
    if (result.restartRequired) server.manager.moduleState.settingsRestartRequired = true;
    res.json(result);
  } catch (error) {
    sendPalworldSettingsError(res, error);
  }
});

app.get('/api/palworld/settings/history', (req, res) => {
  const server = palworldSettingsTarget(req, res);
  if (!server) return;
  try {
    res.json({ ok: true, history: palworldSettings.history(server) });
  } catch (error) {
    sendPalworldSettingsError(res, error);
  }
});

app.post('/api/palworld/settings/history/:id/restore', (req, res) => {
  const server = palworldSettingsTarget(req, res);
  if (!server) return;
  try {
    const result = palworldSettings.restore(server, req.params.id);
    server.manager.moduleState.settingsRestartRequired = true;
    res.json(result);
  } catch (error) {
    sendPalworldSettingsError(res, error);
  }
});

function palworldUpdateTarget(req, res) {
  const manager = targetManager(req);
  const server = manager && findServer(manager.id);
  if (!manager || !server || server.type !== 'palworld') {
    res.status(404).json({ error: 'Palworld updates are not available for this server.' });
    return null;
  }
  return { server, manager };
}

function steamUpdateDeps() {
  const cacheDir = INSTALLER_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });
  return {
    cacheDir,
    download: (url, target, progress = () => {}) => downloadToFile(url, target, progress),
  };
}

async function palworldLatest(force = false) {
  return palworldUpdates.discoverLatest({ ...steamUpdateDeps(), force });
}

function sendPalworldUpdateError(res, error) {
  res.status(error.status || 500).json({ error: error.message, code: error.code || 'update_failed' });
}

app.get('/api/palworld/updates', async (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  try {
    const latest = await palworldLatest(false);
    res.json({ ok: true, update: await palworldUpdates.status({ ...target, latest }) });
  } catch (error) { sendPalworldUpdateError(res, error); }
});

app.post('/api/palworld/updates/check', async (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  try {
    const latest = await palworldLatest(true);
    res.json({ ok: true, update: await palworldUpdates.status({ ...target, latest }) });
  } catch (error) { sendPalworldUpdateError(res, error); }
});

app.post('/api/palworld/updates/preview', async (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  try {
    const latest = await palworldLatest(false);
    const plan = await palworldUpdates.preview({ ...target, latest, input: req.body || {} });
    res.json({ ok: true, plan });
  } catch (error) { sendPalworldUpdateError(res, error); }
});

app.post('/api/palworld/updates/apply', async (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  try {
    const result = await palworldUpdates.apply({
      ...target,
      actorId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      plan: req.body?.plan,
      planRevision: req.body?.revision,
      ...steamUpdateDeps(),
      announce: async (seconds) => {
        await target.manager.module().request(target.manager, 'POST', '/announce', {
          message: `Server update in ${seconds} seconds. Please move to a safe location.`,
        });
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      },
      createBackup: () => createBackup(target.manager, { applyRetention: false }),
    });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.update.apply',
      target: { fromBuildId: req.body?.plan?.installedBuildId, toBuildId: req.body?.plan?.targetBuildId },
      outcome: result.replay ? 'replayed' : 'started',
      requestId: req.requestId,
      operationId: result.operation.id,
      metadata: { policy: { restart: req.body?.plan?.restart, backupRequired: req.body?.plan?.backupRequired } },
    });
    res.status(202).json({ ok: true, operationId: result.operation.id, replay: result.replay });
  } catch (error) { sendPalworldUpdateError(res, error); }
});

app.get('/api/palworld/updates/policy', (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  res.json({ ok: true, policy: palworldUpdates.safePolicy(target.server.palworldUpdatePolicy) });
});

app.put('/api/palworld/updates/policy', (req, res) => {
  const target = palworldUpdateTarget(req, res);
  if (!target) return;
  target.server.palworldUpdatePolicy = palworldUpdates.safePolicy(req.body);
  saveConfig(config);
  foundationAudit.record({
    actorId: req.user.id,
    actorUsername: req.user.username,
    serverId: target.server.id,
    action: 'palworld.update.policy',
    targetType: 'server',
    targetId: target.server.id,
    outcome: 'success',
    requestId: req.requestId,
    metadata: { policy: target.server.palworldUpdatePolicy },
  });
  res.json({ ok: true, policy: target.server.palworldUpdatePolicy });
});

function valheimUpdateTarget(req, res) {
  const manager = targetManager(req);
  const server = manager && findServer(manager.id);
  if (!manager || !server || server.type !== 'valheim') {
    res.status(404).json({ error: 'Valheim updates are not available for this server.' });
    return null;
  }
  return { server, manager };
}

async function valheimLatest(force = false) {
  return valheimInstall.discoverAvailable({ ...steamUpdateDeps(), force });
}

function sendValheimUpdateError(res, error) {
  res.status(error.status || 500).json({ error: error.message, code: error.code || 'valheim_update_failed' });
}

app.get('/api/valheim/updates', async (req, res) => {
  const target = valheimUpdateTarget(req, res);
  if (!target) return;
  try { res.json({ ok: true, update: valheimInstall.updateStatus({ server: target.server, latest: await valheimLatest(false) }) }); }
  catch (error) { sendValheimUpdateError(res, error); }
});

app.post('/api/valheim/updates/check', async (req, res) => {
  const target = valheimUpdateTarget(req, res);
  if (!target) return;
  try { res.json({ ok: true, update: valheimInstall.updateStatus({ server: target.server, latest: await valheimLatest(true) }) }); }
  catch (error) { sendValheimUpdateError(res, error); }
});

app.post('/api/valheim/updates/preview', async (req, res) => {
  const target = valheimUpdateTarget(req, res);
  if (!target) return;
  try {
    const plan = valheimInstall.createPreview({
      ...target, actorId: req.user.id, latest: await valheimLatest(false), restart: req.body?.restart,
    });
    res.json({ ok: true, plan });
  } catch (error) { sendValheimUpdateError(res, error); }
});

app.post('/api/valheim/updates/apply', async (req, res) => {
  const target = valheimUpdateTarget(req, res);
  if (!target) return;
  try {
    const result = await valheimInstall.applyUpdate({
      ...target,
      actorId: req.user.id,
      previewToken: req.body?.previewToken,
      latest: await valheimLatest(false),
      restart: req.body?.restart !== false,
      options: {
        ...steamUpdateDeps(),
        operationId: req.get('Idempotency-Key') || crypto.randomUUID(),
        idempotencyKey: req.get('Idempotency-Key'),
        saveDescriptor: () => saveConfig(config),
      },
    });
    res.json({ ok: true, ...result });
  } catch (error) { sendValheimUpdateError(res, error); }
});

app.post('/api/valheim/updates/:operationId/rollback', async (req, res) => {
  const target = valheimUpdateTarget(req, res);
  if (!target) return;
  try {
    const result = await valheimInstall.rollbackUpdate({
      rollbackId: req.params.operationId,
      ...target,
      restart: req.body?.restart === true,
      saveDescriptor: () => saveConfig(config),
    });
    res.json({ ok: true, ...result });
  } catch (error) { sendValheimUpdateError(res, error); }
});

app.get('/api/valheim/updates/policy', (req, res) => {
  if (!valheimUpdateTarget(req, res)) return;
  res.json({ ok: true, policy: { enabled: false, mode: 'manual' } });
});

app.put('/api/valheim/updates/policy', (req, res) => {
  if (!valheimUpdateTarget(req, res)) return;
  res.status(409).json({ error: 'Automatic Valheim updates are not implemented. Manual updates remain available.', code: 'policy_not_implemented' });
});

// --- Palworld mods and extension frameworks (docs/palworld/06-mods.md) -----
//
// Uploaded packages are data, never programs: the archive lands in a scratch
// directory, the guard validates it, and only a previewed, staged, hash-verified
// copy is ever committed into the server folder.

function palworldModTarget(req, res) {
  const manager = targetManager(req);
  const server = manager && findServer(manager.id);
  if (!manager || !server || server.type !== 'palworld') {
    res.status(404).json({ error: 'Palworld mods are not available for this server.' });
    return null;
  }
  return { server: { ...server, dir: manager.dir() }, manager };
}

function sendPalworldModError(res, error) {
  res.status(Number(error?.status) || 500).json({ error: error?.message || 'The mod request failed.', code: error?.code || 'mod_error' });
}

const palworldModUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(require('./lib/db.cjs').dataDir(), 'palworld-mod-imports');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* reported by multer */ }
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
  }),
  fileFilter: (req, file, cb) => {
    if (!/\.zip$/i.test(file.originalname || '')) return cb(new Error('Only .zip mod packages can be imported.'));
    cb(null, true);
  },
  limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});

app.get('/api/palworld/mods', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(await palworldMods.inventory({ server: target.server, verify: req.query.verify === '1' }));
  } catch (error) { sendPalworldModError(res, error); }
});

app.get('/api/palworld/mods/catalog', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(await palworldWorkshop.catalog({
      query: req.query.q,
      page: req.query.page,
      sort: req.query.sort,
      tag: req.query.tag,
      force: req.query.force === '1',
    }));
  } catch (error) { sendPalworldModError(res, error); }
});

app.get('/api/palworld/mods/catalog/:workshopId', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const items = await palworldWorkshop.details([req.params.workshopId]);
    const item = items.get(String(req.params.workshopId));
    if (!item?.ok) return res.status(404).json({ error: 'That Workshop item is unavailable.', code: 'workshop_item_unavailable' });
    res.json({ ok: true, item, cached: palworldWorkshop.cachedPackages(target.server).some((entry) => entry.workshopId === item.workshopId) });
  } catch (error) { sendPalworldModError(res, error); }
});

app.get('/api/palworld/mods/sources', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const source = palworldWorkshop.sourceConfig(target.server);
    res.json({ ok: true, ...source, libraries: palworldWorkshop.discoverLibraries({ manualPaths: source.manualPaths, serverDir: target.server.dir }) });
  } catch (error) { sendPalworldModError(res, error); }
});

app.put('/api/palworld/mods/sources', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try { res.json({ ok: true, ...palworldWorkshop.saveSources(target.server, req.body || {}) }); }
  catch (error) { sendPalworldModError(res, error); }
});

app.get('/api/palworld/mods/official', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const compatibility = await palworldMods.compatibility({ server: target.server });
    res.json({ ...(await palworldWorkshop.checkUpdates(target.server)), compatibility });
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/preview', palworldModUpload.single('package'), async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  if (!req.file && !req.body?.workshopId) return res.status(400).json({ error: 'Choose a cached Workshop item or upload an official package ZIP.', code: 'package_required' });
  try {
    const result = await palworldWorkshop.preview({
      server: target.server,
      manager: target.manager,
      actorId: req.user.id,
      archivePath: req.file?.path,
      workshopId: req.body?.workshopId,
      serverRevision: req.body?.serverRevision == null ? null : Number(req.body.serverRevision),
      allowUnknownRevision: req.body?.allowUnknownRevision === true || req.body?.allowUnknownRevision === 'true',
    });
    res.json(result);
  } catch (error) {
    try {
      const staged = stagedUploadPath(req.file, palworldModImportsDir());
      if (staged) {
        // Inline resolve + startsWith barrier at the cleanup sink
        // (js/path-injection); stagedUploadPath already proved containment,
        // this restates it on the sink's own taint path.
        const uploadsRoot = path.resolve(palworldModImportsDir());
        const stagedResolved = path.resolve(staged);
        if (stagedResolved.startsWith(uploadsRoot + path.sep)) {
          fs.unlinkSync(stagedResolved);
        }
      }
    } catch (_) { /* swept later */ }    sendPalworldModError(res, error);
  }
}, (err, req, res, next) => {
  log('upload failed:', err.message);
  res.status(400).json({ error: sanitizeErrorMessage(err.message || 'The upload failed.'), code: 'upload_failed' });
});

app.post('/api/palworld/mods/install', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const result = await palworldWorkshop.install({
      server: target.server,
      manager: target.manager,
      actorId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      previewToken: req.body?.previewToken,
      revision: req.body?.revision,
    });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.mods.install',
      targetType: 'palworld-mod',
      targetId: result.operation.summary?.workshopId || target.server.id,
      outcome: result.replay ? 'replayed' : 'started',
      requestId: req.requestId,
      operationId: result.operation.id,
      metadata: { summary: result.operation.summary },
    });
    res.status(202).json({ ok: true, operationId: result.operation.id, replay: !!result.replay });
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/import', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const result = await palworldMods.applyImport({
      server: target.server,
      manager: target.manager,
      actorId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      previewToken: req.body?.previewToken,
      revision: req.body?.revision,
      restart: req.body?.restart !== false,
      backupRequired: req.body?.backupRequired === true,
      announce: async (seconds) => {
        await target.manager.module().request(target.manager, 'POST', '/announce', {
          message: `Server maintenance in ${seconds} seconds. Please move to a safe location.`,
        });
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      },
      createBackup: () => createBackup(target.manager, { applyRetention: false }),
    });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.mods.import',
      targetType: 'server',
      targetId: target.server.id,
      outcome: result.replay ? 'replayed' : 'started',
      requestId: req.requestId,
      operationId: result.operation.id,
      metadata: { summary: result.operation.summary },
    });
    res.status(202).json({ ok: true, operationId: result.operation.id, replay: !!result.replay });
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/:id/enabled', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const result = palworldWorkshop.setEnabled({
      server: target.server,
      manager: target.manager,
      workshopId: req.params.id,
      enabled: req.body?.enabled === true,
    });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: req.body?.enabled === true ? 'palworld.mods.enable' : 'palworld.mods.disable',
      targetType: 'palworld-mod',
      targetId: req.params.id,
      outcome: 'success',
      requestId: req.requestId,
    });
    res.json(result);
  } catch (error) { sendPalworldModError(res, error); }
});

app.delete('/api/palworld/mods/:id', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const result = palworldWorkshop.remove({ server: target.server, manager: target.manager, workshopId: req.params.id });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.mods.remove',
      targetType: 'palworld-mod',
      targetId: req.params.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { trashId: result.trashId, snapshotId: result.snapshotId },
    });
    res.json(result);
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/trash/:id/restore', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(palworldWorkshop.restore({ server: target.server, manager: target.manager, trashId: req.params.id }));
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/adopt', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(palworldMods.adopt({
      server: target.server,
      relPath: req.body?.path,
      name: req.body?.name,
      provider: req.body?.provider,
      sourceItemId: req.body?.sourceItemId,
    }));
  } catch (error) { sendPalworldModError(res, error); }
});

app.post('/api/palworld/mods/updates/check', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(await palworldWorkshop.checkUpdates(target.server));
  } catch (error) { sendPalworldModError(res, error); }
});

// The Wine runtime is an advanced per-server setting. Environment values are
// stored in the ignored configuration and never returned to a browser.
app.get('/api/palworld/platform', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json({ ok: true, compatibility: await palworldMods.compatibility({ server: target.server }) });
  } catch (error) { sendPalworldModError(res, error); }
});

app.put('/api/palworld/platform/wine', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  const server = findServer(target.server.id);
  const safe = palworldPlatform.safeWine(req.body || {});
  server.palworldWine = { enabled: safe.enabled, executable: safe.executable, prefix: safe.prefix, args: safe.args, env: safe.env };
  saveConfig(config);
  foundationAudit.record({
    actorId: req.user.id,
    actorUsername: req.user.username,
    serverId: server.id,
    action: 'palworld.platform.wine',
    targetType: 'server',
    targetId: server.id,
    outcome: 'success',
    requestId: req.requestId,
    metadata: { enabled: safe.enabled, executable: safe.executable, envKeys: Object.keys(safe.env) },
  });
  try {
    res.json({ ok: true, compatibility: await palworldMods.compatibility({ server: { ...server, dir: target.manager.dir() } }) });
  } catch (error) { sendPalworldModError(res, error); }
});

// --- Palworld portability and connectivity (docs/palworld/07-portability-safety.md)
//
// Exports are built from the registered server; imports and adoption create a
// *new* server and therefore live outside /api/palworld (which requires an
// active REST-capable server) under /api/portability, next to registration.

const palworldProfileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(require('./lib/db.cjs').dataDir(), 'palworld-profile-uploads');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* reported by multer */ }
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
  }),
  fileFilter: (req, file, cb) => {
    if (!/\.(?:zip|fdprofile\.zip)$/i.test(file.originalname || '')) return cb(new Error('Only a Hostkind profile archive can be imported.'));
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 },
});

function sendPortabilityError(res, error) {
  res.status(Number(error?.status) || 500).json({
    error: error?.message || 'The request failed.',
    code: error?.code || 'portability_error',
    conflict: error?.conflict || undefined,
  });
}

function tasksForServer(serverId) {
  return (config.tasks || []).filter((task) => task.serverId === serverId).map((task) => automation.migrateTask(task));
}

app.get('/api/palworld/profile/preview', (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(palworldPortability.exportPreview({
      server: target.server,
      selection: req.query.selection,
      tasks: tasksForServer(target.server.id),
      updatePolicy: target.server.palworldUpdatePolicy || null,
    }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/palworld/profile/export', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    const result = await palworldPortability.exportProfile({
      server: target.server,
      selection: req.body?.selection,
      actorId: req.user.id,
      tasks: tasksForServer(target.server.id),
      updatePolicy: target.server.palworldUpdatePolicy || null,
    });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.profile.export',
      targetType: 'server',
      targetId: target.server.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { selection: result.manifest.selection, files: result.manifest.entries.length, bytes: result.bytes },
    });
    res.json({
      ok: true,
      id: result.id,
      fileName: result.fileName,
      bytes: result.bytes,
      sha256: result.sha256,
      manifest: result.manifest,
      warnings: result.warnings,
    });
  } catch (error) { sendPortabilityError(res, error); }
});

app.get('/api/palworld/profile/export/:id/download', (req, res) => {
  try {
    const file = palworldPortability.exportFile(req.params.id);
    res.download(file, `${path.basename(file)}`);
  } catch (error) { sendPortabilityError(res, error); }
});

app.get('/api/palworld/connectivity', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(await palworldConnectivity.report({
      server: target.server,
      online: target.manager.status === 'online',
    }));
  } catch (error) { sendPortabilityError(res, error); }
});

// An external probe only ever runs when the operator asks for one, and its
// result is reported as an observation, never as a verdict on their router.
app.post('/api/palworld/connectivity/test', async (req, res) => {
  const target = palworldModTarget(req, res);
  if (!target) return;
  try {
    res.json(await palworldConnectivity.testEndpoint({ host: req.body?.host, port: req.body?.port }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/portability/palworld/adopt/preview', requireAdmin, (req, res) => {
  try {
    res.json(palworldPortability.inspectAdoption({
      dir: req.body?.dir,
      servers: config.servers,
      desiredRestPort: req.body?.restPort,
    }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/portability/palworld/adopt', requireAdmin, (req, res) => {
  try {
    const result = palworldPortability.adopt({
      dir: req.body?.dir,
      name: req.body?.name,
      servers: config.servers,
      desiredRestPort: req.body?.restPort,
    });
    const entry = { id: genId(), ...result.descriptor };
    config.servers.push(entry);
    if (!config.activeServerId) config.activeServerId = entry.id;
    saveConfig(config);
    getManager(entry.id);
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: entry.id,
      action: 'palworld.adopt',
      targetType: 'server',
      targetId: entry.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { reconciled: result.reconciled, snapshotId: result.snapshotId, buildId: result.build?.buildId || null },
    });
    addNotification('server_added', 'Server Adopted', `Existing Palworld server "${entry.name}" has been adopted.`, entry.id);
    res.json({
      ok: true,
      server: serverWithStatus(entry),
      reconciled: result.reconciled,
      snapshotId: result.snapshotId,
      preserved: result.preserved,
    });
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/portability/palworld/import/preview', requireAdmin, palworldProfileUpload.single('profile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A Hostkind profile archive is required.', code: 'archive_required' });
  try {
    res.json(await palworldPortability.importPreview({
      file: req.file.path,
      actorId: req.user.id,
      servers: config.servers,
    }));
  } catch (error) {
    sendPortabilityError(res, error);
  } finally {
    try {
      const staged = stagedUploadPath(req.file, palworldProfileUploadsDir());
      if (staged) {
        // Inline resolve + startsWith barrier at the cleanup sink
        // (js/path-injection); stagedUploadPath already proved containment,
        // this restates it on the sink's own taint path.
        const uploadsRoot = path.resolve(palworldProfileUploadsDir());
        const stagedResolved = path.resolve(staged);
        if (stagedResolved.startsWith(uploadsRoot + path.sep)) {
          fs.rmSync(stagedResolved, { force: true });
        }
      }
    } catch (_) { /* swept on restart */ }  }
});

app.post('/api/portability/palworld/import', requireAdmin, (req, res) => {
  try {
    const result = palworldPortability.confirmImport({
      token: req.body?.token,
      actorId: req.user.id,
      name: req.body?.name,
      dir: req.body?.dir,
      port: req.body?.port,
      restPort: req.body?.restPort,
      servers: config.servers,
    });
    const entry = { id: genId(), ...result.descriptor };
    config.servers.push(entry);
    if (!config.activeServerId) config.activeServerId = entry.id;
    saveConfig(config);
    getManager(entry.id);
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: entry.id,
      action: 'palworld.profile.import',
      targetType: 'server',
      targetId: entry.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { requiresServerFiles: result.requiresServerFiles, schedules: result.schedules.length },
    });
    addNotification('server_added', 'Profile Imported', `Palworld server "${entry.name}" has been imported.`, entry.id);
    res.json({
      ok: true,
      server: serverWithStatus(entry),
      requiresServerFiles: result.requiresServerFiles,
      schedules: result.schedules,
      updatePolicy: result.updatePolicy,
      nextSteps: result.nextSteps,
    });
  } catch (error) { sendPortabilityError(res, error); }
});

// Minecraft adoption preview. Mirrors the Palworld adopt/preview flow: the
// frontend cannot run Node.js filesystem detection, so this route exists for
// the detection step only; the actual adoption uses POST /api/servers.
app.use('/api/portability/minecraft', minecraftPortabilityRouter({
  requireAdmin,
  getConfig: () => config,
  sendError: sendPortabilityError,
}));

app.get('/api/palworld/players', async (req, res) => {
  const manager = targetManager(req);
  if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  try {
    await manager.module().refresh(manager);
    const health = manager.moduleState.restHealth;
    if (health?.state !== 'healthy') {
      return res.status(503).json({ error: 'Palworld REST API is unavailable.', restHealth: health });
    }
    const status = manager.statusPayload();
    res.json({
      ok: true,
      players: manager.module().listPlayers(manager),
      playerCount: status.playerCount || 0,
      maxPlayers: status.maxPlayers || 0,
      sampledAt: status.sampledAt || null,
      restHealth: health,
    });
  } catch (_) {
    res.status(503).json({ error: 'Palworld REST API is unavailable.' });
  }
});

app.get('/api/palworld/map', async (req, res) => {
  const manager = targetManager(req);
  if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  if (manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
  if (!foundationCapabilities.has(req.user, manager.id, CAPABILITIES.PLAYERS_VIEW)) {
    return res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability: CAPABILITIES.PLAYERS_VIEW });
  }
  await manager.module().refresh(manager).catch(() => {});
  const map = palworldMap.publicState(manager.desc());
  const health = manager.moduleState.restHealth;
  const healthy = health?.state === 'healthy';
  res.json({
    ok: true,
    ...map,
    restHealth: health,
    sampledAt: manager.statusPayload().sampledAt || null,
    players: (manager.module().listPlayers(manager) || []).map((player) => ({
      ...player,
      mapPosition: palworldMap.project(player.location, map.calibration),
      mapGrid: palworldMap.grid(player.location),
      state: healthy ? 'live' : 'stale',
    })).concat(healthy ? (manager.module().listDepartedPlayers?.(manager) || []).map((player) => ({
      ...player,
      mapPosition: palworldMap.project(player.location, map.calibration),
      mapGrid: palworldMap.grid(player.location),
      state: 'offline',
    })) : []),
  });
});

app.get('/api/palworld/map/asset', (req, res) => {
  const manager = targetManager(req);
  if (manager && manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
  const asset = manager ? palworldMap.assetFile(manager.desc()) : null;
  if (!asset) return res.status(404).json({ error: 'Map asset not found.' });
  const resolved = path.resolve(asset.file);
  if (!asset.builtin) {
    const allowed = path.resolve(manager.dir(), '.fleetdeck', 'palworld-map') + path.sep;
    if (!resolved.startsWith(allowed)) return res.status(404).json({ error: 'Map asset not found.' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Map asset not found.' });
  res.type(asset.mediaType).sendFile(resolved);
});

app.put('/api/palworld/map/calibration', (req, res) => {
  const manager = targetManager(req);
  if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  if (req.user.role !== 'admin') return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
  if (manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
  try {
    if (req.body?.restoreRevision) {
      const result = palworldMap.restore(manager.desc(), req.body.restoreRevision);
      saveConfig(config);
      foundationAudit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
        action: 'palworld.map.restore', targetType: 'server', targetId: manager.id,
        outcome: 'success', requestId: req.requestId, metadata: { revision: result.revision },
      });
      return res.json({ ok: true, ...result });
    }
    if (req.body?.resetToDefault) {
      const result = palworldMap.resetToDefault(manager.desc());
      saveConfig(config);
      foundationAudit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
        action: 'palworld.map.reset', targetType: 'server', targetId: manager.id,
        outcome: 'success', requestId: req.requestId, metadata: { revision: result.revision },
      });
      return res.json({ ok: true, ...result });
    }
    const result = req.body?.preview
      ? palworldMap.preview(manager.desc(), req.body)
      : palworldMap.apply(manager.desc(), req.body);
    if (!req.body?.preview) saveConfig(config);
    if (!req.body?.preview) foundationAudit.record({
      actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
      action: 'palworld.map.calibrate', targetType: 'server', targetId: manager.id,
      outcome: 'success', requestId: req.requestId,
      metadata: { revision: result.revision, assetVersion: result.asset.version, checksum: result.asset.checksum },
    });
    res.json({ ok: true, ...result, _decoded: undefined });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || 'invalid_map' });
  }
});

function auditPalworldMutation(req, manager, action, outcome, {
  targetId = null, content = null, idempotencyKey = null, metadata = null,
} = {}) {
  try {
    const auditMetadata = {};
    if (content != null) auditMetadata.content = palworldOperations.contentFingerprint(content);
    if (idempotencyKey) auditMetadata.idempotencyKeyHash = palworldOperations.safeTargetId(idempotencyKey);
    Object.assign(auditMetadata, metadata || {});
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: manager.id,
      action: `palworld.${action}`,
      targetType: targetId ? 'player' : 'server',
      targetId: targetId ? palworldOperations.safeTargetId(targetId) : manager.id,
      outcome,
      requestId: req.requestId,
      metadata: auditMetadata,
    });
  } catch (error) {
    log('audit: Palworld mutation capture failed:', error.message);
  }
}

function palworldMutationContext(req, res, capability, limiter) {
  const manager = targetManager(req);
  if (!manager) {
    res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    return null;
  }
  if (!foundationCapabilities.has(req.user, manager.id, capability)) {
    res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability });
    return null;
  }
  if (manager.status !== 'online') {
    res.status(409).json({ error: 'The server must be online.' });
    return null;
  }
  const rate = limiter(`${req.user.id}:${manager.id}`);
  if (!rate.allowed) {
    res.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    res.status(429).json({ error: 'Too many Palworld requests. Try again shortly.' });
    return null;
  }
  return manager;
}

async function applyPalworldMutation(req, res, {
  action, endpoint = action, body, targetId = null, content = null, idempotent = false,
}) {
  const manager = targetManager(req);
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (idempotent && !key) return res.status(400).json({ error: 'Idempotency-Key is required.' });
  const replayKey = `${req.user.id}:${manager.id}:${action}:${key}`;
  const replay = idempotent ? palworldReplays.get(replayKey) : null;
  if (replay) return res.status(replay.status).json({ ...replay.body, replayed: true });
  try {
    const data = await manager.module().mutate(manager, endpoint, body);
    const result = { status: action === 'save' ? 202 : 200, body: {
      ok: true,
      accepted: true,
      completed: action === 'save' ? null : true,
      requestId: req.requestId,
      ...(data?.result || {}),
    } };
    if (idempotent) palworldReplays.set(replayKey, result);
    auditPalworldMutation(req, manager, action, 'success', { targetId, content, idempotencyKey: key });
    manager.module().refresh(manager).catch(() => {});
    return res.status(result.status).json(result.body);
  } catch (error) {
    const unknown = error?.state === 'timeout';
    const result = {
      status: unknown ? 504 : 503,
      body: {
        error: unknown
          ? 'The Palworld REST API timed out. The outcome is unknown; refresh before retrying.'
          : 'Palworld REST API is unavailable.',
        outcome: unknown ? 'unknown' : 'failure',
        requestId: req.requestId,
      },
    };
    if (idempotent) palworldReplays.set(replayKey, result);
    auditPalworldMutation(req, manager, action, unknown ? 'unknown' : 'failure', {
      targetId, content, idempotencyKey: key, metadata: { errorCode: error?.code || 'request_failed' },
    });
    manager.module().refresh(manager).catch(() => {});
    return res.status(result.status).json(result.body);
  }
}

async function playerMutation(req, res, action, routeUserId) {
  const manager = palworldMutationContext(req, res, CAPABILITIES.PLAYERS_MANAGE, limitPalworldPlayers);
  if (!manager) return;
  const parsedId = palworldOperations.userId(routeUserId ?? req.body?.userId);
  if (parsedId.error) return res.status(400).json({ error: parsedId.error });
  const parsedReason = palworldOperations.text(req.body?.reason ?? req.body?.message, { label: 'Reason' });
  if (parsedReason.error) return res.status(400).json({ error: parsedReason.error, limit: palworldOperations.MESSAGE_LIMIT });
  if (action !== 'unban') {
    await manager.module().refresh(manager);
    const health = manager.moduleState.restHealth;
    if (health?.state !== 'healthy') return res.status(503).json({ error: 'Palworld REST API is unavailable.', restHealth: health });
    const player = manager.module().listPlayers(manager).find((item) => item.userId === parsedId.value);
    if (!player) return res.status(409).json({ error: 'The player is no longer online. Refresh the list.' });
    if (Date.now() - Date.parse(player.observedAt) > palworldOperations.STALE_PLAYER_MS) {
      return res.status(409).json({ error: 'The player observation is stale. Refresh the list.' });
    }
  }
  const mutationBody = { userid: parsedId.value };
  if (action !== 'unban' && parsedReason.value) mutationBody.message = parsedReason.value;
  return applyPalworldMutation(req, res, {
    action,
    body: mutationBody,
    targetId: parsedId.value,
    content: parsedReason.value,
    idempotent: true,
  });
}

app.post('/api/palworld/players/:userId/kick', (req, res) => playerMutation(req, res, 'kick', req.params.userId));
app.post('/api/palworld/players/:userId/ban', (req, res) => playerMutation(req, res, 'ban', req.params.userId));
app.post('/api/palworld/players/unban', (req, res) => playerMutation(req, res, 'unban'));

app.post('/api/palworld/announcements', (req, res) => {
  const manager = palworldMutationContext(req, res, CAPABILITIES.ANNOUNCEMENTS_SEND, limitPalworldAnnouncements);
  if (!manager) return;
  const parsed = palworldOperations.text(req.body?.message, { required: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error, limit: palworldOperations.MESSAGE_LIMIT });
  return applyPalworldMutation(req, res, { action: 'announcement', endpoint: 'announce', body: { message: parsed.value }, content: parsed.value });
});

app.post('/api/palworld/save', (req, res) => {
  const manager = palworldMutationContext(req, res, CAPABILITIES.BACKUPS_CREATE, limitPalworldPlayers);
  if (!manager) return;
  return applyPalworldMutation(req, res, { action: 'save', body: undefined });
});

// Compatibility shims for clients using the original action endpoint.
app.post('/api/palworld/:action', (req, res) => {
  const action = String(req.params.action || '').toLowerCase();
  if (action === 'kick' || action === 'ban' || action === 'unban') return playerMutation(req, res, action);
  if (action === 'announce') {
    const manager = palworldMutationContext(req, res, CAPABILITIES.ANNOUNCEMENTS_SEND, limitPalworldAnnouncements);
    if (!manager) return;
    const parsed = palworldOperations.text(req.body?.message, { required: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error, limit: palworldOperations.MESSAGE_LIMIT });
    return applyPalworldMutation(req, res, { action: 'announcement', endpoint: 'announce', body: { message: parsed.value }, content: parsed.value });
  }
  if (action === 'save') {
    const manager = palworldMutationContext(req, res, CAPABILITIES.BACKUPS_CREATE, limitPalworldPlayers);
    if (!manager) return;
    return applyPalworldMutation(req, res, { action: 'save', body: undefined });
  }
  return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
});

// ---------------------------------------------------------------------------
// Bug-report sync integration (plan Task 3/4 wiring + upstream-relay Task 5)
//
// Three surfaces share the config block `config.bugReports`:
//   1. POST /api/bug-reports persists a report, then attempts an immediate
//      one-shot sync (syncBugReportNow). A GitHub/relay failure never fails
//      the request: the row stays pending/retryable and the scheduler retries.
//   2. A bounded cron retry (createSyncWorker for github mode,
//      runRelayBugReportSyncOnce for upstream-relay mode) drains
//      pending/failed rows under an attempt/backoff policy.
//   3. PUT /api/config/bug-reports (admin) updates non-secret settings; the
//      token is environment-driven (FLEETDECK_GITHUB_TOKEN) and the relayUrl
//      is server config only (config.json) — neither is ever stored in
//      config.json from the browser nor returned to it.
//
// The core modules (lib/bug-reports.cjs, lib/bug-report-config.cjs,
// lib/github-issues.cjs, lib/bug-report-sync.cjs) land in the same feature
// wave. They are loaded lazily so a partially-deployed tree still boots and
// the rest of the panel keeps working; once they exist the integration is
// fully active.
// ---------------------------------------------------------------------------
let _bugReportsStore = null;
let _bugReportConfig = null;
let _githubIssues = null;
let bugReportsWorker = null;

function loadBugReportCore() {
  if (_bugReportsStore && _bugReportConfig && _githubIssues) return true;
  try {
    _bugReportsStore = require('./lib/bug-reports.cjs');
    _bugReportConfig = require('./lib/bug-report-config.cjs');
    _githubIssues = require('./lib/github-issues.cjs');
    return true;
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') log('bug-report core load failed:', (err && err.message) || err);
    _bugReportsStore = null; _bugReportConfig = null; _githubIssues = null;
    return false;
  }
}

function bugReportConfigBlock() {
  if (!loadBugReportCore()) return { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'], mode: 'github', relayUrl: null, token: null, errors: [] };
  try { return _bugReportConfig.normalizeConfig(config.bugReports || {}, process.env); }
  catch {
    return { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'], mode: 'github', relayUrl: null, token: null, errors: ['config_invalid'] };
  }
}

// One-shot sync for the POST route: create the GitHub issue (github mode) or
// POST a redacted payload to the upstream relay (upstream-relay mode), record
// the outcome on the durable row, and return the sync summary the router
// echoes. Never throws; never leaks a token (errors are redacted by the
// clients and again by the router before they reach a response).
async function syncBugReportNow(report) {
  if (!loadBugReportCore() || !report) {
    return { state: 'pending', issueNumber: null, issueUrl: null, error: 'sync_unavailable: bug-report modules not loaded' };
  }
  const cfg = bugReportConfigBlock();
  if (!cfg.enabled) {
    // Not configured: the report stays pending locally. This is different
    // from an outage, so the UI must not claim the relay/GitHub is down.
    // Since local-only sync is the open edition's default, the summary also
    // carries a direct link to the configured repo's issue chooser so the
    // user can still reach the public tracker.
    return {
      state: 'pending',
      issueNumber: null,
      issueUrl: null,
      reason: 'not_configured',
      message: 'Bug-report sync is not configured. The report is saved locally and will sync after an administrator enables it.',
      error: 'sync_disabled: bug-report integration is not configured',
      trackerUrl: _bugReportConfig.buildTrackerUrl(cfg.owner, cfg.repo),
    };
  }
  if (cfg.mode === 'upstream-relay') {
    // Relay failures never fail the request: the row stays pending/retryable
    // and the scheduler re-posts with the same idempotency key.
    return _bugReportConfig.syncReportToRelay(report, {
      relayUrl: cfg.relayUrl,
      timeoutMs: _bugReportConfig.RELAY_TIMEOUT_MS,
      trackerUrl: _bugReportConfig.buildTrackerUrl(cfg.owner, cfg.repo),
      markSynced: (id, meta) => _bugReportsStore.markSynced(id, meta),
      markFailed: (id, meta) => _bugReportsStore.markFailed(id, meta),
    });
  }
  if (!cfg.token) {
    // Tokenless github mode: the report stays pending locally. This is
    // different from an outage, so the UI must not claim that GitHub is down.
    return {
      state: 'pending',
      issueNumber: null,
      issueUrl: null,
      reason: 'not_configured',
      message: 'GitHub issue sync is not configured. The report is saved locally and will sync after an administrator enables it.',
      error: 'sync_disabled: GitHub integration is not configured',
      trackerUrl: _bugReportConfig.buildTrackerUrl(cfg.owner, cfg.repo),
    };
  }
  const client = _githubIssues.createGitHubClient({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, labels: cfg.labels });
  const marker = report.marker || `fleetdeck-${report.id}`;
  try {
    const body = _githubIssues.buildIssueBody({
      summary: report.title || '',
      description: report.description || '',
      reproSteps: report.reproSteps || report.repro_steps || null,
      expected: report.expected || null,
      route: report.route || null,
      view: report.view || null,
      game: report.game || null,
      actorUsername: report.actorUsername || report.actor_username || null,
      actorId: report.actorId || report.actor_id || null,
      timestamp: new Date(report.createdAt || report.created_at || Date.now()).toISOString(),
      version: report.version || PANEL_VERSION,
      userAgent: report.userAgent || report.user_agent || null,
      marker,
    });
    const result = await client.createIssue({ title: report.title || 'Untitled report', body, marker });
    _bugReportsStore.markSynced(report.id, { issueNumber: result.issueNumber, issueUrl: result.issueUrl });
    return { state: 'synced', issueNumber: result.issueNumber, issueUrl: result.issueUrl, error: null };
  } catch (err) {
    const error = String((err && err.message) || err || 'sync failed');
    const attempts = (report.attempts || 0) + 1;
    try { _bugReportsStore.markFailed(report.id, { error, attempts }); } catch (_) { /* row stays pending */ }
    return { state: 'failed', issueNumber: null, issueUrl: null, error };
  }
}

// (Re)build the retry worker from the current config. Called at scheduler
// setup and after every config save, so owner/repo/enabled/mode changes take
// effect without a restart. The cron callback re-reads `bugReportsWorker` at
// tick time, so replacing it here is picked up by the existing job.
function rebuildBugReportWorker() {
  bugReportsWorker = null;
  if (!loadBugReportCore()) return;
  const cfg = bugReportConfigBlock();
  if (!cfg.enabled) return;
  if (cfg.mode === 'upstream-relay') {
    if (!cfg.relayUrl) return;
    // Relay retries use the same durable store and backoff policy as the
    // GitHub worker, but the client is the upstream relay: every POST carries
    // the same clientKey so re-posts are idempotent at the relay.
    bugReportsWorker = { runOnce: runRelayBugReportSyncOnce };
    return;
  }
  if (!cfg.token) return;
  try {
    const { createSyncWorker } = require('./lib/bug-report-sync.cjs');
    const client = _githubIssues.createGitHubClient({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, labels: cfg.labels });
    bugReportsWorker = createSyncWorker({
      store: _bugReportsStore,
      client,
      logger: { warn: (m) => log('bug-report sync:', m) },
    });
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') log('bug-report sync worker unavailable:', (err && err.message) || err);
    bugReportsWorker = null;
  }
}

/*
 * Relay-mode retry pass for the scheduler. Mirrors the GitHub worker's
 * contract (never rejects; bounded by the store's attempt/backoff policy) but
 * interprets the relay's 201/202/error responses:
 *   - issueUrl present            -> markSynced
 *   - 202 queued (no url)         -> leave the row pending; the next tick
 *                                    re-posts with the same clientKey until
 *                                    the relay's queue worker creates the
 *                                    issue (rate limits make re-posts bounded)
 *   - any other status / network  -> markFailed attempts+1 (retryable)
 * A module-level busy flag prevents overlapping passes.
 */
let relaySyncBusy = false;
async function runRelayBugReportSyncOnce() {
  const counts = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  if (relaySyncBusy) return counts;
  relaySyncBusy = true;
  try {
    const cfg = bugReportConfigBlock();
    if (!cfg.enabled || cfg.mode !== 'upstream-relay' || !cfg.relayUrl) return counts;
    let rows;
    try {
      rows = _bugReportsStore.listPending({
        now: Date.now(),
        maxAttempts: 5,
        backoffBaseMs: 60_000,
        maxAgeMs: 30 * 86_400_000,
        limit: 10,
      });
    } catch (err) {
      log('bug-report sync: listPending failed:', (err && err.message) || err);
      return counts;
    }
    for (const report of rows) {
      counts.attempted += 1;
      // syncReportToRelay never throws and records the outcome on the row.
      const summary = await _bugReportConfig.syncReportToRelay(report, {
        relayUrl: cfg.relayUrl,
        timeoutMs: _bugReportConfig.RELAY_TIMEOUT_MS,
        markSynced: (id, meta) => _bugReportsStore.markSynced(id, meta),
        markFailed: (id, meta) => _bugReportsStore.markFailed(id, meta),
      });
      if (summary.state === 'synced') counts.succeeded += 1;
      else if (summary.state === 'failed') counts.failed += 1;
      // 'pending' (202 queued) counts as attempted only: the row stays
      // eligible so the next tick keeps polling the relay.
    }
    return counts;
  } finally {
    relaySyncBusy = false;
  }
}

// Platform foundation: /api/operations is the durable-operations surface
// defined in docs/roadmap/README.md. Mount it after the auth middleware
// so its handlers can read req.user.
app.use('/api/operations', operationsRouter());
app.use('/api/audit', auditRouter());
// Bug reports: mounted at /api WITHOUT active-server scoping. Reports belong
// to the panel and the reporter, never to a selected game server, so no
// X-Hostkind-Server-Id handling and no per-server capability gate applies.
// Auth is enforced by the /api middleware above; the router re-checks req.user
// so it stays safe if ever mounted elsewhere. The router itself is always
// available; its injected store/sync degrade gracefully while the core
// modules are not yet deployed.
app.use('/api', require('./lib/routes/bug-reports.cjs')({
  bugReports: {
    create: (input, opts) => {
      if (!loadBugReportCore()) throw new Error('bug report storage unavailable (modules not loaded)');
      return _bugReportsStore.create(input, opts);
    },
    get: (id) => (loadBugReportCore() ? _bugReportsStore.get(id) : undefined),
  },
  syncReport: syncBugReportNow,
  audit: foundationAudit,
  getConfig: () => config.bugReports || {},
  normalizeConfig: (input, env) => {
    if (!loadBugReportCore()) return { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'], mode: 'github', relayUrl: null, token: null, errors: ['sync_unavailable'] };
    return _bugReportConfig.normalizeConfig(input, env);
  },
  redactConfig: (cfg) => {
    if (!loadBugReportCore()) { const c = Object.assign({}, cfg); delete c.token; return c; }
    return _bugReportConfig.redactConfig(cfg);
  },
  saveConfig: (next) => {
    // Persist the block without any token key: rotation is environment-driven
    // and config files are commonly backed up. The token, when present, lives
    // in the process environment only.
    const block = Object.assign({}, next);
    delete block.token;
    delete block[_bugReportConfig ? _bugReportConfig.GITHUB_TOKEN_ENV : 'FLEETDECK_GITHUB_TOKEN'];
    // relayUrl is server config only (config.json): a browser PUT can never
    // introduce or change it. Always keep the value already loaded from the
    // config file and drop anything the browser tried to supply.
    const current = config.bugReports && typeof config.bugReports === 'object' && !Array.isArray(config.bugReports) ? config.bugReports : {};
    if (typeof current.relayUrl === 'string' && current.relayUrl.trim() !== '') {
      block.relayUrl = current.relayUrl;
    } else {
      delete block.relayUrl;
    }
    config.bugReports = block;
    saveConfig(config);
    rebuildBugReportWorker();
  },
  throttleLimits: { max: 5, windowMs: 60000 },
  panelVersion: () => PANEL_VERSION,
}));
app.use('/api/health', healthRouter({
  resolveServerId: (req) => req.get('X-Hostkind-Server-Id') || (req.query && req.query.serverId) || (req.body && req.body.serverId) || config.activeServerId || null,
  knownServer: (id) => !!findServer(id),
}));

// World operations (docs/roadmap/08-world-operations.md). The router owns its
// own capability checks and durable operations; what it needs from the panel is
// the server registry, the console, and the backup pipeline (a world archive is
// a restore point and gets the same manifest + verification as any other).
app.use('/api/worlds', worldsRouter({
  activeServerId: () => config.activeServerId || null,
  findServer,
  getManager,
  detectCompat,
  backupsDir,
  saveWorlds: (serverId, next) => {
    const server = findServer(serverId);
    if (!server) throw new Error('Server not found.');
    worlds.assertNoOverlap(next);
    server.worlds = next;
    saveConfig(config);
  },
  inspectBackup: (args) => recovery.inspect(args),
  verifyBackup: (args) => recovery.verify(args),
  recordProvenance: (args) => updateCenter.recordModrinth(args),
}));

/*
 * Terraria world operations (docs/terraria/03-worlds.md). A Terraria world is a
 * single file, so it gets its own router rather than a shim over the Minecraft
 * one; both go through the same durable-operations, snapshot and trash
 * primitives. The prefix middleware above has already established that the
 * target is a Terraria server.
 */
app.use('/api/terraria/worlds', terrariaWorldsRouter({
  activeServerId: () => config.activeServerId || null,
  findServer,
  getManager,
  allServers: () => config.servers || [],
  // The descriptor is the panel's half of a world selection; the other half is
  // the server's own serverconfig.txt, and the world module writes both.
  saveDescriptor: (serverId, fields) => {
    const server = findServer(serverId);
    if (!server) throw new Error('Server not found.');
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete server[key];
      else server[key] = value;
    }
    saveConfig(config);
  },
  // World-generation progress reaches every connected client the same way status
  // and console lines do.
  broadcast: (frame) => globalBroadcast(frame),
}));

/*
 * Valheim world operations (docs/valheim/03-worlds.md). A Valheim world is a
 * paired `.fwl`+`.db`, so it gets its own router too; selection is a single
 * descriptor field (`worldName`), not a second config file to keep in sync,
 * so the descriptor accessor below is simpler than Terraria's. The router's
 * own game-type check (`serverOf()`) gates the route, matching Terraria's
 * pattern of not adding a separate `/api/valheim` prefix guard.
 */
app.use('/api/valheim/worlds', valheimWorldsRouter({
  activeServerId: () => config.activeServerId || null,
  findServer,
  getManager,
  allServers: () => config.servers || [],
  saveDescriptor: (serverId, fields) => {
    const server = findServer(serverId);
    if (!server) throw new Error('Server not found.');
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete server[key];
      else server[key] = value;
    }
    saveConfig(config);
  },
}));

app.use('/api/terraria/mods', terrariaModsRouter({
  activeServerId: () => config.activeServerId || null,
  findServer,
  getManager,
  allServers: () => config.servers || [],
  cacheDir: () => INSTALLER_CACHE_DIR,
  download: downloadToFile,
}));

app.use('/api/terraria/tshock', terrariaTshockRouter({
  activeServerId: () => config.activeServerId || null,
  findServer,
  getManager,
}));

async function prepareTemplateRuntime(destination, manifest) {
  const loader = String(manifest?.source?.loader || '').toLowerCase();
  const mcVersion = String(manifest?.source?.mcVersion || '');
  if (!SERVER_TYPES.includes(loader) || !mcVersion) {
    throw Object.assign(new Error('The template does not declare a supported runtime.'), { status: 400, code: 'runtime_missing' });
  }
  const resolved = await resolveServerJar(loader, mcVersion);
  const jarPath = path.join(destination, resolved.filename);
  await downloadToFile(resolved.url, jarPath, () => {});
  let jar = resolved.filename;
  let launchArgs = null;
  if (loader === 'forge' || loader === 'neoforge') {
    const major = requiredJavaMajor(mcVersion);
    const javaBin = resolveJavaForServer({ mcVersion }, major) || await ensureRuntime(major, () => {});
    await runForgeInstaller(destination, resolved.filename, loader === 'forge' ? 'Forge' : 'NeoForge', javaBin);
    const produced = findForgeLaunchTarget(destination, loader);
    if (!produced) throw Object.assign(new Error('The server runtime could not be prepared.'), { code: 'runtime_invalid' });
    jar = produced.jar;
    launchArgs = produced.launchArgs;
  }
  return { jar, launchArgs, loader, mcVersion };
}

/*
 * Registration is the last phase of an instantiate/clone and is compensated:
 * if writing config.json or spawning the manager fails, the registry goes back
 * to exactly what it was and the caller turns the operation into a recoverable
 * one (the promoted folder stays on disk).
 */
function registerTemplateServer({ name, dir, manifest, runtime }) {
  const entry = {
    id: genId(), name, dir, jar: runtime.jar, loader: runtime.loader,
    launchArgs: runtime.launchArgs, javaArgs: ['-Xmx4G', '-Xms4G'],
    mcVersion: runtime.mcVersion || manifest?.source?.mcVersion || '', stopTimeoutSeconds: 30,
    worlds: ['world', 'world_nether', 'world_the_end'],
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
  const oldActive = config.activeServerId;
  config.servers.push(entry);
  if (!config.activeServerId) config.activeServerId = entry.id;
  try { saveConfig(config); getManager(entry.id); }
  catch { config.servers = config.servers.filter((item) => item.id !== entry.id); config.activeServerId = oldActive; try { saveConfig(config); } catch (_) {} throw err; }
  return serverWithStatus(entry);
}

/*
 * Recovery path: the folder was promoted by an earlier operation but never
 * registered. Validate that it still looks like a server root, then register
 * the runtime that is already on disk - we do not download anything again.
 */
function registerExistingServer({ name, dir, manifest }) {
  if (!fs.existsSync(path.join(dir, 'server.properties'))) {
    throw Object.assign(new Error('That folder is not a valid server root.'), { status: 409, code: 'invalid_server_root' });
  }
  const loader = String(manifest?.source?.loader || '').toLowerCase();
  const produced = (loader === 'forge' || loader === 'neoforge') ? findForgeLaunchTarget(dir, loader) : null;
  const jar = produced ? produced.jar : fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.jar'));
  if (!jar) throw Object.assign(new Error('No server jar was found in that folder.'), { status: 409, code: 'runtime_missing' });
  return registerTemplateServer({
    name,
    dir,
    manifest,
    runtime: { jar, launchArgs: produced ? produced.launchArgs : null, loader: loader || null, mcVersion: manifest?.source?.mcVersion || '' },
  });
}

const templateDeps = {
  findServer,
  prepareRuntime: prepareTemplateRuntime,
  registerCreated: registerTemplateServer,
  registerExisting: registerExistingServer,
  recordProvenance: (args) => updateCenter.recordModrinth(args),
  isRegisteredDir: (dir) => config.servers.some((item) => path.resolve(item.dir) === path.resolve(dir)),
};

app.use('/api/templates', templatesRouter.router(templateDeps));
app.use('/api/servers', templatesRouter.cloneRouter(templateDeps));

// Foundation status: lightweight endpoint that reports the database path,
// applied migrations, and aggregate row counts. Useful for diagnosing
// "did the foundation actually boot?" without scraping logs.
app.get('/api/foundation/status', (req, res) => {
  const user = userFromToken((req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : (req.query.token || '')) || guestUser();
  if (!user || user.role !== 'admin') return res.status(403).json({ error: tErr(user, 'errors.forbidden') });
  res.json({ ok: true, foundation: foundationStatus() });
});

// --- users CRUD (any logged-in user can manage users) ---
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}
// Username rules: 1-32 chars, no leading/trailing whitespace, no '@' (so
// usernames can't be confused with emails on login). Letters, digits,
// dot, dash, underscore are fine.
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;

function validateIdentifier({ email, username }) {
  const e = email === undefined ? undefined : normalizeEmail(email);
  const u = username === undefined ? undefined : normalizeUsername(username);
  if (e === undefined || e === '') {
    // only fail if the caller tried to set email and it's malformed
  } else if (!e.includes('@')) {
    return { error: 'emailInvalid' };
  }
  if (u !== undefined && u !== '' && !USERNAME_RE.test(u)) {
    return { error: 'usernameInvalid' };
  }
  return { email: e, username: u };
}

app.get('/api/me', (req, res) => res.json({ ...publicUser(req.user), permissions: publicPermissions(req.user) }));

// Self-service profile edit. A user can change their own name, email, and
// username, but never their own role (that would let an operator promote
// themselves) and never another account.
app.put('/api/me', (req, res) => {
  const user = req.user;
  if (isGuestUser(user)) return res.status(400).json({ error: tErr(user, 'errors.guestAccount') });
  const { email, username, name } = req.body || {};
  if (email !== undefined) {
    const e = normalizeEmail(email);
    if (e && !e.includes('@')) return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
    if (e) {
      const clash = findUserByEmail(e);
      if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
    }
    user.email = e;
  }
  if (username !== undefined) {
    const u = normalizeUsername(username);
    if (u && !USERNAME_RE.test(u)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
    if (u) {
      const clash = findUserByUsername(u);
      if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
    }
    user.username = u;
  }
  if (!user.email && !user.username) {
    return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
  }
  if (name !== undefined) user.name = String(name || '').trim();
  saveConfig(config);
  res.json({ user: publicUser(user) });
});

// Self-service password change. Requires the current password, so a hijacked
// session (or a shoulder-surfer) can't silently swap it.
app.put('/api/me/password', (req, res) => {
  const user = req.user;
  if (isGuestUser(user)) return res.status(400).json({ error: tErr(user, 'errors.guestAccount') });
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return res.status(400).json({ error: tErr(req.user, 'errors.currentPasswordWrong') });
  }
  const pwIssue = passwordIssue(newPassword);
  if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
  user.passwordHash = hashPassword(newPassword);
  saveConfig(config);
  res.json({ ok: true });
});

// Manual language switch. The user can change it any time from the header.
app.put('/api/me/language', (req, res) => {
  if (isGuestUser(req.user)) return res.status(400).json({ error: tErr(req.user, 'errors.guestAccount') });
  const next = i18n.normalizeLang((req.body || {}).language);
  if (!i18n.SUPPORTED_LANGS.includes(next)) {
    return res.status(400).json({ error: tErr(req.user, 'errors.langInvalid') });
  }
  if (req.user.language !== next) {
    req.user.language = next;
    saveConfig(config);
  }
  res.json({ user: publicUser(req.user) });
});

function normalizeRole(role) {
  return role === 'operator' ? 'operator' : role === 'admin' ? 'admin' : null;
}

app.get('/api/users', (req, res) => {
  res.json({ users: (config.users || []).map((user) => ({ ...publicUser(user), permissions: publicPermissions(user) })) });
});

app.get('/api/users/:id/permissions', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
  res.json({
    permissions: publicPermissions(user),
    capabilities: {
      perServer: foundationCapabilities.perServerCapabilities(),
      global: foundationCapabilities.globalCapabilities(),
    },
  });
});

app.put('/api/users/:id/permissions', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
  if (user.role === 'admin') return res.status(400).json({ error: tErr(req.user, 'errors.adminPermissions') });
  try {
    const grants = foundationCapabilities.replaceForUser(user.id, req.body?.grants, req.user.id);
    res.json({ ok: true, permissions: { admin: false, grants: grants.map((grant) => ({ serverId: grant.server_id, capability: grant.capability })) } });
  } catch (err) {
    httpError(res, req, err, 400);
  }
});

app.post('/api/users', (req, res) => {
  const { email, username, name, password, role } = req.body || {};
  const v = validateIdentifier({ email, username });
  if (v.error === 'emailInvalid') return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
  if (v.error === 'usernameInvalid') return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
  if (!v.email && !v.username) return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
  const pwIssue = passwordIssue(password);
  if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
  if (v.email && findUserByEmail(v.email)) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
  if (v.username && findUserByUsername(v.username)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
  // New accounts default to operator (least privilege); an admin can grant the
  // admin role explicitly.
  const newRole = normalizeRole(role) || 'operator';
  const user = {
    id: genId(),
    email: v.email || '',
    username: v.username || '',
    name: String(name || '').trim(),
    role: newRole,
    passwordHash: hashPassword(password),
  };
  config.users.push(user);
  saveConfig(config);
  res.json({ user: publicUser(user) });
});

app.put('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
  const { email, username, name, password, role } = req.body || {};
  if (role !== undefined) {
    const r = normalizeRole(role);
    if (!r) return res.status(400).json({ error: tErr(req.user, 'errors.roleInvalid') });
    // Don't allow demoting the last remaining admin (would lock everyone out of
    // user management and global settings).
    if (user.role === 'admin' && r !== 'admin' && adminCount() <= 1) {
      return res.status(400).json({ error: tErr(req.user, 'errors.lastAdmin') });
    }
    user.role = r;
  }
  if (email !== undefined) {
    const e = normalizeEmail(email);
    if (e && !e.includes('@')) return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
    if (e) {
      const clash = findUserByEmail(e);
      if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
    }
    user.email = e;
  }
  if (username !== undefined) {
    const u = normalizeUsername(username);
    if (u && !USERNAME_RE.test(u)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
    if (u) {
      const clash = findUserByUsername(u);
      if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
    }
    user.username = u;
  }
  // Make sure the user still has at least one way to log in.
  if (!user.email && !user.username) {
    return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
  }
  if (name !== undefined) user.name = String(name || '').trim();
  if (password !== undefined && password !== '') {
    const pwIssue = passwordIssue(password);
    if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
    user.passwordHash = hashPassword(password);
  }
  saveConfig(config);
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
  if (config.users.length <= 1) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDeleteLastUser') });
  if (user.id === req.user.id) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDeleteSelf') });
  // Keep at least one admin alive.
  if (user.role === 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: tErr(req.user, 'errors.lastAdmin') });
  }
  config.users = config.users.filter((u) => u.id !== user.id);
  saveConfig(config);
  foundationCapabilities.deleteUserGrants(user.id);
  res.json({ ok: true });
});

// --- API keys ---------------------------------------------------------------
// Machine principals for provisioning: a billing system creating a server when
// an order is paid, and stopping it when it is not. All four routes are
// requireHuman - see the comment there for why a key may not manage keys.

app.get('/api/api-keys', requireHuman, (req, res) => {
  res.json({ keys: apiKeys.list(), roles: apiKeys.ROLES });
});

app.post('/api/api-keys', requireHuman, (req, res) => {
  const { name, role, expiresAt, grants } = req.body || {};
  if (!String(name || '').trim()) {
    return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyNameRequired') });
  }
  if (role !== undefined && !apiKeys.ROLES.includes(role)) {
    return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyRoleInvalid') });
  }
  // An expiry in the past would mint a key that is dead on arrival, which reads
  // as a silent failure to whoever pastes it into their billing system.
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyExpiryInvalid') });
  }

  let created;
  try {
    created = apiKeys.create({ name, role: role || 'operator', createdBy: req.user.id, expiresAt: expiresAt ?? null });
  } catch (err) {
    return httpError(res, req, err, 400);
  }

  // An operator-role key is useless without grants, so they are set in the same
  // request the key is created in - there is no window where a key exists with
  // permissions nobody chose.
  if (created.key.role !== 'admin' && Array.isArray(grants) && grants.length) {
    try {
      foundationCapabilities.replaceForUser(created.key.id, grants, req.user.id);
    } catch (err) {
      apiKeys.revoke(created.key.id, req.user.id);
      return httpError(res, req, err, 400);
    }
  }

  try {
    foundationAudit.record({
      actorId: req.user.id, actorUsername: req.user.username,
      action: 'apikey.create', targetType: 'api_key', targetId: created.key.id,
      outcome: 'success', metadata: { name: created.key.name, role: created.key.role },
    });
  } catch (err) { log('audit: api key creation capture failed:', err.message); }

  // The only time the plaintext exists outside the caller's memory.
  res.json({ key: created.key, token: created.token, permissions: publicKeyPermissions(created.key) });
});

app.get('/api/api-keys/:id/permissions', requireHuman, (req, res) => {
  const key = apiKeys.get(req.params.id);
  if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
  res.json({
    permissions: publicKeyPermissions(key),
    capabilities: {
      perServer: foundationCapabilities.perServerCapabilities(),
      global: foundationCapabilities.globalCapabilities(),
    },
  });
});

app.put('/api/api-keys/:id/permissions', requireHuman, (req, res) => {
  const key = apiKeys.get(req.params.id);
  if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
  if (key.revokedAt) return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyRevoked') });
  if (key.role === 'admin') return res.status(400).json({ error: tErr(req.user, 'errors.adminPermissions') });
  try {
    foundationCapabilities.replaceForUser(key.id, req.body?.grants, req.user.id);
    res.json({ ok: true, permissions: publicKeyPermissions(apiKeys.get(key.id)) });
  } catch (err) {
    httpError(res, req, err, 400);
  }
});

app.delete('/api/api-keys/:id', requireHuman, (req, res) => {
  const key = apiKeys.get(req.params.id);
  if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
  // Revoked rather than deleted: the row is what an audit trail dereferences
  // when it says which key did something six months ago.
  const revoked = apiKeys.revoke(key.id, req.user.id);
  if (revoked) {
    try {
      foundationAudit.record({
        actorId: req.user.id, actorUsername: req.user.username,
        action: 'apikey.revoke', targetType: 'api_key', targetId: key.id,
        outcome: 'success', metadata: { name: key.name },
      });
    } catch (err) { log('audit: api key revocation capture failed:', err.message); }
  }
  res.json({ ok: true, key: apiKeys.get(key.id) });
});

// --- config (without secrets) ---
function publicConfig() {
  const c = JSON.parse(JSON.stringify(config));
  delete c.password;
  delete c.jwtSecret;
  delete c.users;
  
  for (const server of c.servers || []) {
    delete server.adminPassword;
    delete server.palworldIntegrations;
  }
  delete c.palworldIntegrations;
  return c;
}

app.get('/api/config', (req, res) => res.json(publicConfig()));

// Update only the backup-retention settings. After saving, prune every
// server's existing backups so a newly-lowered limit takes effect right
// away (not just on the next backup).
app.put('/api/config/backups', requireAdmin, (req, res) => {
  const b = req.body || {};
  const toNonNegInt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  };
  const maxCount = toNonNegInt(b.maxCount);
  const maxSizeMB = toNonNegInt(b.maxSizeMB);
  if (maxCount === null || maxSizeMB === null) {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidBackupsConfig') });
  }
  if (!config.backups) config.backups = {};
  config.backups.maxCount = maxCount;
  config.backups.maxSizeMB = maxSizeMB;
  saveConfig(config);
  for (const s of config.servers) {
    try { pruneBackups(slugify(s.name)); } catch (_) { /* noop */ }
  }
  res.json({ ok: true, backups: config.backups });
});

// Turn password sign-in on or off (admin-only). While off, requests fall back
// to the synthetic guest admin (see authMiddleware), so the panel stays fully
// usable and the setting can be flipped back on at any time - including by an
// unsigned visitor, which is exactly what "off" means.
app.put('/api/config/auth', requireAdmin, (req, res) => {
  const { requireAuth } = req.body || {};
  if (typeof requireAuth !== 'boolean') {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidAuthConfig') });
  }
  config.requireAuth = requireAuth;
  saveConfig(config);
  log(`auth: sign-in ${requireAuth ? 'enabled' : 'disabled'} by ${req.user.username || req.user.id}`);
  res.json({ ok: true, requireAuth: config.requireAuth });
});

// The watchdog (crash-loop guard) is a panel-level switch; servers without
// their own watchdog block inherit it (ServerManager.watchdogCfg). Same
// admin-only contract as the other config writers, and the general audit
// middleware records every config PUT, so the change is traceable.
app.put('/api/config/watchdog', requireAdmin, (req, res) => {
  const b = req.body || {};
  const maxRestarts = Number(b.maxRestarts);
  const windowMinutes = Number(b.windowMinutes);
  if (!Number.isFinite(maxRestarts) || maxRestarts < 0 || maxRestarts > 1000) {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidWatchdogConfig') });
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 100000) {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidWatchdogConfig') });
  }
  config.watchdog = {
    enabled: b.enabled === true,
    maxRestarts: Math.floor(maxRestarts),
    windowMinutes: Math.floor(windowMinutes),
  };
  saveConfig(config);
  log(`watchdog: ${config.watchdog.enabled ? 'enabled' : 'disabled'} by ${req.user.username || req.user.id} (max ${config.watchdog.maxRestarts} / ${config.watchdog.windowMinutes}m)`);
  res.json({ ok: true, watchdog: config.watchdog });
});

app.put('/api/config/game-accents', requireAdmin, (req, res) => {
  config.gameAccents = branding.normalizeGameAccents(req.body?.accents);
  saveConfig(config);
  log(`game accents updated by ${req.user.username || req.user.id}`);
  res.json({
    ok: true,
    gameAccents: config.gameAccents,
    gameThemes: branding.resolveGameAccents(config),
  });
});

// ---------------------------------------------------------------------------
// Filesystem browser (for registering a server)
// ---------------------------------------------------------------------------

// The "roots" shown when the folder browser is at the top level. On Windows
// these are the drive letters (C:\, D:\, ...). On POSIX there are no drive
// letters, so we offer the user's home folder and the filesystem root as
// jumping-off points; navigation from there walks the tree normally.
function listDrives() {
  if (process.platform === 'win32') {
    const drives = [];
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const root = `${c}:\\`;
      try {
        fs.accessSync(root);
        drives.push(root);
      } catch (_) { /* not present */ }
    }
    return drives;
  }
  const roots = [];
  const home = os.homedir();
  if (home && home !== '/') roots.push(home);
  roots.push('/');
  return roots;
}

app.get('/api/fs', requireAdmin, (req, res) => {
  const requestedPath = req.query.path;
  if (requestedPath !== undefined && typeof requestedPath !== 'string') {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
  const p = (requestedPath || '').trim();
  try {
    if (!p) {
      return res.json({ path: '', parent: null, drives: listDrives(), dirs: [], jars: [], sep: path.sep });
    }
    const abs = path.resolve(p);
    const allowedRoot = listDrives()
      .map((root) => path.resolve(root))
      .find((root) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
    if (!allowedRoot) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    let entries;
    if (abs.startsWith(allowedRoot)) entries = fs.readdirSync(abs, { withFileTypes: true });
    else return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const dirs = [];
    const jars = [];
    for (const e of entries) {
      try {
        if (e.isDirectory()) dirs.push(e.name);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.jar')) jars.push(e.name);
      } catch (_) { /* skip unreadable entry */ }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    jars.sort((a, b) => a.localeCompare(b));
    const parentCandidate = path.dirname(abs);
    const parent = parentCandidate === abs ? '' : parentCandidate; // '' => back to drive list
    res.json({ path: abs, parent, drives: [], dirs, jars, sep: path.sep });
  } catch (err) {
    httpError(res, req, err, 400);
  }
});
// ---------------------------------------------------------------------------
// Native folder picker - pops the real OS folder dialog (Windows Explorer /
// Linux zenity / macOS Finder) and returns the chosen absolute path. The
// in-browser custom folder browser is still used for "Register server" but
// the "Create a new server" flow uses this so the user gets the familiar
// native dialog. The implementation lives in lib/folderPicker.cjs: it spawns
// asynchronously (the panel stays responsive while the dialog is open),
// compiles the Windows dialog's C# helper once and caches the DLL, and
// refuses a second dialog (409) while one is already open.
// ---------------------------------------------------------------------------

app.get('/api/pick-folder', async (req, res) => {
  const def = String(req.query.defaultPath || '').trim();
  const title = String(req.query.title || 'Select the parent folder for the new server').trim().slice(0, 100);
  try {
    const result = await pickFolder(def, title);
    if (res.destroyed) return;
    if (result.cancelled) return res.json({ path: null, cancelled: true });
    if (!fs.existsSync(result.path) || !fs.statSync(result.path).isDirectory()) {
      return res.status(400).json({ error: `Picked path is not a folder: ${result.path}` });
    }
    return res.json({ path: result.path });
  } catch (err) {
    if (res.destroyed) return;
    if (err.code === PICKER_BUSY) {
      return res.status(409).json({ error: tErr(req.user, 'errors.pickFolderBusy') });
    }
    log('pick-folder error:', err.message);
    // The dialog never came back and was killed. Answering is the point: the
    // caller's Browse button is disabled until this request resolves, and it
    // falls back to the in-panel folder browser on any error.
    if (err.code === PICKER_TIMEOUT) {
      return res.status(504).json({ error: tErr(req.user, 'errors.pickFolderTimeout') });
    }
    if (err.code === PICKER_UNAVAILABLE) {
      return res.status(500).json({ error: tErr(req.user, 'errors.pickFolderUnavailable', { error: sanitizeErrorMessage(err.message) }) });
    }
    return httpError(res, req, err, 500);
  }
});

// ---------------------------------------------------------------------------
// Servers registry (register / edit / delete / control)
// ---------------------------------------------------------------------------

// True if the server has been started at least once. The Minecraft server
// always writes `server.properties` on its first run (along with the world
// folder, plugin/mod folders for paper/spigot, etc.), so its presence is the
// canonical "vanilla structure has been generated" signal we use to warn the
// user away from modding before a first start.
function hasGeneratedContent(s) {
  if (!s || !s.dir) return false;
  if (s.hasStarted) return true;
  try {
    return fs.existsSync(path.join(s.dir, 'server.properties'));
  } catch (_) {
    return false;
  }
}

function markServerStarted(id) {
  const s = findServer(id);
  if (!s || s.hasStarted) return;
  s.hasStarted = true;
  saveConfig(config);
  globalBroadcast({ type: 'server', server: serverWithStatus(s) });
}

// The stored variant, or null when it is missing/unrecognized. Never guessed:
// a null here is what makes the UI say "unknown" instead of showing vanilla's
// tools over a tModLoader install.
function terrariaVariantOf(s) {
  try { return terrariaVariants.resolveVariant(s); } catch (_) { return null; }
}

function serverWithStatus(s) {
  const m = getManager(s.id);
  const payload = {
    id: s.id,
    type: s.type || 'minecraft',
    name: s.name,
    dir: s.dir,
    // Launch commands, executable paths, and arguments are intentionally
    // internal. The UI only needs the installation folder and safe settings.
    stopCommand: s.stopCommand,
    stopSignal: s.stopSignal,
    healthCheckRegex: s.healthCheckRegex,
    jar: s.jar,
    loader: s.loader || '',
    mcVersion: s.mcVersion,
    worlds: s.worlds,
    watchdog: s.watchdog,
    mapUrl: s.mapUrl || '',
    // Terraria's feature set depends on its variant, so the UI gates views on
    // the server's own capabilities rather than on the game type's.
    capabilities: moduleCapabilitiesFor(s),
  };
  if (s.type === 'terraria') payload.terrariaVariant = terrariaVariantOf(s);
  Object.assign(payload, {
    active: s.id === config.activeServerId,
    hasStarted: !!s.hasStarted,
    hasGenerated: hasGeneratedContent(s),
    status: m.statusPayload(),
  });
  return payload;
}

app.get('/api/servers', (req, res) => {
  // SERVER_REGISTER is not grantable at NULL scope, so gating the list on it
  // left an operator who holds per-server grants unable to see the fleet at
  // all. They see exactly the servers they have a per-server grant on; admins
  // (and the guest identity) pass hasAnyPerServerGrant unconditionally.
  res.json({
    activeServerId: config.activeServerId,
    servers: config.servers.filter((s) => foundationCapabilities.hasAnyPerServerGrant(req.user, s.id)).map(serverWithStatus),
  });
});

// Rebase a path that lived under `from` onto `to`. Anything outside `from`
// (or not a path at all) is returned untouched, so launch arguments that are
// plain flags survive a folder move unchanged.
function rebasePath(p, from, to) {
  if (typeof p !== 'string' || !p || !from) return p;
  const rel = path.relative(from, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return path.join(to, rel);
}

// `existing` is the registry entry being edited (null when registering a new
// one). Only Minecraft servers are jar-launched: every other game type is
// installed by the panel with its own executable/args, and its gameplay
// settings live in the game's own config files - so editing one only touches
// the panel-side fields (name + install folder).
function validateServerInput(body, user, existing = null) {
  const name = String(body.name || '').trim();
  const dir = String(body.dir || '').trim();
  let jar = String(body.jar || '').trim();
  if (!name) return { error: eKey('errors.nameRequired') };
  if (name.length > SERVER_NAME_MAX_LENGTH) return { error: eKey('errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) };
  if (!dir) return { error: eKey('errors.folderRequired') };
  if (!fs.existsSync(dir)) return { error: eKey('errors.folderDoesNotExist', { path: dir }) };
  if (!fs.statSync(dir).isDirectory()) return { error: eKey('errors.notAFolder') };
  const type = (existing && existing.type) || 'minecraft';
  if (type !== 'minecraft') {
    const value = { name, dir };
    // The folder moved: point the stored launch command at the new location.
    if (existing.dir && path.resolve(existing.dir) !== path.resolve(dir)) {
      const from = existing.dir;
      value.executable = rebasePath(existing.executable, from, dir);
      value.cwd = rebasePath(existing.cwd, from, dir);
      if (Array.isArray(existing.args)) value.args = existing.args.map((a) => rebasePath(a, from, dir));
    }
    return { value };
  }
  // Auto-detect the jar if not supplied and exactly one exists.
  if (!jar) {
    const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
    if (jars.length === 1) jar = jars[0];
    else if (jars.length === 0) return { error: eKey('errors.noJar') };
    else return { error: eKey('errors.multipleJars') };
  } else if (!fs.existsSync(path.join(dir, jar))) {
    return { error: eKey('errors.jarNotFound', { name: jar }) };
  }
  let javaArgs = body.javaArgs;
  if (typeof javaArgs === 'string') {
    javaArgs = javaArgs.trim().split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(javaArgs) || !javaArgs.length) javaArgs = ['-Xmx2G', '-Xms2G'];
  let worlds = body.worlds;
  if (typeof worlds === 'string') worlds = worlds.split(',').map((w) => w.trim()).filter(Boolean);
  if (!Array.isArray(worlds) || !worlds.length) worlds = ['world', 'world_nether', 'world_the_end'];
  const mapUrl = normalizeMapUrl(body.mapUrl);
  if (mapUrl === null) return { error: eKey('errors.invalidMapUrl') };
  return {
    value: {
      name,
      dir,
      jar,
      javaArgs,
      worlds,
      mcVersion: String(body.mcVersion || '').trim(),
      stopTimeoutSeconds: Number(body.stopTimeoutSeconds) || 30,
      mapUrl,
    },
  };
}

// Accept an empty string (clears the map) or a http(s) URL. Returns the
// normalized URL, or null if the input is non-empty but not a valid URL.
function normalizeMapUrl(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

app.post('/api/servers', requireAdmin, (req, res) => {
  const v = validateServerInput(req.body || {}, req.user);
  if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
  const entry = {
    id: genId(),
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    ...v.value,
  };
  config.servers.push(entry);
  if (!config.activeServerId) config.activeServerId = entry.id;
  saveConfig(config);
  getManager(entry.id);
  addNotification('server_added', 'Server Registered', `Server "${entry.name}" has been registered.`, entry.id);
  res.json({ ok: true, server: serverWithStatus(entry) });
});

app.put('/api/servers/:id', requireAdmin, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  const m = getManager(s.id);
  if (m.isRunning()) return res.status(409).json({ error: tErr(req.user, 'errors.stopBeforeEdit') });
  const v = validateServerInput(req.body || {}, req.user, s);
  if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
  Object.assign(s, v.value);
  if (req.body.watchdog && typeof req.body.watchdog === 'object' && !Array.isArray(req.body.watchdog)) {
    s.watchdog = {
      enabled: !!req.body.watchdog.enabled,
      maxRestarts: Number(req.body.watchdog.maxRestarts) || 3,
      windowMinutes: Number(req.body.watchdog.windowMinutes) || 10,
    };
  }
  saveConfig(config);
  res.json({ ok: true, server: serverWithStatus(s) });
});

// Update only the map URL for a server. The map URL is a panel-UI concern
// (it's just a link to the web map the user wants to embed) so it can be
// changed while the Minecraft server is running - unlike the rest of the
// server settings, which require the server to be stopped.
app.put('/api/servers/:id/map', requireAdmin, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  const mapUrl = normalizeMapUrl((req.body || {}).mapUrl);
  if (mapUrl === null) return res.status(400).json({ error: tErr(req.user, 'errors.invalidMapUrl') });
  s.mapUrl = mapUrl;
  saveConfig(config);
  globalBroadcast({ type: 'server', server: serverWithStatus(s) });
  res.json({ ok: true, server: serverWithStatus(s) });
});

app.delete('/api/servers/:id', requireAdmin, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  const m = getManager(s.id);
  if (m.isRunning()) return res.status(409).json({ error: tErr(req.user, 'errors.stopBeforeRemove') });
  // Two separate decisions, two separate audit actions: removing the profile
  // from Hostkind, and moving the server files to trash. `files=trash` is the
  // only value that touches the disk, and it is recoverable - the legacy
  // deleteFiles flag now means the same thing rather than deleting permanently.
  const filesMode = String(req.query.files || '').toLowerCase() === 'trash'
    || req.query.deleteFiles === 'true' || req.query.deleteFiles === '1'
    ? 'trash'
    : 'keep';
  let trashed = null;
  let trashError = null;
  if (filesMode === 'trash' && s.dir) {
    try {
      trashed = trash.moveToTrash({
        target: s.dir,
        kind: 'server-files',
        serverId: s.id,
        label: s.name,
        reason: 'Server removed from Hostkind',
        actorId: req.user.id,
        servers: config.servers,
        selfId: s.id,
      });
    } catch (error) {
      // A failed recoverable delete never becomes a permanent one: the profile
      // stays registered so the operator can retry or fix the cause.
      trashError = error;
    }
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: s.id,
      action: 'server.files.trash',
      targetType: 'server-files',
      targetId: s.id,
      outcome: trashed ? 'success' : 'failure',
      requestId: req.requestId,
      metadata: trashed
        ? { trashId: trashed.id, location: trashed.location, expiresAt: trashed.expiresAt, fileCount: trashed.fileCount }
        : { code: trashError?.code || 'trash_failed' },
    });
    if (!trashed) {
      return res.status(Number(trashError?.status) || 500).json({
        error: trashError?.message || 'The server files could not be moved to trash.',
        code: trashError?.code || 'trash_failed',
      });
    }
  }
  config.servers = config.servers.filter((x) => x.id !== s.id);
  foundationCapabilities.deleteServerGrants(s.id);
  try { health.deleteServerData(s.id); } catch (err) { log('health: cleanup failed for', s.id, err.message); }
  managers.delete(s.id);
  if (config.activeServerId === s.id) {
    config.activeServerId = config.servers.length ? config.servers[0].id : null;
  }
  saveConfig(config);
  try { serverPresentation.reset(s.id); } catch (err) { log('presentation: cleanup failed for', s.id, err.message); }
  const filesDeleted = !!trashed;
  foundationAudit.record({
    actorId: req.user.id,
    actorUsername: req.user.username,
    serverId: s.id,
    action: 'server.remove',
    targetType: 'server',
    targetId: s.id,
    outcome: 'success',
    requestId: req.requestId,
    metadata: { filesMode },
  });
  addNotification(
    'server_removed',
    'Server Removed',
    `Server "${s.name}" has been removed${filesDeleted ? ' along with its files' : ''}.`,
    s.id,
    {
      titleKey: 'notifications.serverRemovedTitle',
      messageKey: filesDeleted ? 'notifications.serverRemovedWithFilesMessage' : 'notifications.serverRemovedMessage',
      messageVars: { name: s.name },
    }
  );
  res.json({
    ok: true,
    activeServerId: config.activeServerId,
    filesDeleted,
    trash: trashed
      ? { id: trashed.id, expiresAt: trashed.expiresAt, restorable: trashed.restorable, location: trashed.location }
      : null,
  });
});

// --- Recoverable deletion (docs/palworld/07-portability-safety.md) ----------
//
// Trashed files stay restorable until their retention expires or someone
// explicitly purges them. Nothing in this section deletes as a side effect.

app.get('/api/trash', (req, res) => {
  res.json({
    ok: true,
    osTrash: trash.detectOsTrash(),
    retentionDays: trash.DEFAULT_RETENTION_DAYS,
    entries: trash.list({ serverId: req.query.serverId || null, kind: req.query.kind || null }),
  });
});

app.post('/api/trash/:id/restore', requireAdmin, (req, res) => {
  try {
    const result = trash.restore(req.params.id, { servers: config.servers });
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: result.entry?.serverId || null,
      action: 'trash.restore',
      targetType: 'trash-entry',
      targetId: req.params.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { restoredTo: result.restoredTo },
    });
    res.json(result);
  } catch (error) { sendPortabilityError(res, error); }
});

// Permanent and irreversible, and only ever reached by asking for it directly.
app.delete('/api/trash/:id', requireAdmin, (req, res) => {
  try {
    const entry = trash.get(req.params.id);
    const result = trash.purge(req.params.id);
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: entry?.serverId || null,
      action: 'trash.purge',
      targetType: 'trash-entry',
      targetId: req.params.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { label: entry?.label || null, permanent: true },
    });
    res.json(result);
  } catch (error) { sendPortabilityError(res, error); }
});

// --- Panel-only server presentation ----------------------------------------

const presentationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
});

app.get('/api/servers/:id/presentation', (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  res.json(serverPresentation.get(s.id));
});

app.get('/api/servers/:id/presentation/:kind/image', (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  try {
    const asset = serverPresentation.assetFile(s.id, req.params.kind);
    res.type(asset.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(asset.file);
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/servers/:id/presentation/:kind', requireAdmin, presentationUpload.single('image'), (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  if (!req.file) return res.status(400).json({ error: 'An image file is required.', code: 'empty_upload' });
  try {
    res.json(serverPresentation.setAsset({ serverId: s.id, kind: req.params.kind, buffer: req.file.buffer }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.delete('/api/servers/:id/presentation/:kind', requireAdmin, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  try {
    res.json(req.params.kind === 'all'
      ? serverPresentation.reset(s.id)
      : serverPresentation.clearAsset({ serverId: s.id, kind: req.params.kind }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.put('/api/servers/:id/presentation/accent', requireAdmin, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  try {
    res.json(serverPresentation.setAccent({ serverId: s.id, accent: req.body?.accent }));
  } catch (error) { sendPortabilityError(res, error); }
});

app.post('/api/active', (req, res) => {
  const id = req.body && req.body.serverId;
  if (!findServer(id)) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  config.activeServerId = id;
  saveConfig(config);
  res.json({ ok: true, activeServerId: id });
});

app.post('/api/servers/:id/start', (req, res) => {
  const s = findServer(req.params.id);
  const r = localizeManagerResult(req, getManagerOr404(req, res, (m) => m.start()));
  if (r && r.ok) {
    addNotification('server_started', 'Server Started', `Server "${s.name}" has been started.`, s.id);
    notifyDiscord(s.id, 'start', `:green_circle: "${s.name}" was started.`);
  }
  res.json(r);
});
app.post('/api/servers/:id/stop', (req, res) => {
  const s = findServer(req.params.id);
  const r = localizeManagerResult(req, getManagerOr404(req, res, (m) => m.stop(req.body && req.body.force)));
  if (r && r.ok) {
    addNotification('server_stopped', 'Server Stopped', `Server "${s.name}" has been stopped.`, s.id);
    notifyDiscord(s.id, 'stop', `:black_circle: "${s.name}" was stopped.`);
  }
  res.json(r);
});
app.post('/api/servers/:id/restart', async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
  const r = await getManager(s.id).restart();
  if (r && r.ok) {
    addNotification('server_restarted', 'Server Restarted', `Server "${s.name}" has been restarted.`, s.id);
    notifyDiscord(s.id, 'restart', `:arrows_counterclockwise: "${s.name}" was restarted.`);
  }
  res.json(localizeManagerResult(req, r));
});

function getManagerOr404(req, res, fn) {
  const s = findServer(req.params.id);
  if (!s) { res.status(404); return { error: eKey('errors.serverNotFound') }; }
  return fn(getManager(s.id));
}

// Translate the manager-shaped result ({ ok, error }) and 4xx the failure.
function localizeManagerResult(req, r) {
  if (!r || r.ok) return r;
  return { ok: false, error: localizeErr(req.user, r.error) };
}

// --- server status / actions (active server, legacy-compatible) ---
app.get('/api/status', (req, res) => {
  const m = targetManager(req);
  res.json(m ? m.statusPayload() : { status: 'offline', serverId: null });
});

app.post('/api/server/start', (req, res) => {
  const m = targetManager(req);
  const result = localizeManagerResult(req, m ? m.start() : { ok: false, error: eKey('errors.noActiveServer') });
  if (result?.ok && m) notifyDiscord(m.id, 'start', `:green_circle: "${m.name()}" was started.`);
  res.json(result);
});
app.post('/api/server/stop', (req, res) => {
  const m = targetManager(req);
  const result = localizeManagerResult(req, m ? m.stop(req.body && req.body.force) : { ok: false, error: eKey('errors.noActiveServer') });
  if (result?.ok && m) notifyDiscord(m.id, 'stop', `:black_circle: "${m.name()}" was stopped.`);
  res.json(result);
});
app.post('/api/server/restart', async (req, res) => {
  const m = targetManager(req);
  const result = localizeManagerResult(req, m ? await m.restart() : { ok: false, error: eKey('errors.noActiveServer') });
  if (result?.ok && m) notifyDiscord(m.id, 'restart', `:arrows_counterclockwise: "${m.name()}" was restarted.`);
  res.json(result);
});

/*
 * Console command (docs/terraria/02-lifecycle-console.md step 5).
 *
 * The console is the console: there is no Hostkind allowlist of commands,
 * because the `commands.run` capability is the control. What is enforced is
 * that one request is one command - a newline in the text would run a second
 * command on the same authorization and put an unaudited line in the console -
 * and that the request is recorded with the actor who made it.
 */
const MAX_COMMAND_LENGTH = 512;

app.post('/api/command', (req, res) => {
  const raw = req.body && req.body.cmd;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingCmd') });
  if (/[\r\n\u0000]/.test(raw)) return res.status(400).json({ error: tErr(req.user, 'errors.commandNotSingleLine') });
  const cmd = raw.trim();
  if (!cmd) return res.status(400).json({ error: tErr(req.user, 'errors.missingCmd') });
  if (cmd.length > MAX_COMMAND_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.commandTooLong') });
  const m = targetManager(req);
  const result = localizeManagerResult(req, m ? m.sendCommand(cmd) : { ok: false, error: eKey('errors.noActiveServer') });
  // The command text is redacted by lib/audit.cjs before it is stored, so a
  // `password <secret>` typed at a Terraria console does not become an audit
  // record of the password.
  foundationAudit.record({
    actorId: req.user.id,
    actorUsername: req.user.username,
    serverId: m ? m.id : null,
    action: 'console.command',
    targetType: 'server',
    targetId: m ? m.id : null,
    outcome: result && result.ok ? 'success' : 'failure',
    requestId: req.requestId,
    metadata: { command: cmd },
  });
  res.json(result);
});

// --- players ---
app.get('/api/players', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.json({ players: [], max: 0 });
  const st = m.moduleState || {};
  res.json({ players: [...(st.players || [])].sort(), max: st.maxPlayers || 0 });
});

app.post('/api/players/:action', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidName') });
  const map = {
    kick: `kick ${name}`,
    ban: `ban ${name}`,
    pardon: `pardon ${name}`,
    op: `op ${name}`,
    deop: `deop ${name}`,
    'whitelist-add': `whitelist add ${name}`,
    'whitelist-remove': `whitelist remove ${name}`,
  };
  const cmd = map[req.params.action];
  if (!cmd) return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
  const m = targetManager(req);
  res.json(localizeManagerResult(req, m ? m.sendCommand(cmd) : { ok: false, error: eKey('errors.noActiveServer') }));
});

// ---------------------------------------------------------------------------
// Player management (Crafty-style): whitelist / operators / banned players.
// Reads the server's JSON lists so they can be viewed even while offline; for
// add/remove it sends the in-game command when the server is running, and edits
// the files directly when it is offline.
// ---------------------------------------------------------------------------

function readJsonArray(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}
function writeJsonArray(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
}
function whitelistEnabled(dir) {
  try {
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    return /^white-list\s*=\s*true/m.test(props);
  } catch (_) { return false; }
}
// Read the bind host + port a Minecraft server will listen on, from
// server.properties. An empty server-ip means "all interfaces". Falls back to
// :25565 (Minecraft's default) when the file or keys are missing.
function readServerBind(dir) {
  let host = '';
  let port = 25565;
  try {
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const ip = props.match(/^server-ip\s*=\s*(.*)$/m);
    if (ip && ip[1].trim()) host = ip[1].trim();
    const p = props.match(/^server-port\s*=\s*(\d+)/m);
    if (p) port = parseInt(p[1], 10) || 25565;
  } catch (_) { /* keep defaults */ }
  return { host, port };
}
// Best-effort, cross-platform check for whether a TCP port is already bound
// (no external tools): try to listen on it ourselves — EADDRINUSE means
// something else already holds it. Any other outcome is treated as "free" so a
// probe failure never blocks a legitimate start.
function probePortInUse(port, host) {
  // An empty server-ip means Minecraft binds the IPv4 wildcard, so probe that
  // explicitly. Omitting the host lets Node pick the IPv6 unspecified address,
  // which on hosts with net.ipv6.bindv6only=1 would NOT collide with an
  // IPv4-only server and give a false "free".
  const bindHost = host || '0.0.0.0';
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      const inUse = !!err && err.code === 'EADDRINUSE';
      tester.close(() => resolve(inUse));
    });
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, bindHost);
  });
}
// Look up a player's Mojang UUID (needed to add to files while offline, online-mode servers).
async function mojangUuid(name) {
  try {
    const d = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (d && d.id && d.id.length === 32) {
      return d.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    }
  } catch (_) {}
  return null;
}

// Players the server has seen recently (usercache.json), so they can be acted on
// by clicking instead of typing - even while offline. Drops expired entries and
// anyone already surfaced elsewhere (online / whitelist / ops / banned).
function readUserCache(dir, exclude) {
  const arr = readJsonArray(path.join(dir, 'usercache.json'));
  const now = Date.now();
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const name = x && x.name;
    if (!name || seen.has(name.toLowerCase())) continue;
    if (x.expiresOn) {
      const exp = Date.parse(x.expiresOn);
      if (!Number.isNaN(exp) && exp < now) continue;
    }
    if (exclude.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, uuid: x.uuid || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/playerlists', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.json({ online: [], whitelist: [], ops: [], banned: [], recent: [], whitelistEnabled: false, running: false });
  const d = m.dir();
  const wl = readJsonArray(path.join(d, 'whitelist.json')).map((x) => x.name).filter(Boolean);
  const ops = readJsonArray(path.join(d, 'ops.json')).map((x) => x.name).filter(Boolean);
  const banned = readJsonArray(path.join(d, 'banned-players.json')).map((x) => ({ name: x.name, reason: x.reason || '' })).filter((x) => x.name);
  const online = [...((m.moduleState && m.moduleState.players) || [])].sort((a, b) => a.localeCompare(b));
  const exclude = new Set([...online, ...wl, ...ops, ...banned.map((b) => b.name)].map((n) => n.toLowerCase()));
  res.json({
    online,
    whitelist: wl.sort((a, b) => a.localeCompare(b)),
    ops: ops.sort((a, b) => a.localeCompare(b)),
    banned,
    recent: readUserCache(d, exclude),
    whitelistEnabled: whitelistEnabled(d),
    running: m.isRunning(),
  });
});

// Validate a never-before-seen name against Mojang and return its head-ready
// canonical name + UUID, so the "add player" search can confirm before adding.
app.get('/api/players/lookup', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPlayerName') });
  try {
    const d = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (d && d.id && d.name) {
      const uuid = d.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      return res.json({ ok: true, name: d.name, uuid });
    }
    return res.status(404).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
  } catch (_) {
    return res.status(404).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
  }
});

// Toggle the whitelist on/off (sends command when running, edits server.properties when offline).
app.post('/api/whitelist/toggle', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const on = !!(req.body && req.body.enabled);
  if (m.isRunning()) return res.json(localizeManagerResult(req, m.sendCommand(`whitelist ${on ? 'on' : 'off'}`)));
  try {
    const file = path.join(m.dir(), 'server.properties');
    let props = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/^white-list\s*=.*/m.test(props)) props = props.replace(/^white-list\s*=.*/m, `white-list=${on}`);
    else props += `${props.endsWith('\n') || !props ? '' : '\n'}white-list=${on}\n`;
    fs.writeFileSync(file, props, 'utf8');
    res.json({ ok: true, note: 'Saved. Takes effect on next start.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/remove a player to/from a list, working both online and offline.
// kind: whitelist | op | ban ; op: add | remove
app.post('/api/playerlists/:kind/:op', async (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPlayerName') });
  const { kind, op } = req.params;
  if (!['whitelist', 'op', 'ban'].includes(kind) || !['add', 'remove'].includes(op)) {
    return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
  }
  // Optional free-text ban reason (only used when kind === 'ban' && op === 'add').
  const reason = (req.body && typeof req.body.reason === 'string' ? req.body.reason : '').trim().slice(0, 200);
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });

  // Online: let Minecraft do it (resolves UUIDs, applies immediately).
  if (m.isRunning()) {
    const cmds = {
      'whitelist:add': `whitelist add ${name}`, 'whitelist:remove': `whitelist remove ${name}`,
      'op:add': `op ${name}`, 'op:remove': `deop ${name}`,
      'ban:add': reason ? `ban ${name} ${reason}` : `ban ${name}`, 'ban:remove': `pardon ${name}`,
    };
    return res.json(localizeManagerResult(req, m.sendCommand(cmds[`${kind}:${op}`])));
  }

  // Offline: edit the JSON files directly.
  const d = m.dir();
  const files = { whitelist: 'whitelist.json', op: 'ops.json', ban: 'banned-players.json' };
  const file = path.join(d, files[kind]);
  try {
    if (op === 'remove') {
      const arr = readJsonArray(file);
      const next = arr.filter((x) => (x.name || '').toLowerCase() !== name.toLowerCase());
      writeJsonArray(file, next);
      return res.json({ ok: true, note: 'Updated (server offline).' });
    }
    // add → needs a UUID
    const uuid = await mojangUuid(name);
    if (!uuid) return res.status(400).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
    const arr = readJsonArray(file);
    if (arr.some((x) => (x.name || '').toLowerCase() === name.toLowerCase())) return res.json({ ok: true, note: 'Already listed.' });
    if (kind === 'whitelist') arr.push({ uuid, name });
    else if (kind === 'op') arr.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
    else if (kind === 'ban') arr.push({ uuid, name, created: new Date().toISOString(), source: 'Hostkind', expires: 'forever', reason: reason || 'Banned by an operator' });
    writeJsonArray(file, arr);
    return res.json({ ok: true, note: 'Updated (server offline).' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Metrics history (Crafty-style): per-server time series persisted to disk.
// Sampled once a minute: CPU %, memory (MB), players online, world size (MB).
// ---------------------------------------------------------------------------

const METRICS_PATH = path.join(__dirname, 'metrics.json');
const METRICS_INTERVAL_MS = 60 * 1000;          // sample every minute
const METRICS_RETAIN_MS = 7 * 24 * 3600 * 1000; // keep 7 days
const WORLD_SIZE_EVERY = 5;                      // recompute world size every ~5 samples

let metrics = {};            // { [serverId]: [ [t, cpu, memMB, players, worldMB], ... ] }
let metricsDirty = false;
let metricsTick = 0;
const worldSizeCache = {};   // { [serverId]: mb }

(function loadMetrics() {
  try { metrics = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8')) || {}; }
  catch { metrics = {}; }
})();

function saveMetrics() {
  if (!metricsDirty) return;
  try { fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics)); metricsDirty = false; }
  catch (e) { log('metrics save failed:', e.message); }
}

// Recursive directory size (iterative, with a safety guard against huge trees).
function dirSize(dir) {
  let total = 0, guard = 0;
  const stack = [dir];
  while (stack.length) {
    if (++guard > 400000) break;
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch (_) { /* noop */ } }
    }
  }
  return total;
}
function worldSizeMB(m) {
  const desc = m.desc();
  if (!desc.dir || !fs.existsSync(desc.dir)) return 0;
  const worlds = (desc.worlds && desc.worlds.length) ? desc.worlds : ['world'];
  let bytes = 0;
  for (const w of worlds) {
    const wp = path.join(desc.dir, w);
    if (fs.existsSync(wp)) bytes += dirSize(wp);
  }
  return Math.round(bytes / 1048576);
}

// Capacity of the filesystem holding a server folder. statfs is not available
// on every mount (network shares, containers with restricted /proc), and the
// health analysis treats "we don't know" as a first-class answer, so a failure
// here yields nulls rather than zeros.
async function diskUsage(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    const totalMb = (st.blocks * st.bsize) / 1048576;
    const freeMb = (st.bfree * st.bsize) / 1048576;
    return { usedMb: totalMb - freeMb, totalMb };
  } catch (_) {
    return { usedMb: null, totalMb: null };
  }
}

async function sampleMetrics() {
  metricsTick++;
  const recomputeWorld = (metricsTick % WORLD_SIZE_EVERY) === 1;
  const now = Date.now();
  const systemTotalMb = os.totalmem() / 1048576;
  const systemFreeMb = os.freemem() / 1048576;
  for (const s of config.servers) {
    const m = getManager(s.id);
    let cpu = 0, memMB = 0, players = 0;
    const pid = m && m.isRunning() ? m.pid() : null;
    if (pid) {
      try {
        const u = await procUsage(pid);
        const cores = os.cpus().length || 1;
        cpu = Math.round(Math.min(100, (u ? u.cpu : 0) / cores));
        memMB = Math.round((u ? u.memory : 0) / 1048576);
      } catch (_) { /* process may have died */ }
      players = (m.moduleState && m.moduleState.players) ? m.moduleState.players.size : 0;
    }
    let worldMB = worldSizeCache[s.id] || 0;
    if (recomputeWorld) {
      try { worldMB = worldSizeMB(m); worldSizeCache[s.id] = worldMB; } catch (_) { /* noop */ }
    }
    const arr = metrics[s.id] || (metrics[s.id] = []);
    arr.push([now, cpu, memMB, players, worldMB]);
    const cutoff = now - METRICS_RETAIN_MS;
    let drop = 0;
    while (drop < arr.length && arr[drop][0] < cutoff) drop++;
    if (drop) arr.splice(0, drop);

    // Health and capacity: the same sample, plus the fields the analysis needs.
    // TPS is only meaningful while the server is up and reporting it; leaving it
    // null keeps a gap a gap instead of inventing a 20.0.
    const disk = s.dir ? await diskUsage(s.dir) : { usedMb: null, totalMb: null };
    try {
      health.recordSample({
        serverId: s.id, ts: now, cpu, memoryMb: memMB, players, worldMb: worldMB,
        online: !!pid,
        tps: pid && m.moduleState && m.moduleState.lastTps != null ? m.moduleState.lastTps : null,
        heapMb: health.parseHeapMb(s.javaArgs),
        diskUsedMb: disk.usedMb, diskTotalMb: disk.totalMb,
      });
      health.analyze(s.id, { systemTotalMb, systemFreeMb }, now);
    } catch (err) {
      // Analysis is advisory: a database problem must never disturb the panel
      // or the servers it supervises.
      log('health: sample/analysis failed for', s.id, err.message);
    }
  }
  for (const id of Object.keys(metrics)) {
    if (!config.servers.some((s) => s.id === id)) delete metrics[id];
  }
  metricsDirty = true;
}

setInterval(sampleMetrics, METRICS_INTERVAL_MS);
setTimeout(sampleMetrics, 4000); // first sample shortly after boot
setInterval(saveMetrics, 5 * 60 * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveMetrics(); process.exit(0); });

// Bounded database growth: fold aged-out raw samples into hourly rollups and
// drop what is past the retention horizon. Low priority - hourly, and a failure
// is logged and retried on the next tick.
function runMetricsRetention() {
  try { health.runRetention(); }
  catch (err) { log('health: retention failed:', err.message); }
}
setInterval(runMetricsRetention, 60 * 60 * 1000);
setTimeout(runMetricsRetention, 30 * 1000);

// Trash retention. Entries are purged only after their documented retention
// window; everything else stays restorable.
function runTrashRetention() {
  try {
    const purged = trash.sweep();
    if (purged.length) log(`trash: purged ${purged.length} expired entr${purged.length === 1 ? 'y' : 'ies'}`);
  } catch (err) { log('trash: retention failed:', err.message); }
}
setInterval(runTrashRetention, 6 * 60 * 60 * 1000);
setTimeout(runTrashRetention, 60 * 1000);

const METRICS_RANGES = { hour: 3600e3, '6h': 6 * 3600e3, day: 24 * 3600e3, week: 7 * 24 * 3600e3 };
function queueCrashCapture(payload, attempt = 0) {
  setImmediate(() => {
    try {
      const latest = (metrics[payload.serverId] || []).at(-1);
      const result = crashIntelligence.capture({ ...payload, recentMetrics: latest ? { ts: latest[0], cpu: latest[1], memoryMb: latest[2] } : null });
      globalBroadcast({ type: 'crash', serverId: payload.serverId, groupId: result.groupId, incidentId: result.incidentId });
    } catch (err) {
      log('Crash capture failed:', err.message);
      const manager = getManager(payload.serverId);
      if (manager) manager.pushLine('[Hostkind] Crash evidence could not be saved. Server supervision will continue.', 'warn');
      if (attempt < 2) setTimeout(() => queueCrashCapture(payload, attempt + 1), 1000 * (attempt + 1));
    }
  });
}

// Same contract as before (t/cpu/mem/players/world per point), now served from
// SQLite with a bounded time window and page size. The response carries the
// extra columns (tps, disk) too; older clients simply ignore them.
app.get('/api/metrics', (req, res) => {
  const id = (req.query.serverId) || config.activeServerId;
  const rangeKey = METRICS_RANGES[req.query.range] ? req.query.range : '6h';
  if (!id) return res.json({ serverId: id, range: rangeKey, points: [] });
  try {
    let points = health.querySamples(id, { since: Date.now() - METRICS_RANGES[rangeKey] });
    if (!moduleGate.supports(req, 'players')) {
      points = points.map(({ players, world, tps, ...point }) => point);
    }
    return res.json({ serverId: id, range: rangeKey, points });
  } catch (err) {
    log('metrics query failed:', err.message);
    return res.status(503).json({ error: 'Metrics history is unavailable.' });
  }
});

app.get('/api/crashes', (req, res) => {
  const acknowledged = req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined;
  const data = crashIntelligence.list({ cursor: Number(req.query.cursor) || undefined, serverId: req.query.serverId || config.activeServerId, acknowledged, from: Number(req.query.from) || undefined, to: Number(req.query.to) || undefined });
  res.json(data);
});
app.get('/api/crashes/:id', (req, res) => {
  const item = crashIntelligence.detail(req.params.id);
  if (!item) return res.status(404).json({ error: 'Crash group not found.' });
  res.json(item);
});
for (const [suffix, value] of [['acknowledge', true], ['unacknowledge', false]]) {
  app.post(`/api/crashes/groups/:id/${suffix}`, (req, res) => {
    const result = crashIntelligence.acknowledge(req.params.id, req.user.id, value);
    if (!result) return res.status(404).json({ error: 'Crash group not found.' });
    res.json({ ok: true, ...result });
  });
}

// --- addons (plugins + mods) ---
// Both kinds are just .jar files in a folder; `kind` picks which folder.
function addonKind(req) {
  const raw = (req.query && req.query.kind) || (req.body && req.body.kind) || 'plugins';
  return String(raw).toLowerCase() === 'mods' ? 'mods' : 'plugins';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const m = targetManager(req);
      if (!m) return cb(new Error('No active server.'));
      const dir = m.addonsDir(addonKind(req));
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* noop */ }
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.jar')) {
      return cb(new Error('Only .jar files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.get('/api/addons', (req, res) => {
  const kind = addonKind(req);
  const m = targetManager(req);
  if (!m) return res.json({ kind, addons: [] });
  try {
    const dir = m.addonsDir(kind);
    if (!fs.existsSync(dir)) return res.json({ kind, addons: [] });
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ kind, addons: files });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.post('/api/addons/upload', upload.single('addon'), (req, res) => {
  const m = targetManager(req);
  const label = addonKind(req) === 'mods' ? 'Mod' : 'Plugin';
  if (m && req.file && req.file.filename) {
    addNotification('plugin_uploaded', `${label} Uploaded`, `${label} "${req.file.filename}" uploaded to "${m.name()}". Restart the server to apply.`, m.id);
  }
  res.json({ ok: true, name: req.file && req.file.filename, note: 'Restart the server to apply.' });
}, (err, req, res, next) => {
  res.status(400).json({ error: tErr(req.user, err.message && err.message.includes('Only') ? 'errors.onlyJar' : 'errors.unknownAction') });
});

app.delete('/api/addons/:name', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const name = path.basename(req.params.name);
  if (!name.toLowerCase().endsWith('.jar')) return res.status(400).json({ error: tErr(req.user, 'errors.notAJar') });
  const full = path.join(m.addonsDir(addonKind(req)), name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: tErr(req.user, 'errors.fileDoesNotExist') });
  try {
    fs.unlinkSync(full);
    res.json({ ok: true, note: 'Restart the server to apply.' });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

// --- config editor ---
function editableFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const allowed = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')
        || lower.endsWith('.xml') || lower.endsWith('.json')
        || lower.endsWith('.properties')) {
      allowed.push(e.name);
    }
  }
  return allowed.sort();
}

function resolveEditable(dir, name) {
  const base = path.basename(name);
  const allowed = editableFiles(dir);
  if (!allowed.includes(base)) return null;
  return path.join(dir, base);
}

app.get('/api/configs', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.json({ files: [] });
  try {
    res.json({ files: editableFiles(m.dir()) });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.get('/api/configs/:name', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const full = resolveEditable(m.dir(), req.params.name);
  if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
  try {
    res.json({ name: path.basename(full), content: fs.readFileSync(full, 'utf8') });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.put('/api/configs/:name', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const full = resolveEditable(m.dir(), req.params.name);
  if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
  const content = req.body && req.body.content;
  if (typeof content !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingContent') });
  try {
    if (fs.existsSync(full)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(full, `${full}.${stamp}.bak`);
    }
    fs.writeFileSync(full, content, 'utf8');
    res.json({ ok: true, note: 'Saved. Restart the server to apply.' });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

// --- config .bak history (list + restore) ---------------------------------
// The PUT /api/configs/:name route above writes a timestamped .bak on every
// save. These two routes let the UI surface that history as a "History"
// dropdown and let the user roll back to any of those snapshots. Both are
// JWT-protected (via the /api middleware) and reuse resolveEditable so only
// allowlisted files can be snapshotted/restored. The restore endpoint writes
// a fresh .bak of the state it's about to overwrite, so the user can undo
// the restore itself.

const BAK_SUFFIX_RE = /\.[0-9TZ-]+\.bak$/i;

function bakStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

app.get('/api/configs/:name/backups', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const full = resolveEditable(m.dir(), req.params.name);
  if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
  try {
    const base = path.basename(full);
    const parentDir = path.dirname(full);
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const prefix = `${base}.`;
    const backups = entries
      .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith('.bak'))
      .map((e) => {
        const stamp = e.name.slice(prefix.length, -'.bak'.length);
        if (!BAK_SUFFIX_RE.test('.' + stamp)) return null;
        const fullPath = path.join(parentDir, e.name);
        let st;
        try { st = fs.statSync(fullPath); } catch (_) { return null; }
        return { name: e.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
      })
      .filter(Boolean)
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ ok: true, backups });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.post('/api/configs/:name/restore', (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const full = resolveEditable(m.dir(), req.params.name);
  if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
  const backupName = path.basename(String((req.body && req.body.backup) || ''));
  const base = path.basename(full);
  // Only allow backups of THIS file, with the matching "<base>.<stamp>.bak"
  // shape that PUT writes. Reject anything else (path traversal, foreign
  // files, oddly named snapshots). `path.basename` already strips any
  // directory part, so a request like ".." or "foo/../bar" can never reach
  // the disk.
  if (!backupName || !backupName.startsWith(`${base}.`) || !backupName.endsWith('.bak')
      || !BAK_SUFFIX_RE.test(backupName.slice(base.length))) {
    return res.status(400).json({ error: 'invalidBackup' });
  }
  const bakPath = path.join(path.dirname(full), backupName);
  if (!fs.existsSync(bakPath)) return res.status(404).json({ error: 'backupNotFound' });
  try {
    let content;
    if (fs.existsSync(full)) {
      // Snapshot the state we are about to overwrite so the user can undo
      // the restore itself (same .bak naming as the PUT route).
      const stamp = bakStamp();
      fs.copyFileSync(full, `${full}.${stamp}.bak`);
      content = fs.readFileSync(full, 'utf8');
    } else {
      content = '';
    }
    fs.copyFileSync(bakPath, full);
    res.json({ ok: true, content, note: 'Restored. Restart the server to apply.' });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

// --- backups ---
function ensureBackupsDir() {
  if (!fs.existsSync(backupsDir())) fs.mkdirSync(backupsDir(), { recursive: true });
}

function parseBackupName(f) {
  // <serverSlug>__<stamp>.zip ; older backups without "__" => server unknown
  const i = f.indexOf('__');
  return i === -1 ? { slug: '', label: f } : { slug: f.slice(0, i), label: f };
}

function listBackups() {
  ensureBackupsDir();
  return fs.readdirSync(backupsDir())
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => {
      const st = fs.statSync(path.join(backupsDir(), f));
      const meta = parseBackupName(f);
      const manifest = recovery.findManifest(f);
      return { name: f, size: st.size, mtime: st.mtimeMs, slug: meta.slug, manifest, ...recovery.summaries(manifest) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

let backupInProgress = false;

async function createBackup(m, { applyRetention = true, includeMods = false, offline = false } = {}) {
  if (!m || !m.dir()) throw new Error('No server selected.');
  if (backupInProgress) throw new Error('A backup is already in progress.');
  backupInProgress = true;
  ensureBackupsDir();
  const slug = slugify(m.name());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  const outName = `${slug}__${stamp}.zip`;
  const outPath = path.join(backupsDir(), outName);
  const wasOnline = m.status === STATUS.ONLINE;
  const mod = m.module();
  let selection = mod.backupSelection
    ? mod.backupSelection(m.desc(), { includeMods })
    : (m.desc().worlds || ['world', 'world_nether', 'world_the_end']);
  const worlds = selection;
  const shouldFlushWorlds = wasOnline && mod.id === 'minecraft';
  let moduleBackupState = null;
  let archiveError = null;
  let temporaryDir = null;
  const sourceOverrides = new Map();

  try {
    if (offline && wasOnline) {
      log(`Backup: stopping "${m.name()}" for an exact offline backup...`);
      const exited = m._waitForExit();
      const stopped = m.stop(false);
      if (!stopped || stopped.ok === false) throw new Error('The server could not be stopped for the backup.');
      await exited;
    }
    log(`Backup: "${m.name()}" -> ${outName} (worlds: ${worlds.join(', ')})`);
    if (shouldFlushWorlds) {
      // Avoid writes during the zip
      log('Backup: server online, flushing world saves (save-off + save-all flush)...');
      m.sendCommand('save-off');
      m.sendCommand('save-all flush');
      await new Promise((r) => setTimeout(r, 5000));
    } else if (mod.backupPrepare) {
      moduleBackupState = await mod.backupPrepare(m);
    }

    if (mod.id === 'terraria' && wasOnline && !offline && (m.desc().terrariaVariant || 'vanilla') === 'tshock') {
      const databases = selection.filter((item) => /\.(?:sqlite|db)$/i.test(item));
      if (databases.length) temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-tshock-backup-'));
      for (const item of databases) {
        try {
          const Database = require('better-sqlite3');
          const live = path.join(m.dir(), item);
          const copy = path.join(temporaryDir, path.basename(item));
          const db = new Database(live, { readonly: true, fileMustExist: true });
          try { await db.backup(copy); } finally { db.close(); }
          sourceOverrides.set(item, copy);
        } catch (error) {
          selection = selection.filter((entry) => entry !== item);
          moduleBackupState = {
            ...(moduleBackupState || {}),
            partial: true,
            reason: 'tshock_database_backup_failed',
          };
          log(`Backup: TShock database omitted because its online snapshot failed: ${error.message}`);
        }
      }
    }

    log('Backup: zipping worlds...');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const item of selection) {
        const source = sourceOverrides.get(item) || path.join(m.dir(), item);
        if (!fs.existsSync(source)) continue;
        const stat = fs.statSync(source);
        if (stat.isDirectory()) archive.directory(source, item === '.' ? false : item);
        else if (stat.isFile()) archive.file(source, { name: item.replace(/\\/g, '/') });
      }
      archive.finalize();
    });
  } catch (error) {
    archiveError = error;
    throw error;
  } finally {
    if (shouldFlushWorlds) m.sendCommand('save-on');
    if (mod.backupCleanup) await mod.backupCleanup(m, moduleBackupState, { ok: !archiveError, error: archiveError && archiveError.message });
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
    if (offline && wasOnline) {
      const started = m.start();
      if (!started || started.ok === false) {
        const restartError = new Error('The backup finished, but the server could not be restarted.');
        if (!archiveError) archiveError = restartError;
        m.pushLine(`[Hostkind] ${restartError.message}`, 'error');
      }
    }
    backupInProgress = false;
  }

  const st = fs.statSync(outPath);
  let world = null;
  if (mod.id === 'terraria' && m.desc().terrariaWorld && m.desc().terrariaWorld.file) {
    try {
      const terrariaWorlds = require('./lib/terraria-worlds.cjs');
      const absolute = path.join(m.dir(), m.desc().terrariaWorld.file);
      const header = terrariaWorlds.readHeaderOf(absolute);
      world = { file: m.desc().terrariaWorld.file, headerVersion: header.ok ? header.version : null };
    } catch (_) { world = { file: m.desc().terrariaWorld.file, headerVersion: null }; }
  }
  const metadata = mod.id === 'terraria' ? {
    game: 'terraria',
    variant: m.desc().terrariaVariant || 'vanilla',
    version: m.desc().terrariaVersion || null,
    world,
    online: wasOnline && !offline,
    exact: offline || !wasOnline,
    saveConfirmed: moduleBackupState ? moduleBackupState.saved === true : !wasOnline,
    partial: !!(moduleBackupState && (moduleBackupState.saved === false || moduleBackupState.partial)),
    reason: moduleBackupState && moduleBackupState.reason || null,
    includeMods: includeMods === true,
    selection,
  } : null;
  await recovery.inspect({
    file: outPath, filename: outName, serverId: m.id,
    worlds: [...new Set(selection.map((item) => item.split('/')[0]))],
    metadata,
  });
  if (applyRetention) pruneBackups(slug);
  log(`Backup: done -> ${outName} (${(st.size / 1048576).toFixed(1)} MB)`);
  m.pushLine(`[Hostkind] Backup created: ${outName} (${(st.size / 1048576).toFixed(1)} MB)`, 'info');
  addNotification('backup_created', 'Backup Created', `Backup "${outName}" created for server "${m.name()}" (${(st.size / 1048576).toFixed(1)} MB).`, m.id);
  notifyDiscord(m.id, 'backup', `:floppy_disk: Backup completed for "${m.name()}".`);
  if (archiveError) throw archiveError;
  return { name: outName, size: st.size, manifest: metadata };
}

// Enforce retention for one server's backups. Always keeps the newest
// (all[0]); deletes from the oldest end until both the count cap and the
// total-size cap are satisfied. A limit of 0 means "unlimited" (disabled).
function pruneBackups(slug) {
  const maxCount = Number(config.backups.maxCount) || 0;
  const maxSizeMB = Number(config.backups.maxSizeMB) || 0;
  if (maxCount <= 0 && maxSizeMB <= 0) return;
  const all = listBackups().filter((b) => b.slug === slug); // sorted by mtime desc
  if (all.length === 0) return;
  const toDelete = new Set();

  // 1) Count cap: keep the newest maxCount; flag the rest.
  if (maxCount > 0 && all.length > maxCount) {
    for (let i = maxCount; i < all.length; i++) toDelete.add(all[i].name);
  }

  // 2) Size cap: walk oldest-first (end of the list), deleting until the
  //    surviving backups' total size fits under the cap. Never delete the
  //    newest (index 0) - the just-created backup is always retained, even
  //    if on its own it's bigger than the cap (we'd rather keep one fresh
  //    backup than none).
  if (maxSizeMB > 0) {
    const maxBytes = maxSizeMB * 1024 * 1024;
    let total = all.reduce((s, b) => s + (toDelete.has(b.name) ? 0 : b.size), 0);
    for (let i = all.length - 1; i > 0 && total > maxBytes; i--) {
      const b = all[i];
      if (toDelete.has(b.name)) continue;
      toDelete.add(b.name);
      total -= b.size;
    }
  }

  for (const name of toDelete) {
    try {
      fs.unlinkSync(path.join(backupsDir(), name));
      log(`Old backup deleted by retention: ${name}`);
    } catch (_) { /* noop */ }
  }
}

const backupServerId = (req) => (targetManager(req) || {}).id;
function backupFile(name) {
  const safe = path.basename(name);
  if (safe !== name || !safe.toLowerCase().endsWith('.zip')) throw Object.assign(new Error('Invalid backup name.'), { status: 400 });
  const file = path.join(backupsDir(), safe);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Backup does not exist.'), { status: 404 });
  return { name: safe, file };
}
function recoveryArgs(req) {
  const m = targetManager(req); if (!m) throw Object.assign(new Error('No server selected.'), { status: 400 });
  const b = backupFile(req.params.name);
  const known = recovery.findManifest(b.name);
  const parsed = parseBackupName(b.name);
  if ((known && known.serverId !== m.id) || (!known && parsed.slug && parsed.slug !== slugify(m.name()))) {
    throw Object.assign(new Error('Backup does not belong to this server.'), { status: 404 });
  }
  const selection = m.module().backupSelection
    ? m.module().backupSelection(m.desc(), { includeMods: true })
    : (m.desc().worlds || ['world', 'world_nether', 'world_the_end']);
  const worlds = [...new Set(selection.map((item) => String(item).replace(/\\/g, '/').split('/')[0]).filter(Boolean))];
  return { ...b, filename: b.name, serverId: m.id, worlds, createdAt: fs.statSync(b.file).mtimeMs, m };
}

app.get('/api/backups', requireCap(CAPABILITIES.BACKUPS_VIEW, { getServerId: backupServerId }), (req, res) => {
  try {
    const m = targetManager(req);
    let modsSizeBytes = 0;
    if (m.module().id === 'terraria' && m.desc().terrariaVariant === 'tmodloader') {
      const base = m.module().backupSelection(m.desc(), { includeMods: false });
      const full = m.module().backupSelection(m.desc(), { includeMods: true });
      for (const item of full.filter((entry) => !base.includes(entry) && /\.tmod$/i.test(entry))) {
        try { modsSizeBytes += fs.statSync(path.join(m.dir(), item)).size; } catch (_) { /* vanished */ }
      }
    }
    res.json({
      backups: listBackups().filter((b) => (b.manifest ? b.manifest.serverId === m.id : b.slug === slugify(m.name()))),
      options: {
        terraria: m.module().id === 'terraria',
        variant: m.desc().terrariaVariant || null,
        includeMods: !!m.desc().backups?.includeMods,
        modsSizeBytes,
      },
    });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.post('/api/backups', requireCap(CAPABILITIES.BACKUPS_CREATE, { getServerId: backupServerId }), async (req, res) => {
  try {
    const r = await createBackup(targetManager(req), {
      includeMods: req.body && typeof req.body.includeMods === 'boolean'
        ? req.body.includeMods
        : !!targetManager(req).desc().backups?.includeMods,
      offline: req.body && req.body.offline === true,
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.put('/api/backups/options', requireCap(CAPABILITIES.BACKUPS_CREATE, { getServerId: backupServerId }), (req, res) => {
  try {
    const m = targetManager(req);
    if (!m || m.module().id !== 'terraria') return res.status(400).json({ error: 'Backup options are only available for Terraria servers.' });
    const server = findServer(m.id);
    server.backups = { ...(server.backups || {}), includeMods: req.body && req.body.includeMods === true };
    saveConfig(config);
    res.json({ ok: true, backups: server.backups });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.delete('/api/backups/:name', requireCap(CAPABILITIES.BACKUPS_DELETE, { getServerId: backupServerId }), (req, res) => {
  try {
    const owned = recoveryArgs(req); const name = owned.name; const full = owned.file;
    // Backups use the same recoverable-deletion vocabulary as everything else:
    // the archive moves to trash and stays restorable until it is purged.
    const entry = trash.moveToTrash({
      target: full,
      kind: 'backup',
      scope: 'item',
      serverId: backupServerId(req) || null,
      label: name,
      reason: 'Backup deleted',
      actorId: req.user.id,
    });
    const manifest = recovery.findManifest(name);
    if (manifest) require('./lib/db.cjs').open().prepare('DELETE FROM backup_manifests WHERE id=?').run(manifest.id);
    addNotification('backup_deleted', 'Backup Deleted', `Backup "${name}" has been moved to trash.`);
    res.json({ ok: true, trash: { id: entry.id, expiresAt: entry.expiresAt, restorable: entry.restorable } });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

app.get('/api/backups/:name/download', requireCap(CAPABILITIES.BACKUPS_VIEW, { getServerId: backupServerId }), (req, res) => {
  try { const owned = recoveryArgs(req); res.download(owned.file, owned.name); }
  catch (err) { httpError(res, req, err, err.status || 400); }
});

app.get('/api/backups/:name/contents', requireCap(CAPABILITIES.BACKUPS_VIEW, { getServerId: backupServerId }), async (req, res) => {
  try { const a = recoveryArgs(req); const manifest = await recovery.ensureManifest(a); res.json({ ok: true, manifest }); }
  catch (err) { log('backup error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code }); }
});

app.post('/api/backups/:name/verify', requireCap(CAPABILITIES.BACKUPS_VIEW, { getServerId: backupServerId }), async (req, res) => {
  try { const result = await recovery.verify(recoveryArgs(req)); res.json({ ok: true, verification: result }); }
  catch (err) { log('backup verify error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code || 'verification_failed' }); }
});

app.post('/api/backups/:name/impact', requireCap(CAPABILITIES.BACKUPS_RESTORE, { getServerId: backupServerId }), async (req, res) => {
  try {
    const a = recoveryArgs(req); const manifest = await recovery.ensureManifest(a);
    if (a.m.module().id === 'terraria' && a.m.status !== STATUS.OFFLINE) {
      return res.status(409).json({ error: 'Terraria backups can only be restored while the server is offline.' });
    }
    if (manifest.metadata?.game === 'terraria'
        && manifest.metadata.variant !== (a.m.desc().terrariaVariant || 'vanilla')) {
      return res.status(409).json({ error: 'This backup belongs to a different Terraria variant.', code: 'variant_mismatch' });
    }
    if (manifest.metadata?.game === 'terraria' && Number.isInteger(manifest.metadata.world?.headerVersion)) {
      const currentFile = a.m.desc().terrariaWorld?.file;
      if (currentFile) {
        try {
          const current = require('./lib/terraria-worlds.cjs').readHeaderOf(path.join(a.m.dir(), currentFile));
          if (current.ok && manifest.metadata.world.headerVersion > current.version) {
            return res.status(409).json({
              error: 'This world was saved by a newer Terraria version than this server has opened.',
              code: 'world_version_newer',
            });
          }
        } catch (_) { /* No readable local world means there is no safe version comparison. */ }
      }
    }
    const verification = recovery.summaries(manifest).verification;
    if (verification.status !== 'verified') return res.status(409).json({ error: 'Verify this backup before restoring it.' });
    const server = { id: a.m.id, dir: a.m.dir(), worlds: a.worlds };
    res.json({ ok: true, impact: recovery.makeImpact({ manifest, server, actorId: req.user.id }) });
  } catch (err) { log('backup error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code }); }
});


app.post('/api/backups/:name/restore', requireCap(CAPABILITIES.BACKUPS_RESTORE, { getServerId: backupServerId }), async (req, res) => {
  const idem = req.get('Idempotency-Key'); if (!idem) return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  let a, preview; try { a = recoveryArgs(req); preview = recovery.consumePreview({ token: req.body && req.body.token, actorId: req.user.id, server: { id: a.m.id, dir: a.m.dir(), worlds: a.worlds } }); }
  catch (err) { return httpError(res, req, err, err.status || 409); }
  const op = foundationOperations.create({ kind: 'backup-restore', actorId: req.user.id, serverId: a.m.id, idempotencyKey: idem, summary: { backup: a.name } });
  res.status(202).json({ ok: true, operationId: op.id }); if (op.state !== foundationOperations.STATES.QUEUED) return;
  setImmediate(async () => {
    const staging = path.join(a.m.dir(), '.lodestone', 'staging', op.id); const rollback = path.join(a.m.dir(), '.lodestone', 'rollback', op.id); const moved = [];
    try {
      foundationOperations.start(op.id, { phase: 'verify' }); await recovery.verify({ ...a, operationId: op.id });
      foundationOperations.heartbeat(op.id, { phase: 'pre-restore-backup', progress: .2 }); const snapshot = await createBackup(a.m, { applyRetention: false }); await recovery.verify({ file: path.join(backupsDir(), snapshot.name), filename: snapshot.name, serverId: a.m.id, worlds: a.worlds, operationId: op.id });
      const disk = await new Promise((resolve) => fs.statfs(a.m.dir(), (e, s) => resolve(e ? null : s.bavail * s.bsize)));
      if (disk != null && disk < preview.payload.requiredBytes * 1.1) throw Object.assign(new Error('Insufficient disk space for restore.'), { code: 'insufficient_disk' });
      foundationOperations.heartbeat(op.id, { phase: 'extract-staging', progress: .4 }); await recovery.extract(a.file, staging, a.worlds);
      foundationOperations.heartbeat(op.id, { phase: 'wait-offline', progress: .6 }); if (a.m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server must be offline before restore commit.'), { code: 'server_online' });
      fs.mkdirSync(rollback, { recursive: true }); foundationOperations.heartbeat(op.id, { phase: 'commit', progress: .75 });
      for (const root of preview.manifest.worldRoots) { if (a.m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server came online during restore.'), { code: 'server_online_race' }); const live = path.join(a.m.dir(), root); const old = path.join(rollback, root); const fresh = path.join(staging, root); if (fs.existsSync(live)) fs.renameSync(live, old); moved.push({ live, old }); fs.renameSync(fresh, live); }
      fs.rmSync(staging, { recursive: true, force: true }); foundationOperations.finish(op.id, { backup: a.name, snapshot: snapshot.name, rollbackAvailable: true });
    } catch (err) {
      if (moved.length) foundationOperations.markRecoveryRequired(op.id, { code: err.code || 'commit_failed', text: err.message, recovery: { rollbackPath: rollback, roots: moved } });
      else { fs.rmSync(staging, { recursive: true, force: true }); foundationOperations.fail(op.id, { code: err.code || 'restore_failed', text: err.message }); }
    }
  });
});

// --- Modrinth ---
const MODRINTH = 'https://api.modrinth.com/v2';
const UA = `${(config.appName || 'Hostkind')}-Panel/1.0 (local use)`;

const MODRINTH_SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
// Categories that exist for both plugins and mods on Modrinth.
const MODRINTH_CATEGORIES = [
  'adventure', 'cursed', 'decoration', 'economy', 'equipment', 'food', 'game-mechanics',
  'library', 'magic', 'management', 'minigame', 'mobs', 'optimization', 'social',
  'storage', 'technology', 'transportation', 'utility', 'worldgen',
];

// Work out what content the selected server can actually run, from its jar name.
// loaders[] is used both to filter Modrinth and to decide plugins/ vs mods/.
// `canMods` (true when the server runs any mod loader) is what gates the Mods
// tab in the content view; the Plugins tab still works for the plugin loaders
// (paper/spigot/bukkit).
function detectCompat(m) {
  const jar = ((m && m.desc().jar) || '').toLowerCase();
  const loaderName = ((m && m.desc().loader) || '').toLowerCase();
  const mcVersion = (m && m.desc().mcVersion) || '';
  let projectType = 'plugin';
  let loaders = ['paper', 'spigot', 'bukkit'];
  let folder = 'plugins';
  let label = 'Paper/Spigot';
  let canMods = false;
  if (loaderName === 'fabric' || jar.includes('fabric')) { projectType = 'mod'; loaders = ['fabric']; folder = 'mods'; label = 'Fabric'; canMods = true; }
  else if (loaderName === 'quilt' || jar.includes('quilt')) { projectType = 'mod'; loaders = ['quilt', 'fabric']; folder = 'mods'; label = 'Quilt'; canMods = true; }
  else if (loaderName === 'neoforge' || jar.includes('neoforge')) { projectType = 'mod'; loaders = ['neoforge']; folder = 'mods'; label = 'NeoForge'; canMods = true; }
  else if (loaderName === 'forge' || jar.includes('forge')) { projectType = 'mod'; loaders = ['forge']; folder = 'mods'; label = 'Forge'; canMods = true; }
  else if (loaderName === 'paper' || jar.includes('paper')) { loaders = ['paper', 'spigot', 'bukkit']; label = 'Paper'; }
  else if (loaderName === 'spigot' || jar.includes('spigot')) { loaders = ['spigot', 'bukkit']; label = 'Spigot'; }
  else if (loaderName === 'bukkit' || jar.includes('bukkit')) { loaders = ['bukkit']; label = 'Bukkit'; }
  else if (loaderName === 'vanilla' || jar.includes('vanilla') || jar.includes('minecraft_server')) { projectType = null; label = 'Vanilla'; }
  return { projectType, loaders, folder, label, mcVersion, canMods };
}

app.get('/api/modrinth/search', async (req, res) => {
  const m = targetManager(req);
  const compat = detectCompat(m);
  // `projectType` (optional) lets the caller force 'mod', 'plugin', or
  // 'modpack' so all tabs of the content view can reuse this endpoint
  // regardless of the active server's loader. Without an override we keep
  // the historical behaviour of matching the server's own project type.
  const overrideType = String(req.query.projectType || '');
  const projectType = overrideType === 'mod' || overrideType === 'plugin' || overrideType === 'modpack' ? overrideType : compat.projectType;
  if (!projectType) {
    return res.json({ hits: [], compat, note: tErr(req.user, 'errors.vanillaNoPlugins') });
  }
  // Pick the loader facet for the requested project type: when the user is
  // looking at the Mods tab on a Paper server (e.g. browsing a Fabric mod
  // pack reference) we fall back to the full mod-loader union so they still
  // see fabric/forge/neoforge results. The Modpacks tab omits the loader
  // facet entirely so modpacks for any loader surface.
  let loadersForQuery = compat.loaders;
  if (projectType === 'mod') {
    loadersForQuery = compat.canMods ? compat.loaders : ['fabric', 'forge', 'neoforge', 'quilt'];
  } else if (projectType === 'plugin') {
    loadersForQuery = ['paper', 'spigot', 'bukkit'];
  }
  const q = req.query.q || '';
  const sort = MODRINTH_SORTS.includes(req.query.sort) ? req.query.sort : 'downloads';
  const facets = [
    [`project_type:${projectType}`],
  ];
  if (projectType !== 'modpack') {
    facets.push(loadersForQuery.map((l) => `categories:${l}`));
    if (compat.mcVersion) facets.push([`versions:${compat.mcVersion}`]);
  }
  if (req.query.category && MODRINTH_CATEGORIES.includes(req.query.category)) {
    facets.push([`categories:${req.query.category}`]);
  }
  const url = `${MODRINTH}/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=${sort}&limit=30`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const data = await r.json();
    res.json({ ...data, compat, projectType, categories: MODRINTH_CATEGORIES });
  } catch (err) {
    httpError(res, req, err, 502);
  }
});

app.get('/api/modrinth/versions/:projectId', async (req, res) => {
  const m = targetManager(req);
  const compat = detectCompat(m);
  const loaders = JSON.stringify(compat.loaders);
  const gv = JSON.stringify(compat.mcVersion ? [compat.mcVersion] : []);
  const url = `${MODRINTH}/project/${encodeURIComponent(req.params.projectId)}/version?loaders=${encodeURIComponent(loaders)}&game_versions=${encodeURIComponent(gv)}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const matched = await r.json();
    res.json({ matched: Array.isArray(matched) ? matched : [], compat });
  } catch (err) {
    httpError(res, req, err, 502);
  }
});

app.post('/api/modrinth/install', async (req, res) => {
  const { versionId } = req.body || {};
  if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const compat = detectCompat(m);
  try {
    log(`Modrinth: resolving version ${versionId} for "${m.name()}" (${compat.label})...`);
    const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
    const version = await r.json();
    // Compatibility guard: refuse anything that doesn't match this server's
    // loader and Minecraft version, so an incompatible jar can't be installed.
    const loaderOk = (version.loaders || []).some((l) => compat.loaders.includes(l));
    const versionOk = !compat.mcVersion || (version.game_versions || []).includes(compat.mcVersion);
    if (!loaderOk || !versionOk) {
      return res.status(409).json({ error: tErr(req.user, 'errors.incompatible', { label: compat.label, version: compat.mcVersion || '' }) });
    }
    const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
    if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
    log(`Modrinth: downloading ${file.filename}...`);
    const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
    const buf = Buffer.from(await dl.arrayBuffer());
    const pdir = path.join(m.dir(), compat.folder);
    fs.mkdirSync(pdir, { recursive: true });
    const dest = path.join(pdir, path.basename(file.filename));
    fs.writeFileSync(dest, buf);
    updateCenter.recordModrinth({
      serverId: m.id,
      relativePath: path.relative(m.dir(), dest).split(path.sep).join('/'),
      kind: compat.folder === 'mods' ? 'mod' : 'plugin',
      projectId: version.project_id,
      versionId: version.id,
      mcVersion: compat.mcVersion,
      loader: (version.loaders || []).find((l) => compat.loaders.includes(l)),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    });
    log(`Modrinth: installed ${file.filename} into ${compat.folder}/ for "${m.name()}"`);
    m.pushLine(`[Hostkind] Installed from Modrinth into ${compat.folder}/: ${file.filename}`, 'info');
    addNotification('plugin_installed', 'Plugin Installed', `"${file.filename}" installed into ${compat.folder}/ for "${m.name()}". Restart the server to apply.`, m.id);
    res.json({ ok: true, name: file.filename, note: 'Restart the server to apply.' });
  } catch (err) {
    log(`Modrinth install failed: ${err.message}`);
    res.status(502).json({ error: sanitizeErrorMessage(err.message) });
  }
});

app.use('/api/updates', updateCenter.router({
  findServer,
  getManager: (id) => managers.get(id),
  detectCompat,
}));

// --- Modrinth modpack --------------------------------------------------------

async function resolveLifecyclePack(versionId, worlds) {
  const response = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`Modrinth version lookup failed: HTTP ${response.status}`);
  const version = await response.json();
  const archive = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
  if (!archive) throw new Error('No version files found');
  const archiveResponse = await fetch(archive.url, { headers: { 'User-Agent': UA } });
  if (!archiveResponse.ok) throw new Error(`Download failed: HTTP ${archiveResponse.status}`);
  const mrpack = Buffer.from(await archiveResponse.arrayBuffer());
  const index = await readMrpackIndex(mrpack);
  const spec = manifestToSpec(index);
  if (spec.unsupported) throw new Error(spec.reason || 'Unsupported modpack');
  const files = [];
  for (const item of serverSideFiles(index)) {
    const url = item.downloads && item.downloads[0];
    if (!url || !item.path) continue;
    const buffer = await downloadAndVerify(url, item.hashes, UA);
    files.push({
      relativePath: item.path,
      sizeBytes: buffer.length,
      sha256: modpackLifecycle.sha256(buffer),
      sourceUrlHash: modpackLifecycle.sha256(url),
      url,
    });
  }
  const validated = modpackLifecycle.validateFiles(files, worlds);
  return { version, index, spec, files: validated.accepted, excluded: validated.excluded };
}

async function lifecyclePreview(req, res, kind) {
  try {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: 'No active server.' });
    const versionId = String((req.body || {}).versionId || '');
    if (!versionId) return res.status(400).json({ error: 'A version is required.' });
    const server = m.desc();
    const pack = await resolveLifecyclePack(versionId, server.worlds || []);
    const compat = detectCompat(m);
    if (!compat.loaders.includes(pack.spec.loaderType) || (compat.mcVersion && compat.mcVersion !== pack.spec.mcVersion)) {
      return res.status(409).json({ error: 'This modpack is not compatible with the server.' });
    }
    const previous = modpackLifecycle.latest(m.id);
    if (kind === 'update' && !previous) return res.status(409).json({ error: 'This server has no managed modpack.' });
    const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
    const plan = modpackLifecycle.buildPlan({ root: m.dir(), oldFiles, newFiles: pack.files, worlds: server.worlds || [] });
    const projectId = String(pack.version.project_id || (req.body || {}).projectId || '');
    const previewId = modpackLifecycle.savePreview({ serverId: m.id, actorId: req.user.id, kind, projectId, versionId, mcVersion: pack.spec.mcVersion, loader: pack.spec.loaderType, previousManifestId: previous?.id || null, plan });
    res.json({ ok: true, previewId, projectId, versionId, mcVersion: pack.spec.mcVersion, loader: pack.spec.loaderType, groups: plan.groups, inventoryHash: plan.inventoryHash, compatibility: { ok: true }, downtime: m.status !== STATUS.OFFLINE, snapshot: { required: true } });
  } catch (err) {
    log(`Modpack ${kind} preview failed: ${err.message}`);
    res.status(502).json({ error: sanitizeErrorMessage(err.message) });
  }
}

async function lifecycleApply(req, res, kind) {
  const body = req.body || {};
  const loaded = modpackLifecycle.loadPreview(String(body.previewId || ''), req.user.id);
  if (!loaded || loaded.data.kind !== kind) return res.status(409).json({ error: 'Preview expired. Create a new preview.' });
  const m = getManager(loaded.data.serverId);
  if (!m || !m.dir()) return res.status(404).json({ error: 'Server not found.' });
  if (m.status !== STATUS.OFFLINE) return res.status(409).json({ error: 'The server must be offline.' });
  const operation = foundationOperations.create({ kind: `modpack-${kind}`, actorId: req.user.id, serverId: m.id, idempotencyKey: req.get('Idempotency-Key') || null, summary: { versionId: loaded.data.versionId } });
  if (operation.state !== foundationOperations.STATES.QUEUED) return res.status(202).json({ ok: true, operationId: operation.id });
  try {
    foundationOperations.start(operation.id, { phase: 'revalidate' });
    const server = m.desc();
    const pack = await resolveLifecyclePack(loaded.data.versionId, server.worlds || []);
    const previous = modpackLifecycle.latest(m.id);
    const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
    const plan = modpackLifecycle.buildPlan({ root: m.dir(), oldFiles, newFiles: pack.files, worlds: server.worlds || [] });
    if (plan.inventoryHash !== loaded.row.inventory_hash) throw Object.assign(new Error('Server files changed after preview. Create a new preview.'), { status: 409 });
    const decisions = body.decisions && typeof body.decisions === 'object' && !Array.isArray(body.decisions) ? body.decisions : {};
    for (const conflict of plan.groups.conflicts) {
      if (!['keep_local', 'take_pack'].includes(decisions[conflict.relativePath])) throw Object.assign(new Error(`A decision is required for ${conflict.relativePath}.`), { status: 409 });
    }
    const snapshot = foundationSnapshots.take({ serverId: m.id, sourceDir: m.dir(), kind: 'modpack', reason: `${kind} ${loaded.data.versionId}` });
    if (!foundationSnapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed.');
    const staging = path.join(m.dir(), '.lodestone', 'staging', operation.id);
    fs.mkdirSync(staging, { recursive: true });
    const incoming = new Map(pack.files.map((f) => [f.relativePath, f]));
    for (const entry of plan.entries) {
      const takePack = entry.state !== 'local_edit' && (entry.state !== 'conflict' || decisions[entry.relativePath] === 'take_pack');
      if (!takePack) continue;
      const item = incoming.get(entry.relativePath);
      if (!item) continue;
      const buffer = await downloadAndVerify(item.url, { sha256: item.sha256 }, UA);
      if (modpackLifecycle.sha256(buffer) !== item.sha256) throw new Error(`SHA-256 mismatch for ${item.relativePath}`);
      const staged = mrpackSafeResolve(staging, entry.relativePath);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, buffer);
    }
    if (m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server started during update.'), { status: 409 });
    const db = require('./lib/db.cjs').open();
    const insertDecision = db.prepare('INSERT OR REPLACE INTO modpack_conflict_decisions VALUES (?,?,?,?)');
    for (const [relativePath, decision] of Object.entries(decisions)) insertDecision.run(operation.id, relativePath, decision, req.user.id);
    for (const entry of plan.entries) {
      const takePack = entry.state !== 'local_edit' && (entry.state !== 'conflict' || decisions[entry.relativePath] === 'take_pack');
      if (!takePack) continue;
      const dest = mrpackSafeResolve(m.dir(), entry.relativePath);
      const staged = mrpackSafeResolve(staging, entry.relativePath);
      if (incoming.has(entry.relativePath)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(staged, dest);
      } else if (entry.state === 'safe_removal' && fs.existsSync(dest)) fs.unlinkSync(dest);
    }
    const owned = pack.files.filter((f) => {
      const e = plan.entries.find((x) => x.relativePath === f.relativePath);
      return e && e.state !== 'local_edit' && (e.state !== 'conflict' || decisions[e.relativePath] === 'take_pack');
    });
    const manifest = modpackLifecycle.persistManifest({ serverId: m.id, projectId: loaded.data.projectId, versionId: loaded.data.versionId, mcVersion: loaded.data.mcVersion, loader: loaded.data.loader, operationId: operation.id, snapshotId: snapshot.id, previousManifestId: previous?.id || null }, owned);
    fs.rmSync(staging, { recursive: true, force: true });
    foundationOperations.finish(operation.id, { manifestId: manifest.id });
    res.status(202).json({ ok: true, operationId: operation.id, manifestId: manifest.id });
  } catch (err) {
    foundationOperations.fail(operation.id, { code: 'modpack_apply_failed', text: err.message });
    log('modpack apply failed:', err.message);
    res.status(err.status || 500).json({ error: sanitizeErrorMessage(err.message), operationId: operation.id });
  }
}

app.post('/api/modpacks/import/preview', (req, res) => lifecyclePreview(req, res, 'import'));
app.post('/api/modpacks/import', (req, res) => lifecycleApply(req, res, 'import'));
app.get('/api/modpacks/installed', async (req, res) => {
  const m = targetManager(req);
  if (!m) return res.status(400).json({ error: 'No active server.' });
  const installed = modpackLifecycle.latest(m.id);
  const history = modpackLifecycle.history(m.id);
  const records = installed ? [installed, ...history] : history;
  const metadata = new Map();
  await Promise.all(records.map(async (record) => {
    const key = `${record.project_id}:${record.version_id}`;
    if (metadata.has(key)) return;
    try {
      const [projectResponse, versionResponse] = await Promise.all([
        fetch(`${MODRINTH}/project/${encodeURIComponent(record.project_id)}`, { headers: { 'User-Agent': UA } }),
        fetch(`${MODRINTH}/version/${encodeURIComponent(record.version_id)}`, { headers: { 'User-Agent': UA } }),
      ]);
      if (!projectResponse.ok || !versionResponse.ok) return;
      const [project, version] = await Promise.all([projectResponse.json(), versionResponse.json()]);
      metadata.set(key, {
        projectName: project.title || project.slug,
        projectSlug: project.slug,
        iconUrl: project.icon_url || null,
        versionName: version.name || version.version_number,
        versionNumber: version.version_number,
      });
    } catch (_) { /* Stored identifiers remain available when Modrinth is unavailable. */ }
  }));
  const enrich = (record) => record ? {
    ...record,
    file_count: record.file_count ?? record.files?.length ?? 0,
    ...(metadata.get(`${record.project_id}:${record.version_id}`) || {}),
  } : null;
  res.json({ installed: enrich(installed), history: history.map(enrich) });
});
app.post('/api/modpacks/update/preview', (req, res) => lifecyclePreview(req, res, 'update'));
app.post('/api/modpacks/update', (req, res) => lifecycleApply(req, res, 'update'));

app.post('/api/modpacks/clone', (req, res) => {
  const body = req.body || {};
  const source = targetManager(req);
  const name = String(body.name || '').trim();
  const parentDir = String(body.parentDir || '').trim();
  if (!source || !source.dir()) return res.status(400).json({ error: 'No active server.' });
  if (!name || !parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: 'A name and existing parent folder are required.' });
  const finalDir = path.join(parentDir, slugify(name));
  if (fs.existsSync(finalDir)) return res.status(409).json({ error: 'The clone folder already exists.' });
  const staging = `${finalDir}.lodestone-${crypto.randomUUID()}.staging`;
  const sourceConfig = source.desc();
  try {
    const worlds = sourceConfig.worlds || [];
    function copyClone(src, dest, rel = '') {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (modpackLifecycle.exclusionReason(childRel, worlds)) continue;
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyClone(from, to, childRel);
        else if (entry.isFile()) fs.copyFileSync(from, to);
      }
    }
    copyClone(source.dir(), staging);
    fs.renameSync(staging, finalDir);
    const entry = { ...sourceConfig, id: genId(), name, dir: finalDir, worlds: [...worlds] };
    config.servers.push(entry);
    saveConfig(config);
    getManager(entry.id);
    const prior = modpackLifecycle.latest(source.id);
    if (prior) {
      const files = prior.files.filter((f) => fs.existsSync(mrpackSafeResolve(finalDir, f.relative_path))).map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes, sourceUrlHash: f.source_url_hash }));
      modpackLifecycle.persistManifest({ serverId: entry.id, projectId: prior.project_id, versionId: prior.version_id, mcVersion: prior.mc_version, loader: prior.loader, operationId: crypto.randomUUID() }, files);
    }
    res.status(201).json({ ok: true, server: serverWithStatus(entry) });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    httpError(res, req, err, 500);
  }
});

app.post('/api/modpacks/history/:id/rollback', (req, res) => {
  const manifest = modpackLifecycle.getManifest(req.params.id);
  if (!manifest || !manifest.snapshot_id) return res.status(404).json({ error: 'Rollback snapshot not found.' });
  const m = getManager(manifest.server_id);
  if (!m || m.status !== STATUS.OFFLINE) return res.status(409).json({ error: 'The server must be offline.' });
  const result = foundationSnapshots.restore({ id: manifest.snapshot_id, targetDir: m.dir() });
  if (!result.ok) return res.status(500).json({ error: 'Snapshot restore verification failed.' });
  const op = foundationOperations.create({ kind: 'modpack-rollback', actorId: req.user.id, serverId: m.id, idempotencyKey: req.get('Idempotency-Key') || null });
  foundationOperations.start(op.id, { phase: 'restore' });
  foundationOperations.finish(op.id, { manifestId: manifest.id });
  res.status(202).json({ ok: true, operationId: op.id, manifestId: manifest.id });
});

app.get('/api/modrinth/modpack/versions/:projectId', async (req, res) => {
  const m = targetManager(req);
  const compat = detectCompat(m);
  const projectId = req.params.projectId;
  const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const matched = await r.json();
    res.json({ matched: Array.isArray(matched) ? matched : [], compat });
  } catch (err) {
    httpError(res, req, err, 502);
  }
});

app.get('/api/modrinth/modpack/preview/:versionId', async (req, res) => {
  const versionId = req.params.versionId;
  if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
  const m = targetManager(req);
  const compat = detectCompat(m);
  try {
    log(`Modpack preview: resolving version ${versionId}...`);
    const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
    const version = await r.json();
    const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
    if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
    const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
    const mrpack = Buffer.from(await dl.arrayBuffer());
    const index = await readMrpackIndex(mrpack);
    const spec = manifestToSpec(index);
    const counts = fileCountByEnv(index);
    const eligibleExisting = !spec.unsupported && compat.loaders.some((l) => l === spec.loaderType) &&
      (!compat.mcVersion || compat.mcVersion === spec.mcVersion);
    res.json({
      name: spec.name || version.name || '',
      versionId,
      mcVersion: spec.mcVersion || '',
      loaderType: spec.loaderType || '',
      loaderVersion: spec.loaderVersion || '',
      unsupported: spec.unsupported,
      unsupportedReason: spec.reason || '',
      fileCount: counts.total,
      serverFileCount: counts.server,
      indexName: index.name || '',
      eligibleExisting,
      compat,
    });
  } catch (err) {
    log(`Modpack preview failed: ${err.message}`);
    res.status(502).json({ error: sanitizeErrorMessage(err.message) });
  }
});

app.post('/api/modrinth/modpack/install', async (req, res) => {
  const body = req.body || {};
  const versionId = String(body.versionId || '');
  const mode = String(body.mode || 'existing').toLowerCase();
  if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
  try {
    log(`Modpack install: resolving version ${versionId}...`);
    const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
    const version = await r.json();
    const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
    if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
    const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
    const mrpack = Buffer.from(await dl.arrayBuffer());
    const index = await readMrpackIndex(mrpack);
    const spec = manifestToSpec(index);
    if (spec.unsupported) {
      return res.status(400).json({ error: tErr(req.user, 'errors.modpackUnsupportedLoader', { loader: spec.loaderType || 'unknown', reason: spec.reason || '' }) });
    }

    const sFiles = serverSideFiles(index);
    let targetDir;
    let serverName;
    let targetServerId;
    let targetWorlds = [];

    if (mode === 'create') {
      const createName = String(body.name || spec.name || index.name || 'Modpack Server').trim();
      const parentDir = String(body.parentDir || '').trim();
      if (!createName) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
      if (createName.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
      if (!parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });

      const dir = path.join(parentDir, slugify(createName));
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
      }

      const type = spec.loaderType;
      const mcVersion = spec.mcVersion;

      log(`Modpack create: ${type} server "${createName}" (MC ${mcVersion}) -> ${dir}`);

      fs.mkdirSync(dir, { recursive: true });

      const { url, filename } = await resolveServerJar(type, mcVersion);
      log(`Modpack create: resolved -> ${url}`);
      const jarPath = path.join(dir, filename);

      log(`Modpack create: downloading ${filename}...`);
      await downloadToFile(url, jarPath, () => {}, undefined);

      let jarFilename = filename;
      let launchArgs = null;
      if (type === 'forge' || type === 'neoforge') {
        const label = type === 'neoforge' ? 'NeoForge' : 'Forge';
        const major = requiredJavaMajor(mcVersion);
        let javaBin = resolveJavaForServer({ mcVersion }, major);
        if (!javaBin) {
          log(`Modpack create: ${label} installer needs Java ${major}; preparing managed runtime...`);
          javaBin = await ensureRuntime(major, () => {});
        }
        await runForgeInstaller(dir, filename, label, javaBin);
        const produced = findForgeLaunchTarget(dir, type);
        if (!produced) throw new Error(`${label} installer finished but no server jar or launch args file was found in the folder`);
        jarFilename = produced.jar;
        launchArgs = produced.launchArgs;
      }

      fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted via Hostkind modpack install on ${new Date().toISOString()}\neula=true\n`, 'utf8');

      targetDir = dir;
      serverName = createName;

      const entry = {
        id: genId(),
        name: createName,
        dir,
        jar: jarFilename,
        loader: type,
        launchArgs,
        javaArgs: ['-Xmx4G', '-Xms4G'],
        mcVersion,
        stopTimeoutSeconds: 30,
        worlds: ['world', 'world_nether', 'world_the_end'],
        watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      };
      config.servers.push(entry);
      if (!config.activeServerId) config.activeServerId = entry.id;
      saveConfig(config);
      getManager(entry.id);
      targetServerId = entry.id;
      targetWorlds = entry.worlds;
      addNotification('server_created', 'Modpack Server Created', `Server "${createName}" (${type}, MC ${mcVersion}) created from modpack.`, entry.id);
      log(`Created ${type} server "${createName}" (${mcVersion}) from modpack at ${dir}`);
    } else {
      const m = targetManager(req);
      if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
      const compat = detectCompat(m);
      const loaderOk = compat.loaders.some((l) => l === spec.loaderType);
      const versionOk = !compat.mcVersion || compat.mcVersion === spec.mcVersion;
      if (!loaderOk || !versionOk) {
        return res.status(409).json({ error: tErr(req.user, 'errors.modpackIncompatible', { label: spec.loaderType || '?', version: spec.mcVersion || '' }) });
      }
      targetDir = m.dir();
      serverName = m.name();
      targetServerId = m.id;
      targetWorlds = m.desc().worlds || [];
    }

    fs.mkdirSync(targetDir, { recursive: true });

    let installed = 0;
    const managedFiles = [];
    for (const f of sFiles) {
      const url = f.downloads && f.downloads[0];
      if (!url) continue;
      log(`Modpack: downloading ${f.path}...`);
      const buf = await downloadAndVerify(url, f.hashes, UA);
      if (!f.path || typeof f.path !== 'string') continue;
      const dest = mrpackSafeResolve(targetDir, f.path);
      if (!dest) {
        log(`Modpack: skipping "${f.path}" — escapes server directory`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      managedFiles.push({
        relativePath: f.path,
        sizeBytes: buf.length,
        sha256: modpackLifecycle.sha256(buf),
        sourceUrlHash: modpackLifecycle.sha256(url),
      });
      installed++;
    }

    const overridesExtracted = await extractOverrides(mrpack, targetDir);
    const trackedFiles = modpackLifecycle.validateFiles(managedFiles, targetWorlds).accepted;
    const previous = modpackLifecycle.latest(targetServerId);
    modpackLifecycle.persistManifest({
      serverId: targetServerId,
      projectId: String(version.project_id || ''),
      versionId,
      mcVersion: spec.mcVersion,
      loader: spec.loaderType,
      operationId: crypto.randomUUID(),
      previousManifestId: previous?.id || null,
    }, trackedFiles);

    log(`Modpack: installed ${installed} files + ${overridesExtracted} overrides into "${serverName}"`);
    if (mode === 'existing') {
      const m = targetManager(req);
      if (m) {
        m.pushLine(`[Hostkind] Installed modpack from Modrinth: ${spec.name || version.name || ''} (${installed} files, ${overridesExtracted} overrides)`, 'info');
        addNotification('modpack_installed', 'Modpack Installed', `Modpack "${spec.name || version.name || ''}" installed into "${serverName}" (${installed} files, ${overridesExtracted} overrides).`, m.id);
      }
    } else {
      addNotification('modpack_installed', 'Modpack Server Created', `Modpack "${spec.name || version.name || ''}" deployed as new server "${serverName}".`);
    }

    res.json({
      ok: true,
      name: spec.name || version.name || '',
      serverId: targetServerId,
      server: config.servers.find((server) => server.id === targetServerId) || null,
      fileCount: installed,
      overrides: overridesExtracted,
      mode,
      note: 'Restart the server to apply.',
    });
  } catch (err) {
    log(`Modpack install failed: ${err.message}`);
    res.status(502).json({ error: sanitizeErrorMessage(err.message) });
  }
});

// --- system (point-in-time snapshot; the stream goes over WS) ---
app.get('/api/system', async (req, res) => {
  res.json(await systemStats(targetManager(req)));
});

// ---------------------------------------------------------------------------
// File manager (browse/edit/upload/download - sandboxed to the server folder)
// ---------------------------------------------------------------------------

// Resolve a user-supplied relative path against the server root, refusing any
// path that would escape the root (path traversal guard).
function safeResolve(root, rel) {
  const base = path.resolve(root);
  // CodeQL's js/path-injection barrier keys on the FIRST argument of
  // path.resolve (or the last argument of a path.join nested as its first
  // argument). The tainted relative path must therefore enter through
  // path.join - a resolve(base, taintedSuffix) shape is logically correct
  // but invisible to the query, leaving every downstream fs sink flagged.
  const target = path.resolve(path.join(base, '.' + path.sep + (rel || '').replace(/^[\\/]+/, '')));
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(rootWithSep)) return null;
  return target;
}

// The prefix check above is lexical, so a symlink (or Windows junction) inside
// the server folder can reach the host through it. Re-prove containment on the
// real paths: canonical() resolves every existing link on both sides, so a
// link pointing outside the root fails the relation check here. The sandbox is
// "the server folder", links included - reads, writes, renames, and deletes
// through a link must never leave it.
function safeResolveNoFollow(root, rel) {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  const how = pathSafety.relation(abs, root);
  return how === 'same' || how === 'inside' ? abs : null;
}

const TEXT_EXTS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.conf', '.cfg',
  '.ini', '.log', '.md', '.sh', '.bat', '.csv', '.xml', '.mcmeta', '.lang', '.sk',
]);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTS.has(ext) || name.toLowerCase() === 'eula.txt' || !ext;
}

app.get('/api/files', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
  if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  // Inline prefix + startsWith barrier at the fs sinks (js/path-injection).
  // safeResolveNoFollow already proved containment; this restates it on the
  // sink's own taint path in the positive-startsWith shape CodeQL 2.26.3
  // registers (negated or compound guard conditions are invisible to the
  // query). The prefix is checked without a trailing separator so the server
  // root itself stays reachable, matching the resolver contract.
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      const entries = fs.readdirSync(absResolved, { withFileTypes: true });
      const out = entries.map((e) => {
        let size = 0, mtime = 0;
        const child = path.join(absResolved, e.name);
        if (child.startsWith(filesRoot)) {
          try { const st = fs.statSync(child); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        }
        return { name: e.name, dir: e.isDirectory(), size, mtime, editable: e.isFile() && isTextFile(e.name) };
      }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      res.json({ path: path.relative(m.dir(), abs).replace(/\\/g, '/'), entries: out });
    } catch (err) {
      httpError(res, req, err, 400);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.get('/api/files/read', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
  if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      const st = fs.statSync(absResolved);
      if (st.isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.isAFolder') });
      if (st.size > MAX_EDIT_BYTES) return res.status(413).json({ error: tErr(req.user, 'errors.fileTooLarge') });
      if (!isTextFile(path.basename(absResolved))) return res.status(415).json({ error: tErr(req.user, 'errors.notATextFile') });
      res.json({ content: fs.readFileSync(absResolved, 'utf8') });
    } catch (err) {
      httpError(res, req, err, 400);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.put('/api/files/write', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const abs = safeResolveNoFollow(m.dir(), req.body && req.body.path);
  if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const content = req.body && req.body.content;
  if (typeof content !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingContent') });
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      if (m.desc().type === 'palworld' && absResolved === path.resolve(palworldSettings.configPath(m.dir()))) {
        const guarded = palworldSettings.validateProtectedRaw(content, m.desc());
        if (!guarded.ok) return res.status(409).json({ error: guarded.error, code: 'protected_palworld_setting' });
      }
      fs.writeFileSync(absResolved, content, 'utf8');
      res.json({ ok: true });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.post('/api/files/mkdir', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const name = path.basename(String((req.body && req.body.name) || '').trim());
  if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequiredShort') });
  const abs = safeResolveNoFollow(m.dir(), path.join(req.body.path || '', name));
  if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      fs.mkdirSync(absResolved, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.post('/api/files/rename', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const from = safeResolveNoFollow(m.dir(), req.body && req.body.path);
  const newName = path.basename(String((req.body && req.body.name) || '').trim());
  if (!from || !newName) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const to = path.join(path.dirname(from), newName);
  // The destination is the sibling of an allowed source, so it is canonically
  // inside the root whenever `from` is - but check it anyway so a rename can
  // never land on a symlink pointing out of the sandbox.
  const toRel = pathSafety.relation(to, m.dir());
  if (toRel !== 'same' && toRel !== 'inside') return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  // The source and destination are both user-influenced; restate containment
  // in the positive-startsWith shape at the rename sink (js/path-injection).
  // CodeQL 2.26.3 registers positive startsWith guards with the use in the
  // true branch (negated/compound conditions are invisible to the query).
  const filesRoot = path.resolve(m.dir());
  const fromResolved = path.resolve(from);
  const toResolved = path.resolve(to);
  if (fromResolved.startsWith(filesRoot) && toResolved.startsWith(filesRoot)) {
    try {
      fs.renameSync(fromResolved, toResolved);
      res.json({ ok: true });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.delete('/api/files', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
  if (!abs || abs === path.resolve(m.dir())) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      fs.rmSync(absResolved, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

app.get('/api/files/download', (req, res) => {
  const m = targetManager(req);
  if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
  const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
  if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  const filesRoot = path.resolve(m.dir());
  const absResolved = path.resolve(abs);
  if (absResolved.startsWith(filesRoot)) {
    try {
      if (fs.statSync(absResolved).isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDownloadFolder') });
      res.download(absResolved, path.basename(absResolved));
    } catch (err) {
      res.status(404).json({ error: tErr(req.user, 'errors.fileDoesNotExist') });
    }
  } else {
    return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
  }
});

const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const m = targetManager(req);
      if (!m || !m.dir()) return cb(new Error('No active server.'));
      const dest = safeResolveNoFollow(m.dir(), req.query.path || '');
      if (!dest) return cb(new Error('Invalid path'));
      const uploadsRoot = path.resolve(m.dir());
      const destResolved = path.resolve(dest);
      if (destResolved !== uploadsRoot && !destResolved.startsWith(uploadsRoot + path.sep)) return cb(new Error('Invalid path'));
      try { fs.mkdirSync(destResolved, { recursive: true }); } catch (_) {}
      cb(null, destResolved);
    },
    filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post('/api/files/upload', fileUpload.array('files'), (req, res) => {
  res.json({ ok: true, count: Array.isArray(req.files) ? req.files.length : 0 });
}, (err, req, res, next) => {
  httpError(res, req, err, 400);
});

// ---------------------------------------------------------------------------
// Server creator (download Vanilla / Spigot / Paper / Fabric / Forge / NeoForge jars)
// ---------------------------------------------------------------------------

const SERVER_TYPES = ['vanilla', 'spigot', 'paper', 'fabric', 'forge', 'neoforge'];

// NeoForge versions are listed dynamically from the same API neoforged.net's
// own download page uses (no hardcoded MC->version table to maintain). The
// API returns every NeoForge build oldest-first; we derive the Minecraft
// version each one targets and keep stable releases only.
const NEOFORGE_API_URL = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.text();
}

// Spigot has no version API, so we scrape its download page. This keeps the
// list in sync with the actual Spigot releases (so we never offer a version
// GetBukkit has no jar for) and tracks new releases automatically. Versions
// are listed newest-first on the page; we preserve that order.
async function listSpigotVersions() {
  const html = await fetchText('https://getbukkit.org/download/spigot');
  const versions = [];
  const seen = new Set();
  const re = /<h[1-6][^>]*>\s*(\d+(?:\.\d+)+)\s*<\/h[1-6]>/gi;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1];
    if (!seen.has(v)) { seen.add(v); versions.push(v); }
  }
  if (!versions.length) throw new Error('Could not read the Spigot version list from getbukkit.org');
  return versions;
}

// Vanilla releases come from a community-maintained gist that maps every
// Minecraft version to its official Mojang server.jar URL. We keep full
// releases only (no snapshots / pre-releases / release candidates) and
// preserve the gist's newest-first order. Returns [{ version, url }].
async function fetchVanillaReleases() {
  const md = await fetchText('https://gist.githubusercontent.com/cliffano/77a982a7503669c3e1acb0a0cf6127e9/raw');
  const out = [];
  const seen = new Set();
  const re = /^\|\s*([^|]+?)\s*\|\s*(https?:\/\/\S+?server\.jar)\s*\|/gm;
  let m;
  while ((m = re.exec(md))) {
    const version = m[1].trim();
    // Full releases are digits-and-dots only; anything with letters or a
    // hyphen (26w14a, 26.2-rc-2, 1.16-pre1, beta/alpha) is filtered out.
    if (!/^[0-9]+(\.[0-9]+)+$/.test(version)) continue;
    if (seen.has(version)) continue;
    seen.add(version);
    out.push({ version, url: m[2].trim() });
  }
  if (!out.length) throw new Error('Could not read the vanilla version list');
  return out;
}

// Paper versions come from the PaperMC "Fill" v3 API. `versions` is keyed by
// version family (e.g. "1.21") with arrays of releases newest-first; we flatten
// them keeping full releases only (no rc/pre) and the API's newest-first order.
async function listPaperVersions() {
  const d = await fetchJson('https://fill.papermc.io/v3/projects/paper');
  const versions = [];
  const seen = new Set();
  for (const family of Object.values(d.versions || {})) {
    for (const v of (family || [])) {
      if (!/^[0-9]+(\.[0-9]+)+$/.test(v)) continue; // full releases only
      if (!seen.has(v)) { seen.add(v); versions.push(v); }
    }
  }
  if (!versions.length) throw new Error('Could not read the Paper version list');
  return versions;
}

// Fetches the Forge Maven version list and returns the latest forge build for
// each MC version, mapped to the full "<mc>-<forge>" coordinate (newest MC
// first).
async function listForgeVersions() {
  const xml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  // Coordinates look like "1.20.1-47.2.0" or "1.20.1-47.2.0-1.18" (rare).
  // The MC version is the longest leading "x.y.z" prefix that Mojang would
  // recognise. Group by that and keep the first hit per group (Maven is
  // sorted newest-first by version-string order, which roughly matches
  // release order for forge, so the first match is the newest build).
  const out = [];
  const seen = new Set();
  for (const v of matches) {
    const m = v.match(/^(\d+\.\d+(?:\.\d+)?)(?=-)/);
    if (!m) continue;
    const mc = m[1];
    if (seen.has(mc)) continue;
    seen.add(mc);
    out.push(mc);
  }
  // Sort newest-first by Mojang-style semver.
  out.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return out;
}

async function findLatestForgeCoordinate(mcVersion) {
  const xml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  // Newest matching coordinate that starts with the MC version followed by '-'.
  for (const v of matches) {
    if (v === mcVersion || v.startsWith(mcVersion + '-')) return v;
  }
  return null;
}

// Derives the Minecraft version a NeoForge build targets, mirroring the exact
// algorithm neoforged.net uses on its download page. Old scheme (major < 26):
// "21.1.234" -> "1.21.1" (MC is "1." + the first two version numbers). New
// scheme (major >= 26): "26.1.2.71" -> "26.1.2", dropping a trailing ".0"
// third component so "26.1.0.5" -> "26.1".
function mcVersionFromNeoForge(version) {
  const s = version.split('.');
  if (parseInt(s[0], 10) >= 26) {
    let mc = `${s[0]}.${s[1]}`;
    if (s[2] !== '0') mc += `.${s[2]}`;
    return mc;
  }
  return `1.${s[0]}.${s[1]}`;
}

// A NeoForge build is a stable release only when it carries no pre-release or
// snapshot suffix: digits-and-dots only. Drops "-beta"/"-alpha", "+snapshot"
// builds, and April Fools versions like "0.25w14craftmine.x-beta".
function isStableNeoForge(version) {
  return /^\d+\.\d+\.\d+(\.\d+)?$/.test(version);
}

// Newest-first numeric ordering of dotted version strings ("21.1.234",
// "26.1.2.76", "1.21.11", ...).
function compareVersionDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Fetches every NeoForge build and returns the stable release strings only.
async function fetchStableNeoForgeVersions() {
  const data = await fetchJson(NEOFORGE_API_URL);
  return (data.versions || []).filter(isStableNeoForge);
}

// Returns the MC versions that have at least one stable NeoForge build,
// newest-first.
async function listNeoForgeVersions() {
  const stable = await fetchStableNeoForgeVersions();
  const mc = new Set(stable.map(mcVersionFromNeoForge));
  return Array.from(mc).sort(compareVersionDesc);
}

async function findLatestNeoForgeCoordinate(mcVersion) {
  const stable = await fetchStableNeoForgeVersions();
  const matching = stable.filter((v) => mcVersionFromNeoForge(v) === mcVersion);
  if (!matching.length) return null;
  return matching.sort(compareVersionDesc)[0];
}

// Returns [latest..oldest] of MC versions installable for a type.
async function listServerVersions(type) {
  if (type === 'paper') {
    return await listPaperVersions();
  }
  if (type === 'vanilla') {
    return (await fetchVanillaReleases()).map((r) => r.version);
  }
  if (type === 'spigot') {
    return await listSpigotVersions();
  }
  if (type === 'fabric') {
    const d = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return (d || []).filter((v) => v.stable).map((v) => v.version);
  }
  if (type === 'forge') {
    return await listForgeVersions();
  }
  if (type === 'neoforge') {
    return await listNeoForgeVersions();
  }
  throw new Error('Unknown server type');
}

// Returns { url, filename } for the jar to download.
async function resolveServerJar(type, mcVersion) {
  if (type === 'paper') {
    const build = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds/latest`);
    const dl = build.downloads && build.downloads['server:default'];
    if (!dl || !dl.url) throw new Error('No Paper build for that version');
    return { url: dl.url, filename: dl.name };
  }
  if (type === 'vanilla') {
    const rel = (await fetchVanillaReleases()).find((r) => r.version === mcVersion);
    if (!rel) throw new Error('Unknown vanilla version');
    return { url: rel.url, filename: `minecraft_server-${mcVersion}.jar` };
  }
  if (type === 'spigot') {
    // GetBukkit's CDN serves the Spigot jar for any version that has a build.
    return {
      url: `https://cdn.getbukkit.org/spigot/spigot-${encodeURIComponent(mcVersion)}.jar`,
      filename: `spigot-${mcVersion}.jar`,
    };
  }
  if (type === 'fabric') {
    const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
    const loader = loaders[0] && loaders[0].loader && loaders[0].loader.version;
    if (!loader) throw new Error('No Fabric loader for that version');
    const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = installers[0] && installers[0].version;
    return {
      url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/${installer}/server/jar`,
      filename: `fabric-server-${mcVersion}.jar`,
    };
  }
  if (type === 'forge') {
    const coord = await findLatestForgeCoordinate(mcVersion);
    if (!coord) throw new Error(`No Forge build for MC ${mcVersion}`);
    return {
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(coord)}/forge-${encodeURIComponent(coord)}-installer.jar`,
      filename: `forge-${coord}-installer.jar`,
    };
  }
  if (type === 'neoforge') {
    const coord = await findLatestNeoForgeCoordinate(mcVersion);
    if (!coord) throw new Error(`No NeoForge build for MC ${mcVersion}`);
    return {
      url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(coord)}/neoforge-${encodeURIComponent(coord)}-installer.jar`,
      filename: `neoforge-${coord}-installer.jar`,
    };
  }
  throw new Error('Unknown server type');
}

// Runs the Forge / NeoForge installer non-interactively to extract libraries
// + the runnable server jar into `dir`. Removes the installer jar afterwards.
function runForgeInstaller(dir, installerFilename, label = 'Forge', javaBin = 'java') {
  return runForgeInstallerProcess(dir, installerFilename, label, javaBin, log);
}

app.get('/api/create/versions', async (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  if (!SERVER_TYPES.includes(type)) return res.status(400).json({ error: tErr(req.user, 'errors.unknownServerType') });
  try {
    log(`Fetching ${type} version list...`);
    const versions = await listServerVersions(type);
    log(`${type} versions: ${versions.length} (latest ${versions[0] || 'n/a'})`);
    res.json({ versions });
  } catch (err) {
    log(`Failed to fetch ${type} version list: ${err.message}`);
    res.status(502).json({ error: sanitizeErrorMessage(err.message) });
  }
});

// Downloads `url` to `destPath`, streaming chunks to disk and reporting
// progress through `onProgress(received, total)`. Resolves with the number of
// bytes written. Throws on HTTP failure, on read errors, or when `signal`
// aborts (the partial file is removed before re-throwing).
async function downloadToFile(url, destPath, onProgress, signal) {
  const dl = await fetch(url, { headers: { 'User-Agent': UA }, signal });
  if (!dl.ok) throw new Error(`Jar download failed: HTTP ${dl.status}`);
  const total = Number(dl.headers.get('content-length') || 0);
  const out = fs.createWriteStream(destPath);
  const reader = dl.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal && signal.aborted) {
        reader.cancel().catch(() => {});
        throw new Error('aborted');
      }
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      onProgress(received, total);
    }
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
    throw err;
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
  return received;
}

// ---------------------------------------------------------------------------
// Managed Java runtimes - the panel downloads and keeps a Temurin (Adoptium)
// JRE per Java major so the user never has to install Java themselves. Each
// Minecraft version maps to the Java major it needs; the right runtime is
// fetched on the first start of a server that needs it. Runtimes live under
// runtimes/temurin-<major>/ and are git-ignored.
// ---------------------------------------------------------------------------

// RUNTIMES_DIR is resolved next to CONFIG_PATH at the top of this file, so a
// throwaway instance can keep its runtimes to itself.
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';

// Minecraft version -> required Java major.
function requiredJavaMajor(mcVersion) {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(String(mcVersion || '').trim());
  // New-scheme versions (e.g. "26.1.2") and snapshots don't match the legacy
  // "1.x" pattern; they need the newest managed LTS. This is only a floor -
  // jarJavaMajor() reads the exact requirement from the jar at launch.
  if (!m) return 25;
  const minor = Number(m[1]);
  const patch = Number(m[2] || 0);
  if (minor <= 16) return 8;                       // 1.16.5 and older
  if (minor < 20) return 17;                       // 1.17 - 1.19
  if (minor === 20) return patch >= 5 ? 21 : 17;   // 1.20.5+ needs Java 21
  return 21;                                       // 1.21+
}

// --- Jar class-file version probe ----------------------------------------
// The MC-version heuristic above is a guess; the jar itself states exactly
// which Java it needs. Java enforces this before running: a class compiled for
// Java N carries class-file major (N + 44), and a runtime older than N refuses
// it with UnsupportedClassVersionError. We read the main class's version from
// the jar (a zip) using only Node built-ins, so server-create never picks a
// too-old runtime. Returns the Java major, or null if it can't be determined.
// Note: this is a zip32 reader (fine for any real MC jar; not zip64-aware).
function zipCentralDir(fd, size) {
  const tail = Math.min(size, 65557); // max EOCD record + comment
  const buf = Buffer.alloc(tail);
  fs.readSync(fd, buf, 0, tail, size - tail);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = new Map();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOff = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function zipReadEntry(fd, rec) {
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, rec.localOff);
  if (lh.readUInt32LE(0) !== 0x04034b50) return null;
  const dataOff = rec.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const comp = Buffer.alloc(rec.compSize);
  fs.readSync(fd, comp, 0, rec.compSize, dataOff);
  if (rec.method === 0) return comp;                       // stored
  if (rec.method === 8) return zlib.inflateRawSync(comp);  // deflate
  return null;
}
function jarJavaMajor(jarPath) {
  let fd;
  try {
    const size = fs.statSync(jarPath).size;
    fd = fs.openSync(jarPath, 'r');
    const dir = zipCentralDir(fd, size);
    if (!dir) return null;
    const mfRec = dir.get('META-INF/MANIFEST.MF');
    if (!mfRec) return null;
    const manifest = zipReadEntry(fd, mfRec);
    if (!manifest) return null;
    const m = /Main-Class:\s*([^\r\n]+)/i.exec(manifest.toString('utf8'));
    if (!m) return null;
    const classRec = dir.get(m[1].trim().replace(/\./g, '/') + '.class');
    if (!classRec) return null;
    const cls = zipReadEntry(fd, classRec);
    if (!cls || cls.length < 8 || cls.readUInt32BE(0) !== 0xcafebabe) return null;
    return cls.readUInt16BE(6) - 44; // class-file major -> Java major
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

// Path to the java binary of a managed runtime, or null if not installed.
function resolveManagedJava(major) {
  const base = path.join(RUNTIMES_DIR, `temurin-${major}`);
  if (!fs.existsSync(base)) return null;
  let entries;
  try { entries = fs.readdirSync(base); } catch (_) { return null; }
  // Temurin archives extract to a top-level folder like "jdk-21.0.3+9-jre".
  for (const name of entries) {
    const candidate = path.join(base, name, 'bin', JAVA_EXE);
    if (fs.existsSync(candidate)) return candidate;
  }
  const flat = path.join(base, 'bin', JAVA_EXE);
  return fs.existsSync(flat) ? flat : null;
}

// Major version of the `java` on PATH, or null if none / unparseable. Cached.
let _systemJavaMajor; // undefined = not probed yet
function systemJavaMajor() {
  if (_systemJavaMajor !== undefined) return _systemJavaMajor;
  _systemJavaMajor = null;
  try {
    const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
    if (m) {
      const a = Number(m[1]);
      _systemJavaMajor = a === 1 ? Number(m[2] || 0) : a; // "1.8.0" -> 8
    }
  } catch (_) { /* no java on PATH */ }
  return _systemJavaMajor;
}

// Pick the java to launch a server with: explicit per-server override, then a
// managed runtime, then the system java if its major matches. null => the
// managed runtime must be downloaded first.
function resolveJavaForServer(d, major) {
  if (d.javaPath && fs.existsSync(d.javaPath)) return d.javaPath;
  const managed = resolveManagedJava(major);
  if (managed) return managed;
  if (systemJavaMajor() === major) return 'java';
  return null;
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}
function adoptiumArch() {
  switch (process.arch) {
    case 'x64': return 'x64';
    case 'arm64': return 'aarch64';
    case 'ppc64': return 'ppc64le';
    case 's390x': return 's390x';
    default: return 'x64';
  }
}

// Download + extract the Temurin JRE for a Java major. Concurrent calls for the
// same major share one download. Resolves to the java binary path.
const _runtimePromises = {};
function ensureRuntime(major, onProgress) {
  const existing = resolveManagedJava(major);
  if (existing) return Promise.resolve(existing);
  if (_runtimePromises[major]) return _runtimePromises[major];

  const p = (async () => {
    fs.mkdirSync(RUNTIMES_DIR, { recursive: true });
    const osName = adoptiumOs();
    const arch = adoptiumArch();
    const ext = osName === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
    const dest = path.join(RUNTIMES_DIR, `temurin-${major}`);
    const archive = path.join(RUNTIMES_DIR, `temurin-${major}.${ext}`);

    log(`JRE ${major}: downloading Temurin for ${osName}/${arch} from ${url}`);
    let nextPct = 0;
    await downloadToFile(url, archive, (rec, total) => {
      if (onProgress) onProgress(rec, total);
      if (total) {
        const pct = Math.floor((rec / total) * 100);
        if (pct >= nextPct) { log(`JRE ${major}: download ${pct}% (${(rec / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`); nextPct += 25; }
      }
    });
    log(`JRE ${major}: extracting...`);

    // Extract into a clean target. Unix/macOS Temurin archives are .tar.gz
    // and use the system tar; Windows Temurin archives are .zip and are
    // unpacked with Node so Hostkind does not depend on bsdtar zip support.
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    fs.mkdirSync(dest, { recursive: true });
    extractRuntimeArchive(archive, dest, ext);
    try { fs.unlinkSync(archive); } catch (_) { /* ignore */ }

    const bin = resolveManagedJava(major);
    if (!bin) throw new Error('Java runtime extracted but no java binary was found');
    log(`Temurin JRE ${major} ready at ${bin}`);
    return bin;
  })();

  _runtimePromises[major] = p;
  p.finally(() => { delete _runtimePromises[major]; });
  return p;
}

app.post('/api/create', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').toLowerCase();
  const gameType = String(body.gameType || (['custom', 'terraria', 'valheim', 'palworld'].includes(type) ? type : 'minecraft')).toLowerCase();
  const name = String(body.name || '').trim();
  if (gameType !== 'minecraft') {
    if (body.automatic && ['terraria', 'valheim', 'palworld'].includes(gameType)) {
      const parentDir = String(body.parentDir || '').trim();
      const port = Number(body.port);
      const maxPlayers = Number(body.maxPlayers);
      const worldName = String(body.worldName || '').trim();
      const serverName = String(body.serverName || name).trim();
      const password = String(body.password || '');
      if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
      if (name.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
      if (!parentDir || !fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });
      const maxPort = gameType === 'valheim' ? 65533 : (gameType === 'palworld' ? 65534 : 65535);
      if (!Number.isInteger(port) || port < 1 || port > maxPort) return res.status(400).json({ error: 'Choose a valid server port.' });
      const maxPlayerLimit = gameType === 'terraria' ? 255 : (gameType === 'valheim' ? 10 : 32);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > maxPlayerLimit) return res.status(400).json({ error: 'Choose a valid player limit.' });
      if (!worldName) return res.status(400).json({ error: 'World name is required.' });
      if (gameType === 'valheim' && password.length < 5) return res.status(400).json({ error: 'Valheim requires a password with at least 5 characters.' });

      /*
       * Terraria's extra creation inputs (docs/terraria/01-installation-versions.md
       * step 4). Everything that can be refused is refused here, before the
       * NDJSON stream opens and before anything is downloaded: an omitted
       * variant is the legacy meaning (vanilla), an unknown one is an error,
       * and the world name and seed go through the installer's own rules so
       * the wizard and a scripted POST get the same answer.
       */
      let terraria = null;
      if (gameType === 'terraria') {
        const variant = String(body.terrariaVariant || 'vanilla').toLowerCase();
        if (!terrariaVariants.isVariant(variant)) return res.status(400).json({ error: `Unknown Terraria variant: ${variant}` });
        try {
          terraria = {
            variant,
            versionId: String(body.versionId || '').trim(),
            worldName: terrariaInstall.normalizeWorldName(worldName),
            seed: terrariaInstall.normalizeSeed(body.seed),
            motd: String(body.motd || '').trim(),
          };
        } catch (error) {
          return res.status(error.status || 400).json({ error: error.message, code: error.code });
        }
        if (terraria.motd.length > 200) return res.status(400).json({ error: 'The message of the day is limited to 200 characters.' });
        let portTaken = false;
        try { portTaken = await probePortInUse(port, '0.0.0.0'); } catch (_) { /* a failed probe must not block creation */ }
        if (portTaken) return res.status(400).json({ error: `Port ${port} is already in use. Choose another port.` });
      }

      const dir = path.join(parentDir, slugify(name));
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const send = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
      const cacheDir = INSTALLER_CACHE_DIR;
      fs.mkdirSync(cacheDir, { recursive: true });
      try {
        const adminPassword = gameType === 'palworld' ? crypto.randomBytes(32).toString('base64url') : undefined;
        const restPort = gameType === 'palworld' ? port + 1 : undefined;
        const install = {
          destination: dir, port, maxPlayers, worldName, serverName, password,
          adminPassword, restPort,
          public: body.public !== false,
          worldSize: [1, 2, 3].includes(Number(body.worldSize)) ? Number(body.worldSize) : 2,
          difficulty: [0, 1, 2, 3].includes(Number(body.difficulty)) ? Number(body.difficulty) : 0,
        };
        if (terraria) {
          install.worldName = terraria.worldName;
          install.seed = terraria.seed;
          install.motd = terraria.motd;
          install.versionId = terraria.versionId;
        }
        const installOptions = {
          cacheDir,
          download: (url, target, progress) => downloadToFile(url, target, (received, total) => progress(received, total)),
          onPhase: (phase) => send({ type: 'phase', phase }),
          onProgress: (received, total) => send({ type: 'progress', received, total }),
          onOutput: (line) => send({ type: 'output', line }),
        };
        // Terraria resolves its own versions, so it is given no `fetchText`:
        // the installer's fetch keeps the HTTP status, which is how a GitHub
        // rate limit is told apart from an unreachable source.
        const runtime = terraria
          ? await terrariaInstall.install(terraria.variant, install, installOptions)
          : await installDedicatedServer(gameType, install, { ...installOptions, fetchText });
        const entry = {
          id: genId(), type: gameType, name, dir, cwd: runtime.cwd || path.dirname(runtime.executable),
          executable: runtime.executable, args: runtime.args,
          port, maxPlayers, worldName, serverName,
        };
        if (gameType === 'valheim') {
          entry.valheimSchema = 1;
          entry.password = password;
          entry.valheimSaveDir = 'data';
          entry.valheimBackend = 'steam';
          entry.valheimPublic = body.public !== false;
          entry.valheimInstanceId = null;
          entry.valheimBuildId = runtime.buildId || null;
          entry.valheimSettings = {};
          entry.valheimExtraArgs = ['-nographics', '-batchmode'];
          // New descriptors are generated from structured fields. The
          // installer's argv is not persisted because it contains the
          // password and duplicates Hostkind-owned flags.
          entry.args = [];
        }
        if (gameType === 'palworld') {
          entry.adminPassword = adminPassword;
          entry.restPort = restPort;
        }
        if (terraria) {
          entry.terrariaVariant = terraria.variant;
          entry.terrariaVersion = runtime.version;
          // Server-relative (docs/terraria/00-baseline-contracts.md "Freeze the
          // descriptor"): the installer answers with an absolute path because
          // it is the one writing it into serverconfig.txt, and the descriptor
          // never carries an absolute path.
          entry.terrariaSaveDir = path.relative(dir, runtime.saveDir).split(path.sep).join('/');
          // Deliberately no `file` yet. A freshly created server has an
          // `autocreate` config and no world on disk: the first start makes it.
          // Writing the path here would make `preLaunch` refuse that very first
          // start for a world that is *supposed* to be missing, and the world
          // module reads the selection from serverconfig.txt until a selection
          // (phase 3) writes both halves.
          entry.terrariaWorld = { name: runtime.worldName };
        }
        entry.stopTimeoutSeconds = 30;
        entry.watchdog = { enabled: false, maxRestarts: 3, windowMinutes: 10 };
        const previousActiveServerId = config.activeServerId;
        config.servers.push(entry);
        if (!config.activeServerId) config.activeServerId = entry.id;
        try {
          saveConfig(config);
          runtime.finalize?.();
        } catch (error) {
          config.servers = config.servers.filter((server) => server.id !== entry.id);
          config.activeServerId = previousActiveServerId;
          runtime.rollbackPromotion?.();
          throw error;
        }
        getManager(entry.id);
        addNotification('server_created', 'Server Created', `${gameType} server "${name}" installed.`, entry.id);
        log(`Installed ${gameType} server "${name}"`);
        send({ type: 'done', server: serverWithStatus(entry) });
        return res.end();
      } catch (err) {
        log(`${gameType} install failed:`, err.message);
        send({ type: 'error', error: err.message });
        return res.end();
      }
    }
    let value;
    try {
      value = validateManualRegistration({ ...body, gameType }, { maxNameLength: SERVER_NAME_MAX_LENGTH });
    } catch (err) {
      return httpError(res, req, err, 400);
    }

    const entry = {
      id: genId(),
      ...value,
      watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    };
    config.servers.push(entry);
    if (!config.activeServerId) config.activeServerId = entry.id;
    saveConfig(config);
    getManager(entry.id);
    addNotification('server_created', 'Process Created', `${gameType} process "${name}" registered.`, entry.id);
    log(`Registered ${gameType} process "${name}"`);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.write(JSON.stringify({ type: 'done', server: serverWithStatus(entry) }) + '\n');
    return res.end();
  }

  const parentDir = String(body.parentDir || '').trim();
  const mcVersion = String(body.mcVersion || '').trim();
  if (!SERVER_TYPES.includes(type)) return res.status(400).json({ error: tErr(req.user, 'errors.pickServerType') });
  if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
  if (name.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
  if (!parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });
  if (!mcVersion) return res.status(400).json({ error: tErr(req.user, 'errors.pickMcVersion') });
  if (!body.eula) return res.status(400).json({ error: tErr(req.user, 'errors.eulaRequired') });

  const dir = path.join(parentDir, slugify(name));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
  }

  // NDJSON stream: each line is a JSON event. Phases:
  //   {type:"start", phase:"resolving"}
  //   {type:"phase", phase:"downloading"}
  //   {type:"download-start", total, filename}
  //   {type:"progress", received, total}    (repeated while downloading)
  //   {type:"phase", phase:"installing-forge"}    (forge only)
  //   {type:"phase", phase:"installing-neoforge"} (neoforge only)
  //   {type:"phase", phase:"finalizing"}
  //   {type:"done", server}                  (terminal)
  //   {type:"error", error}                  (terminal)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (obj) => {
    if (res.writableEnded) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (_) { /* noop */ }
  };

  const ac = new AbortController();
  let clientGone = false;
  // Detect a real client disconnect via the *response* stream. (Listening on
  // req.on('close') is wrong: on Node 18+ the request emits 'close' as soon as
  // its body has been read - immediately for a small POST - which would abort
  // the download before it even starts.)
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    ac.abort();
  });

  const cleanup = (jarName) => {
    try { if (jarName) fs.unlinkSync(path.join(dir, jarName)); } catch (_) { /* ignore */ }
    try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) { /* ignore */ }
  };

  try {
    log(`Create: ${type} server "${name}" (MC ${mcVersion}) -> ${dir}`);
    send({ type: 'phase', phase: 'resolving' });
    log(`Create: resolving ${type} ${mcVersion} download...`);
    const { url, filename } = await resolveServerJar(type, mcVersion);
    if (clientGone) return;
    log(`Create: resolved -> ${url}`);

    fs.mkdirSync(dir, { recursive: true });
    const jarPath = path.join(dir, filename);

    send({ type: 'phase', phase: 'downloading' });
    send({ type: 'download-start', total: 0, filename });
    log(`Create: downloading ${filename}...`);
    let nextPct = 0;
    const received = await downloadToFile(url, jarPath, (rec, total) => {
      send({ type: 'progress', received: rec, total });
      if (total) {
        const pct = Math.floor((rec / total) * 100);
        if (pct >= nextPct) { log(`Create: download ${pct}% (${(rec / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`); nextPct += 25; }
      }
    }, ac.signal);
    if (clientGone) { cleanup(filename); return; }
    log(`Create: downloaded "${filename}" (${(received / 1048576).toFixed(1)} MB)`);

    let jarFilename = filename;
    let launchArgs = null;
    if (type === 'forge' || type === 'neoforge') {
      const label = type === 'neoforge' ? 'NeoForge' : 'Forge';
      send({ type: 'phase', phase: type === 'neoforge' ? 'installing-neoforge' : 'installing-forge' });
      const major = requiredJavaMajor(mcVersion);
      let javaBin = resolveJavaForServer({ mcVersion }, major);
      if (!javaBin) {
        log(`Create: ${label} installer needs Java ${major}; preparing managed runtime...`);
        javaBin = await ensureRuntime(major, (rec, total) => {
          if (total) send({ type: 'progress', received: rec, total });
        });
      }
      await runForgeInstaller(dir, filename, label, javaBin);
      if (clientGone) { cleanup(filename); return; }
      const produced = findForgeLaunchTarget(dir, type);
      if (!produced) throw new Error(`${label} installer finished but no server jar or launch args file was found in the folder`);
      jarFilename = produced.jar;
      launchArgs = produced.launchArgs;
    }

    send({ type: 'phase', phase: 'finalizing' });
    log('Create: writing eula.txt and registering server...');
    fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted via Hostkind on ${new Date().toISOString()}\neula=true\n`, 'utf8');

    let javaArgs = body.javaArgs;
    if (typeof javaArgs === 'string') javaArgs = javaArgs.trim().split(/\s+/).filter(Boolean);
    if (!Array.isArray(javaArgs) || !javaArgs.length) javaArgs = ['-Xmx4G', '-Xms4G'];

    const entry = {
      id: genId(),
      type: 'minecraft',
      name,
      dir,
      jar: jarFilename,
      loader: type,
      launchArgs,
      javaArgs,
      mcVersion,
      stopTimeoutSeconds: 30,
      worlds: ['world', 'world_nether', 'world_the_end'],
      watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    };
    config.servers.push(entry);
    if (!config.activeServerId) config.activeServerId = entry.id;
    saveConfig(config);
    getManager(entry.id);
    addNotification('server_created', 'Server Created', `Server "${name}" (${type}, MC ${mcVersion}) created at ${dir}.`, entry.id);
    log(`Created ${type} server "${name}" (${mcVersion}) at ${dir}`);

    send({ type: 'done', server: serverWithStatus(entry) });
    res.end();
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message === 'aborted' || clientGone)) {
      // Client disconnected - keep what we have on disk for inspection but
      // don't register the server.
      try { log(`Create aborted by client before completion: ${dir}`); } catch (_) { /* noop */ }
      return;
    }
    log(`Create failed (${type} ${mcVersion}): ${err.message}`);
    send({ type: 'error', error: err.message });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Scheduled tasks
//
// A task is `{ trigger, action }` (docs/palworld/05-automation.md). Cron and
// interval triggers are time-based; player-joined, server-empty and
// update-available are condition-based and evaluated by the automation tick
// below against observed state. Legacy `{ type, cron }` tasks migrate to the
// versioned shape with identical behaviour, and both fields stay on the object
// so the node-cron scheduling path is unchanged.
// ---------------------------------------------------------------------------

function publicTask(t) {
  const s = findServer(t.serverId);
  const task = automation.migrateTask(t);
  return {
    ...task,
    serverName: s ? s.name : '(deleted server)',
    serverType: s ? s.type || 'minecraft' : null,
    capability: automation.capabilityForAction(task.action),
    state: taskState(t.id),
    preview: automation.previewTrigger(task.trigger, { lastFireAt: taskState(t.id).lastFireAt }),
  };
}

function validateTask(body) {
  const serverId = String(body.serverId || '').trim();
  const server = findServer(serverId);
  if (!server) return { error: eKey('errors.unknownServer') };
  const normalized = automation.normalizeTask(body, {
    serverType: server.type || 'minecraft',
    validateCron: (expression) => cron.validate(expression),
  });
  if (normalized.error) return { error: eKey(normalized.error) };
  return { value: { serverId, ...normalized.value } };
}

// --- persisted trigger state ------------------------------------------------

let taskStateDirty = false;

function taskState(id) {
  if (!config.taskState || typeof config.taskState !== 'object') config.taskState = {};
  return automation.safeState(config.taskState[id]);
}

function setTaskState(id, next) {
  if (!config.taskState || typeof config.taskState !== 'object') config.taskState = {};
  const value = automation.safeState(next);
  // A tick that only re-observes the same world does not deserve a disk write;
  // config.json is rewritten only when a decision actually moved.
  const meaningful = (state) => JSON.stringify({ ...state, lastObservationAt: null });
  if (meaningful(config.taskState[id] || {}) !== meaningful(value)) taskStateDirty = true;
  config.taskState[id] = value;
}

function flushTaskState() {
  if (!taskStateDirty) return;
  taskStateDirty = false;
  // Drop state for tasks that no longer exist so config.json cannot grow
  // without bound.
  const live = new Set((config.tasks || []).map((task) => task.id));
  for (const id of Object.keys(config.taskState || {})) if (!live.has(id)) delete config.taskState[id];
  saveConfig(config);
}

// --- observation ------------------------------------------------------------

// Sessions started by automation are remembered so a "stop when empty" policy
// can treat them differently from a session an operator started by hand.
const automationSessions = new Map();

function markAutomationSession(m) {
  automationSessions.set(m.id, { markedAt: Date.now(), startedAt: null });
}

/*
 * A session counts as automatic when it is the one that followed an automation
 * start. The first observed session after the mark is bound to it, so a later
 * manual start of the same server is correctly reported as manual.
 */
function sessionOrigin(m) {
  const record = automationSessions.get(m.id);
  if (!record || !m.startedAt) return 'manual';
  if (record.startedAt) return record.startedAt === m.startedAt ? 'automatic' : 'manual';
  if (m.startedAt >= record.markedAt - 5_000 && Date.now() - record.markedAt < 5 * 60_000) {
    record.startedAt = m.startedAt;
    return 'automatic';
  }
  return 'manual';
}

/*
 * What we actually know right now. `healthy` means "this reading can be
 * trusted": for Palworld that is REST health, never the process being up.
 */
function automationObservation(serverDesc) {
  const m = getManager(serverDesc.id);
  const state = (m && m.moduleState) || {};
  const palworld = (serverDesc.type || '') === 'palworld';
  const restHealthy = state.restHealth ? state.restHealth.state === 'healthy' : false;
  const playerCount = state.normalizedStatus && Number.isFinite(Number(state.normalizedStatus.playerCount))
    ? Number(state.normalizedStatus.playerCount)
    : null;
  let generic = null;
  if (!palworld && m && m.status === 'online') {
    try { generic = (m.module().listPlayers(m) || []).length; } catch (_) { generic = null; }
  }
  return {
    status: m ? m.status : 'offline',
    healthy: palworld ? restHealthy : !!m && m.status === 'online',
    playerCount: palworld ? playerCount : generic,
    players: palworld ? (state.players || []) : [],
    startedAt: m ? m.startedAt : null,
    sessionOrigin: m ? sessionOrigin(m) : null,
  };
}

// --- actions ----------------------------------------------------------------

function auditAutomation(task, outcome, metadata = {}, operationId = null) {
  try {
    foundationAudit.record({
      serverId: task.serverId,
      action: `schedule.${task.action ? task.action.kind : task.type}`,
      targetType: 'server',
      targetId: task.serverId,
      outcome,
      operationId,
      metadata: { taskId: task.id, taskName: task.name, trigger: task.trigger ? task.trigger.kind : 'cron', ...metadata },
    });
  } catch (error) {
    log('audit: automation capture failed:', error.message);
  }
}

function palworldAnnounce(m, message) {
  return m.module().mutate(m, 'announce', { message });
}

async function palworldGracefulRestart(m, action) {
  const seconds = Math.max(0, Number(action.announceSeconds) || 0);
  if (m.status === 'online' && seconds) {
    await palworldAnnounce(m, automation.renderTemplate(action.message, { seconds }));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  if (m.status === 'online') await m.module().mutate(m, 'save', {});
  markAutomationSession(m);
  m.restart();
}

async function runPalworldUpdatePolicy(serverDesc) {
  // Re-run the policy check immediately instead of waiting for its interval.
  const tracked = palworldAutoChecks.get(serverDesc.id) || {};
  palworldAutoChecks.set(serverDesc.id, { ...tracked, checkedAt: 0, running: false });
  await checkPalworldAutomaticUpdates();
}

/*
 * Executes a task's action. Condition-based bookkeeping (empty countdown, join
 * cooldowns, backup catch-up) lives in the tick; this only performs the effect.
 */
async function runTaskAction(task, { message = null } = {}) {
  const t = automation.migrateTask(task);
  const m = getManager(t.serverId);
  const serverDesc = findServer(t.serverId);
  if (!m || !serverDesc) throw new Error('The task targets a server that no longer exists.');
  const action = t.action;
  switch (action.kind) {
    case 'command':
      if (m.status !== STATUS.ONLINE) return { ok: true, skipped: 'server_offline' };
      m.sendCommand(action.command);
      return { ok: true };
    case 'restart':
      // Palworld never gets the console warning countdown: it restarts through
      // the official announce + save + shutdown sequence instead.
      if ((serverDesc.type || '') === 'palworld') {
        await palworldGracefulRestart(m, { announceSeconds: 0, message: '' });
      } else {
        markAutomationSession(m);
        doScheduledRestart(m);
      }
      return { ok: true };
    case 'backup':
      await createBackup(m);
      return { ok: true };
    case 'backup-offline':
      await createBackup(m, { offline: true });
      return { ok: true };
    case 'say':
      if (m.status !== STATUS.ONLINE) return { ok: true, skipped: 'server_offline' };
      m.sendCommand(`say ${action.message}`);
      return { ok: true };
    case 'announce':
      if (m.status !== 'online') throw new Error('The server must be online to announce.');
      await palworldAnnounce(m, message || action.message);
      return { ok: true };
    case 'save':
      if (m.status !== 'online') throw new Error('The server must be online to save.');
      await m.module().mutate(m, 'save', {});
      return { ok: true };
    case 'graceful-restart':
      await palworldGracefulRestart(m, action);
      return { ok: true };
    case 'apply-update-policy':
      await runPalworldUpdatePolicy(serverDesc);
      return { ok: true };
    case 'stop-when-empty': {
      if (message) await palworldAnnounce(m, message);
      else m.stop(false);
      return { ok: true };
    }
    default:
      throw new Error('Unknown task action.');
  }
}

function fireTask(task, { message = null, reason = 'trigger' } = {}) {
  const state = taskState(task.id);
  setTaskState(task.id, { ...state, lastFireAt: Date.now(), missedAt: null });
  return runTaskAction(task, { message })
    .then(() => auditAutomation(task, 'success', { reason }))
    .catch((error) => {
      auditAutomation(task, 'failure', { reason, error: error.message });
      log(`Scheduled task "${task.name}" failed: ${error.message}`);
    });
}

// --- condition-based evaluation --------------------------------------------

const UPDATE_TRIGGER_INTERVAL_MS = 15 * 60_000;
const updateTriggerChecks = new Map();

/*
 * Runs every AUTOMATION_TICK_MS. Every branch is decided by the pure module so
 * the rules (paused countdowns, cooldowns, catch-up, one-shot updates) are the
 * ones covered by test/palworld-automation.test.cjs.
 */
async function runAutomationTick(now = Date.now()) {
  const observations = new Map();
  for (const task of (config.tasks || [])) {
    if (task.enabled === false) continue;
    const t = automation.migrateTask(task);
    const serverDesc = findServer(t.serverId);
    if (!serverDesc) continue;
    if (!observations.has(t.serverId)) observations.set(t.serverId, automationObservation(serverDesc));
    const observation = observations.get(t.serverId);
    const state = taskState(t.id);
    try {
      if (t.trigger.kind === 'interval') {
        const decision = automation.intervalDecision({ trigger: t.trigger, state, now });
        setTaskState(t.id, { ...state, ...decision.state, lastObservationAt: now });
        if (decision.action === 'run') await fireTask(t, { reason: decision.reason });
        continue;
      }
      if (t.trigger.kind === 'server-empty') {
        const decision = automation.emptyDecision({ policy: { ...t.trigger, ...t.action }, state: state.empty, observation, now });
        setTaskState(t.id, {
          ...state,
          empty: decision.state,
          lastObservationAt: now,
          cancelledReason: decision.state.cancelledReason || null,
        });
        if (decision.action === 'announce') await fireTask(t, { message: decision.message, reason: 'empty_grace' });
        else if (decision.action === 'stop') await fireTask(t, { reason: 'empty' });
        continue;
      }
      if (t.trigger.kind === 'player-joined') {
        const decision = automation.joinDecision({ trigger: t.trigger, action: t.action, state: state.join, observation, now });
        setTaskState(t.id, { ...state, join: decision.state, lastObservationAt: now, cancelledReason: decision.cancelled.length ? decision.cancelled[0].reason : null });
        for (const item of decision.due) await fireTask(t, { message: item.message, reason: 'player_joined' });
        continue;
      }
      if (t.trigger.kind === 'update-available') {
        if ((serverDesc.type || '') !== 'palworld') continue;
        // Steam metadata is expensive to fetch; the tick is not the place to
        // poll it faster than the discovery cache would answer anyway.
        if (now - (updateTriggerChecks.get(t.id) || 0) < UPDATE_TRIGGER_INTERVAL_MS) continue;
        updateTriggerChecks.set(t.id, now);
        const latest = await palworldLatest(false);
        const update = await palworldUpdates.status({ server: serverDesc, manager: getManager(t.serverId), latest });
        const decision = automation.updateDecision({ state: state.update, updateState: update.state, buildId: latest.buildId, now });
        setTaskState(t.id, { ...state, update: decision.state, lastObservationAt: now });
        if (decision.action === 'run') await fireTask(t, { reason: 'update_ready' });
        continue;
      }
      // Cron tasks: only the deferred backup catch-up needs a tick.
      if (t.action.kind === 'backup' && state.backup.missed) {
        const decision = automation.backupCatchUp({ state: state.backup, observation, now });
        setTaskState(t.id, { ...state, backup: decision.state, lastObservationAt: now });
        if (decision.action === 'run') await fireTask(t, { reason: 'backup_catch_up' });
      }
    } catch (error) {
      log(`Automation tick failed for task "${t.name}": ${error.message}`);
    }
  }
  flushTaskState();
}

/*
 * At boot we reconcile instead of replaying every occurrence the panel slept
 * through: at most one catch-up run per task, and only for a recent miss.
 */
function reconcileTasks(now = Date.now()) {
  for (const task of (config.tasks || [])) {
    if (task.enabled === false) continue;
    const t = automation.migrateTask(task);
    if (!findServer(t.serverId)) continue;
    const state = taskState(t.id);
    const decision = automation.reconcile({ trigger: t.trigger, state, now });
    setTaskState(t.id, { ...state, ...decision.state });
    if (decision.action === 'run') {
      log(`Reconcile: running missed task "${t.name}"`);
      fireTask(t, { reason: 'reconcile_catch_up' });
    } else if (decision.action === 'skip') {
      auditAutomation(t, 'skipped', { reason: decision.reason, missedAt: decision.missedAt });
      log(`Reconcile: skipping missed task "${t.name}" (${decision.reason})`);
    }
  }
  flushTaskState();
}

/*
 * The cron path. A backup task can refuse to churn identical archives while
 * the server sits offline, optionally catching up once it is healthy again.
 */
function runTask(t) {
  const task = automation.migrateTask(t);
  const serverDesc = findServer(task.serverId);
  if (!serverDesc) return Promise.resolve();
  if (['backup', 'backup-offline'].includes(task.action.kind)) {
    const state = taskState(task.id);
    const observation = automationObservation(serverDesc);
    const decision = automation.backupDecision({ action: task.action, state: state.backup, observation });
    const skip = (reason) => {
      auditAutomation(task, 'skipped', { reason });
      log(`Scheduled backup skipped for "${serverDesc.name}": ${reason}`);
      flushTaskState();
      return Promise.resolve();
    };
    setTaskState(task.id, { ...state, backup: decision.state });
    if (decision.action === 'skip') return skip(decision.reason);
    // An offline server whose save data has not changed would produce an
    // archive identical to the last one; refusing to create it is what keeps
    // retention from evicting meaningful online saves.
    const manifest = saveManifest(getManager(task.serverId));
    if (manifest && observation.status !== 'online' && automation.isDuplicateArchive(manifest, state.backup)) {
      return skip('identical_content');
    }
    setTaskState(task.id, {
      ...state,
      backup: { ...decision.state, lastRunAt: Date.now(), lastFingerprint: automation.archiveFingerprint(manifest) },
    });
  }
  return fireTask(task, { reason: 'cron' });
}

/*
 * Content metadata for the files a backup would archive: every file's path,
 * size, and last write, read from disk. It is compared only against the
 * previous scheduled archive of the same server to notice that nothing changed,
 * never used as a substitute for the backup itself.
 */
function saveManifest(m) {
  if (!m || !m.dir()) return null;
  const mod = m.module();
  const selection = mod.backupSelection ? mod.backupSelection(m.desc()) : (m.desc().worlds || []);
  const entries = [];
  const walk = (dir, prefix) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const item of items) {
      if (entries.length > 20_000) return;
      const full = path.join(dir, item.name);
      const rel = `${prefix}/${item.name}`;
      if (item.isDirectory()) walk(full, rel);
      else {
        try {
          const stat = fs.statSync(full);
          entries.push({ path: rel, size: stat.size, digest: String(Math.trunc(stat.mtimeMs)) });
        } catch (_) { /* the file vanished mid-walk */ }
      }
    }
  };
  for (const item of selection) {
    const full = path.join(m.dir(), item);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, item);
      else if (stat.isFile()) entries.push({ path: item, size: stat.size, digest: String(Math.trunc(stat.mtimeMs)) });
    } catch (_) { /* optional selection entry is absent */ }
  }
  return entries.length ? { entries } : null;
}

function requireTaskActionCapability(req, res, task) {
  const capability = automation.capabilityForAction(automation.migrateTask(task).action);
  if (!foundationCapabilities.has(req.user, task.serverId, capability)) {
    res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability });
    return false;
  }
  return true;
}

app.get('/api/tasks', (req, res) => {
  res.json({ tasks: (config.tasks || []).map(publicTask) });
});

app.post('/api/tasks/preview', (req, res) => {
  const v = validateTask(req.body || {});
  if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
  res.json({
    ok: true,
    preview: automation.previewTrigger(v.value.trigger, { lastFireAt: taskState(req.body.id).lastFireAt }),
    capability: automation.capabilityForAction(v.value.action),
  });
});

app.post('/api/tasks', (req, res) => {
  const v = validateTask(req.body || {});
  if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
  if (!requireTaskActionCapability(req, res, v.value)) return;
  if (!Array.isArray(config.tasks)) config.tasks = [];
  const task = { id: genId(), ...v.value };
  config.tasks.push(task);
  saveConfig(config);
  setupSchedulers();
  res.json({ ok: true, task: publicTask(task) });
});

app.put('/api/tasks/:id', (req, res) => {
  const t = (config.tasks || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
  const v = validateTask({ ...automation.migrateTask(t), ...req.body });
  if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
  if (!requireTaskActionCapability(req, res, v.value) || !requireTaskActionCapability(req, res, t)) return;
  for (const key of ['trigger', 'action', 'cron', 'command', 'type']) delete t[key];
  Object.assign(t, v.value);
  saveConfig(config);
  setupSchedulers();
  res.json({ ok: true, task: publicTask(t) });
});

app.delete('/api/tasks/:id', (req, res) => {
  if (!Array.isArray(config.tasks)) config.tasks = [];
  const before = config.tasks.length;
  config.tasks = config.tasks.filter((x) => x.id !== req.params.id);
  if (config.tasks.length === before) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
  if (config.taskState) delete config.taskState[req.params.id];
  saveConfig(config);
  setupSchedulers();
  res.json({ ok: true });
});

// Running a task by hand never bypasses the permission its action requires.
app.post('/api/tasks/:id/run', async (req, res) => {
  const t = (config.tasks || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
  if (!requireTaskActionCapability(req, res, t)) return;
  try {
    await runTask(t);
    res.json({ ok: true });
  } catch (err) {
    httpError(res, req, err, 500);
  }
});

// ---------------------------------------------------------------------------
// Static files (last, so they don't shadow /api)
// ---------------------------------------------------------------------------

app.use('/resources', express.static(path.join(__dirname, 'resources')));
app.use(express.static(path.join(__dirname, 'public')));

// The SPA rewrites the document title after mount, but a branded install must
// not flash the stock product name in the tab (or on the login screen) while
// the bundle loads. Inject the resolved panel name into the shell we serve.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// SPA fallback: any non-API GET that didn't match a real static file returns
// the app shell, so client-side routes (e.g. /console, /users) keep working on
// direct navigation and on refresh. API and resource paths are left alone.
app.get('*', rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}), (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/api') return next();
  if (req.path.startsWith('/resources/')) return next();
  const index = path.join(__dirname, 'public', 'index.html');
  let html;
  try {
    html = fs.readFileSync(index, 'utf8');
  } catch (_) {
    return res.status(404).type('text').send('Missing build: run `npm run build` first.');
  }
  const title = branding.resolve(config).name;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  res.type('html').send(html);
});

// ---------------------------------------------------------------------------
// Global error handler (last: catches anything that reached next(err))
// ---------------------------------------------------------------------------

// Anything that throws inside a handler or calls next(err) lands here. Log
// the full error server-side; never leak stack traces or filesystem paths to
// clients. A broken request must never take the panel down.
// NOTE: this must stay the LAST app.use registered, after every route,
// otherwise routes registered below it bypass the handler.
function registerGlobalErrorHandler() {
  app.use((err, req, res, next) => {
    log('unhandled route error:', err && err.stack || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: sanitizeErrorMessage(err && err.message) });
  });
}

// ---------------------------------------------------------------------------
// System resources (monitor)
// ---------------------------------------------------------------------------

let lastCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!lastCpu) {
    lastCpu = { idle, total };
    return 0;
  }
  const idleDiff = idle - lastCpu.idle;
  const totalDiff = total - lastCpu.total;
  lastCpu = { idle, total };
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

function diskFree(p) {
  return new Promise((resolve) => {
    try {
      fs.statfs(p, (err, st) => {
        if (err) return resolve(null);
        resolve({ free: st.bavail * st.bsize, total: st.blocks * st.bsize });
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function systemStats(m) {
  const sysTotal = os.totalmem();
  const sysFree = os.freemem();
  let proc = { cpu: 0, memory: 0 };
  const pid = m ? m.pid() : null;
  if (pid) {
    try {
      const u = await procUsage(pid);
      // procUsage sums CPU across all cores (can exceed 100%); normalize to 0-100
      const cores = os.cpus().length || 1;
      proc = { cpu: Math.min(100, (u ? u.cpu : 0) / cores), memory: u ? u.memory : 0 };
    } catch (_) { /* the process may have died */ }
  }
  const disk = await diskFree(backupsDir() && backupsDir().length ? path.parse(backupsDir()).root : os.homedir());
  return {
    ts: Date.now(),
    serverId: m ? m.id : null,
    cpuSystem: cpuPercent(),
    memSystemUsed: sysTotal - sysFree,
    memSystemTotal: sysTotal,
    procCpu: proc.cpu,
    procMem: proc.memory,
    disk,
    tps: m && m.moduleState ? m.moduleState.lastTps : null,
    status: m ? m.status : 'offline',
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const notifications = [];
const MAX_NOTIFICATIONS = 200;

function addNotification(type, title, message, serverId, i18nMeta = {}) {
  const n = {
    id: genId(),
    type,
    title,
    message,
    ...i18nMeta,
    serverId: serverId || null,
    read: false,
    timestamp: Date.now(),
  };
  notifications.unshift(n);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.pop();
  globalBroadcast({ type: 'notification', notification: n });
  return n;
}

// GET /api/notifications
app.get('/api/notifications', (req, res) => {
  res.json({ notifications });
});

// POST /api/notifications/:id/read
app.post('/api/notifications/:id/read', (req, res) => {
  const n = notifications.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Notification not found' });
  n.read = true;
  res.json({ ok: true });
});

// POST /api/notifications/read-all
app.post('/api/notifications/read-all', (req, res) => {
  for (const n of notifications) n.read = true;
  res.json({ ok: true });
});

// POST /api/notifications/clear
app.post('/api/notifications/clear', (req, res) => {
  notifications.length = 0;
  res.json({ ok: true });
});

// DELETE /api/notifications/:id
app.delete('/api/notifications/:id', (req, res) => {
  const idx = notifications.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Notification not found' });
  notifications.splice(idx, 1);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

registerGlobalErrorHandler();

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  // Cross-site WebSocket hijack defense: browsers send an Origin header on
  // WS upgrades. Reject origins we don't recognize (same rule set as the
  // state-changing HTTP middleware above). Non-browser clients without an
  // Origin header still need a valid token below.
  if (req.headers.origin && !originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') || '';
  // Same two-principal resolution as authMiddleware: a key that may read a
  // console can stream it, rather than having the REST surface and the socket
  // disagree about who the caller is.
  const user = (apiKeys.looksLikeApiKey(token) ? apiKeys.verify(token) : userFromToken(token)) || guestUser();
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  req.fleetdeckUser = user;
  wss.handleUpgrade(req, socket, head, (ws) => {
    // The upgrade already resolved the caller; carry that identity onto the
    // socket so the message handler can authorize without re-parsing a token.
    ws.fleetdeckUser = user;
    wss.emit('connection', ws, req);
  });
});

const clients = new Set();

function sendServerSnapshot(ws, id) {
  const m = getManager(id);
  if (!m) return;
  ws.send(JSON.stringify({ type: 'history', serverId: id, lines: m.history }));
  ws.send(JSON.stringify({ type: 'status', status: m.statusPayload() }));
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  const user = req.fleetdeckUser || null;
  ws.userId = user?.id || null;
  // Only the servers this caller may see appear in the handshake. The meta
  // list and the per-server statuses would otherwise leak the registry's
  // shape (names, statuses, counts) to any socket that can connect - the
  // multi-tenant story is exactly that an operator sees only their fleet.
  // Admins and the guest identity pass hasAnyPerServerGrant unconditionally.
  const visibleServers = config.servers.filter((s) => foundationCapabilities.hasAnyPerServerGrant(user, s.id));
  // The active server is derived from the same filter, so an operator never
  // starts attached to a server they cannot see.
  ws.selectedServerId = (config.activeServerId && visibleServers.some((s) => s.id === config.activeServerId))
    ? config.activeServerId
    : null;
  // Meta + a status for each visible server + history of the active one.
  ws.send(JSON.stringify({
    type: 'meta',
    activeServerId: ws.selectedServerId,
    servers: visibleServers.map((s) => ({ id: s.id, name: s.name })),
  }));
  for (const s of visibleServers) {
    const m = getManager(s.id);
    ws.send(JSON.stringify({ type: 'status', status: m.statusPayload() }));
  }
  if (ws.selectedServerId) sendServerSnapshot(ws, ws.selectedServerId);
  // Send existing notifications
  ws.send(JSON.stringify({ type: 'notifications', notifications }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'command' && typeof msg.cmd === 'string') {
      // The socket, unlike a REST request, never went through the capability
      // middleware, so the same commands.run gate /api/command enforces has to
      // be checked here or any token holder can drive any server's console.
      const user = ws.fleetdeckUser || null;
      const serverId = msg.serverId || ws.selectedServerId || config.activeServerId;
      if (!user || !serverId || !foundationCapabilities.has(user, serverId, foundationCapabilities.CAPABILITIES.COMMANDS_RUN)) {
        ws.send(JSON.stringify({ type: 'error', code: 'command_forbidden', error: 'Console command is not allowed' }));
        return;
      }
      // One message is one command, matching the REST route: a newline in the
      // text would run a second command on the same authorization.
      if (/[\r\n\u0000]/.test(msg.cmd) || msg.cmd.length > MAX_COMMAND_LENGTH) {
        ws.send(JSON.stringify({ type: 'error', code: 'command_invalid', error: 'Command must be a single line' }));
        return;
      }
      const m = getManager(serverId);
      if (!m) {
        ws.send(JSON.stringify({ type: 'error', code: 'command_forbidden', error: 'Server not found' }));
        return;
      }
      const result = m.sendCommand(msg.cmd);
      try {
        // The command text is redacted by lib/audit.cjs before storage, so a
        // password typed at a console never reaches the audit table.
        foundationAudit.record({
          actorId: user.id,
          actorUsername: user.username,
          serverId,
          action: 'console.command',
          targetType: 'server',
          targetId: serverId,
          outcome: result && result.ok ? 'success' : 'failure',
          metadata: { command: msg.cmd },
        });
      } catch (err) { log('audit: ws command capture failed:', err.message); }
    } else if (msg.type === 'selectServer' && msg.serverId) {
      const liveUser = config.users.find(user => user.id === ws.userId);
      const allowed = findServer(msg.serverId)
        && liveUser
        && foundationCapabilities.has(liveUser, msg.serverId, foundationCapabilities.CAPABILITIES.CONSOLE_VIEW);
      if (!allowed) {
        ws.send(JSON.stringify({ type: 'error', code: 'server_selection_forbidden', error: 'Server selection is not allowed' }));
        return;
      }
      ws.selectedServerId = msg.serverId;
      sendServerSnapshot(ws, msg.serverId);
    } else if (msg.type === 'getHistory' && msg.serverId === ws.selectedServerId) {
      sendServerSnapshot(ws, ws.selectedServerId);
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function globalBroadcast(obj) {
  const data = JSON.stringify(obj);
  // Live frames scoped to one server (console lines, status, crash events,
  // server metadata) reach only sockets whose caller may see that server; a
  // server-less frame (notifications, etc.) goes to everyone. This mirrors the
  // handshake filter: an operator without a grant on a server never receives
  // its console stream or lifecycle events.
  const visibleTo = (ws) => !obj || obj.serverId == null
    || foundationCapabilities.hasAnyPerServerGrant(ws.fleetdeckUser || null, obj.serverId);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && visibleTo(ws)) {
      try { ws.send(data); } catch (_) { /* noop */ }
    }
  }
}

// Resource stream every 2s, targeted independently for each connection.
setInterval(async () => {
  if (clients.size === 0) return;
  const byServer = new Map();
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    // A socket whose handshake was granted no server (an operator or key
    // without a grant on the active server) must not receive the active
    // server's resource usage just because selectedServerId is null - that
    // would leak process/host stats across the grant boundary every 2s.
    const id = ws.selectedServerId
      || (foundationCapabilities.hasAnyPerServerGrant(ws.fleetdeckUser || null, config.activeServerId) ? config.activeServerId : null);
    if (!id) continue;
    if (!byServer.has(id)) byServer.set(id, systemStats(getManager(id)));
    try {
      const stats = await byServer.get(id);
      ws.send(JSON.stringify({ type: 'stats', serverId: id, stats }));
    } catch (_) { /* connection or process disappeared */ }
  }
}, 2000);

// ---------------------------------------------------------------------------
// Schedulers (cron): backups and scheduled restarts (act on the active server)
// ---------------------------------------------------------------------------

const cronJobs = [];
const palworldAutoChecks = new Map();

async function checkPalworldAutomaticUpdates() {
  const now = Date.now();
  for (const serverDesc of config.servers.filter((item) => item.type === 'palworld')) {
    let policy = palworldUpdates.safePolicy(serverDesc.palworldUpdatePolicy);
    const tracked = palworldAutoChecks.get(serverDesc.id) || {};
    if (tracked.operationId && !tracked.settled) {
      const operation = foundationOperations.get(tracked.operationId);
      if (operation && ['succeeded', 'failed', 'recovery_required', 'cancelled'].includes(operation.state)) {
        const failed = operation.state !== 'succeeded';
        policy.consecutiveFailures = failed ? policy.consecutiveFailures + 1 : 0;
        policy.suspended = failed && policy.consecutiveFailures >= policy.failureThreshold;
        serverDesc.palworldUpdatePolicy = policy;
        saveConfig(config);
        palworldAutoChecks.set(serverDesc.id, { ...tracked, settled: true });
        if (failed) {
          addNotification(
            'palworld_update_failed',
            'Palworld Update Failed',
            policy.suspended
              ? `Automatic updates were suspended for "${serverDesc.name}" after repeated failures.`
              : `Automatic update failed for "${serverDesc.name}". Review the Updates view.`,
            serverDesc.id,
          );
        }
      }
    }
    if (!policy.enabled || policy.suspended) continue;
    const previous = palworldAutoChecks.get(serverDesc.id) || {};
    if (previous.running || now - (previous.checkedAt || 0) < policy.checkIntervalMinutes * 60_000) continue;
    palworldAutoChecks.set(serverDesc.id, { ...previous, running: true, checkedAt: now });
    try {
      const manager = getManager(serverDesc.id);
      const latest = await palworldLatest(false);
      const update = await palworldUpdates.status({ server: serverDesc, manager, latest });
      const detectedAt = previous.buildId === latest.buildId ? previous.detectedAt : now;
      palworldAutoChecks.set(serverDesc.id, { running: false, checkedAt: now, buildId: latest.buildId, detectedAt });
      const decision = palworldUpdates.automaticDecision({
        policy,
        updateState: update.state,
        playerCount: Number(manager.moduleState?.normalizedStatus?.playerCount) || 0,
        detectedAt,
        now,
      });
      if (decision.action !== 'apply') continue;
      const actor = config.users.find((user) => user.role === 'admin');
      if (!actor) continue;
      const plan = await palworldUpdates.preview({
        server: serverDesc,
        manager,
        latest,
        input: {
          announceSeconds: policy.announcementSeconds,
          restart: policy.restart,
          backupRequired: policy.backupRequired,
        },
      });
      const result = await palworldUpdates.apply({
        server: serverDesc,
        manager,
        actorId: actor.id,
        idempotencyKey: `palworld-auto:${serverDesc.id}:${plan.targetBuildId}`,
        plan,
        planRevision: plan.revision,
        ...steamUpdateDeps(),
        announce: async (seconds) => {
          await manager.module().request(manager, 'POST', '/announce', {
            message: `Automatic server update in ${seconds} seconds. Please move to a safe location.`,
          });
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        },
        createBackup: () => createBackup(manager, { applyRetention: false }),
      });
      foundationAudit.record({
        serverId: serverDesc.id,
        action: 'palworld.update.auto',
        target: { fromBuildId: plan.installedBuildId, toBuildId: plan.targetBuildId },
        outcome: result.replay ? 'replayed' : 'started',
        operationId: result.operation.id,
        metadata: { policy },
      });
      palworldAutoChecks.set(serverDesc.id, {
        ...(palworldAutoChecks.get(serverDesc.id) || {}),
        operationId: result.operation.id,
        settled: false,
      });
    } catch (error) {
      palworldAutoChecks.set(serverDesc.id, { ...previous, running: false, checkedAt: now });
      log(`Automatic Palworld update check failed for "${serverDesc.name}": ${error.message}`);
      addNotification('palworld_update_failed', 'Palworld Update Failed', `Automatic update check failed for "${serverDesc.name}". Review the Updates view.`, serverDesc.id);
    }
  }
}

function setupSchedulers() {
  for (const j of cronJobs) j.stop();
  cronJobs.length = 0;

  if (config.backups.scheduledEnabled && cron.validate(config.backups.scheduledCron)) {
    cronJobs.push(cron.schedule(config.backups.scheduledCron, () => {
      log('Cron: scheduled backup (active server)');
      createBackup(activeManager()).catch((e) => log(`Scheduled backup failed: ${e.message}`));
    }));
    log('Scheduled backup active:', config.backups.scheduledCron);
  }

  if (config.scheduledRestart && config.scheduledRestart.enabled && cron.validate(config.scheduledRestart.cron)) {
    cronJobs.push(cron.schedule(config.scheduledRestart.cron, () => {
      log('Cron: scheduled restart (active server)');
      doScheduledRestart(activeManager());
    }));
    log('Scheduled restart active:', config.scheduledRestart.cron);
  }

  // Per-server user-defined tasks
  for (const t of (config.tasks || [])) {
    if (t.enabled === false || !cron.validate(t.cron)) continue;
    if (!findServer(t.serverId)) continue;
    cronJobs.push(cron.schedule(t.cron, () => {
      log(`Cron: task "${t.name}" (${t.type})`);
      runTask(t);
    }));
    log(`Scheduled task active: ${t.name} [${t.cron}]`);
  }
  cronJobs.push(cron.schedule('* * * * *', () => {
    checkPalworldAutomaticUpdates().catch((error) => log(`Automatic Palworld updates failed: ${error.message}`));
  }));

  // Bug-report retry: drain pending/failed reports once a minute under the
  // worker's attempt/backoff policy (GitHub mode: create issues; relay mode:
  // re-post the idempotent payload to the upstream relay). The worker is
  // (re)built from the current config, so enabling the integration or changing
  // the destination takes effect without a restart; the callback guards the
  // null case so a disabled integration is simply a no-op tick.
  rebuildBugReportWorker();
  cronJobs.push(cron.schedule('* * * * *', () => {
    if (bugReportsWorker) {
      bugReportsWorker.runOnce().catch((error) => log(`Bug-report sync failed: ${error.message}`));
    }
  }));

  // Condition-based triggers (join, empty, update-available, interval) are
  // evaluated on a short tick instead of a cron expression, so they react to
  // observed state rather than to the clock.
  if (automationTimer) clearInterval(automationTimer);
  automationTimer = setInterval(() => {
    if (automationBusy) return; // a slow tick never overlaps itself
    automationBusy = true;
    runAutomationTick()
      .catch((error) => log(`Automation tick failed: ${error.message}`))
      .finally(() => { automationBusy = false; });
  }, AUTOMATION_TICK_MS);
  if (automationTimer.unref) automationTimer.unref();
}

const AUTOMATION_TICK_MS = 20_000;
let automationTimer = null;
let automationBusy = false;

function doScheduledRestart(m) {
  if (!m) return;
  if (!m.isRunning()) {
    m.restart();
    return;
  }
  const warns = [...(config.scheduledRestart.warnMinutes || [5, 1])].sort((a, b) => b - a);
  const maxWarn = warns[0] || 0;
  for (const mm of warns) {
    setTimeout(() => {
      m.sendCommand(`say §eServer restarting in ${mm} minute${mm > 1 ? 's' : ''}...`);
    }, (maxWarn - mm) * 60000);
  }
  setTimeout(() => {
    m.sendCommand('say §cRestarting now...');
    m.restart();
  }, maxWarn * 60000);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Print the default sign-in once at startup, but only while the default admin
// still has the default password. As soon as the password is changed the stored
// hash stops matching, so real credentials are never echoed to the console.
function logDefaultCredentials() {
  try {
    const bar = '='.repeat(58);
    const host = config.panelHost === '0.0.0.0' ? 'localhost' : config.panelHost;
    // First-run install: print the random password from the one-time file
    // (or the in-memory fallback if the file could not be written).
    const oneTime = readInitialPasswordFile() || initialAdminPassword;
    if (oneTime) {
      console.log('');
      console.log(bar);
      console.log('  Hostkind first-run sign-in  (CHANGE THIS PASSWORD!)');
      console.log(bar);
      console.log(`  URL:       http://${host}:${config.panelPort}`);
      console.log(`  Username:  ${DEFAULT_ADMIN_USERNAME}   (or email ${DEFAULT_ADMIN_EMAIL})`);
      console.log(`  Password:  ${oneTime}`);
      console.log(`  Saved to:  ${INITIAL_PASSWORD_FILE}  (deleted after first sign-in)`);
      console.log(bar);
      console.log('  Sign in, then change it in Settings > Change password.');
      console.log(bar);
      console.log('');
      return;
    }
    // Existing installs that predate random generation: show whichever known
    // default still matches, so a long-running panel keeps its old banner.
    const admin = findUserByEmail(DEFAULT_ADMIN_EMAIL);
    if (!admin) return;
    const knownDefaults = ['Hostkind1', 'admin'];
    const current = knownDefaults.find((pw) => verifyPassword(pw, admin.passwordHash));
    if (!current) return;
    console.log('');
    console.log(bar);
    console.log('  Hostkind default sign-in  (CHANGE THIS PASSWORD!)');
    console.log(bar);
    console.log(`  URL:       http://${host}:${config.panelPort}`);
    console.log(`  Username:  ${DEFAULT_ADMIN_USERNAME}   (or email ${DEFAULT_ADMIN_EMAIL})`);
    console.log(`  Password:  ${current}`);
    console.log(bar);
    console.log('  Sign in, then change it in Settings > Change password.');
    console.log('  This notice disappears once the password is changed.');
    console.log(bar);
    console.log('');
  } catch (_) { /* never block startup on the banner */ }
}

// Clean shutdown
function shutdown() {
  log('Shutting down panel...');
  // Discord integration removed (batch E).
  const running = [...managers.values()].filter((m) => m.isRunning());
  if (running.length) {
    log(`${running.length} Minecraft server(s) still running; leaving them alive. Stop them from the panel if you meant to.`);
  }
  process.exit(0);
}

// Node >= 20 exits the process on an unhandled rejection, and one async route
// handler that throws becomes exactly that - taking every supervised server
// down with it. The supervision loop is written to survive per-server crashes,
// so log these loudly and keep serving rather than letting a single bad request
// kill the panel.
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  log('uncaught exception:', err && err.stack || err);
});

if (require.main === module) {
  setupSchedulers();
  try { reconcileTasks(); } catch (e) { log('task reconciliation failed:', e.message); }
  adoptOrphans().catch((e) => log('orphan adoption failed:', e.message));
  server.listen(config.panelPort, config.panelHost, () => {
    log(`${config.appName} listening on http://${config.panelHost}:${config.panelPort}`);
    log(`Registered servers: ${config.servers.length}`);
    logDefaultCredentials();
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  requiredJavaMajor,
  resolveManagedJava,
  resolveJavaForServer,
  ensureRuntime,
  runForgeInstaller,
  installerFailureMessage,
};
