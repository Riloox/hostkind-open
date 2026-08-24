'use strict';

/*
 * bug-report-config upstream-relay mode — configuration contract.
 *
 * Contract under test (lib/bug-report-config.cjs):
 *   - bugReports.mode is 'github' (default, current behavior) or
 *     'upstream-relay'; anything else normalizes to 'github' with an
 *     'invalid_mode' error and disables sync.
 *   - relayUrl is server config only: https URLs are accepted; http is
 *     accepted ONLY for localhost/loopback hosts and ONLY through the
 *     explicit allowLocalhostHttp test seam (normalizeConfig's third arg).
 *     Embedded URL credentials are rejected. A malformed relayUrl is an
 *     error in any mode (broken server config fails closed).
 *   - upstream-relay mode WITHOUT a relayUrl is a broken config: mode is
 *     preserved but enabled=false with an 'invalid_relay_url' error.
 *   - redactConfig strips the token but preserves relayUrl (not a secret).
 *   - DEFAULTS is unchanged ({ enabled, owner, repo, labels }) — pinned by
 *     the pre-existing bug-reports-config test.
 */

const assert = require('assert');

const {
  DEFAULTS,
  GITHUB_TOKEN_ENV,
  normalizeConfig,
  redactConfig,
  validateRelayUrl,
  buildTrackerUrl,
  MODE_GITHUB,
  MODE_UPSTREAM_RELAY,
} = require('../lib/bug-report-config.cjs');

const HTTPS_RELAY = 'https://bugs.fleetdeck.example/v1/reports';

const tests = [];

// 1. mode defaults to 'github' when absent (current behavior preserved).
tests.push({ name: 'mode defaults to github when absent', fn: () => {
  const r = normalizeConfig({});
  assert.strictEqual(r.mode, MODE_GITHUB);
  assert.strictEqual(r.relayUrl, null);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.enabled, false);
}});

// 2. Explicit 'github' and 'upstream-relay' modes are accepted.
tests.push({ name: 'mode github and upstream-relay accepted', fn: () => {
  assert.strictEqual(normalizeConfig({ mode: 'github' }).mode, MODE_GITHUB);
  const relay = normalizeConfig({ mode: 'upstream-relay', relayUrl: HTTPS_RELAY });
  assert.strictEqual(relay.mode, MODE_UPSTREAM_RELAY);
  assert.strictEqual(relay.relayUrl, HTTPS_RELAY);
  assert.deepStrictEqual(relay.errors, []);
}});

// 3. Invalid modes fall back to github + error + disabled.
tests.push({ name: 'invalid mode -> github fallback, error, disabled', fn: () => {
  for (const bad of ['relay', 'GITHUB', 'Upstream-Relay', 42, true, ['github']]) {
    const r = normalizeConfig({ enabled: true, mode: bad, relayUrl: HTTPS_RELAY });
    assert.strictEqual(r.mode, MODE_GITHUB, `mode ${JSON.stringify(bad)} must fall back to github`);
    assert.ok(r.errors.includes('invalid_mode'), `expected invalid_mode for ${JSON.stringify(bad)} in ${JSON.stringify(r.errors)}`);
    assert.strictEqual(r.enabled, false, `invalid mode ${JSON.stringify(bad)} must disable sync`);
  }
}});

// 4. upstream-relay mode without a relayUrl is a broken config (fail closed).
tests.push({ name: 'upstream-relay without relayUrl -> error + disabled', fn: () => {
  const r = normalizeConfig({ enabled: true, mode: 'upstream-relay' });
  assert.strictEqual(r.mode, MODE_UPSTREAM_RELAY);
  assert.strictEqual(r.relayUrl, null);
  assert.ok(r.errors.includes('invalid_relay_url'), JSON.stringify(r.errors));
  assert.strictEqual(r.enabled, false);
}});

// 5. Empty/whitespace relayUrl is treated as absent.
tests.push({ name: 'empty relayUrl treated as absent in relay mode', fn: () => {
  const r = normalizeConfig({ enabled: true, mode: 'upstream-relay', relayUrl: '   ' });
  assert.strictEqual(r.relayUrl, null);
  assert.ok(r.errors.includes('invalid_relay_url'));
  assert.strictEqual(r.enabled, false);
}});

// 6. https relayUrl accepted; http (non-localhost) rejected in any mode.
tests.push({ name: 'https relayUrl accepted, plain http rejected', fn: () => {
  assert.strictEqual(validateRelayUrl(HTTPS_RELAY).error, null);
  assert.strictEqual(validateRelayUrl('http://relay.example/v1/reports').error, 'invalid_relay_url');
  const r = normalizeConfig({ enabled: true, mode: 'github', relayUrl: 'http://relay.example/v1/reports' });
  assert.ok(r.errors.includes('invalid_relay_url'));
  assert.strictEqual(r.enabled, false);
}});

// 7. http://localhost is allowed ONLY through the allowLocalhostHttp seam.
tests.push({ name: 'localhost http requires the allowLocalhostHttp test seam', fn: () => {
  const url = 'http://localhost:8787/v1/reports';
  assert.strictEqual(validateRelayUrl(url).error, 'invalid_relay_url', 'no seam -> rejected');
  assert.strictEqual(validateRelayUrl(url, { allowLocalhostHttp: true }).error, null, 'seam -> accepted');
  const withSeam = normalizeConfig({ enabled: true, mode: 'upstream-relay', relayUrl: url }, {}, { allowLocalhostHttp: true });
  assert.strictEqual(withSeam.relayUrl, url);
  assert.strictEqual(withSeam.enabled, true);
  assert.deepStrictEqual(withSeam.errors, []);
}});

// 8. Loopback hosts accepted with the seam; private/LAN hosts are not.
tests.push({ name: 'loopback http allowed with seam, LAN http never', fn: () => {
  assert.strictEqual(validateRelayUrl('http://127.0.0.1:9000/reports', { allowLocalhostHttp: true }).error, null);
  assert.strictEqual(validateRelayUrl('http://[::1]:9000/reports', { allowLocalhostHttp: true }).error, null);
  assert.strictEqual(validateRelayUrl('http://192.168.1.5:9000/reports', { allowLocalhostHttp: true }).error, 'invalid_relay_url');
  assert.strictEqual(validateRelayUrl('http://mypi.local:9000/reports', { allowLocalhostHttp: true }).error, 'invalid_relay_url');
}});

// 9. Production path never allows http, even localhost (no seam passed).
tests.push({ name: 'server path (no seam) rejects localhost http', fn: () => {
  const r = normalizeConfig({ enabled: true, mode: 'upstream-relay', relayUrl: 'http://localhost:8787/v1/reports' });
  assert.ok(r.errors.includes('invalid_relay_url'));
  assert.strictEqual(r.enabled, false);
}});

// 10. Garbage relayUrl values are rejected without throwing.
tests.push({ name: 'garbage relayUrl -> invalid_relay_url, never throws', fn: () => {
  for (const bad of ['not a url', 'ftp://relay.example/x', 'https://', '//host/path', 42, { url: 'x' }]) {
    const r = normalizeConfig({ mode: 'upstream-relay', relayUrl: bad });
    assert.ok(r.errors.includes('invalid_relay_url'), `expected invalid_relay_url for ${JSON.stringify(bad)}`);
    assert.strictEqual(r.enabled, false);
  }
}});

// 11. Embedded URL credentials are rejected (user:pass@host).
tests.push({ name: 'relayUrl with embedded credentials rejected', fn: () => {
  assert.strictEqual(validateRelayUrl('https://user:secret@relay.example/v1/reports').error, 'invalid_relay_url');
  const r = normalizeConfig({ enabled: true, mode: 'upstream-relay', relayUrl: 'https://user:secret@relay.example/v1/reports' });
  assert.ok(r.errors.includes('invalid_relay_url'));
  assert.strictEqual(r.enabled, false);
}});

// 12. Valid upstream-relay config: enabled survives, errors empty, token env still read.
tests.push({ name: 'upstream-relay with valid https url enables and keeps env token', fn: () => {
  const r = normalizeConfig(
    { enabled: true, mode: 'upstream-relay', relayUrl: HTTPS_RELAY },
    { [GITHUB_TOKEN_ENV]: 'ghp_env_secret' }
  );
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.mode, MODE_UPSTREAM_RELAY);
  assert.strictEqual(r.relayUrl, HTTPS_RELAY);
  assert.strictEqual(r.token, 'ghp_env_secret');
  assert.deepStrictEqual(r.errors, []);
}});

// 13. github mode does not require a relayUrl (backwards compatible).
tests.push({ name: 'github mode without relayUrl stays enabled', fn: () => {
  const r = normalizeConfig({ enabled: true, mode: 'github' }, { [GITHUB_TOKEN_ENV]: 'ghp_x' });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.relayUrl, null);
  assert.deepStrictEqual(r.errors, []);
}});

// 14. redactConfig preserves relayUrl but still strips token/env keys.
tests.push({ name: 'redactConfig keeps relayUrl, strips token', fn: () => {
  const cfg = { enabled: true, mode: 'upstream-relay', relayUrl: HTTPS_RELAY, token: 'ghp_secret', [GITHUB_TOKEN_ENV]: 'ghp_secret2' };
  const redacted = redactConfig(cfg);
  assert.strictEqual(redacted.relayUrl, HTTPS_RELAY);
  assert.strictEqual(redacted.mode, 'upstream-relay');
  assert.ok(!('token' in redacted));
  assert.ok(!(GITHUB_TOKEN_ENV in redacted));
  assert.strictEqual(cfg.token, 'ghp_secret', 'input not mutated');
}});

// 15. DEFAULTS is untouched (pinned by the pre-existing config test).
tests.push({ name: 'DEFAULTS unchanged', fn: () => {
  assert.deepStrictEqual(DEFAULTS, { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'] });
}});

// 16. MODES export exposes exactly the two supported modes.
tests.push({ name: 'MODES exposes github + upstream-relay', fn: () => {
  assert.deepStrictEqual([...new Set([MODE_GITHUB, MODE_UPSTREAM_RELAY])].sort(), ['github', 'upstream-relay']);
}});

// 17. Garbage input still never throws with relay fields present.
tests.push({ name: 'garbage input never throws with relay fields', fn: () => {
  assert.strictEqual(normalizeConfig(null).mode, MODE_GITHUB);
  assert.strictEqual(normalizeConfig('garbage').relayUrl, null);
  assert.strictEqual(normalizeConfig([]).mode, MODE_GITHUB);
  assert.deepStrictEqual(normalizeConfig(42).errors, []);
}});

// 18. buildTrackerUrl derives the public issue chooser from owner/repo: the
// "not configured" fallback link shown to users of installs without a relay
// or token (the default for the open edition).
tests.push({ name: 'buildTrackerUrl builds the issue chooser URL', fn: () => {
  assert.strictEqual(buildTrackerUrl('Riloox', 'hostkind-open'), 'https://github.com/Riloox/hostkind-open/issues/new/choose');
  assert.strictEqual(buildTrackerUrl('some-org', 'a-repo'), 'https://github.com/some-org/a-repo/issues/new/choose');
  assert.strictEqual(buildTrackerUrl('xn--foo', 'repo.with.dots_and-dashes'), 'https://github.com/xn--foo/repo.with.dots_and-dashes/issues/new/choose');
}});

// 19. buildTrackerUrl fails closed on garbage/absent values — never throws,
// never emits a URL that GitHub would 404 or that could redirect elsewhere.
tests.push({ name: 'buildTrackerUrl fails closed on bad input', fn: () => {
  assert.strictEqual(buildTrackerUrl(), null);
  assert.strictEqual(buildTrackerUrl('', ''), null);
  assert.strictEqual(buildTrackerUrl('Riloox', ''), null);
  assert.strictEqual(buildTrackerUrl('', 'hostkind-open'), null);
  assert.strictEqual(buildTrackerUrl(null, 'repo'), null);
  assert.strictEqual(buildTrackerUrl('Riloox', null), null);
  assert.strictEqual(buildTrackerUrl(42, ['x']), null);
  assert.strictEqual(buildTrackerUrl('a b', 'c d'), null, 'spaces are not valid GitHub owner/repo chars');
  assert.strictEqual(buildTrackerUrl('Riloox', 'evil repo\njavascript:alert(1)'), null, 'control chars must fail closed');
}});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i].fn(); console.log(`ok  bug-report-upstream-relay-config test ${i + 1}: ${tests[i].name}`); }
  catch (e) { failed++; console.error(`FAIL bug-report-upstream-relay-config test ${i + 1}: ${tests[i].name}: ${e.message}`); }
}
if (failed) { console.error(`FAIL  ${failed} bug-report-upstream-relay-config test(s) failed`); process.exit(1); }
console.log('PASS  bug-report-upstream-relay-config');
