'use strict';

const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const audit = require('../audit.cjs');
const { open } = require('../db.cjs');
const { redactObject } = require('../redact.cjs');
const { CAPABILITIES, requireCap } = require('../capabilities.cjs');

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const OUTCOMES = new Set(['success', 'failure', 'denied']);

function time(value, end = false) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(end && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function filters(query) {
  return {
    cursor: query.cursor || null,
    serverId: query.serverId || null,
    actorId: query.actorId || null,
    action: query.action || null,
    outcome: OUTCOMES.has(query.outcome) ? query.outcome : null,
    since: time(query.from),
    until: time(query.to, true),
    limit: query.limit,
  };
}

function safeCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    occurredAt: new Date(row.ts).toISOString(),
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    serverId: row.server_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    requestId: row.request_id,
    operationId: row.operation_id,
    metadata: redactObject(audit.safeJson(row.metadata)),
  }));
}

module.exports = function auditRouter() {
  const router = express.Router();
  // Retention preview/apply churn the audit table (INSERT/DELETE); bound how
  // often one account may run them (CodeQL js/missing-rate-limiting). Route
  // middleware keeps the guard on the flagged route itself.
  function rateLimited(req, res) {
    const info = req.rateLimit;
    const ms = info && info.resetTime ? info.resetTime.getTime() - Date.now() : 60_000;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
    res.status(429).json({ error: 'Too many retention requests. Try again shortly.', code: 'rate_limited' });
  }
  const limitRetention = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: false,
    legacyHeaders: false,
    // Same per-operator buckets as before: `preview:<user>` / `apply:<user>`.
    keyGenerator: (req) => `${req.path.endsWith('/apply') ? 'apply' : 'preview'}:${req.user.id}`,
    handler: (req, res) => rateLimited(req, res),
  });

  router.get('/', requireCap(CAPABILITIES.AUDIT_VIEW), (req, res) => res.json(audit.list(filters(req.query))));

  router.get('/export', requireCap(CAPABILITIES.AUDIT_EXPORT), (req, res) => {
    const format = req.query.format;
    if (!['csv', 'json'].includes(format)) return res.status(400).json({ error: 'format must be csv or json' });
    const rows = exportRows(audit.all(filters(req.query)));
    audit.record({ actorId: req.user.id, actorUsername: req.user.username, action: 'audit.export', outcome: 'success', requestId: req.requestId, metadata: { format, count: rows.length } });
    res.setHeader('Content-Disposition', `attachment; filename="fleetdeck-audit.${format}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (format === 'json') return res.type('application/json').send(JSON.stringify(rows, null, 2));
    const fields = ['id', 'occurredAt', 'actorId', 'actorUsername', 'serverId', 'action', 'targetType', 'targetId', 'outcome', 'requestId', 'operationId', 'metadata'];
    res.type('text/csv').send([fields.map(safeCell).join(','), ...rows.map((row) => fields.map((field) => safeCell(field === 'metadata' ? JSON.stringify(row[field]) : row[field])).join(','))].join('\r\n'));
  });

  router.post('/retention/preview', requireCap(CAPABILITIES.AUDIT_RETENTION), limitRetention, (req, res) => {
    const cutoff = time(req.body?.cutoff);
    if (!cutoff || cutoff >= Date.now()) return res.status(400).json({ error: 'cutoff must be a date in the past' });
    const db = open();
    const count = db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE ts < ?').get(cutoff).count;
    const token = crypto.randomUUID();
    const now = Date.now();
    db.prepare('DELETE FROM audit_retention_previews WHERE expires_at < ?').run(now);
    db.prepare('INSERT INTO audit_retention_previews VALUES (?, ?, ?, ?, ?, ?)').run(token, req.user.id, cutoff, count, now, now + PREVIEW_TTL_MS);
    res.json({ ok: true, previewToken: token, cutoff, count, expiresAt: now + PREVIEW_TTL_MS });
  });

  router.post('/retention/apply', requireCap(CAPABILITIES.AUDIT_RETENTION), limitRetention, (req, res) => {
    const key = String(req.get('Idempotency-Key') || '').trim();
    if (!key) return res.status(400).json({ error: 'Idempotency-Key is required' });
    const db = open();
    const prior = db.prepare('SELECT result_json FROM audit_retention_requests WHERE actor_id = ? AND idempotency_key = ?').get(req.user.id, key);
    if (prior) return res.json(JSON.parse(prior.result_json));
    const preview = db.prepare('SELECT * FROM audit_retention_previews WHERE token = ? AND actor_id = ?').get(req.body?.previewToken, req.user.id);
    if (!preview || preview.expires_at < Date.now()) return res.status(409).json({ error: 'retention preview expired or invalid' });
    const current = db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE ts < ?').get(preview.cutoff).count;
    if (current !== preview.event_count) return res.status(409).json({ error: 'audit trail changed; create a new preview' });
    const result = db.transaction(() => {
      audit.record({ actorId: req.user.id, actorUsername: req.user.username, action: 'audit.retention.apply', targetType: 'audit_events', outcome: 'success', requestId: req.requestId, metadata: { cutoff: preview.cutoff, deletedCount: current } });
      const deleted = db.prepare('DELETE FROM audit_events WHERE ts < ?').run(preview.cutoff).changes;
      const value = { ok: true, cutoff: preview.cutoff, deletedCount: deleted };
      db.prepare('INSERT INTO audit_retention_requests VALUES (?, ?, ?, ?)').run(req.user.id, key, JSON.stringify(value), Date.now());
      db.prepare('DELETE FROM audit_retention_previews WHERE token = ?').run(preview.token);
      return value;
    })();
    res.json(result);
  });

  // --- Tour lifecycle events (analytics) ---
  const TOUR_EVENT_TYPES = new Set(['start', 'step', 'complete', 'dismiss']);
  router.post('/tour-event', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const { type, step, total, game, variant } = req.body || {};
    if (!TOUR_EVENT_TYPES.has(type)) return res.status(400).json({ error: 'invalid tour event type' });
    try {
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        action: 'tour.event',
        outcome: 'success',
        requestId: req.requestId,
        metadata: { type, step: step ?? null, total: total ?? null, game: game || null, variant: variant || 'full' },
      });
    } catch { /* recording failure must never break the tour */ }
    res.json({ ok: true });
  });

  return router;
};
