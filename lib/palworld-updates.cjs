'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STEAM_APPS, ensureSteamCmd, installSteamGame, runSteam: run } = require('./dedicatedServerInstaller.cjs');
const operations = require('./operations.cjs');
const snapshots = require('./snapshots.cjs');
const stateStore = require('./stateStore.cjs');

const APP_ID = STEAM_APPS.palworld;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  checkIntervalMinutes: 60,
  maintenanceWindow: { start: '04:00', end: '06:00' },
  announcementSeconds: 300,
  backupRequired: true,
  restart: true,
  maximumDeferralMinutes: 1440,
  playersOnline: 'defer',
  failureThreshold: 3,
  consecutiveFailures: 0,
  suspended: false,
});

// Restore release cache from disk so a panel restart never loses the
// last-known Palworld build metadata (avoids stale:true on first poll).
let cache = stateStore.read('palworld', 'release-cache');

class UpdateError extends Error {
  constructor(message, status = 409, code = 'update_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseBuildId(text) {
  const value = String(text || '');
  const publicBranch = value.match(/"public"\s*\{[\s\S]*?"buildid"\s*"(\d+)"/i);
  const direct = value.match(/"buildid"\s*"(\d+)"/i);
  return (publicBranch || direct || [])[1] || null;
}

function manifestCandidates(serverDir) {
  return [
    path.join(serverDir, 'steamapps', `appmanifest_${APP_ID}.acf`),
    path.join(serverDir, `appmanifest_${APP_ID}.acf`),
    path.join(path.dirname(serverDir), 'steamapps', `appmanifest_${APP_ID}.acf`),
  ];
}

function installedBuild(serverDir) {
  for (const file of manifestCandidates(serverDir)) {
    try {
      const buildId = parseBuildId(fs.readFileSync(file, 'utf8'));
      if (buildId) return { buildId, source: 'steam-app-manifest', observedAt: fs.statSync(file).mtime.toISOString() };
    } catch {}
  }
  // Read receipt from .fleetdeck (primary) with fallback to legacy .lodestone.
  for (const subdir of ['.fleetdeck', '.lodestone']) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(serverDir, subdir, 'palworld-build.json'), 'utf8'));
      if (/^\d+$/.test(String(receipt.buildId || ''))) {
        return { buildId: String(receipt.buildId), source: 'steamcmd-validated-receipt', observedAt: receipt.observedAt || null };
      }
    } catch {}
  }
  return { buildId: null, source: 'unavailable', observedAt: null };
}

function revision(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safePolicy(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const window = input.maintenanceWindow || {};
  const time = (v, fallback) => /^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : fallback;
  return {
    ...DEFAULT_POLICY,
    enabled: !!input.enabled,
    checkIntervalMinutes: Math.max(15, Math.min(1440, Number(input.checkIntervalMinutes) || 60)),
    maintenanceWindow: { start: time(window.start, '04:00'), end: time(window.end, '06:00') },
    announcementSeconds: Math.max(0, Math.min(3600, input.announcementSeconds == null ? DEFAULT_POLICY.announcementSeconds : Number(input.announcementSeconds) || 0)),
    backupRequired: input.backupRequired !== false,
    restart: input.restart !== false,
    maximumDeferralMinutes: Math.max(0, Math.min(10080, input.maximumDeferralMinutes == null ? DEFAULT_POLICY.maximumDeferralMinutes : Number(input.maximumDeferralMinutes) || 0)),
    playersOnline: ['defer', 'skip', 'force'].includes(input.playersOnline) ? input.playersOnline : 'defer',
    failureThreshold: Math.max(1, Math.min(10, Number(input.failureThreshold) || 3)),
    consecutiveFailures: Math.max(0, Number(input.consecutiveFailures) || 0),
    suspended: !!input.suspended,
  };
}

function inMaintenanceWindow(policy, date = new Date()) {
  const minute = date.getHours() * 60 + date.getMinutes();
  const parse = (value) => {
    const [hour, min] = String(value).split(':').map(Number);
    return hour * 60 + min;
  };
  const start = parse(policy.maintenanceWindow.start);
  const end = parse(policy.maintenanceWindow.end);
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

function automaticDecision({ policy, updateState, playerCount, detectedAt = Date.now(), now = Date.now() }) {
  const value = safePolicy(policy);
  if (!value.enabled || value.suspended) return { action: 'disabled' };
  if (updateState !== 'update-ready') return { action: 'wait', reason: 'no_update' };
  if (!inMaintenanceWindow(value, new Date(now))) return { action: 'wait', reason: 'outside_window' };
  if (playerCount > 0 && value.playersOnline !== 'force') {
    const overdue = value.maximumDeferralMinutes > 0 && now - detectedAt >= value.maximumDeferralMinutes * 60_000;
    if (!overdue || value.playersOnline === 'skip') return { action: 'wait', reason: 'players_online' };
  }
  return { action: 'apply' };
}

async function discoverLatest({ cacheDir, download, force = false, now = Date.now(), runCommand = run }) {
  if (!force && cache && now - cache.retrievedAt < CACHE_TTL_MS) return { ...cache, stale: false };
  try {
    const steamcmd = await ensureSteamCmd(cacheDir, download);
    const lines = [];
    await runCommand(steamcmd, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(APP_ID), '+quit'], {
      cwd: path.dirname(steamcmd),
    }, (line) => {
      if (lines.length < 4000) lines.push(String(line).slice(0, 2048));
    });
    const buildId = parseBuildId(lines.join('\n'));
    if (!buildId) throw new Error('Steam did not return a public Palworld build ID');
    cache = {
      buildId,
      source: 'steamcmd-public-branch',
      retrievedAt: now,
      retrievedAtIso: new Date(now).toISOString(),
      lastSuccessAt: new Date(now).toISOString(),
      error: null,
    };
    stateStore.write('palworld', 'release-cache', cache);
    return { ...cache, stale: false };
  } catch {
    if (cache && now - cache.retrievedAt <= MAX_STALE_MS) {
      return { ...cache, stale: true, error: 'Steam metadata is temporarily unavailable.' };
    }
    return {
      buildId: null,
      source: 'steamcmd-public-branch',
      retrievedAt: now,
      retrievedAtIso: new Date(now).toISOString(),
      lastSuccessAt: cache?.lastSuccessAt || null,
      stale: true,
      error: 'Steam metadata is unavailable.',
    };
  }
}

function diskEstimate(serverDir) {
  let bytes = 0;
  const queue = [serverDir];
  while (queue.length && bytes < 20 * 1024 ** 3) {
    const dir = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.lodestone' || entry.name === '.fleetdeck' || entry.name === 'Pal') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else { try { bytes += fs.statSync(file).size; } catch {} }
    }
  }
  return Math.max(2 * 1024 ** 3, Math.ceil(bytes * 1.25));
}

async function status({ server, manager, latest }) {
  const installed = installedBuild(server.dir);
  const runningVersion = manager?.moduleState?.normalizedStatus?.version || null;
  const state = !latest.buildId ? 'unknown'
    : latest.stale ? 'verification-stale'
    : !installed.buildId ? 'installed-unknown'
      : installed.buildId === latest.buildId ? 'current' : 'update-ready';
  return {
    serverId: server.id,
    installed,
    running: { version: runningVersion, buildId: null, source: runningVersion ? 'palworld-rest-api' : 'unavailable' },
    latest,
    state,
    restartRequired: state === 'update-ready',
    diskEstimateBytes: diskEstimate(server.dir),
    checkedAt: new Date().toISOString(),
    changelogUrl: null,
  };
}

async function preview({ server, manager, latest, input = {} }) {
  const current = await status({ server, manager, latest });
  if (!latest.buildId || latest.stale) throw new UpdateError('Fresh Steam build metadata is required before an update can be planned.', 409, 'build_unavailable');
  const plan = {
    serverId: server.id,
    targetBuildId: latest.buildId,
    installedBuildId: current.installed.buildId,
    wasRunning: manager.status !== 'offline',
    playerCount: Number(manager.moduleState?.normalizedStatus?.playerCount) || 0,
    announceSeconds: Math.max(0, Math.min(3600, Number(input.announceSeconds) || 0)),
    restart: input.restart !== false,
    backupRequired: input.backupRequired !== false,
    diskEstimateBytes: current.diskEstimateBytes,
    createdAt: Date.now(),
  };
  return { ...plan, revision: revision(plan) };
}

function waitFor(manager, predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeoutMs) { clearInterval(timer); reject(new UpdateError(message, 500, 'timeout')); }
    }, 250);
  });
}

async function apply({ server, manager, actorId, idempotencyKey, plan, planRevision, cacheDir, download, announce, createBackup, install = installSteamGame }) {
  if (!idempotencyKey) throw new UpdateError('Idempotency-Key is required.', 400, 'idempotency_key_required');
  if (!plan) throw new UpdateError('The update preview is required.', 400, 'preview_required');
  const cleanPlan = { ...plan };
  delete cleanPlan.revision;
  if (!planRevision || revision(cleanPlan) !== planRevision) throw new UpdateError('The update preview is stale.', 409, 'stale_preview');
  const op = operations.create({
    kind: 'palworld-update',
    actorId,
    serverId: server.id,
    idempotencyKey,
    summary: { fromBuildId: plan.installedBuildId, toBuildId: plan.targetBuildId, policy: { restart: plan.restart, backupRequired: plan.backupRequired } },
  });
  if (op.state !== operations.STATES.QUEUED) return { operation: op, replay: true };
  operations.start(op.id, { phase: 'revalidate' });
  if (!operations.acquireServerLock(op.id, server.id)) {
    operations.fail(op.id, { code: 'server_busy', text: 'Another operation is running for this server.' });
    throw new UpdateError('Another operation is running for this server.', 409, 'server_busy');
  }
  void (async () => {
    let snapshot = null;
    try {
      if (!['win32', 'linux'].includes(process.platform)) throw new UpdateError('Palworld updates are supported on Windows and Linux.', 409, 'unsupported_platform');
      const free = fs.statfsSync(server.dir).bavail * fs.statfsSync(server.dir).bsize;
      if (free < plan.diskEstimateBytes) throw new UpdateError('Not enough free disk space for the update and safety copy.', 409, 'insufficient_space');
      if (plan.announceSeconds && manager.status === 'online') {
        operations.heartbeat(op.id, { phase: 'announce', progress: 0.08 });
        await announce(plan.announceSeconds);
      }
      if (manager.status === 'online') {
        operations.heartbeat(op.id, { phase: 'save', progress: 0.15 });
        await manager.module().request(manager, 'POST', '/save');
        operations.heartbeat(op.id, { phase: 'stop', progress: 0.22 });
        manager.stop(false);
        await waitFor(manager, () => manager.status === 'offline', 90_000, 'The Palworld process did not stop in time.');
      }
      operations.heartbeat(op.id, { phase: 'snapshot', progress: 0.32 });
      snapshot = snapshots.take({ serverId: server.id, sourceDir: server.dir, scope: ['Pal/Saved'], kind: 'palworld-update', reason: `Before Palworld build ${plan.targetBuildId}` });
      if (!snapshots.verify(snapshot.id).ok) throw new UpdateError('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
      if (plan.backupRequired) await createBackup();
      operations.heartbeat(op.id, { phase: 'steamcmd', progress: 0.52 });
      await install('palworld', server.dir, {
        cacheDir, download, onProgress: () => {}, onPhase: () => {},
        onOutput: (line) => operations.appendEvent(op.id, { phase: 'steamcmd', message: String(line).slice(0, 500), level: 'info' }),
      });
      operations.heartbeat(op.id, { phase: 'validate', progress: 0.78 });
      if (!fs.existsSync(server.executable)) throw new UpdateError('Steam completed but the Palworld executable is missing.', 500, 'invalid_install');
      const installed = installedBuild(server.dir);
      if (installed.buildId && installed.buildId !== plan.targetBuildId) throw new UpdateError('Installed build metadata does not match the planned build.', 500, 'build_mismatch');
      const receiptDir = path.join(server.dir, '.fleetdeck');
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(path.join(receiptDir, 'palworld-build.json'), JSON.stringify({
        appId: APP_ID,
        buildId: plan.targetBuildId,
        observedAt: new Date().toISOString(),
        source: 'steamcmd-success-and-file-validation',
      }, null, 2));
      if (plan.wasRunning && plan.restart) {
        operations.heartbeat(op.id, { phase: 'restart', progress: 0.86 });
        const started = manager.start();
        if (started?.ok === false) throw new UpdateError('Palworld could not be restarted.', 500, 'restart_failed');
        await waitFor(manager, () => manager.status === 'online', 120_000, 'Palworld did not become ready after the update.');
        operations.heartbeat(op.id, { phase: 'health', progress: 0.95 });
        await manager.module().refresh(manager);
        if (manager.moduleState?.restHealth?.state !== 'healthy') throw new UpdateError('Palworld restarted but its administration API is not healthy.', 500, 'health_failed');
      }
      operations.finish(op.id, { fromBuildId: plan.installedBuildId, toBuildId: plan.targetBuildId, snapshotId: snapshot.id });
    } catch (error) {
      operations.markRecoveryRequired(op.id, {
        code: error.code || 'update_failed',
        text: error.message,
        recovery: {
          snapshotId: snapshot?.id || null,
          instructions: 'The safety snapshot contains save data only. It can restore Pal/Saved, but it cannot restore an older Palworld binary unless Steam still offers that build. Review the operation log before starting the server.',
        },
      });
    }
  })();
  return { operation: operations.get(op.id), replay: false };
}

function resetCache() {
  cache = null;
  stateStore.write('palworld', 'release-cache', null);
}

module.exports = {
  APP_ID, CACHE_TTL_MS, MAX_STALE_MS, DEFAULT_POLICY, UpdateError,
  parseBuildId, installedBuild, safePolicy, inMaintenanceWindow, automaticDecision,
  discoverLatest, status, preview, apply, revision, resetCache,
};
