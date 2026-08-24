'use strict';

/*
 * Valheim world operations (docs/valheim/03-worlds.md).
 *
 * A Valheim world is a *pair*: `<name>.fwl` (metadata) and `<name>.db` (the
 * actual save), both required, neither meaningful alone. That is the one
 * identity model none of the other game modules have - Minecraft
 * (lib/worlds.cjs) is a directory with a marker file, Terraria
 * (lib/terraria-worlds.cjs) is a single file - so this module reuses the same
 * shared primitives (`operations`, `snapshots`, `fsTransaction`, `trash`,
 * `archiveGuard`, `safeResolve`) without reusing either game's module.
 *
 * Three things make this module simpler than its Terraria sibling:
 *
 *   - No binary parser. The doc is explicit: do not implement a speculative
 *     parser for `.fwl`/`.db` internals. "Health" is existence, regular-file-
 *     ness, and non-empty size - nothing about the format is ever read.
 *   - No companion config file. Selection is one descriptor field
 *     (`desc.worldName`, a plain string - see lib/modules/valheim/launch.cjs),
 *     not a second source of truth to keep in sync, so there is no
 *     "disagreement" concept the way Terraria's `serverconfig.txt` has.
 *   - The save directory convention is fixed by the game itself
 *     (`<valheimSaveDir>/worlds_local/`, already hardcoded in
 *     lib/modules/valheim/manager.cjs's start()), not discoverable the way
 *     Terraria's `worldpath` is.
 *
 * What stays the same: selection, rename, import and delete all require the
 * server offline, a fresh actor/server/action-bound preview, an idempotency
 * key, the per-server operation lock, a verified snapshot, transactional
 * promotion, and an audit event. Deletion is quarantine (lib/trash.cjs),
 * never a recursive remove. Absolute paths never leave this module.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const archiver = require('archiver');
const { open, dataDir } = require('./db.cjs');
const { safeResolve } = require('./files.cjs');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { Transaction } = require('./fsTransaction.cjs');
const snapshots = require('./snapshots.cjs');
const operations = require('./operations.cjs');
const trash = require('./trash.cjs');
const launch = require('./modules/valheim/launch.cjs');

/* --------------------------------------------------------------- constants -- */

const META_EXT = '.fwl';
const DATA_EXT = '.db';
const WORLDS_DIR = 'worlds_local';
const BACKUPS_DIR = 'backups';

// A preview is a promise about a state of the disk; lib/worlds.cjs and
// lib/terraria-worlds.cjs both honour that promise for fifteen minutes.
const PREVIEW_TTL = 15 * 60 * 1000;

const MAX_NAME_LENGTH = 64;

// A large Valheim world is a few hundred megabytes. Generous by an order of
// magnitude, so a mistake is refused rather than streamed to disk.
const MAX_PAIR_FILE_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 4096;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

// Require 25% more free space than expected usage, matching lib/worlds.cjs.
const DISK_HEADROOM = 1.25;

const MAX_SCAN_ENTRIES = 5000;

// Every kind contains "world-write", which operations.isDestructiveKind()
// looks for: an interrupted run becomes recovery_required and never resumes
// on its own.
const KIND = Object.freeze({
  SELECT: 'world-write.valheim-select',
  IMPORT: 'world-write.valheim-import',
  RENAME: 'world-write.valheim-rename',
  DELETE: 'world-write.valheim-delete',
});

const ACTIONS = Object.freeze({
  [KIND.SELECT]: 'valheim-select',
  [KIND.IMPORT]: 'valheim-import',
  [KIND.RENAME]: 'valheim-rename',
  [KIND.DELETE]: 'valheim-delete',
});

class ValheimWorldError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.status = status;
    this.code = code || 'valheim_world_error';
  }
}

class Cancelled extends Error {}

const fail = (message, status, code) => { throw new ValheimWorldError(message, { status, code }); };

// Character-code check rather than a regex literal: a control-character
// range in a regex is easy to mistype as literal bytes instead of an escape
// sequence, which would leave raw control bytes sitting in this source file.
function hasControlChar(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// Windows-reserved device names, matching lib/terraria-worlds.cjs's RESERVED.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/* ------------------------------------------------------------------ naming -- */

/*
 * A world name becomes two file names, so it is bounded the way
 * lib/terraria-worlds.cjs bounds its own: letters, digits, spaces, dots,
 * dashes and underscores only, no control characters, no reserved device
 * name, no trailing dot or space (Windows treats both as ambiguous), no `.`
 * or `..`.
 */
function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) fail('A world name is required.', 400, 'name_required');
  if (name.length > MAX_NAME_LENGTH) fail(`World names are limited to ${MAX_NAME_LENGTH} characters.`, 400, 'name_too_long');
  if (hasControlChar(name)) fail('That world name is not a valid file name.', 400, 'name_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    fail('World names may only contain letters, digits, spaces, dots, dashes and underscores.', 400, 'name_invalid');
  }
  if (name === '.' || name === '..' || name.endsWith('.') || name.endsWith(' ')) {
    fail('That world name is not a valid file name.', 400, 'name_invalid');
  }
  if (RESERVED.has(name.toLowerCase())) fail('That world name is reserved by the operating system.', 400, 'name_reserved');
  return name;
}

/*
 * Whether two names are the same world file. On Windows and macOS the
 * default filesystem folds case, so two names differing only in case are the
 * same file and a collision; on Linux they are two different files. Same
 * rule as lib/terraria-worlds.cjs's `sameFile`.
 */
const CASE_INSENSITIVE_HOST = process.platform === 'win32' || process.platform === 'darwin';

function sameName(a, b, { caseInsensitive = CASE_INSENSITIVE_HOST } = {}) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/* ---------------------------------------------------------- the save directory -- */

function serverDir(desc) {
  const dir = String((desc && (desc.dir || desc.cwd)) || '').trim();
  if (!dir) fail('This server has no folder configured.', 409, 'server_dir_missing');
  return path.resolve(dir);
}

// Server-relative, POSIX-separated, for responses, previews and snapshot scope.
const toRelative = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// Refuse a path reached through a link: every write in this module lands
// under the resolved directory, so a link anywhere along the way is refused
// rather than followed.
function assertNoSymlink(root, abs) {
  let current = path.resolve(root);
  const parts = path.relative(current, abs).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (_) { return; } // does not exist yet
    if (stat.isSymbolicLink()) fail('The world folder is reached through a link; links are not supported.', 409, 'symlink_path');
  }
}

/*
 * Where this server keeps its worlds.
 *
 * Unlike Terraria's configurable `worldpath`, this is fixed by the game
 * itself: `-savedir <dir>/<valheimSaveDir>` plus the dedicated server's own
 * `worlds_local` subfolder - the exact convention already hardcoded in
 * lib/modules/valheim/manager.cjs's start(). One resolution, no source
 * priority chain.
 */
function resolveSaveDir(desc) {
  const root = serverDir(desc);
  const saveDirRel = launch.normalizeRelativeDir((desc && desc.valheimSaveDir) || 'data');
  let saveRootAbs;
  try { saveRootAbs = safeResolve(root, saveDirRel); }
  catch { fail('The Valheim save directory is not valid.', 409, 'save_dir_invalid'); }
  const worldsAbs = path.join(saveRootAbs, WORLDS_DIR);
  assertNoSymlink(root, worldsAbs);
  return { abs: worldsAbs, rel: toRelative(root, worldsAbs), root, saveRootAbs };
}

function backupsDirOf(saveDir) {
  return path.join(saveDir.abs, BACKUPS_DIR);
}

// One world file inside the worlds directory, resolved safely.
function pairPaths(saveDir, name) {
  let fwl;
  let db;
  try {
    fwl = safeResolve(saveDir.abs, `${name}${META_EXT}`);
    db = safeResolve(saveDir.abs, `${name}${DATA_EXT}`);
  } catch (_) { fail('That world name is not inside the world folder.', 400, 'path_escape'); }
  if (path.dirname(fwl) !== saveDir.abs || path.dirname(db) !== saveDir.abs) {
    fail('That world name is not inside the world folder.', 400, 'path_escape');
  }
  return { fwl, db };
}

function statOf(abs) {
  try {
    const stat = fs.lstatSync(abs);
    return stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

/*
 * Recognized upstream automatic backups.
 *
 * Valheim's dedicated server writes rotations into `worlds_local/backups/`
 * named `<name>_backup_auto-<n>_<timestamp>.fwl`/`.db`. They are recognized
 * by this naming pattern only - never parsed - so a file that does not match
 * is simply not grouped with its world (a safe degrade, never a guess).
 */
function backupPattern(name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}_backup_.*\\.(?:fwl|db)$`, 'i');
}

function existingBackups(saveDir, name) {
  const dir = backupsDirOf(saveDir);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const pattern = backupPattern(name);
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!pattern.test(entry.name)) continue;
    const stat = statOf(path.join(dir, entry.name));
    if (!stat) continue;
    out.push({ file: entry.name, sizeBytes: stat.size });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/* --------------------------------------------------------------- the pair -- */

/*
 * Resolve a name to its pair on disk. No binary parsing: `healthy` means both
 * files exist, are regular files, and are non-empty; `incomplete` means
 * exactly one exists; `unreadable` means both exist but at least one is
 * empty; `missing` (internal only - never reaches a public response) means
 * neither exists, which is the "free name" state the create-new-world flow
 * needs to tell apart from a corrupt pair.
 */
function readPair(saveDir, name) {
  const { fwl, db } = pairPaths(saveDir, name);
  const fwlStat = statOf(fwl);
  const dbStat = statOf(db);
  const backups = existingBackups(saveDir, name);
  const metaOk = !!fwlStat;
  const dataOk = !!dbStat;

  let health;
  let reason = null;
  if (metaOk && dataOk) {
    if (fwlStat.size === 0 && dbStat.size === 0) { health = 'unreadable'; reason = 'both_empty'; }
    else if (fwlStat.size === 0) { health = 'unreadable'; reason = 'metadata_empty'; }
    else if (dbStat.size === 0) { health = 'unreadable'; reason = 'database_empty'; }
    else { health = 'healthy'; }
  } else if (metaOk || dataOk) {
    health = 'incomplete';
    reason = metaOk ? 'database_missing' : 'metadata_missing';
  } else {
    health = 'missing';
  }

  return {
    name, fwl, db, fwlStat, dbStat, backups, health, reason,
    complete: health === 'healthy',
    sizeBytes: (fwlStat ? fwlStat.size : 0) + (dbStat ? dbStat.size : 0)
      + backups.reduce((sum, b) => sum + b.sizeBytes, 0),
    modifiedAt: Math.round(Math.max(fwlStat ? fwlStat.mtimeMs : 0, dbStat ? dbStat.mtimeMs : 0)),
  };
}

// A content-agnostic revision marker (a hash of size+mtime for each half of
// the pair) - not read from inside the file. No binary parser is implemented
// here, per the phase's explicit guardrail; this only detects that the pair
// changed, not what changed.
function revisionOf(fwlStat, dbStat) {
  const parts = [
    fwlStat ? `${fwlStat.size}:${Math.round(fwlStat.mtimeMs)}` : 'x',
    dbStat ? `${dbStat.size}:${Math.round(dbStat.mtimeMs)}` : 'x',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// The World model from docs/valheim/03-worlds.md. Never called for a
// `missing` pair - that state has nothing to publish.
function worldModel(pair, { active }) {
  return {
    name: pair.name,
    active: !!active,
    complete: pair.complete,
    files: { metadata: !!pair.fwlStat, database: !!pair.dbStat, backups: pair.backups.length },
    sizeBytes: pair.sizeBytes,
    modifiedAt: pair.modifiedAt,
    revision: revisionOf(pair.fwlStat, pair.dbStat),
    health: pair.health,
    reason: pair.reason,
  };
}

/*
 * Refuse a name already taken in the worlds directory - by a recognized
 * world, an unreadable stray file, or anything else sitting on the name.
 * Case sensitivity follows the host, same as lib/terraria-worlds.cjs's
 * `assertNameFree`.
 */
function assertNameFree(saveDir, name) {
  const wanted = [`${name}${META_EXT}`, `${name}${DATA_EXT}`];
  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs); } catch (_) { return; }
  for (const existing of entries) {
    if (wanted.some((w) => sameName(w, existing))) {
      fail(`"${existing}" already exists in this server's world folder. Choose another name.`, 409, 'name_collision');
    }
  }
}

/* --------------------------------------------------------------- inventory -- */

/*
 * The read model behind GET /api/valheim/worlds.
 *
 * Candidate names are every `.fwl` or `.db` basename found in the worlds
 * directory (a stray `.db` with no `.fwl` is still a world - it is reported
 * `incomplete`, never hidden). Selection is a single descriptor field, so
 * there is no "disagreement" concept the way Minecraft/Terraria have one.
 */
function inventory(desc, { status = 'offline', activeOperations: active = [] } = {}) {
  const saveDir = resolveSaveDir(desc);
  const scannedAt = Date.now();
  const selection = currentSelection(desc);
  const byName = new Map();
  for (const op of active) if (op.worldId) byName.set(op.worldId, op);

  const names = new Set();
  let truncated = false;
  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') fail(`The world folder could not be read: ${error.message}`, 500, 'save_dir_unreadable');
  }

  for (const entry of entries) {
    if (names.size >= MAX_SCAN_ENTRIES) { truncated = true; break; }
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(META_EXT)) names.add(entry.name.slice(0, -META_EXT.length));
    else if (lower.endsWith(DATA_EXT)) names.add(entry.name.slice(0, -DATA_EXT.length));
  }

  const worlds = [];
  for (const name of names) {
    if (!name) continue;
    let pair;
    try { pair = readPair(saveDir, name); } catch (_) { continue; }
    if (pair.health === 'missing') continue;
    const op = byName.get(name) || null;
    const model = worldModel(pair, { active: !!selection.name && sameName(selection.name, name) });
    model.operation = op ? { id: op.operationId, action: op.action, state: op.state, phase: op.phase, progress: op.progress } : null;
    worlds.push(model);
  }
  worlds.sort((a, b) => a.name.localeCompare(b.name));

  return {
    serverId: desc.id,
    serverStatus: status,
    saveDir: saveDir.rel,
    saveDirExists: fs.existsSync(saveDir.abs),
    scannedAt,
    truncated,
    worlds,
    selection,
  };
}

// The only "selection" source: the descriptor's own worldName field.
function currentSelection(desc) {
  const raw = desc && desc.worldName;
  return { name: raw ? String(raw) : null };
}

/* ------------------------------------------------------------------ disk -- */

function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (_) {
    return null;
  }
}

function diskPlan(dir, requiredBytes) {
  const available = freeBytes(dir);
  const needed = Math.ceil(requiredBytes * DISK_HEADROOM);
  return {
    requiredBytes,
    neededBytes: needed,
    availableBytes: available,
    sufficient: available == null ? false : available >= needed,
    reason: available == null ? 'capacity_unknown' : (available >= needed ? null : 'insufficient_space'),
  };
}

function assertDisk(plan) {
  if (plan.sufficient) return;
  if (plan.reason === 'capacity_unknown') {
    fail('Free disk space could not be read, so this cannot be done safely.', 409, 'capacity_unknown');
  }
  fail('Not enough free disk space for this operation.', 409, 'insufficient_space');
}

/* ---------------------------------------------------------------- previews -- */

/*
 * The fingerprint is what makes a preview a promise about a specific state of
 * the worlds directory: every `.fwl`/`.db`/recognized-backup file, its size
 * and modification time, plus what is currently selected. If any of it
 * changed since the preview, the impact shown is no longer the impact that
 * would happen, and the mutation refuses to run against it.
 */
function fingerprint(desc) {
  const saveDir = resolveSaveDir(desc);
  const parts = [];
  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs, { withFileTypes: true }); } catch (_) { /* missing folder is a state too */ }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(META_EXT) && !lower.endsWith(DATA_EXT)) continue;
    const stat = statOf(path.join(saveDir.abs, entry.name));
    parts.push(`${entry.name}:${stat ? stat.size : 'x'}:${stat ? Math.round(stat.mtimeMs) : 'x'}`);
  }
  let backupEntries = [];
  try { backupEntries = fs.readdirSync(backupsDirOf(saveDir), { withFileTypes: true }); } catch (_) { /* no backups folder yet */ }
  for (const entry of backupEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const stat = statOf(path.join(backupsDirOf(saveDir), entry.name));
    parts.push(`backup:${entry.name}:${stat ? stat.size : 'x'}:${stat ? Math.round(stat.mtimeMs) : 'x'}`);
  }
  parts.push(`selection:${(desc && desc.worldName) || ''}`);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/*
 * Previews live in the shared `world_previews` table - the same one
 * lib/worlds.cjs and lib/terraria-worlds.cjs use. It already stores exactly
 * what a preview is (actor, server, action, fingerprint, payload, expiry), so
 * a second table with the same columns would only create a second place for
 * consent to be recorded.
 */
function savePreview({ desc, actorId, action, name, payload }) {
  const token = crypto.randomUUID();
  const now = Date.now();
  open().prepare(`
    INSERT INTO world_previews (token, server_id, actor_id, action, world_id, created_at, expires_at, fingerprint, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, desc.id, actorId, action, name || null, now, now + PREVIEW_TTL, fingerprint(desc), JSON.stringify(payload));
  return { token, expiresAt: now + PREVIEW_TTL, ...payload };
}

// Single-use: the row is deleted as it is read, so a replayed request must
// take a fresh preview rather than reuse consent for a state that no longer
// holds.
function consumePreview({ token, desc, actorId, action }) {
  const db = open();
  const row = db.prepare('SELECT * FROM world_previews WHERE token = ?').get(String(token || ''));
  if (!row || row.actor_id !== actorId || row.server_id !== desc.id || row.action !== action) {
    fail('This action needs a current preview.', 409, 'preview_invalid');
  }
  db.prepare('DELETE FROM world_previews WHERE token = ?').run(row.token);
  if (row.expires_at < Date.now()) fail('The preview expired. Review the impact again.', 409, 'preview_expired');
  if (row.fingerprint !== fingerprint(desc)) {
    fail('The worlds changed since the preview was taken. Review the impact again.', 409, 'preview_stale');
  }
  return JSON.parse(row.payload_json);
}

/* ----------------------------------------------------- operation plumbing -- */

function recordOperation({ operationId, serverId, name, action, source, destination }) {
  open().prepare(`
    INSERT INTO world_operations (operation_id, server_id, world_id, action, source_json, destination_json, result_json)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(operation_id) DO NOTHING
  `).run(operationId, serverId, name || null, action, JSON.stringify(source || {}), JSON.stringify(destination || {}));
}

function recordResult(operationId, result) {
  open().prepare('UPDATE world_operations SET result_json = ? WHERE operation_id = ?')
    .run(JSON.stringify(result || {}), operationId);
}

const safeJson = (text) => { try { return text ? JSON.parse(text) : null; } catch (_) { return null; } };

function listOperations(serverId, limit = 25) {
  return open().prepare(`
    SELECT w.operation_id, w.world_id, w.action, w.source_json, w.destination_json, w.result_json,
           o.state, o.phase, o.progress, o.queued_at, o.finished_at, o.error_code, o.error_text
      FROM world_operations w
      JOIN operations o ON o.id = w.operation_id
     WHERE w.server_id = ? AND w.action LIKE 'valheim-%'
     ORDER BY o.queued_at DESC
     LIMIT ?
  `).all(serverId, limit).map((row) => ({
    operationId: row.operation_id,
    worldId: row.world_id,
    action: row.action,
    state: row.state,
    phase: row.phase,
    progress: row.progress,
    queuedAt: row.queued_at,
    finishedAt: row.finished_at,
    error: row.error_code ? { code: row.error_code, text: row.error_text } : null,
    source: safeJson(row.source_json),
    destination: safeJson(row.destination_json),
    result: safeJson(row.result_json),
  }));
}

function activeOperations(serverId) {
  return listOperations(serverId, 50).filter((op) => ['running', 'queued', 'recovery_required'].includes(op.state));
}

function findOperationByKey(actorId, idempotencyKey) {
  if (!actorId || !idempotencyKey) return null;
  const row = open().prepare('SELECT id FROM operations WHERE actor_id = ? AND idempotency_key = ?').get(actorId, idempotencyKey);
  return row ? operations.get(row.id) : null;
}

/*
 * Start a durable operation. The per-server lock keeps two mutations off the
 * same worlds directory; a replayed Idempotency-Key returns the original
 * operation instead of doing the work twice.
 */
function beginOperation({ kind, actorId, desc, idempotencyKey, summary, name, source, destination }) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required for this request.', 400, 'idempotency_key_required');
  const existing = findOperationByKey(actorId, idempotencyKey);
  if (existing) return { operation: existing, replay: true };

  const op = operations.create({ kind, actorId, serverId: desc.id, idempotencyKey, summary });
  if (!operations.acquireServerLock(op.id, desc.id)) {
    operations.fail(op.id, { code: 'server_busy', text: 'another operation is already running for this server' });
    fail('Another operation is already running for this server.', 409, 'server_busy');
  }
  recordOperation({ operationId: op.id, serverId: desc.id, name, action: ACTIONS[kind] || kind, source, destination });
  return { operation: op, replay: false };
}

// Cancellation may only take effect before a commit; after a promoting rename
// we are past the point where stopping is safe, so nothing checks this again
// and the operation runs to a verified end.
function checkpoint(operationId, phase, progress) {
  const op = operations.get(operationId);
  if (!op || op.state === operations.STATES.CANCELLED) throw new Cancelled();
  operations.heartbeat(operationId, { phase, progress });
  operations.appendEvent(operationId, { phase, message: phase, level: 'info' });
}

/*
 * Terminal handling shared by every runner:
 *
 *   cancelled          - stopped before the commit; nothing changed.
 *   failed             - stopped before the commit; nothing changed, with a reason.
 *   recovery_required  - the worlds directory and the descriptor may disagree.
 *                        This never resolves itself and never reports success.
 */
function settle(operationId, err, { compensated }) {
  if (err instanceof Cancelled) {
    operations.cancel(operationId);
    recordResult(operationId, { cancelled: true });
    return;
  }
  const code = err.code || 'valheim_world_operation_failed';
  if (compensated === false) {
    operations.markRecoveryRequired(operationId, {
      code,
      text: err.message,
      recovery: {
        instructions: 'The world folder and this server\'s configuration may disagree. Review the world list before running further operations.',
      },
    });
  } else {
    operations.fail(operationId, { code, text: err.message });
  }
  recordResult(operationId, { error: code });
}

function requireOffline(manager, what) {
  if (!manager || manager.status !== 'offline') {
    fail(`Stop the server before ${what}.`, 409, 'server_online');
  }
}

// Previews carry POSIX-separated relative paths (they reach the API);
// lib/snapshots.cjs compares scope entries against `path.relative` output,
// which uses the host separator. This is the one place that translates.
const scopeFor = (list) => (Array.isArray(list) ? list : []).map((entry) => String(entry).split('/').join(path.sep));

/* ----------------------------------------------------------------- selection -- */

/*
 * Selection changes one descriptor field and nothing on disk - so unlike
 * Terraria/Minecraft there is no companion file to keep in sync and no
 * snapshot to take. An existing pair must be `healthy` (both members
 * present) to be selected; a name with neither file yet is the "create new
 * world" path Valheim's own dedicated server handles by generating on first
 * connect - `willCreate: true` marks that case rather than refusing it.
 * `incomplete`/`unreadable` pairs are refused: selecting one would point
 * `-world` at data that is not there or not readable.
 */
function previewSelect({ desc, actorId, name: rawName, manager }) {
  const name = normalizeName(rawName);
  const saveDir = resolveSaveDir(desc);
  const pair = readPair(saveDir, name);
  const willCreate = pair.health === 'missing';
  if (!willCreate && pair.health !== 'healthy') {
    const reason = pair.health === 'incomplete' ? 'its world pair is incomplete: one file is missing' : 'one of its files is empty or unreadable';
    fail(`"${name}" cannot be selected because ${reason}. Both the metadata and data files must be present.`, 422, `world_${pair.health}`);
  }

  const selection = currentSelection(desc);
  return savePreview({
    desc, actorId, action: ACTIONS[KIND.SELECT], name,
    payload: {
      action: ACTIONS[KIND.SELECT],
      name,
      world: willCreate ? null : worldModel(pair, { active: false }),
      willCreate,
      current: selection.name,
      alreadySelected: !!selection.name && sameName(selection.name, name),
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      restartRequired: true,
      disk: diskPlan(saveDir.abs, 0),
    },
  });
}

/*
 * Every runner does all of its work inside the try, including resolving the
 * save directory: anything that throws before it would leave the operation
 * `running`, holding the per-server lock until a boot sweep found it.
 */
async function runSelect({ desc, manager, operationId, preview, saveDescriptor, readDescriptor }) {
  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    requireOffline(manager, 'selecting a world');

    checkpoint(operationId, 'commit', 0.6);
    try {
      saveDescriptor({ worldName: preview.name });
    } catch (error) {
      fail(`The panel configuration could not be saved: ${error.message}`, 500, 'config_save_failed');
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.95 });
    const stored = readDescriptor ? readDescriptor() : null;
    if (!stored || String(stored.worldName || '') !== preview.name) {
      const err = new ValheimWorldError('The selection did not verify: the panel configuration does not agree.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    const result = { name: preview.name, willCreate: !!preview.willCreate, restartRequired: true };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ------------------------------------------------------------------ import -- */

/*
 * Uploads are staged under the Hostkind data directory, never inside a
 * server folder: nothing an operator uploaded reaches a server's own tree
 * until an import commits it.
 */
function importStagingDir(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) fail('That upload is no longer available. Upload it again.', 409, 'staging_missing');
  return path.join(dataDir(), 'valheim-world-imports', safe);
}

function sweepImportStaging({ now = Date.now(), maxAgeMs = PREVIEW_TTL } = {}) {
  const root = path.join(dataDir(), 'valheim-world-imports');
  if (!fs.existsSync(root)) return [];
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).mtimeMs >= now - maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (_) { /* locked: the next sweep gets it */ }
  }
  return removed;
}

function normalizeArchiveError(err) {
  if (err instanceof ArchiveError) return err;
  const message = String((err && err.message) || '');
  if (/invalid relative path|\.\./i.test(message)) return new ArchiveError(`path escapes root: ${message}`, 'path_traversal');
  if (/absolute path/i.test(message)) return new ArchiveError(`absolute path in archive: ${message}`, 'absolute_path');
  if (/invalid characters|malformed|end of central directory|not a zip/i.test(message)) {
    return new ArchiveError('The archive is not a readable zip file.', 'invalid_archive');
  }
  return err;
}

/*
 * Extract a world pair (and any recognized backups) out of a zip into a
 * staging directory. Every entry goes through the shared guard before
 * anything is written. Only `.fwl`/`.db`/backup-pattern files are extracted -
 * a zip of a whole Valheim save folder carries logs and configs that are not
 * ours to write into a server - and a second `.fwl` or `.db` is refused as an
 * ambiguity nobody may resolve on the operator's behalf.
 */
function extractPairFromArchive(archivePath, destination, limits = {}) {
  const guard = { maxEntries: MAX_IMPORT_ENTRIES, maxTotalSize: MAX_IMPORT_BYTES, ...limits };
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ArchiveError('The archive could not be read.', 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const written = [];
      let settled = false;
      const bail = (err) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) { /* */ }
        reject(normalizeArchiveError(err));
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        let rel;
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          rel = checkEntry(entry, state, guard);
        } catch (err) { return bail(err); }

        const base = path.posix.basename(rel);
        const lower = base.toLowerCase();
        const wanted = lower.endsWith(META_EXT) || lower.endsWith(DATA_EXT) || /_backup_/.test(lower);
        if (!wanted) { zip.readEntry(); return; }
        if (lower.endsWith(META_EXT) && written.some((n) => n.toLowerCase().endsWith(META_EXT))) {
          return bail(new ArchiveError('The archive contains more than one world.', 'multiple_worlds'));
        }
        if (lower.endsWith(DATA_EXT) && written.some((n) => n.toLowerCase().endsWith(DATA_EXT))) {
          return bail(new ArchiveError('The archive contains more than one world.', 'multiple_worlds'));
        }
        if ((entry.uncompressedSize || 0) > MAX_PAIR_FILE_BYTES) {
          return bail(new ArchiveError(`${base} is larger than a Valheim world file can be.`, 'entry_too_large'));
        }
        let target;
        try { target = safeResolve(destination, base); }
        catch { return bail(new ArchiveError(`entry escapes the staging root: ${rel}`, 'path_traversal')); }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return bail(streamError);
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', bail);
          out.on('error', bail);
          out.on('close', () => { written.push(base); zip.readEntry(); });
          stream.pipe(out);
        });
      });
      zip.on('end', () => {
        if (settled) return;
        try { finalize(state); settled = true; resolve(written); } catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

/*
 * Describe what importing a staged payload would do. `staged` is
 * `{ dir, kind: 'upload' | 'archive' | 'folder', archive?, originalName? }` -
 * `'folder'` is not produced by this module's own routes, but keeps the shape
 * open for phase 9's adoption flow ("Import world only: use phase 3",
 * docs/valheim/09-import-portability.md) to call this function directly with
 * an already-staged directory, without a signature change.
 */
async function previewImport({ desc, actorId, staged, requestedName, select = false, manager }) {
  const saveDir = resolveSaveDir(desc);
  const stagingDir = String(staged.dir);
  const payloadDir = path.join(stagingDir, 'payload');

  let files;
  if (staged.kind === 'archive') {
    files = await extractPairFromArchive(path.join(stagingDir, staged.archive), payloadDir);
  } else {
    files = fs.readdirSync(payloadDir);
  }

  const metaFile = files.find((n) => n.toLowerCase().endsWith(META_EXT));
  const dataFile = files.find((n) => n.toLowerCase().endsWith(DATA_EXT));
  if (!metaFile || !dataFile) fail('Upload both the .fwl metadata file and its matching .db data file.', 422, 'pair_incomplete');

  const metaBase = path.basename(metaFile, META_EXT);
  const dataBase = path.basename(dataFile, DATA_EXT);
  if (metaBase !== dataBase) {
    if (sameName(metaBase, dataBase)) {
      fail('The .fwl and .db file names differ only in case; that is ambiguous and refused.', 422, 'name_case_ambiguous');
    }
    fail('The .fwl and .db files must share the same base name.', 422, 'name_mismatch');
  }

  const metaStat = statOf(path.join(payloadDir, metaFile));
  const dataStat = statOf(path.join(payloadDir, dataFile));
  if (!metaStat || metaStat.size === 0) fail('The uploaded .fwl file is empty or unreadable.', 422, 'metadata_empty');
  if (!dataStat || dataStat.size === 0) fail('The uploaded .db file is empty or unreadable.', 422, 'database_empty');

  // Only backups whose own name is prefixed by the pair's base name travel
  // with it; anything else in the payload is ignored, never guessed at.
  const recognizedBackups = files
    .filter((n) => n !== metaFile && n !== dataFile)
    .filter((n) => backupPattern(metaBase).test(n));

  const name = normalizeName(requestedName || metaBase);
  pairPaths(saveDir, name); // refuses anything that would land outside the worlds directory
  assertNameFree(saveDir, name);

  const sizeBytes = metaStat.size + dataStat.size + recognizedBackups.reduce((sum, n) => {
    const s = statOf(path.join(payloadDir, n));
    return sum + (s ? s.size : 0);
  }, 0);

  return savePreview({
    desc, actorId, action: ACTIONS[KIND.IMPORT], name,
    payload: {
      action: ACTIONS[KIND.IMPORT],
      source: {
        kind: staged.kind,
        originalName: path.basename(String(staged.originalName || metaFile)),
        metaFile, dataFile, backups: recognizedBackups, sizeBytes,
      },
      name,
      select: !!select,
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [saveDir.rel],
      disk: diskPlan(saveDir.abs, sizeBytes),
      staging: path.basename(stagingDir),
    },
  });
}

async function runImport({ desc, manager, operationId, preview, saveDescriptor, readDescriptor }) {
  let stagingDir = null;
  let snapshot = null;
  let committed = false;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    stagingDir = importStagingDir(preview.staging);
    const payloadDir = path.join(stagingDir, 'payload');
    if (!fs.existsSync(path.join(payloadDir, preview.source.metaFile)) || !fs.existsSync(path.join(payloadDir, preview.source.dataFile))) {
      fail('The uploaded world is no longer available. Upload it again.', 409, 'staging_missing');
    }
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));
    assertNameFree(saveDir, preview.name);

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'importing a world');

    checkpoint(operationId, 'snapshot', 0.3);
    fs.mkdirSync(saveDir.abs, { recursive: true });
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'valheim-world-import', reason: `Import "${preview.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    checkpoint(operationId, 'commit', 0.6);
    const tx = new Transaction({ serverDir: saveDir.root, operationId });
    tx.stageCopy(path.join(payloadDir, preview.source.metaFile), path.posix.join(saveDir.rel, `${preview.name}${META_EXT}`));
    tx.stageCopy(path.join(payloadDir, preview.source.dataFile), path.posix.join(saveDir.rel, `${preview.name}${DATA_EXT}`));
    // Backups travel with the import under their original names. If the
    // operator also renamed on import, the backups keep their old prefix and
    // are simply not pattern-matched to the new name until an explicit
    // rename moves them too - nothing is lost, nothing is guessed.
    const importedBackups = [];
    for (const backupFile of preview.source.backups || []) {
      tx.stageCopy(path.join(payloadDir, backupFile), path.posix.join(saveDir.rel, BACKUPS_DIR, backupFile));
      importedBackups.push(backupFile);
    }
    tx.saveJournal();
    operations.appendEvent(operationId, { phase: 'journal', message: 'commit plan written', level: 'info', metadata: { entries: tx.journal.length } });

    tx.commit();
    committed = true;
    operations.heartbeat(operationId, { phase: 'verify', progress: 0.8 });

    const pair = readPair(saveDir, preview.name);
    if (pair.health !== 'healthy') {
      const err = new ValheimWorldError('The imported world is not readable after the commit.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    // The import itself is already committed at this point - unlike rename
    // and delete, a failed select here cannot leave the descriptor pointing
    // at data that no longer exists (it is either unchanged, or still points
    // at some other world that still exists), so this is a soft failure
    // reported in the result rather than a reason to fail or recover the
    // whole (successful) import.
    let selected = false;
    let selectError = null;
    if (preview.select) {
      operations.heartbeat(operationId, { phase: 'select', progress: 0.9 });
      try { saveDescriptor({ worldName: preview.name }); selected = true; }
      catch (error) { selectError = error.message; }
    }

    operations.heartbeat(operationId, { phase: 'cleanup', progress: 0.97 });
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* swept later */ }
    if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* retention sweeps it */ } }

    const result = { name: preview.name, backups: importedBackups, selected, selectError, restartRequired: selected };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!committed) {
      if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* swept later */ } }
      if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ------------------------------------------------------------------ rename -- */

/*
 * No Terraria/Minecraft precedent - new plumbing, following the same
 * staged-transaction shape those modules use for multi-file promotion.
 * Renaming moves whichever of `.fwl`/`.db`/recognized backups exist (an
 * incomplete pair may still be renamed; the point is that *everything that
 * exists* moves together, not that the pair must be complete first).
 */
function previewRename({ desc, actorId, from: rawFrom, to: rawTo, manager }) {
  const from = normalizeName(rawFrom);
  const to = normalizeName(rawTo);
  const saveDir = resolveSaveDir(desc);
  const pair = readPair(saveDir, from);
  if (pair.health === 'missing') fail(`"${from}" does not exist.`, 404, 'world_not_found');
  if (from === to) fail('Choose a different name.', 400, 'name_unchanged');
  if (CASE_INSENSITIVE_HOST && sameName(from, to)) {
    fail('That name differs from the current one only by case, which this filesystem treats as the same file.', 400, 'name_case_only');
  }
  assertNameFree(saveDir, to);

  const selection = currentSelection(desc);
  const selected = !!selection.name && sameName(selection.name, from);
  return savePreview({
    desc, actorId, action: ACTIONS[KIND.RENAME], name: from,
    payload: {
      action: ACTIONS[KIND.RENAME],
      from, to,
      world: worldModel(pair, { active: selected }),
      selected,
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [saveDir.rel],
      restartRequired: selected,
      disk: diskPlan(saveDir.abs, pair.sizeBytes),
    },
  });
}

async function runRename({ desc, manager, operationId, preview, saveDescriptor, readDescriptor }) {
  let snapshot = null;
  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    const pair = readPair(saveDir, preview.from);
    if (pair.health === 'missing') fail(`"${preview.from}" does not exist.`, 404, 'world_not_found');
    assertNameFree(saveDir, preview.to);
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'renaming a world');

    checkpoint(operationId, 'snapshot', 0.3);
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'valheim-world-rename', reason: `Rename "${preview.from}" to "${preview.to}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    checkpoint(operationId, 'commit', 0.6);
    const tx = new Transaction({ serverDir: saveDir.root, operationId });
    if (pair.fwlStat) {
      tx.stageCopy(pair.fwl, path.posix.join(saveDir.rel, `${preview.to}${META_EXT}`));
      tx.stageRemove(path.posix.join(saveDir.rel, `${preview.from}${META_EXT}`));
    }
    if (pair.dbStat) {
      tx.stageCopy(pair.db, path.posix.join(saveDir.rel, `${preview.to}${DATA_EXT}`));
      tx.stageRemove(path.posix.join(saveDir.rel, `${preview.from}${DATA_EXT}`));
    }
    const renamedBackups = [];
    for (const backup of pair.backups) {
      // Preserve everything after the base name (the "_backup_..." suffix).
      const suffix = backup.file.slice(preview.from.length);
      const newName = `${preview.to}${suffix}`;
      tx.stageCopy(path.join(saveDir.abs, BACKUPS_DIR, backup.file), path.posix.join(saveDir.rel, BACKUPS_DIR, newName));
      tx.stageRemove(path.posix.join(saveDir.rel, BACKUPS_DIR, backup.file));
      renamedBackups.push({ from: backup.file, to: newName });
    }
    tx.saveJournal();
    operations.appendEvent(operationId, { phase: 'journal', message: 'commit plan written', level: 'info', metadata: { entries: tx.journal.length } });
    tx.commit();

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.8 });
    if (fs.existsSync(pair.fwl) || fs.existsSync(pair.db)) {
      const err = new ValheimWorldError('The old world files are still present after the rename.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }
    const renamedPair = readPair(saveDir, preview.to);
    if (!!pair.fwlStat !== !!renamedPair.fwlStat || !!pair.dbStat !== !!renamedPair.dbStat) {
      const err = new ValheimWorldError('The rename did not verify: not every file moved.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    let reselected = false;
    if (preview.selected) {
      operations.heartbeat(operationId, { phase: 'reselect', progress: 0.9 });
      try { saveDescriptor({ worldName: preview.to }); }
      catch (error) {
        const err = new ValheimWorldError(`The world was renamed but the selection could not be updated: ${error.message}`, { code: 'config_save_failed' });
        err.compensated = false;
        throw err;
      }
      const stored = readDescriptor ? readDescriptor() : null;
      if (!stored || String(stored.worldName || '') !== preview.to) {
        const err = new ValheimWorldError('The renamed selection did not verify.', { code: 'verify_failed' });
        err.compensated = false;
        throw err;
      }
      reselected = true;
    }

    const result = { from: preview.from, to: preview.to, backups: renamedBackups, reselected };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* retention sweeps it */ } }
    return result;
  } catch (err) {
    if (snapshot && err.compensated !== false) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ------------------------------------------------------------------ delete -- */

function previewDelete({ desc, actorId, name: rawName, manager }) {
  const name = normalizeName(rawName);
  const saveDir = resolveSaveDir(desc);
  const pair = readPair(saveDir, name);
  if (pair.health === 'missing') fail(`"${name}" does not exist.`, 404, 'world_not_found');

  const selection = currentSelection(desc);
  const active = !!selection.name && sameName(selection.name, name);
  return savePreview({
    desc, actorId, action: ACTIONS[KIND.DELETE], name,
    payload: {
      action: ACTIONS[KIND.DELETE],
      world: worldModel(pair, { active }),
      backups: pair.backups.map((b) => b.file),
      active,
      // Deleting the selected world clears the selection: the configuration
      // may never be left pointing `-world` at data that is gone.
      clearsSelection: active,
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [saveDir.rel],
      disk: diskPlan(saveDir.abs, pair.sizeBytes),
      retentionDays: trash.DEFAULT_RETENTION_DAYS,
    },
  });
}

async function runDelete({ desc, manager, operationId, preview, actorId, saveDescriptor, readDescriptor, servers = [] }) {
  let snapshot = null;
  const moved = [];

  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    const pair = readPair(saveDir, preview.world.name);
    if (pair.health === 'missing') fail(`"${preview.world.name}" does not exist.`, 404, 'world_not_found');
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'deleting a world');

    checkpoint(operationId, 'snapshot', 0.3);
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'valheim-world-delete', reason: `Delete "${preview.world.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    /*
     * Quarantine, never a recursive remove. Each file is moved on its own so
     * it can be restored to exactly where it came from; if one move fails,
     * the ones already moved are put back and nothing has been lost.
     */
    checkpoint(operationId, 'quarantine', 0.5);
    const targets = [];
    if (pair.fwlStat) targets.push(pair.fwl);
    if (pair.dbStat) targets.push(pair.db);
    for (const backup of pair.backups) targets.push(path.join(saveDir.abs, BACKUPS_DIR, backup.file));

    try {
      for (const target of targets) {
        if (!fs.existsSync(target)) continue;
        const entry = trash.moveToTrash({
          target, kind: 'valheim-world', serverId: desc.id, label: path.basename(target),
          reason: `Deleted with world "${preview.world.name}"`, actorId: actorId || null, scope: 'item', servers,
        });
        moved.push({ file: path.basename(target), trashId: entry ? entry.id : null });
      }
    } catch (error) {
      for (const item of moved.slice().reverse()) {
        if (item.trashId) { try { trash.restore(item.trashId, { servers }); } catch (_) { /* the snapshot is the backstop */ } }
      }
      fail(`The world could not be moved to trash, so nothing was deleted: ${error.message}`, error.status || 500, error.code || 'trash_failed');
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.75 });
    if (fs.existsSync(pair.fwl) || fs.existsSync(pair.db)) {
      const err = new ValheimWorldError('The world file is still present after the delete.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    let selectionCleared = false;
    if (preview.clearsSelection) {
      operations.heartbeat(operationId, { phase: 'clear-selection', progress: 0.85 });
      try { saveDescriptor({ worldName: null }); }
      catch (error) {
        const err = new ValheimWorldError(`The world was deleted but the selection could not be cleared: ${error.message}`, { code: 'config_save_failed' });
        err.compensated = false;
        throw err;
      }
      const stored = readDescriptor ? readDescriptor() : null;
      if (stored && stored.worldName) {
        const err = new ValheimWorldError('The selection could not be cleared.', { code: 'verify_failed' });
        err.compensated = false;
        throw err;
      }
      selectionCleared = true;
    }

    const result = {
      name: preview.world.name,
      files: moved.map((item) => item.file),
      trash: moved.map((item) => item.trashId).filter(Boolean),
      retentionDays: trash.DEFAULT_RETENTION_DAYS,
      selectionCleared,
      snapshotId: snapshot.id,
    };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!moved.length && snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ---------------------------------------------------------------- download -- */

// A downloadable name a browser cannot be talked into interpreting: ASCII
// only, no separators, no quotes, no control characters. Same rule as
// lib/terraria-worlds.cjs's `safeDownloadName`.
function safeDownloadName(serverName, worldName, extension = '.zip') {
  const clean = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  const base = [clean(serverName) || 'server', clean(worldName) || 'world'].join('-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}-${stamp}${extension}`;
}

function downloadName(desc, rawName) {
  const name = normalizeName(rawName);
  const saveDir = resolveSaveDir(desc);
  const pair = readPair(saveDir, name);
  if (pair.health === 'missing') fail(`"${name}" does not exist.`, 404, 'world_not_found');
  const files = [];
  if (pair.fwlStat) files.push(pair.fwl);
  if (pair.dbStat) files.push(pair.db);
  for (const b of pair.backups) files.push(path.join(saveDir.abs, BACKUPS_DIR, b.file));
  return { filename: safeDownloadName(desc.name, name), files, name };
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/*
 * The doc's Export function: a zip of the pair plus recognized backups and a
 * small manifest - relative names, sizes and checksums only. Never an
 * absolute path, password, platform identity or address.
 */
async function archive(desc, rawName, output) {
  const name = normalizeName(rawName);
  const saveDir = resolveSaveDir(desc);
  const pair = readPair(saveDir, name);
  if (pair.health === 'missing') fail(`"${name}" does not exist.`, 404, 'world_not_found');

  const entries = [];
  if (pair.fwlStat) entries.push({ abs: pair.fwl, rel: `${name}${META_EXT}`, size: pair.fwlStat.size });
  if (pair.dbStat) entries.push({ abs: pair.db, rel: `${name}${DATA_EXT}`, size: pair.dbStat.size });
  for (const b of pair.backups) entries.push({ abs: path.join(saveDir.abs, BACKUPS_DIR, b.file), rel: `${BACKUPS_DIR}/${b.file}`, size: b.sizeBytes });

  const manifest = { version: 1, name, files: [] };
  for (const entry of entries) {
    manifest.files.push({ name: entry.rel, sizeBytes: entry.size, sha256: await sha256File(entry.abs) });
  }

  const filename = safeDownloadName(desc.name, name);
  const zip = archiver('zip', { zlib: { level: 9 } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve({ filename }); };
    zip.on('error', done);
    output.on('close', () => done());
    output.on('error', done);
    zip.pipe(output);
    for (const entry of entries) zip.file(entry.abs, { name: entry.rel });
    zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    zip.finalize();
  });
}

module.exports = {
  META_EXT, DATA_EXT, WORLDS_DIR, BACKUPS_DIR, PREVIEW_TTL,
  KIND, ACTIONS,
  ValheimWorldError, Cancelled,
  normalizeName, sameName,
  resolveSaveDir, pairPaths, readPair, worldModel, assertNameFree,
  inventory, currentSelection,
  freeBytes, diskPlan, assertDisk,
  fingerprint,
  savePreview, consumePreview,
  beginOperation, findOperationByKey, recordOperation, recordResult, listOperations, activeOperations, checkpoint,
  importStagingDir, sweepImportStaging, extractPairFromArchive,
  previewSelect, runSelect,
  previewImport, runImport,
  previewRename, runRename,
  previewDelete, runDelete,
  archive, downloadName, safeDownloadName,
};
