'use strict';

/*
 * application-update-routes — API contract for the application updater
 * (gauntlet contract: .gauntlet/application-updater-contract.md).
 *
 * Contract test for the landed router implementation:
 *
 *   module.exports = function applicationUpdateRouter(deps) { ... }  // express.Router()
 *
 * The lead wires it in server.js with:
 *   app.use('/api', applicationUpdateRouter({ service, fetchImpl }))
 *
 * Router paths (relative to the /api mount, mirroring lib/routes/bug-reports.cjs):
 *   GET  /application-update/status    never performs network I/O
 *   POST /application-update/check     refreshes release metadata
 *   POST /application-update/download  requires an available update; stages only
 *   POST /application-update/install   requires ready + approval (or high priority)
 *
 * Injected deps (no live network; mirrors the service contract):
 *   deps.service  mirrors createApplicationUpdater(...) from the core contract:
 *                 { getStatus(), check(), download(), install({ approved }) }
 *                 Methods may be sync or async; the router must await them,
 *                 catch every failure, and never let a throw escape (the route
 *                 module must not terminate the process).
 *   deps.fetchImpl (optional) is a TRIPWIRE: routes must never perform network
 *                 I/O themselves; any invocation fails the current test.
 *
 * Response envelopes (contract):
 *   success: { ok: true, status: <status object exactly as the service returned it> }
 *   error:   { ok: false, error: { code, message } }  (never a `status` field)
 *
 * Service failure mapping (this router's contract):
 *   code 'invalid_transition' -> HTTP 409  (contract: invalid transitions return 409)
 *   code 'approval_required'  -> HTTP 409  (approval-policy conflict)
 *   any other typed {code,message} error   -> HTTP 502 (upstream: GitHub/installer)
 *   anything else (raw throw)              -> HTTP 500 { code: 'internal_error' }
 *
 * Auth boundary at the route seam. The router re-checks req.user (same
 * convention as lib/routes/bug-reports.cjs; the server.js /api middleware adds
 * the real auth on top). Rejected requests must never invoke any service method:
 *   req.user missing         -> 401 { error: 'unauthorized' }  (existing response)
 *   req.user.role !== admin  -> 403 { error: 'forbidden' }     (existing response)
 *
 * Approval forwarding:
 *   The router forwards approved: (body.approved === true) to service.install;
 *   it does NOT read priority itself — the service owns approval policy. The
 *   high-priority path is exercised with a service whose policy permits
 *   unapproved installs when status.priority === 'high'.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

const ROUTER_MODULE = '../lib/routes/application-update.cjs';

let applicationUpdateRouter;
try {
  applicationUpdateRouter = require(ROUTER_MODULE);
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('application-update')) {
    console.error(`application-update-routes: missing router module ${ROUTER_MODULE}`);
    process.exit(1);
  }
  throw err;
}

// --- injected service fake ---------------------------------------------------
// Mirrors createApplicationUpdater(...) from the core contract. It owns the
// state machine and the approval policy (as the real service will); the ROUTER
// must forward calls, await results, and echo statuses untouched.
const TYPED = (code, message) => Object.assign(new Error(message), { code, message });

function makeService({ state = 'idle', priority = 'normal' } = {}) {
  const status = {
    state,
    priority,
    currentVersion: '1.0.0',
    checkedAt: null,
    updateAvailable: false,
    version: null,
    packagePath: null,
  };
  const calls = [];
  const hooks = { check: null, download: null, install: null, getStatus: null };
  const svc = {
    calls,
    hooks,
    priority: () => status.priority,
    getStatus() {
      calls.push(['getStatus']);
      if (hooks.getStatus) return hooks.getStatus();
      svc.lastStatus = { ...status };
      return svc.lastStatus;
    },
    async check() {
      calls.push(['check']);
      if (hooks.check) return hooks.check();
      if (status.state !== 'idle' && status.state !== 'failed') {
        throw TYPED('invalid_transition', 'check is only allowed from idle');
      }
      status.state = 'available';
      status.updateAvailable = true;
      status.version = '1.2.3';
      status.checkedAt = '2026-08-25T12:00:00.000Z';
      return { ...status };
    },
    async download() {
      calls.push(['download']);
      if (hooks.download) return hooks.download();
      if (status.state !== 'available') {
        throw TYPED('invalid_transition', 'no available update to download');
      }
      status.state = 'ready';
      status.packagePath = 'C:/staged/hostkind-1.2.3-windows-x64.exe';
      return { ...status };
    },
    async install({ approved }) {
      calls.push(['install', { approved }]);
      if (hooks.install) return hooks.install({ approved });
      if (status.state !== 'ready') {
        throw TYPED('invalid_transition', 'update is not ready to install');
      }
      if (status.priority !== 'high' && approved !== true) {
        throw TYPED('approval_required', 'normal-priority updates require explicit approval');
      }
      status.state = 'restarting';
      return { ...status };
    },
  };
  return svc;
}

// --- harness: express app + stub auth, mounted WITHOUT server scoping --------
// The stub middleware plays the role of the server.js /api auth middleware on
// top of the router; the router must re-check req.user itself (route seam).
function makeHarness(service) {
  const state = { user: null };
  const networkCalls = { count: 0 };
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => { req.user = state.user; next(); });
  app.use('/api', applicationUpdateRouter({
    service,
    // Tripwire: routes must never touch the network themselves. Any call fails
    // its test via the recorded counter (and throws, in case it is awaited).
    fetchImpl: async () => { networkCalls.count += 1; throw new Error('route performed network I/O'); },
  }));
  return { state, networkCalls, app };
}

const users = {
  admin: { id: 'admin-1', role: 'admin', username: 'root' },
  operator: { id: 'op-1', role: 'operator', username: 'alice' },
};

// --- test runner -------------------------------------------------------------
const tests = [];

// Every POST gets a bounded signal: a broken router (unhandled rejection in an
// express 4 async handler) must fail the test, not hang the suite forever.
function request(base, method, url, body, user) {
  const headers = { 'content-type': 'application/json' };
  const options = { method, headers, signal: AbortSignal.timeout(5000) };
  if (body !== undefined) options.body = JSON.stringify(body);
  return fetch(`${base}${url}`, options);
}

async function withServer({ service, run }) {
  let server;
  try {
    const harness = makeHarness(service);
    server = http.createServer(harness.app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    harness.base = `http://127.0.0.1:${server.address().port}`;
    harness.service = service;
    await run(harness);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

tests.push({ name: 'unauthenticated requests are rejected 401 on every route and never reach the service', fn: async () => {
  await withServer({
    service: makeService(),
    async run(h) {
      h.state.user = null;
      for (const [method, url] of [
        ['GET', '/api/application-update/status'],
        ['POST', '/api/application-update/check'],
        ['POST', '/api/application-update/download'],
        ['POST', '/api/application-update/install'],
      ]) {
        const res = await request(h.base, method, url, method === 'POST' ? {} : undefined, null);
        assert.strictEqual(res.status, 401, `${method} ${url} must be 401`);
        const body = await res.json();
        assert.strictEqual(body.error, 'unauthorized', `${method} ${url} must answer the existing authorization response`);
      }
      assert.strictEqual(h.service.calls.length, 0, 'no service method may run for unauthenticated requests');
      assert.strictEqual(h.networkCalls.count, 0, 'no network I/O may occur');
    },
  });
}});

tests.push({ name: 'non-admin users get the existing 403 forbidden response and cannot invoke install', fn: async () => {
  await withServer({
    service: makeService(),
    async run(h) {
      h.state.user = users.operator;
      for (const [method, url] of [
        ['GET', '/api/application-update/status'],
        ['POST', '/api/application-update/check'],
        ['POST', '/api/application-update/download'],
        ['POST', '/api/application-update/install'],
      ]) {
        const res = await request(h.base, method, url, method === 'POST' ? { approved: true } : undefined, users.operator);
        assert.strictEqual(res.status, 403, `${method} ${url} must be 403 for a non-admin`);
        const body = await res.json();
        assert.strictEqual(body.error, 'forbidden', `${method} ${url} must answer the existing authorization response`);
      }
      assert.strictEqual(h.service.calls.length, 0, 'no service method may run for a non-admin, including install');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'GET status: 200 envelope { ok, status } echoing the service, no refresh, no network', fn: async () => {
  await withServer({
    service: makeService({ state: 'idle' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'GET', '/api/application-update/status');
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.deepStrictEqual(h.service.calls, [['getStatus']], 'status must only read state, never refresh');
      assert.deepStrictEqual(body.status, h.service.lastStatus, 'the status object must be echoed untouched');
      assert.deepStrictEqual(body.status.state, 'idle');
      assert.strictEqual(h.networkCalls.count, 0, 'GET status must never perform network I/O');
    },
  });
}});

tests.push({ name: 'GET status is safe even when the updater is mid-lifecycle (failed state)', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready' }),
    async run(h) {
      h.state.user = users.admin;
      h.service.hooks.download = async () => { throw TYPED('installer_crashed', 'binary staging failed'); };
      const res = await request(h.base, 'GET', '/api/application-update/status');
      assert.strictEqual(res.status, 200, 'status must always answer 200 with the current state');
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.status.state, 'ready');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST check refreshes metadata: service.check invoked, new status echoed', fn: async () => {
  await withServer({
    service: makeService({ state: 'idle' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/check', {});
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.deepStrictEqual(h.service.calls, [['check']], 'check must forward to the injected service once');
      assert.strictEqual(body.status.state, 'available');
      assert.strictEqual(body.status.updateAvailable, true);
      assert.strictEqual(body.status.version, '1.2.3');
      assert.deepStrictEqual(body.status, h.service.getStatus(), 'post-check status must be echoed untouched');
      assert.strictEqual(h.networkCalls.count, 0, 'the route must not fetch anything itself');
    },
  });
}});

tests.push({ name: 'POST check failure: typed upstream error surfaces as 502 in the contract envelope', fn: async () => {
  await withServer({
    service: makeService({ state: 'idle' }),
    async run(h) {
      h.state.user = users.admin;
      h.service.hooks.check = async () => { throw TYPED('check_failed', 'release metadata unavailable'); };
      const res = await request(h.base, 'POST', '/api/application-update/check', {});
      assert.strictEqual(res.status, 502);
      const body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.deepStrictEqual(body.error, { code: 'check_failed', message: 'release metadata unavailable' });
      assert.ok(!('status' in body), 'error responses must not carry a status field');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST download in idle (no update available) -> 409 invalid_transition, nothing staged', fn: async () => {
  await withServer({
    service: makeService({ state: 'idle' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/download', {});
      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'invalid_transition');
      assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0);
      assert.ok(!('status' in body));
      assert.deepStrictEqual(h.service.calls.map((c) => c[0]), ['download']);
      assert.strictEqual(h.service.getStatus().packagePath, null, 'nothing may be staged from an invalid transition');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST download with an available update stages it (ready) and never installs', fn: async () => {
  await withServer({
    service: makeService({ state: 'available' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/download', {});
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.status.state, 'ready');
      assert.ok(body.status.packagePath, 'a staged packagePath is expected once ready');
      assert.deepStrictEqual(h.service.calls.map((c) => c[0]), ['download'], 'download only stages');
      assert.ok(!h.service.calls.some((c) => c[0] === 'install'), 'downloading must never install');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST install before the update is ready -> 409 invalid_transition', fn: async () => {
  await withServer({
    service: makeService({ state: 'available' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/install', { approved: true });
      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'invalid_transition');
      assert.ok(!('status' in body));
      assert.strictEqual(h.service.getStatus().state, 'available', 'a rejected install must not change state');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST install ready + explicit approval (normal priority): install proceeds', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready', priority: 'normal' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/install', { approved: true });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.status.state, 'restarting');
      assert.deepStrictEqual(h.service.calls, [['install', { approved: true }]], 'approved must be forwarded verbatim');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST install ready + no approval (normal priority) -> 409 approval_required', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready', priority: 'normal' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/install', {});
      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'approval_required');
      assert.ok(!('status' in body));
      assert.deepStrictEqual(h.service.calls, [['install', { approved: false }]], 'missing approval must forward as approved:false');
      assert.strictEqual(h.service.getStatus().state, 'ready', 'a refused install must not change state');
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'POST install ready + non-boolean approved is treated as not approved (409 normal)', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready', priority: 'normal' }),
    async run(h) {
      h.state.user = users.admin;
      for (const bogus of ['yes', 1, null]) {
        const res = await request(h.base, 'POST', '/api/application-update/install', { approved: bogus });
        assert.strictEqual(res.status, 409, `approved=${JSON.stringify(bogus)} must not count as approval`);
        const body = await res.json();
        assert.strictEqual(body.error.code, 'approval_required');
      }
      assert.ok(h.service.calls.every((c) => c[1].approved === false), 'only the literal boolean true counts as approval');
    },
  });
}});

tests.push({ name: 'POST install ready + no approval is permitted for high priority (route does not block)', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready', priority: 'high' }),
    async run(h) {
      h.state.user = users.admin;
      const res = await request(h.base, 'POST', '/api/application-update/install', {});
      assert.strictEqual(res.status, 200, 'high-priority updates may install without approval');
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.status.state, 'restarting');
      assert.deepStrictEqual(h.service.calls, [['install', { approved: false }]]);
      assert.strictEqual(h.networkCalls.count, 0);
    },
  });
}});

tests.push({ name: 'a throwing service never escapes the router: 500 envelope and the process survives', fn: async () => {
  await withServer({
    service: makeService({ state: 'ready' }),
    async run(h) {
      h.state.user = users.admin;
      // Sync throw from the service (the worst case): the route module must
      // catch it and answer the envelope — never reply with express's HTML
      // error page and never terminate the process.
      h.service.hooks.getStatus = () => { throw new Error('status boom'); };
      let res = await request(h.base, 'GET', '/api/application-update/status');
      assert.strictEqual(res.status, 500, 'a raw throw must be contained as 500');
      let body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'internal_error');
      assert.ok(typeof body.error.message === 'string');

      // The router is still alive and serving: process and route module intact.
      h.service.hooks.getStatus = null;
      res = await request(h.base, 'GET', '/api/application-update/status');
      assert.strictEqual(res.status, 200, 'the route module must survive a service crash');
      body = await res.json();
      assert.strictEqual(body.ok, true);
    },
  });
}});

// --- boot --------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log(`ok  application-update-routes test ${i + 1}: ${tests[i].name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL application-update-routes test ${i + 1}: ${tests[i].name}: ${e.message}`);
    }
  }
  if (failed) { console.error(`FAIL  ${failed} application-update-routes test(s) failed`); process.exit(1); }
  console.log('PASS  application-update-routes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});