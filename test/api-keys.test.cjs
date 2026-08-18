'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath, open } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const capabilities = require('../lib/capabilities.cjs');
const apiKeys = require('../lib/apiKeys.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (require('fs').existsSync(p)) try { require('fs').unlinkSync(p); } catch { /* */ }
  }
}

fresh();
migrations.runMigrations();

const tests = [];

// The secret is base64url, whose alphabet contains "_", so the separator is not
// a safe delimiter - about half of all tokens carry one. Parse it the way the
// library does, anchored on the fixed-width hex handle.
const TOKEN = /^fdk_([0-9a-f]{16})_(.+)$/;

// 1. A created key hands back a token exactly once, and the plaintext is not
//    what gets stored.
tests.push(() => {
  const { key, token } = apiKeys.create({ name: 'Billing', role: 'operator', createdBy: 'admin-1' });
  const parts = TOKEN.exec(token);
  assert.ok(parts, `unexpected token shape: ${token}`);
  assert.strictEqual(key.id, `key:${parts[1]}`, 'the handle in the token is the principal id');
  assert.ok(parts[2].length >= 40, 'the secret should carry 32 bytes of entropy');

  const row = open().prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id);
  assert.ok(row.secret_hash);
  assert.ok(!token.includes(row.secret_hash), 'the stored hash must not be the token');
  assert.ok(!JSON.stringify(key).includes(parts[2]), 'the public key object must not carry the secret');
});

// 2. verify() round-trips, and returns a principal the capability layer accepts.
tests.push(() => {
  const { key, token } = apiKeys.create({ name: 'Provisioner', role: 'operator' });
  const principal = apiKeys.verify(token);
  assert.ok(principal, 'a fresh token should verify');
  assert.strictEqual(principal.id, key.id);
  assert.strictEqual(principal.role, 'operator');
  assert.strictEqual(principal.apiKey, true);

  // The whole point: no grant, no access - the same rule users get.
  assert.ok(!capabilities.has(principal, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
  capabilities.grant(principal.id, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  assert.ok(capabilities.has(principal, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
  assert.ok(!capabilities.has(principal, 'srv-2', capabilities.CAPABILITIES.SERVER_CONTROL));
});

// 3. A tampered secret, a wrong handle, and junk all fail closed.
tests.push(() => {
  const { token } = apiKeys.create({ name: 'Tamper' });
  const [, handle, secret] = TOKEN.exec(token);

  assert.strictEqual(apiKeys.verify(`fdk_${handle}_${secret}x`), null, 'appended secret must fail');
  assert.strictEqual(apiKeys.verify(`fdk_0000000000000000_${secret}`), null, 'unknown handle must fail');
  assert.strictEqual(apiKeys.verify(`fdk_${handle}_`), null, 'an empty secret must fail');
  assert.strictEqual(apiKeys.verify('not-a-token'), null);
  assert.strictEqual(apiKeys.verify(''), null);
  assert.strictEqual(apiKeys.verify(null), null);
  // A JWT must never be mistaken for a key.
  assert.strictEqual(apiKeys.looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.e30.abc'), false);
  assert.strictEqual(apiKeys.looksLikeApiKey(token), true);
});

// 4. Revoking kills the token and takes its grants with it.
tests.push(() => {
  const { key, token } = apiKeys.create({ name: 'Doomed', role: 'operator' });
  capabilities.grant(key.id, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  assert.ok(apiKeys.verify(token));

  assert.strictEqual(apiKeys.revoke(key.id, 'admin-1'), true);
  assert.strictEqual(apiKeys.verify(token), null, 'a revoked key must not authenticate');
  assert.strictEqual(capabilities.listForUser(key.id).length, 0, 'revoking must drop the grants');

  // Revoking twice is not an error, but it is not a second revocation either.
  assert.strictEqual(apiKeys.revoke(key.id, 'admin-1'), false);
  // The row survives so an audit trail can still name the key.
  assert.ok(apiKeys.get(key.id));
  assert.ok(apiKeys.get(key.id).revokedAt);
});

// 5. Expiry is enforced at verify time, not only at creation.
tests.push(() => {
  const past = apiKeys.create({ name: 'Expired', expiresAt: Date.now() - 1000 });
  assert.strictEqual(apiKeys.verify(past.token), null, 'an expired key must not authenticate');

  const future = apiKeys.create({ name: 'Live', expiresAt: Date.now() + 60_000 });
  assert.ok(apiKeys.verify(future.token), 'a key expiring later must still work');
});

// 6. last_used_at is recorded, and throttled so it is not a write per request.
tests.push(() => {
  const { key, token } = apiKeys.create({ name: 'Used' });
  assert.strictEqual(apiKeys.get(key.id).lastUsedAt, null);

  apiKeys.verify(token);
  const first = apiKeys.get(key.id).lastUsedAt;
  assert.ok(first, 'first use must be recorded');

  apiKeys.verify(token);
  assert.strictEqual(apiKeys.get(key.id).lastUsedAt, first, 'a second use inside the window must not write again');
});

// 7. Bad input is refused rather than stored.
tests.push(() => {
  assert.throws(() => apiKeys.create({ name: '' }), /name required/);
  assert.throws(() => apiKeys.create({ name: '   ' }), /name required/);
  assert.throws(() => apiKeys.create({ name: 'Bad role', role: 'superuser' }), /unknown role/);
  assert.throws(() => apiKeys.create({ name: 'Bad expiry', expiresAt: 'tomorrow' }), /timestamp/);
});

// 8. list() sees every key; the secret hash is never in what it returns.
tests.push(() => {
  const before = apiKeys.list().length;
  apiKeys.create({ name: 'Listed' });
  const all = apiKeys.list();
  assert.strictEqual(all.length, before + 1);
  assert.ok(all.every((key) => !('secretHash' in key) && !('secret_hash' in key)));
  assert.ok(apiKeys.list({ includeRevoked: false }).every((key) => !key.revokedAt));
});

// 9. isApiKeyPrincipal separates machines from people - it is what the
//    key-management routes gate on.
tests.push(() => {
  const { token } = apiKeys.create({ name: 'Machine' });
  assert.strictEqual(apiKeys.isApiKeyPrincipal(apiKeys.verify(token)), true);
  assert.strictEqual(apiKeys.isApiKeyPrincipal({ id: 'u1', role: 'admin' }), false);
  assert.strictEqual(apiKeys.isApiKeyPrincipal(null), false);
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  api-keys test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  api-keys test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} api-keys test(s) failed`); process.exit(1); }
console.log('PASS  api-keys');
