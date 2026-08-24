'use strict';

/*
 * Standalone GitHub Issues client for the relay.
 *
 * Native fetch only, with injectable fetch/baseUrl for tests — no live
 * network in the test suite. The credential is server-side only: the token
 * rides exclusively in the Authorization header, is never placed in the
 * request body/URL, and every error message is redacted before it can reach
 * a log or the stored report row.
 *
 * The destination (owner/repo/labels) is FIXED at construction time from
 * environment/config — a client can never be pointed at an arbitrary
 * repository or API path by report content.
 *
 * Exports:
 *   createGitHubClient(deps) -> { createIssue(input), findIssueByMarker(marker) }
 *   githubClientFromEnv(env) -> client, throws when the token is missing
 *     (fail closed — the relay must not run without a credential)
 *   buildIssueBody(input)    -> markdown string (pure)
 *   classifyResponse(status, { retryAfter }) -> { kind, retryable, retryAfterMs? }
 *   redactSecrets(text, token) -> text with secret forms replaced
 *   GitHubApiError           -> { name, message, status, kind, retryable, retryAfterMs }
 */

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_LABELS = ['bug', 'in-app-report'];
const DEFAULT_TIMEOUT_MS = 15_000;

class GitHubApiError extends Error {
  constructor(message, { status = null, kind = 'unknown', retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/*
 * Replace every secret form with '[REDACTED]': the exact token literal,
 * ghp_/github_pat_ shaped PATs, and 'Bearer <secret>' sequences.
 */
function redactSecrets(text, token) {
  let out = String(text);
  if (token) out = out.split(String(token)).join('[REDACTED]');
  out = out.replace(/(?:github_pat_|ghp_)[A-Za-z0-9_]*/g, '[REDACTED]');
  out = out.replace(/\bBearer\s+\S+/g, 'Bearer [REDACTED]');
  return out;
}

/*
 * Classify an HTTP status into a { kind, retryable, retryAfterMs } triple.
 * 429 honours the Retry-After header (seconds -> ms) with a 60s fallback.
 * Authorization/configuration failures (401/403/404/422) are NEVER retried.
 */
function classifyResponse(status, { retryAfter } = {}) {
  if (status === 200 || status === 201) return { kind: 'ok', retryable: false };
  if (status === 401) return { kind: 'auth', retryable: false };
  if (status === 403) return { kind: 'forbidden', retryable: false };
  if (status === 404) return { kind: 'not_found', retryable: false };
  if (status === 422) return { kind: 'validation', retryable: false };
  if (status === 429) {
    const seconds = Number.parseInt(String(retryAfter), 10);
    return {
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
    };
  }
  if (status >= 500 && status <= 599) return { kind: 'server_error', retryable: true };
  return { kind: 'unknown', retryable: false };
}

/*
 * Escape user-supplied text so it can never introduce a Markdown heading:
 * leading '#' (with the 0-3 spaces ATX allows) is backslash-escaped per line.
 */
function escapeMarkdown(text) {
  if (text == null) return '';
  return String(text).split(/\r?\n/).map((line) => (
    /^ {0,3}#{1,6}/.test(line) ? line.replace(/^( {0,3})(#{1,6})/, '$1\\$2') : line
  )).join('\n');
}

function valueOrDash(value) {
  if (value == null) return 'Not provided';
  const s = String(value).trim();
  return s === '' ? 'Not provided' : s;
}

/*
 * Pure builder for the GitHub issue body. Fixed heading set; every
 * user-supplied field is escaped; ends with the machine-readable marker
 * comment when a marker is given, preceded by an in-app-reporter note.
 */
function buildIssueBody(input = {}) {
  const parts = [
    '## Summary',
    escapeMarkdown(valueOrDash(input.summary)),
    '',
    '## Description',
    escapeMarkdown(valueOrDash(input.description)),
    '',
    '## Current screen',
    valueOrDash(input.route),
    valueOrDash(input.view),
    '',
    '## Game',
    valueOrDash(input.game),
    '',
    '## Timestamp',
    valueOrDash(input.timestamp),
    '',
    '## Hostkind version',
    valueOrDash(input.version),
    '',
    '## Browser',
    valueOrDash(input.userAgent),
    '',
    '## Reproduction steps',
    escapeMarkdown(valueOrDash(input.reproSteps)),
    '',
    '## Expected behaviour',
    escapeMarkdown(valueOrDash(input.expected)),
  ];

  parts.push(
    '',
    '---',
    '*This report was filed through the Hostkind in-app reporter.*',
  );
  if (input.marker) {
    parts.push('', `<!-- fleetdeck-report-marker: ${input.marker} -->`);
  }
  return parts.join('\n');
}

function createGitHubClient(deps = {}) {
  const { token, owner, repo } = deps;
  if (!token) throw new Error('relay-github: token is required (fail closed)');
  if (!owner) throw new Error('relay-github: owner is required');
  if (!repo) throw new Error('relay-github: repo is required');

  const labels = Array.isArray(deps.labels) ? deps.labels : DEFAULT_LABELS;
  const baseUrl = String(deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
  const timeoutMs = deps.timeoutMs !== undefined ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const userAgent = `HostkindRelay/${deps.version || '1.0'} (bug-report relay)`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };

  function redactedMessage(message, status) {
    const text = message ? String(message) : `GitHub API error (status ${status})`;
    return redactSecrets(text, token);
  }

  async function request(url, init) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      return await fetchImpl(url, {
        method: init.method,
        headers: { ...headers, ...(init.headers || {}) },
        body: init.body,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      // Network/abort failures: retryable, message redacted.
      throw new GitHubApiError(redactedMessage(err && err.message ? err.message : 'network error'), {
        kind: 'network',
        retryable: true,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  async function throwForStatus(res) {
    const body = await readJson(res);
    const retryAfter = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('retry-after')
      : null;
    const classified = classifyResponse(res.status, { retryAfter });
    const detail = body && body.message ? String(body.message) : '';
    const message = detail
      ? `GitHub API error ${res.status}: ${detail}`
      : `GitHub API error (status ${res.status})`;
    throw new GitHubApiError(
      redactedMessage(message, res.status),
      {
        status: res.status,
        kind: classified.kind,
        retryable: classified.retryable,
        retryAfterMs: classified.retryAfterMs || null,
      },
    );
  }

  async function createIssue({ title, body, marker } = {}) {
    const finalTitle = String(title || '').startsWith('[In-app report] ')
      ? String(title)
      : `[In-app report] ${title || ''}`;

    let issueBody = body == null ? '' : String(body);
    if (marker && !issueBody.includes('fleetdeck-report-marker:')) {
      issueBody += `\n\n<!-- fleetdeck-report-marker: ${marker} -->`;
    }

    const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
    const res = await request(url, {
      method: 'POST',
      body: JSON.stringify({ title: finalTitle, body: issueBody, labels }),
    });

    if (!res.ok) await throwForStatus(res);

    const payload = await readJson(res);
    if (payload == null || !Number.isInteger(payload.number)) {
      // The issue may exist (ambiguous 2xx); only marker reconciliation may
      // safely re-create it, so this is deliberately non-retryable.
      throw new GitHubApiError('GitHub responded 2xx without an issue number (malformed response)', {
        status: res.status,
        kind: 'malformed',
        retryable: false,
      });
    }
    return {
      ok: true,
      issueNumber: payload.number,
      issueUrl: payload.html_url || `${baseUrl}/${owner}/${repo}/issues/${payload.number}`,
      status: res.status,
    };
  }

  async function findIssueByMarker(marker) {
    const query = encodeURIComponent(`repo:${owner}/${repo} "${marker}"`);
    const url = `${baseUrl}/search/issues?q=${query}`;
    const res = await request(url, { method: 'GET' });

    if (!res.ok) await throwForStatus(res);

    const payload = await readJson(res);
    const items = Array.isArray(payload && payload.items) ? payload.items : [];
    const hit = items.find((item) => item && Number.isInteger(item.number));
    if (!hit) return null;
    return {
      issueNumber: hit.number,
      issueUrl: hit.html_url || `${baseUrl}/${owner}/${repo}/issues/${hit.number}`,
    };
  }

  return { createIssue, findIssueByMarker };
}

/*
 * Build the client from environment variables. Fails closed when the token
 * is missing — the relay must not run without a credential. The destination
 * repository is fixed in configuration, never chosen by report content.
 */
function githubClientFromEnv(env = process.env) {
  const token = env.RELAY_GITHUB_TOKEN;
  const owner = env.RELAY_GITHUB_OWNER || 'Riloox';
  const repo = env.RELAY_GITHUB_REPO || 'hostkind-open';
  return createGitHubClient({
    token,
    owner,
    repo,
    version: env.RELAY_VERSION,
    baseUrl: env.RELAY_GITHUB_BASE_URL,
    timeoutMs: env.RELAY_GITHUB_TIMEOUT_MS ? Number(env.RELAY_GITHUB_TIMEOUT_MS) : undefined,
  });
}

module.exports = {
  createGitHubClient,
  githubClientFromEnv,
  buildIssueBody,
  classifyResponse,
  redactSecrets,
  GitHubApiError,
};
