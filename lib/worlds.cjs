'use strict';

/*
 * World operations (docs/roadmap/08-world-operations.md).
 *
 * Worlds are the only thing on a Minecraft server that cannot be re-downloaded.
 * Every rule in this module follows from that:
 *
 *   - The configured worlds in config.json are authoritative. Scanning the disk
 *     can *suggest* a world, never register one; `world_inventory` is a cache.
 *   - Anything that replaces or removes a registered world requires the server
 *     to be offline, a verified snapshot, and a preview the same actor took.
 *   - Deletion is a staged rename into .lodestone/trash/<operationId>, retained
 *     until the operation has verified its own result. Nothing is recursively
 *     removed while it might still be needed.
 *   - Filesystem and config must agree before an operation may succeed. If the
 *     config save fails after the rename, we rename back; if we cannot, the
 *     operation goes to recovery_required rather than reporting success.
 *   - Pre-generation asks Modrinth, at request time, whether a Chunky build
 *     exists for this exact loader and Minecraft version. There is no mapping
 *     table here to go stale, and "no compatible Chunky" is an honest answer.
 *
 * Paths never leave this module in absolute form: responses, audit metadata and
 * operation summaries carry world names and server-relative paths only.
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
const { fetchToFile } = require('./downloads.cjs');

const MARKER = 'level.dat';
const PREVIEW_TTL = 15 * 60 * 1000;
const MODRINTH = 'https://api.modrinth.com/v2';
const CHUNKY_SLUG = 'chunky';

// Bounds on the inventory scan. A world with more than this many files is
// reported as an estimate rather than walked to the end - an unbounded scan of
// a pathological tree would block the event loop for minutes.
const MAX_SCAN_ENTRIES = 200000;

// Import ceilings. These sit on top of the shared archive guard's own limits.
const MAX_IMPORT_ENTRIES = 200000;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024 * 1024; // 32 GiB expanded
const DISK_HEADROOM = 1.25; // require 25% more free space than we expect to use

// Kinds. "world-write" is what operations.isDestructiveKind() looks for: an
// interrupted one becomes recovery_required and never resumes on its own.
const KIND = Object.freeze({
  IMPORT:      'world-write.import',
  CLONE:       'world-write.clone',
  DELETE:      'world-write.delete',
  ARCHIVE:     'world-archive',
  PREGENERATE: 'world-pregenerate',
});

const ACTIONS = Object.freeze({
  [KIND.IMPORT]: 'import', [KIND.CLONE]: 'clone', [KIND.DELETE]: 'delete',
  [KIND.ARCHIVE]: 'archive', [KIND.PREGENERATE]: 'pregenerate',
});

class WorldError extends Error {
  constructor(message, { status = 400, code = 'world_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (message, status, code) => { throw new WorldError(message, { status, code }); };

// --- names ----------------------------------------------------------------

/*
 * A world name is a single path segment we are willing to create on any of the
 * three supported platforms. Anything else is refused rather than repaired, so
 * a name in config.json always means exactly one directory under the server
 * folder - no separators, no drive letters, no dot-names, no Windows devices.
 */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => [`com${i + 1}`, `lpt${i + 1}`]).flat()]);

function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) fail('A world name is required.', 400, 'name_required');
  if (name.length > 64) fail('World names are limited to 64 characters.', 400, 'name_too_long');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    fail('World names may only contain letters, digits, spaces, dots, dashes and underscores.', 400, 'name_invalid');
  }
  if (name === '.' || name === '..' || name.endsWith('.') || name.endsWith(' ')) fail('That world name is not a valid folder name.', 400, 'name_invalid');
  if (RESERVED.has(name.toLowerCase())) fail('That world name is reserved by the operating system.', 400, 'name_reserved');
  return name;
}

// The world id is the name. It is stable, it is what the console commands take,
// and it is what config.json stores - deriving a second identifier would only
// create a way for the two to disagree.
const worldId = (name) => name;

// Case-insensitive, because a name that collides only by case is a collision on
// Windows and macOS and a silently different world on Linux.
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// --- server helpers -------------------------------------------------------

function configuredWorlds(server) {
  const list = Array.isArray(server.worlds) && server.worlds.length ? server.worlds : ['world'];
  return [...new Set(list.map(String))];
}

/*
 * Registered roots must not nest. `world` and `world/region` as two registered
 * worlds would make "delete world" also delete a second registered world, and
 * every impact preview would be a lie. We refuse the configuration instead of
 * guessing which one the operator meant.
 */
function assertNoOverlap(names) {
  const lower = names.map((n) => n.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    for (let j = 0; j < lower.length; j++) {
      if (i === j) continue;
      if (lower[i] === lower[j] || lower[j].startsWith(lower[i] + '/')) {
        fail(`Registered worlds overlap: "${names[i]}" and "${names[j]}".`, 409, 'overlapping_roots');
      }
    }
  }
}

/*
 * Resolve a world folder inside the server root. Refuses traversal (safeResolve)
 * and refuses a symlinked root: following one would let a world "inside" the
 * server folder write, or be deleted, anywhere on the host.
 */
function worldPath(server, name) {
  let abs;
  try { abs = safeResolve(server.dir, name); }
  catch { fail('That world path is not inside the server folder.', 400, 'path_escape'); }
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) fail('That world folder is a link; links are not supported.', 409, 'symlink_root');
  } catch (err) {
    if (err instanceof WorldError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  return abs;
}

/*
 * Bounded directory walk. Returns the estimate flag rather than pretending a
 * truncated walk is a complete measurement.
 */
function dirStats(abs) {
  const out = { fileCount: 0, sizeBytes: 0, lastModified: 0, truncated: false };
  if (!fs.existsSync(abs)) return { ...out, missing: true };
  const stack = [abs];
  while (stack.length) {
    if (out.fileCount >= MAX_SCAN_ENTRIES) { out.truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never measure, copy or delete through a link
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      out.fileCount += 1;
      out.sizeBytes += st.size;
      if (st.mtimeMs > out.lastModified) out.lastModified = st.mtimeMs;
    }
  }
  return out;
}

/*
 * The marker hash identifies *this* world: level.dat holds the seed, the
 * generator settings and the world's own UUID. Hashing it lets a preview notice
 * that the world it described was swapped for a different one before commit.
 */
function markerHash(abs) {
  const marker = path.join(abs, MARKER);
  try {
    const st = fs.statSync(marker);
    if (!st.isFile() || st.size > 16 * 1024 * 1024) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(marker)).digest('hex');
  } catch (_) {
    return null;
  }
}

const hasMarker = (abs) => { try { return fs.statSync(path.join(abs, MARKER)).isFile(); } catch (_) { return false; } };

// Vanilla keeps the nether and the end inside the overworld folder (DIM-1 /
// DIM1); Paper splits them into sibling folders. Report what is actually there.
function dimensionsOf(abs) {
  const dims = [];
  if (fs.existsSync(path.join(abs, 'region'))) dims.push('overworld');
  if (fs.existsSync(path.join(abs, 'DIM-1'))) dims.push('the_nether');
  if (fs.existsSync(path.join(abs, 'DIM1'))) dims.push('the_end');
  const custom = path.join(abs, 'dimensions');
  if (fs.existsSync(custom)) {
    try {
      for (const ns of fs.readdirSync(custom, { withFileTypes: true })) {
        if (ns.isDirectory()) dims.push(`custom:${ns.name}`);
      }
    } catch (_) { /* unreadable: report what we have */ }
  }
  return dims;
}

// --- inventory ------------------------------------------------------------

function cacheInventory(serverId, entries) {
  const db = open();
  db.transaction(() => {
    db.prepare('DELETE FROM world_inventory WHERE server_id = ?').run(serverId);
    const insert = db.prepare(`
      INSERT INTO world_inventory (server_id, world_id, name, relative_path, marker_hash, size_bytes, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of entries) insert.run(serverId, e.id, e.name, e.relativePath, e.markerHash, e.sizeBytes, e.scannedAt);
  })();
}

/*
 * The read model behind GET /api/worlds. `worlds` are the registered ones;
 * `candidates` are folders that look like worlds but are not registered -
 * they are shown so an operator can confirm registration, never adopted
 * automatically.
 */
function inventory(server, { status = 'offline', activeOperations = [] } = {}) {
  const names = configuredWorlds(server);
  assertNoOverlap(names);
  const scannedAt = Date.now();
  const byWorld = new Map();
  for (const op of activeOperations) if (op.worldId) byWorld.set(op.worldId, op);

  const worlds = names.map((name) => {
    const abs = worldPath(server, name);
    const stats = dirStats(abs);
    const op = byWorld.get(worldId(name)) || null;
    return {
      id: worldId(name),
      name,
      relativePath: name,
      exists: !stats.missing,
      hasMarker: hasMarker(abs),
      markerHash: markerHash(abs),
      dimensions: dimensionsOf(abs),
      sizeBytes: stats.sizeBytes,
      fileCount: stats.fileCount,
      sizeEstimated: !!stats.truncated,
      lastModified: stats.lastModified || null,
      scannedAt,
      operation: op ? { id: op.operationId, action: op.action, state: op.state, phase: op.phase, progress: op.progress } : null,
    };
  });
  cacheInventory(server.id, worlds.map((w) => ({ ...w, markerHash: w.markerHash })));

  // Unregistered folders that carry a level.dat. Registration is a decision,
  // not a discovery, so these are advisory only.
  const candidates = [];
  try {
    for (const e of fs.readdirSync(server.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
      if (names.some((n) => sameName(n, e.name))) continue;
      const abs = path.join(server.dir, e.name);
      if (!hasMarker(abs)) continue;
      const stats = dirStats(abs);
      candidates.push({ name: e.name, relativePath: e.name, sizeBytes: stats.sizeBytes, sizeEstimated: !!stats.truncated, lastModified: stats.lastModified || null });
    }
  } catch (_) { /* server folder unreadable: report the registered worlds anyway */ }

  return { serverId: server.id, serverStatus: status, scannedAt, worlds, candidates };
}

function findWorld(server, id) {
  const name = configuredWorlds(server).find((n) => worldId(n) === id || sameName(n, id));
  if (!name) fail('World not found.', 404, 'world_not_found');
  return { id: worldId(name), name, abs: worldPath(server, name) };
}

// --- disk -----------------------------------------------------------------

/*
 * Free space on the filesystem holding the server folder. statfs is not
 * available on every mount, and "we don't know" must not read as "there is
 * room": an unknown capacity makes every disk gate fail closed.
 */
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) {
    return null;
  }
}

/*
 * Every mutation stages a full copy before it commits, so the requirement is
 * the payload plus headroom - not just the payload.
 */
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

// --- previews -------------------------------------------------------------

/*
 * The fingerprint is what makes a preview a promise about a specific state of
 * the disk. If any registered world's marker or size changed since the preview,
 * the impact we showed is no longer the impact we would have, and the mutation
 * refuses to run against it.
 */
function fingerprint(server) {
  const parts = configuredWorlds(server).map((name) => {
    const abs = worldPath(server, name);
    const stats = dirStats(abs);
    return `${name}:${markerHash(abs) || 'none'}:${stats.sizeBytes}:${stats.fileCount}`;
  });
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function savePreview({ server, actorId, action, worldId: id, payload }) {
  const token = crypto.randomUUID();
  const now = Date.now();
  open().prepare(`
    INSERT INTO world_previews (token, server_id, actor_id, action, world_id, created_at, expires_at, fingerprint, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, server.id, actorId, action, id || null, now, now + PREVIEW_TTL, fingerprint(server), JSON.stringify(payload));
  return { token, expiresAt: now + PREVIEW_TTL, ...payload };
}

/*
 * Consume a preview. Single-use: the row is deleted as it is read, so a replayed
 * request has to take a fresh preview and see the current impact - it cannot
 * reuse consent that was given for a state of the world that no longer holds.
 */
function consumePreview({ token, server, actorId, action }) {
  const db = open();
  const row = db.prepare('SELECT * FROM world_previews WHERE token = ?').get(String(token || ''));
  if (!row || row.actor_id !== actorId || row.server_id !== server.id || row.action !== action) {
    fail('This action needs a current preview.', 409, 'preview_invalid');
  }
  db.prepare('DELETE FROM world_previews WHERE token = ?').run(row.token);
  if (row.expires_at < Date.now()) fail('The preview expired. Review the impact again.', 409, 'preview_expired');
  if (row.fingerprint !== fingerprint(server)) {
    fail('The worlds changed since the preview was taken. Review the impact again.', 409, 'preview_stale');
  }
  return JSON.parse(row.payload_json);
}

function purgeExpiredPreviews(now = Date.now()) {
  return open().prepare('DELETE FROM world_previews WHERE expires_at < ?').run(now).changes;
}

// --- durable operation plumbing ------------------------------------------

function recordOperation({ operationId, serverId, worldId: id, action, source, destination }) {
  open().prepare(`
    INSERT INTO world_operations (operation_id, server_id, world_id, action, source_json, destination_json, result_json)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(operation_id) DO NOTHING
  `).run(operationId, serverId, id || null, action, JSON.stringify(source || {}), JSON.stringify(destination || {}));
}

function recordResult(operationId, result) {
  open().prepare('UPDATE world_operations SET result_json = ? WHERE operation_id = ?')
    .run(JSON.stringify(result || {}), operationId);
}

function listOperations(serverId, limit = 25) {
  return open().prepare(`
    SELECT w.operation_id, w.world_id, w.action, w.source_json, w.destination_json, w.result_json,
           o.state, o.phase, o.progress, o.queued_at, o.finished_at, o.error_code, o.error_text
      FROM world_operations w
      JOIN operations o ON o.id = w.operation_id
     WHERE w.server_id = ?
     ORDER BY o.queued_at DESC
     LIMIT ?
  `).all(serverId, limit).map((r) => ({
    operationId: r.operation_id,
    worldId: r.world_id,
    action: r.action,
    state: r.state,
    phase: r.phase,
    progress: r.progress,
    queuedAt: r.queued_at,
    finishedAt: r.finished_at,
    error: r.error_code ? { code: r.error_code, text: r.error_text } : null,
    source: safeJson(r.source_json),
    destination: safeJson(r.destination_json),
    result: safeJson(r.result_json),
  }));
}

function activeOperations(serverId) {
  return listOperations(serverId, 50).filter((op) => op.state === 'running' || op.state === 'queued' || op.state === 'recovery_required');
}

function safeJson(text) { try { return text ? JSON.parse(text) : null; } catch (_) { return null; } }

class Cancelled extends Error {
  constructor() { super('cancelled'); this.code = 'cancelled'; }
}

// Cancellation may only take effect before a commit. After the rename we are
// past the point where stopping is the safe thing to do, so nothing checks this
// again and the operation runs to a verified end.
function checkpoint(operationId, phase, progress) {
  const op = operations.get(operationId);
  if (!op || op.state === operations.STATES.CANCELLED) throw new Cancelled();
  operations.heartbeat(operationId, { phase, progress });
  operations.appendEvent(operationId, { phase, message: phase, level: 'info' });
}

/*
 * Start a durable operation. The per-server lock is what keeps two mutations
 * off the same folder; a replayed Idempotency-Key returns the original
 * operation instead of doing the work twice.
 */
function findOperationByKey(actorId, idempotencyKey) {
  if (!actorId || !idempotencyKey) return null;
  const row = open().prepare('SELECT id FROM operations WHERE actor_id = ? AND idempotency_key = ?').get(actorId, idempotencyKey);
  return row ? operations.get(row.id) : null;
}

function beginOperation({ kind, actorId, server, idempotencyKey, summary, worldId: id, source, destination }) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required for this request.', 400, 'idempotency_key_required');
  const existing = findOperationByKey(actorId, idempotencyKey);
  if (existing) return { operation: existing, replay: true };

  const op = operations.create({ kind, actorId, serverId: server.id, idempotencyKey, summary });
  if (!operations.acquireServerLock(op.id, server.id)) {
    operations.fail(op.id, { code: 'server_busy', text: 'another operation is already running for this server' });
    fail('Another operation is already running for this server.', 409, 'server_busy');
  }
  recordOperation({ operationId: op.id, serverId: server.id, worldId: id, action: ACTIONS[kind] || kind, source, destination });
  return { operation: op, replay: false };
}

/*
 * Terminal handling shared by every runner. The distinction that matters:
 *
 *   - cancelled           - we stopped before the commit; nothing changed.
 *   - failed              - we stopped before the commit; nothing changed, and
 *                           the caller gets a reason.
 *   - recovery_required   - we got far enough that the filesystem and the config
 *                           may disagree. This never resolves itself.
 */
function settle(operationId, err, { compensated }) {
  if (err instanceof Cancelled) {
    operations.cancel(operationId);
    recordResult(operationId, { cancelled: true });
    return;
  }
  const code = err.code || 'world_operation_failed';
  if (compensated === false) {
    operations.markRecoveryRequired(operationId, {
      code,
      text: err.message,
      recovery: { instructions: 'The world folder and the panel configuration may disagree. Review the world list before running further operations.' },
    });
  } else {
    operations.fail(operationId, { code, text: err.message });
  }
  recordResult(operationId, { error: code });
}

// --- archive reading (import) --------------------------------------------

/*
 * yauzl validates entry names itself and refuses traversing or absolute ones
 * before our guard ever sees them - which is exactly the right order, but it
 * throws plain Errors. Map them onto the guard's vocabulary so a caller (and
 * the UI) only ever has to understand one set of codes.
 */
function normalizeArchiveError(err) {
  if (err instanceof ArchiveError) return err;
  const message = String(err && err.message || '');
  if (/invalid relative path|\.\./i.test(message)) return new ArchiveError(`path escapes root: ${message}`, 'path_traversal');
  if (/absolute path/i.test(message)) return new ArchiveError(`absolute path in archive: ${message}`, 'absolute_path');
  if (/invalid characters|malformed|end of central directory|not a zip/i.test(message)) return new ArchiveError('The archive is not a readable zip file.', 'invalid_archive');
  return err;
}

/*
 * Scan an uploaded archive through the shared guard, and work out which of its
 * top-level directories are worlds (a directory holding a level.dat). An
 * archive whose world sits at its own root ("level.dat" at depth 0) is a world
 * too - that is how most people zip them.
 */
function scanArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ArchiveError('The archive could not be read.', 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const roots = new Map(); // root ('' = archive root) -> { files, bytes, marker }
      let settled = false;
      const bail = (err) => { if (settled) return; settled = true; try { zip.close(); } catch (_) { /* */ } reject(normalizeArchiveError(err)); };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          const rel = checkEntry(entry, state, { maxEntries: MAX_IMPORT_ENTRIES, maxTotalSize: MAX_IMPORT_BYTES });
          const segments = rel.split('/');
          const root = segments.length > 1 ? segments[0] : '';
          const bucket = roots.get(root) || { files: 0, bytes: 0, marker: false };
          bucket.files += 1;
          bucket.bytes += entry.uncompressedSize || 0;
          const inside = segments.slice(root === '' ? 0 : 1).join('/');
          if (inside === MARKER) bucket.marker = true;
          roots.set(root, bucket);
          zip.readEntry();
        } catch (err) { bail(err); }
      });
      zip.on('end', () => {
        if (settled) return;
        try {
          const totals = finalize(state);
          settled = true;
          resolve({
            totals,
            roots: [...roots.entries()].map(([root, v]) => ({
              path: root, files: v.files, sizeBytes: v.bytes, hasMarker: v.marker,
            })).sort((a, b) => b.sizeBytes - a.sizeBytes),
          });
        } catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

/*
 * Extract exactly one root of the archive into a staging directory. Every entry
 * goes back through the guard (the scan and the extraction read the same central
 * directory, but they are two separate passes and only what we re-validate here
 * ever reaches the disk), and anything outside the chosen root is skipped.
 */
function extractRoot(file, root, destination, onProgress) {
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ArchiveError('The archive could not be read.', 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      let files = 0;
      let bytes = 0;
      let settled = false;
      const bail = (err) => { if (settled) return; settled = true; try { zip.close(); } catch (_) { /* */ } reject(normalizeArchiveError(err)); };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        let rel;
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          rel = checkEntry(entry, state, { maxEntries: MAX_IMPORT_ENTRIES, maxTotalSize: MAX_IMPORT_BYTES });
        } catch (err) { return bail(err); }
        const segments = rel.split('/');
        const inRoot = root === '' ? true : segments[0] === root;
        if (!inRoot) { zip.readEntry(); return; }
        const relInside = root === '' ? rel : segments.slice(1).join('/');
        if (!relInside) { zip.readEntry(); return; }
        let target;
        try { target = safeResolve(destination, relInside); }
        catch { return bail(new ArchiveError(`entry escapes the staging root: ${rel}`, 'path_traversal')); }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return bail(streamError);
          // 'wx' - a duplicate path that slipped past the guard fails loudly
          // rather than overwriting whatever was written first.
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', bail);
          out.on('error', bail);
          out.on('close', () => {
            files += 1;
            bytes += entry.uncompressedSize || 0;
            if (onProgress && files % 250 === 0) {
              try { onProgress({ files, bytes }); } catch (err) { return bail(err); }
            }
            zip.readEntry();
          });
          stream.pipe(out);
        });
      });
      zip.on('end', () => {
        if (settled) return;
        try { finalize(state); settled = true; resolve({ files, bytes }); }
        catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

function importStagingDir(token) {
  return path.join(dataDir(), 'world-imports', String(token).replace(/[^a-zA-Z0-9-]/g, ''));
}

// --- import ---------------------------------------------------------------

/*
 * Preview an uploaded archive: what worlds it contains, whether they carry the
 * marker, what registering one would collide with, what it would cost on disk,
 * and what would change in the configuration.
 */
async function previewImport({ server, actorId, archivePath, requestedName, mode = 'add' }) {
  const scan = await scanArchive(archivePath);
  const worldRoots = scan.roots.filter((r) => r.hasMarker);
  if (!worldRoots.length) {
    fail(`No world was found in the archive: none of its folders contain a ${MARKER}.`, 422, 'missing_marker');
  }
  const chosen = worldRoots[0];
  const registered = configuredWorlds(server);
  const suggested = requestedName || (chosen.path || path.basename(archivePath, path.extname(archivePath)));
  const name = normalizeName(suggested);
  const existingName = registered.find((n) => sameName(n, name)) || null;
  const abs = worldPath(server, name);
  const occupied = fs.existsSync(abs);

  if (mode !== 'add' && mode !== 'replace') fail('Unknown import mode.', 400, 'invalid_mode');
  if (mode === 'add' && (existingName || occupied)) {
    fail(`"${name}" already exists on this server. Choose another name, or import as a replacement.`, 409, 'name_collision');
  }
  if (mode === 'replace' && !existingName) {
    fail(`"${name}" is not a registered world, so there is nothing to replace.`, 409, 'not_registered');
  }

  const requiresOffline = mode === 'replace';
  const disk = diskPlan(server.dir, chosen.sizeBytes + (mode === 'replace' ? dirStats(abs).sizeBytes : 0));
  const replaced = mode === 'replace' ? { name: existingName, sizeBytes: dirStats(abs).sizeBytes } : null;

  return savePreview({
    server, actorId, action: 'import', worldId: mode === 'replace' ? worldId(existingName) : null,
    payload: {
      action: 'import',
      archive: { entries: scan.totals.entries, expandedBytes: scan.totals.totalSize, compressedBytes: scan.totals.totalCompressedSize },
      roots: scan.roots.map((r) => ({ path: r.path || '(archive root)', hasMarker: r.hasMarker, files: r.files, sizeBytes: r.sizeBytes })),
      selectedRoot: chosen.path,
      name,
      mode,
      replaced,
      disk,
      requiresOffline,
      registration: mode === 'replace' ? { replaces: existingName } : { adds: name },
      // Staging an import while the server is running is safe (nothing under the
      // live world is touched until the commit, which requires offline anyway).
      consistencyNote: requiresOffline ? 'replaceOffline' : null,
    },
  });
}

/*
 * Apply an import. Phases:
 *   preview-revalidate -> snapshot/verify -> extract to staging -> validate
 *   markers -> require offline -> journal -> rename commit -> update config ->
 *   verify -> cleanup
 */
async function runImport({ server, manager, saveWorlds, operationId, archivePath, preview }) {
  const { name, mode, selectedRoot } = preview;
  const abs = worldPath(server, name);
  const replacing = mode === 'replace';
  const staging = path.join(server.dir, '.lodestone', 'staging', operationId);
  const stagedWorld = path.join(staging, 'payload', name);
  const trash = path.join(server.dir, '.lodestone', 'trash', operationId);
  let snapshot = null;
  let committed = false;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.02);
    assertDisk(diskPlan(server.dir, preview.disk.requiredBytes));

    if (replacing) {
      checkpoint(operationId, 'snapshot', 0.05);
      snapshot = snapshots.take({ serverId: server.id, sourceDir: server.dir, scope: [name], kind: 'world-import', reason: `Import into "${name}"` });
      if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
    }

    checkpoint(operationId, 'extract', 0.15);
    fs.mkdirSync(path.dirname(stagedWorld), { recursive: true });
    const expanded = preview.archive.expandedBytes || 1;
    await extractRoot(archivePath, selectedRoot, stagedWorld, ({ bytes }) => {
      checkpoint(operationId, 'extract', 0.15 + 0.55 * Math.min(1, bytes / expanded));
    });

    checkpoint(operationId, 'validate-markers', 0.75);
    if (!hasMarker(stagedWorld)) fail(`The extracted world has no ${MARKER}.`, 422, 'missing_marker');

    // The offline check happens as late as possible and is re-checked here: a
    // server that came up during the extraction must not be committed over.
    checkpoint(operationId, 'require-offline', 0.8);
    if (replacing && manager.status !== 'offline') {
      fail('The server started while the import was staging. Stop it and try again.', 409, 'server_online');
    }

    checkpoint(operationId, 'journal', 0.85);
    const tx = new Transaction({ serverDir: server.dir, operationId });
    tx.journal.push({ action: 'rename', from: `.lodestone/staging/${operationId}/payload/${name}`, to: name });
    if (replacing) tx.journal.push({ action: 'retire', from: name, to: `.lodestone/trash/${operationId}/${name}` });
    tx.saveJournal();
    operations.appendEvent(operationId, { phase: 'journal', message: 'commit plan written', level: 'info', metadata: { entries: tx.journal.length } });

    // Commit. Same-filesystem renames: the old world is moved aside first (kept
    // in trash until we have verified the new one), then the staged tree takes
    // its place. Past this point cancellation is no longer honoured.
    if (replacing && fs.existsSync(abs)) {
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(abs, path.join(trash, name));
    }
    fs.renameSync(stagedWorld, abs);
    committed = true;
    operations.heartbeat(operationId, { phase: 'commit', progress: 0.9 });

    // Config and filesystem must agree. If the save throws, put the world back
    // the way it was; only if *that* fails do we escalate to recovery_required.
    // A replacement re-uses a name that is already registered, so only a new
    // world changes the configuration.
    if (!replacing) {
      try {
        saveWorlds([...configuredWorlds(server), name]);
      } catch (err) {
        try {
          fs.rmSync(abs, { recursive: true, force: true });
        } catch (_) {
          const e = new WorldError(`The world was imported but the configuration could not be saved: ${err.message}`, { code: 'config_save_failed' });
          e.compensated = false;
          throw e;
        }
        fail(`The configuration could not be saved, so the import was undone: ${err.message}`, 500, 'config_save_failed');
      }
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.95 });
    if (!hasMarker(abs)) {
      const e = new WorldError('The imported world is not readable after the commit.', { code: 'verify_failed' });
      e.compensated = false;
      throw e;
    }

    operations.heartbeat(operationId, { phase: 'cleanup', progress: 0.99 });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(trash, { recursive: true, force: true });
    if (snapshot) snapshots.remove(snapshot.id);

    const stats = dirStats(abs);
    const result = { name, mode, sizeBytes: stats.sizeBytes, fileCount: stats.fileCount };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!committed) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* swept later */ }
      if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep */ } }
    }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  } finally {
    try { fs.rmSync(archivePath, { force: true }); } catch (_) { /* swept later */ }
  }
}

// --- clone ----------------------------------------------------------------

function previewClone({ server, actorId, world, requestedName }) {
  const name = normalizeName(requestedName);
  if (configuredWorlds(server).some((n) => sameName(n, name)) || fs.existsSync(worldPath(server, name))) {
    fail(`"${name}" already exists on this server.`, 409, 'name_collision');
  }
  const stats = dirStats(world.abs);
  if (!hasMarker(world.abs)) fail(`"${world.name}" has no ${MARKER}, so it cannot be cloned.`, 422, 'missing_marker');
  const disk = diskPlan(server.dir, stats.sizeBytes * 2); // staged copy + committed copy
  return savePreview({
    server, actorId, action: 'clone', worldId: world.id,
    payload: {
      action: 'clone',
      source: { id: world.id, name: world.name, sizeBytes: stats.sizeBytes, fileCount: stats.fileCount, sizeEstimated: !!stats.truncated },
      name,
      disk,
      requiresOffline: false,
      registration: { adds: name },
      // Note codes, not prose: the panel translates them (see worlds.note.* in i18n.json).
      consistencyNote: 'cloneOnline',
    },
  });
}

/*
 * Copy a tree file by file, refusing links. Cancellation is checked as it goes,
 * because a clone of a large world is the one operation where a user is most
 * likely to change their mind halfway through.
 */
function copyTree(src, dest, { onFile } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) copyTree(from, to, { onFile });
    else if (e.isFile()) {
      fs.copyFileSync(from, to);
      if (onFile) onFile(fs.statSync(to).size);
    }
  }
}

async function runClone({ server, saveWorlds, operationId, world, preview }) {
  const name = preview.name;
  const abs = worldPath(server, name);
  const staging = path.join(server.dir, '.lodestone', 'staging', operationId);
  const stagedWorld = path.join(staging, 'payload', name);
  let committed = false;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.02);
    if (fs.existsSync(abs)) fail(`"${name}" already exists on this server.`, 409, 'name_collision');
    assertDisk(diskPlan(server.dir, preview.disk.requiredBytes));

    checkpoint(operationId, 'copy', 0.1);
    const total = Math.max(1, preview.source.sizeBytes);
    let copied = 0;
    let lastTick = 0;
    fs.mkdirSync(path.dirname(stagedWorld), { recursive: true });
    copyTree(world.abs, stagedWorld, {
      onFile: (size) => {
        copied += size;
        // Checkpointing per file would spend more time in SQLite than in the
        // copy; every 64 MiB is often enough to cancel promptly.
        if (copied - lastTick < 64 * 1024 * 1024) return;
        lastTick = copied;
        checkpoint(operationId, 'copy', 0.1 + 0.7 * Math.min(1, copied / total));
      },
    });

    checkpoint(operationId, 'validate-markers', 0.85);
    if (!hasMarker(stagedWorld)) fail(`The copied world has no ${MARKER}.`, 422, 'missing_marker');

    checkpoint(operationId, 'journal', 0.88);
    const tx = new Transaction({ serverDir: server.dir, operationId });
    tx.journal.push({ action: 'rename', from: `.lodestone/staging/${operationId}/payload/${name}`, to: name });
    tx.saveJournal();

    fs.renameSync(stagedWorld, abs);
    committed = true;
    operations.heartbeat(operationId, { phase: 'commit', progress: 0.92 });

    try {
      saveWorlds([...configuredWorlds(server), name]);
    } catch (err) {
      try { fs.rmSync(abs, { recursive: true, force: true }); }
      catch {
        const e = new WorldError(`The clone was created but the configuration could not be saved: ${err.message}`, { code: 'config_save_failed' });
        e.compensated = false;
        throw e;
      }
      fail(`The configuration could not be saved, so the clone was undone: ${err.message}`, 500, 'config_save_failed');
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.97 });
    if (!hasMarker(abs)) {
      const e = new WorldError('The clone is not readable after the commit.', { code: 'verify_failed' });
      e.compensated = false;
      throw e;
    }
    fs.rmSync(staging, { recursive: true, force: true });

    const stats = dirStats(abs);
    const result = { name, source: world.name, sizeBytes: stats.sizeBytes, fileCount: stats.fileCount };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!committed) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* swept later */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

// --- delete ---------------------------------------------------------------

function previewDelete({ server, actorId, world, manager }) {
  const registered = configuredWorlds(server);
  if (registered.length <= 1) {
    fail('This is the only registered world; a server must keep at least one.', 409, 'last_world');
  }
  const stats = dirStats(world.abs);
  return savePreview({
    server, actorId, action: 'delete', worldId: world.id,
    payload: {
      action: 'delete',
      world: { id: world.id, name: world.name, sizeBytes: stats.sizeBytes, fileCount: stats.fileCount, sizeEstimated: !!stats.truncated, dimensions: dimensionsOf(world.abs) },
      // Deleting the world folder while the JVM holds it open would leave the
      // server writing chunks into a directory that no longer has a name.
      requiresOffline: true,
      serverOffline: manager.status === 'offline',
      disk: diskPlan(server.dir, stats.sizeBytes), // the snapshot needs the same space again
      registration: { removes: world.name },
      // No note here: the delete dialog already leads with the same reassurance
      // (worlds.deleteWarning), and saying it twice reads like two facts.
      remaining: registered.filter((n) => !sameName(n, world.name)),
    },
  });
}

async function runDelete({ server, manager, saveWorlds, operationId, world, preview }) {
  const trash = path.join(server.dir, '.lodestone', 'trash', operationId);
  const retired = path.join(trash, world.name);
  let snapshot = null;
  let renamed = false;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    if (!fs.existsSync(world.abs)) fail('That world folder no longer exists.', 409, 'world_missing');
    assertDisk(diskPlan(server.dir, preview.world.sizeBytes));

    checkpoint(operationId, 'snapshot', 0.1);
    snapshot = snapshots.take({ serverId: server.id, sourceDir: server.dir, scope: [world.name], kind: 'world-delete', reason: `Delete "${world.name}"` });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    checkpoint(operationId, 'require-offline', 0.4);
    if (manager.status !== 'offline') {
      fail('The server started while the delete was preparing. Stop it and try again.', 409, 'server_online');
    }

    checkpoint(operationId, 'journal', 0.5);
    const tx = new Transaction({ serverDir: server.dir, operationId });
    tx.journal.push({ action: 'retire', from: world.name, to: `.lodestone/trash/${operationId}/${world.name}` });
    tx.saveJournal();

    // Staged rename, not a recursive delete: until this operation has verified
    // itself, the world is still there under .lodestone/trash.
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(world.abs, retired);
    renamed = true;
    operations.heartbeat(operationId, { phase: 'commit', progress: 0.7 });

    try {
      saveWorlds(configuredWorlds(server).filter((n) => !sameName(n, world.name)));
    } catch (err) {
      try { fs.renameSync(retired, world.abs); }
      catch {
        const e = new WorldError(`The world was moved aside but the configuration could not be saved: ${err.message}`, { code: 'config_save_failed' });
        e.compensated = false;
        throw e;
      }
      fail(`The configuration could not be saved, so the delete was undone: ${err.message}`, 500, 'config_save_failed');
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.9 });
    if (fs.existsSync(world.abs)) {
      const e = new WorldError('The world folder is still present after the commit.', { code: 'verify_failed' });
      e.compensated = false;
      throw e;
    }

    // Verified: now, and only now, the retained copy goes.
    operations.heartbeat(operationId, { phase: 'cleanup', progress: 0.97 });
    fs.rmSync(trash, { recursive: true, force: true });

    const result = { name: world.name, sizeBytes: preview.world.sizeBytes, snapshotId: snapshot.id };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!renamed && snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep the snapshot */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

// --- archive / download ---------------------------------------------------

/*
 * A downloadable name that a browser cannot be talked into interpreting: ASCII
 * only, no separators, no quotes, no control characters.
 */
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

/*
 * Zip a world folder. Used by both archive (writes into the backups folder and
 * gets a manifest) and download (streams to the client).
 */
function zipWorld(worldAbs, worldName, output, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    let bytes = 0;
    archive.on('error', reject);
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') reject(w); });
    if (onProgress) {
      archive.on('entry', (entry) => {
        bytes += entry.stats ? entry.stats.size : 0;
        try { onProgress(bytes); } catch (err) { archive.abort(); reject(err); }
      });
    }
    output.on('error', reject);
    output.on('close', () => resolve({ bytes: archive.pointer() }));
    archive.pipe(output);
    // `false` for symlinks: a link inside a world is not followed into the host.
    archive.directory(worldAbs, worldName, (entry) => (entry.stats && entry.stats.isSymbolicLink && entry.stats.isSymbolicLink() ? false : entry));
    archive.finalize();
  });
}

/*
 * Archive a world into the backups folder, then hand it to the backup pipeline
 * so it gets the same manifest and verification any other restore point gets.
 * Archiving may run while the server is online; the payload says so, because a
 * zip of a live world is a point-in-time-ish copy, not a consistent one.
 */
async function runArchive({ server, manager, operationId, world, backupsDir, inspectBackup, verifyBackup }) {
  const online = manager.status === 'online';
  const filename = safeDownloadName(server.name, world.name);
  const dest = path.join(backupsDir, filename);

  try {
    checkpoint(operationId, 'prepare', 0.05);
    const stats = dirStats(world.abs);
    assertDisk(diskPlan(backupsDir, stats.sizeBytes));
    fs.mkdirSync(backupsDir, { recursive: true });

    // Same protocol the backup feature uses: ask the server to stop writing,
    // flush what it has, and put saving back afterwards no matter what.
    if (online) {
      manager.sendCommand('save-off');
      manager.sendCommand('save-all flush');
      await new Promise((r) => setTimeout(r, 5000));
    }
    try {
      checkpoint(operationId, 'archive', 0.2);
      const total = Math.max(1, stats.sizeBytes);
      await zipWorld(world.abs, world.name, fs.createWriteStream(dest), {
        onProgress: (bytes) => operations.heartbeat(operationId, { phase: 'archive', progress: 0.2 + 0.6 * Math.min(1, bytes / total) }),
      });
    } finally {
      if (online) manager.sendCommand('save-on');
    }

    operations.heartbeat(operationId, { phase: 'manifest', progress: 0.85 });
    const manifest = await inspectBackup({ file: dest, filename, serverId: server.id, worlds: [world.name] });
    operations.heartbeat(operationId, { phase: 'verify', progress: 0.92 });
    const verification = await verifyBackup({ file: dest, filename, serverId: server.id, worlds: [world.name], operationId });

    const result = {
      filename,
      sizeBytes: fs.statSync(dest).size,
      sha256: manifest.sha256,
      verified: verification.status === 'verified',
      consistent: !online,
      consistencyNote: online ? 'archiveOnline' : null,
    };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* leave the partial file */ }
    settle(operationId, err, { compensated: true });
    throw err;
  }
}

// --- pre-generation (Chunky) ---------------------------------------------

async function modrinthJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Hostkind/1.0' } });
  if (!res.ok) throw new WorldError(`Modrinth returned HTTP ${res.status}.`, { status: 502, code: 'provider_error' });
  return res.json();
}

/*
 * Ask Modrinth, now, whether a stable Chunky build exists for this server's
 * exact loader and Minecraft version. Nothing about the answer is cached in
 * code: a new Minecraft release needs no change here, and a version Chunky does
 * not support reports as unsupported instead of installing something that will
 * not load.
 */
async function resolveChunky(compat) {
  if (!compat.mcVersion) {
    return { supported: false, reason: 'unknown_mc_version' };
  }
  if (!compat.projectType) {
    // Vanilla: no plugin or mod can be loaded at all.
    return { supported: false, reason: 'vanilla' };
  }
  const url = `${MODRINTH}/project/${CHUNKY_SLUG}/version`
    + `?loaders=${encodeURIComponent(JSON.stringify(compat.loaders))}`
    + `&game_versions=${encodeURIComponent(JSON.stringify([compat.mcVersion]))}`;
  let versions;
  try { versions = await modrinthJson(url); }
  catch (err) { return { supported: false, reason: 'provider_unavailable', error: err.message }; }

  const stable = (Array.isArray(versions) ? versions : [])
    .filter((v) => v.version_type === 'release' && !/\b(?:alpha|beta|rc|pre|snapshot)\b/i.test(v.version_number || ''))
    .filter((v) => (v.game_versions || []).includes(compat.mcVersion))
    .filter((v) => (v.loaders || []).some((l) => compat.loaders.includes(l)));
  if (!stable.length) {
    return { supported: false, reason: 'no_compatible_build', loader: compat.label, mcVersion: compat.mcVersion };
  }
  const version = stable[0];
  const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
  if (!file || !file.hashes || !file.hashes.sha512) {
    return { supported: false, reason: 'no_verifiable_file' };
  }
  return {
    supported: true,
    versionId: version.id,
    versionNumber: version.version_number,
    filename: path.basename(file.filename),
    url: file.url,
    sha512: file.hashes.sha512,
    sizeBytes: file.size,
    loader: (version.loaders || []).find((l) => compat.loaders.includes(l)),
    mcVersion: compat.mcVersion,
    folder: compat.folder,
  };
}

// Is Chunky already sitting in plugins/ or mods/?
function chunkyInstalled(server, compat) {
  const dir = path.join(server.dir, compat.folder);
  if (!fs.existsSync(dir)) return null;
  try {
    const hit = fs.readdirSync(dir).find((f) => /^chunky.*\.jar$/i.test(f));
    return hit ? `${compat.folder}/${hit}` : null;
  } catch (_) {
    return null;
  }
}

// A plugin/mod file being present does not mean the running JVM loaded it.
// Loaders discover content during startup, so a file newer than the current
// server process requires a restart before its commands can be used.
function chunkyNeedsRestart(server, manager, relativePath) {
  if (!relativePath || manager.status !== 'online') return false;
  if (!manager.startedAt) return true;
  try {
    return fs.statSync(path.join(server.dir, relativePath)).mtimeMs > manager.startedAt;
  } catch (_) {
    return true;
  }
}

async function previewPregenerate({ server, actorId, world, compat, manager, radius }) {
  const r = Number(radius);
  if (!Number.isFinite(r) || r < 1 || r > 20000) {
    fail('Choose a radius between 1 and 20000 blocks.', 400, 'invalid_radius');
  }
  const chunky = await resolveChunky(compat);
  const installed = chunky.supported ? chunkyInstalled(server, compat) : null;
  const restartRequired = chunkyNeedsRestart(server, manager, installed);

  const payload = {
    action: 'pregenerate',
    world: { id: world.id, name: world.name },
    radius: Math.round(r),
    chunky: chunky.supported
      ? {
        supported: true,
        installed: !!installed,
        restartRequired,
        relativePath: installed,
        versionNumber: chunky.versionNumber,
        filename: chunky.filename,
        sizeBytes: chunky.sizeBytes,
        loader: chunky.loader,
        mcVersion: chunky.mcVersion,
        versionId: chunky.versionId,
      }
      : { supported: false, reason: chunky.reason, loader: compat.label, mcVersion: compat.mcVersion || null },
    // Pre-generation is the server generating chunks. It needs the server up,
    // and the world-replacement rules do not apply - nothing is being replaced.
    requiresOnline: true,
    serverOnline: manager.status === 'online',
    consentRequired: chunky.supported && !installed
      ? ['Install Chunky from Modrinth into this server', 'Let the panel run Chunky commands on the server console']
      : ['Let the panel run Chunky commands on the server console'],
    // A generated chunk is a written chunk: this grows the world on disk and
    // there is no undo other than a backup.
    disk: diskPlan(server.dir, 0),
    commands: ['chunky world', 'chunky center', 'chunky radius', 'chunky start', 'chunky cancel'],
  };
  if (!chunky.supported) {
    return savePreview({ server, actorId, action: 'pregenerate', worldId: world.id, payload });
  }
  return savePreview({ server, actorId, action: 'pregenerate', worldId: world.id, payload: { ...payload, _resolved: chunky } });
}

/*
 * Install Chunky into plugins/ or mods/. Verified against the authoritative
 * hash from Modrinth before it is promoted into the server folder.
 */
async function installChunky({ server, operationId, chunky, recordProvenance }) {
  const staging = path.join(server.dir, '.lodestone', 'staging', operationId);
  fs.mkdirSync(staging, { recursive: true });
  const temp = path.join(staging, chunky.filename);
  await fetchToFile(chunky.url, temp, {
    maxBytes: 64 * 1024 * 1024,
    allowlist: (host) => host === 'cdn.modrinth.com' || host.endsWith('.modrinth.com'),
  });
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(temp)).digest('hex');
  if (sha512 !== chunky.sha512) {
    fs.rmSync(staging, { recursive: true, force: true });
    fail('The downloaded Chunky file did not match the hash Modrinth published for it.', 502, 'hash_mismatch');
  }
  const relativePath = `${chunky.folder}/${chunky.filename}`;
  const tx = new Transaction({ serverDir: server.dir, operationId });
  tx.stageCopy(temp, relativePath);
  tx.commit();
  if (recordProvenance) {
    recordProvenance({
      serverId: server.id,
      relativePath,
      kind: chunky.folder === 'mods' ? 'mod' : 'plugin',
      projectId: CHUNKY_SLUG,
      versionId: chunky.versionId,
      mcVersion: chunky.mcVersion,
      loader: chunky.loader,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(server.dir, chunky.folder, chunky.filename))).digest('hex'),
    });
  }
  return relativePath;
}

// Chunky reports progress on lines like
//   "[Chunky] Task running for [world]: 12.34%, ETA ..."
// We only read a percentage off a line that Chunky owns, we cap how much of a
// line we look at, and an unparseable line simply does not move the bar.
const CHUNKY_PROGRESS = /chunky.*?(\d{1,3}(?:\.\d+)?)\s?%/i;
const CHUNKY_DONE = /task finished for|pregeneration complete|task complete/i;
const CHUNKY_CANCELLED = /task (?:cancelled|canceled|stopped)/i;
const CHUNKY_UNKNOWN_COMMAND = /unknown command|no such command/i;
const MAX_LINE = 2000;

/*
 * Drive Chunky through the console and follow its progress.
 *
 * Cancellation is the delicate part: the operation is only "cancelled" once
 * Chunky has confirmed it stopped. If we cannot confirm that, the server may
 * still be generating chunks, and reporting a clean cancellation would be a
 * lie - so it becomes recovery_required instead.
 */
async function runPregenerate({ server, manager, operationId, world, preview, recordProvenance, timeoutMs = 24 * 3600 * 1000 }) {
  const chunky = preview._resolved;
  try {
    checkpoint(operationId, 'preview-revalidate', 0.02);
    if (!chunky || !chunky.supported) fail('No compatible Chunky build is available for this server.', 409, 'chunky_unsupported');

    if (!chunkyInstalled(server, { folder: chunky.folder })) {
      checkpoint(operationId, 'install-chunky', 0.05);
      await installChunky({ server, operationId, chunky, recordProvenance });
      operations.appendEvent(operationId, { phase: 'install-chunky', message: `installed ${chunky.filename}`, level: 'info' });
      fail('Chunky was installed. Restart the server, then start pre-generation again.', 409, 'restart_required');
    }

    const installedPath = chunkyInstalled(server, { folder: chunky.folder });
    if (chunkyNeedsRestart(server, manager, installedPath)) {
      fail('Restart the server so it can load Chunky, then start pre-generation again.', 409, 'restart_required');
    }

    checkpoint(operationId, 'require-online', 0.1);
    if (manager.status !== 'online') fail('Start the server before pre-generating chunks.', 409, 'server_offline');

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let cancelSent = false;
      let progress = 0;
      let lastSeen = Date.now();

      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        unwatch();
        fn(value);
      };

      const unwatch = manager.watchLines((raw) => {
        const line = String(raw).slice(0, MAX_LINE);
        if (!/chunky|task /i.test(line)) return;
        lastSeen = Date.now();
        if (CHUNKY_UNKNOWN_COMMAND.test(line)) {
          return done(reject, new WorldError('The server did not recognise the Chunky commands. Is Chunky loaded?', { status: 409, code: 'chunky_not_loaded' }));
        }
        if (cancelSent && CHUNKY_CANCELLED.test(line)) return done(reject, new Cancelled());
        if (CHUNKY_DONE.test(line)) return done(resolve, { completed: true, progress: 1 });
        const match = CHUNKY_PROGRESS.exec(line);
        if (!match) return;
        const pct = Number(match[1]);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
        progress = pct / 100;
        operations.heartbeat(operationId, { phase: 'generating', progress: 0.1 + 0.85 * progress });
      });

      // Cancellation, liveness and the deadline all come through here so there
      // is one place that decides how this ends.
      const poll = setInterval(() => {
        const op = operations.get(operationId);
        if (op && op.state === operations.STATES.CANCELLED && !cancelSent) {
          cancelSent = true;
          operations.appendEvent(operationId, { phase: 'cancelling', message: 'sent "chunky cancel"', level: 'warn' });
          const sent = manager.sendCommand('chunky cancel');
          if (!sent.ok) {
            return done(reject, Object.assign(
              new WorldError('Cancellation could not be sent to the server, so pre-generation may still be running.', { code: 'cancel_unconfirmed' }),
              { compensated: false },
            ));
          }
          setTimeout(() => {
            if (settled) return;
            done(reject, Object.assign(
              new WorldError('Chunky did not confirm that it stopped, so pre-generation may still be running.', { code: 'cancel_unconfirmed' }),
              { compensated: false },
            ));
          }, 30000);
          return;
        }
        if (manager.status !== 'online') {
          return done(reject, new WorldError('The server stopped while chunks were being generated.', { status: 409, code: 'server_stopped' }));
        }
        if (Date.now() - lastSeen > timeoutMs) {
          return done(reject, new WorldError('Chunky stopped reporting progress.', { status: 504, code: 'no_progress' }));
        }
        operations.heartbeat(operationId, { progress: 0.1 + 0.85 * progress });
      }, 2000);

      operations.heartbeat(operationId, { phase: 'generating', progress: 0.12 });
      for (const command of [`chunky world ${world.name}`, 'chunky center 0 0', `chunky radius ${preview.radius}`, 'chunky start']) {
        const sent = manager.sendCommand(command);
        if (!sent.ok) return done(reject, new WorldError('The console is not accepting commands on this server.', { status: 409, code: 'console_unavailable' }));
      }
    });

    const result_ = { world: world.name, radius: preview.radius, completed: true, ...result };
    recordResult(operationId, result_);
    operations.finish(operationId, result_);
    return result_;
  } catch (err) {
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

module.exports = {
  KIND, MARKER, PREVIEW_TTL, WorldError, Cancelled,
  normalizeName, worldId, sameName, configuredWorlds, assertNoOverlap, worldPath,
  dirStats, markerHash, hasMarker, dimensionsOf,
  inventory, findWorld, fingerprint,
  diskPlan, freeBytes, assertDisk,
  savePreview, consumePreview, purgeExpiredPreviews,
  beginOperation, findOperationByKey, recordOperation, recordResult, listOperations, activeOperations, checkpoint,
  scanArchive, extractRoot, importStagingDir,
  previewImport, runImport,
  previewClone, runClone,
  previewDelete, runDelete,
  runArchive, zipWorld, safeDownloadName,
  resolveChunky, chunkyInstalled, chunkyNeedsRestart, previewPregenerate, runPregenerate,
};
