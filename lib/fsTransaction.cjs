'use strict';

/*
 * Filesystem transaction: staging + atomic commit.
 *
 * Spec contract (docs/roadmap/README.md "Durable operations"):
 *   - "Mutations stage under <server>/.fleetdeck/staging/<operationId>,
 *      journal intended replacements, and commit with same-filesystem
 *      renames."
 *
 * A `Transaction` represents one pending mutation against a server folder.
 * It writes everything into a per-operation staging directory and on commit
 * walks the journal, renaming the staged files over their live targets in
 * reverse-depth order so a parent directory that gets replaced doesn't yank
 * the rug out from under the children.
 *
 * The journal is a JSON object held on disk in the staging directory; the
 * operations module records a copy in operations.journal so the recover
 * flow can validate preconditions before applying.
 */

const fs = require('fs');
const path = require('path');
const { safeResolve } = require('./files.cjs');

class StagingError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'staging_error'; }
}

function stagingRoot(serverDir, operationId) {
  const id = String(operationId || '');
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new StagingError('invalid operationId', 'invalid_operation_id');
  }
  return path.join(serverDir, '.fleetdeck', 'staging', id);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class Transaction {
  constructor({ serverDir, operationId }) {
    if (!serverDir) throw new StagingError('serverDir required', 'no_server_dir');
    if (!operationId) throw new StagingError('operationId required', 'no_operation_id');
    this.serverDir = serverDir;
    this.operationId = operationId;
    this.root = stagingRoot(serverDir, operationId);
    this.journal = []; // [{ action: 'replace'|'remove', from, to }]
    ensureDir(this.root);
  }

  /*
   * Stage a file copy from a source path to a destination relative to
   * serverDir. The source is copied into the staging tree at the same
   * relative path; on commit, it is renamed over the live target.
   */
  stageCopy(srcAbs, destRel) {
    if (!fs.existsSync(srcAbs)) throw new StagingError(`source missing: ${srcAbs}`, 'source_missing');
    const stagedPath = this._stagedPath(destRel);
    ensureDir(path.dirname(stagedPath));
    fs.copyFileSync(srcAbs, stagedPath);
    this.journal.push({ action: 'replace', from: destRel, to: destRel });
    return stagedPath;
  }

  /*
   * Stage a write: caller hands us a buffer / string, we save it under
   * the staging tree at destRel. The journal entry says "replace this
   * file at commit time".
   */
  stageWrite(destRel, data) {
    const stagedPath = this._stagedPath(destRel);
    ensureDir(path.dirname(stagedPath));
    if (Buffer.isBuffer(data)) fs.writeFileSync(stagedPath, data);
    else fs.writeFileSync(stagedPath, String(data));
    this.journal.push({ action: 'replace', from: destRel, to: destRel });
    return stagedPath;
  }

  /*
   * Record a file the caller already wrote into the staging payload.
   *
   * stageCopy() copies a source file in; a caller that produced the payload
   * in place - an archive extracted straight into the staging tree, which is
   * how a game-server update avoids copying tens of thousands of files twice
   * - has nothing to copy and only needs the journal entry.
   */
  stageExisting(destRel) {
    const stagedPath = this._stagedPath(destRel);
    if (!fs.existsSync(stagedPath)) throw new StagingError(`staged file missing: ${destRel}`, 'source_missing');
    this.journal.push({ action: 'replace', from: destRel, to: destRel });
    return stagedPath;
  }

  /*
   * Stage a removal. The journal records the relative path; the commit
   * step unlinks the live file.
   */
  stageRemove(destRel) {
    this.journal.push({ action: 'remove', from: destRel, to: null });
    return destRel;
  }

  _stagedPath(destRel) {
    return safeTransactionPath(path.join(this.root, 'payload'), destRel);
  }

  /*
   * Persist the journal. Call this before commit so an interrupted
   * transaction can be replayed (or rolled back) by a recovery flow.
   */
  saveJournal() {
    fs.writeFileSync(path.join(this.root, 'journal.json'), JSON.stringify({
      operationId: this.operationId,
      serverDir: this.serverDir,
      entries: this.journal,
      savedAt: Date.now(),
    }, null, 2));
  }

  /*
   * Commit: rename staged files over their live targets. Replacements are
   * applied deepest-first so a renamed parent directory never disappears
   * from under its children mid-rename. If anything fails midway, the
   * caller is responsible for invoking rollback() with the pre-commit
   * snapshot id.
   */
  commit() {
    this.saveJournal();
    const ordered = this.journal.slice().sort((a, b) => depth(b.from) - depth(a.from));
    for (const entry of ordered) {
      if (entry.action === 'replace') {
        const staged = this._stagedPath(entry.from);
        if (!fs.existsSync(staged)) continue;
        const target = safeTransactionPath(this.serverDir, entry.to);
        ensureDir(path.dirname(target));
        fs.renameSync(staged, target);
      } else if (entry.action === 'remove') {
        const target = safeTransactionPath(this.serverDir, entry.from);
        if (fs.existsSync(target)) {
          try { fs.unlinkSync(target); } catch { /* best effort */ }
        }
      }
    }
    this._cleanup();
  }

  /*
   * Roll back: drop the staging tree. The caller is expected to also
   * restore a pre-mutation snapshot, since the live tree has not been
   * touched (commit failed) and the staging tree is the only thing
   * that needs cleaning up.
   */
  rollback() {
    this._cleanup();
  }

  _cleanup() {
    if (fs.existsSync(this.root)) {
      try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* locked - leave for sweep */ }
    }
  }
}

function depth(rel) {
  if (!rel) return 0;
  return String(rel).split(/[\\/]+/).filter(Boolean).length;
}

/*
 * Sweep stale staging directories for a server. Called on boot to clean
 * up after a crashed transaction.
 */
function safeTransactionPath(root, rel) {
  try {
    const resolved = safeResolve(root, rel);
    const relative = path.relative(path.resolve(root), resolved);
    let current = path.resolve(root);
    for (const part of relative.split(path.sep).filter(Boolean).slice(0, -1)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('path traverses a symbolic link');
      }
    }
    return resolved;
  } catch (err) {
    throw new StagingError(err.message, 'invalid_path');
  }
}

function sweep(serverDir, { preserveOperationIds = [] } = {}) {
  const bases = [
    path.join(serverDir, '.fleetdeck', 'staging'),
    // Legacy alias: pre-fleetdeck installs used .lodestone/staging.
    path.join(serverDir, '.lodestone', 'staging'),
  ];
  const preserve = new Set(preserveOperationIds.map(String));
  const removed = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (preserve.has(entry.name)) continue;
      const full = path.join(base, entry.name);
      try { fs.rmSync(full, { recursive: true, force: true }); removed.push(full); } catch { /* locked */ }
    }
  }
  return removed;
}

module.exports = { Transaction, StagingError, stagingRoot, sweep, safeTransactionPath };
