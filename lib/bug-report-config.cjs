'use strict';

/*
 * Safe configuration for the GitHub-issue bug-report sync and upstream-relay mode.
 *
 * The integration is DISABLED by default and never crashes panel startup:
 * normalizeConfig() never throws — garbage input falls back to safe defaults
 * and invalid owner/repo/labels/mode/relayUrl force enabled=false with errors
 * populated.
 *
 * The GitHub token is server-side only. It is read from the environment
 * (FLEETDECK_GITHUB_TOKEN) with a config-block string as fallback, is never
 * required for normalization, and is stripped by redactConfig() so no API
 * response or log can expose it. Consumers derive the sync gate as
 * `enabled && token` from the normalized object.
 *
 * Modes:
 *   'github' (default)        — create issues in the configured owner/repo
 *                               using the server-side GitHub token.
 *   'upstream-relay'          — POST a validated, redacted payload to the
 *                               fixed relayUrl (server config only; the
 *                               browser can never set or override it). The
 *                               relay URL must be https; http://localhost and
 *                               http://127.0.0.1 are tolerated ONLY through
 *                               the explicit allowLocalhostHttp test seam.
 *
 * The upstream-relay client (buildRelayPayload / createRelayClient /
 * syncReportToRelay) lives here rather than in server.js so the whole POST
 * path is deterministic and unit-testable offline with an injected fetch.
 * server.js wires it to the durable store and the retry scheduler.
 */

const GITHUB_TOKEN_ENV = 'FLEETDECK_GITHUB_TOKEN';
const { redactObject } = require('./redact.cjs');

const DEFAULTS = {
  enabled: false,
  owner: 'Riloox',
  repo: 'hostkind-open',
  labels: ['bug'],
};

const MODE_GITHUB = 'github';
const MODE_UPSTREAM_RELAY = 'upstream-relay';
const MODES = new Set([MODE_GITHUB, MODE_UPSTREAM_RELAY]);

// Relay HTTP client defaults (mirror the relay's own request timeout).
const RELAY_TIMEOUT_MS = 10_000;

// The relay derives its idempotency key from `clientKey` and restricts it to
// safe characters (relay/lib/validate-report.cjs CLIENT_KEY_PATTERN).
const RELAY_CLIENT_KEY_PATTERN = /^[A-Za-z0-9._-]{8,100}$/;

// GitHub usernames/organizations cap at 39 chars; repo names allow a narrower
// set than owner names and cap at 100.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;
const OWNER_MAX = 39;
const REPO_MAX = 100;

// Localhost hosts accepted for http:// when the test seam is on.
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function asObject(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return {};
}

function normalizeOwner(input) {
  const raw = input.owner;
  // Absent owner -> default, no error (config may omit it entirely).
  if (raw === undefined || raw === null) {
    return { value: DEFAULTS.owner, error: null };
  }
  if (typeof raw === 'string' && raw.trim() !== '' &&
      raw.length <= OWNER_MAX && OWNER_PATTERN.test(raw)) {
    return { value: raw, error: null };
  }
  return { value: DEFAULTS.owner, error: 'invalid_owner' };
}

function normalizeRepo(input) {
  const raw = input.repo;
  if (raw === undefined || raw === null) {
    return { value: DEFAULTS.repo, error: null };
  }
  if (typeof raw === 'string' && raw.trim() !== '' &&
      raw.length <= REPO_MAX && REPO_PATTERN.test(raw)) {
    return { value: raw, error: null };
  }
  return { value: DEFAULTS.repo, error: 'invalid_repo' };
}

/*
 * Labels: array of strings (trimmed, empty dropped) or a comma-separated
 * string. Non-string entries are dropped; an all-invalid input falls back to
 * the default ['bug']. Duplicates are removed, order preserved.
 */
function normalizeLabels(input) {
  let entries = [];
  if (Array.isArray(input.labels)) {
    entries = input.labels;
  } else if (typeof input.labels === 'string') {
    entries = input.labels.split(',');
  } else {
    return [...DEFAULTS.labels];
  }
  const seen = new Set();
  const labels = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    labels.push(trimmed);
  }
  return labels.length > 0 ? labels : [...DEFAULTS.labels];
}

function normalizeToken(input, env) {
  const envValue = env && typeof env === 'object' && !Array.isArray(env) ? env[GITHUB_TOKEN_ENV] : undefined;
  const candidate = typeof envValue === 'string' && envValue.trim() !== ''
    ? envValue.trim()
    : (typeof input.token === 'string' && input.token.trim() !== ''
        ? input.token.trim()
        : null);
  return candidate;
}

function normalizeMode(input) {
  const raw = input.mode;
  if (raw === undefined || raw === null) return { value: MODE_GITHUB, error: null };
  if (typeof raw !== 'string') return { value: MODE_GITHUB, error: 'invalid_mode' };
  const mode = raw.trim();
  if (mode === '' || mode === MODE_GITHUB) return { value: MODE_GITHUB, error: null };
  if (mode === MODE_UPSTREAM_RELAY) return { value: MODE_UPSTREAM_RELAY, error: null };
  return { value: MODE_GITHUB, error: 'invalid_mode' };
}

/*
 * Validate a relay URL. Accepts https URLs only; http is tolerated solely for
 * localhost/loopback hosts and ONLY when opts.allowLocalhostHttp is true (the
 * offline test seam — production callers never pass it). Embedded URL
 * credentials (user:pass@host) are rejected outright.
 */
function validateRelayUrl(raw, opts = {}) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== 'string') return { value: null, error: 'invalid_relay_url' };
  const url = raw.trim();
  if (url === '') return { value: null, error: null };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { value: null, error: 'invalid_relay_url' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { value: null, error: 'invalid_relay_url' };
  }
  // Node keeps the brackets in hostname for IPv6 literals; normalize them away.
  const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') {
    // e.g. 'https:///path' parses with an empty host.
    return { value: null, error: 'invalid_relay_url' };
  }
  if (parsed.protocol === 'https:') {
    return { value: url, error: null };
  }
  if (opts.allowLocalhostHttp === true && parsed.protocol === 'http:') {
    if (LOCALHOST_HOSTS.has(host)) return { value: url, error: null };
  }
  return { value: null, error: 'invalid_relay_url' };
}

/*
 * Derive the public issue tracker link for the "not configured" UI fallback.
 * Installs without a relay URL or token (the open edition's default) cannot
 * sync reports, so the client offers a direct link to the configured
 * repository's issue chooser instead of a dead end. Derived purely from the
 * validated owner/repo — never from user input, never a secret — and fails
 * closed (null) on anything that would not form a well-behaved GitHub URL.
 */
function buildTrackerUrl(owner, repo) {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  const o = owner.trim();
  const r = repo.trim();
  if (o === '' || r === '' || o.length > OWNER_MAX || r.length > REPO_MAX) return null;
  if (!OWNER_PATTERN.test(o) || !REPO_PATTERN.test(r)) return null;
  return `https://github.com/${encodeURIComponent(o)}/${encodeURIComponent(r)}/issues/new/choose`;
}

/*
 * Pure normalization. Returns { enabled, owner, repo, labels, mode, relayUrl,
 * token, errors }. Never throws. Invalid owner/repo/labels/mode/relayUrl
 * disable synchronization instead of crashing panel startup. relayUrl is only
 * meaningful (and required) in 'upstream-relay' mode, but a malformed value is
 * an error in any mode because it indicates a broken server config.
 */
function normalizeConfig(input, env, opts = {}) {
  const raw = asObject(input);

  const owner = normalizeOwner(raw);
  const repo = normalizeRepo(raw);
  const labels = normalizeLabels(raw);
  const mode = normalizeMode(raw);
  const relayUrl = validateRelayUrl(raw.relayUrl, opts);
  const errors = [];
  if (owner.error) errors.push(owner.error);
  if (repo.error) errors.push(repo.error);
  if (mode.error) errors.push(mode.error);
  if (relayUrl.error) errors.push(relayUrl.error);
  // Upstream-relay mode without a usable relay URL is a broken config: the
  // mode is kept (so the operator sees what they asked for) but sync stays
  // disabled until the server-side URL is fixed.
  if (mode.value === MODE_UPSTREAM_RELAY && relayUrl.value === null) {
    errors.push('invalid_relay_url');
  }

  return {
    // `enabled` is a strict boolean: only the literal `true` enables.
    enabled: raw.enabled === true && errors.length === 0,
    owner: owner.value,
    repo: repo.value,
    labels,
    mode: mode.value,
    relayUrl: relayUrl.value,
    token: normalizeToken(raw, env),
    errors,
  };
}

/*
 * Redact a config object for responses/logging: returns a NEW object with
 * every token-bearing key removed (the token itself and the env var name).
 * relayUrl is NOT a credential and is preserved so admins can see the
 * configured destination. The input is never mutated.
 */
function redactConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const key of Object.keys(config)) {
    if (key === 'token' || key === GITHUB_TOKEN_ENV) continue;
    out[key] = config[key];
  }
  return out;
}

/*
 * Build the structured payload the relay accepts (relay/lib/validate-report.cjs
 * ALLOWED_FIELDS): title, description, reproSteps, expected, game, view,
 * route, userAgent, version, clientKey. Unknown fields are REJECTED by the
 * relay, so actor identity is deliberately NOT forwarded — reports become
 * public issue content, and actorUsername may itself be an email address.
 *
 * clientKey is the idempotency key the relay dedupes on: the stored marker
 * when it matches the relay's safe pattern, otherwise a deterministic
 * `fleetdeck-<id>` fallback so retries stay idempotent.
 *
 * Every string leaf is run through the panel-wide secret redactor
 * (lib/redact.cjs) before leaving the server; the relay re-redacts on its
 * side. Input is never mutated.
 */
function buildRelayPayload(report) {
  const src = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const pick = (camel, snake) => {
    const v = src[camel] != null ? src[camel] : src[snake];
    return typeof v === 'string' ? v.trim() : null;
  };
  const marker = pick('marker', 'marker');
  const clientKey = marker && RELAY_CLIENT_KEY_PATTERN.test(marker)
    ? marker
    : (src.id != null ? `fleetdeck-${src.id}` : null);
  const payload = {
    title: pick('title', 'title'),
    description: pick('description', 'description'),
    reproSteps: pick('reproSteps', 'repro_steps'),
    expected: pick('expected', 'expected'),
    game: pick('game', 'game'),
    view: pick('view', 'view'),
    route: pick('route', 'route'),
    userAgent: pick('userAgent', 'user_agent'),
    version: pick('version', 'version'),
  };
  if (clientKey != null) payload.clientKey = clientKey;
  // redactObject masks secret-shaped values in every string leaf (passwords,
  // tokens, bearer headers, AWS keys, IPs, ...) and never mutates the input.
  const redacted = redactObject(payload);
  // Extra pass for GitHub PAT-shaped strings: the panel-wide redactor has no
  // ghp_/github_pat_ rule (GitHub PATs are handled by the GitHub client's own
  // redaction), but the relay payload is the last line before the wire, so
  // mask them here too (same pattern the store uses for persisted errors).
  const PAT_PATTERN = /(?:github_pat_|ghp_)[A-Za-z0-9_]*/g;
  for (const key of Object.keys(redacted)) {
    if (typeof redacted[key] === 'string' && PAT_PATTERN.test(redacted[key])) {
      PAT_PATTERN.lastIndex = 0;
      redacted[key] = redacted[key].replace(PAT_PATTERN, '[REDACTED]');
      PAT_PATTERN.lastIndex = 0;
    }
  }
  return redacted;
}

/*
 * Minimal HTTP client for the upstream relay.
 *
 * createRelayClient(deps) -> { relayUrl, submit(report) }
 *   deps: { relayUrl (required), fetch (required in tests; defaults to the
 *           global fetch), timeoutMs (default 10_000) }
 *
 * submit(report) POSTs buildRelayPayload(report) to the fixed relayUrl with
 * content-type application/json. It resolves with
 *   { status, body, payload }   — body is the parsed JSON (or null) and is
 *                                 NOT interpreted here (the caller decides
 *                                 synced/queued/failed from status + issueUrl)
 * and throws ONLY on transport-level failures (network down, timeout), with
 * err.retryable = true so callers treat them as retryable. HTTP error
 * statuses (4xx/5xx) are returned, not thrown — they are the relay's answer
 * and carry no credentials.
 */
function createRelayClient(deps = {}) {
  const relayUrl = typeof deps.relayUrl === 'string' ? deps.relayUrl.trim() : '';
  if (relayUrl === '') {
    throw new Error('bug-report-config: relayUrl is required');
  }
  const fetchImpl = typeof deps.fetch === 'function'
    ? deps.fetch
    : (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof fetchImpl !== 'function') {
    throw new Error('bug-report-config: no fetch implementation available');
  }
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : RELAY_TIMEOUT_MS;

  async function submit(report) {
    const payload = buildRelayPayload(report);
    if (!payload.title || !payload.description) {
      const err = new Error('bug-report relay: report is missing title or description');
      err.retryable = false;
      err.code = 'relay_invalid_report';
      throw err;
    }
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(relayUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      const wrapped = new Error(
        timedOut
          ? 'bug-report relay: request timed out'
          : `bug-report relay unreachable: ${(err && err.message) || err}`
      );
      wrapped.retryable = true;
      wrapped.code = timedOut ? 'relay_timeout' : 'relay_network_error';
      throw wrapped;
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, payload };
  }

  return { relayUrl, submit };
}

/*
 * One-shot relay sync with the same contract as syncBugReportNow in server.js:
 * never throws, records outcomes on the durable row through the injected
 * markSynced/markFailed seams, and returns a router-friendly summary.
 *
 * State machine (contract: mark synced when issueUrl is returned, leave
 * pending when queued, retry when relay/network failed):
 *   - response carries a non-empty issueUrl   -> markSynced, state 'synced'
 *   - 202 Accepted / state 'queued' (no url)  -> leave the row pending with a
 *     useful message (the relay queue owns it; the scheduler keeps polling
 *     with the same idempotency key until the issue exists)
 *   - any other status (4xx/5xx, or a 201/202 with no url) -> markFailed with
 *     attempts+1 (retryable; the scheduler's bounded backoff gates re-posts)
 *   - transport failure (network/timeout)     -> markFailed with attempts+1,
 *     reason 'relay_unreachable'
 *
 * deps: { relayUrl, fetch?, timeoutMs?, markSynced(id, {issueUrl}),
 *         markFailed(id, {error, attempts}) }  — mark* default to no-ops.
 */
async function syncReportToRelay(report, deps = {}) {
  const relayUrl = typeof deps.relayUrl === 'string' ? deps.relayUrl.trim() : '';
  if (relayUrl === '') {
    return {
      state: 'pending',
      issueNumber: null,
      issueUrl: null,
      reason: 'not_configured',
      message: 'Upstream relay mode is enabled but no relayUrl is configured. The report is saved locally and will sync after an administrator configures it.',
      error: 'sync_disabled: relay URL is not configured',
      trackerUrl: typeof deps.trackerUrl === 'string' && deps.trackerUrl.trim() !== '' ? deps.trackerUrl.trim() : null,
    };
  }
  const markSynced = typeof deps.markSynced === 'function' ? deps.markSynced : () => {};
  const markFailed = typeof deps.markFailed === 'function' ? deps.markFailed : () => {};
  const client = createRelayClient({
    relayUrl,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
  });
  const reportId = report && report.id;
  const attempts = (report && Number.isFinite(Number(report.attempts)) ? Number(report.attempts) : 0) + 1;

  let result;
  try {
    result = await client.submit(report);
  } catch (err) {
    const error = String((err && err.message) || err || 'relay sync failed');
    try { markFailed(reportId, { error, attempts }); } catch { /* row stays pending */ }
    return {
      state: 'failed',
      issueNumber: null,
      issueUrl: null,
      reason: err && err.code === 'relay_timeout' ? 'relay_timeout' : 'relay_unreachable',
      message: error,
      error,
    };
  }

  const body = result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body : {};
  const issueUrl = typeof body.issueUrl === 'string' && body.issueUrl.trim() !== ''
    ? body.issueUrl.trim()
    : null;
  const state = typeof body.state === 'string' ? body.state : '';

  if (issueUrl !== null) {
    try { markSynced(reportId, { issueNumber: null, issueUrl }); } catch { /* row stays pending */ }
    return { state: 'synced', issueNumber: null, issueUrl, reason: null, message: null, error: null };
  }

  if (result.status === 202 || state === 'queued') {
    // Accepted into the relay's durable queue; no upstream issue yet. Leave
    // the row pending — the retry scheduler re-posts with the same clientKey
    // (idempotent at the relay) until the issue exists.
    return {
      state: 'pending',
      issueNumber: null,
      issueUrl: null,
      reason: 'queued_upstream',
      message: 'The report is queued at the upstream relay; it will sync once the relay creates the upstream issue.',
      error: null,
    };
  }

  const code = typeof body.error === 'string'
    ? body.error
    : (body.error && typeof body.error === 'object' && !Array.isArray(body.error) && typeof body.error.code === 'string' ? body.error.code : null);
  const error = `upstream relay rejected the report (HTTP ${result.status}${code ? `: ${code}` : ''})`;
  try { markFailed(reportId, { error, attempts }); } catch { /* row stays pending */ }
  return {
    state: 'failed',
    issueNumber: null,
    issueUrl: null,
    reason: 'relay_rejected',
    message: error,
    error,
  };
}

module.exports = {
  DEFAULTS,
  GITHUB_TOKEN_ENV,
  MODE_GITHUB,
  MODE_UPSTREAM_RELAY,
  MODES,
  RELAY_TIMEOUT_MS,
  normalizeConfig,
  redactConfig,
  validateRelayUrl,
  buildTrackerUrl,
  buildRelayPayload,
  createRelayClient,
  syncReportToRelay,
};
