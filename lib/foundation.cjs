'use strict';

/*
 * Foundation boot: open the database, run migrations, sweep stale
 * operations, import legacy data. Idempotent. Safe to call multiple times
 * during a single process; the database handle is a singleton.
 *
 * Order matters:
 *   1. db.open() - PRAGMAs applied.
 *   2. migrations.runMigrations() - schema is current.
 *   3. operations.sweepStale() - mark interrupted work as recovery_required.
 *   4. imports.importLegacyMetrics() - one-shot legacy data ingestion.
 *   5. fsTransaction.sweep() for each server folder we know about.
 *
 * Any of these failing is logged but does not abort boot: the spec says
 * "Database failure must not affect process supervision; emit a safe panel
 * warning and retry a bounded queued capture." We log and continue, and
 * the next call to bootFoundation() (e.g. from a health check) retries.
 */

const path = require('path');
const { open, close, dbPath, dataDir } = require('./db.cjs');
const migrations = require('./migrations.cjs');
const operations = require('./operations.cjs');
const imports = require('./imports.cjs');
const fsTx = require('./fsTransaction.cjs');

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[Hostkind ${ts}]`, ...args);
}

function sweepStagingForServers(servers) {
  const out = [];
  const recoverable = new Map();
  try {
    for (const op of operations.list({ state: operations.STATES.RECOVERY_REQUIRED, limit: 10000 }).items) {
      if (!recoverable.has(op.serverId)) recoverable.set(op.serverId, []);
      recoverable.get(op.serverId).push(op.id);
    }
  } catch { /* database may be unavailable */ }
  for (const s of servers || []) {
    if (!s || !s.dir) continue;
    try {
      const removed = fsTx.sweep(s.dir, { preserveOperationIds: recoverable.get(s.id) || [] });
      if (removed.length) out.push({ serverId: s.id, removed });
    } catch (err) {
      log('staging sweep failed for', s.id, err.message);
    }
  }
  return out;
}

function bootFoundation({ servers = [], users = [], logFn = log } = {}) {
  const result = { ok: true, steps: [] };

  // Step 1: open the database. If this fails, the panel cannot function
  // safely. We log a warning and continue - the rest of the panel still
  // works (per spec: database failure must not affect process supervision).
  try {
    open();
    result.steps.push({ step: 'open', ok: true });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'open', ok: false, error: err.message });
    logFn('foundation: database open failed; running with disabled foundation:', err.message);
    return result;
  }

  // Step 2: run migrations.
  try {
    const m = migrations.runMigrations();
    result.steps.push({ step: 'migrate', ok: true, applied: m.applied.length });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'migrate', ok: false, error: err.message });
    logFn('foundation: migration failed; foundation remains at prior version:', err.message);
    return result;
  }

  // Existing operators had broad access before capabilities existed. Preserve
  // that access exactly once; subsequent revocations must remain revoked.
  try {
    const key = 'capability-parity:v1';
    if (!migrations.hasImported(key)) {
      const caps = require('./capabilities.cjs');
      const db = open();
      db.transaction(() => {
        for (const user of users.filter((u) => u && u.role === 'operator')) {
          for (const server of servers) {
            for (const capability of caps.perServerCapabilities()) {
              caps.grant(user.id, server.id, capability, null);
            }
          }
        }
        migrations.recordImport(key, { operators: users.filter((u) => u && u.role === 'operator').length, servers: servers.length });
      })();
    }
    result.steps.push({ step: 'capabilityParity', ok: true });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'capabilityParity', ok: false, error: err.message });
  }

  // Roadmap 09 introduced server.view after the original parity import had
  // already run on existing installations. Preserve those operators' prior
  // ability to discover their assigned servers exactly once without
  // re-granting any capability that an administrator later revokes.
  try {
    const key = 'capability-parity:server-view:v1';
    if (!migrations.hasImported(key)) {
      const caps = require('./capabilities.cjs');
      const db = open();
      db.transaction(() => {
        for (const user of users.filter((u) => u && u.role === 'operator')) {
          for (const server of servers) {
            caps.grant(user.id, server.id, caps.CAPABILITIES.SERVER_VIEW, null);
          }
        }
        migrations.recordImport(key, { operators: users.filter((u) => u && u.role === 'operator').length, servers: servers.length });
      })();
    }
    result.steps.push({ step: 'serverViewParity', ok: true });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'serverViewParity', ok: false, error: err.message });
  }

  // Step 3: sweep stale operations.
  try {
    const stale = operations.sweepStale();
    result.steps.push({ step: 'sweep', ok: true, marked: stale.length });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'sweep', ok: false, error: err.message });
  }

  // Step 4: one-shot legacy imports.
  try {
    const r = imports.importLegacyMetrics();
    result.steps.push({ step: 'importMetrics', ok: true, alreadyImported: !!r.alreadyImported, missing: !!r.missing });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'importMetrics', ok: false, error: err.message });
  }

  // Step 5: sweep stale staging directories.
  try {
    const cleaned = sweepStagingForServers(servers);
    result.steps.push({ step: 'stagingSweep', ok: true, cleaned });
  } catch (err) {
    result.ok = false;
    result.steps.push({ step: 'stagingSweep', ok: false, error: err.message });
  }

  return result;
}

function foundationStatus() {
  try {
    const db = open();
    const applied = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
    const ops = db.prepare(`SELECT state, COUNT(*) as n FROM operations GROUP BY state`).all();
    const audits = db.prepare('SELECT COUNT(*) as n FROM audit_events').get();
    const grants = db.prepare('SELECT COUNT(*) as n FROM capability_grants').get();
    return { ok: true, dbPath: dbPath(), dataDir: dataDir(), applied, ops, auditCount: audits.n, grantCount: grants.n };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { bootFoundation, foundationStatus };
