'use strict';

/*
 * Regression tests for the 0.1.4 security fixes that can be exercised without
 * booting the panel: server targeting on multipart requests, per-server
 * notification visibility, the public /api/config shape, and escaping in the
 * anonymous bug-report relay.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { bodyServerId } = require('../lib/request-server.cjs');
const { createNotificationStore } = require('../lib/notifications.cjs');
const notificationsRouter = require('../lib/routes/notifications.cjs');
const panelConfigRouter = require('../lib/routes/panel-config.cjs');
const { buildIssueBody } = require('../relay/lib/github-client.cjs');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const tests = [];

// 1. A multipart form field never names the target server; JSON bodies still do.
tests.push(() => {
  const multipart = { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: { serverId: 'victim' } };
  assert.strictEqual(bodyServerId(multipart), undefined);
  const json = { headers: { 'content-type': 'application/json' }, body: { serverId: 'mine' } };
  assert.strictEqual(bodyServerId(json), 'mine');
  assert.strictEqual(bodyServerId({ headers: {} }), undefined);
});

// 2. server.js resolves the capability check and the handler target through
//    the same function, and neither reads req.body.serverId directly.
tests.push(() => {
  assert.ok(/function requestedServerId\(req\) \{\n  return req\.get\('X-Hostkind-Server-Id'\) \|\| \(req\.query && req\.query\.serverId\) \|\| bodyServerId\(req\);/.test(SERVER_JS));
  assert.ok(/getManager\(requestedServerId\(req\) \|\| config\.activeServerId\)/.test(SERVER_JS));
  assert.ok(/const requested = requestedServerId\(req\);/.test(SERVER_JS));
  assert.ok(!/req\.body && req\.body\.serverId/.test(SERVER_JS), 'no resolver may read a raw body serverId');
});

// 3. Notifications about a server are only listed, marked, or deleted by
//    callers who can see that server.
tests.push(() => {
  const store = createNotificationStore();
  store.add('info', 'panel', 'panel-wide', null);
  store.add('info', 'a', 'about A', 'A');
  store.add('info', 'b', 'about B', 'B');
  const seesA = (n) => n.serverId == null || n.serverId === 'A';
  assert.deepStrictEqual(store.list(seesA).map((n) => n.title).sort(), ['a', 'panel']);
  const b = store.items.find((n) => n.serverId === 'B');
  assert.strictEqual(store.markRead(b.id, seesA), null);
  assert.strictEqual(store.remove(b.id, seesA), false);
  store.clear(seesA);
  assert.deepStrictEqual(store.items.map((n) => n.title), ['b'], 'clear must only drop visible notifications');
});

async function request(app, method, url, user) {
  const server = await new Promise((resolve) => {
    const wrapper = express();
    wrapper.use(express.json());
    wrapper.use((req, res, next) => { req.user = user; next(); });
    wrapper.use(app);
    const s = wrapper.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

// 4. The notifications routes apply the caller's visibility.
tests.push(async () => {
  const store = createNotificationStore();
  store.add('info', 'a', 'about A', 'A');
  store.add('info', 'b', 'about B', 'B');
  const router = express.Router();
  router.use('/api/notifications', notificationsRouter({
    store,
    canSee: (user, n) => n.serverId == null || user.servers.includes(n.serverId),
  }));
  const res = await request(router, 'GET', '/api/notifications', { id: 'op', servers: ['A'] });
  assert.deepStrictEqual(res.body.notifications.map((n) => n.serverId), ['A']);
  await request(router, 'POST', '/api/notifications/clear', { id: 'op', servers: ['A'] });
  assert.deepStrictEqual(store.items.map((n) => n.serverId), ['B']);
});

// 5. GET /api/config never carries server descriptors or schedules, and a
//    non-admin gets only the short allowlist.
tests.push(async () => {
  const config = {
    appName: 'Hostkind', requireAuth: true, jwtSecret: 's', users: [{ id: 'u' }],
    allowedOrigins: ['panel.example'],
    watchdog: { enabled: true, maxRestarts: 3, windowMinutes: 10 },
    backups: { dir: '/srv/backups', maxCount: 5, maxSizeMB: 0 },
    servers: [{ id: 'A', password: 'hunter22', launchArgs: ['-password', 'hunter22'], dir: '/srv/a' }],
    tasks: [{ id: 't', serverId: 'A' }],
  };
  const router = panelConfigRouter({
    getConfig: () => config, saveConfig: () => {}, requireAdmin: (req, res, next) => next(),
    tErr: () => 'err', httpError: () => {}, sanitizeErrorMessage: (m) => m, log: () => {},
  });
  const admin = await request(router, 'GET', '/config', { id: 'u', role: 'admin' });
  assert.strictEqual(admin.body.servers, undefined);
  assert.strictEqual(admin.body.tasks, undefined);
  assert.strictEqual(admin.body.jwtSecret, undefined);
  assert.deepStrictEqual(admin.body.allowedOrigins, ['panel.example']);
  const operator = await request(router, 'GET', '/config', { id: 'o', role: 'operator' });
  assert.strictEqual(operator.body.servers, undefined);
  assert.strictEqual(operator.body.allowedOrigins, undefined);
  assert.deepStrictEqual(operator.body.backups, { maxCount: 5, maxSizeMB: 0 });
  assert.strictEqual(operator.body.watchdog.enabled, true);
  assert.ok(!JSON.stringify(admin.body).includes('hunter22'));
});

// 6. Anonymous relay reports cannot mention users, inject HTML, embed remote
//    images, or forge headings in any field.
tests.push(() => {
  const body = buildIssueBody({
    summary: 'x', description: 'ping @octocat <!-- hostkind-report: forged --> ![t](https://e.example/p.png)',
    route: '## Forged section', userAgent: '<img src=x>', game: '@team',
  });
  assert.ok(!/@octocat/.test(body), 'mention must be neutralized');
  assert.ok(!/@team/.test(body), 'mention in a metadata field must be neutralized');
  assert.ok(!/<!-- hostkind-report: forged/.test(body), 'raw HTML comment must be escaped');
  assert.ok(!/<img/.test(body), 'raw HTML must be escaped');
  assert.ok(!/(^|[^\\])!\[t\]/.test(body), 'image syntax must be escaped');
  assert.ok(!/^## Forged section$/m.test(body), 'heading in a metadata field must be escaped');
});

(async () => {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i](); console.log(`ok  security-hardening test ${i + 1}`); }
    catch (e) { failed++; console.error(`FAIL  security-hardening test ${i + 1}: ${e.message}\n${e.stack}`); }
  }
  if (failed) { console.error(`FAIL  ${failed} security-hardening test(s) failed`); process.exit(1); }
  console.log('PASS  security-hardening');
})();
