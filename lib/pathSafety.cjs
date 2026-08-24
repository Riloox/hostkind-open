'use strict';

/*
 * Path safety for destructive and adoptive lifecycle actions
 * (docs/palworld/07-portability-safety.md "Adoption" and "Recoverable
 * deletion").
 *
 * Spec contract:
 *   - "Reject drive roots, home/profile roots, Hostkind data/build
 *      directories, backup roots, and any folder equal to or containing
 *      another registered server."
 *   - "Canonicalize paths and account for Windows case folding and links."
 *
 * This module is deliberately game-neutral: adoption, removal, trash, and
 * profile import all ask the same question - "is this folder something we are
 * allowed to touch as a whole?" - and they must all get the same answer. It
 * only classifies paths; it never deletes, moves, or creates anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir } = require('./db.cjs');

// Windows and macOS compare paths case-insensitively; Linux does not. Folding
// on the wrong platform would make two genuinely different folders look like
// one, so the fold follows the host.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function fold(value) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

/*
 * Canonicalize without requiring the path to exist. We realpath the deepest
 * existing ancestor - that is what resolves symlinks and Windows junctions -
 * and re-attach the missing tail. A link pointing at a protected root must not
 * be able to hide behind a name that does not exist yet.
 */
function canonical(input) {
  const resolved = path.resolve(String(input || ''));
  let head = resolved;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native ? fs.realpathSync.native(head) : fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return resolved;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function isRoot(p) {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}

/*
 * How two canonical paths relate. Comparison is segment-wise: /srv/pal-2 is
 * not inside /srv/pal even though the string starts with it.
 */
function relation(a, b) {
  const left = fold(canonical(a));
  const right = fold(canonical(b));
  if (left === right) return 'same';
  if (right.startsWith(left + path.sep)) return 'contains';
  if (left.startsWith(right + path.sep)) return 'inside';
  return null;
}

function overlaps(a, b) {
  return relation(a, b) !== null;
}

/*
 * Directories Hostkind refuses to treat as a server root, whether adopting or
 * removing. Each entry carries the reason the caller shows the operator: "not
 * allowed" without a why is an unactionable error.
 *
 * `strict` entries also protect everything below them - Hostkind's own data,
 * build, and backup trees must never become a server root. The home and
 * temporary roots are protected as roots only: `~/servers/palworld` is a
 * perfectly ordinary place to keep a server, `~` is not.
 */
function protectedRoots({ extra = [] } = {}) {
  const out = [
    { path: dataDir(), reason: 'fleetdeck_data', strict: true },
    { path: path.join(__dirname, '..'), reason: 'fleetdeck_install', strict: true },
    { path: path.join(__dirname, '..', 'backups'), reason: 'backup_root', strict: true },
    { path: os.homedir(), reason: 'home_root', strict: false },
    { path: os.tmpdir(), reason: 'temp_root', strict: false },
  ];
  for (const item of extra) {
    if (!item) continue;
    if (typeof item === 'string') out.push({ path: item, reason: 'protected', strict: true });
    else if (item.path) out.push({ path: item.path, reason: item.reason || 'protected', strict: item.strict !== false });
  }
  return out.filter((item) => item.path).map((item) => ({ path: canonical(item.path), reason: item.reason, strict: item.strict }));
}

const REASONS = Object.freeze({
  empty: 'A folder path is required.',
  drive_root: 'A drive or filesystem root is never a server folder.',
  home_root: 'A user home folder is never a server folder.',
  temp_root: 'The system temporary folder is never a server folder.',
  fleetdeck_data: 'This is the Hostkind data folder.',
  fleetdeck_install: 'This is the Hostkind installation folder.',
  backup_root: 'This is the Hostkind backup folder.',
  protected: 'This folder is protected.',
  contains_protected: 'This folder contains a protected Hostkind folder.',
  server_overlap: 'This folder overlaps another registered server.',
  not_found: 'That folder does not exist.',
  not_a_directory: 'That path is not a folder.',
});

/*
 * Classify one candidate root. Returns null when the path is usable, otherwise
 * `{ reason, message, conflict }`. `servers` is the registered-server list;
 * `selfId` is the server the caller is acting on, which is allowed to be its
 * own path.
 */
function protectedReason(target, { servers = [], selfId = null, extra = [], requireExisting = false } = {}) {
  const raw = String(target || '').trim();
  if (!raw) return { reason: 'empty', message: REASONS.empty };
  const resolved = canonical(raw);
  if (isRoot(resolved)) return { reason: 'drive_root', message: REASONS.drive_root };
  if (requireExisting) {
    if (!fs.existsSync(resolved)) return { reason: 'not_found', message: REASONS.not_found };
    if (!fs.statSync(resolved).isDirectory()) return { reason: 'not_a_directory', message: REASONS.not_a_directory };
  }
  // Two passes on purpose: "this *is* the home folder" is a more useful answer
  // than "this contains some Hostkind folder", and a home folder containing
  // the Hostkind install would otherwise report the vaguer reason.
  const roots = protectedRoots({ extra });
  for (const item of roots) {
    const how = relation(resolved, item.path);
    if (how === 'same' || (how === 'inside' && item.strict)) {
      return { reason: item.reason, message: REASONS[item.reason] || REASONS.protected, conflict: item.path };
    }
  }
  for (const item of roots) {
    if (relation(resolved, item.path) === 'contains') {
      return { reason: 'contains_protected', message: REASONS.contains_protected, conflict: item.path };
    }
  }
  for (const server of servers) {
    if (!server || !server.dir) continue;
    if (selfId && server.id === selfId) continue;
    if (overlaps(resolved, server.dir)) {
      return { reason: 'server_overlap', message: REASONS.server_overlap, conflict: server.name || server.id };
    }
  }
  return null;
}

function assertUsableRoot(target, options = {}) {
  const problem = protectedReason(target, options);
  if (problem) {
    throw Object.assign(new Error(problem.message), {
      status: 409,
      code: problem.reason,
      conflict: problem.conflict || null,
    });
  }
  return canonical(target);
}

module.exports = {
  CASE_INSENSITIVE,
  REASONS,
  canonical,
  isRoot,
  relation,
  overlaps,
  protectedRoots,
  protectedReason,
  assertUsableRoot,
};
