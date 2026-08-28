'use strict';

/*
 * Authenticated bug-report API (plan: .hermes/plans/2026-08-14_235510-report-bug-github.md,
 * Task 4). Contract pinned by test/bug-reports-routes.test.cjs:
 *
 *   module.exports = function bugReportsRouter(deps) { ... }  // express.Router()
 *
 * Routes (relative to the /api mount, where authentication is already enforced):
 *   POST /bug-reports            create a report (authenticated, per-user throttled)
 *   GET  /bug-reports/:id        owner-only; admins may read any report
 *   PUT  /config/bug-reports     admin-only; update non-secret settings, redacted reply
 *
 * This router is intentionally NOT server-scoped: a report belongs to the panel
 * and the reporter, never to whichever game server happens to be selected, so
 * X-Hostkind-Server-Id headers and config.activeServerId are ignored here.
 *
 * Injected deps (no live network):
 *   deps.bugReports     { create(input) -> report, get(id) -> report|null }
 *   deps.syncReport     async (report) -> { state:'pending'|'synced'|'failed',
 *                                           issueUrl, issueNumber, error } — must NOT throw
 *   deps.audit          lib/audit.cjs (real: redaction + storage verified by the tests)
 *   deps.getConfig      () -> current bugReports config block
 *   deps.normalizeConfig/redactConfig   lib/bug-report-config.cjs contract
 *   deps.saveConfig     (next) => void
 *   deps.throttleLimits { max, windowMs }  optional; defaults { max: 5, windowMs: 60000 }
 *   deps.panelVersion   () -> version string (optional)
 *
 * Error bodies use the i18n-style keys ('unauthorized', 'forbidden', ...) rather
 * than localized strings; the SPA renders them. The GitHub token is never
 * accepted from the browser: a token in a PUT body is ignored (rotation is
 * environment-driven) and every config response is redacted.
 */

const express = require('express');
const { redactString } = require('../redact.cjs');

const LIMITS = {
  titleMax: 200,
  descriptionMax: 8000,
  optionalMax: 4000, // reproduction steps / expected behaviour
  contextMax: 200,   // game / view / route / userAgent
};
// Raw-body ceiling for this router (matches the focused-test harness limit).
// Oversized raw bodies are rejected before field validation runs.
const MAX_BODY_BYTES = 64 * 1024;
// Env var the config module reads the GitHub token from; hardcoded here so the
// router keeps zero coupling to lib/bug-report-config.cjs (it is injected).
const GITHUB_TOKEN_ENV = 'FLEETDECK_GITHUB_TOKEN';

module.exports = function bugReportsRouter(deps) {
  const router = express.Router();
  const limits = Object.assign({ max: 5, windowMs: 60000 }, deps.throttleLimits || {});
  const audit = deps.audit;
  // Per-user submission throttle: userId -> [attempt timestamps within window].
  // In-memory is fine for the single-process panel (same tradeoff as the login
  // brute-force throttle in server.js).
  const attempts = new Map();

  // Cheap raw-size guard. Field validation below enforces the per-field caps;
  // this only stops multi-hundred-KB junk before it is processed. The router is
  // mounted at /api, so scope the guard to this feature's own endpoint: unrelated
  // uploads (including image/form-data requests) must reach their own routes.
  router.use(['/bug-reports', '/config/bug-reports'], (req, res, next) => {
    if (req.method !== 'GET') {
      const len = Number(req.get('content-length') || 0);
      if (len > MAX_BODY_BYTES) return res.status(413).json({ error: 'payload_too_large' });
    }
    next();
  });

  function recordAudit(event) {
    try {
      audit.record(event);
    } catch (err) {
      // The report itself is already durable; a broken audit log must not fail
      // the request (mirrors the health-router pattern of guarding audit calls).
      console.error('bug-report audit failed:', (err && err.message) || err);
    }
  }

  // Map a stored row to the response shape. The injected store returns camelCase
  // rows (test fake) while lib/bug-reports.cjs returns snake_case columns; the
  // response always carries camelCase aliases so the SPA reads one shape.
  function presentReport(row) {
    if (!row) return row;
    const out = Object.assign({}, row);
    if (out.sync_state !== undefined && out.syncState === undefined) out.syncState = out.sync_state;
    if (out.issue_number !== undefined && out.issueNumber === undefined) out.issueNumber = out.issue_number;
    if (out.issue_url !== undefined && out.issueUrl === undefined) out.issueUrl = out.issue_url;
    if (out.last_error !== undefined && out.lastError === undefined) out.lastError = out.last_error;
    if (out.created_at !== undefined && out.createdAt === undefined) out.createdAt = out.created_at;
    if (out.actor_id !== undefined && out.actorId === undefined) out.actorId = out.actor_id;
    if (out.actor_username !== undefined && out.actorUsername === undefined) out.actorUsername = out.actor_username;
    if (out.repro_steps !== undefined && out.reproSteps === undefined) out.reproSteps = out.repro_steps;
    if (out.user_agent !== undefined && out.userAgent === undefined) out.userAgent = out.user_agent;
    return out;
  }

  // Validate and normalize the POST body. Returns { error } or the clean fields.
  function parseReportBody(req) {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return { error: 'title_required' };
    if (title.length > LIMITS.titleMax) return { error: 'title_too_long' };

    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) return { error: 'description_required' };
    if (description.length > LIMITS.descriptionMax) return { error: 'description_too_long' };

    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const fields = {
      // The browser uses the compact `repro` field; accept the descriptive
      // `reproduction` alias too for API clients and backwards-compatible
      // callers.
      reproSteps: text(body.repro ?? body.reproduction),
      expected: text(body.expected),
      game: text(body.game),
      view: text(body.view),
      route: text(body.route),
    };
    for (const [key, value] of Object.entries(fields)) {
      const max = (key === 'reproSteps' || key === 'expected') ? LIMITS.optionalMax : LIMITS.contextMax;
      if (value.length > max) return { error: 'field_too_long' };
    }

    const ua = req.get('user-agent');
    const userAgent = (typeof ua === 'string' ? ua : '').slice(0, LIMITS.contextMax) || null;
    return { title, description, userAgent, ...fields };
  }

  // POST /api/bug-reports — authenticated, per-user throttled, persisted before
  // any sync attempt, 201 (non-5xx) even when GitHub is down.
  router.post('/bug-reports', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });

    const now = Date.now();
    const window = (attempts.get(req.user.id) || []).filter((t) => now - t < limits.windowMs);
    if (window.length >= limits.max) {
      const retryAfter = Math.max(0, Math.ceil((window[0] + limits.windowMs - now) / 1000));
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }
    window.push(now);
    attempts.set(req.user.id, window);

    const parsed = parseReportBody(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let report;
    try {
      report = deps.bugReports.create({
        actorId: req.user.id,
        actorUsername: req.user.username || null,
        game: parsed.game || null,
        view: parsed.view || null,
        route: parsed.route || null,
        title: parsed.title,
        description: parsed.description,
        reproSteps: parsed.reproSteps || null,
        expected: parsed.expected || null,
        userAgent: parsed.userAgent,
        version: deps.panelVersion ? String(deps.panelVersion() || '') : undefined,
      });
    } catch {
      return res.status(400).json({ error: 'invalid_report' });
    }

    recordAudit({
      actorId: req.user.id,
      actorUsername: req.user.username || null,
      action: 'bug_report.created',
      targetType: 'bug_report',
      targetId: report.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { reportId: report.id },
    });

    // Sync is best-effort and must never fail the request: the row is already
    // durable, and the scheduler retries pending/failed rows later.
    let sync;
    try {
      sync = await deps.syncReport(report);
    } catch (err) {
      sync = { state: 'failed', issueNumber: null, issueUrl: null, error: String((err && err.message) || err || 'sync failed') };
    }
    sync = {
      state: (sync && (sync.state === 'synced' || sync.state === 'failed' || sync.state === 'pending')) ? sync.state : 'failed',
      issueNumber: sync && sync.issueNumber != null ? sync.issueNumber : null,
      issueUrl: sync && sync.issueUrl != null ? sync.issueUrl : null,
      reason: sync && typeof sync.reason === 'string' ? sync.reason : null,
      message: sync && typeof sync.message === 'string' ? sync.message : null,
      trackerUrl: sync && typeof sync.trackerUrl === 'string' ? sync.trackerUrl : null,
      error: sync && typeof sync.error === 'string' ? redactString(sync.error).text : (sync && sync.error != null ? sync.error : null),
    };

    // Re-read the row so the response mirrors the post-sync state (the sync
    // module records its outcome on the row itself).
    const fresh = deps.bugReports.get(report.id) || report;

    const auditMetadata = {
      reportId: report.id,
      state: sync.state,
    };
    if (sync.issueNumber != null) auditMetadata.issueNumber = sync.issueNumber;
    if (sync.issueUrl != null) auditMetadata.issueUrl = sync.issueUrl;
    if (sync.error != null) auditMetadata.error = sync.error;

    recordAudit({
      actorId: req.user.id,
      actorUsername: req.user.username || null,
      action: 'bug_report.sync',
      targetType: 'bug_report',
      targetId: report.id,
      outcome: sync.state === 'synced' ? 'success' : (sync.state === 'failed' ? 'failure' : 'pending'),
      requestId: req.requestId,
      metadata: auditMetadata,
    });

    res.status(201).json({ report: presentReport(fresh), sync });
  });

  // GET /api/bug-reports/:id — the reporter may read their own report; admins
  // may inspect any report (support workflow). No report contents beyond the
  // row itself; the response never carries secrets.
  router.get('/bug-reports/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const report = deps.bugReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'not_found' });
    const ownerId = report.actorId || report.actor_id;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json({ report: presentReport(report) });
  });

  // PUT /api/config/bug-reports — admin only. Non-secret integration settings;
  // a token in the request body is ignored (rotation is environment-driven),
  // and the response config is always redacted.
  router.put('/config/bug-reports', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const input = Object.assign({}, body);
    // Never accept a browser-supplied token: strip it (and the env-key spelling)
    // before normalization so the only token source is the process environment.
    delete input.token;
    delete input[GITHUB_TOKEN_ENV];

    const normalized = deps.normalizeConfig(input, process.env);
    if (normalized.errors && normalized.errors.length) {
      return res.status(400).json({ error: 'invalid_config' });
    }

    // Persist the redacted block: the token (if any) stays in the environment.
    const toSave = deps.redactConfig(normalized);
    try {
      deps.saveConfig(toSave);
    } catch {
      return res.status(500).json({ error: 'config_save_failed' });
    }
    res.json({ ok: true, config: deps.redactConfig(normalized) });
  });

  return router;
};
