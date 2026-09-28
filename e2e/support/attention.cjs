'use strict';

/*
 * Findings and crashes for a panel under test, the two things the Overview's
 * Needs attention list reads from the panel's own analysis.
 *
 * Like metrics.cjs this writes the database directly: findings come from the
 * health sampler on a one-minute timer and crashes from a real process dying,
 * and neither has an ingestion route. It writes the same rows lib/health.cjs
 * and lib/crashes.cjs write, into that instance's throwaway database only.
 */

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function withDb(panel, fn) {
  const db = new Database(path.join(panel.dataDir, 'fleetdeck.db'));
  try { return fn(db); } finally { db.close(); }
}

/**
 * An active health finding (default: no verified backup for 9 days). Also
 * marks the server as analysed: until the first analysis row exists,
 * /api/health reports no findings at all.
 */
function seedFinding(panel, serverId, {
  ruleId = 'backup.stale', severity = 'warning', evidence = { reason: 'stale', ageDays: 9 },
} = {}) {
  const now = Date.now();
  return withDb(panel, (db) => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO health_alerts
        (id, server_id, rule_id, severity, state, occurrences, first_seen_at, last_seen_at, cooldown_until, algo_version, evidence_json)
      VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL, 'e2e', ?)
      ON CONFLICT(server_id, rule_id) DO UPDATE SET state = 'active', severity = excluded.severity, evidence_json = excluded.evidence_json, cooldown_until = NULL
    `).run(id, serverId, ruleId, severity, now - 3600e3, now, JSON.stringify(evidence));
    db.prepare(`
      INSERT OR IGNORE INTO health_analysis (server_id, computed_at, ok, error_code, payload_json)
      VALUES (?, ?, 1, NULL, '{}')
    `).run(serverId, now);
    return id;
  });
}

/** Drop every finding for one server, as if analysis had found nothing. */
function clearFindings(panel, serverId) {
  withDb(panel, (db) => db.prepare('DELETE FROM health_alerts WHERE server_id = ?').run(serverId));
}

/** An unacknowledged crash group with `count` crashes, the last two hours ago. */
function seedCrash(panel, serverId, { count = 3, category = 'java' } = {}) {
  const last = Date.now() - 2 * 3600e3;
  return withDb(panel, (db) => {
    const groupId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO crash_groups (id, server_id, fingerprint, category, first_seen_at, last_seen_at, count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(groupId, serverId, `e2e-${groupId}`, category, last - 3600e3, last, count);
    db.prepare(`
      INSERT INTO crash_incidents (id, group_id, server_id, exit_code, signal, occurred_at, runtime_ms, evidence_json, environment_json)
      VALUES (?, ?, ?, 1, NULL, ?, 1000, ?, ?)
    `).run(crypto.randomUUID(), groupId, serverId, last, JSON.stringify({ console: [] }), JSON.stringify({ lifecycle: 'crash' }));
    return groupId;
  });
}

/** Whether a crash group has been acknowledged. */
function crashAcknowledged(panel, groupId) {
  return withDb(panel, (db) => !!db.prepare('SELECT acknowledged_at FROM crash_groups WHERE id = ?').get(groupId)?.acknowledged_at);
}

module.exports = { seedFinding, clearFindings, seedCrash, crashAcknowledged };
