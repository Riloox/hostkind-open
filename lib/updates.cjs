'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { open } = require('./db.cjs');
const { CAPABILITIES, requireCap } = require('./capabilities.cjs');
const snapshots = require('./snapshots.cjs');
const { Transaction } = require('./fsTransaction.cjs');
const { fetchToFile } = require('./downloads.cjs');
const operations = require('./operations.cjs');

// Errors are shown to the operator; strip absolute paths and URLs so a
// failure never leaks the machine layout (same rule as server.js).
function safeMsg(m) {
  return String(m || 'Internal server error')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/https?:\/\/[^\s'"]+/g, '<url>')
    .replace(/\/[\w@.:-]+(?:\/[\w@.:-]+)+/g, '<path>')
    .slice(0, 300);
}

const MODRINTH = 'https://api.modrinth.com/v2';
const CACHE_MS = 30 * 60 * 1000;
const MAX_JAR = 512 * 1024 * 1024;

function json(s, fallback = null) { try { return JSON.parse(s); } catch { return fallback; } }
function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const b = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function inventory(server) {
  const rows = open().prepare('SELECT * FROM content_provenance WHERE server_id = ? ORDER BY relative_path').all(server.id);
  const managed = rows.map((r) => {
    const abs = path.resolve(server.dir, r.relative_path);
    const inside = abs.startsWith(path.resolve(server.dir) + path.sep);
    const exists = inside && fs.existsSync(abs) && fs.statSync(abs).isFile();
    const actualSha256 = exists ? hashFile(abs) : null;
    return { ...r, exists, actualSha256, modified: exists && actualSha256 !== r.sha256 };
  });
  const known = new Set(rows.map((r) => r.relative_path.split(path.sep).join('/')));
  const unmanaged = [];
  for (const folder of ['plugins', 'mods']) {
    const dir = path.join(server.dir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${folder}/${e.name}`;
      if (e.isFile() && e.name.toLowerCase().endsWith('.jar') && !known.has(rel)) unmanaged.push({ relativePath: rel, size: fs.statSync(path.join(dir, e.name)).size });
    }
  }
  const inventoryHash = crypto.createHash('sha256').update(JSON.stringify(managed.map((x) => [x.relative_path, x.actualSha256]))).digest('hex');
  return { managed, unmanaged, inventoryHash };
}
async function apiJson(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'user-agent': 'Hostkind/1.0', 'content-type': 'application/json', ...(options.headers || {}) } });
  if (!r.ok) throw new Error(`Provider returned HTTP ${r.status}`);
  return r.json();
}
async function projectVersions(item, compat, allowStale) {
  const db = open();
  const key = `${item.project_id}:${compat.mcVersion}:${compat.loaders.join(',')}`;
  const cached = db.prepare('SELECT * FROM compatibility_cache WHERE source = ? AND cache_key = ?').get('modrinth', key);
  if (cached && cached.expires_at > Date.now() && !cached.stale) return { data: json(cached.payload_json, []), freshness: cached };
  try {
    const url = `${MODRINTH}/project/${encodeURIComponent(item.project_id)}/version?loaders=${encodeURIComponent(JSON.stringify(compat.loaders))}&game_versions=${encodeURIComponent(JSON.stringify([compat.mcVersion]))}`;
    const data = await apiJson(url);
    const stable = data.filter((v) => v.version_type === 'release' && !/\b(?:alpha|beta|rc|pre|snapshot)\b/i.test(v.version_number || ''));
    db.prepare(`INSERT INTO compatibility_cache VALUES (?, ?, ?, ?, 0, ?, NULL)
      ON CONFLICT(source,cache_key) DO UPDATE SET retrieved_at=excluded.retrieved_at, expires_at=excluded.expires_at, stale=0, payload_json=excluded.payload_json, error_json=NULL`)
      .run('modrinth', key, Date.now(), Date.now() + CACHE_MS, JSON.stringify(stable));
    return { data: stable, freshness: { source: 'modrinth', retrieved_at: Date.now(), stale: 0 } };
  } catch (e) {
    if (cached && allowStale) {
      db.prepare('UPDATE compatibility_cache SET stale=1, error_json=? WHERE source=? AND cache_key=?').run(JSON.stringify({ message: e.message, at: Date.now() }), 'modrinth', key);
      return { data: json(cached.payload_json, []), freshness: { ...cached, stale: 1, error_json: JSON.stringify({ message: e.message }) } };
    }
    throw e;
  }
}
function primaryFile(v) { return (v.files || []).find((f) => f.primary) || (v.files || [])[0]; }
async function scan(server, compat, allowStale = true) {
  const inv = inventory(server);
  const artifacts = [];
  let freshest = null;
  for (const item of inv.managed) {
    const artifact = { id: item.id, relativePath: item.relative_path, kind: item.kind, projectId: item.project_id, currentVersionId: item.version_id, currentSha256: item.sha256, modified: item.modified, selectable: false };
    if (!item.exists || item.modified || item.provider !== 'modrinth') { artifact.reason = !item.exists ? 'missing' : item.modified ? 'locally_modified' : 'unsupported_provider'; artifacts.push(artifact); continue; }
    try {
      const got = await projectVersions(item, compat, allowStale); freshest = got.freshness;
      const next = got.data[0]; const file = next && primaryFile(next);
      if (next && file && next.id !== item.version_id) {
        artifact.update = { versionId: next.id, versionNumber: next.version_number, name: next.name, filename: file.filename, url: file.url, sha512: file.hashes && file.hashes.sha512, size: file.size, mcVersion: compat.mcVersion, loader: (next.loaders || []).find((x) => compat.loaders.includes(x)) };
        artifact.selectable = !!artifact.update.sha512 && !got.freshness.stale;
        if (got.freshness.stale) artifact.reason = 'stale_metadata';
      }
    } catch (e) { artifact.reason = 'provider_error'; artifact.error = e.message; }
    artifacts.push(artifact);
  }
  return { scannedAt: Date.now(), freshness: freshest, ...inv, artifacts };
}
function planPublic(row) { return row && { id: row.id, serverId: row.server_id, createdBy: row.created_by, createdAt: row.created_at, status: row.status, ...json(row.plan_json, {}) }; }

function router({ findServer, getManager, detectCompat }) {
  const r = express.Router();
  const sid = (req) => (req.body && req.body.serverId) || req.query.serverId;
  const serverFor = (req, res) => { const s = findServer(sid(req)); if (!s) res.status(404).json({ error: 'Server not found' }); return s; };
  // Update scans and plan execution are expensive (provider network calls,
  // database, file system). Bound them per operator so one account cannot
  // hammer the panel or Modrinth (CodeQL js/missing-rate-limiting). The
  // limiter is route middleware so the guard sits on the flagged route
  // itself; keyGenerator reproduces the previous per-operator buckets.
  function rateLimited(req, res) {
    const info = req.rateLimit;
    const ms = info && info.resetTime ? info.resetTime.getTime() - Date.now() : 60_000;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
    res.status(429).json({ error: 'Too many update requests. Try again shortly.', code: 'rate_limited' });
  }
  const limitUpdateActions = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (req.path === '/scan' || req.path === '/plan') {
        const s = findServer(sid(req));
        return `${req.user.id}:${s ? s.id : 'unknown'}`;
      }
      if (req.path.startsWith('/plans/') && req.path.endsWith('/apply')) return `apply:${req.user.id}`;
      if (req.path.startsWith('/plans/') && req.path.endsWith('/rollback')) return `rollback:${req.user.id}`;
      return `${req.user.id}`;
    },
    handler: (req, res) => rateLimited(req, res),
  });
  const limitPlanReads = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `plan:${req.user.id}`,
    handler: (req, res) => rateLimited(req, res),
  });
  r.post('/scan', requireCap(CAPABILITIES.UPDATES_VIEW, { getServerId: sid }), limitUpdateActions, async (req, res) => {
    const s = serverFor(req, res); if (!s) return;
    try { res.json({ ok: true, scan: await scan(s, detectCompat(getManager(s.id)), true), plans: open().prepare('SELECT * FROM update_plans WHERE server_id=? ORDER BY created_at DESC LIMIT 20').all(s.id).map(planPublic) }); }
    catch (e) { res.status(502).json({ error: safeMsg(e.message) }); }
  });
  r.post('/plan', requireCap(CAPABILITIES.UPDATES_APPLY, { getServerId: sid }), limitUpdateActions, async (req, res) => {
    const s = serverFor(req, res); if (!s) return;
    const ids = [...new Set((req.body.artifactIds || []).map(String))];
    try {
      const found = await scan(s, detectCompat(getManager(s.id)), false);
      const items = found.artifacts.filter((a) => ids.includes(a.id) && a.selectable);
      if (!ids.length || items.length !== ids.length) return res.status(409).json({ error: 'One or more artifacts are unmanaged, incompatible, stale, or modified.' });
      const id = crypto.randomUUID();
      const plan = { inventoryHash: found.inventoryHash, diskNeed: items.reduce((n, x) => n + Number(x.update.size || 0), 0), requiresOffline: true, snapshotRequired: true, items };
      open().prepare('INSERT INTO update_plans VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, req.user.id, Date.now(), found.inventoryHash, 'planned', JSON.stringify(plan));
      res.json({ ok: true, plan: { id, serverId: s.id, createdAt: Date.now(), status: 'planned', ...plan } });
    } catch (e) { res.status(502).json({ error: safeMsg(e.message) }); }
  });
  r.get('/plans/:id', limitPlanReads, (req, res) => {
    const row = open().prepare('SELECT * FROM update_plans WHERE id=?').get(req.params.id);
    if (!row || !require('./capabilities.cjs').has(req.user, row.server_id, CAPABILITIES.UPDATES_VIEW)) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: planPublic(row) });
  });
  r.post('/plans/:id/apply', limitUpdateActions, async (req, res) => {
    const db = open(); const row = db.prepare('SELECT * FROM update_plans WHERE id=?').get(req.params.id);
    if (!row || !require('./capabilities.cjs').has(req.user, row.server_id, CAPABILITIES.UPDATES_APPLY)) return res.status(404).json({ error: 'Plan not found' });
    if (row.status === 'succeeded') return res.json({ ok: true, plan: planPublic(row), idempotent: true });
    if (row.status !== 'planned') return res.status(409).json({ error: 'Plan cannot be applied in its current state.' });
    const s = findServer(row.server_id); const m = s && getManager(s.id); const plan = json(row.plan_json, {});
    if (!s) return res.status(404).json({ error: 'Server not found' });
    if (m.status !== 'offline') return res.status(409).json({ error: 'Stop the server before applying updates.' });
    const op = operations.create({
      kind: 'modpack-update',
      actorId: req.user.id,
      serverId: s.id,
      idempotencyKey: `plan-${row.id}-${Date.now()}`,
      summary: { planId: row.id, itemCount: (plan.items || []).length },
    });
    if (op.state !== operations.STATES.QUEUED) return res.json({ ok: true, plan: planPublic(row), replay: true });
    operations.start(op.id, { phase: 'revalidate' });
    if (!operations.acquireServerLock(op.id, s.id)) {
      operations.fail(op.id, { code: 'server_busy', text: 'Another operation is running for this server.' });
      return res.status(409).json({ error: 'Another update operation is in progress.' });
    }
    let snapshot;
    try {
      if (inventory(s).inventoryHash !== row.base_inventory_hash) return res.status(409).json({ error: 'Server files changed since this plan was created. Scan again.' });
      db.prepare("UPDATE update_plans SET status='applying' WHERE id=? AND status='planned'").run(row.id);
      snapshot = snapshots.take({ serverId: s.id, sourceDir: s.dir, scope: [...new Set(plan.items.map((x) => x.relativePath.split('/')[0]))], kind: 'update', reason: `Update plan ${row.id}` });
      if (!snapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed');
      const tx = new Transaction({ serverDir: s.dir, operationId: row.id });
      for (const item of plan.items) {
        const meta = await apiJson(`${MODRINTH}/version/${encodeURIComponent(item.update.versionId)}`);
        const file = primaryFile(meta);
        if (!file || file.url !== item.update.url || file.hashes.sha512 !== item.update.sha512) throw new Error('Update metadata changed during revalidation');
        const temp = path.join(tx.root, `${item.id}.download`);
        await fetchToFile(file.url, temp, { maxBytes: MAX_JAR, expectedSha256: null, allowlist: (host) => host === 'cdn.modrinth.com' || host.endsWith('.modrinth.com') });
        const sha512 = crypto.createHash('sha512').update(fs.readFileSync(temp)).digest('hex');
        if (sha512 !== file.hashes.sha512) throw new Error('Downloaded file hash did not match authoritative metadata');
        item.newSha256 = hashFile(temp); tx.stageCopy(temp, item.relativePath);
      }
      tx.saveJournal(); tx.commit();
      const up = db.prepare(`UPDATE content_provenance SET version_id=?, mc_version=?, loader=?, sha256=?, managed_at=? WHERE id=?`);
      db.transaction(() => { for (const x of plan.items) up.run(x.update.versionId, x.update.mcVersion, x.update.loader, x.newSha256, Date.now(), x.id); db.prepare("UPDATE update_plans SET status='succeeded', plan_json=? WHERE id=?").run(JSON.stringify({ ...plan, snapshotId: snapshot.id, appliedAt: Date.now() }), row.id); })();
      operations.finish(op.id, { planId: row.id, snapshotId: snapshot.id });
      res.json({ ok: true, plan: planPublic(db.prepare('SELECT * FROM update_plans WHERE id=?').get(row.id)) });
    } catch (e) {
      operations.fail(op.id, { code: e.code || 'update_failed', text: e.message });
      db.prepare("UPDATE update_plans SET status=?, plan_json=? WHERE id=?").run(snapshot ? 'rollback_available' : 'failed', JSON.stringify({ ...plan, snapshotId: snapshot && snapshot.id, error: e.message }), row.id);
      res.status(500).json({ error: safeMsg(e.message) });
    }
  });
  r.post('/plans/:id/rollback', limitUpdateActions, async (req, res) => {
    const db = open(); const row = db.prepare('SELECT * FROM update_plans WHERE id=?').get(req.params.id);
    if (!row || !require('./capabilities.cjs').has(req.user, row.server_id, CAPABILITIES.UPDATES_APPLY)) return res.status(404).json({ error: 'Plan not found' });
    const s = findServer(row.server_id); const m = s && getManager(s.id); const plan = json(row.plan_json, {});
    if (!s || !plan.snapshotId) return res.status(409).json({ error: 'No verified snapshot is available.' });
    if (m.status !== 'offline') return res.status(409).json({ error: 'Stop the server before rollback.' });
    const restored = snapshots.restore({ id: plan.snapshotId, targetDir: s.dir });
    if (!restored.ok) return res.status(409).json({ error: 'Snapshot verification failed.' });
    db.transaction(() => { for (const x of plan.items || []) db.prepare('UPDATE content_provenance SET version_id=?, sha256=?, managed_at=? WHERE id=?').run(x.currentVersionId, x.currentSha256, Date.now(), x.id); db.prepare("UPDATE update_plans SET status='rolled_back' WHERE id=?").run(row.id); })();
    res.json({ ok: true, plan: planPublic(db.prepare('SELECT * FROM update_plans WHERE id=?').get(row.id)) });
  });
  return r;
}

function recordModrinth({ serverId, relativePath, kind, projectId, versionId, mcVersion, loader, sha256 }) {
  open().prepare(`INSERT INTO content_provenance VALUES (?, ?, ?, ?, 'modrinth', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id,relative_path) DO UPDATE SET kind=excluded.kind, provider='modrinth', project_id=excluded.project_id, version_id=excluded.version_id, mc_version=excluded.mc_version, loader=excluded.loader, sha256=excluded.sha256, managed_at=excluded.managed_at`)
    .run(crypto.randomUUID(), serverId, relativePath, kind, projectId, versionId, mcVersion || null, loader || null, sha256, Date.now());
}

module.exports = { router, recordModrinth, inventory, scan };
