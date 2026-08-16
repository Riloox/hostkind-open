'use strict';

/*
 * Durable SQLite queue for the standalone relay.
 *
 * The relay persists a validated + redacted report BEFORE any network call:
 * enqueue() writes the row synchronously, and only then may the queue worker
 * touch GitHub. The queue is an append-only table with an idempotency
 * marker (UNIQUE) and a sync state machine (pending -> synced | failed).
 *
 * Retry gating lives in listPending(): a row is eligible when it has not
 * exhausted its attempt budget, is younger than maxAgeMs, and its exponential
 * backoff window (backoffBaseMs * 2^(attempts-1)) has elapsed since the last
 * update. markFailed() stores a REDACTED, truncated error so a secret can
 * never reach the database.
 *
 * All functions are synchronous (better-sqlite3). createStore() returns an
 * isolated instance so tests can point each instance at its own temp file;
 * production uses RELAY_DATA_DIR (see relay/README.md).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { redactString } = require('./redact-report.cjs');

const DAY_MS = 86_400_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;
const MAX_ERROR_LENGTH = 500;

const SELECT_COLUMNS = `
  id, marker, title, payload, sync_state, attempts, issue_number, issue_url,
  last_error, created_at, updated_at
`;

function createStore(opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, '..', 'data', 'relay.db');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_reports (
      id           TEXT PRIMARY KEY,
      marker       TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      payload      TEXT NOT NULL,
      sync_state   TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_state IN ('pending', 'failed', 'synced')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      issue_number INTEGER,
      issue_url    TEXT,
      last_error   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_reports_pending
      ON relay_reports (sync_state, attempts, updated_at);
  `);

  function requireNonEmpty(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`relay-store: ${field} must be a non-empty string`);
    }
    return value.trim();
  }

  /*
   * Map a raw row to one with payload parsed back to an object. A corrupt
   * payload parses to null (the worker treats it as non-retryable).
   */
  function withParsedPayload(row) {
    if (!row) return null;
    let payload = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    return { ...row, payload };
  }

  function getRow(id) {
    return withParsedPayload(
      db.prepare(`SELECT ${SELECT_COLUMNS} FROM relay_reports WHERE id = ?`).get(id),
    );
  }

  /*
   * Persist a report. input: { marker, title, payload } where payload is the
   * already-redacted report object. Returns the stored row.
   *
   * Idempotency: when the marker already exists, the EXISTING row is
   * returned unchanged — double submissions can never create a duplicate
   * queue entry (and therefore never a duplicate GitHub issue).
   */
  function enqueue(input, opts2 = {}) {
    const marker = requireNonEmpty(input && input.marker, 'marker');
    const title = requireNonEmpty(input && input.title, 'title');
    if (!input.payload || typeof input.payload !== 'object') {
      throw new Error('relay-store: payload object is required');
    }
    const id = opts2.id !== undefined ? String(opts2.id) : crypto.randomUUID();
    const ts = opts2.now !== undefined ? opts2.now : now();

    const existing = db.prepare('SELECT id FROM relay_reports WHERE marker = ?').get(marker);
    if (existing) return getRow(existing.id);

    db.prepare(`
      INSERT INTO relay_reports (
        id, marker, title, payload, sync_state, attempts,
        issue_number, issue_url, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)
    `).run(id, marker, title, JSON.stringify(input.payload), ts, ts);

    return getRow(id);
  }

  function get(id) {
    return getRow(id);
  }

  function getByMarker(marker) {
    const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM relay_reports WHERE marker = ?`).get(marker);
    return withParsedPayload(row);
  }

  /*
   * Rows eligible for sync, oldest first.
   * opts: { now, limit (10), maxAttempts (5), backoffBaseMs (60_000),
   *         maxAgeMs (30 days) }
   */
  function listPending(opts3 = {}) {
    const t = opts3.now !== undefined ? opts3.now : now();
    const limit = opts3.limit !== undefined ? opts3.limit : 10;
    const maxAttempts = opts3.maxAttempts !== undefined ? opts3.maxAttempts : DEFAULT_MAX_ATTEMPTS;
    const backoffBaseMs = opts3.backoffBaseMs !== undefined ? opts3.backoffBaseMs : DEFAULT_BACKOFF_BASE_MS;
    const maxAgeMs = opts3.maxAgeMs !== undefined ? opts3.maxAgeMs : DEFAULT_MAX_AGE_MS;

    const rows = db.prepare(`
      SELECT ${SELECT_COLUMNS}
        FROM relay_reports
       WHERE sync_state IN ('pending', 'failed')
         AND attempts < @maxAttempts
         AND updated_at >= @t - @maxAgeMs
         AND (attempts = 0 OR updated_at + @backoffBaseMs * CAST(POWER(2, attempts - 1) AS INTEGER) <= @t)
       ORDER BY created_at ASC
       LIMIT @limit
    `).all({ t, limit, maxAttempts, backoffBaseMs, maxAgeMs });

    return rows.map(withParsedPayload);
  }

  function markSynced(id, { issueNumber, issueUrl } = {}, opts4 = {}) {
    const ts = opts4.now !== undefined ? opts4.now : now();
    db.prepare(`
      UPDATE relay_reports
         SET sync_state = 'synced',
             issue_number = ?,
             issue_url = ?,
             last_error = NULL,
             updated_at = ?
       WHERE id = ?
    `).run(
      issueNumber == null ? null : Number(issueNumber),
      issueUrl == null ? null : String(issueUrl),
      ts,
      id,
    );
    return getRow(id);
  }

  /*
   * Record a failed attempt. The error is redacted and truncated before it
   * touches the database; the attempt count is the worker-computed budget.
   */
  function markFailed(id, { error, attempts } = {}, opts5 = {}) {
    const ts = opts5.now !== undefined ? opts5.now : now();
    const redacted = redactString(error == null ? '' : String(error)).text;
    const truncated = redacted.length > MAX_ERROR_LENGTH
      ? redacted.slice(0, MAX_ERROR_LENGTH)
      : redacted;

    db.prepare(`
      UPDATE relay_reports
         SET sync_state = 'failed',
             attempts = ?,
             last_error = ?,
             updated_at = ?
       WHERE id = ?
    `).run(
      Number.isFinite(Number(attempts)) ? Number(attempts) : 0,
      truncated,
      ts,
      id,
    );
    return getRow(id);
  }

  function counts() {
    const rows = db.prepare(`
      SELECT sync_state, COUNT(*) AS n FROM relay_reports GROUP BY sync_state
    `).all();
    const out = { total: 0, pending: 0, failed: 0, synced: 0 };
    for (const r of rows) out[r.sync_state] = r.n;
    out.total = out.pending + out.failed + out.synced;
    return out;
  }

  function close() {
    // Checkpoint + truncate WAL first so no -wal/-shm file lingers to lock
    // the directory on Windows after close.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* already closed */ }
    try { db.close(); } catch { /* already closed */ }
  }

  return {
    enqueue,
    get,
    getByMarker,
    listPending,
    markSynced,
    markFailed,
    counts,
    close,
    dbPath: () => dbPath,
  };
}

module.exports = {
  createStore,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_AGE_MS,
  DAY_MS,
};
