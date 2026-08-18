'use strict';

/*
 * Durable create/install: the operations ledger, the resume route, and
 * destination recovery. Together these prove that an interrupted install
 * (a) leaves a resumable .part and a recovery_required operation,
 * (b) resumes from the exact byte offset when POST /resume replays it, and
 * (c) never lets a retried create brick on a leftover partial folder - and
 * never deletes a folder that is not one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const operations = require('../lib/operations.cjs');
const capabilities = require('../lib/capabilities.cjs');
const installRun = require('../lib/installRun.cjs');
const trash = require('../lib/trash.cjs');
const { router } = require('../lib/routes/operations.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    // localhost rather than 127.0.0.1: the recovery plan is persisted through
    // the redactor, and a bare IPv4 in the URL would be masked as an IP.
    server.listen(0, 'localhost', () => {
      const { port } = server.address();
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

function planFor(destination, url, destPath, extra = {}) {
  return { type: 'download', destination, downloads: [{ url, destPath, filename: path.basename(destPath), allowInsecure: true, ...extra }] };
}

async function main() {
  fresh();
  migrations.runMigrations();

  const admin = { id: 'admin-resume', role: 'admin' };
  const operator = { id: 'operator-resume', role: 'operator' };
  capabilities.grant(operator.id, 'server-a', capabilities.CAPABILITIES.SERVER_CONTROL, admin.id);

  const app = express();
  app.use((req, res, next) => {
    req.user = req.headers['x-test-user'] === 'admin' ? admin : operator;
    next();
  });
  app.use('/api/operations', router());
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. An interrupted create sweeps to recovery_required with the journal
    // preserved, so the resume flow can reconstruct the download plan.
    {
      const dir = path.join(TMP_ROOT, 'sweep-install');
      const destPath = path.join(dir, 'server.jar');
      const op = operations.create({ kind: 'install.minecraft.create', actorId: admin.id, serverId: 'server-a' });
      operations.start(op.id);
      operations.setJournal(op.id, planFor(dir, 'https://cdn.example.invalid/jar', destPath));
      const swept = operations.sweepStale({ heartbeatStaleMs: 0, now: Date.now() + 60_000 });
      const found = swept.find((o) => o.id === op.id);
      assert.ok(found, 'the interrupted create must be swept');
      assert.strictEqual(found.state, operations.STATES.RECOVERY_REQUIRED);
      assert.ok(found.recovery && found.recovery.journal, 'the sweep must copy the journal into recovery');
      const plan = installRun.planFromOperation(found);
      assert.ok(plan, 'a download plan must be recoverable from the swept operation');
      assert.strictEqual(plan.type, 'download');
      assert.strictEqual(plan.downloads[0].destPath, destPath);
    }

    // 2. POST /resume replays a recovery_required create: the second fetch
    // sends Range from the byte offset, the .part is appended, promoted, and
    // the operation finishes succeeded. The marker is cleared on success.
    {
      const body = Buffer.from('route-resume-payload-body-0123456789');
      const cut = 9;
      const dir = path.join(TMP_ROOT, 'route-resume');
      fs.mkdirSync(dir, { recursive: true });
      const destPath = path.join(dir, 'server.jar');
      fs.writeFileSync(destPath + '.part', body.slice(0, cut));
      const op = operations.create({ kind: 'install.minecraft.create', actorId: admin.id, serverId: 'server-a', summary: { destination: dir } });
      operations.start(op.id);
      installRun.writeMarker(dir, { operationId: op.id, destination: dir, phase: 'downloading' });

      const { server: dl, url } = await startServer((req, res) => {
        const range = req.headers.range;
        assert.ok(range, `resume must send a Range header, got ${range}`);
        const m = /^bytes=(\d+)-$/.exec(range);
        const from = Number(m[1]);
        assert.strictEqual(from, cut, `resume must continue from byte ${cut}, got ${from}`);
        res.writeHead(206, {
          'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
          'content-length': String(body.length - from),
        });
        res.end(body.slice(from));
      });
      try {
        // The plan must hold the real URL before it is persisted: both the
        // journal and the recovery metadata go through the redactor, and the
        // resume flow prefers recovery - a placeholder would be replayed.
        const plan = planFor(dir, url + '/server.jar', destPath);
        operations.setJournal(op.id, plan);
        operations.markRecoveryRequired(op.id, { code: 'interrupted', text: 'simulated crash mid-download', recovery: plan });
        const response = await fetch(`${base}/api/operations/${op.id}/resume`, { method: 'POST' });
        assert.strictEqual(response.status, 200, `expected 200, got ${response.status}: ${await response.clone().text()}`);
        const json = await response.json();
        assert.ok(json.ok);
        assert.strictEqual(json.operation.state, operations.STATES.SUCCEEDED, `expected succeeded, got ${json.operation.state}`);
        assert.strictEqual(json.resumed.from, cut);
        assert.strictEqual(fs.readFileSync(destPath, 'utf8'), body.toString('utf8'), 'the final file must be whole');
        assert.ok(!fs.existsSync(destPath + '.part'), 'the .part must be promoted');
        assert.ok(!fs.existsSync(path.join(dir, installRun.INSTALL_MARKER)), 'the marker must be cleared on success');
      } finally {
        dl.close();
      }
    }

    // 3. A retried create recovers a leftover partial folder (moves it to
    // recoverable trash) and refuses - without deleting - a markerless
    // non-empty folder.
    {
      const partial = path.join(TMP_ROOT, 'partial-install');
      fs.mkdirSync(partial, { recursive: true });
      fs.writeFileSync(path.join(partial, 'server.jar.part'), 'half-downloaded');
      installRun.writeMarker(partial, { operationId: 'long-gone-op', destination: partial });
      const recovered = installRun.recoverDestination(partial);
      assert.strictEqual(recovered.action, 'recovered');
      assert.ok(recovered.trashId, 'the partial must be moved to recoverable trash');
      assert.ok(!fs.existsSync(partial), 'the partial folder must be moved aside');
      const entry = trash.get(recovered.trashId);
      assert.ok(entry && entry.restorable, 'the moved partial must be restorable');
      assert.strictEqual(trash.restore(recovered.trashId).restoredTo, partial);

      const real = path.join(TMP_ROOT, 'real-server');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'server.jar'), 'a real server');
      let threw = null;
      try { installRun.recoverDestination(real); } catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'destination_not_empty', `expected destination_not_empty, got ${threw && threw.code}`);
      assert.ok(fs.existsSync(path.join(real, 'server.jar')), 'a markerless folder is never deleted');
    }

    // 4. Resume keeps its precondition contract: a running (not
    // recovery_required) operation is refused with 409, and a
    // recovery_required non-install kind keeps the feature-specific message.
    {
      const running = operations.create({ kind: 'install.minecraft.create', actorId: admin.id, serverId: 'server-a' });
      operations.start(running.id);
      const r409 = await fetch(`${base}/api/operations/${running.id}/resume`, { method: 'POST' });
      assert.strictEqual(r409.status, 409);
      assert.strictEqual((await r409.json()).error, 'not_recoverable');

      const feature = operations.create({ kind: 'metrics.scan', actorId: admin.id, serverId: 'server-a' });
      operations.start(feature.id);
      operations.markRecoveryRequired(feature.id, { code: 'stale', text: 'stale at boot' });
      const rFeature = await fetch(`${base}/api/operations/${feature.id}/resume`, { method: 'POST' });
      assert.strictEqual(rFeature.status, 200);
      const json = await rFeature.json();
      assert.strictEqual(json.message, 'resume is feature-specific');
      assert.strictEqual(json.operation.state, operations.STATES.RECOVERY_REQUIRED);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    close();
    teardown();
  }
  console.log('PASS  install-resume');
}

main().catch((err) => {
  console.error(err);
  close();
  teardown();
  process.exit(1);
});
