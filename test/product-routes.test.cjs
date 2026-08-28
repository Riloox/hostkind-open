'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const productRouter = require('../lib/routes/product.cjs');

(async function main() {
  const server = {
    id: 'srv-1', name: 'Survival', type: 'minecraft', loader: 'paper', mcVersion: '1.21.4',
    worlds: ['world'], dir: 'C:\\private\\server', jar: 'C:\\private\\paper.jar',
  };
  const targets = [];
  const events = [];
  const restoreReports = [];
  const app = express();
  app.use(express.json());
  app.use('/api/product', productRouter({
    findServer: (id) => id === server.id ? server : null,
    listModules: () => [{ id: 'minecraft', module: { id: 'minecraft', install() {}, import() {}, update() {}, backup() {}, restore() {}, sleep() {}, wake() {}, migrate() {} }, descriptor: server }],
    store: {
      listTargets: () => targets,
      createTarget: (input) => { const value = { id: `target-${targets.length + 1}`, ...input }; targets.push(value); return value; },
      updateTarget: (id, status) => { const value = targets.find((item) => item.id === id); if (!value) return null; value.status = status; return value; },
      createPairing: (input) => ({ id: 'challenge-1', targetId: input.targetId, token: 'one-time-token', expiresAt: 2000 }),
      consumePairing: (input) => input.token === 'one-time-token' ? { ok: true, targetId: 'target-1', agentId: 'agent-1' } : { ok: false, code: 'invalid_token' },
      recordRestoreDrill: (report) => { restoreReports.push(report); return report; },
      latestRestoreDrill: () => restoreReports[restoreReports.length - 1] || null,
      recordEvent: (input) => { events.push(input); return input; },
      summaryEvents: () => ({ counts: { first_playable: events.filter((event) => event.type === 'first_playable').length }, funnel: { firstPlayable: events.filter((event) => event.type === 'first_playable').length, byocBetaRequested: 0, pricingInterest: 0, firstToByoc: 0, byocToPricing: 0 } }),
    },
  }));
  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${httpServer.address().port}/api/product`;
  const call = (method, url, body) => {
    const options = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) options.body = JSON.stringify(body);
    return fetch(`${base}${url}`, options);
  };

  try {
    let response = await call('GET', '/manifest/srv-1');
    assert.strictEqual(response.status, 200);
    let payload = await response.json();
    assert.strictEqual(payload.manifest.kind, 'hostkind.server-manifest');
    assert.doesNotMatch(JSON.stringify(payload), /private\\\\server|paper\\.jar/);
    assert.strictEqual(events.filter((event) => event.type === 'manifest_exported').length, 1);

    response = await call('GET', '/lifecycle');
    assert.strictEqual(response.status, 200);
    payload = await response.json();
    assert.deepStrictEqual(payload.scorecards.map((item) => item.moduleId), ['minecraft']);
    assert.strictEqual(payload.scorecards[0].score, 8);

    response = await call('POST', '/byoc/targets', { name: 'Primary', provider: 'hetzner', endpoint: 'https://vps.example.test', region: 'fsn1', resourceTier: 'cx33', secretRef: 'HOSTKIND_BYOC_PRIMARY' });
    assert.strictEqual(response.status, 201);
    payload = await response.json();
    assert.strictEqual(payload.target.secretRef, 'HOSTKIND_BYOC_PRIMARY');
    response = await call('PATCH', `/byoc/targets/${payload.target.id}`, { status: 'ready' });
    assert.strictEqual(response.status, 200);

    response = await call('POST', '/pairing/challenges', { targetId: payload.target.id });
    assert.strictEqual(response.status, 201);
    const challenge = await response.json();
    response = await call('POST', '/pairing/consume', { id: challenge.challenge.id, token: challenge.challenge.token });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).pairing.agentId, 'agent-1');

    const drillInventory = [{ path: 'state.json', size: 7, sha256: 'b'.repeat(64) }];
    response = await call('POST', '/restore-drills', { backupId: 'backup-1', target: 'drill-1', expected: drillInventory, actual: drillInventory, startedAt: 100, completedAt: 200 });
    assert.strictEqual(response.status, 201);
    assert.strictEqual((await response.json()).report.status, 'succeeded');
    response = await call('GET', '/restore-drills/latest');
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).report.status, 'succeeded');

    response = await call('POST', '/events', { type: 'first_playable', serverId: 'srv-1', game: 'minecraft', source: 'beta', password: 'discard' });
    assert.strictEqual(response.status, 201);
    assert.strictEqual((await response.json()).event.type, 'first_playable');
    response = await call('GET', '/summary');
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).summary.counts.first_playable, 1);
    console.log('PASS product-routes');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
