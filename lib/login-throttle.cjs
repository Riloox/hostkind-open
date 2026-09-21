'use strict';

/*
 * Phase 2B persistent login throttling.
 *
 * Replaces the in-memory Map in server.js with SQLite-backed counters
 * (login_attempts table from migration 17) so a panel restart does not reset
 * brute-force locks. Same two-bucket shape: per-identifier (5/15min) and
 * per-IP (15/15min), lock 15min, sliding window expiry. Falls back to an
 * in-memory Map when the database is unavailable so auth never hard-fails.
 */

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_IP_MAX_ATTEMPTS = 15;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const memFallback = new Map();

function dbOrNull() {
  try { return require('./db.cjs').open(); }
  catch { return null; }
}

function tableReady(db) {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='login_attempts'`).get();
  } catch { return false; }
}

function readRec(key) {
  const db = dbOrNull();
  if (db && tableReady(db)) {
    try {
      const row = db.prepare('SELECT count, first_at, lock_until FROM login_attempts WHERE key = ?').get(key);
      if (!row) return null;
      return { count: row.count, firstAt: row.first_at, lockUntil: row.lock_until };
    } catch { /* fall through to memory */ }
  }
  return memFallback.get(key) || null;
}

function writeRec(key, rec) {
  const db = dbOrNull();
  if (db && tableReady(db)) {
    try {
      db.prepare(`INSERT INTO login_attempts (key, count, first_at, lock_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET count=excluded.count, first_at=excluded.first_at, lock_until=excluded.lock_until`)
        .run(key, rec.count, rec.firstAt, rec.lockUntil);
      return;
    } catch { /* fall through */ }
  }
  memFallback.set(key, rec);
}

function deleteRec(key) {
  const db = dbOrNull();
  if (db && tableReady(db)) {
    try { db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key); } catch { /* noop */ }
  }
  memFallback.delete(key);
}

function lockRemainingMs(key) {
  const rec = readRec(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockUntil && rec.lockUntil > now) return rec.lockUntil - now;
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { deleteRec(key); return 0; }
  return 0;
}

function noteFailure(key, max) {
  const now = Date.now();
  let rec = readRec(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) rec = { count: 0, firstAt: now, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= max) rec.lockUntil = now + LOGIN_LOCK_MS;
  writeRec(key, rec);
}

function clearFailures(...keys) {
  for (const k of keys) deleteRec(k);
}

module.exports = {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  LOGIN_LOCK_MS,
  lockRemainingMs,
  noteFailure,
  clearFailures,
};
