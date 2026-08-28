'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const { open, close } = require('../lib/db.cjs');
const store = require('../lib/product-store.cjs');

(async function main() {
  migrations.runMigrations();
  try {
    const target = store.createTarget({
      name: 'Primary', provider: 'hetzner', endpoint: 'https://vps.example.test',
      region: 'fsn1', resourceTier: 'cx33', secretRef: 'HOSTKIND_BYOC_PRIMARY',
    }, { now: 1000, id: 'target-1' });
    assert.strictEqual(target.id, 'target-1');
    assert.strictEqual(store.listTargets()[0].status, 'pending');
    assert.strictEqual(store.updateTarget('target-1', 'ready', { now: 1100 }).status, 'ready');

    const challenge = store.createPairing({ targetId: 'target-1', actorId: 'admin-1' }, { now: 1200, id: 'challenge-1' });
    assert.ok(challenge.token);
    const storedChallenge = open().prepare('SELECT token_hash FROM pairing_challenges WHERE id=?').get('challenge-1');
    assert.ok(storedChallenge);
    assert.notStrictEqual(storedChallenge.token_hash, challenge.token);
    const pairing = store.consumePairing({ id: challenge.id, token: challenge.token }, { now: 1201 });
    assert.strictEqual(pairing.ok, true);
    assert.ok(pairing.agentId);

    const drill = store.recordRestoreDrill({
      backupId: 'backup-1', target: 'drill-1', status: 'succeeded',
      startedAt: 1250, completedAt: 1260, expectedCount: 1, actualCount: 1,
      diff: { ok: true, missing: [], unexpected: [], changed: [] },
    }, { now: 1260, id: 'drill-1' });
    assert.strictEqual(drill.status, 'succeeded');
    assert.throws(() => store.recordRestoreDrill({
      backupId: 'backup-2', target: 'drill-1', status: 'failed',
      expectedCount: 1, actualCount: 1,
      diff: { ok: false, missing: ['..\\evil'], unexpected: [], changed: [] },
    }, { now: 1261, id: 'drill-2' }), /unsafe path/);

    const event = store.recordEvent({ type: 'first_playable', serverId: 'srv-1', game: 'minecraft', source: 'beta', occurredAt: 1300, password: 'drop' });
    assert.strictEqual(event.type, 'first_playable');
    const summary = store.summaryEvents({ from: 1000, to: 1400 });
    assert.strictEqual(summary.counts.byoc_target_created, 1);
    assert.strictEqual(summary.counts.pairing_completed, 1);
    assert.strictEqual(summary.counts.first_playable, 1);
    assert.strictEqual(summary.counts.restore_drill_succeeded, 1);
    const storedEvent = open().prepare('SELECT * FROM product_events').get();
    assert.ok(storedEvent);
    assert.doesNotMatch(JSON.stringify(storedEvent), /drop/);
    console.log('PASS product-store');
  } finally {
    close();
    teardown();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
