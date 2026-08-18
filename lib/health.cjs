'use strict';

/*
 * Health and capacity analysis (docs/roadmap/07-health-and-capacity.md).
 *
 * The rule of this module is that it would rather say nothing than say
 * something it cannot support:
 *   - baselines are only computed once a window has enough samples AND enough
 *     time coverage; otherwise the caller gets an explicit insufficiency reason.
 *   - the disk forecast is omitted (not zeroed, not "healthy") unless coverage,
 *     positive growth, fit quality, and a known filesystem capacity all hold.
 *   - correlations report association, never causation, and need overlapping
 *     samples with real variance.
 *   - gaps (downtime, sleeping host, clock jumps, collection failures) stay
 *     gaps; we never interpolate a sample that was not taken.
 *
 * Findings must persist across analysis runs before they surface, and a
 * resolved finding enters a cooldown so it cannot flap. Every finding stores
 * the exact numbers it was derived from plus the algorithm version, so the UI
 * can re-render it from the database without recomputing anything.
 *
 * Analysis never touches server supervision: analyze() swallows its own
 * failures, marks the last result stale, and returns.
 */

const crypto = require('crypto');
const { open } = require('./db.cjs');

const ALGO_VERSION = 'health/1';

// Sampling cadence of the panel's metrics sampler (server.js).
const SAMPLE_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Retention: raw minute samples for 14 days, hourly rollups for 90. Both are
// versioned via the migration that created the tables; changing them here is a
// behavioural change, not a schema one.
const RAW_RETENTION_MS = 14 * DAY_MS;
const ROLLUP_RETENTION_MS = 90 * DAY_MS;

// A window is only usable when it has both enough samples and enough spread.
// Coverage is (last - first) / window, so a burst of 200 samples in 5 minutes
// does not qualify as a 24-hour baseline.
const WINDOWS = Object.freeze({
  '1h':  { ms: HOUR_MS,     minSamples: 20,  minCoverage: 0.5 },
  '24h': { ms: DAY_MS,      minSamples: 180, minCoverage: 0.5 },
  '7d':  { ms: 7 * DAY_MS,  minSamples: 800, minCoverage: 0.4 },
});

const DEFAULTS = Object.freeze({
  cpuWarnPct: 85,
  cpuCriticalPct: 95,
  memoryWarnRatio: 0.9,
  memoryCriticalRatio: 0.97,
  tpsWarn: 15,
  tpsCritical: 10,
  diskWarnDays: 14,
  diskCriticalDays: 3,
  backupStaleDays: 7,
  minOccurrences: 2,          // analysis runs a finding must persist for
  cooldownMinutes: 30,        // suppression after a finding resolves
  forecastMinCoverageMs: 2 * DAY_MS,
  forecastMinSamples: 240,
  forecastMinFitQuality: 0.5, // robust R-squared analogue, 0..1
  forecastMaxDays: 365,       // beyond this the projection is not worth showing
  correlationMinPairs: 30,
});

const RULES = ['cpu.sustained', 'memory.pressure', 'tps.low', 'disk.forecast', 'backup.stale'];

// --- settings -------------------------------------------------------------

function settingsFor(serverId) {
  const row = open().prepare('SELECT settings_json FROM health_settings WHERE server_id = ?').get(serverId);
  if (!row) return { ...DEFAULTS };
  let stored = {};
  try { stored = JSON.parse(row.settings_json) || {}; } catch { stored = {}; }
  return { ...DEFAULTS, ...stored };
}

/*
 * Only known numeric keys are accepted, and each is clamped to a sane band so
 * a bad setting can never make the analyzer emit nonsense (or divide by zero).
 */
const SETTING_BOUNDS = Object.freeze({
  cpuWarnPct: [1, 100], cpuCriticalPct: [1, 100],
  memoryWarnRatio: [0.1, 1.5], memoryCriticalRatio: [0.1, 1.5],
  tpsWarn: [1, 20], tpsCritical: [1, 20],
  diskWarnDays: [1, 365], diskCriticalDays: [1, 365],
  backupStaleDays: [1, 365],
  minOccurrences: [1, 20], cooldownMinutes: [0, 1440],
});

function saveSettings(serverId, patch, actorId) {
  const next = {};
  for (const [key, [min, max]] of Object.entries(SETTING_BOUNDS)) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`${key} must be a number`), { status: 400 });
    if (value < min || value > max) throw Object.assign(new Error(`${key} must be between ${min} and ${max}`), { status: 400 });
    next[key] = value;
  }
  const merged = { ...settingsFor(serverId), ...next };
  if (merged.cpuCriticalPct < merged.cpuWarnPct) throw Object.assign(new Error('cpuCriticalPct must not be below cpuWarnPct'), { status: 400 });
  if (merged.tpsCritical > merged.tpsWarn) throw Object.assign(new Error('tpsCritical must not be above tpsWarn'), { status: 400 });
  if (merged.diskCriticalDays > merged.diskWarnDays) throw Object.assign(new Error('diskCriticalDays must not be above diskWarnDays'), { status: 400 });
  const explicit = { ...next };
  const row = open().prepare('SELECT settings_json FROM health_settings WHERE server_id = ?').get(serverId);
  if (row) { try { Object.assign(explicit, JSON.parse(row.settings_json), next); } catch { /* corrupt row: overwrite */ } }
  open().prepare(`
    INSERT INTO health_settings (server_id, updated_at, updated_by, settings_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET updated_at = excluded.updated_at, updated_by = excluded.updated_by, settings_json = excluded.settings_json
  `).run(serverId, Date.now(), actorId || null, JSON.stringify(explicit));
  return settingsFor(serverId);
}

// --- sample ingestion -----------------------------------------------------

/*
 * Absent means absent. Number(null) and Number('') are both 0, so coercing
 * blindly would turn "this server reported no TPS" into "this server reported
 * a TPS of zero" - a fabricated sample, and a rather alarming one.
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/*
 * Validated insert. A sample with a non-finite timestamp, or values outside the
 * physically possible range, is dropped rather than stored: a bad sample would
 * otherwise poison every baseline computed from it.
 */
function recordSample(sample) {
  const ts = num(sample.ts);
  if (!ts || ts <= 0) return false;
  const bounded = (value, min, max) => {
    const n = num(value);
    if (n === null || n < min || n > max) return null;
    return n;
  };
  open().prepare(`
    INSERT INTO metric_samples (server_id, ts, cpu, memory_mb, players, world_mb, tps, online, heap_mb, disk_used_mb, disk_total_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, ts) DO NOTHING
  `).run(
    String(sample.serverId), Math.round(ts),
    bounded(sample.cpu, 0, 100),
    bounded(sample.memoryMb, 0, 1e9),
    bounded(sample.players, 0, 1e6),
    bounded(sample.worldMb, 0, 1e9),
    bounded(sample.tps, 0, 100),
    sample.online ? 1 : 0,
    bounded(sample.heapMb, 0, 1e9),
    bounded(sample.diskUsedMb, 0, 1e12),
    bounded(sample.diskTotalMb, 0, 1e12),
  );
  return true;
}

const MAX_POINTS = 5000;

/*
 * Bounded, server-scoped read, oldest-first. Raw samples wherever they still
 * exist; hourly rollups only for the part of the range that predates the oldest
 * raw row. Splitting on the data itself rather than on the retention horizon
 * means a range reads the same whether or not retention has run yet, and the
 * two sources can never overlap and double-count an hour.
 */
function querySamples(serverId, { since, until = Date.now(), limit = MAX_POINTS } = {}) {
  const db = open();
  const cap = Math.min(Math.max(Number(limit) || MAX_POINTS, 1), MAX_POINTS);
  const from = Math.max(0, Number(since) || 0);
  const raw = db.prepare(`
    SELECT ts AS t, cpu, memory_mb AS mem, players, world_mb AS world, tps, online,
           heap_mb AS heap, disk_used_mb AS diskUsed, disk_total_mb AS diskTotal
      FROM metric_samples WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(serverId, from, until);
  const boundary = raw.length ? raw[0].t : until + 1;
  const points = [];
  if (from < boundary) {
    for (const r of db.prepare(`
      SELECT bucket_ts AS t, cpu_avg AS cpu, memory_avg AS mem, players_avg AS players, world_avg AS world,
             tps_avg AS tps, disk_used_avg AS diskUsed, disk_total_avg AS diskTotal, sample_count AS samples
        FROM metric_rollups WHERE server_id = ? AND bucket_ts >= ? AND bucket_ts < ? ORDER BY bucket_ts
    `).all(serverId, from, boundary)) points.push({ ...r, rollup: true });
  }
  points.push(...raw);
  // Downsample evenly rather than truncating, so a long range keeps its shape
  // and its newest point.
  if (points.length <= cap) return points;
  const stride = Math.ceil(points.length / cap);
  const out = points.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// --- retention ------------------------------------------------------------

/*
 * Fold raw samples older than the raw horizon into hourly buckets, then drop
 * them; drop rollups past the rollup horizon. Idempotent, and safe to run
 * repeatedly: rolled-up hours are recomputed from whatever raw rows remain
 * and only deleted after the bucket is written, inside one transaction.
 */
function runRetention(now = Date.now()) {
  const db = open();
  const rawFloor = now - RAW_RETENTION_MS;
  const rollupFloor = now - ROLLUP_RETENTION_MS;
  return db.transaction(() => {
    const folded = db.prepare(`
      INSERT INTO metric_rollups (server_id, bucket_ts, sample_count, cpu_avg, cpu_max, memory_avg, memory_max,
                                  players_avg, players_max, world_avg, tps_avg, tps_min, disk_used_avg, disk_total_avg)
      SELECT server_id, ts / ${HOUR_MS} * ${HOUR_MS}, COUNT(*), AVG(cpu), MAX(cpu), AVG(memory_mb), MAX(memory_mb),
             AVG(players), MAX(players), AVG(world_mb), AVG(tps), MIN(tps), AVG(disk_used_mb), AVG(disk_total_mb)
        FROM metric_samples WHERE ts < ?
       GROUP BY server_id, ts / ${HOUR_MS}
      ON CONFLICT(server_id, bucket_ts) DO NOTHING
    `).run(rawFloor).changes;
    const pruned = db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(rawFloor).changes;
    const expired = db.prepare('DELETE FROM metric_rollups WHERE bucket_ts < ?').run(rollupFloor).changes;
    return { folded, pruned, expired };
  })();
}

/*
 * A deleted server leaves nothing behind: metrics, baselines, findings and
 * settings all key off server_id and are not foreign-keyed to it.
 */
function deleteServerData(serverId) {
  const db = open();
  db.transaction(() => {
    for (const table of ['metric_samples', 'metric_rollups', 'health_baselines', 'health_alerts', 'health_analysis', 'health_settings']) {
      db.prepare(`DELETE FROM ${table} WHERE server_id = ?`).run(serverId);
    }
  })();
}

// --- statistics -----------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const median = (sorted) => quantile(sorted, 0.5);

/*
 * Theil-Sen slope: the median of all pairwise slopes. Chosen over least squares
 * because a single spike (a backup zip, a log burst) must not be able to swing
 * a disk forecast. Pairs are sub-sampled above a threshold to stay O(n) on
 * long windows.
 */
function theilSen(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const slopes = [];
  const step = n > 200 ? Math.ceil(n / 200) : 1;
  for (let i = 0; i < n; i += step) {
    for (let j = i + step; j < n; j += step) {
      const dx = xs[j] - xs[i];
      if (dx === 0) continue;
      slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const slope = median(slopes);
  const intercepts = xs.map((x, i) => ys[i] - slope * x).sort((a, b) => a - b);
  return { slope, intercept: median(intercepts), slopeLow: quantile(slopes, 0.1), slopeHigh: quantile(slopes, 0.9) };
}

function medianAbs(values) {
  if (!values.length) return 0;
  return median(values.map(Math.abs).sort((a, b) => a - b));
}

/*
 * Robust goodness of fit in 0..1: how much of the data's own spread the trend
 * line explains, measured with median absolute deviation instead of squares.
 * Flat-but-noisy data scores near 0 and is rejected by the forecast gate.
 */
function fitQuality(xs, ys, fit) {
  const med = median([...ys].sort((a, b) => a - b));
  const spread = medianAbs(ys.map((y) => y - med));
  if (spread === 0) return 0;
  const residual = medianAbs(ys.map((y, i) => y - (fit.intercept + fit.slope * xs[i])));
  return Math.max(0, Math.min(1, 1 - residual / spread));
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx < 1e-9 || syy < 1e-9) return null; // no variance: a coefficient here would be noise
  return sxy / Math.sqrt(sxx * syy);
}

// --- baselines ------------------------------------------------------------

/*
 * A sample counts towards process-level baselines (CPU, memory, TPS) only when
 * the server was actually up. Legacy rows imported from metrics.json have no
 * `online` flag; for those we fall back to "the JVM was using memory", which is
 * the best evidence the old format preserved.
 */
const ONLINE_SQL = '(online = 1 OR (online IS NULL AND memory_mb > 0))';

function windowSpec(window) {
  const spec = WINDOWS[window];
  if (!spec) throw Object.assign(new Error(`Unknown window: ${window}`), { status: 400 });
  return spec;
}

/*
 * Returns either { available: true, ... quantiles } or an explicit
 * { available: false, reason } - never a fabricated zero.
 */
function baseline(serverId, metric, window, now = Date.now()) {
  const spec = windowSpec(window);
  const column = { cpu: 'cpu', memory: 'memory_mb', tps: 'tps', players: 'players' }[metric];
  if (!column) throw Object.assign(new Error(`Unknown metric: ${metric}`), { status: 400 });
  const rows = open().prepare(`
    SELECT ts, ${column} AS v FROM metric_samples
     WHERE server_id = ? AND ts >= ? AND ts <= ? AND ${column} IS NOT NULL AND ${ONLINE_SQL}
     ORDER BY ts
  `).all(serverId, now - spec.ms, now);

  if (rows.length < spec.minSamples) {
    return { available: false, reason: 'insufficient_samples', sampleCount: rows.length, requiredSamples: spec.minSamples, window };
  }
  const coverage = (rows[rows.length - 1].ts - rows[0].ts) / spec.ms;
  if (coverage < spec.minCoverage) {
    return { available: false, reason: 'insufficient_coverage', sampleCount: rows.length, coverage, requiredCoverage: spec.minCoverage, window };
  }
  const values = rows.map((r) => r.v).sort((a, b) => a - b);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  return {
    available: true, window, metric, sampleCount: rows.length, coverage,
    firstAt: rows[0].ts, lastAt: rows[rows.length - 1].ts,
    p10: quantile(values, 0.1), p50: median(values), p90: quantile(values, 0.9), p95: quantile(values, 0.95),
    // Interquartile range is the uncertainty we show: a p95 of 90 with an IQR
    // of 3 means something quite different from the same p95 with an IQR of 60.
    iqr: p75 - p25,
    algoVersion: ALGO_VERSION,
  };
}

function cacheBaseline(serverId, metric, window, value, now) {
  open().prepare(`
    INSERT INTO health_baselines (server_id, metric, window, computed_at, sample_count, value_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, metric, window) DO UPDATE SET
      computed_at = excluded.computed_at, sample_count = excluded.sample_count, value_json = excluded.value_json
  `).run(serverId, metric, window, now, value.sampleCount || 0, JSON.stringify(value));
}

// --- disk forecast --------------------------------------------------------

/*
 * Omitted unless every gate passes. Each failure returns the reason, and the UI
 * shows the reason instead of a card - "we don't know yet" is a valid answer
 * and a far more useful one than a confident wrong number.
 */
function diskForecast(serverId, settings, now = Date.now()) {
  const rows = open().prepare(`
    SELECT ts, disk_used_mb AS used, disk_total_mb AS total FROM metric_samples
     WHERE server_id = ? AND ts >= ? AND disk_used_mb IS NOT NULL ORDER BY ts
  `).all(serverId, now - WINDOWS['7d'].ms);

  if (rows.length < settings.forecastMinSamples) {
    return { available: false, reason: 'insufficient_samples', sampleCount: rows.length, requiredSamples: settings.forecastMinSamples };
  }
  const coverageMs = rows[rows.length - 1].ts - rows[0].ts;
  if (coverageMs < settings.forecastMinCoverageMs) {
    return { available: false, reason: 'insufficient_coverage', coverageMs, requiredCoverageMs: settings.forecastMinCoverageMs };
  }
  const capacity = rows[rows.length - 1].total;
  if (!capacity) {
    // statfs failed (network mount, permissions, unsupported platform). Without
    // capacity there is no "full" to forecast towards.
    return { available: false, reason: 'capacity_unavailable', sampleCount: rows.length };
  }
  const xs = rows.map((r) => r.ts);
  const ys = rows.map((r) => r.used);
  const fit = theilSen(xs, ys);
  if (!fit) return { available: false, reason: 'insufficient_samples', sampleCount: rows.length };

  const quality = fitQuality(xs, ys, fit);
  const perDay = fit.slope * DAY_MS;
  if (perDay <= 0) {
    return { available: false, reason: 'no_growth', growthMbPerDay: perDay, sampleCount: rows.length, coverageMs };
  }
  if (quality < settings.forecastMinFitQuality) {
    return { available: false, reason: 'poor_fit', fitQuality: quality, requiredFitQuality: settings.forecastMinFitQuality, sampleCount: rows.length };
  }
  const used = ys[ys.length - 1];
  const free = Math.max(0, capacity - used);
  const days = free / perDay;
  if (days > settings.forecastMaxDays) {
    return { available: false, reason: 'beyond_horizon', daysUntilFull: days, horizonDays: settings.forecastMaxDays };
  }
  // The forecast band comes from the 10th/90th percentile pairwise slopes, so
  // the range widens honestly when growth is erratic.
  const bandDays = (slope) => (slope * DAY_MS > 0 ? free / (slope * DAY_MS) : null);
  return {
    available: true, algoVersion: ALGO_VERSION,
    sampleCount: rows.length, coverageMs, fitQuality: quality,
    usedMb: used, totalMb: capacity, freeMb: free,
    growthMbPerDay: perDay,
    daysUntilFull: days,
    daysUntilFullRange: [bandDays(fit.slopeHigh), bandDays(fit.slopeLow)], // faster growth = sooner
  };
}

// --- memory pressure ------------------------------------------------------

/*
 * Process memory means little on its own: 6 GB is fine on a 32 GB host with an
 * 8 GB heap and alarming on a 8 GB host with a 6 GB heap. So we compare against
 * both the configured heap (parsed from the launch args at sample time) and
 * what the host actually has.
 */
function memoryPressure(serverId, window, ctx, now = Date.now()) {
  const base = baseline(serverId, 'memory', window, now);
  if (!base.available) return { available: false, reason: base.reason, ...base };
  const heapRow = open().prepare(`
    SELECT heap_mb FROM metric_samples WHERE server_id = ? AND heap_mb IS NOT NULL AND ts >= ? ORDER BY ts DESC LIMIT 1
  `).get(serverId, now - WINDOWS[window].ms);
  const heapMb = heapRow ? heapRow.heap_mb : null;
  const systemTotalMb = ctx && ctx.systemTotalMb ? ctx.systemTotalMb : null;
  const systemFreeMb = ctx && ctx.systemFreeMb != null ? ctx.systemFreeMb : null;
  if (!heapMb) {
    return { available: false, reason: 'heap_unknown', baseline: base, systemTotalMb, systemFreeMb };
  }
  return {
    available: true, algoVersion: ALGO_VERSION,
    baseline: base, heapMb, systemTotalMb, systemFreeMb,
    heapRatio: base.p95 / heapMb,
    systemRatio: systemTotalMb ? base.p95 / systemTotalMb : null,
  };
}

/*
 * Parse the configured max heap out of the java args (-Xmx4G, -Xmx4096m, ...).
 * Returns null when the args do not set one, which is a legitimate answer: the
 * JVM then picks a default we cannot see from here.
 */
function parseHeapMb(javaArgs) {
  for (const arg of Array.isArray(javaArgs) ? javaArgs : []) {
    const m = /^-Xmx(\d+(?:\.\d+)?)([kmgt])?$/i.exec(String(arg).trim());
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = (m[2] || 'b').toLowerCase();
    const mb = { b: value / 1048576, k: value / 1024, m: value, g: value * 1024, t: value * 1048576 }[unit];
    return Math.round(mb);
  }
  return null;
}

// --- correlations ---------------------------------------------------------

/*
 * Association only. Two series moving together tells you where to look; it does
 * not tell you which one is driving. The UI must say so, and so does the
 * payload (`association: true`, no "cause" anywhere).
 */
function correlation(serverId, other, settings, now = Date.now()) {
  const column = { players: 'players', cpu: 'cpu' }[other];
  if (!column) throw Object.assign(new Error(`Unknown correlation series: ${other}`), { status: 400 });
  const rows = open().prepare(`
    SELECT tps, ${column} AS v FROM metric_samples
     WHERE server_id = ? AND ts >= ? AND tps IS NOT NULL AND ${column} IS NOT NULL AND ${ONLINE_SQL}
  `).all(serverId, now - WINDOWS['24h'].ms);
  if (rows.length < settings.correlationMinPairs) {
    return { available: false, reason: 'insufficient_pairs', pairs: rows.length, requiredPairs: settings.correlationMinPairs };
  }
  const r = pearson(rows.map((x) => x.tps), rows.map((x) => x.v));
  if (r === null) return { available: false, reason: 'no_variance', pairs: rows.length };
  return { available: true, association: true, series: ['tps', other], coefficient: r, pairs: rows.length, algoVersion: ALGO_VERSION };
}

// --- backup freshness -----------------------------------------------------

/*
 * Only a backup that was verified counts. An unverified zip is not a recovery
 * position; claiming otherwise is exactly the kind of false comfort this
 * feature exists to avoid.
 */
function backupFreshness(serverId, settings, now = Date.now()) {
  const row = open().prepare(`
    SELECT m.id, m.filename, m.created_at, v.verified_at
      FROM backup_manifests m
      JOIN backup_verifications v ON v.backup_id = m.id AND v.status = 'verified'
     WHERE m.server_id = ?
     ORDER BY v.verified_at DESC LIMIT 1
  `).get(serverId);
  const total = open().prepare('SELECT COUNT(*) AS n FROM backup_manifests WHERE server_id = ?').get(serverId).n;
  if (!row) return { available: true, verifiedBackup: null, backupCount: total, ageDays: null, stale: true, reason: total ? 'no_verified_backup' : 'no_backups' };
  const ageDays = (now - row.verified_at) / DAY_MS;
  return {
    available: true, backupCount: total, ageDays, stale: ageDays > settings.backupStaleDays,
    verifiedBackup: { id: row.id, filename: row.filename, createdAt: row.created_at, verifiedAt: row.verified_at },
  };
}

// --- rules ----------------------------------------------------------------

/*
 * Each rule returns null (not firing, or not enough evidence to say) or a
 * finding candidate. `evidence` is stored verbatim and must contain no paths,
 * process arguments, or anything else that could leak the host's layout.
 */
function evaluateRules(serverId, settings, ctx, now) {
  const out = [];
  const cpu = baseline(serverId, 'cpu', '1h', now);
  const memory = memoryPressure(serverId, '24h', ctx, now);
  const tps = baseline(serverId, 'tps', '24h', now);
  const forecast = diskForecast(serverId, settings, now);
  const backups = backupFreshness(serverId, settings, now);

  if (cpu.available && cpu.p95 >= settings.cpuWarnPct) {
    out.push({
      ruleId: 'cpu.sustained',
      severity: cpu.p95 >= settings.cpuCriticalPct ? 'critical' : 'warning',
      evidence: { window: '1h', p95: cpu.p95, p50: cpu.p50, iqr: cpu.iqr, sampleCount: cpu.sampleCount, coverage: cpu.coverage, threshold: settings.cpuWarnPct },
    });
  }
  if (memory.available && memory.heapRatio >= settings.memoryWarnRatio) {
    out.push({
      ruleId: 'memory.pressure',
      severity: memory.heapRatio >= settings.memoryCriticalRatio ? 'critical' : 'warning',
      evidence: {
        window: '24h', p95Mb: memory.baseline.p95, heapMb: memory.heapMb, heapRatio: memory.heapRatio,
        systemTotalMb: memory.systemTotalMb, systemFreeMb: memory.systemFreeMb,
        sampleCount: memory.baseline.sampleCount, coverage: memory.baseline.coverage, threshold: settings.memoryWarnRatio,
      },
    });
  }
  if (tps.available && tps.p10 <= settings.tpsWarn) {
    out.push({
      ruleId: 'tps.low',
      severity: tps.p10 <= settings.tpsCritical ? 'critical' : 'warning',
      evidence: { window: '24h', p10: tps.p10, p50: tps.p50, iqr: tps.iqr, sampleCount: tps.sampleCount, coverage: tps.coverage, threshold: settings.tpsWarn },
    });
  }
  if (forecast.available && forecast.daysUntilFull <= settings.diskWarnDays) {
    out.push({
      ruleId: 'disk.forecast',
      severity: forecast.daysUntilFull <= settings.diskCriticalDays ? 'critical' : 'warning',
      evidence: {
        daysUntilFull: forecast.daysUntilFull, daysUntilFullRange: forecast.daysUntilFullRange,
        growthMbPerDay: forecast.growthMbPerDay, freeMb: forecast.freeMb, totalMb: forecast.totalMb,
        fitQuality: forecast.fitQuality, sampleCount: forecast.sampleCount, coverageMs: forecast.coverageMs,
        threshold: settings.diskWarnDays,
      },
    });
  }
  if (backups.stale) {
    out.push({
      ruleId: 'backup.stale',
      severity: 'warning',
      evidence: { ageDays: backups.ageDays, backupCount: backups.backupCount, reason: backups.reason || 'stale', threshold: settings.backupStaleDays },
    });
  }
  return { findings: out, baselines: { cpu, memory, tps }, forecast, backups };
}

// --- finding lifecycle ----------------------------------------------------

/*
 * pending -> active once the rule has fired on `minOccurrences` consecutive
 * runs; active -> resolved the moment it stops firing, which starts a cooldown.
 * While the cooldown holds, a re-firing rule stays resolved (evidence is still
 * refreshed so the UI can show it is being suppressed), which is what stops a
 * borderline metric from producing an alert storm.
 */
function applyFindings(serverId, candidates, settings, now) {
  const db = open();
  const firing = new Map(candidates.map((c) => [c.ruleId, c]));
  db.transaction(() => {
    for (const ruleId of RULES) {
      const existing = db.prepare('SELECT * FROM health_alerts WHERE server_id = ? AND rule_id = ?').get(serverId, ruleId);
      const candidate = firing.get(ruleId);

      if (!candidate) {
        if (existing && existing.state !== 'resolved') {
          db.prepare('UPDATE health_alerts SET state = ?, occurrences = 0, last_seen_at = ?, cooldown_until = ? WHERE id = ?')
            .run('resolved', now, now + settings.cooldownMinutes * 60 * 1000, existing.id);
        }
        continue;
      }
      const evidence = JSON.stringify({ ...candidate.evidence, algoVersion: ALGO_VERSION });
      if (!existing) {
        const state = settings.minOccurrences <= 1 ? 'active' : 'pending';
        db.prepare(`INSERT INTO health_alerts (id, server_id, rule_id, severity, state, occurrences, first_seen_at, last_seen_at, cooldown_until, algo_version, evidence_json)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`)
          .run(crypto.randomUUID(), serverId, ruleId, candidate.severity, state, now, now, ALGO_VERSION, evidence);
        continue;
      }
      if (existing.state === 'resolved' && existing.cooldown_until && existing.cooldown_until > now) {
        db.prepare('UPDATE health_alerts SET last_seen_at = ?, severity = ?, evidence_json = ? WHERE id = ?')
          .run(now, candidate.severity, evidence, existing.id);
        continue;
      }
      const occurrences = existing.state === 'resolved' ? 1 : existing.occurrences + 1;
      const state = occurrences >= settings.minOccurrences ? 'active' : 'pending';
      const firstSeen = existing.state === 'resolved' ? now : existing.first_seen_at;
      db.prepare(`UPDATE health_alerts SET severity = ?, state = ?, occurrences = ?, first_seen_at = ?, last_seen_at = ?,
                    cooldown_until = NULL, algo_version = ?, evidence_json = ? WHERE id = ?`)
        .run(candidate.severity, state, occurrences, firstSeen, now, ALGO_VERSION, evidence, existing.id);
    }
  })();
}

function listFindings(serverId) {
  return open().prepare(`
    SELECT * FROM health_alerts WHERE server_id = ? AND state IN ('active', 'resolved') ORDER BY last_seen_at DESC
  `).all(serverId).map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    severity: row.severity,
    state: row.state,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    cooldownUntil: row.cooldown_until,
    suppressed: row.state === 'resolved' && !!row.cooldown_until && row.cooldown_until > Date.now(),
    algoVersion: row.algo_version,
    evidence: safeJson(row.evidence_json),
  })).filter((f) => f.state === 'active' || f.suppressed);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

// --- analysis -------------------------------------------------------------

/*
 * Called from the metrics sampler once per sample. Failures are contained: the
 * previous analysis row is left untouched (so its findings remain readable and
 * are reported stale), and nothing is thrown at the caller, because analysis
 * must never be able to disturb server supervision.
 */
function analyze(serverId, ctx = {}, now = Date.now()) {
  try {
    const settings = settingsFor(serverId);
    const result = evaluateRules(serverId, settings, ctx, now);
    applyFindings(serverId, result.findings, settings, now);
    for (const [metric, value] of Object.entries(result.baselines)) cacheBaseline(serverId, metric, value.window || (metric === 'cpu' ? '1h' : '24h'), value, now);
    const payload = {
      baselines: result.baselines,
      forecast: result.forecast,
      backups: result.backups,
      correlations: {
        tpsPlayers: correlation(serverId, 'players', settings, now),
        tpsCpu: correlation(serverId, 'cpu', settings, now),
      },
    };
    open().prepare(`
      INSERT INTO health_analysis (server_id, computed_at, ok, error_code, payload_json) VALUES (?, ?, 1, NULL, ?)
      ON CONFLICT(server_id) DO UPDATE SET computed_at = excluded.computed_at, ok = 1, error_code = NULL, payload_json = excluded.payload_json
    `).run(serverId, now, JSON.stringify(payload));
    return { ok: true, ...payload };
  } catch (err) {
    try {
      open().prepare('UPDATE health_analysis SET ok = 0, error_code = ? WHERE server_id = ?').run(err.code || 'analysis_failed', serverId);
    } catch { /* the database itself is unavailable; the stale marker below still applies */ }
    return { ok: false, error: err.message };
  }
}

// How long an analysis may go without refreshing before we call it stale. Two
// missed sampler ticks is enough to mean "something stopped".
const STALE_AFTER_MS = 3 * SAMPLE_INTERVAL_MS;

/*
 * The read model behind GET /api/health. Everything here comes out of the
 * database - findings are rendered from stored evidence, not recomputed - so
 * two callers always see the same numbers.
 */
function summary(serverId, now = Date.now()) {
  const row = open().prepare('SELECT * FROM health_analysis WHERE server_id = ?').get(serverId);
  const settings = settingsFor(serverId);
  if (!row) {
    return {
      serverId, algoVersion: ALGO_VERSION, settings,
      status: 'pending', stale: false, computedAt: null, analysisOk: null,
      findings: [], baselines: null, forecast: { available: false, reason: 'insufficient_samples' },
      backups: backupFreshness(serverId, settings, now), correlations: null,
    };
  }
  const payload = safeJson(row.payload_json);
  const stale = !row.ok || (now - row.computed_at) > STALE_AFTER_MS;
  return {
    serverId, algoVersion: ALGO_VERSION, settings,
    status: stale ? 'stale' : 'ok',
    stale,
    analysisOk: !!row.ok,
    errorCode: row.error_code || null,
    computedAt: row.computed_at,
    findings: listFindings(serverId),
    ...payload,
  };
}

module.exports = {
  ALGO_VERSION, DEFAULTS, WINDOWS, RULES,
  RAW_RETENTION_MS, ROLLUP_RETENTION_MS, STALE_AFTER_MS,
  settingsFor, saveSettings,
  recordSample, querySamples, runRetention, deleteServerData,
  baseline, diskForecast, memoryPressure, parseHeapMb, correlation, backupFreshness,
  analyze, summary, listFindings,
  // exported for tests
  theilSen, fitQuality, pearson, quantile,
};
