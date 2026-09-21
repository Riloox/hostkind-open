'use strict';

/*
 * Phase 2B centralized retention + server-scoped cleanup.
 *
 * Mirrors health.runRetention: every prune is idempotent, transactional, and
 * safe to run on a periodic tick. Owns two jobs:
 *   1. runRetention(now): prune append-only tables (operation_events,
 *      crash_*, product_events, audit previews/requests) plus the health
 *      rollup fold. Audit events themselves are only auto-pruned when the
 *      caller opts in (manual retention flow stays authoritative).
 *   2. deleteServerData(serverId): fan-out delete for a removed server across
 *      every server-scoped table, extending health.deleteServerData which
 *      only covered health/metric rows.
 */

const { open } = require('./db.cjs');
const { checkpointPassive } = require('./db.cjs');

const SERVER_SCOPED_TABLES = Object.freeze([
  // [table, column]
  ['metric_samples', 'server_id'],
  ['metric_rollups', 'server_id'],
  ['health_baselines', 'server_id'],
  ['health_alerts', 'server_id'],
  ['health_analysis', 'server_id'],
  ['health_settings', 'server_id'],
  ['world_inventory', 'server_id'],
  ['world_operations', 'server_id'],
  ['world_previews', 'server_id'],
  ['operations', 'server_id'],
  ['snapshots', 'server_id'],
  ['crash_groups', 'server_id'],
  ['crash_incidents', 'server_id'],
  ['content_provenance', 'server_id'],
  ['update_plans', 'server_id'],
  ['modpack_manifests', 'server_id'],
  ['backup_manifests', 'server_id'],
  ['capability_grants', 'server_id'],
]);

function tableExists(db, name) {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch { return false; }
}

function deleteServerData(serverId) {
  if (!serverId) return { deleted: {} };
  const db = open();
  const deleted = {};
  db.transaction(() => {
    for (const [table, column] of SERVER_SCOPED_TABLES) {
      if (!tableExists(db, table)) continue;
      try {
        deleted[table] = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(serverId).changes;
      } catch { /* column/table drift: best effort */ }
    }
    // Operation timelines of deleted operations; FK cascade covers most.
    try {
      deleted.operation_events = db.prepare(
        'DELETE FROM operation_events WHERE operation_id NOT IN (SELECT id FROM operations)'
      ).run().changes;
    } catch { /* table missing */ }
    try {
      deleted.crash_conclusions = db.prepare(
        'DELETE FROM crash_conclusions WHERE incident_id NOT IN (SELECT id FROM crash_incidents)'
      ).run().changes;
    } catch { /* table missing */ }
    try {
      deleted.audit_events = 0; // audit trail is global; manual retention owns it
    } catch { /* noop */ }
  })();
  // Capability grants with NULL server_id are global; only server-scoped rows go.
  return { deleted };
}

function runRetention({ now = Date.now(), auditRetentionMs = null } = {}) {
  const out = { at: now };
  try { out.health = require('./health.cjs').runRetention(now); }
  catch (err) { out.health = { error: err.message }; }
  try { out.operationEvents = require('./operations.cjs').pruneOperationEvents({ now }); }
  catch (err) { out.operationEvents = { error: err.message }; }
  try { out.crashes = require('./crashes.cjs').pruneCrashes({ now }); }
  catch (err) { out.crashes = { error: err.message }; }
  try { out.product = require('./product-store.cjs').pruneProductEvents({ now }); }
  catch (err) { out.product = { error: err.message }; }
  try { out.audit = require('./audit.cjs').pruneAudit({ now, retentionMs: auditRetentionMs }); }
  catch (err) { out.audit = { error: err.message }; }
  try {
    const db = open();
    const expiredWorldPreviews = tableExists(db, 'world_previews')
      ? db.prepare('DELETE FROM world_previews WHERE expires_at < ?').run(now).changes : 0;
    const expiredTemplatePreviews = tableExists(db, 'template_import_previews')
      ? db.prepare('DELETE FROM template_import_previews WHERE expires_at < ?').run(now).changes : 0;
    out.previews = { expiredWorldPreviews, expiredTemplatePreviews };
  } catch (err) { out.previews = { error: err.message }; }
  try { out.checkpoint = checkpointPassive(); }
  catch (err) { out.checkpoint = { error: err.message }; }
  return out;
}

module.exports = { runRetention, deleteServerData, SERVER_SCOPED_TABLES };
