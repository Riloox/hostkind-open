'use strict';

const assert = require('assert');
const fs = require('fs');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const imports = require('../lib/imports.cjs');
const health = require('../lib/health.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
  migrations.runMigrations();
}

fresh();

const MIN = 60 * 1000;
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

let seq = 0;
const serverId = () => `srv-${++seq}`;

// Fill a server with one sample per minute over `minutes`, ending at NOW.
function seed(id, minutes, sampleOverrides = () => ({}), now = NOW) {
  for (let i = minutes - 1; i >= 0; i--) {
    const ts = now - i * MIN;
    health.recordSample({
      serverId: id, ts, online: true, cpu: 10, memoryMb: 1024, players: 3, worldMb: 100,
      tps: 20, heapMb: 4096, diskUsedMb: 50000, diskTotalMb: 100000,
      ...sampleOverrides(i, ts),
    });
  }
}

const tests = [];

// --- baselines: sufficiency gates ----------------------------------------

// Too few samples: no baseline, and an explicit reason (never a zero).
tests.push(() => {
  const id = serverId();
  seed(id, 5);
  const base = health.baseline(id, 'cpu', '1h', NOW);
  assert.strictEqual(base.available, false);
  assert.strictEqual(base.reason, 'insufficient_samples');
  assert.strictEqual(base.sampleCount, 5);
});

// Enough samples but crammed into a few minutes: coverage gate rejects it.
tests.push(() => {
  const id = serverId();
  for (let i = 0; i < 200; i++) {
    health.recordSample({ serverId: id, ts: NOW - i * 1000, online: true, cpu: 90, memoryMb: 10, players: 0, tps: 20 });
  }
  const base = health.baseline(id, 'cpu', '24h', NOW);
  assert.strictEqual(base.available, false);
  assert.strictEqual(base.reason, 'insufficient_coverage');
});

// A healthy window yields quantiles plus the uncertainty (IQR) and coverage.
tests.push(() => {
  const id = serverId();
  seed(id, 60, (i) => ({ cpu: i % 2 ? 40 : 60 }));
  const base = health.baseline(id, 'cpu', '1h', NOW);
  assert.strictEqual(base.available, true);
  assert.strictEqual(base.sampleCount, 60);
  assert.strictEqual(base.p50, 50);
  assert.strictEqual(base.iqr, 20);
  assert.ok(base.coverage > 0.9);
  assert.strictEqual(base.algoVersion, health.ALGO_VERSION);
});

// Offline samples must not drag process baselines down: a server that was down
// for half the window is not a server averaging 50% CPU.
tests.push(() => {
  const id = serverId();
  seed(id, 60, (i) => (i % 2 ? { online: false, cpu: 0, memoryMb: 0, tps: null } : { cpu: 80 }));
  const base = health.baseline(id, 'cpu', '1h', NOW);
  assert.strictEqual(base.sampleCount, 30, 'only online samples count');
  assert.strictEqual(base.p50, 80);
});

// --- gaps are gaps --------------------------------------------------------

// Downtime, a sleeping host, or a collection failure leaves a hole. The window
// must report the hole (via sample count / coverage), never fill it in.
tests.push(() => {
  const id = serverId();
  seed(id, 30);                       // last 30 minutes
  seed(id, 30, () => ({}), NOW - 12 * 3600 * 1000); // and 30 minutes half a day ago
  const base = health.baseline(id, 'cpu', '24h', NOW);
  assert.strictEqual(base.available, false, '60 samples is not a 24h baseline');
  assert.strictEqual(base.reason, 'insufficient_samples');
  const points = health.querySamples(id, { since: NOW - DAY, until: NOW });
  assert.strictEqual(points.length, 60, 'no interpolated samples');
});

// A clock jump backwards must not create a negative-width window or duplicate
// rows; the (server, ts) key absorbs the repeat.
tests.push(() => {
  const id = serverId();
  assert.strictEqual(health.recordSample({ serverId: id, ts: NOW, online: true, cpu: 10 }), true);
  health.recordSample({ serverId: id, ts: NOW, online: true, cpu: 99 });
  const rows = health.querySamples(id, { since: NOW - MIN, until: NOW + MIN });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].cpu, 10, 'first write wins; the replay is ignored');
  assert.strictEqual(health.recordSample({ serverId: id, ts: NaN }), false, 'invalid timestamp rejected');
  assert.strictEqual(health.recordSample({ serverId: id, ts: -5 }), false);
});

// Physically impossible values are dropped rather than stored.
tests.push(() => {
  const id = serverId();
  health.recordSample({ serverId: id, ts: NOW, online: true, cpu: 4000, memoryMb: -3, tps: 1e9 });
  const row = health.querySamples(id, { since: NOW - MIN })[0];
  assert.strictEqual(row.cpu, null);
  assert.strictEqual(row.mem, null);
  assert.strictEqual(row.tps, null);
});

// A metric the server did not report stays absent. Coercing it would turn "no
// TPS reading" into "a TPS reading of zero", which is a fabricated sample - and
// one that would trip the low-TPS rule on every offline server.
tests.push(() => {
  const id = serverId();
  health.recordSample({ serverId: id, ts: NOW, online: false, cpu: 0, memoryMb: 0, players: 0, tps: null, heapMb: undefined, diskTotalMb: null });
  const row = health.querySamples(id, { since: NOW - MIN })[0];
  assert.strictEqual(row.tps, null, 'an unreported TPS is null, not 0');
  assert.strictEqual(row.heap, null);
  assert.strictEqual(row.diskTotal, null);
  assert.strictEqual(row.cpu, 0, 'a genuine zero is still a zero');

  // And it must not be picked up as a TPS reading by the analyzer.
  for (let i = 0; i < 400; i++) health.recordSample({ serverId: id, ts: NOW - i * MIN, online: false, cpu: 0, memoryMb: 0, tps: null });
  const base = health.baseline(id, 'tps', '24h', NOW);
  assert.strictEqual(base.available, false);
  assert.strictEqual(base.sampleCount, 0, 'no TPS samples means no TPS baseline');
});

// --- disk forecast: the "omit rather than guess" gates ---------------------

// Flat disk usage: no growth, so no forecast - and explicitly not "0 days".
tests.push(() => {
  const id = serverId();
  seed(id, 4000, () => ({ diskUsedMb: 50000 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.reason, 'no_growth');
  assert.ok(!('daysUntilFull' in f) || f.daysUntilFull === undefined || f.available === false);
});

// Declining usage (someone cleaned up): still no forecast.
tests.push(() => {
  const id = serverId();
  // `i` counts down as time moves forward, so `+ i` is a falling series.
  seed(id, 4000, (i) => ({ diskUsedMb: 50000 + i * 0.5 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.reason, 'no_growth');
});

// Pure noise around a constant: the robust fit quality gate rejects it.
tests.push(() => {
  const id = serverId();
  let x = 1;
  const rand = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  seed(id, 4000, () => ({ diskUsedMb: 50000 + (rand() - 0.5) * 4000 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.ok(['poor_fit', 'no_growth'].includes(f.reason), `unexpected reason ${f.reason}`);
});

// Not enough coverage, even with plenty of samples: no forecast.
tests.push(() => {
  const id = serverId();
  seed(id, 300, (i) => ({ diskUsedMb: 50000 + (300 - i) * 10 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.reason, 'insufficient_coverage');
});

// Capacity unknown (statfs failed): no "full" to forecast towards.
tests.push(() => {
  const id = serverId();
  seed(id, 4000, (i) => ({ diskUsedMb: 50000 + (4000 - i) * 2, diskTotalMb: null }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.reason, 'capacity_unavailable');
});

// Steady growth with a known capacity: a forecast, with an uncertainty band.
tests.push(() => {
  const id = serverId();
  // 4000 minutes (~2.8 days) climbing 1 MB/min = 1440 MB/day, 50 GB free.
  seed(id, 4000, (i) => ({ diskUsedMb: 50000 + (4000 - i) * 1 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, true, `expected a forecast, got ${f.reason}`);
  assert.ok(Math.abs(f.growthMbPerDay - 1440) < 50, `growth ${f.growthMbPerDay}`);
  assert.ok(Math.abs(f.daysUntilFull - 46000 / 1440) < 2, `days ${f.daysUntilFull}`);
  assert.ok(f.fitQuality >= health.DEFAULTS.forecastMinFitQuality);
  assert.strictEqual(f.daysUntilFullRange.length, 2);
});

// A forecast beyond the horizon is not shown either - "full in 4 years" is noise.
tests.push(() => {
  const id = serverId();
  seed(id, 4000, (i) => ({ diskUsedMb: 50000 + (4000 - i) * 0.001 }));
  const f = health.diskForecast(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.reason, 'beyond_horizon');
});

// --- heap parsing ---------------------------------------------------------

tests.push(() => {
  assert.strictEqual(health.parseHeapMb(['-Xmx4G', '-Xms2G']), 4096);
  assert.strictEqual(health.parseHeapMb(['-Xmx4096m']), 4096);
  assert.strictEqual(health.parseHeapMb(['-Xmx2g']), 2048);
  assert.strictEqual(health.parseHeapMb(['-Xmx1t']), 1048576);
  assert.strictEqual(health.parseHeapMb(['-Xmx2097152k']), 2048);
  assert.strictEqual(health.parseHeapMb(['-XX:+UseG1GC']), null, 'no -Xmx means we do not know');
  assert.strictEqual(health.parseHeapMb([]), null);
  assert.strictEqual(health.parseHeapMb(undefined), null);
  assert.strictEqual(health.parseHeapMb(['-Xmx0G']), null, 'a zero heap is not a heap');
});

// Memory pressure needs a known heap; without one it reports why, not a ratio.
tests.push(() => {
  const id = serverId();
  seed(id, 800, () => ({ heapMb: null, memoryMb: 3800 }));
  const m = health.memoryPressure(id, '24h', { systemTotalMb: 8192, systemFreeMb: 512 }, NOW);
  assert.strictEqual(m.available, false);
  assert.strictEqual(m.reason, 'heap_unknown');

  const id2 = serverId();
  seed(id2, 800, () => ({ heapMb: 4096, memoryMb: 3900 }));
  const m2 = health.memoryPressure(id2, '24h', { systemTotalMb: 8192, systemFreeMb: 512 }, NOW);
  assert.strictEqual(m2.available, true);
  assert.ok(m2.heapRatio > 0.9);
  assert.ok(m2.systemRatio > 0.4, 'system availability is part of the picture');
});

// --- correlations ---------------------------------------------------------

// Too few overlapping pairs: no coefficient.
tests.push(() => {
  const id = serverId();
  seed(id, 10);
  const c = health.correlation(id, 'players', health.DEFAULTS, NOW);
  assert.strictEqual(c.available, false);
  assert.strictEqual(c.reason, 'insufficient_pairs');
});

// Constant series have no variance; a coefficient there would be pure noise.
tests.push(() => {
  const id = serverId();
  seed(id, 200, () => ({ tps: 20, players: 4 }));
  const c = health.correlation(id, 'players', health.DEFAULTS, NOW);
  assert.strictEqual(c.available, false);
  assert.strictEqual(c.reason, 'no_variance');
});

// Real covariance: report the association, and say that is what it is.
tests.push(() => {
  const id = serverId();
  seed(id, 200, (i) => ({ players: i % 20, tps: 20 - (i % 20) * 0.4 }));
  const c = health.correlation(id, 'players', health.DEFAULTS, NOW);
  assert.strictEqual(c.available, true);
  assert.strictEqual(c.association, true);
  assert.ok(c.coefficient < -0.9, `expected strong negative association, got ${c.coefficient}`);
  assert.ok(c.pairs >= health.DEFAULTS.correlationMinPairs);
});

// --- backup freshness -----------------------------------------------------

// Only verified backups count. An unverified zip is not a recovery position.
tests.push(() => {
  const id = serverId();
  const db = open();
  const fresh0 = health.backupFreshness(id, health.DEFAULTS, NOW);
  assert.strictEqual(fresh0.stale, true);
  assert.strictEqual(fresh0.reason, 'no_backups');

  db.prepare('INSERT INTO backup_manifests VALUES (?,?,?,?,?,?,?,?)')
    .run('b1', id, `${id}.zip`, 10, 'sha', NOW - 2 * DAY, '[]', '[]');
  const unverified = health.backupFreshness(id, health.DEFAULTS, NOW);
  assert.strictEqual(unverified.stale, true);
  assert.strictEqual(unverified.reason, 'no_verified_backup');

  db.prepare('INSERT INTO backup_verifications VALUES (?,?,?,?,?,?,?,?)')
    .run('v1', 'b1', null, 'verified', 1, 'sha', NOW - 2 * DAY, null);
  const ok = health.backupFreshness(id, health.DEFAULTS, NOW);
  assert.strictEqual(ok.stale, false);
  assert.ok(Math.abs(ok.ageDays - 2) < 0.01);

  const old = health.backupFreshness(id, health.DEFAULTS, NOW + 10 * DAY);
  assert.strictEqual(old.stale, true, 'a 12-day-old verification is stale at a 7-day threshold');
});

// A failed verification does not count as a backup.
tests.push(() => {
  const id = serverId();
  const db = open();
  db.prepare('INSERT INTO backup_manifests VALUES (?,?,?,?,?,?,?,?)')
    .run('b2', id, `${id}.zip`, 10, 'sha', NOW - DAY, '[]', '[]');
  db.prepare('INSERT INTO backup_verifications VALUES (?,?,?,?,?,?,?,?)')
    .run('v2', 'b2', null, 'failed', 0, null, NOW - DAY, 'invalid_archive');
  const f = health.backupFreshness(id, health.DEFAULTS, NOW);
  assert.strictEqual(f.stale, true);
  assert.strictEqual(f.reason, 'no_verified_backup');
});

// --- finding lifecycle: persistence, dedupe, cooldown ---------------------

tests.push(() => {
  const id = serverId();
  seed(id, 90, () => ({ cpu: 99 }));
  const ctx = { systemTotalMb: 8192, systemFreeMb: 4096 };

  // First run: the rule fires but has not persisted yet, so nothing surfaces.
  health.analyze(id, ctx, NOW);
  let cpuFinding = health.listFindings(id).find((f) => f.ruleId === 'cpu.sustained');
  assert.strictEqual(cpuFinding, undefined, 'a single observation is not a finding');

  // Second consecutive run: now it is real.
  health.analyze(id, ctx, NOW + MIN);
  cpuFinding = health.listFindings(id).find((f) => f.ruleId === 'cpu.sustained');
  assert.ok(cpuFinding, 'finding surfaces after persisting');
  assert.strictEqual(cpuFinding.state, 'active');
  assert.strictEqual(cpuFinding.severity, 'critical');
  assert.strictEqual(cpuFinding.evidence.p95, 99);
  assert.strictEqual(cpuFinding.evidence.algoVersion, health.ALGO_VERSION);

  // Re-running does not duplicate it.
  health.analyze(id, ctx, NOW + 2 * MIN);
  assert.strictEqual(health.listFindings(id).filter((f) => f.ruleId === 'cpu.sustained').length, 1);

  // CPU recovers: the finding resolves and enters cooldown.
  const calm = serverId();
  seed(calm, 90, () => ({ cpu: 5 }));
  const db = open();
  db.prepare('UPDATE metric_samples SET cpu = 5 WHERE server_id = ?').run(id);
  health.analyze(id, ctx, NOW + 3 * MIN);
  const resolved = db.prepare("SELECT * FROM health_alerts WHERE server_id = ? AND rule_id = 'cpu.sustained'").get(id);
  assert.strictEqual(resolved.state, 'resolved');
  assert.ok(resolved.cooldown_until > NOW + 3 * MIN);

  // It spikes again inside the cooldown: suppressed, not re-raised.
  db.prepare('UPDATE metric_samples SET cpu = 99 WHERE server_id = ?').run(id);
  health.analyze(id, ctx, NOW + 4 * MIN);
  health.analyze(id, ctx, NOW + 5 * MIN);
  const during = db.prepare("SELECT * FROM health_alerts WHERE server_id = ? AND rule_id = 'cpu.sustained'").get(id);
  assert.strictEqual(during.state, 'resolved', 'cooldown suppresses the re-fire');

  // Once the cooldown lapses it can persist and surface again. The 1-hour CPU
  // window has moved on by then, so it needs samples of its own.
  const after = NOW + 4 * MIN + health.DEFAULTS.cooldownMinutes * 60 * 1000;
  seed(id, 60, () => ({ cpu: 99 }), after);
  health.analyze(id, ctx, after);
  health.analyze(id, ctx, after + MIN);
  const again = health.listFindings(id).find((f) => f.ruleId === 'cpu.sustained');
  assert.ok(again && again.state === 'active', 'the finding can return after the cooldown');
});

// A server with no data produces no findings at all - not "healthy", pending.
tests.push(() => {
  const id = serverId();
  const s = health.summary(id, NOW);
  assert.strictEqual(s.status, 'pending');
  assert.deepStrictEqual(s.findings, []);
  assert.strictEqual(s.forecast.available, false);
});

// --- stale analysis -------------------------------------------------------

// An analysis that has not refreshed is reported stale; the previous findings
// stay readable rather than silently disappearing.
tests.push(() => {
  const id = serverId();
  seed(id, 90, () => ({ cpu: 99 }));
  health.analyze(id, {}, NOW);
  health.analyze(id, {}, NOW + MIN);
  assert.strictEqual(health.summary(id, NOW + MIN).status, 'ok');

  const late = NOW + MIN + health.STALE_AFTER_MS + 1;
  const stale = health.summary(id, late);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.status, 'stale');
  assert.ok(stale.findings.length >= 1, 'stale does not mean empty');
});

// An analysis failure marks the last result stale and never throws at the caller.
tests.push(() => {
  const id = serverId();
  seed(id, 90, () => ({ cpu: 99 }));
  health.analyze(id, {}, NOW);
  health.analyze(id, {}, NOW + MIN);

  const db = open();
  db.exec('ALTER TABLE metric_samples RENAME TO metric_samples_hidden');
  const result = health.analyze(id, {}, NOW + 2 * MIN); // must not throw
  db.exec('ALTER TABLE metric_samples_hidden RENAME TO metric_samples');

  assert.strictEqual(result.ok, false);
  const s = health.summary(id, NOW + 2 * MIN);
  assert.strictEqual(s.analysisOk, false);
  assert.strictEqual(s.stale, true);
  assert.ok(s.findings.length >= 1, 'the prior findings survive a failed run');
});

// --- settings -------------------------------------------------------------

tests.push(() => {
  const id = serverId();
  assert.strictEqual(health.settingsFor(id).cpuWarnPct, health.DEFAULTS.cpuWarnPct);
  const saved = health.saveSettings(id, { cpuWarnPct: 70 }, 'admin-1');
  assert.strictEqual(saved.cpuWarnPct, 70);
  assert.strictEqual(saved.cpuCriticalPct, health.DEFAULTS.cpuCriticalPct, 'unset keys keep their defaults');
  assert.strictEqual(health.settingsFor(id).cpuWarnPct, 70);

  assert.throws(() => health.saveSettings(id, { cpuWarnPct: 900 }, 'a'), /between/);
  assert.throws(() => health.saveSettings(id, { cpuWarnPct: 'lots' }, 'a'), /number/);
  assert.throws(() => health.saveSettings(id, { cpuCriticalPct: 10 }, 'a'), /below/, 'critical below warn is incoherent');
  health.saveSettings(id, { unknownKey: 5 }, 'a');
  assert.strictEqual(health.settingsFor(id).unknownKey, undefined, 'unknown keys are ignored');

  // A lowered threshold takes effect on the next analysis.
  seed(id, 90, () => ({ cpu: 75 }));
  health.analyze(id, {}, NOW);
  health.analyze(id, {}, NOW + MIN);
  assert.ok(health.listFindings(id).some((f) => f.ruleId === 'cpu.sustained'), '75% CPU trips a 70% threshold');
});

// --- retention ------------------------------------------------------------

// Raw samples past the horizon fold into hourly rollups and then leave; the
// long window still reads correctly afterwards, and the database stays bounded.
tests.push(() => {
  const id = serverId();
  const old = NOW - 20 * DAY;
  for (let i = 0; i < 240; i++) {
    health.recordSample({ serverId: id, ts: old + i * MIN, online: true, cpu: 50, memoryMb: 1000, players: 2, worldMb: 10, tps: 19.5, diskUsedMb: 100, diskTotalMb: 1000 });
  }
  seed(id, 60);
  const db = open();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metric_samples WHERE server_id = ?').get(id).n, 300);

  const r1 = health.runRetention(NOW);
  assert.ok(r1.pruned >= 240, 'aged raw samples pruned');
  const rollups = db.prepare('SELECT * FROM metric_rollups WHERE server_id = ? ORDER BY bucket_ts').all(id);
  assert.strictEqual(rollups.length, 4, '240 minutes -> 4 hourly buckets');
  assert.strictEqual(rollups[0].sample_count, 60);
  assert.strictEqual(rollups[0].cpu_avg, 50);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metric_samples WHERE server_id = ?').get(id).n, 60, 'recent raw samples kept');

  // Idempotent: a second pass changes nothing.
  const r2 = health.runRetention(NOW);
  assert.strictEqual(r2.pruned, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metric_rollups WHERE server_id = ?').get(id).n, 4);

  // The rolled-up history is still readable through the normal query path.
  const points = health.querySamples(id, { since: NOW - 30 * DAY, until: NOW });
  assert.ok(points.some((p) => p.rollup), 'rollups back-fill the aged part of the range');
  assert.ok(points.some((p) => !p.rollup), 'recent raw samples are still there');

  // Rollups past their own horizon expire.
  const r3 = health.runRetention(NOW + 100 * DAY);
  assert.ok(r3.expired >= 4);
});

// A bounded page size protects the API from an unbounded range.
tests.push(() => {
  const id = serverId();
  seed(id, 3000);
  const points = health.querySamples(id, { since: 0, until: NOW, limit: 10 ** 9 });
  assert.ok(points.length <= 5000);
  const small = health.querySamples(id, { since: NOW - 3000 * MIN, until: NOW, limit: 100 });
  assert.ok(small.length <= 101, `expected <= 101 points, got ${small.length}`);
  assert.strictEqual(small[small.length - 1].t, NOW, 'the newest point survives downsampling');
});

// --- evidence hygiene -----------------------------------------------------

// Evidence is numbers and rule ids only: no paths, no process arguments.
tests.push(() => {
  const id = serverId();
  seed(id, 90, () => ({ cpu: 99 }));
  health.analyze(id, {}, NOW);
  health.analyze(id, {}, NOW + MIN);
  const text = JSON.stringify(health.listFindings(id));
  assert.ok(!/[/\\](?:home|Users|opt|srv)[/\\]/.test(text), 'no filesystem paths in evidence');
  assert.ok(!/-Xmx|java|\.jar/i.test(text), 'no process arguments in evidence');
});

// --- import interop -------------------------------------------------------

/*
 * imports.METRICS_PATH points at the real metrics.json next to server.js, so
 * these two tests stash whatever is there and put it back afterwards. The
 * import is only allowed to read that file - if a test ever leaves it changed,
 * that is itself the bug we are checking for.
 */
const REAL_METRICS = fs.existsSync(imports.METRICS_PATH) ? fs.readFileSync(imports.METRICS_PATH) : null;
function restoreMetricsFile() {
  if (REAL_METRICS === null) { try { fs.unlinkSync(imports.METRICS_PATH); } catch { /* */ } }
  else fs.writeFileSync(imports.METRICS_PATH, REAL_METRICS);
}

// The one-shot metrics.json import stays idempotent against the new columns:
// re-running it neither duplicates rows nor rewrites the file.
tests.push(() => {
  const legacy = {};
  const id = 'legacy-import';
  legacy[id] = [];
  for (let i = 0; i < 100; i++) legacy[id].push([NOW - i * MIN, 42, 900, 2, 30]);
  fs.writeFileSync(imports.METRICS_PATH, JSON.stringify(legacy));
  const before = fs.readFileSync(imports.METRICS_PATH, 'utf8');
  try {
    const first = imports.importLegacyMetrics({ force: true });
    assert.strictEqual(first.summary.imported, 100);
    const db = open();
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metric_samples WHERE server_id = ?').get(id).n, 100);

    const second = imports.importLegacyMetrics({ force: true });
    assert.strictEqual(second.summary.imported, 0, 'a re-run inserts nothing new');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metric_samples WHERE server_id = ?').get(id).n, 100);
    assert.strictEqual(fs.readFileSync(imports.METRICS_PATH, 'utf8'), before, 'metrics.json is never rewritten');
    assert.ok(fs.existsSync(imports.METRICS_PATH), 'metrics.json is never deleted');

    // Imported rows have no `online` flag; they fall back to "the JVM had memory".
    const base = health.baseline(id, 'cpu', '24h', NOW);
    assert.strictEqual(base.available, false, '100 samples is not a 24h baseline');
    assert.strictEqual(base.sampleCount, 100, 'but legacy rows are still counted');
  } finally {
    restoreMetricsFile();
  }
});

// A corrupt metrics.json must not take the panel down.
tests.push(() => {
  fs.writeFileSync(imports.METRICS_PATH, '{ not json');
  try {
    assert.throws(() => imports.importLegacyMetrics({ force: true }), /JSON/);
    assert.ok(fs.existsSync(imports.METRICS_PATH), 'the corrupt file is left alone for the operator');
  } finally {
    restoreMetricsFile();
  }
});

// --- server deletion ------------------------------------------------------

tests.push(() => {
  const id = serverId();
  seed(id, 90, () => ({ cpu: 99 }));
  health.analyze(id, {}, NOW);
  health.analyze(id, {}, NOW + MIN);
  health.saveSettings(id, { cpuWarnPct: 50 }, 'admin');
  health.deleteServerData(id);
  const db = open();
  for (const table of ['metric_samples', 'metric_rollups', 'health_baselines', 'health_alerts', 'health_analysis', 'health_settings']) {
    assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE server_id = ?`).get(id).n, 0, `${table} cleaned`);
  }
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  health test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  health test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} health test(s) failed`); process.exit(1); }
console.log('PASS  health');
