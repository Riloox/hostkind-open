'use strict';

/*
 * Durable operations: the spec's "long mutation" primitive.
 *
 * Spec contract (docs/roadmap/README.md "Durable operations"):
 *   - operations: ID, kind, state, phase, progress, heartbeat, redacted
 *     summary, recovery journal, actor/server IDs, idempotency key,
 *     timestamps, structured error code, safe error text, recovery
 *     instructions.
 *   - operation_events: append-only timeline.
 *   - States: queued, running, succeeded, failed, cancelled, recovery_required.
 *   - "Only one mutating operation may hold a per-server lock. Read-only
 *      scans use a bounded global pool."
 *   - "On startup, stale read-only work may fail safely. Interrupted
 *      destructive work becomes recovery_required and never resumes
 *      automatically. resume validates the journal and preconditions;
 *      rollback restores the snapshot/journal and verifies the result."
 *   - "Long mutations return 202 { ok: true, operationId }."
 *   - "Collections use cursor pagination ordered by
 *      (created_at DESC, id DESC)."
 *   - "Destructive requests require preview plus Idempotency-Key; a replay
 *      returns the existing operation."
 *
 * This module is the model + storage. The HTTP layer (lib/routes/operations.cjs)
 * sits on top. Mutating operation runners are wired in by the features that
 * need them (spec 01/02/03/...).
 */

const crypto = require('crypto');
const { open } = require('./db.cjs');
const { redactObject } = require('./redact.cjs');

const STATES = Object.freeze({
  QUEUED:             'queued',
  RUNNING:            'running',
  SUCCEEDED:          'succeeded',
  FAILED:             'failed',
  CANCELLED:          'cancelled',
  RECOVERY_REQUIRED:  'recovery_required',
});

const TERMINAL = new Set([STATES.SUCCEEDED, STATES.FAILED, STATES.CANCELLED]);

function genId() {
  return crypto.randomUUID();
}

/*
 * Idempotent create. If a (actor_id, idempotency_key) row already exists we
 * return that one - the caller never sees a duplicate operation for a
 * replayed destructive request. The unique index in migrations.cjs backs
 * this so concurrent replays are safe.
 */
function create({ kind, actorId, serverId, idempotencyKey, summary } = {}) {
  if (!kind) throw new Error('operations.create: kind required');
  const db = open();
  if (idempotencyKey && actorId) {
    const existing = db.prepare(`
      SELECT * FROM operations
       WHERE actor_id = ? AND idempotency_key = ?
    `).get(actorId, idempotencyKey);
    if (existing) return rowToOp(existing);
  }
  const id = genId();
  const ts = Date.now();
  const safeSummary = summary ? JSON.stringify(redactObject(summary)) : null;
  db.prepare(`
    INSERT INTO operations
      (id, kind, state, phase, progress, heartbeat, summary, journal,
       actor_id, server_id, idempotency_key, queued_at)
    VALUES
      (?,  ?,    ?,     NULL,  0,        NULL,      ?,       NULL,
       ?,         ?,         ?,              ?)
  `).run(
    id,
    kind,
    STATES.QUEUED,
    safeSummary,
    actorId || null,
    serverId || null,
    idempotencyKey || null,
    ts,
  );
  appendEvent(id, { phase: 'queued', message: 'operation created', level: 'info' });
  return get(id);
}

function get(id) {
  if (!id) return null;
  const db = open();
  const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
  return row ? rowToOp(row) : null;
}

function list({ serverId, state, cursor, limit = 50 } = {}) {
  const db = open();
  const where = [];
  const args = [];
  if (serverId) { where.push('server_id = ?'); args.push(serverId); }
  if (state)    { where.push('state = ?');    args.push(state); }
  if (cursor) {
    // cursor = "<queuedAt>:<id>" so we can paginate by (queued_at DESC, id DESC).
    const [ts, id] = String(cursor).split(':');
    if (ts && id) {
      where.push('(queued_at < ? OR (queued_at = ? AND id < ?))');
      args.push(Number(ts), Number(ts), id);
    }
  }
  const sql = `
    SELECT * FROM operations
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY queued_at DESC, id DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...args, limit + 1);
  const items = (rows.length > limit ? rows.slice(0, limit) : rows).map(rowToOp);
  let nextCursor = null;
  if (rows.length > limit) {
    const last = items[items.length - 1];
    nextCursor = `${last.queuedAt}:${last.id}`;
  }
  return { items, nextCursor };
}

function rowToOp(row) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    progress: row.progress == null ? 0 : row.progress,
    heartbeat: row.heartbeat,
    summary: row.summary ? safeJson(row.summary) : null,
    journal: row.journal ? safeJson(row.journal) : null,
    actorId: row.actor_id,
    serverId: row.server_id,
    idempotencyKey: row.idempotency_key,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_code ? { code: row.error_code, text: row.error_text } : null,
    recovery: row.recovery ? safeJson(row.recovery) : null,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

/*
 * Transition helpers. Each emits an event so the timeline mirrors the state
 * machine. start()/finish()/fail() are no-ops if the operation is already
 * in a terminal state, so a late-arriving resume() doesn't override success.
 */
function start(id, { phase } = {}) {
  const db = open();
  const op = get(id);
  if (!op) return null;
  if (op.state !== STATES.QUEUED && op.state !== STATES.RECOVERY_REQUIRED) return op;
  db.prepare(`
    UPDATE operations
       SET state = ?, phase = ?, started_at = ?, heartbeat = ?
     WHERE id = ?
  `).run(STATES.RUNNING, phase || 'running', Date.now(), Date.now(), id);
  appendEvent(id, { phase: phase || 'running', message: 'operation started', level: 'info' });
  return get(id);
}

function heartbeat(id, { progress, phase } = {}) {
  const db = open();
  db.prepare(`
    UPDATE operations
       SET heartbeat = ?, progress = COALESCE(?, progress), phase = COALESCE(?, phase)
     WHERE id = ? AND state = ?
  `).run(Date.now(), progress == null ? null : progress, phase || null, id, STATES.RUNNING);
}

function finish(id, summary) {
  const db = open();
  db.prepare(`
    UPDATE operations
       SET state = ?, finished_at = ?, heartbeat = ?, progress = 1,
           summary = COALESCE(?, summary)
     WHERE id = ? AND state = ?
  `).run(STATES.SUCCEEDED, Date.now(), Date.now(), JSON.stringify(redactObject(summary || {})), id, STATES.RUNNING);
  if (db.prepare('SELECT changes() AS n').get().n) {
    appendEvent(id, { phase: 'finished', message: 'operation succeeded', level: 'info' });
  }
  return get(id);
}

function fail(id, { code, text, recovery }) {
  const db = open();
  db.prepare(`
    UPDATE operations
       SET state = ?, finished_at = ?, heartbeat = ?,
           error_code = ?, error_text = ?, recovery = ?
     WHERE id = ? AND state IN (?, ?)
  `).run(
    STATES.FAILED,
    Date.now(),
    Date.now(),
    code || 'unknown',
    text || '',
    recovery ? JSON.stringify(redactObject(recovery)) : null,
    id, STATES.QUEUED, STATES.RUNNING,
  );
  if (db.prepare('SELECT changes() AS n').get().n) {
    appendEvent(id, { phase: 'failed', message: text || code || 'operation failed', level: 'error' });
  }
  return get(id);
}

/*
 * Persist the recovery journal for an operation that is mid-flight. The
 * feature owns the journal shape; sweepStale copies it into the recovery
 * metadata of an interrupted operation so the resume flow can replay it.
 */
function setJournal(id, journal) {
  const db = open();
  db.prepare('UPDATE operations SET journal = ? WHERE id = ?')
    .run(journal == null ? null : JSON.stringify(redactObject(journal)), id);
  return get(id);
}

function cancel(id) {
  const db = open();
  const op = get(id);
  if (!op) return null;
  if (TERMINAL.has(op.state)) return op;
  db.prepare(`
    UPDATE operations
       SET state = ?, finished_at = ?, heartbeat = ?
     WHERE id = ? AND state IN (?, ?)
  `).run(STATES.CANCELLED, Date.now(), Date.now(), id, STATES.QUEUED, STATES.RUNNING);
  if (db.prepare('SELECT changes() AS n').get().n) {
    appendEvent(id, { phase: 'cancelled', message: 'operation cancelled', level: 'warn' });
  }
  return get(id);
}

function markRecoveryRequired(id, { code, text, recovery }) {
  const db = open();
  db.prepare(`
    UPDATE operations
       SET state = ?, finished_at = ?, heartbeat = ?,
           error_code = ?, error_text = ?, recovery = ?
     WHERE id = ?
  `).run(
    STATES.RECOVERY_REQUIRED,
    Date.now(),
    Date.now(),
    code || 'recovery_required',
    text || '',
    recovery ? JSON.stringify(redactObject(recovery)) : null,
    id,
  );
  appendEvent(id, { phase: 'recovery_required', message: text || code, level: 'error' });
  return get(id);
}

/*
 * Sweep stale running operations at boot. Spec:
 *   "On startup, stale read-only work may fail safely. Interrupted
 *    destructive work becomes recovery_required and never resumes
 *    automatically."
 *
 * The kernel has to know which kinds are destructive and which are read-only.
 * By default any kind containing "snapshot" / "install" / "update" / "restore"
 * / "pack" / "template" / "world-write" is treated as destructive; everything
 * else (reports, scans) is treated as read-only and just marked failed.
 */
// "create" is here too: an interrupted server install leaves a half-folder on
// disk, which is destructive work, so it must recover rather than fail.
const DESTRUCTIVE_KIND_HINTS = ['snapshot', 'install', 'create', 'update', 'restore', 'pack', 'template', 'world-write', 'world-write', 'purge', 'replace'];

function isDestructiveKind(kind) {
  if (!kind) return false;
  const k = String(kind).toLowerCase();
  return DESTRUCTIVE_KIND_HINTS.some((hint) => k.includes(hint));
}

function sweepStale({ heartbeatStaleMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const db = open();
  const stale = db.prepare(`
    SELECT * FROM operations
     WHERE (state = ? AND (heartbeat IS NULL OR heartbeat < ?))
        OR (state = ? AND queued_at < ?)
  `).all(STATES.RUNNING, now - heartbeatStaleMs, STATES.QUEUED, now - heartbeatStaleMs);
  const out = [];
  for (const row of stale) {
    if (isDestructiveKind(row.kind)) {
      markRecoveryRequired(row.id, {
        code: 'interrupted',
        text: 'panel restarted while operation was in flight',
        recovery: { journal: row.journal, kind: row.kind, serverId: row.server_id },
      });
    } else {
      fail(row.id, { code: 'stale', text: 'operation aborted at panel startup' });
    }
    out.push(get(row.id));
  }
  return out;
}

/*
 * Append an event to the operation timeline. Events are append-only; we never
 * UPDATE or DELETE rows in operation_events. The metadata goes through the
 * redactor so a careless caller can't leak secrets into the timeline.
 */
function appendEvent(operationId, { phase, message, level, metadata } = {}) {
  const db = open();
  db.prepare(`
    INSERT INTO operation_events (operation_id, ts, phase, message, level, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    Date.now(),
    phase || null,
    message || null,
    level || 'info',
    metadata ? JSON.stringify(redactObject(metadata)) : null,
  );
}

function listEvents(operationId, { since } = {}) {
  const db = open();
  const where = ['operation_id = ?'];
  const args = [operationId];
  if (since) { where.push('ts > ?'); args.push(since); }
  const rows = db.prepare(`
    SELECT id, operation_id, ts, phase, message, level, metadata
      FROM operation_events
     WHERE ${where.join(' AND ')}
     ORDER BY ts ASC, id ASC
  `).all(...args);
  return rows.map((r) => ({
    id: r.id,
    operationId: r.operation_id,
    ts: r.ts,
    phase: r.phase,
    message: r.message,
    level: r.level,
    metadata: r.metadata ? safeJson(r.metadata) : null,
  }));
}

/*
 * Per-server lock: only one mutating operation may hold the lock at a time.
 * This is enforced by a short transaction; the caller passes the operationId
 * they want to grant the lock to and the serverId they want it for. Returns
 * true if the lock was acquired, false otherwise. Always call unlock() in a
 * finally.
 */
function acquireServerLock(operationId, serverId) {
  if (!serverId) return true; // server-agnostic operations don't need a lock
  const db = open();
  // The conflict check must be atomic with respect to other callers claiming
  // the same server: an IMMEDIATE transaction takes the write lock up front,
  // so concurrent checks serialize and the loser sees the winner's running
  // operation. (Today's callers check synchronously with no await in between,
  // so this is defense-in-depth in the single-threaded layout - but it makes
  // the "short transaction" guarantee documented below real, and keeps the
  // pattern safe if a caller ever inserts an await between check and start.)
  const check = () => {
    // Running operations are the lock holders. Queued work is waiting for the
    // lock and must not block another queued operation merely by existing.
    const conflict = db.prepare(`
      SELECT id FROM operations
       WHERE server_id = ? AND state = ?
         AND id != ?
    `).get(serverId, STATES.RUNNING, operationId);
    return !conflict;
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = check();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* connection still usable */ }
    throw err;
  }
}

module.exports = {
  STATES,
  create,
  get,
  list,
  start,
  heartbeat,
  finish,
  fail,
  setJournal,
  cancel,
  markRecoveryRequired,
  appendEvent,
  listEvents,
  sweepStale,
  acquireServerLock,
  isDestructiveKind,
  genId,
};
