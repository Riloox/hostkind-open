'use strict';

/*
 * bug-reports-routes — API contract for the bug-report feature
 * (plan: .hermes/plans/2026-08-14_235510-report-bug-github.md, Task 4).
 *
 * Test-first: lib/routes/bug-reports.cjs does not exist yet. This file pins the
 * router contract the implementation must satisfy:
 *
 *   module.exports = function bugReportsRouter(deps) { ... }  // express.Router()
 *
 * server.js is expected to mount it WITHOUT server scoping:
 *   app.use('/api', bugReportsRouter({ ...deps }))            // no X-Hostkind-Server-Id
 *
 * Routes (relative to the /api mount):
 *   POST /bug-reports            create a report (authenticated, per-user throttled)
 *   GET  /bug-reports/:id        owner-only; admins may read any report
 *   PUT  /config/bug-reports     admin-only; update non-secret settings, redacted reply
 *
 * Injected deps (no live network; mirrors how server.js will wire it):
 *   deps.bugReports     { create(input) -> report, get(id) -> report|null }
 *   deps.syncReport     async (report) -> { state:'pending'|'synced'|'failed',
 *                                           issueUrl, issueNumber, error } — must NOT throw
 *   deps.audit          lib/audit.cjs (real: redaction + storage verified here)
 *   deps.getConfig      () -> current bugReports config block
 *   deps.normalizeConfig/redactConfig   lib/bug-report-config.cjs contract
 *   deps.saveConfig     (next) => void
 *   deps.throttleLimits { max, windowMs }  optional; defaults { max: 5, windowMs: 60000 }
 *   deps.panelVersion   () -> version string (optional)
 *
 * HTTP contract pinned here:
 *   - POST: 401 unauthenticated; 400 validation (title_required,
 *     description_required, title_too_long, description_too_long,
 *     field_too_long); 429 rate_limited { retryAfter }; 201 { report, sync }
 *     on success INCLUDING GitHub outage (non-5xx, recoverable pending).
 *     The report row is persisted BEFORE any sync attempt; the response never
 *     contains a token or other secret. Redaction of sync error text happens
 *     in the sync module before it reaches the stored row or the response
 *     (Task 3 contract; faked here against the real lib/redact.cjs).
 *   - GET /:id: 401 / 403 / 404 / 200 (owner or admin).
 *   - PUT /config/bug-reports: 401 / 403 / 400 invalid_config / 200
 *     { ok:true, config } with the token absent; a token in the request body
 *     is ignored (rotation is environment-driven, never browser-driven).
 *   - Audit: bug_report.created and bug_report.sync events with reportId and
 *     sync outcome in metadata, NEVER the report body or secrets.
 *
 * Sync states (Task 2 schema): 'pending' | 'synced' | 'failed'.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const audit = require('../lib/audit.cjs');

const ROUTER_MODULE = '../lib/routes/bug-reports.cjs';

let bugReportsRouter;
try {
  bugReportsRouter = require(ROUTER_MODULE);
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('bug-reports')) {
    // Expected in test-first wave 1: the router (Task 4) has not landed yet.
    console.error(`PENDING bug-reports-routes: ${ROUTER_MODULE} not implemented yet (test-first wave 1; expected failure until Task 4 lands).`);
    process.exit(1);
  }
  throw err;
}

// --- contract constants (implementation must match or these tests fail) -----
const LIMITS = {
  titleMax: 200,
  descriptionMax: 8000,
  optionalMax: 4000, // reproduction/expected
  contextMax: 200,   // game/view/route/userAgent
};
// JWT-shaped so the repo's real redactor (lib/redact.cjs) masks it: a router
// that leaks a token-shaped sync error into the response fails these tests.
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.test_sig_123456789';

// --- injected data-layer fake ------------------------------------------------
// The real SQLite-backed module (Task 2) is covered by test/bug-reports.test.cjs.
// Here the router is exercised against a deterministic in-memory store so the
// ordering contract (persist BEFORE sync) and response shaping are what is
// under test.
const rows = new Map();
let seq = 0;
const callOrder = [];
const syncEntryStates = [];
const bugReports = {
  create(input) {
    callOrder.push('create');
    const rec = {
      id: `rep-${++seq}`,
      createdAt: new Date().toISOString(),
      ...input,
      syncState: 'pending',
      issueNumber: null,
      issueUrl: null,
      lastError: null,
    };
    rows.set(rec.id, rec);
    return rec;
  },
  get(id) { return rows.get(id) || null; },
};

// --- injected sync fake ------------------------------------------------------
// Mirrors the Task 3 sync-module contract: errors are redacted with the repo's
// shared redactor BEFORE they reach the stored row or the response, so a
// token-shaped error can never leak into report.lastError / sync.error.
const { redactString } = require('../lib/redact.cjs');
let syncBehavior = async () => ({ state: 'synced', issueNumber: 1, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/1', error: null });
const syncReport = async (report) => {
  callOrder.push('sync');
  const rowAtEntry = rows.get(report.id);
  syncEntryStates.push(rowAtEntry ? rowAtEntry.syncState : null);
  const result = await syncBehavior(report);
  const error = typeof result.error === 'string' ? redactString(result.error).text : result.error;
  const row = rows.get(report.id);
  if (row) {
    rows.set(report.id, {
      ...row,
      syncState: result.state,
      issueNumber: result.issueNumber ?? null,
      issueUrl: result.issueUrl ?? null,
      lastError: error,
    });
  }
  return { ...result, error };
};

// --- injected config deps ----------------------------------------------------
// Stand-ins for lib/bug-report-config.cjs (that module's contract is pinned in
// test/bug-reports-config.test.cjs); when the real module exists it is used so
// both files agree on one contract.
let normalizeConfig = (input = {}, env = {}) => {
  const owner = typeof input.owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(input.owner) && input.owner.length <= 39 ? input.owner : null;
  const repo = typeof input.repo === 'string' && /^[A-Za-z0-9_.-]+$/.test(input.repo) && input.repo.length <= 100 ? input.repo : null;
  const errors = [];
  if (owner === null) errors.push('invalid_owner');
  if (repo === null) errors.push('invalid_repo');
  return {
    enabled: input.enabled === true && errors.length === 0,
    owner: owner || 'Riloox',
    repo: repo || 'hostkind-open',
    labels: Array.isArray(input.labels) ? input.labels.filter((l) => typeof l === 'string' && l.trim()) : ['bug'],
    token: env.FLEETDECK_GITHUB_TOKEN || (typeof input.token === 'string' && input.token.trim()) || null,
    errors,
  };
};
let redactConfig = (cfg) => { const c = { ...cfg }; delete c.token; return c; };
try {
  const real = require('../lib/bug-report-config.cjs');
  if (typeof real.normalizeConfig === 'function') normalizeConfig = real.normalizeConfig;
  if (typeof real.redactConfig === 'function') redactConfig = real.redactConfig;
} catch { /* fall back to the stand-ins above */ }

let currentConfigBlock = { enabled: false, owner: 'Riloox', repo: 'hostkind-open', labels: ['bug'] };
let savedConfig = null;
const deps = {
  bugReports,
  syncReport,
  audit,
  getConfig: () => currentConfigBlock,
  normalizeConfig,
  redactConfig,
  saveConfig: (next) => { savedConfig = next; currentConfigBlock = next; },
  throttleLimits: { max: 3, windowMs: 60000 },
  panelVersion: () => '0.1.0',
};

// --- harness: express app + stub auth, mounted WITHOUT server scoping --------
function makeHarness() {
  const state = { user: null };
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => { req.user = state.user; next(); });
  app.use('/api', bugReportsRouter(deps));
  // Body-parser errors (e.g. the 64kb limit) answer JSON instead of express's
  // noisy HTML error page, so the 413 test output stays deterministic.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    next(err);
  });
  return { state, app };
}

// Every test that POSTs gets a FRESH user: the per-user throttle (max 3
// attempts/window, counting attempts) must never bleed into another test.
let userSeq = 0;
const freshUser = (role = 'operator') => {
  userSeq += 1;
  return { id: `user-${userSeq}`, role, username: `u${userSeq}` };
};
const users = {
  alice: { id: 'alice-1', role: 'operator', username: 'alice' }, // audit assertions key on this id
  admin: { id: 'admin-1', role: 'admin', username: 'root' },
};

const validBody = (over = {}) => ({
  title: 'Panel crashes on restart',
  description: 'After saving watchdog settings the panel exits and never comes back.',
  reproduction: '1. Open Settings\n2. Toggle watchdog\n3. Save',
  expected: 'Settings are persisted without a restart.',
  game: 'minecraft',
  view: 'settings',
  route: '/games/minecraft/settings',
  ...over,
});

// --- test runner -------------------------------------------------------------
const tests = [];

tests.push({ name: 'unauthenticated POST is rejected with 401 and nothing is persisted', fn: async (h) => {
  h.state.user = null;
  const before = rows.size;
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody()),
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'unauthorized');
  assert.strictEqual(rows.size, before, 'no row may be created for an unauthenticated request');
  assert.ok(!callOrder.includes('sync'), 'no sync may run for an unauthenticated request');
}});

tests.push({ name: 'unauthenticated GET and PUT are rejected with 401', fn: async (h) => {
  h.state.user = null;
  let res = await fetch(`${h.base}/api/bug-reports/rep-1`);
  assert.strictEqual(res.status, 401);
  res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.strictEqual(res.status, 401);
}});

tests.push({ name: 'valid report: persisted BEFORE sync, returns { report, sync } with synced state', fn: async (h) => {
  h.state.user = freshUser();
  callOrder.length = 0; syncEntryStates.length = 0;
  syncBehavior = async () => ({ state: 'synced', issueNumber: 42, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42', error: null });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody()),
  });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.ok(body.report && body.sync, 'response must be { report, sync }');
  assert.ok(body.report.id, 'report must carry an id');
  assert.strictEqual(body.report.title, 'Panel crashes on restart');
  assert.strictEqual(body.report.description, 'After saving watchdog settings the panel exits and never comes back.');
  assert.deepStrictEqual(callOrder, ['create', 'sync'], 'the report must be persisted before sync is attempted');
  assert.deepStrictEqual(syncEntryStates, ['pending'], 'the row must already be durable (pending) when sync starts');
  assert.strictEqual(body.sync.state, 'synced');
  assert.strictEqual(body.sync.issueNumber, 42);
  assert.strictEqual(body.sync.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/42');
  assert.strictEqual(body.report.syncState, 'synced', 'report.syncState must mirror the sync outcome');
}});

tests.push({ name: 'server-scope header is NOT required and is ignored', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'pending', error: null });
  let res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody({ title: 'No server header' })),
  });
  assert.strictEqual(res.status, 201, 'POST without X-Hostkind-Server-Id must succeed');
  let body = await res.json();
  assert.ok(!('serverId' in body.report), 'reports are not tied to a game server');

  res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetdeck-server-id': 'some-server-1' },
    body: JSON.stringify(validBody({ title: 'With server header' })),
  });
  assert.strictEqual(res.status, 201, 'an X-Hostkind-Server-Id header must not scope the report');
  body = await res.json();
  assert.ok(!('serverId' in body.report));
}});

tests.push({ name: 'title is required (missing / empty / whitespace -> 400 title_required)', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  for (const title of [undefined, '', '   ']) {
    const payload = validBody();
    if (title === undefined) delete payload.title; else payload.title = title;
    const res = await fetch(`${h.base}/api/bug-reports`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.strictEqual(res.status, 400, `title ${JSON.stringify(title)} must be rejected`);
    assert.strictEqual((await res.json()).error, 'title_required');
  }
  assert.strictEqual(rows.size, before, 'invalid reports must not be persisted');
}});

tests.push({ name: 'description is required (missing -> 400 description_required)', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  const payload = validBody();
  delete payload.description;
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'description_required');
  assert.strictEqual(rows.size, before);
}});

tests.push({ name: 'title longer than 200 chars -> 400 title_too_long, not persisted', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ title: 'x'.repeat(LIMITS.titleMax + 1) })),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'title_too_long');
  assert.strictEqual(rows.size, before);
}});

tests.push({ name: 'description longer than 8000 chars -> 400 description_too_long', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ description: 'y'.repeat(LIMITS.descriptionMax + 1) })),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'description_too_long');
  assert.strictEqual(rows.size, before);
}});

tests.push({ name: 'oversized optional fields -> 400 field_too_long', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  for (const over of [
    { reproduction: 'r'.repeat(LIMITS.optionalMax + 1) },
    { expected: 'e'.repeat(LIMITS.optionalMax + 1) },
    { game: 'g'.repeat(LIMITS.contextMax + 1) },
  ]) {
    const res = await fetch(`${h.base}/api/bug-reports`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody(over)),
    });
    assert.strictEqual(res.status, 400, `oversized ${Object.keys(over)[0]} must be rejected`);
    assert.strictEqual((await res.json()).error, 'field_too_long');
  }
  assert.strictEqual(rows.size, before);
}});

tests.push({ name: 'raw body over the mount limit is rejected (413, harness-level)', fn: async (h) => {
  h.state.user = freshUser();
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ description: 'z'.repeat(1024 * 1024) })),
  });
  assert.strictEqual(res.status, 413, 'express.json limit must reject oversized raw bodies before the handler');
}});

tests.push({ name: 'per-user throttling: 4th authenticated POST within the window -> 429 rate_limited', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'synced', issueNumber: 7, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/7', error: null });
  for (let i = 1; i <= deps.throttleLimits.max; i++) {
    const res = await fetch(`${h.base}/api/bug-reports`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ title: `Throttled report ${i}` })),
    });
    assert.strictEqual(res.status, 201, `request ${i} within limit must succeed`);
  }
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ title: 'Throttled report 4' })),
  });
  assert.strictEqual(res.status, 429);
  const body = await res.json();
  assert.strictEqual(body.error, 'rate_limited');
  assert.ok(Number.isFinite(Number(body.retryAfter)) && Number(body.retryAfter) >= 0, 'retryAfter seconds expected');
}});

tests.push({ name: 'throttling is per-user: a different user is not throttled', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'pending', error: null });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody({ title: 'Other user' })),
  });
  assert.strictEqual(res.status, 201);
}});

tests.push({ name: 'GitHub outage: report persisted, 201 (non-5xx), sync.state pending, recoverable', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  syncBehavior = async () => ({ state: 'pending', error: 'github_unavailable: connect ECONNREFUSED', issueUrl: null, issueNumber: null });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ title: 'Outage report' })),
  });
  assert.strictEqual(res.status, 201, 'a GitHub outage must not fail the request after local persistence');
  assert.ok(rows.size > before, 'the report must survive the outage');
  const body = await res.json();
  assert.strictEqual(body.sync.state, 'pending');
  assert.ok(body.sync.error, 'the sync error should be surfaced for diagnostics');
  assert.strictEqual(body.report.syncState, 'pending');
}});

tests.push({ name: 'sync crash (rejected promise) never fails the request after persistence', fn: async (h) => {
  h.state.user = freshUser();
  const before = rows.size;
  syncBehavior = async () => { throw new Error('boom'); };
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ title: 'Crashy sync' })),
  });
  assert.strictEqual(res.status, 201, 'sync failures must be contained after the row is saved');
  assert.ok(rows.size > before);
  const body = await res.json();
  assert.strictEqual(body.sync.state, 'failed');
  assert.ok(body.sync.error, 'the failure reason should be present for retry diagnostics');
}});

tests.push({ name: 'not_configured sync response carries the trackerUrl fallback link', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'pending', reason: 'not_configured', trackerUrl: 'https://github.com/Riloox/hostkind-open/issues/new/choose', issueUrl: null, issueNumber: null, error: null, message: 'Bug-report sync is not configured.' });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody({ title: 'No relay configured' })),
  });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.strictEqual(body.sync.state, 'pending');
  assert.strictEqual(body.sync.reason, 'not_configured');
  assert.strictEqual(body.sync.trackerUrl, 'https://github.com/Riloox/hostkind-open/issues/new/choose');
  assert.ok(!JSON.stringify(body).includes('token'), 'no secret-shaped text in the response');
}});

tests.push({ name: 'sync response omits trackerUrl when the summary has none', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'pending', reason: 'not_configured', issueUrl: null, issueNumber: null, error: null });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody({ title: 'No tracker link' })),
  });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.strictEqual(body.sync.trackerUrl, null);
}});

tests.push({ name: 'no token (or secret-shaped key) appears in any POST response', fn: async (h) => {
  h.state.user = freshUser();
  syncBehavior = async () => ({ state: 'failed', error: `token ${FAKE_TOKEN} leaked?`, issueUrl: null, issueNumber: null });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody({ title: 'Token hygiene' })),
  });
  const text = await res.text();
  assert.ok(!text.includes(FAKE_TOKEN), 'the GitHub token must never appear in a response');
  assert.ok(!text.includes('"token"'), 'no token key may be serialized into the response');
  const body = JSON.parse(text);
  assert.ok(!('token' in body.report) && !('token' in body.sync));
}});

tests.push({ name: 'audit: bug_report.created recorded with reportId, no report body or secrets', fn: async (h) => {
  h.state.user = users.alice;
  syncBehavior = async () => ({ state: 'synced', issueNumber: 9, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/9', error: null });
  const payload = validBody({ title: 'Audit me', description: 'super-secret-description-text-xyz' });
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.strictEqual(res.status, 201);
  const { report } = await res.json();
  const list = audit.list({ actorId: 'alice-1' });
  const created = list.items.find((e) => e.action === 'bug_report.created' && e.metadata && e.metadata.reportId === report.id);
  assert.ok(created, 'a bug_report.created audit event with the report id must exist');
  assert.strictEqual(created.outcome, 'success');
  const meta = created.metadata;
  assert.ok(!('description' in meta), 'audit metadata must not carry the report body');
  assert.ok(!('title' in meta), 'audit metadata must not carry the report title');
  assert.ok(!('token' in meta) && !('secret' in meta), 'audit metadata must not carry secrets');
  assert.ok(!JSON.stringify(meta).includes('super-secret-description-text-xyz'), 'report body text must not leak into audit metadata');
}});

tests.push({ name: 'audit: bug_report.sync recorded with issue metadata, no body', fn: async (h) => {
  const list = audit.list({ actorId: 'alice-1' });
  const syncEvents = list.items.filter((e) => e.action === 'bug_report.sync');
  assert.ok(syncEvents.length >= 1, 'at least one bug_report.sync event must exist for alice');
  const ev = syncEvents.find((e) => e.metadata && e.metadata.issueNumber === 9);
  assert.ok(ev, 'sync audit event must carry the GitHub issue number');
  // Exact URL check: parse first, then pin protocol and hostname exactly. A
  // substring check would pass for lookalike hosts (e.g. github.com.evil.example).
  const issueUrl = new URL(ev.metadata.issueUrl);
  assert.strictEqual(issueUrl.protocol, 'https:', 'sync audit event issue url must be https');
  assert.strictEqual(issueUrl.hostname, 'github.com', 'sync audit event must carry a github.com issue url');
  assert.ok(!('description' in ev.metadata) && !('token' in ev.metadata));
  assert.ok(!JSON.stringify(ev.metadata).includes('super-secret-description-text-xyz'));
}});

tests.push({ name: 'GET ownership: owner 200, other user 403, admin 200, unknown 404', fn: async (h) => {
  h.state.user = freshUser();
  const res = await fetch(`${h.base}/api/bug-reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ title: 'Ownership probe' })),
  });
  assert.strictEqual(res.status, 201);
  const { report } = await res.json();

  h.state.user = users.admin;
  let r = await fetch(`${h.base}/api/bug-reports/${report.id}`);
  assert.strictEqual(r.status, 200, 'admins may inspect any report (support workflow)');
  let body = await r.json();
  assert.strictEqual(body.report.id, report.id);
  assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN));

  h.state.user = freshUser();
  r = await fetch(`${h.base}/api/bug-reports/${report.id}`);
  assert.strictEqual(r.status, 403, 'another user must not read someone else\'s report');
  assert.strictEqual((await r.json()).error, 'forbidden');

  h.state.user = null;
  r = await fetch(`${h.base}/api/bug-reports/${report.id}`);
  assert.strictEqual(r.status, 401, 'unauthenticated GET must be rejected');

  h.state.user = users.admin;
  r = await fetch(`${h.base}/api/bug-reports/rep-does-not-exist`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await r.json()).error, 'not_found');
}});

tests.push({ name: 'PUT /config/bug-reports is admin-only (operator -> 403)', fn: async (h) => {
  h.state.user = freshUser(); // operator role by default
  const res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, owner: 'Riloox', repo: 'hostkind-open' }),
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).error, 'forbidden');
  assert.strictEqual(savedConfig, null, 'a non-admin must not be able to change config');
}});

tests.push({ name: 'PUT /config/bug-reports: admin updates settings, response config is redacted', fn: async (h) => {
  h.state.user = users.admin;
  savedConfig = null;
  const res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, owner: 'Acme-Corp', repo: 'support-issues', labels: ['bug', 'in-app-report'] }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  assert.ok(body.config, 'response must include the updated config');
  assert.strictEqual(body.config.owner, 'Acme-Corp');
  assert.strictEqual(body.config.repo, 'support-issues');
  assert.ok(!('token' in body.config), 'config responses must never expose the token');
  assert.ok(savedConfig, 'saveConfig must have been called with the normalized block');
  assert.strictEqual(savedConfig.owner, 'Acme-Corp');
  assert.deepStrictEqual(savedConfig.labels, ['bug', 'in-app-report']);
}});

tests.push({ name: 'PUT /config/bug-reports: invalid owner/repo -> 400 invalid_config, nothing saved', fn: async (h) => {
  h.state.user = users.admin;
  const before = JSON.stringify(savedConfig);
  const res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'bad owner!', repo: 'bad/repo' }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'invalid_config');
  assert.strictEqual(JSON.stringify(savedConfig), before, 'invalid config must not be saved');
}});

tests.push({ name: 'PUT /config/bug-reports: token in body is ignored (env-driven rotation)', fn: async (h) => {
  h.state.user = users.admin;
  savedConfig = null;
  const res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, owner: 'Riloox', repo: 'hostkind-open', token: FAKE_TOKEN }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN), 'a browser-supplied token must never be stored or echoed');
  assert.ok(savedConfig, 'saveConfig must have been called');
  assert.ok(!('token' in savedConfig) || savedConfig.token === null || savedConfig.token === undefined,
    'the saved config block must not hold a browser-supplied token');
  assert.ok(!('token' in body.config));
}});

tests.push({ name: 'PUT /config/bug-reports: response redacts an env-configured token', fn: async (h) => {
  h.state.user = users.admin;
  savedConfig = null;
  const res = await fetch(`${h.base}/api/config/bug-reports`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, owner: 'Riloox', repo: 'hostkind-open' }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(!('token' in body.config), 'redactConfig must strip the token even when one exists server-side');
}});

// --- boot --------------------------------------------------------------------
async function main() {
  migrations.runMigrations();
  const h = makeHarness();
  const server = http.createServer(h.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  h.base = `http://127.0.0.1:${server.address().port}`;

  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i].fn(h); console.log(`ok  bug-reports-routes test ${i + 1}: ${tests[i].name}`); }
    catch (e) { failed++; console.error(`FAIL bug-reports-routes test ${i + 1}: ${tests[i].name}: ${e.message}`); }
  }

  await new Promise((resolve) => server.close(resolve));
  close();
  teardown();
  if (failed) { console.error(`FAIL  ${failed} bug-reports-routes test(s) failed`); process.exit(1); }
  console.log('PASS  bug-reports-routes');
}

main().catch((err) => {
  console.error(err);
  close();
  teardown();
  process.exit(1);
});
