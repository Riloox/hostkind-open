'use strict';

/*
 * Durable create/install runs: the glue between the operations ledger, the
 * resumable downloader, and the destination folder.
 *
 * Why this module exists: POST /api/create (server.js) streams NDJSON and
 * forgets. A killed download leaves a half-created folder, and a retry
 * bounces off `folderNotEmpty`, forcing manual surgery. This module gives the
 * create flow a way to (a) claim a destination with a marker file, (b) drive
 * the download through the operations ledger so an interruption becomes
 * `recovery_required` with a replayable plan, and (c) let the resume route
 * continue the .part file from its byte offset instead of starting over.
 *
 * The marker file is the difference between "a folder mid-install" and "a
 * real server". recoverDestination() only ever touches a folder that carries
 * the marker; a markerless non-empty folder (a real, adopted, or legacy
 * server) is left alone and reported as `destination_not_empty`, mirroring
 * the existing `folderNotEmpty` contract - never silently deleted.
 *
 * Plan shape (stored in operations.journal and copied into `recovery` by
 * sweepStale / abortInstall):
 *   { type: 'download', destination, downloads: [{ url, destPath, filename,
 *     expectedSha256?, allowInsecure? }] }
 * `type: 'download'` plans are what resumeInstall can replay. The `steps`
 * seam exists so a future create that runs post-download steps (the Forge
 * installer, registration) can record them and have resume walk each one.
 */

const fs = require('fs');
const path = require('path');
const operations = require('./operations.cjs');
const downloads = require('./downloads.cjs');
const trash = require('./trash.cjs');

const INSTALL_MARKER = '.fleetdeck-install.json';

function fail(message, code, status = 409) {
  return Object.assign(new Error(message), { code: code || 'install_run_error', status });
}

function safeParse(text) {
  if (text == null) return null;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function isResumableInstallKind(kind) {
  return /(?:^|[._-])(?:install|create)(?:[._-]|$)/i.test(String(kind || ''));
}

/* ---------------------------------------------------------------- marker -- */

function markerPath(destination) {
  return path.join(destination, INSTALL_MARKER);
}

function readMarker(destination) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(destination), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(destination, payload) {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(markerPath(destination), JSON.stringify({ schema: 1, ...payload }, null, 2));
}

function clearMarker(destination) {
  try { fs.unlinkSync(markerPath(destination)); } catch { /* already gone */ }
}

function isPartialInstall(destination) {
  return fs.existsSync(markerPath(destination));
}

/*
 * Get a retried create past a leftover partial folder. Returns:
 *   { action: 'clean' }        - nothing to recover (absent or empty folder);
 *   { action: 'recovered', trashId } - the partial was moved to recoverable
 *                                      trash; a fresh create can proceed;
 * and throws for a non-empty folder that is NOT a partial install - that is a
 * real server, and it is left exactly as found.
 */
function recoverDestination(destination, { servers = [], selfId = null, serverId = null } = {}) {
  if (!destination || !fs.existsSync(destination)) return { action: 'clean' };
  if (fs.readdirSync(destination).length === 0) return { action: 'clean' };
  const marker = readMarker(destination);
  if (!marker) throw fail(`${destination} is not empty`, 'destination_not_empty');
  if (marker.operationId) {
    const op = operations.get(String(marker.operationId));
    if (op && (op.state === operations.STATES.RUNNING || op.state === operations.STATES.QUEUED)) {
      throw fail(`another create is still in progress for ${destination}`, 'install_in_progress');
    }
  }
  // A folder carrying our marker is a dead partial install, not a server.
  // Move it to recoverable trash (a rename, so nothing is half-deleted)
  // rather than deleting it outright.
  const entry = trash.moveToTrash({
    target: destination,
    kind: 'install-partial',
    serverId: serverId || null,
    label: 'Interrupted install',
    reason: 'Partial folder recovered before a retried create',
    servers,
    selfId,
    scope: 'root',
  });
  return { action: 'recovered', trashId: entry && entry.id };
}

/* ------------------------------------------------------------------ plan -- */

function planFromOperation(op) {
  if (!op) return null;
  const journal = safeParse(op.journal);
  const recovery = op.recovery && typeof op.recovery === 'object' && !Array.isArray(op.recovery) ? op.recovery : null;
  const recoveryJournal = safeParse(recovery && recovery.journal);
  return [recovery, recoveryJournal, journal].find((p) => p && p.type === 'download') || null;
}

function isDownloadIncomplete(item) {
  if (!item || !item.destPath) return false;
  if (!fs.existsSync(item.destPath)) return true;
  return fs.existsSync(item.destPath + '.part');
}

/*
 * Start a create operation the durable way: create + start it, claim the
 * destination with the marker, and persist the download plan in the journal
 * so an interruption anywhere in the create is recoverable. Returns
 * { operation, plan } for the caller (the NDJSON stream) to drive.
 */
function beginInstall({ type, destination, actorId, serverId, idempotencyKey, downloads: dl, summary } = {}) {
  if (!destination) throw fail('destination required', 'no_destination');
  const plan = { type: 'download', destination, downloads: dl || [] };
  const op = operations.create({
    kind: `install.${type || 'generic'}.create`,
    actorId,
    serverId,
    idempotencyKey,
    summary,
  });
  operations.start(op.id, { phase: 'downloading' });
  writeMarker(destination, {
    operationId: op.id,
    type: type || 'generic',
    destination,
    phase: 'downloading',
    downloads: plan.downloads,
  });
  operations.setJournal(op.id, plan);
  return { operation: op, plan };
}

/*
 * Continue one download from its .part offset, feeding progress into the
 * ledger as it goes. `options` may carry runtime-only fetch knobs (an
 * allowlist function, allowInsecure); JSON-safe knobs can also live on the
 * plan item itself so the resume route needs no per-plan wiring.
 */
async function runDownload(op, item, options = {}) {
  if (!item || !item.url || !item.destPath) throw fail('the recovery plan has no downloadable file', 'no_download_in_plan');
  const heartbeat = typeof options.onProgress === 'function'
    ? options.onProgress
    : (received, total) => operations.heartbeat(op.id, {
        phase: 'downloading',
        progress: total ? Math.min(0.99, received / total) : null,
      });
  return downloads.fetchToFile(item.url, item.destPath, {
    resume: true,
    maxBytes: options.maxBytes ?? item.maxBytes,
    allowlist: typeof options.allowlist === 'function' ? options.allowlist : (item.allowlist ? (host) => item.allowlist.includes(host) : null),
    allowInsecure: options.allowInsecure ?? !!item.allowInsecure,
    expectedSha256: item.expectedSha256 || options.expectedSha256 || null,
    onProgress: heartbeat,
  });
}

function finishInstall(op, summary) {
  const plan = planFromOperation(op);
  if (plan && plan.destination) clearMarker(plan.destination);
  return operations.finish(op.id, summary || {});
}

function abortInstall(op, err, plan) {
  const p = plan || planFromOperation(op);
  return operations.markRecoveryRequired(op.id, {
    code: err.code || 'install_interrupted',
    text: err.message,
    recovery: p || { type: 'download' },
  });
}

/*
 * Replay a recovery_required install/create operation: move it back to
 * running and continue every file that is still incomplete from its .part
 * offset. Returns { ok, operation, resumed } where `operation` is the final
 * state (succeeded once every download promoted). Errors leave the operation
 * recovery_required again so another resume can retry.
 */
async function resumeInstall(op, options = {}) {
  if (!op) throw fail('operation not found', 'not_found', 404);
  if (op.state !== operations.STATES.RECOVERY_REQUIRED) throw fail('this operation cannot be resumed', 'not_recoverable', 409);
  const plan = planFromOperation(op);
  if (!plan) throw fail('this operation has no recovery plan to replay', 'no_recovery_plan', 409);
  const downloadsList = (plan.downloads || []).filter((d) => d && d.url);
  if (!downloadsList.length) throw fail('this operation has no downloadable file', 'no_download_in_plan', 409);

  const started = operations.start(op.id, { phase: 'downloading' });
  if (!started || started.state !== operations.STATES.RUNNING) {
    throw fail('the operation is not resumable in its current state', 'resume_conflict', 409);
  }
  try {
    const toResume = downloadsList.filter(isDownloadIncomplete);
    if (!toResume.length) {
      // Everything is already on disk (the process died between the last
      // promote and the finishing write): finish without another network hit.
      const finished = finishInstall(op, { destination: plan.destination, files: downloadsList.map((d) => d.filename || d.destPath) });
      return { ok: true, operation: finished, resumed: null };
    }
    let last = null;
    for (const item of toResume) {
      last = await runDownload(op, item, options);
    }
    const finished = finishInstall(op, { destination: plan.destination, files: downloadsList.map((d) => d.filename || d.destPath) });
    return { ok: true, operation: finished, resumed: last && last.resumed };
  } catch (err) {
    abortInstall(op, err, plan);
    throw err;
  }
}

module.exports = {
  INSTALL_MARKER,
  isPartialInstall,
  readMarker,
  writeMarker,
  clearMarker,
  isResumableInstallKind,
  recoverDestination,
  planFromOperation,
  beginInstall,
  runDownload,
  finishInstall,
  abortInstall,
  resumeInstall,
};
