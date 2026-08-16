'use strict';

/*
 * Pre-mutation snapshots.
 *
 * Spec contract (docs/roadmap/README.md "Durable operations"):
 *   - "Mutations stage under <server>/.fleetdeck/staging/<operationId>,
 *      journal intended replacements, and commit with same-filesystem
 *      renames."
 *   - "Updates, restores, pack changes, templates, and bulk world changes
 *      require a verified snapshot."
 *
 * This module is the *snapshot* primitive - a baseline copy of a server
 * folder (or a subset of it) that a destructive operation can roll back to
 * if the commit goes wrong. It's separate from lib/migrations.cjs'
 * database-snapshot logic - that one protects the SQLite file, this one
 * protects server folders.
 *
 * The snapshot itself is a directory tree with a manifest (manifest.json)
 * that records the source path, taken-at timestamp, file count, and
 * total size. We keep the newest N snapshots per server and let older
 * ones age out.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./db.cjs');
const { safeResolve } = require('./files.cjs');

const DEFAULT_RETENTION = 5;
const MANIFEST_NAME = 'manifest.json';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/*
 * The on-disk layout:
 *
 *   data/snapshots/
 *     <snapshotId>/
 *       manifest.json
 *       root/             <-- mirror of the server folder
 *       ...
 *
 * The "root/" entry is named after the server folder basename. We keep the
 * manifest at the top so the verification step can find it without crawling
 * the whole tree.
 */
function snapshotRootDir() {
  return path.join(__dirname, '..', 'data', 'snapshots');
}

function snapshotDir(id) {
  const dir = path.resolve(path.join(snapshotRootDir(), id));
  const root = path.resolve(snapshotRootDir());
  // A snapshot id may never escape the snapshot root; the resolve +
  // startsWith guard is the sanitizer CodeQL js/path-injection recognizes,
  // with the use in the guarded branch.
  if (!dir.startsWith(root + path.sep)) {
    throw new Error('snapshots: invalid snapshot id');
  }
  return dir;
}

function manifestPath(id) {
  return path.join(snapshotDir(id), MANIFEST_NAME);
}

/*
 * Take a snapshot. The "scope" argument is a list of relative paths under
 * the server root to include; pass an empty array to snapshot the whole
 * folder. Excluded paths (everything not in scope, and explicitly skipped
 * names) are recorded in the manifest so a verify() can detect drift.
 *
 * The copy is a plain file walk - no hard links, no copy-on-write. The
 * .fleetdeck/staging directory is always excluded so we never snapshot
 * our own scratch space.
 */
function take({ serverId, sourceDir, scope = [], kind = 'manual', reason = null, retention = DEFAULT_RETENTION }) {
  if (!serverId) throw new Error('snapshots.take: serverId required');
  if (!sourceDir) throw new Error('snapshots.take: sourceDir required');
  if (!fs.existsSync(sourceDir)) throw new Error('snapshots.take: sourceDir does not exist');

  const id = crypto.randomUUID();
  const takenAt = Date.now();
  const dir = snapshotDir(id);
  ensureDir(dir);
  const dest = path.join(dir, 'root');
  ensureDir(dest);

  const excludes = new Set(['.fleetdeck', '.lodestone']);
  const stat = { fileCount: 0, totalSize: 0 };

  function walk(srcRel) {
    const abs = srcRel ? safeResolve(sourceDir, srcRel) : sourceDir;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (excludes.has(e.name)) continue;
      const srcPath = path.join(abs, e.name);
      const rel = path.relative(sourceDir, srcPath);
      if (scope.length && !scope.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
      if (e.isDirectory()) {
        const target = path.join(dest, rel);
        ensureDir(target);
        walk(rel);
      } else if (e.isFile()) {
        const target = path.join(dest, rel);
        ensureDir(path.dirname(target));
        fs.copyFileSync(srcPath, target);
        const st = fs.statSync(target);
        stat.fileCount += 1;
        stat.totalSize += st.size;
      }
      // symlinks and other special entries are skipped on purpose; the
      // server folder shouldn't have any.
    }
  }
  walk('');

  const manifest = {
    id,
    serverId,
    kind,
    reason,
    takenAt,
    sourceDir,
    scope,
    fileCount: stat.fileCount,
    totalSize: stat.totalSize,
    excludes: [...excludes],
  };
  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));

  const db = open();
  db.prepare(`
    INSERT INTO snapshots (id, server_id, kind, path, size, file_count, taken_at, verified, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, serverId, kind, path.relative(snapshotRootDir(), dir), stat.totalSize, stat.fileCount, takenAt, reason);

  pruneRetention(serverId, retention);
  return { id, ...manifest };
}

/*
 * Verify a snapshot. The manifest records the file count and total size of
 * the source at take-time; verify() walks the on-disk mirror and compares.
 * A successful verify sets snapshots.verified = 1; a failed one leaves it 0
 * and returns the diff.
 */
function verify(id) {
  const m = readManifest(id);
  if (!m) return { ok: false, error: 'manifest_missing' };
  const root = path.join(snapshotDir(id), 'root');
  if (!fs.existsSync(root)) return { ok: false, error: 'data_missing' };
  let fileCount = 0;
  let totalSize = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        fileCount += 1;
        totalSize += fs.statSync(p).size;
      }
    }
  })(root);
  const ok = fileCount === m.fileCount && totalSize === m.totalSize;
  if (ok) {
    const db = open();
    db.prepare('UPDATE snapshots SET verified = 1 WHERE id = ?').run(id);
  }
  return { ok, fileCount, totalSize, expectedFileCount: m.fileCount, expectedTotalSize: m.totalSize };
}

function readManifest(id) {
  const p = manifestPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function list(serverId) {
  const db = open();
  return db.prepare(`
    SELECT id, server_id, kind, path, size, file_count, taken_at, verified, reason
      FROM snapshots
     WHERE server_id = ?
     ORDER BY taken_at DESC
  `).all(serverId);
}

function pruneRetention(serverId, retention) {
  const rows = list(serverId);
  if (rows.length <= retention) return;
  for (const r of rows.slice(retention)) {
    remove(r.id);
  }
}

function remove(id) {
  const dir = snapshotDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const db = open();
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
}

/*
 * Restore a server folder from a snapshot. Refuses if the manifest is
 * missing, the on-disk data is missing, or verify() fails. The restore
 * is destructive: anything under the server folder that is not part of
 * the snapshot is left in place (we restore *over* the live tree, not
 * wipe-and-replace). Callers that need a strict replace should pair this
 * with their own fs work.
 */
function restore({ id, targetDir }) {
  const m = readManifest(id);
  if (!m) return { ok: false, error: 'manifest_missing' };
  const v = verify(id);
  if (!v.ok) return { ok: false, error: 'verify_failed', diff: v };

  const src = path.join(snapshotDir(id), 'root');
  copyTree(src, targetDir);
  return { ok: true, manifest: m };
}

function copyTree(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

module.exports = {
  take,
  verify,
  list,
  remove,
  restore,
  readManifest,
  snapshotDir,
  snapshotRootDir,
  DEFAULT_RETENTION,
};
