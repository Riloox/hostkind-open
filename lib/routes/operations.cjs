'use strict';

/*
 * /api/operations routes.
 *
 * Spec contract (docs/roadmap/README.md "Durable operations"):
 *   - GET /api/operations?cursor=&serverId=&state=
 *   - GET /api/operations/:id
 *   - POST /api/operations/:id/cancel, /resume, /rollback
 *   - Long mutations return 202 { ok: true, operationId }
 *
 * Read endpoints require a valid JWT. Mutating endpoints also require the
 * right capability. This router doesn't itself dispatch long mutations -
 * features that need one (spec 01/02/03/...) create the operation via
 * operations.create() and hand the work off to their own runner.
 */

const express = require('express');
const operations = require('../operations.cjs');
const audit = require('../audit.cjs');
const installRun = require('../installRun.cjs');
const { CAPABILITIES, requireCap, has } = require('../capabilities.cjs');
const { sendError } = require('../httpError.cjs');
const { redactString } = require('../redact.cjs');

function mayView(user, op) {
  return !!user && (user.role === 'admin' || op.actorId === user.id || has(user, op.serverId, CAPABILITIES.SERVER_CONTROL));
}

function router() {
  const r = express.Router();

  r.get('/', (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { serverId, state, cursor, limit } = req.query;
    if (user.role !== 'admin') {
      if (!serverId) return res.status(400).json({ error: 'serverId_required' });
      if (!has(user, serverId, CAPABILITIES.SERVER_CONTROL)) return res.status(403).json({ error: 'forbidden' });
    }
    const items = operations.list({
      serverId: serverId || null,
      state: state || null,
      cursor: cursor || null,
      limit: limit ? Math.min(200, parseInt(limit, 10) || 50) : 50,
    });
    res.json({ ok: true, ...items });
  });

  r.get('/:id', (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const op = operations.get(req.params.id);
    if (!op) return res.status(404).json({ error: 'not_found' });
    if (!mayView(user, op)) return res.status(403).json({ error: 'forbidden' });
    const events = operations.listEvents(req.params.id);
    res.json({ ok: true, operation: op, events });
  });

  r.post('/:id/cancel', requireCap(CAPABILITIES.SERVER_CONTROL, { getServerId: (req) => (operations.get(req.params.id) || {}).serverId }), (req, res) => {
    const user = req.user;
    const op = operations.cancel(req.params.id);
    if (!op) return res.status(404).json({ error: 'not_found' });
    audit.record({
      actorId: user && user.id,
      serverId: op.serverId,
      action: 'operation.cancel',
      target: { operationId: op.id, kind: op.kind },
      outcome: 'success',
      requestId: req.requestId,
      operationId: op.id,
    });
    res.json({ ok: true, operation: op });
  });

  r.post('/:id/resume', requireCap(CAPABILITIES.SERVER_CONTROL, { getServerId: (req) => (operations.get(req.params.id) || {}).serverId }), async (req, res) => {
    const user = req.user;
    const op = operations.get(req.params.id);
    if (!op) return res.status(404).json({ error: 'not_found' });
    if (op.state !== operations.STATES.RECOVERY_REQUIRED) {
      return res.status(409).json({ error: 'not_recoverable', state: op.state });
    }
    audit.record({
      actorId: user && user.id,
      serverId: op.serverId,
      action: 'operation.resume',
      target: { operationId: op.id, kind: op.kind },
      outcome: 'requested',
      requestId: req.requestId,
      operationId: op.id,
    });
    // Only install/create operations carry a recovery plan this router can
    // replay (the download phase continues from the .part offset). Every
    // other recovery_required kind stays feature-specific.
    if (!installRun.isResumableInstallKind(op.kind)) {
      return res.json({ ok: true, operation: op, message: 'resume is feature-specific' });
    }
    try {
      const result = await installRun.resumeInstall(op);
      audit.record({
        actorId: user && user.id,
        serverId: op.serverId,
        action: 'operation.resume',
        target: { operationId: op.id, kind: op.kind },
        outcome: 'success',
        requestId: req.requestId,
        operationId: op.id,
      });
      return res.json({ ok: true, operation: result.operation, resumed: result.resumed });
    } catch (err) {
      audit.record({
        actorId: user && user.id,
        serverId: op.serverId,
        action: 'operation.resume',
        target: { operationId: op.id, kind: op.kind },
        outcome: 'failed',
        metadata: { code: err.code || 'resume_failed', message: redactString(String((err && err.message) || '')).text },
        requestId: req.requestId,
        operationId: op.id,
      });
      return sendError(res, err);
    }
  });

  r.post('/:id/rollback', requireCap(CAPABILITIES.SERVER_CONTROL, { getServerId: (req) => (operations.get(req.params.id) || {}).serverId }), (req, res) => {
    const user = req.user;
    const op = operations.get(req.params.id);
    if (!op) return res.status(404).json({ error: 'not_found' });
    if (!op.recovery) {
      return res.status(409).json({ error: 'no_recovery_instructions' });
    }
    audit.record({
      actorId: user && user.id,
      serverId: op.serverId,
      action: 'operation.rollback',
      target: { operationId: op.id, kind: op.kind, snapshotId: op.recovery.snapshotId || null },
      outcome: 'requested',
      requestId: req.requestId,
      operationId: op.id,
    });
    res.json({ ok: true, operation: op, message: 'rollback is feature-specific' });
  });

  return r;
}

module.exports = { router };
