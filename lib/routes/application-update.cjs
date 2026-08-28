'use strict';

/*
 * Admin-only application-updater API (gauntlet contract:
 * .gauntlet/application-updater-contract.md). Contract pinned by
 * test/application-update-routes.test.cjs:
 *
 *   module.exports = function applicationUpdateRouter(deps) { ... }  // express.Router()
 *
 * Mounted by server.js under /api (lead's wiring, not tested here):
 *   app.use('/api', applicationUpdateRouter({ service, fetchImpl }))
 *
 * Routes (relative to the /api mount; the router re-checks req.user at the
 * route seam, same convention as lib/routes/bug-reports.cjs):
 *   GET  /application-update/status    read-only; never refreshes, never touches the network
 *   POST /application-update/check     service.check()    (refresh release metadata)
 *   POST /application-update/download  service.download() (stages the artifact; never installs)
 *   POST /application-update/install   service.install({ approved }) — only the literal
 *                                      boolean true is forwarded as approval; the service
 *                                      owns the approval policy (incl. the high-priority path)
 *
 * Injected deps (no live network):
 *   deps.service   mirrors createApplicationUpdater(...): { getStatus(), check(),
 *                  download(), install({ approved }) }. Methods may be sync or
 *                  async; every failure is contained and never escapes the router.
 *   deps.fetchImpl is a TRIPWIRE — this router never performs network I/O itself
 *                  and never invokes it (it is accepted only for wiring parity).
 *
 * Response envelopes:
 *   success: { ok: true, status: <status object exactly as the service returned it> }
 *   error:   { ok: false, error: { code, message } }  (never a `status` field)
 *
 * Failure mapping:
 *   typed code 'invalid_transition' | 'INVALID_TRANSITION' -> HTTP 409 invalid_transition
 *   typed code 'approval_required'  | 'APPROVAL_REQUIRED'  -> HTTP 409 approval_required
 *   any other typed {code,message}  -> HTTP 502 (upstream: release client / installer);
 *                                      lowercase wire codes pass through untouched; uppercase
 *                                      core codes are normalized to lowercase on the wire
 *   anything else (raw throw)       -> HTTP 500 { code: 'internal_error' }
 *
 * JSON stays bounded: error bodies carry only { code, message } (no stacks, no
 * original error objects, no request-body echo) and responses are serialized
 * defensively so an unserializable status object cannot escape as an exception.
 */

const express = require('express');

// Wire spelling for state-machine / approval-policy conflicts. Both the
// lowercase service-contract spelling and the uppercase core spelling are
// accepted and collapsed to the contract wire code.
const CONFLICT_WIRE_CODES = new Map([
  ['invalid_transition', 'invalid_transition'],
  ['INVALID_TRANSITION', 'invalid_transition'],
  ['approval_required', 'approval_required'],
  ['APPROVAL_REQUIRED', 'approval_required'],
]);

const INTERNAL_MESSAGE = 'unexpected internal error';

// Any other non-empty string code (a lowercase wire code, or an uppercase core
// code) is normalized to lowercase for the wire; service-provided lowercase
// codes therefore pass through verbatim.
function toWireCode(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'upstream_error';
  return raw.toLowerCase();
}

// Serialize defensively: bounded payloads only, and never let a circular or
// otherwise unserializable value escape as an exception.
function sendJson(res, status, payload) {
  if (res.headersSent) return;
  let text;
  try {
    text = JSON.stringify(payload);
  } catch (err) {
    text = JSON.stringify({ ok: false, error: { code: 'internal_error', message: INTERNAL_MESSAGE } });
  }
  res.status(status).type('application/json').send(text);
}

// Map a contained failure to the contract envelope. Returns null for raw
// throws (no string `code` on the thrown value).
function mapFailure(err) {
  const raw = err && typeof err === 'object' ? err.code : undefined;
  const code = typeof raw === 'string' && raw.length > 0 ? raw : null;
  if (code === null) return null; // raw throw -> 500 internal_error
  const message = err && typeof err.message === 'string' && err.message.length > 0 ? err.message : null;
  const conflict = CONFLICT_WIRE_CODES.get(code);
  if (conflict) {
    return { status: 409, code: conflict, message: message || conflict };
  }
  const wire = toWireCode(code);
  return { status: 502, code: wire, message: message || wire };
}

// Every handler runs inside this guard: a throwing service (sync or async)
// becomes a contract envelope and can never escape the route module.
function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const mapped = mapFailure(err);
      if (mapped) {
        try {
          sendJson(res, mapped.status, { ok: false, error: { code: mapped.code, message: mapped.message } });
        } catch (inner) {
          // Last-resort containment; nothing else to do.
        }
      } else {
        // Server-side diagnostic only — never echoed to the client.
        try {
          console.error('application-update route internal error:', err && err.stack ? err.stack : String(err));
        } catch (logErr) {
          // Logging must not kill the route either.
        }
        try {
          sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: INTERNAL_MESSAGE } });
        } catch (inner) {
          // Last-resort containment; nothing else to do.
        }
      }
    }
  };
}

// Route-seam authorization: the server.js /api middleware applies the real
// auth on top; this router still re-checks req.user so a mis-mounted router
// can never reach the service unauthenticated. Uses the existing response
// shapes ({ error: 'unauthorized' } / { error: 'forbidden' }).
function requireAdmin(req, res) {
  if (!req.user) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  if (req.user.role !== 'admin') {
    sendJson(res, 403, { error: 'forbidden' });
    return false;
  }
  return true;
}

module.exports = function applicationUpdateRouter(deps) {
  const service = (deps && deps.service) || {};
  const router = express.Router();

  // GET /api/application-update/status — read-only state echo; never refreshes
  // release metadata and never performs network I/O.
  router.get('/application-update/status', guard(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = await service.getStatus();
    sendJson(res, 200, { ok: true, status });
  }));

  // POST /api/application-update/check — refresh release metadata via the
  // injected service (the route itself never fetches).
  router.post('/application-update/check', guard(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = await service.check();
    sendJson(res, 200, { ok: true, status });
  }));

  // POST /api/application-update/download — stage the selected artifact only;
  // this never installs.
  router.post('/application-update/download', guard(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = await service.download();
    sendJson(res, 200, { ok: true, status });
  }));

  // POST /api/application-update/install — forward the approval flag verbatim.
  // Only the literal boolean true counts as approval ('yes', 1, null, missing
  // all become false); the service owns the approval policy, including the
  // high-priority no-approval path.
  router.post('/application-update/install', guard(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const status = await service.install({ approved: body.approved === true });
    sendJson(res, 200, { ok: true, status });
  }));

  return router;
};