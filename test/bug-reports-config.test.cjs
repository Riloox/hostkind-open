'use strict';

/*
 * bug-reports-config — configuration contract for the GitHub-issue sync
 * feature (plan: .hermes/plans/2026-08-14_235510-report-bug-github.md, Task 1).
 *
 * Test-first: the module under test (lib/bug-report-config.cjs) does not exist
 * yet. This file pins the exported contract the implementation must satisfy:
 *
 *   module.exports = {
 *     DEFAULTS: { enabled, owner, repo, labels },
 *     GITHUB_TOKEN_ENV: 'FLEETDECK_GITHUB_TOKEN',
 *     normalizeConfig(input, env) -> {
 *       enabled, owner, repo, labels, token, errors,
 *     },
 *     redactConfig(config) -> config without any token key,
 *   }
 *
 * Contract rules pinned here (from the plan):
 *   - Defaults: disabled, destination Riloox/hostkind-open, labels ['bug'].
 *   - The GitHub token is server-side only and comes from the environment
 *     (FLEETDECK_GITHUB_TOKEN) with a config-block string as fallback; it is
 *     never required for normalization and is stripped by redactConfig().
 *   - Invalid owner/repo/labels must DISABLE synchronization (enabled=false,
 *     errors populated) rather than crash panel startup — normalization never
 *     throws, even on garbage input.
 *   - `enabled` is a strict boolean (only `true` enables).
 */

const assert = require('assert');

const CONFIG_MODULE = '../lib/bug-report-config.cjs';

let config;
try {
  config = require(CONFIG_MODULE);
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('bug-report-config')) {
    // Expected in test-first wave 1: implementation (Task 1) has not landed yet.
    console.error(`PENDING bug-reports-config: ${CONFIG_MODULE} not implemented yet (test-first wave 1; expected failure until Task 1 lands).`);
    process.exit(1);
  }
  throw err;
}

const { DEFAULTS, GITHUB_TOKEN_ENV, normalizeConfig, redactConfig } = config;

const tests = [];

// 1. Empty input normalizes to safe defaults, disabled, default destination.
tests.push({ name: 'defaults: disabled, Riloox/hostkind-open, [bug], no token', fn: () => {
  const r = normalizeConfig({});
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.owner, 'Riloox');
  assert.strictEqual(r.repo, 'hostkind-open');
  assert.deepStrictEqual(r.labels, ['bug']);
  assert.strictEqual(r.token, null);
  assert.deepStrictEqual(r.errors, []);
}});

// 2. DEFAULTS export matches the documented defaults.
tests.push({ name: 'DEFAULTS export is { enabled:false, owner:Riloox, repo:hostkind-open, labels:[bug] }', fn: () => {
  assert.deepStrictEqual(DEFAULTS, { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'] });
}});

// 3. Token comes from the environment when present.
tests.push({ name: 'token read from FLEETDECK_GITHUB_TOKEN env', fn: () => {
  const r = normalizeConfig({ enabled: true }, { [GITHUB_TOKEN_ENV]: 'ghp_env_secret' });
  assert.strictEqual(r.token, 'ghp_env_secret');
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(r.errors, []);
}});

// 4. Environment token wins over a config-block token.
tests.push({ name: 'env token takes precedence over config-block token', fn: () => {
  const r = normalizeConfig({ token: 'cfg-token' }, { [GITHUB_TOKEN_ENV]: 'env-token' });
  assert.strictEqual(r.token, 'env-token');
}});

// 5. Config-block token is the fallback when the env var is absent.
tests.push({ name: 'config-block token used when env var absent', fn: () => {
  const r = normalizeConfig({ token: 'cfg-token' }, {});
  assert.strictEqual(r.token, 'cfg-token');
}});

// 6. Empty/whitespace tokens normalize to null.
tests.push({ name: 'empty or whitespace token normalizes to null', fn: () => {
  assert.strictEqual(normalizeConfig({ token: '' }, {}).token, null);
  assert.strictEqual(normalizeConfig({ token: '   ' }, { [GITHUB_TOKEN_ENV]: '  ' }).token, null);
}});

// 7. Invalid owner disables sync instead of crashing.
tests.push({ name: 'invalid owner -> enabled forced false + error, default owner kept', fn: () => {
  const r = normalizeConfig({ enabled: true, owner: 'bad owner!' });
  assert.strictEqual(r.enabled, false);
  assert.ok(r.errors.includes('invalid_owner'), `expected invalid_owner in ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.owner, 'Riloox');
}});

// 8. Invalid repo disables sync.
tests.push({ name: 'invalid repo (slash) -> enabled forced false + error', fn: () => {
  const r = normalizeConfig({ enabled: true, repo: 'owner/repo' });
  assert.strictEqual(r.enabled, false);
  assert.ok(r.errors.includes('invalid_repo'), `expected invalid_repo in ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.repo, 'hostkind-open');
}});

// 9. Over-long owner (GitHub usernames cap at 39 chars) is invalid.
tests.push({ name: 'owner longer than 39 chars is invalid', fn: () => {
  const r = normalizeConfig({ owner: 'a'.repeat(40) });
  assert.ok(r.errors.includes('invalid_owner'));
}});

// 10. Valid custom owner/repo are accepted and enabled survives.
tests.push({ name: 'valid custom owner/repo accepted, enabled preserved', fn: () => {
  const r = normalizeConfig({ enabled: true, owner: 'Acme-Corp', repo: 'support_issues.1' });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.owner, 'Acme-Corp');
  assert.strictEqual(r.repo, 'support_issues.1');
  assert.deepStrictEqual(r.errors, []);
}});

// 11. Labels: array form normalized (non-empty trimmed strings, invalid dropped).
tests.push({ name: 'labels array normalized, invalid entries dropped', fn: () => {
  const r = normalizeConfig({ labels: [' bug ', '', 42, 'ui'] });
  assert.deepStrictEqual(r.labels, ['bug', 'ui']);
}});

// 12. Labels: comma-separated string form accepted.
tests.push({ name: 'comma-separated labels string split', fn: () => {
  const r = normalizeConfig({ labels: 'bug, in-app-report' });
  assert.deepStrictEqual(r.labels, ['bug', 'in-app-report']);
}});

// 13. Labels: all-invalid input falls back to the default label.
tests.push({ name: 'all-invalid labels fall back to default [bug]', fn: () => {
  const r = normalizeConfig({ labels: ['', 42, null] });
  assert.deepStrictEqual(r.labels, ['bug']);
}});

// 14. enabled is strict: only the boolean true enables.
tests.push({ name: 'enabled is strict boolean (1/"yes" do not enable)', fn: () => {
  assert.strictEqual(normalizeConfig({ enabled: 1 }).enabled, false);
  assert.strictEqual(normalizeConfig({ enabled: 'yes' }).enabled, false);
  assert.strictEqual(normalizeConfig({ enabled: true }).enabled, true);
}});

// 15. redactConfig strips the token entirely and does not mutate the source.
tests.push({ name: 'redactConfig removes token key, preserves everything else, no mutation', fn: () => {
  const withToken = { enabled: true, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'], token: 'ghp_never_show' };
  const redacted = redactConfig(withToken);
  assert.ok(!('token' in redacted), 'redacted config must not expose a token key');
  assert.strictEqual(redacted.owner, 'Riloox');
  assert.strictEqual(redacted.repo, 'hostkind-open');
  assert.strictEqual(redacted.enabled, true);
  assert.strictEqual(withToken.token, 'ghp_never_show', 'redactConfig must not mutate its input');
}});

// 16. redactConfig also strips the env-name key if present.
tests.push({ name: 'redactConfig strips GITHUB_TOKEN_ENV key too', fn: () => {
  const redacted = redactConfig({ enabled: true, [GITHUB_TOKEN_ENV]: 'ghp_x' });
  assert.ok(!(GITHUB_TOKEN_ENV in redacted));
}});

// 17. Garbage input never throws (invalid config must not crash startup).
tests.push({ name: 'garbage input (null/string/array) normalizes to defaults without throwing', fn: () => {
  assert.deepStrictEqual(normalizeConfig(null).errors, []);
  assert.strictEqual(normalizeConfig(null).enabled, false);
  assert.strictEqual(normalizeConfig('garbage').owner, 'Riloox');
  assert.strictEqual(normalizeConfig([]).repo, 'hostkind-open');
}});

// 18. Missing token with enabled=true still normalizes (token optional); the
//     sync gate is enabled && token, which consumers derive from this object.
tests.push({ name: 'missing token never disables normalization or throws', fn: () => {
  const r = normalizeConfig({ enabled: true }, {});
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.token, null);
  assert.deepStrictEqual(r.errors, []);
}});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i].fn(); console.log(`ok  bug-reports-config test ${i + 1}: ${tests[i].name}`); }
  catch (e) { failed++; console.error(`FAIL bug-reports-config test ${i + 1}: ${tests[i].name}: ${e.message}`); }
}
if (failed) { console.error(`FAIL  ${failed} bug-reports-config test(s) failed`); process.exit(1); }
console.log('PASS  bug-reports-config');
