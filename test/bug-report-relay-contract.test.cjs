'use strict';

/*
 * Relay contract tests.
 *
 * Pins the documented wire contract: relay/README.md and
 * relay/THREAT-MODEL.md exist and state the non-negotiables; the module
 * constants match the documentation; the schema has NO credential field and
 * NO client-selected repository/URL field; and a report is queued before any
 * GitHub call.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validateReport,
  parseAndValidate,
  LIMITS,
  MAX_BODY_BYTES,
  ALLOWED_FIELDS,
} = require('../relay/lib/validate-report.cjs');

const tests = [];
const REPO_ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/* ── documentation exists and states the contract ────────────────── */

tests.push(() => {
  const readme = read('relay/README.md');
  assert.ok(readme.includes('POST /v1/reports'), 'README must document the submission endpoint');
  assert.ok(readme.includes('/healthz'), 'README must document the health endpoint');
  assert.ok(readme.includes('32 KiB'), 'README must document the body limit');
  assert.ok(readme.includes('hostkind-open'), 'README must fix the upstream repository');
  assert.ok(readme.includes('no credential field') || readme.includes('no credential'), 'README must state the no-credential rule');
  assert.ok(readme.includes('unknown fields are rejected') || readme.includes('Unknown fields'), 'README must state unknown-field rejection');
  console.log('ok  relay-contract README: endpoint, limits, fixed repo, no credential');
});

tests.push(() => {
  const threat = read('relay/THREAT-MODEL.md');
  assert.ok(threat.includes('Riloox/hostkind-open'), 'threat model must name the fixed upstream repo');
  assert.ok(/credential/i.test(threat), 'threat model must cover the credential asset');
  assert.ok(/prompt injection/i.test(threat), 'threat model must cover prompt injection');
  assert.ok(/rate limit/i.test(threat), 'threat model must cover abuse controls');
  assert.ok(/idempoten/i.test(threat), 'threat model must cover replay/idempotency');
  console.log('ok  relay-contract THREAT-MODEL: assets, injection, abuse, replay');
});

/* ── documented limits match the code ────────────────────────────── */

tests.push(() => {
  assert.strictEqual(LIMITS.titleMax, 200, 'README table: title 200');
  assert.strictEqual(LIMITS.descriptionMax, 20_000, 'README table: description 20 000');
  assert.strictEqual(LIMITS.stepsMax, 5_000, 'README table: reproSteps/expected 5 000');
  assert.strictEqual(LIMITS.userAgentMax, 1_000, 'README table: userAgent 1 000');
  assert.strictEqual(LIMITS.optionalMax, 500, 'README table: game/view/route/version 500');
  assert.strictEqual(MAX_BODY_BYTES, 32 * 1024, 'README: 32 KiB body cap');
  console.log('ok  relay-contract limits: code constants match documentation');
});

/* ── schema: no credential / no client-selected destination ──────── */

tests.push(() => {
  const forbidden = ['token', 'password', 'secret', 'authorization', 'credential', 'api_key', 'access_token', 'github_token'];
  for (const field of forbidden) {
    assert.ok(!ALLOWED_FIELDS.has(field), `contract must have no credential field '${field}'`);
  }
  const destination = ['repo', 'repository', 'owner', 'labels', 'url', 'githubUrl', 'apiUrl', 'baseUrl'];
  for (const field of destination) {
    assert.ok(!ALLOWED_FIELDS.has(field), `contract must have no client-selected destination field '${field}'`);
  }
  console.log('ok  relay-contract schema: no credential or destination fields');
});

tests.push(() => {
  // A payload attempting to smuggle a credential or destination is rejected,
  // and the rejection never echoes the submitted value.
  const payload = {
    title: 'ok',
    description: 'ok',
    token: 'ghp_top_secret_token_1234567890',
    repo: 'Riloox/other',
  };
  const out = validateReport(payload);
  assert.strictEqual(out.ok, false);
  const joined = JSON.stringify(out.errors);
  assert.ok(joined.includes('token: unknown field'), joined);
  assert.ok(joined.includes('repo: unknown field'), joined);
  assert.ok(!joined.includes('ghp_'), 'rejection must not echo the secret');
  console.log('ok  relay-contract validation: credential/destination smuggling rejected silently');
});

/* ── wire parsing gates ──────────────────────────────────────────── */

tests.push(() => {
  const text = parseAndValidate(JSON.stringify({ title: 't', description: 'd' }), 'text/plain');
  assert.strictEqual(text.status, 415);
  const tooBig = parseAndValidate(JSON.stringify({ title: 't', description: 'x'.repeat(MAX_BODY_BYTES + 1) }), 'application/json');
  assert.strictEqual(tooBig.status, 413);
  const broken = parseAndValidate('{nope', 'application/json');
  assert.strictEqual(broken.status, 400);
  const ok = parseAndValidate(JSON.stringify({ title: 't', description: 'd' }), 'application/json');
  assert.strictEqual(ok.ok, true);
  console.log('ok  relay-contract wire: 415/413/400/accept mapping');
});

/* ── queued before GitHub (ordering invariant, unit level) ───────── */

tests.push(async () => {
  // Enqueue is synchronous and durable before the worker is ever invoked;
  // the worker can only ever see already-persisted rows.
  const fs2 = require('fs');
  const os2 = require('os');
  const path2 = require('path');
  const { createStore } = require('../relay/lib/store.cjs');
  const { createQueueWorker } = require('../relay/lib/queue-worker.cjs');

  const dir = fs2.realpathSync.native(fs2.mkdtempSync(path2.join(os2.tmpdir(), 'relay-contract-')));
  const store = createStore({ dbPath: path2.join(dir, 'relay.db') });
  try {
    let clientSawRow = false;
    const client = {
      async createIssue() {
        clientSawRow = store.getByMarker('m-contract') !== null;
        return { issueNumber: 1, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/1' };
      },
      async findIssueByMarker() { return null; },
    };
    const row = store.enqueue({ marker: 'm-contract', title: 't', payload: { title: 't', description: 'd' } });
    assert.strictEqual(row.sync_state, 'pending', 'durable before any network access');
    const worker = createQueueWorker({ store, client });
    await worker.runOnce();
    assert.strictEqual(clientSawRow, true, 'GitHub call must observe the persisted row');
    assert.strictEqual(store.getByMarker('m-contract').sync_state, 'synced');
  } finally {
    store.close();
    fs2.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log('ok  relay-contract ordering: report queued before any GitHub call');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
    } catch (e) {
      failed++;
      console.error(`FAIL  bug-report-relay-contract test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL  ${failed} bug-report-relay-contract test(s) failed`);
    process.exit(1);
  }
  console.log(`PASS  bug-report-relay-contract (${tests.length} tests)`);
})();
