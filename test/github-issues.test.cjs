'use strict';

/*
 * GitHub Issues client tests — plan Task 3
 * (.hermes/plans/2026-08-14_235510-report-bug-github.md)
 *
 * Implementation contract under test — lib/github-issues.cjs (native fetch,
 * no credentials ever leak to the browser or into logs/errors):
 *
 *   Exports:
 *     createGitHubClient(deps) -> { createIssue(input), findIssueByMarker(marker) }
 *       deps: { token, owner, repo, labels?, fetch?, baseUrl?, timeoutMs?, version? }
 *       - token/owner/repo required (factory throws otherwise)
 *       - labels default ['bug', 'in-app-report']
 *       - baseUrl default 'https://api.github.com'
 *       - fetch default global.fetch (injectable for tests)
 *     buildIssueBody(input) -> markdown string (pure)
 *       input: { summary, description, reproSteps, expected, route, view, game,
 *                actorUsername, actorId, timestamp, version, userAgent, marker }
 *       Fixed `## ` heading set; user text is escaped so it can never add a
 *       heading; ends with `<!-- fleetdeck-report-marker: <marker> -->` when a
 *       marker is given, plus a note that the report came from the in-app
 *       reporter.
 *     classifyResponse(status, { retryAfter }) -> { kind, retryable, retryAfterMs? }
 *       200/201 -> ok            (retryable false)
 *       401 -> auth              (retryable false, configuration failure)
 *       403 -> forbidden         (retryable false, configuration failure)
 *       404 -> not_found         (retryable false, repository/config failure)
 *       422 -> validation        (retryable false, report/config failure)
 *       429 -> rate_limit        (retryable true, retryAfterMs from Retry-After
 *                                 seconds, fallback 60_000)
 *       500-599 -> server_error  (retryable true)
 *       anything else -> unknown (retryable false)
 *     redactSecrets(text, token) -> text with the token, ghp_/github_pat_
 *       secrets and 'Bearer <secret>' replaced by '[REDACTED]'
 *     GitHubApiError: { name, message, status, kind, retryable, retryAfterMs }
 *       - message is ALWAYS redacted (GitHub error bodies may echo secrets)
 *
 *   createIssue({ title, body, marker }):
 *     POST {baseUrl}/repos/{owner}/{repo}/issues
 *     Headers: Authorization 'Bearer <token>', Accept
 *     'application/vnd.github+json', Content-Type application/json,
 *     User-Agent starting with 'Hostkind'.
 *     Body: { title: '[In-app report] ' + title (not doubled), body, labels }.
 *     If marker is given but body lacks the marker comment, it is appended.
 *     2xx with { number, html_url } -> { ok: true, issueNumber, issueUrl, status }
 *     2xx without number -> throws kind 'malformed', retryable FALSE (the issue
 *       may exist; only marker reconciliation may safely re-create).
 *     non-2xx -> throws classified GitHubApiError; fetch rejection -> kind
 *       'network', retryable true.
 *
 *   findIssueByMarker(marker):
 *     GET {baseUrl}/search/issues?q=repo:{owner}/{repo}+"<marker>"
 *     -> { issueNumber, issueUrl } for the first hit, or null; non-2xx throws
 *     a classified GitHubApiError.
 */

const assert = require('assert');
const {
  createGitHubClient,
  buildIssueBody,
  classifyResponse,
  redactSecrets,
  GitHubApiError,
} = require('../lib/github-issues.cjs');

const TOKEN = 'ghp_top_secret_token_1234567890';

/* ── helpers ─────────────────────────────────────────────────────── */

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k in headers ? headers[k] : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Capture the wire request; return a fixed response (or throw an Error). */
function captureFetch(responses = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    if (!next) throw new Error('captureFetch: no response queued for call ' + calls.length);
    return next;
  };
  return { calls, fetch };
}

function clientWithFetch(fetch, overrides = {}) {
  return createGitHubClient({
    token: TOKEN,
    owner: 'Riloox',
    repo: 'hostkind-open',
    fetch,
    ...overrides,
  });
}

function sampleBodyInput(overrides = {}) {
  return {
    summary: 'Crash on boot',
    description: 'Panel shows a white screen after upgrade.',
    reproSteps: '1. Start panel\n2. Open dashboard',
    expected: 'Panel should boot normally.',
    route: '/servers',
    view: 'servers',
    game: 'minecraft',
    actorUsername: 'alice',
    actorId: 'user-123',
    timestamp: '2026-08-14T12:00:00.000Z',
    version: '0.1.0',
    userAgent: 'Mozilla/5.0 (fleetdeck test)',
    marker: 'fleetdeck-marker-1',
    ...overrides,
  };
}

const EXPECTED_HEADINGS = [
  '## Summary',
  '## Description',
  '## Current screen',
  '## Game',
  '## Reported by',
  '## Timestamp',
  '## Hostkind version',
  '## Browser',
  '## Reproduction steps',
  '## Expected behaviour',
];

function headingLines(body) {
  return body.split('\n').filter((l) => l.startsWith('#'));
}

/* ── tests ───────────────────────────────────────────────────────── */

const tests = [];

/* 1. createIssue POSTs to the right endpoint with auth and returns the issue. */
tests.push(async () => {
  const { calls, fetch } = captureFetch([
    jsonResponse(201, { number: 42, html_url: 'https://github.com/Riloox/hostkind-open/issues/42' }),
  ]);
  const client = clientWithFetch(fetch);

  const body = buildIssueBody(sampleBodyInput());
  const result = await client.createIssue({ title: 'Crash on boot', body, marker: 'fleetdeck-marker-1' });

  assert.deepStrictEqual(result, {
    ok: true,
    issueNumber: 42,
    issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42',
    status: 201,
  });

  const { url, init } = calls[0];
  assert.strictEqual(url, 'https://api.github.com/repos/Riloox/hostkind-open/issues');
  assert.strictEqual(init.method, 'POST');
  // Header names are matched case-insensitively (implementers may emit either casing).
  const headers = Object.fromEntries(
    Object.entries(init.headers).map(([k, v]) => [String(k).toLowerCase(), v]),
  );
  assert.ok(String(headers.authorization).includes(TOKEN), 'Authorization must carry the token');
  assert.strictEqual(headers.accept, 'application/vnd.github+json');
  assert.strictEqual(headers['content-type'], 'application/json');
  assert.ok(String(headers['user-agent']).startsWith('Hostkind'), 'GitHub requires a Hostkind UA');

  const payload = JSON.parse(init.body);
  assert.strictEqual(payload.title, '[In-app report] Crash on boot');
  assert.deepStrictEqual(payload.labels, ['bug', 'in-app-report']);
  assert.ok(payload.body.includes('fleetdeck-report-marker'), 'marker must ride in the body');

  // The server token never appears in the wire payload or URL.
  assert.ok(!init.body.includes(TOKEN), 'token must not appear in the request body');
  assert.ok(!url.includes(TOKEN), 'token must not appear in the request URL');
  console.log('ok  github-issues createIssue: POST shape, auth, result mapping');
});

/* 2. The title prefix is not doubled when already present. */
tests.push(async () => {
  const { calls, fetch } = captureFetch([
    jsonResponse(201, { number: 1, html_url: 'https://github.com/Riloox/hostkind-open/issues/1' }),
  ]);
  const client = clientWithFetch(fetch);
  await client.createIssue({ title: '[In-app report] Crash', body: 'x' });
  const payload = JSON.parse(calls[0].init.body);
  assert.strictEqual(payload.title, '[In-app report] Crash');
  console.log('ok  github-issues createIssue: title prefix not doubled');
});

/* 3. Custom labels and repo are honoured. */
tests.push(async () => {
  const { calls, fetch } = captureFetch([
    jsonResponse(201, { number: 3, html_url: 'https://github.com/Riloox/hostkind-open/issues/3' }),
  ]);
  const client = clientWithFetch(fetch, { labels: ['custom-label'], repo: 'example-repo', owner: 'example-owner' });
  await client.createIssue({ title: 'T', body: 'b' });
  const { url, init } = calls[0];
  assert.ok(url.endsWith('/repos/example-owner/example-repo/issues'), `unexpected url ${url}`);
  assert.deepStrictEqual(JSON.parse(init.body).labels, ['custom-label']);
  console.log('ok  github-issues createIssue: custom labels and repo');
});

/* 4. buildIssueBody produces the full heading set and every field. */
tests.push(() => {
  const body = buildIssueBody(sampleBodyInput());
  assert.deepStrictEqual(headingLines(body), EXPECTED_HEADINGS, 'heading set must be exactly the contract');
  for (const text of [
    'Crash on boot', 'Panel shows a white screen after upgrade.',
    '1. Start panel', 'Panel should boot normally.',
    '/servers', 'servers', 'minecraft', 'alice', 'user-123',
    '2026-08-14T12:00:00.000Z', '0.1.0', 'Mozilla/5.0 (fleetdeck test)',
  ]) {
    assert.ok(body.includes(text), `body must include field value: ${text}`);
  }
  assert.ok(body.includes('<!-- fleetdeck-report-marker: fleetdeck-marker-1 -->'),
    'machine-readable marker comment required');
  assert.match(body, /in-app reporter/i, 'body must state the report came from the in-app reporter');
  console.log('ok  github-issues buildIssueBody: headings + fields + marker');
});

/* 5. buildIssueBody escapes user text so it can never inject headings. */
tests.push(() => {
  const body = buildIssueBody(sampleBodyInput({
    summary: 'Evil ## Hijack',
    description: '## Fake heading\n# Another fake\n> quoted\n- bullet',
    reproSteps: '## Steal the headings',
  }));
  assert.deepStrictEqual(headingLines(body), EXPECTED_HEADINGS,
    'user text must not create new markdown headings');
  assert.ok(body.includes('Fake heading'), 'escaped text is still readable');
  assert.ok(body.includes('Evil ## Hijack'));
  console.log('ok  github-issues buildIssueBody: heading-injection escaping');
});

/* 6. classifyResponse table: every status class. */
tests.push(() => {
  const cases = [
    [200, {}, { kind: 'ok', retryable: false }],
    [201, {}, { kind: 'ok', retryable: false }],
    [401, {}, { kind: 'auth', retryable: false }],
    [403, {}, { kind: 'forbidden', retryable: false }],
    [404, {}, { kind: 'not_found', retryable: false }],
    [422, {}, { kind: 'validation', retryable: false }],
    [429, {}, { kind: 'rate_limit', retryable: true, retryAfterMs: 60_000 }],
    [429, { retryAfter: '120' }, { kind: 'rate_limit', retryable: true, retryAfterMs: 120_000 }],
    [500, {}, { kind: 'server_error', retryable: true }],
    [502, {}, { kind: 'server_error', retryable: true }],
    [503, {}, { kind: 'server_error', retryable: true }],
    [418, {}, { kind: 'unknown', retryable: false }],
  ];
  for (const [status, opts, expected] of cases) {
    const got = classifyResponse(status, opts);
    assert.strictEqual(got.kind, expected.kind, `status ${status} kind`);
    assert.strictEqual(got.retryable, expected.retryable, `status ${status} retryable`);
    if (expected.retryAfterMs !== undefined) {
      assert.strictEqual(got.retryAfterMs, expected.retryAfterMs, `status ${status} retryAfterMs`);
    }
  }
  console.log('ok  github-issues classifyResponse: full status table');
});

/* 7. 401/403/404/422 are non-retryable configuration failures. */
tests.push(async () => {
  for (const [status, kind] of [[401, 'auth'], [403, 'forbidden'], [404, 'not_found'], [422, 'validation']]) {
    const { fetch } = captureFetch([jsonResponse(status, { message: `msg ${status}` })]);
    const client = clientWithFetch(fetch);
    let err = null;
    try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
    assert.ok(err, `status ${status} must throw`);
    assert.ok(err instanceof GitHubApiError, `status ${status} must throw GitHubApiError`);
    assert.strictEqual(err.status, status);
    assert.strictEqual(err.kind, kind);
    assert.strictEqual(err.retryable, false, `status ${status} must not be retried`);
  }
  console.log('ok  github-issues createIssue: 401/403/404/422 classified non-retryable');
});

/* 8. A GitHub error body that echoes the token is redacted in the error. */
tests.push(async () => {
  const { fetch } = captureFetch([
    jsonResponse(422, { message: `Validation Failed token=${TOKEN}` }),
  ]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(err.message.includes('Validation Failed'), 'GitHub message text is preserved');
  assert.ok(!err.message.includes(TOKEN), 'token must never surface in the error message');
  console.log('ok  github-issues createIssue: error bodies redacted');
});

/* 9. 429 is retryable and honours Retry-After. */
tests.push(async () => {
  const { fetch } = captureFetch([
    jsonResponse(429, { message: 'API rate limit exceeded' }, { 'retry-after': '120' }),
  ]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.kind, 'rate_limit');
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.retryAfterMs, 120_000, 'Retry-After seconds must become ms');
  console.log('ok  github-issues createIssue: 429 rate limit + Retry-After');
});

/* 10. 5xx is retryable. */
tests.push(async () => {
  const { fetch } = captureFetch([jsonResponse(500, { message: 'server exploded' })]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.kind, 'server_error');
  assert.strictEqual(err.retryable, true);
  console.log('ok  github-issues createIssue: 5xx retryable');
});

/* 11. Network failure is retryable and its message is redacted. */
tests.push(async () => {
  const { fetch } = captureFetch([new TypeError('fetch failed: https://api.github.com ' + TOKEN)]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.kind, 'network');
  assert.strictEqual(err.retryable, true);
  assert.ok(!err.message.includes(TOKEN), 'fetch error text must be redacted');
  console.log('ok  github-issues createIssue: network failure retryable + redacted');
});

/* 12. A 2xx response without a number is malformed and NOT retried. */
tests.push(async () => {
  const { fetch } = captureFetch([jsonResponse(201, { html_url: 'https://example.com/nope' })]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.createIssue({ title: 'T', body: 'b' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.kind, 'malformed');
  assert.strictEqual(err.retryable, false, 'issue may exist; only marker reconciliation may re-create');
  console.log('ok  github-issues createIssue: malformed 2xx classified');
});

/* 13. findIssueByMarker searches and resolves an existing issue. */
tests.push(async () => {
  const { calls, fetch } = captureFetch([
    jsonResponse(200, { items: [{ number: 99, html_url: 'https://github.com/Riloox/hostkind-open/issues/99' }] }),
  ]);
  const client = clientWithFetch(fetch);
  const hit = await client.findIssueByMarker('fleetdeck-marker-1');
  assert.deepStrictEqual(hit, {
    issueNumber: 99,
    issueUrl: 'https://github.com/Riloox/hostkind-open/issues/99',
  });
  assert.ok(calls[0].url.includes('/search/issues'), `expected search URL, got ${calls[0].url}`);
  assert.ok(calls[0].url.includes('repo%3ARiloox%2Fhostkind-open'), 'search must be scoped to the repo');
  assert.ok(calls[0].url.includes(encodeURIComponent('"fleetdeck-marker-1"')), 'marker must be quoted');
  console.log('ok  github-issues findIssueByMarker: hit resolution');
});

/* 14. findIssueByMarker returns null when nothing matches. */
tests.push(async () => {
  const { fetch } = captureFetch([jsonResponse(200, { items: [] })]);
  const client = clientWithFetch(fetch);
  assert.strictEqual(await client.findIssueByMarker('fleetdeck-marker-2'), null);
  console.log('ok  github-issues findIssueByMarker: no match -> null');
});

/* 15. findIssueByMarker failures throw classified errors. */
tests.push(async () => {
  const { fetch } = captureFetch([jsonResponse(403, { message: 'search quota exceeded' })]);
  const client = clientWithFetch(fetch);
  let err = null;
  try { await client.findIssueByMarker('fleetdeck-marker-3'); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.kind, 'forbidden');
  assert.strictEqual(err.retryable, false);
  console.log('ok  github-issues findIssueByMarker: classified failure');
});

/* 16. redactSecrets strips every secret form and keeps plain text. */
tests.push(() => {
  const input = [
    'boom', TOKEN,
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345678',
    'Bearer ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'keep me',
  ].join(' ');
  const out = redactSecrets(input, TOKEN);
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345678'));
  assert.ok(!out.includes('Bearer ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzz'));
  assert.ok(out.includes('boom'));
  assert.ok(out.includes('keep me'));
  assert.ok(out.includes('[REDACTED]'));
  console.log('ok  github-issues redactSecrets: token, PATs, Bearer forms');
});

/* 17. The factory refuses to run without token/owner/repo. */
tests.push(() => {
  assert.throws(() => createGitHubClient({ owner: 'Riloox', repo: 'hostkind-open' }), /token/i);
  assert.throws(() => createGitHubClient({ token: TOKEN, repo: 'hostkind-open' }), /owner/i);
  assert.throws(() => createGitHubClient({ token: TOKEN, owner: 'Riloox' }), /repo/i);
  console.log('ok  github-issues factory: token/owner/repo required');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i](); }
    catch (e) {
      failed++;
      console.error(`FAIL  github-issues test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  if (failed) { console.error(`FAIL  ${failed} github-issues test(s) failed`); process.exit(1); }
  console.log(`PASS  github-issues (${tests.length} tests)`);
})();
