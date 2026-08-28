'use strict';

const assert = require('assert');
const { EVENT_TYPES, sanitizeEvent, summarizeEvents, createRecorder } = require('../lib/product-validation.cjs');

assert.deepStrictEqual(EVENT_TYPES, [
  'first_playable', 'manifest_exported', 'manifest_imported', 'byoc_target_created',
  'pairing_completed', 'restore_verified', 'restore_drill_succeeded', 'pricing_interest', 'byoc_beta_requested',
]);
const raw = {
  type: 'first_playable', serverId: 'srv-1', game: 'minecraft', plan: 'local', source: 'beta', value: 1, occurredAt: 1000,
  username: 'alice', password: 'secret', token: 'secret', path: 'C:\\Users\\alice', description: 'private', unknown: 'drop',
};
const safe = sanitizeEvent(raw);
assert.deepStrictEqual(safe, { type: 'first_playable', serverId: 'srv-1', game: 'minecraft', plan: 'local', source: 'beta', value: 1, occurredAt: 1000 });
assert.strictEqual(sanitizeEvent({ type: 'not-an-event', occurredAt: 1000 }).type, undefined);
assert.strictEqual(sanitizeEvent({ type: 'pricing_interest', value: 'not-a-number', occurredAt: 1000 }).value, undefined);

const received = [];
const recorder = createRecorder({ now: () => 5000, sink: (event) => received.push(event) });
const recorded = recorder.record({ type: 'byoc_beta_requested', serverId: 'srv-1', source: 'landing', occurredAt: 2000, password: 'never' });
assert.strictEqual(recorded.type, 'byoc_beta_requested');
assert.strictEqual(recorded.occurredAt, 2000);
assert.deepStrictEqual(received, [recorded]);
assert.deepStrictEqual(recorder.all(), [recorded]);

const events = [
  { type: 'first_playable', serverId: 'srv-1', occurredAt: 100 },
  { type: 'byoc_beta_requested', serverId: 'srv-1', occurredAt: 200 },
  { type: 'pricing_interest', serverId: 'srv-1', occurredAt: 300 },
  { type: 'first_playable', serverId: 'srv-2', occurredAt: 400 },
  { type: 'pricing_interest', serverId: 'srv-2', occurredAt: 500 },
];
const summary = summarizeEvents(events, { from: 100, to: 300 });
assert.strictEqual(summary.counts.first_playable, 1);
assert.strictEqual(summary.counts.byoc_beta_requested, 1);
assert.strictEqual(summary.counts.pricing_interest, 1);
assert.deepStrictEqual(summary.funnel, {
  firstPlayable: 1,
  byocBetaRequested: 1,
  pricingInterest: 1,
  firstToByoc: 1,
  byocToPricing: 1,
});
console.log('PASS product-validation');
