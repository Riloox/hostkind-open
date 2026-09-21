'use strict';

/*
 * Shared HTTP error helper: single place where route error responses are
 * shaped and secrets are stripped before they reach the client.
 *
 * Contract:
 *   sendError(res, err) -> res.status(status).json({ error, code? })
 *   - status = err.status (if finite 400..599) else 500
 *   - code = err.code when a non-empty string, else omitted
 *   - message: for 5xx, a generic "Internal server error." (the original
 *     message is redacted to "" and never sent); for 4xx, the redacted
 *     err.message (or a fallback per status).
 *   - Every string sent is run through redactString() so passwords, JWTs,
 *     webhook URLs, IPs, etc. never leak via error text.
 *   - Never throws: falls back to 500 { error: 'Internal server error.' }.
 */

const { redactString } = require('./redact.cjs');

const GENERIC_500 = 'Internal server error.';

function statusOf(err) {
  const s = Number(err && err.status);
  if (Number.isFinite(s) && s >= 400 && s < 600) return Math.trunc(s);
  return 500;
}

function codeOf(err) {
  const c = err && err.code;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

function messageFor(status, err) {
  if (status >= 500) return GENERIC_500;
  const raw = err && err.message != null ? String(err.message) : '';
  const text = raw.trim() !== '' ? raw : (status === 404 ? 'Not found.' : 'Request failed.');
  try {
    return redactString(text).text;
  } catch (_) {
    return text;
  }
}

function toErrorBody(err) {
  const status = statusOf(err);
  const code = codeOf(err);
  const body = { error: messageFor(status, err) };
  if (code) body.code = code;
  return { status, body };
}

function sendError(res, err) {
  try {
    const { status, body } = toErrorBody(err);
    return res.status(status).json(body);
  } catch (_) {
    try { return res.status(500).json({ error: GENERIC_500 }); } catch (_) { /* noop */ }
    return undefined;
  }
}

module.exports = { sendError, toErrorBody, statusOf, codeOf };
