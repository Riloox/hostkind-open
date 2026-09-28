'use strict';

/*
 * src/lib/overview.js: what a server's Overview puts in Needs attention, how
 * each KPI reads against the server's own normal, and the facts line.
 *
 * overview.js is browser ESM in a CommonJS package, so it is copied to a
 * temporary .mjs and imported from there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadOverview() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'overview.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-overview-'));
  const file = path.join(dir, 'overview.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const {
    buildAttentionItems, gameUpdateReady, cpuReading, tpsTone, pickKpis, latestBackupAt, nextScheduled,
    attentionSummary,
  } = await loadOverview();
  const ids = (items) => items.map((item) => item.id);

  // --- Needs attention ------------------------------------------------------
  assert.deepStrictEqual(buildAttentionItems({ serverId: 's1', running: true }), []);
  console.log('ok  a healthy server has nothing to show');

  const staleBackup = { id: 'f1', ruleId: 'backup.stale', severity: 'warning', state: 'active', lastSeenAt: 50 };
  const crash = { id: 'g1', serverId: 's1', category: 'java', count: 3, lastSeenAt: 100 };
  const items = buildAttentionItems({
    serverId: 's1',
    running: true,
    findings: [
      staleBackup,
      { id: 'f2', ruleId: 'disk.forecast', severity: 'critical', state: 'active', lastSeenAt: 10 },
      { id: 'f3', ruleId: 'cpu.sustained', severity: 'warning', state: 'resolved', suppressed: true },
    ],
    crashes: [crash, { id: 'g2', serverId: 's1', acknowledgedAt: 5, lastSeenAt: 200 }],
    contentUpdates: 3,
  });
  assert.deepStrictEqual(ids(items), ['crash:g1', 'finding:f2', 'finding:f1', 'content-updates']);
  assert.deepStrictEqual(items.map((item) => item.action), ['crash', 'backups', 'backup', 'mods']);
  assert.strictEqual(items[3].count, 3);
  console.log('ok  critical before warning before notice; acknowledged and suppressed items stay out');

  const newestFirst = buildAttentionItems({
    serverId: 's1',
    crashes: [{ id: 'old', lastSeenAt: 1 }, { id: 'new', lastSeenAt: 9 }],
    running: true,
  });
  assert.deepStrictEqual(ids(newestFirst), ['crash:new', 'crash:old']);
  console.log('ok  newest first within a severity');

  assert.deepStrictEqual(
    ids(buildAttentionItems({ serverId: 's1', crashes: [{ id: 'x', serverId: 's2', lastSeenAt: 1 }] })),
    [],
  );
  console.log('ok  another server\'s crash is not this server\'s problem');

  const tps = { id: 't', ruleId: 'tps.low', severity: 'warning', state: 'active' };
  assert.deepStrictEqual(ids(buildAttentionItems({ serverId: 's1', findings: [tps], tracksTps: false })), []);
  assert.deepStrictEqual(ids(buildAttentionItems({ serverId: 's1', findings: [tps] })), ['finding:t']);
  assert.strictEqual(buildAttentionItems({ serverId: 's1', findings: [tps] })[0].action, 'details');
  console.log('ok  a TPS finding only shows for servers that report TPS');

  const never = buildAttentionItems({ serverId: 's1', hasGenerated: false, running: false });
  assert.deepStrictEqual(never.map((item) => [item.id, item.action]), [['first-start', 'start']]);
  assert.deepStrictEqual(buildAttentionItems({ serverId: 's1', hasGenerated: false, running: true }), []);
  console.log('ok  a never-started server asks to be started once, until it is starting');

  const watchdog = [
    { id: 'n1', type: 'watchdog_limit', serverId: 's1', read: false, timestamp: 10 },
    { id: 'n2', type: 'watchdog_limit', serverId: 's1', read: false, timestamp: 20 },
    { id: 'n3', type: 'watchdog_limit', serverId: 's2', read: false, timestamp: 30 },
    { id: 'n4', type: 'watchdog_restart', serverId: 's1', read: false, timestamp: 40 },
  ];
  const limited = buildAttentionItems({ serverId: 's1', running: false, notifications: watchdog });
  assert.deepStrictEqual(limited.map((item) => [item.id, item.action]), [['watchdog:n2', 'console']]);
  assert.deepStrictEqual(buildAttentionItems({ serverId: 's1', running: true, notifications: watchdog }), []);
  assert.deepStrictEqual(
    buildAttentionItems({ serverId: 's1', notifications: watchdog.map((n) => ({ ...n, read: true })) }),
    [],
  );
  console.log('ok  one watchdog item while the server stays down and the notice is unread');

  assert.deepStrictEqual(ids(buildAttentionItems({ serverId: 's1', running: true, gameUpdate: true })), ['game-update']);
  assert.strictEqual(gameUpdateReady({ state: 'update-ready' }), true);
  for (const state of ['current', 'stale', 'verification-stale', 'installed-unknown', 'unavailable']) {
    assert.strictEqual(gameUpdateReady({ state }), false, state);
  }
  assert.strictEqual(gameUpdateReady(null), false);
  console.log('ok  a game build update counts only when one is ready to install');

  // --- KPIs -----------------------------------------------------------------
  const baseline = { available: true, p50: 20, p95: 40 };
  assert.deepStrictEqual(cpuReading(null, baseline), { tone: 'neutral', state: null });
  assert.deepStrictEqual(cpuReading(35, baseline), { tone: 'neutral', state: 'normal' });
  assert.deepStrictEqual(cpuReading(60, baseline), { tone: 'warn', state: 'high' });
  assert.deepStrictEqual(cpuReading(90, baseline), { tone: 'error', state: 'high' });
  assert.deepStrictEqual(cpuReading(60, { available: false }), { tone: 'neutral', state: 'learning' });
  assert.deepStrictEqual(cpuReading(90, null), { tone: 'error', state: 'high' });
  console.log('ok  CPU is coloured only above this server\'s normal or above 85%');

  assert.strictEqual(tpsTone(20), 'neutral');
  assert.strictEqual(tpsTone(18), 'warn');
  assert.strictEqual(tpsTone(12), 'error');
  assert.strictEqual(tpsTone(null), 'neutral');
  console.log('ok  TPS keeps the 19 / 15 thresholds');

  assert.deepStrictEqual(pickKpis({ tracksPlayers: true, tracksTps: true, tps: 20 }), ['status', 'players', 'cpu', 'memory']);
  assert.deepStrictEqual(pickKpis({ tracksPlayers: true, tracksTps: true, tps: 14 }), ['status', 'players', 'performance', 'memory']);
  assert.deepStrictEqual(pickKpis({ tracksPlayers: false, tracksTps: false }), ['status', 'cpu', 'memory']);
  console.log('ok  Status first, Performance replaces CPU only while lagging');

  // --- Facts line -----------------------------------------------------------
  assert.strictEqual(latestBackupAt([]), null);
  assert.strictEqual(latestBackupAt([{ mtime: 5 }, { mtime: 9 }, { mtime: 7 }]), 9);
  console.log('ok  last backup is the newest archive');

  const now = Date.parse('2026-09-26T12:00:00Z');
  const at = (iso) => ({ at: iso });
  const tasks = [
    { id: 'a', serverId: 's1', enabled: true, preview: { next: [at('2026-09-27T04:00:00Z')] } },
    { id: 'b', serverId: 's1', enabled: false, preview: { next: [at('2026-09-26T13:00:00Z')] } },
    { id: 'c', serverId: 's2', enabled: true, preview: { next: [at('2026-09-26T12:30:00Z')] } },
    { id: 'd', serverId: 's1', preview: { next: [at('2026-09-26T11:00:00Z'), at('2026-09-26T18:00:00Z')] } },
    { id: 'e', serverId: 's1', enabled: true, preview: { next: [], condition: 'When any player joins' } },
  ];
  const next = nextScheduled(tasks, 's1', now);
  assert.strictEqual(next.task.id, 'd');
  assert.strictEqual(next.at, Date.parse('2026-09-26T18:00:00Z'));
  assert.strictEqual(nextScheduled(tasks, 's3', now), null);
  console.log('ok  next schedule skips paused, other servers\' and past runs');

  // --- All-servers row ------------------------------------------------------
  assert.deepStrictEqual(attentionSummary([]), { count: 0, critical: false, backupStale: false });
  assert.deepStrictEqual(attentionSummary(undefined), { count: 0, critical: false, backupStale: false });
  assert.deepStrictEqual(attentionSummary(items), { count: 4, critical: true, backupStale: true });
  assert.deepStrictEqual(
    attentionSummary(buildAttentionItems({ serverId: 's1', running: true, contentUpdates: 2 })),
    { count: 1, critical: false, backupStale: false },
  );
  console.log('ok  a server row counts its items and flags a stale backup');

  console.log('PASS  overview');
})().catch((err) => { console.error(err); process.exitCode = 1; });
