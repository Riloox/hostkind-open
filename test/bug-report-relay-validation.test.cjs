'use strict';

/*
 * Relay validation + redaction tests.
 *
 * Pins the pure contract of relay/lib/validate-report.cjs and
 * relay/lib/redact-report.cjs: strict schema, length limits, unknown-field
 * rejection, secret-pattern redaction (tokens/passwords/private keys/paths/
 * emails/IPs), Unicode/multiline handling, and the invariant that NO
 * validation error ever contains the submitted value.
 */

const assert = require('assert');
const {
  validateReport,
  parseAndValidate,
  acceptsJson,
  LIMITS,
  MAX_BODY_BYTES,
} = require('../relay/lib/validate-report.cjs');
const { redactReport, redactString, containsSecret } = require('../relay/lib/redact-report.cjs');

const tests = [];

const VALID = {
  title: 'Crash on world load',
  description: 'The server crashes when the world loads.',
  reproSteps: '1. Start server\n2. Load world',
  expected: 'World loads without crashing',
  game: 'minecraft',
  view: 'servers',
  route: '/servers/abc',
  userAgent: 'Mozilla/5.0 (fleetdeck test)',
  version: '0.1.0',
};

/* ── content-type / wire parsing ─────────────────────────────────── */

tests.push(() => {
  assert.strictEqual(acceptsJson('application/json'), true);
  assert.strictEqual(acceptsJson('application/json; charset=utf-8'), true);
  assert.strictEqual(acceptsJson('application/vnd.github+json'), true);
  assert.strictEqual(acceptsJson('Application/JSON'), true);
  assert.strictEqual(acceptsJson('text/plain'), false);
  assert.strictEqual(acceptsJson('multipart/form-data'), false);
  assert.strictEqual(acceptsJson(null), false);
  assert.strictEqual(acceptsJson(''), false);
  console.log('ok  relay-validation acceptsJson: json media types only');
});

tests.push(() => {
  const out = parseAndValidate(JSON.stringify(VALID), 'application/json');
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.report, {
    title: 'Crash on world load',
    description: 'The server crashes when the world loads.',
    reproSteps: '1. Start server\n2. Load world',
    expected: 'World loads without crashing',
    game: 'minecraft',
    view: 'servers',
    route: '/servers/abc',
    userAgent: 'Mozilla/5.0 (fleetdeck test)',
    version: '0.1.0',
  });
  console.log('ok  relay-validation parseAndValidate: valid body accepted');
});

tests.push(() => {
  const out = parseAndValidate(JSON.stringify(VALID), 'text/plain');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 415);
  assert.strictEqual(out.code, 'unsupported_content_type');
  console.log('ok  relay-validation parseAndValidate: non-JSON content type -> 415');
});

tests.push(() => {
  const out = parseAndValidate('{"title": "oops",', 'application/json');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.code, 'invalid_json');
  console.log('ok  relay-validation parseAndValidate: invalid JSON -> 400');
});

tests.push(() => {
  const out = parseAndValidate('', 'application/json');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.code, 'invalid_json');
  console.log('ok  relay-validation parseAndValidate: empty body -> 400');
});

tests.push(() => {
  const big = JSON.stringify({ title: 'x'.repeat(200), description: 'y'.repeat(MAX_BODY_BYTES + 100) });
  const out = parseAndValidate(big, 'application/json');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 413);
  assert.strictEqual(out.code, 'payload_too_large');
  assert.strictEqual(MAX_BODY_BYTES, 32 * 1024);
  console.log('ok  relay-validation parseAndValidate: oversized body -> 413 (32 KiB cap)');
});

/* ── schema validation ───────────────────────────────────────────── */

tests.push(() => {
  const out = validateReport({ description: 'no title' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('title: must be a non-empty string'), JSON.stringify(out.errors));
  console.log('ok  relay-validation required: title');
});

tests.push(() => {
  const out = validateReport({ title: 'no description' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('description: must be a non-empty string'), JSON.stringify(out.errors));
  console.log('ok  relay-validation required: description');
});

tests.push(() => {
  const out = validateReport({ title: '   ', description: 'ok' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('title: must be a non-empty string'), JSON.stringify(out.errors));
  console.log('ok  relay-validation required: whitespace-only title rejected');
});

tests.push(() => {
  const out = validateReport({ title: 42, description: 'ok' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('title: must be a non-empty string'), JSON.stringify(out.errors));
  console.log('ok  relay-validation type: non-string title rejected');
});

tests.push(() => {
  const out = validateReport({ title: 'x'.repeat(LIMITS.titleMax + 1), description: 'ok' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes(`title: exceeds ${LIMITS.titleMax} characters`), JSON.stringify(out.errors));
  console.log('ok  relay-validation limits: title max length');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'd'.repeat(LIMITS.descriptionMax + 1) });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes(`description: exceeds ${LIMITS.descriptionMax} characters`), JSON.stringify(out.errors));
  console.log('ok  relay-validation limits: description max length');
});

tests.push(() => {
  const out = validateReport({
    title: 'ok',
    description: 'ok',
    reproSteps: 's'.repeat(LIMITS.stepsMax + 1),
    expected: 'e'.repeat(LIMITS.stepsMax + 1),
  });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes(`reproSteps: exceeds ${LIMITS.stepsMax} characters`), JSON.stringify(out.errors));
  assert.ok(out.errors.includes(`expected: exceeds ${LIMITS.stepsMax} characters`), JSON.stringify(out.errors));
  console.log('ok  relay-validation limits: reproSteps/expected max length');
});

tests.push(() => {
  const out = validateReport({
    title: 'ok',
    description: 'ok',
    userAgent: 'u'.repeat(LIMITS.userAgentMax + 1),
    game: 'g'.repeat(LIMITS.optionalMax + 1),
  });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes(`userAgent: exceeds ${LIMITS.userAgentMax} characters`), JSON.stringify(out.errors));
  assert.ok(out.errors.includes(`game: exceeds ${LIMITS.optionalMax} characters`), JSON.stringify(out.errors));
  console.log('ok  relay-validation limits: userAgent/game max length');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'ok', token: 'ghp_abc' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('token: unknown field'), JSON.stringify(out.errors));
  console.log('ok  relay-validation unknown fields: credential-shaped field rejected');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'ok', repo: 'Riloox/other', url: 'https://x' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('repo: unknown field'), JSON.stringify(out.errors));
  assert.ok(out.errors.includes('url: unknown field'), JSON.stringify(out.errors));
  console.log('ok  relay-validation unknown fields: no client-selected repo/url fields');
});

tests.push(() => {
  const out = validateReport('not an object');
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('payload: must be a JSON object'), JSON.stringify(out.errors));
  const arr = validateReport([1, 2]);
  assert.strictEqual(arr.ok, false);
  console.log('ok  relay-validation type: non-object payload rejected');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'ok', version: 1.2 });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('version: must be a string'), JSON.stringify(out.errors));
  console.log('ok  relay-validation type: non-string optional rejected');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'ok', clientKey: 'ab' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.some((e) => e.startsWith('clientKey:')), JSON.stringify(out.errors));
  const bad = validateReport({ title: 'ok', description: 'ok', clientKey: 'a b c d e f g h' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith('clientKey:')), JSON.stringify(bad.errors));
  console.log('ok  relay-validation clientKey: too short / unsafe charset rejected');
});

tests.push(() => {
  const out = validateReport({ title: 'ok', description: 'ok', clientKey: 'client-key-1234' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.report.clientKey, 'client-key-1234');
  console.log('ok  relay-validation clientKey: safe key accepted');
});

tests.push(() => {
  const out = validateReport({ title: 'ok\u0000boom', description: 'ok' });
  assert.strictEqual(out.ok, false);
  assert.ok(out.errors.includes('title: contains control characters'), JSON.stringify(out.errors));
  console.log('ok  relay-validation control chars: NUL rejected');
});

tests.push(() => {
  const out = validateReport({
    title: 'Über cool 🎮 bug',
    description: 'line one\nline two\r\n\ttabbed\nemoji ✅ works',
    reproSteps: '1. a\n2. b',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.report.title, 'Über cool 🎮 bug');
  assert.strictEqual(out.report.description, 'line one\nline two\r\n\ttabbed\nemoji ✅ works');
  assert.strictEqual(out.report.reproSteps, '1. a\n2. b');
  console.log('ok  relay-validation unicode/multiline: preserved exactly');
});

tests.push(() => {
  const out = validateReport({ title: '  padded title  ', description: ' ok ', game: '   ', route: '' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.report.title, 'padded title');
  assert.strictEqual(out.report.description, 'ok');
  assert.strictEqual(out.report.game, null);
  assert.strictEqual(out.report.route, null);
  console.log('ok  relay-validation normalization: trim + empty optional -> null');
});

/* ── no-value-echo invariant ─────────────────────────────────────── */

tests.push(() => {
  const secretTitle = `ghp_${'a'.repeat(40)}secret`;
  const secretDesc = 'SuperSecretPassword123!';
  const out = validateReport({
    title: secretTitle.repeat(5),   // way over limit
    description: secretDesc.repeat(2000), // way over limit
  });
  assert.strictEqual(out.ok, false);
  const joined = JSON.stringify(out.errors);
  assert.ok(!joined.includes(secretTitle), 'error must not contain the submitted title');
  assert.ok(!joined.includes('ghp_'), 'error must not contain PAT-shaped text');
  assert.ok(!joined.includes(secretDesc), 'error must not contain the submitted description');
  console.log('ok  relay-validation no-echo: errors never contain submitted values');
});

tests.push(() => {
  const secret = 'hunter2-password-value';
  const out = validateReport({ title: 'ok', description: 'ok', password: secret });
  assert.strictEqual(out.ok, false);
  assert.ok(!JSON.stringify(out.errors).includes(secret), 'unknown-field error must not echo the value');
  console.log('ok  relay-validation no-echo: unknown-field error drops the value');
});

/* ── redaction ───────────────────────────────────────────────────── */

tests.push(() => {
  const text = [
    'boom ghp_top_secret_token_1234567890 end',
    'also ' + 'github_pat_' + '11ABCDEF_abcdefghijklmnopqrstuvwxyz',
    'password=hunter2 and "secret": "value"',
    'Bearer ' + ['eyJ', 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.'),
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'admin@example.com on 192.168.1.10',
    'https://user:pass@example.com/api and ?token=abc123&key=zzz',
    'C:\\Users\\alice\\AppData and /home/bob/server',
  ].join('\n');
  const { text: out, hits } = redactString(text);
  assert.ok(!out.includes('ghp_'), out);
  assert.ok(!out.includes('github_pat_'), out);
  assert.ok(!out.includes('hunter2'), out);
  assert.ok(!out.includes('eyJ' + 'hbGciOiJIUzI1NiJ9'), out);
  assert.ok(!out.includes('AKIA' + 'IOSFODNN7EXAMPLE'), out);
  assert.ok(!out.includes('admin@example.com'), out);
  assert.ok(!out.includes('192.168.1.10'), out);
  assert.ok(!out.includes('user:pass'), out);
  assert.ok(!out.includes('token=abc123'), out);
  assert.ok(!out.includes('alice'), out);
  assert.ok(!out.includes('bob'), out);
  assert.ok(out.includes('boom'), out);
  assert.ok(out.includes('[REDACTED]'), out);
  assert.ok(hits.length > 0, 'rules should fire');
  console.log('ok  relay-redaction patterns: tokens, passwords, keys, emails, IPs, paths');
});

tests.push(() => {
  const text = [
    '-----BEGIN' + ' RSA PRIVATE KEY-----',
    'MIIE' + 'pAIBAAKCAQEA7wVXJ3v2vVx4eFpF0x1b9kLmNoPqRsTuVwXyZaBcDeFgHiJkLmN',
    '-----END' + ' RSA PRIVATE KEY-----',
    'keep this line',
  ].join('\n');
  const { text: out } = redactString(text);
  assert.ok(!out.includes('BEGIN RSA PRIVATE KEY'), out);
  assert.ok(!out.includes('MIIEpAIBAAKCAQEA'), out);
  assert.ok(out.includes('keep this line'), out);
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'), out);
  console.log('ok  relay-redaction private key blocks');
});

tests.push(() => {
  const { text: out } = redactString('discord hook ' + 'https://discord.com/api/webhooks/' + '1234567890' + '/' + 'AbCdEfGhIjKlMnOp');
  assert.ok(!out.includes('AbCdEfGhIjKlMnOp'), out);
  assert.ok(out.includes('[REDACTED_WEBHOOK]'), out);
  console.log('ok  relay-redaction discord webhook urls');
});

tests.push(() => {
  const r = redactReport({
    title: 'crash with ghp_top_secret_token_1234567890 pasted',
    description: 'home dir C:\\Users\\alice\\AppData\\Roaming and 10.0.0.8',
    reproSteps: '1. do the thing',
    game: 'minecraft',
    version: '0.1.0',
    optional: null,
  });
  assert.ok(!r.report.title.includes('ghp_'), r.report.title);
  assert.ok(!r.report.description.includes('alice'), r.report.description);
  assert.ok(!r.report.description.includes('10.0.0.8'), r.report.description);
  assert.strictEqual(r.report.reproSteps, '1. do the thing');
  assert.strictEqual(r.report.game, 'minecraft');
  assert.strictEqual(r.report.optional, null);
  assert.ok(r.hits.title && r.hits.title.includes('github-pat'), JSON.stringify(r.hits));
  console.log('ok  relay-redaction redactReport: deep redaction with hits');
});

tests.push(() => {
  assert.strictEqual(containsSecret('token ghp_top_secret_token_1234567890'), true);
  assert.strictEqual(containsSecret('plain prose about game servers'), false);
  const { text } = redactString('Über cool game 🎮 minecraft');
  assert.strictEqual(text, 'Über cool game 🎮 minecraft');
  console.log('ok  relay-redaction false positives: unicode/emoji prose untouched');
});

tests.push(() => {
  const first = redactString('ghp_top_secret_token_1234567890 and email a@b.com');
  const second = redactString(first.text);
  assert.strictEqual(first.text, second.text, 'redaction must be idempotent');
  console.log('ok  relay-redaction idempotent: double redaction is stable');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
    } catch (e) {
      failed++;
      console.error(`FAIL  bug-report-relay-validation test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL  ${failed} bug-report-relay-validation test(s) failed`);
    process.exit(1);
  }
  console.log(`PASS  bug-report-relay-validation (${tests.length} tests)`);
})();
