'use strict';

/*
 * Restore drills - verified, exact inventory comparison for restores.
 *
 * Spec contract (`.gauntlet/edge-product-contract.md` slice 2):
 *   - `inventoryDirectory(root)` returns sorted relative file entries with
 *     byte size and SHA-256.
 *   - Inventories use POSIX relative paths; absolute paths and traversal
 *     entries are rejected.
 *   - A restore succeeds only when expected and actual inventories match
 *     exactly - a checksum-only or file-count-only check is insufficient.
 *
 * This module only reads directories and files; it never deletes, moves,
 * or restores anything itself.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_RE = /^[a-f0-9]{64}$/;

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(read === buffer.length ? buffer : buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function walkFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      // Symlinks are intentionally not followed: a link could point outside
      // the restore root, and a drill must never hash what it cannot own.
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/*
 * Inventory one directory tree. Entries are sorted by relative POSIX path
 * and carry `{ path, size, sha256 }` - byte-for-byte content fingerprints.
 */
function inventoryDirectory(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('inventoryDirectory: root must be a non-empty path');
  }
  const base = path.resolve(root);
  const files = walkFiles(base, []);
  const entries = [];
  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    entries.push({ path: rel, size: stat.size, sha256: hashFile(file) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/*
 * Hard rule for inventory paths: relative POSIX style only. Absolute paths,
 * drive letters, backslashes, and traversal/empty segments are rejected so
 * a crafted inventory cannot name anything outside the restore root.
 */
function checkInventoryEntry(entry, label) {
  const p = entry && entry.path;
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(label + ' path must be a non-empty string');
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) {
    throw new Error(label + ' path must be a relative POSIX path (no leading slash, drive, or backslash)');
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(label + ' path must not contain traversal or empty segments');
  }
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
    throw new Error(label + ' size must be a non-negative byte count');
  }
  if (typeof entry.sha256 !== 'string' || !HASH_RE.test(entry.sha256)) {
    throw new Error(label + ' sha256 must be a SHA-256 hex digest');
  }
}

/*
 * Exact comparison: a restore is successful only when expected and actual
 * inventories match path-for-path, byte size, and SHA-256.
 */
function compareInventories(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    throw new TypeError('compareInventories: expected and actual must be arrays');
  }
  expected.forEach((entry, index) => checkInventoryEntry(entry, 'expected[' + index + ']'));
  actual.forEach((entry, index) => checkInventoryEntry(entry, 'actual[' + index + ']'));

  const byPath = (list) => new Map(list.map((entry) => [entry.path, entry]));
  const expectedByPath = byPath(expected);
  const actualByPath = byPath(actual);

  const missing = [];
  const changed = [];
  for (const entry of expected) {
    const found = actualByPath.get(entry.path);
    if (!found) {
      missing.push(entry.path);
    } else if (found.size !== entry.size || found.sha256 !== entry.sha256) {
      changed.push(entry.path);
    }
  }
  const unexpected = [];
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path)) unexpected.push(entry.path);
  }

  return {
    ok: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    missing,
    unexpected,
    changed,
  };
}

/*
 * Stable drill report. `status` follows the exact match - nothing else is
 * allowed to declare a restore a success.
 */
function buildReport({ backupId, target, expected, actual, startedAt, completedAt }) {
  const diff = compareInventories(expected, actual);
  return {
    backupId,
    target,
    status: diff.ok ? 'succeeded' : 'failed',
    startedAt,
    completedAt,
    expectedCount: expected.length,
    actualCount: actual.length,
    diff,
  };
}

module.exports = {
  inventoryDirectory,
  compareInventories,
  buildReport,
};