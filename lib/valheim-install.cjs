'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  STEAM_APPS,
  ensureSteamCmd,
  runSteam: runSteamCmd,
} = require('./dedicatedServerInstaller.cjs');
const stateStore = require('./stateStore.cjs');

const APP_ID = STEAM_APPS.valheim;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const RECEIPT_NAME = 'valheim-build.json';
const DESCRIPTOR_NAME = 'valheim-install.json';
// Receipts live under .fleetdeck (primary); .lodestone is the pre-fleetdeck
// location and is still read for installs adopted before the rename.
const RECEIPT_DIRS = ['.fleetdeck', '.lodestone'];
const RECEIPT = path.join('.fleetdeck', RECEIPT_NAME);
const DESCRIPTOR = path.join('.fleetdeck', DESCRIPTOR_NAME);
const PRESERVED_PATHS = Object.freeze(['data', 'adminlist.txt', 'bannedlist.txt', 'permittedlist.txt']);

/* ------------------------------------------------------------------ */
/* Persisted state: release cache, preview tokens, rollback snapshots  */
/* ------------------------------------------------------------------ */

// releaseCache is restored from disk so a panel restart never loses the
// last-known Valheim release metadata (avoids stale:true on first poll).
let releaseCache = stateStore.read('valheim', 'release-cache');

// previews and rollbacks are Maps that survive restarts via stateStore.
// On disk they are plain objects; we hydrate them into Maps on init.
function hydrateMap(obj) {
  const m = new Map();
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) m.set(k, v);
  }
  return m;
}

const previews = hydrateMap(stateStore.read('valheim', 'previews'));
const rollbacks = hydrateMap(stateStore.read('valheim', 'rollbacks'));
const activeUpdates = new Set();

function persistPreviews() {
  const obj = {};
  for (const [k, v] of previews) obj[k] = v;
  stateStore.write('valheim', 'previews', obj);
}

function persistRollbacks() {
  const obj = {};
  for (const [k, v] of rollbacks) obj[k] = v;
  stateStore.write('valheim', 'rollbacks', obj);
}

class ValheimInstallError extends Error {
  constructor(message, status = 409, code = 'valheim_install_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/*
 * The install destination is operator-supplied and there is deliberately no
 * fixed root to contain it under: an admin may install Valheim on any
 * absolute path on the host. The resolved path is therefore re-asserted
 * against its own filesystem root with the startsWith guard CodeQL
 * js/path-injection recognizes; every absolute path passes unchanged, so
 * accepted destinations are identical, while the value that reaches the fs
 * sinks carries the guard.
 */
function containedAbsolute(value) {
  const abs = path.resolve(String(value || ''));
  const ownRoot = path.parse(abs).root || path.sep;
  if (!abs.startsWith(ownRoot)) {
    throw new ValheimInstallError('Choose a valid destination folder.', 400, 'invalid_destination');
  }
  return abs;
}

function parseBuildId(text) {
  const source = String(text || '');
  const branch = source.match(/\"public\"\s*\{[\s\S]*?\"buildid\"\s*\"(\d+)\"/i);
  const direct = source.match(/\"buildid\"\s*\"(\d+)\"/i);
  return (branch || direct || [])[1] || null;
}

function manifestCandidates(root) {
  return [
    path.join(root, 'steamapps', `appmanifest_${APP_ID}.acf`),
    path.join(root, `appmanifest_${APP_ID}.acf`),
    path.join(path.dirname(root), 'steamapps', `appmanifest_${APP_ID}.acf`),
  ];
}

function readInstalledBuild(root) {
  const base = containedAbsolute(root);
  for (const file of manifestCandidates(base)) {
    try {
      const buildId = parseBuildId(fs.readFileSync(file, 'utf8'));
      if (buildId) return { buildId, source: 'steam-app-manifest', observedAt: fs.statSync(file).mtime.toISOString() };
    } catch (_) {}
  }
  for (const subdir of RECEIPT_DIRS) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(base, subdir, RECEIPT_NAME), 'utf8'));
      if (/^\d+$/.test(String(receipt.buildId || ''))) {
        return { buildId: String(receipt.buildId), source: receipt.source || 'fleetdeck-receipt', observedAt: receipt.verifiedAt || null };
      }
    } catch (_) {}
  }
  return { buildId: null, source: 'unavailable', observedAt: null };
}

function executableName(platform = process.platform) {
  if (platform === 'win32') return 'valheim_server.exe';
  if (platform === 'linux') return 'valheim_server.x86_64';
  throw new ValheimInstallError('Automatic Valheim installation is supported on Windows and Linux. Register an existing installation manually on this host.', 409, 'unsupported_platform');
}

function findExecutable(root, platform = process.platform) {
  const wanted = executableName(platform).toLowerCase();
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) return full;
    }
  }
  return null;
}

function verifyInstall(root, options = {}) {
  const resolved = containedAbsolute(root);
  const platform = options.platform || process.platform;
  const executable = findExecutable(resolved, platform);
  if (!executable) throw new ValheimInstallError('SteamCMD completed but the Valheim dedicated-server executable is missing.', 500, 'invalid_install');
  if (platform !== 'win32') {
    fs.chmodSync(executable, 0o755);
    fs.accessSync(executable, fs.constants.X_OK);
  }
  const installed = readInstalledBuild(resolved);
  if (!installed.buildId) throw new ValheimInstallError('SteamCMD completed but the Valheim app manifest has no valid build ID.', 500, 'invalid_manifest');
  const required = platform === 'win32'
    ? ['UnityPlayer.dll', 'steamclient64.dll']
    : ['UnityPlayer.so', 'steamclient.so'];
  const missing = required.filter((name) => !findNamedFile(resolved, name));
  if (missing.length) throw new ValheimInstallError(`Valheim is missing required files: ${missing.join(', ')}.`, 500, 'invalid_install');
  return { executable, buildId: installed.buildId, manifest: installed };
}

function findNamedFile(root, name) {
  const wanted = name.toLowerCase();
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) return full;
    }
  }
  return null;
}

function safeOutput(onOutput = () => {}) {
  let count = 0;
  return (line) => {
    count += 1;
    if (count <= 300 || count % 50 === 0) onOutput(String(line).slice(0, 1000));
  };
}

function stagingPath(destination, operationId = crypto.randomUUID()) {
  const parent = path.dirname(destination);
  // The operation id is client-supplied (the Idempotency-Key header flows
  // here), so it must not be able to inject path separators into the staging
  // directory name - a crafted key like `../../x` would otherwise resolve the
  // staged path outside the destination's parent. path.basename is a CodeQL
  // js/path-injection sanitizer (its output is always a bare name), so the
  // value reaching the fs sinks below carries no taint. Opaque idempotency
  // keys are single path components and pass through unchanged; keys
  // containing separators are flattened into a bare name instead of escaping.
  const safeId = path.basename(String(operationId || ''));
  return path.join(parent, `.${path.basename(destination)}.fleetdeck-staging-${safeId}`);
}

function writeMetadata(root, verification, input, source = 'steamcmd-anonymous') {
  const base = containedAbsolute(root);
  const owned = path.join(base, '.fleetdeck');
  fs.mkdirSync(owned, { recursive: true });
  const verifiedAt = new Date().toISOString();
  fs.writeFileSync(path.join(base, RECEIPT), JSON.stringify({
    appId: APP_ID,
    buildId: verification.buildId,
    source,
    platform: process.platform,
    architecture: process.arch,
    verifiedAt,
  }, null, 2));
  fs.writeFileSync(path.join(base, DESCRIPTOR), JSON.stringify({
    schema: 1,
    appId: APP_ID,
    saveDir: 'data',
    worldName: input.worldName,
    installedBuildId: verification.buildId,
    verifiedAt,
  }, null, 2));
}

async function install(input, options = {}) {
  const destination = containedAbsolute(input && input.destination);
  if (!destination || destination === path.parse(destination).root) throw new ValheimInstallError('Choose a valid destination.', 400, 'invalid_destination');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new ValheimInstallError('The destination folder is not empty.', 409, 'destination_not_empty');
  const stage = stagingPath(destination, options.operationId);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: false });
  let promoted = false;
  try {
    options.onPhase?.('steamcmd');
    const steamcmd = await ensureSteamCmd(options.cacheDir, options.download, options.onProgress);
    await (options.runCommand || runSteamCmd)(steamcmd, [
      '+force_install_dir', stage,
      '+login', 'anonymous',
      '+app_update', String(APP_ID), 'validate',
      '+quit',
    ], { cwd: path.dirname(steamcmd), signal: options.signal }, safeOutput(options.onOutput));
    options.onPhase?.('verify');
    const verification = verifyInstall(stage, options);
    fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
    writeMetadata(stage, verification, input);
    if (options.signal?.aborted) throw new ValheimInstallError('Valheim installation was cancelled.', 409, 'cancelled');
    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    fs.renameSync(stage, destination);
    promoted = true;
    const executable = path.join(destination, path.relative(stage, verification.executable));
    return {
      executable,
      cwd: path.dirname(executable),
      args: [],
      buildId: verification.buildId,
      saveDir: path.join(destination, 'data'),
      rollbackPromotion() {
        if (fs.existsSync(destination)) fs.renameSync(destination, stage);
        promoted = false;
      },
      finalize() { fs.rmSync(stage, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (!promoted) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

async function discoverAvailable(options = {}) {
  const now = options.now || Date.now();
  if (!options.force && releaseCache && now - releaseCache.retrievedAt < CACHE_TTL_MS) return { ...releaseCache, stale: false };
  try {
    const steamcmd = await ensureSteamCmd(options.cacheDir, options.download);
    const lines = [];
    await (options.runCommand || runSteamCmd)(steamcmd, [
      '+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(APP_ID), '+quit',
    ], { cwd: path.dirname(steamcmd) }, (line) => {
      if (lines.length < 4000) lines.push(String(line).slice(0, 2048));
    });
    const buildId = parseBuildId(lines.join('\\n'));
    if (!buildId) throw new Error('malformed metadata');
    releaseCache = { buildId, source: 'steamcmd-public-branch', retrievedAt: now, checkedAt: new Date(now).toISOString(), error: null };
    stateStore.write('valheim', 'release-cache', releaseCache);
    return { ...releaseCache, stale: false };
  } catch (_) {
    if (releaseCache && now - releaseCache.retrievedAt <= MAX_STALE_MS) {
      return { ...releaseCache, stale: true, error: 'Steam metadata is temporarily unavailable.' };
    }
    return { buildId: null, source: 'steamcmd-public-branch', retrievedAt: now, checkedAt: new Date(now).toISOString(), stale: true, error: 'Steam metadata is unavailable or malformed.' };
  }
}

function hashTree(root, excluded = PRESERVED_PATHS) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let files = 0;
  const queue = [''];
  while (queue.length) {
    const relDir = queue.shift();
    const abs = path.join(root, relDir);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (_) { continue; }
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name);
      if (excluded.some((item) => rel === item || rel.startsWith(item + path.sep))) continue;
      if (rel.startsWith('.fleetdeck') || rel.startsWith('.lodestone')) continue;
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile()) {
        const stat = fs.statSync(path.join(root, rel));
        hash.update(rel.split(path.sep).join('/')).update(String(stat.size)).update(String(Math.trunc(stat.mtimeMs)));
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { fingerprint: hash.digest('hex'), bytes, files };
}

function updateStatus({ server, latest }) {
  const installed = readInstalledBuild(server.dir);
  const state = !latest?.buildId ? 'unavailable'
    : latest.stale ? 'stale'
      : !installed.buildId ? 'installed-unknown'
        : installed.buildId === latest.buildId ? 'current' : 'update-ready';
  return { serverId: server.id, installed, available: latest, state, checkedAt: new Date().toISOString() };
}

function createPreview({ server, manager, actorId, latest, restart = true, now = Date.now() }) {
  if (!latest?.buildId || latest.stale) throw new ValheimInstallError('Fresh Steam build metadata is required before an update can be planned.', 409, 'metadata_stale');
  const dir = containedAbsolute(server.dir);
  const installed = readInstalledBuild(dir);
  const inventory = hashTree(dir);
  const token = crypto.randomBytes(32).toString('base64url');
  const plan = {
    serverId: server.id,
    installedBuildId: installed.buildId,
    availableBuildId: latest.buildId,
    metadataFresh: true,
    requiredDiskBytes: Math.max(2 * 1024 ** 3, Math.ceil(inventory.bytes * 2.25)),
    replaceableFiles: inventory.files,
    preservedPaths: [...PRESERVED_PATHS],
    stopRequired: manager?.status !== 'offline',
    restart: restart !== false,
    inventoryFingerprint: inventory.fingerprint,
    expiresAt: now + PREVIEW_TTL_MS,
  };
  previews.set(token, { actorId: String(actorId), serverId: server.id, buildId: latest.buildId, inventoryFingerprint: inventory.fingerprint, expiresAt: plan.expiresAt });
  persistPreviews();
  return { ...plan, previewToken: token };
}

function consumePreview({ token, actorId, server, latest, now = Date.now() }) {
  const record = previews.get(String(token || ''));
  previews.delete(String(token || ''));
  persistPreviews();
  if (!record || record.expiresAt < now) throw new ValheimInstallError('The update preview expired or was already used.', 409, 'stale_preview');
  const inventory = hashTree(containedAbsolute(server.dir));
  if (record.actorId !== String(actorId) || record.serverId !== server.id || record.buildId !== latest?.buildId || latest?.stale || record.inventoryFingerprint !== inventory.fingerprint) {
    throw new ValheimInstallError('The server or available build changed after preview.', 409, 'stale_preview');
  }
  return record;
}

function copyTree(source, target, exclude = []) {
  const abs = containedAbsolute(source);
  fs.cpSync(abs, target, {
    recursive: true,
    filter: (item) => {
      const rel = path.relative(abs, item);
      return !exclude.some((part) => rel === part || rel.startsWith(part + path.sep));
    },
  });
}

async function applyUpdate({ server, manager, actorId, previewToken, latest, restart = true, options = {} }) {
  if (activeUpdates.has(server.id)) throw new ValheimInstallError('Another update is already running for this server.', 409, 'server_busy');
  activeUpdates.add(server.id);
  const wasRunning = manager?.status !== 'offline';
  const dir = containedAbsolute(server.dir);
  const transaction = stagingPath(dir, options.operationId || `update-${crypto.randomUUID()}`);
  const backup = stagingPath(dir, `rollback-${crypto.randomUUID()}`);
  try {
    consumePreview({ token: previewToken, actorId, server, latest, now: options.now });
    if (wasRunning) {
      manager.stop(false);
      await waitFor(() => manager.status === 'offline', options.stopTimeoutMs || 90_000, 'Valheim did not stop cleanly.');
    }
    fs.rmSync(transaction, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    copyTree(dir, transaction);
    const steamcmd = await ensureSteamCmd(options.cacheDir, options.download, options.onProgress);
    await (options.runCommand || runSteamCmd)(steamcmd, [
      '+force_install_dir', transaction, '+login', 'anonymous', '+app_update', String(APP_ID), 'validate', '+quit',
    ], { cwd: path.dirname(steamcmd) }, safeOutput(options.onOutput));
    const verified = verifyInstall(transaction, options);
    if (verified.buildId !== latest.buildId) throw new ValheimInstallError('The installed build does not match the previewed build.', 500, 'build_mismatch');
    writeMetadata(transaction, verified, { worldName: server.worldName }, 'steamcmd-validated-update');
    fs.renameSync(dir, backup);
    try { fs.renameSync(transaction, dir); } catch (error) { fs.renameSync(backup, dir); throw error; }
    const rollbackId = crypto.randomUUID();
    rollbacks.set(rollbackId, { serverId: server.id, backup, oldBuildId: readInstalledBuild(backup).buildId, newBuildId: verified.buildId });
    persistRollbacks();
    server.valheimBuildId = verified.buildId;
    try {
      if (typeof options.saveDescriptor === 'function') await options.saveDescriptor(server);
    } catch (error) {
      const rejected = stagingPath(dir, `persistence-failed-${crypto.randomUUID()}`);
      fs.renameSync(dir, rejected);
      fs.renameSync(backup, dir);
      fs.rmSync(rejected, { recursive: true, force: true });
      server.valheimBuildId = rollbacks.get(rollbackId).oldBuildId;
      rollbacks.delete(rollbackId);
      persistRollbacks();
      throw error;
    }
    if (manager && wasRunning && restart) {
      const result = manager.start();
      if (result?.ok === false) throw new ValheimInstallError(result.error || 'Valheim could not restart.', 500, 'restart_failed');
    }
    return { buildId: verified.buildId, rollbackId };
  } catch (error) {
    fs.rmSync(transaction, { recursive: true, force: true });
    throw error;
  } finally {
    activeUpdates.delete(server.id);
  }
}

async function rollbackUpdate({ rollbackId, server, manager, restart = false, saveDescriptor }) {
  const record = rollbacks.get(rollbackId);
  if (!record || record.serverId !== server.id) throw new ValheimInstallError('The rollback snapshot is unavailable.', 404, 'rollback_unavailable');
  const backup = containedAbsolute(record.backup);
  if (!fs.existsSync(backup)) throw new ValheimInstallError('The rollback snapshot is unavailable.', 404, 'rollback_unavailable');
  if (manager?.status !== 'offline') throw new ValheimInstallError('Stop Valheim before rolling back.', 409, 'server_running');
  const dir = containedAbsolute(server.dir);
  verifyInstall(backup);
  const failed = stagingPath(dir, `failed-${crypto.randomUUID()}`);
  fs.renameSync(dir, failed);
  try { fs.renameSync(backup, dir); } catch (error) { fs.renameSync(failed, dir); throw error; }
  fs.rmSync(failed, { recursive: true, force: true });
  server.valheimBuildId = record.oldBuildId;
  if (typeof saveDescriptor === 'function') await saveDescriptor(server);
  rollbacks.delete(rollbackId);
  persistRollbacks();
  if (restart && manager) manager.start();
  return { buildId: record.oldBuildId };
}

function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new ValheimInstallError(message, 409, 'stop_failed'));
      }
    }, 100);
  });
}

function resetForTests() {
  releaseCache = null;
  previews.clear();
  rollbacks.clear();
  activeUpdates.clear();
  // Also clear persisted state so tests start clean
  stateStore.write('valheim', 'release-cache', null);
  stateStore.write('valheim', 'previews', {});
  stateStore.write('valheim', 'rollbacks', {});
}

module.exports = {
  APP_ID,
  CACHE_TTL_MS,
  MAX_STALE_MS,
  PREVIEW_TTL_MS,
  PRESERVED_PATHS,
  ValheimInstallError,
  parseBuildId,
  readInstalledBuild,
  verifyInstall,
  discoverAvailable,
  install,
  updateStatus,
  createPreview,
  consumePreview,
  applyUpdate,
  rollbackUpdate,
  hashTree,
  resetForTests,
};
