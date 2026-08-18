'use strict';

/*
 * One-shot importer for the legacy metrics.json file.
 *
 * Spec contract (docs/roadmap/README.md "Shared platform foundation"):
 *   - "Import metrics.json once, without deleting or rewriting it. Record
 *      the import key in data_imports; duplicate runs are no-ops."
 *
 * The existing sampler stores { serverId: [[ts,cpu,mem,players,world], ...] }.
 * Importing the samples and recording the idempotency key happen in one
 * transaction, so a partial import can never be mistaken for a completed one.
 */

const fs = require('fs');
const path = require('path');
const { hasImported } = require('./migrations.cjs');
const { open } = require('./db.cjs');

const METRICS_PATH = path.join(__dirname, '..', 'metrics.json');
const IMPORT_KEY = 'metrics.json:v1';

function summaryOf(p) {
  let stat;
  try { stat = fs.statSync(p); } catch { return null; }
  let sampleCount = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      sampleCount = Object.values(raw).reduce((n, samples) => n + (Array.isArray(samples) ? samples.length : 0), 0);
    }
  } catch { /* not parseable - report what we have */ }
  return { path: p, size: stat.size, mtime: stat.mtimeMs, sampleCount };
}

function importLegacyMetrics({ force = false } = {}) {
  if (!force && hasImported(IMPORT_KEY)) {
    return { ok: true, alreadyImported: true };
  }
  const summary = summaryOf(METRICS_PATH);
  if (!summary) return { ok: true, alreadyImported: false, missing: true };
  const raw = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
  const db = open();
  let imported = 0;
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO metric_samples (server_id, ts, cpu, memory_mb, players, world_mb)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, ts) DO NOTHING
    `);
    for (const [serverId, samples] of Object.entries(raw || {})) {
      if (!Array.isArray(samples)) continue;
      for (const sample of samples) {
        if (!Array.isArray(sample) || !Number.isFinite(Number(sample[0]))) continue;
        imported += insert.run(serverId, Number(sample[0]), nullableNumber(sample[1]), nullableNumber(sample[2]), nullableNumber(sample[3]), nullableNumber(sample[4])).changes;
      }
    }
    db.prepare(`
      INSERT INTO data_imports (key, imported_at, summary) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET imported_at = excluded.imported_at, summary = excluded.summary
    `).run(IMPORT_KEY, Date.now(), JSON.stringify({ ...summary, imported }));
  })();
  return { ok: true, summary: { ...summary, imported } };
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { importLegacyMetrics, IMPORT_KEY, METRICS_PATH };
