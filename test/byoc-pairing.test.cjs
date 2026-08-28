'use strict';

const assert = require('assert');
const { PROVIDERS, STATUSES, validateTarget, normalizeTarget, transition } = require('../lib/byoc.cjs');
const { createPairingStore, hashToken } = require('../lib/pairing.cjs');

assert.deepStrictEqual(PROVIDERS, ['generic-vps', 'hetzner']);
assert.deepStrictEqual(STATUSES, ['pending', 'ready', 'offline', 'disabled']);

const input = {
  name: 'Primary VPS',
  provider: 'hetzner',
  endpoint: 'https://vps.example.test:8443',
  region: 'fsn1',
  resourceTier: 'cx33',
  secretRef: 'HOSTKIND_BYOC_PRIMARY',
};
assert.strictEqual(validateTarget(input).ok, true);
const target = normalizeTarget(input, { id: 'target-1', now: 1000 });
assert.deepStrictEqual(target, {
  id: 'target-1',
  name: 'Primary VPS',
  provider: 'hetzner',
  endpoint: 'https://vps.example.test:8443',
  region: 'fsn1',
  resourceTier: 'cx33',
  secretRef: 'HOSTKIND_BYOC_PRIMARY',
  status: 'pending',
  createdAt: 1000,
  updatedAt: 1000,
  lastSeenAt: null,
});
assert.strictEqual(transition(target, 'ready', 1100).status, 'ready');
assert.strictEqual(transition(target, 'offline', 1200).status, 'offline');
assert.strictEqual(validateTarget({ ...input, provider: 'aws' }).ok, false);
assert.strictEqual(validateTarget({ ...input, secretRef: 'plaintext-password' }).ok, false);
assert.strictEqual(validateTarget({ ...input, endpoint: 'file:///etc/passwd' }).ok, false);
assert.throws(() => transition(target, 'unknown', 1300), /status/i);

let now = 10_000;
const store = createPairingStore({ now: () => now, ttlMs: 100, maxAttempts: 2 });
const first = store.create({ targetId: 'target-1', actorId: 'admin-1' });
assert.ok(first.token.length >= 32);
assert.notStrictEqual(hashToken(first.token), first.token);
assert.strictEqual(store.consume({ id: first.id, token: 'wrong-token', now }).ok, false);
const consumed = store.consume({ id: first.id, token: first.token, now: now + 1 });
assert.strictEqual(consumed.ok, true);
assert.strictEqual(consumed.targetId, 'target-1');
assert.ok(consumed.agentId);
assert.strictEqual(store.consume({ id: first.id, token: first.token, now: now + 2 }).ok, false);

const second = store.create({ targetId: 'target-2', actorId: 'admin-1' });
assert.strictEqual(store.consume({ id: 'not-second', token: second.token, now }).ok, false);
now += 101;
assert.strictEqual(store.consume({ id: second.id, token: second.token, now }).ok, false);

const locked = store.create({ targetId: 'target-3', actorId: 'admin-1' });
assert.strictEqual(store.consume({ id: locked.id, token: 'bad-1', now }).ok, false);
assert.strictEqual(store.consume({ id: locked.id, token: 'bad-2', now }).ok, false);
assert.strictEqual(store.consume({ id: locked.id, token: locked.token, now }).ok, false);
console.log('PASS byoc-pairing');
