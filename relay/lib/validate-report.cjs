'use strict';

/*
 * Strict report validation for the standalone relay.
 *
 * Pure module: no I/O, no network, no secrets. Validation errors are
 * field-name + reason only — the submitted value is NEVER echoed, so a
 * validation failure can never leak a pasted secret back to the caller or
 * into a log.
 *
 * Contract (relay/README.md):
 *   POST /v1/reports accepts exactly one JSON object with the allowlisted
 *   fields below. title and description are required; everything else is
 *   optional and normalized (trimmed; empty -> null). Unknown fields are
 *   rejected outright so a client can never smuggle extra keys through.
 *
 *   clientKey is the bounded client idempotency key (optional). When
 *   present it becomes the idempotency marker for the queue; otherwise the
 *   server generates a UUID marker. It is restricted to safe characters so
 *   it can be embedded in a GitHub search query and issue comment safely.
 */

const LIMITS = {
  titleMax: 200,
  descriptionMax: 20_000,
  stepsMax: 5_000,
  optionalMax: 500,     // game / view / route / version
  userAgentMax: 1_000,
  clientKeyMin: 8,
  clientKeyMax: 100,
};

// Ceiling for a whole request body (matches the express.json '32kb' limit
// used by relay/server.cjs; kept here so the contract is testable).
const MAX_BODY_BYTES = 32 * 1024;

const ALLOWED_FIELDS = new Set([
  'title',
  'description',
  'reproSteps',
  'expected',
  'game',
  'view',
  'route',
  'userAgent',
  'version',
  'clientKey',
]);

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._-]{8,100}$/;

// NUL and DEL are never legitimate in report text.
const CONTROL_PATTERN = /[\u0000\u007F]/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControlChars(value) {
  return CONTROL_PATTERN.test(value);
}

function fail(errors, field, reason) {
  errors.push(`${field}: ${reason}`);
}

/*
 * Required string: must be a non-empty string, trimmed, within max, and free
 * of control characters. Returns the trimmed value or null (with an error).
 */
function validateRequiredString(value, field, max, errors) {
  if (typeof value !== 'string') {
    fail(errors, field, 'must be a non-empty string');
    return null;
  }
  if (hasControlChars(value)) {
    fail(errors, field, 'contains control characters');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    fail(errors, field, 'must be a non-empty string');
    return null;
  }
  if (trimmed.length > max) {
    fail(errors, field, `exceeds ${max} characters`);
    return null;
  }
  return trimmed;
}

/*
 * Optional string: null / undefined / '' / whitespace normalize to null;
 * anything else must be a string within max. Returns trimmed or null.
 */
function validateOptionalString(value, field, max, errors) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    fail(errors, field, 'must be a string');
    return null;
  }
  if (hasControlChars(value)) {
    fail(errors, field, 'contains control characters');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    fail(errors, field, `exceeds ${max} characters`);
    return null;
  }
  return trimmed;
}

/*
 * Validate a parsed JSON payload.
 * Returns { ok: true, report } or { ok: false, errors: [...] }.
 * The normalized report has only allowlisted, trimmed fields and is safe to
 * redact and persist. Error strings never contain submitted values.
 */
function validateReport(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['payload: must be a JSON object'] };
  }

  const errors = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      fail(errors, key, 'unknown field');
    }
  }

  const report = {};
  report.title = validateRequiredString(input.title, 'title', LIMITS.titleMax, errors);
  report.description = validateRequiredString(input.description, 'description', LIMITS.descriptionMax, errors);
  report.reproSteps = validateOptionalString(input.reproSteps, 'reproSteps', LIMITS.stepsMax, errors);
  report.expected = validateOptionalString(input.expected, 'expected', LIMITS.stepsMax, errors);
  report.game = validateOptionalString(input.game, 'game', LIMITS.optionalMax, errors);
  report.view = validateOptionalString(input.view, 'view', LIMITS.optionalMax, errors);
  report.route = validateOptionalString(input.route, 'route', LIMITS.optionalMax, errors);
  report.userAgent = validateOptionalString(input.userAgent, 'userAgent', LIMITS.userAgentMax, errors);
  report.version = validateOptionalString(input.version, 'version', LIMITS.optionalMax, errors);

  if (input.clientKey != null) {
    if (typeof input.clientKey !== 'string') {
      fail(errors, 'clientKey', 'must be a string');
    } else {
      const trimmed = input.clientKey.trim();
      if (trimmed === '') {
        fail(errors, 'clientKey', 'must be a non-empty string');
      } else if (trimmed.length < LIMITS.clientKeyMin || trimmed.length > LIMITS.clientKeyMax) {
        fail(errors, 'clientKey', `must be ${LIMITS.clientKeyMin}-${LIMITS.clientKeyMax} characters`);
      } else if (!CLIENT_KEY_PATTERN.test(trimmed)) {
        fail(errors, 'clientKey', 'may only contain letters, digits, dot, dash and underscore');
      } else {
        report.clientKey = trimmed;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, report };
}

/*
 * Accept only JSON media types (application/json or any +json subtype).
 */
function acceptsJson(contentType) {
  if (contentType == null) return false;
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  return ct === 'application/json' || ct.endsWith('+json');
}

/*
 * Parse + validate a raw request body (used by the HTTP layer and by tests
 * to pin the wire contract). Returns { ok, report?, errors?, status, code? }:
 *   415 unsupported_content_type — non-JSON content type
 *   413 payload_too_large      — over MAX_BODY_BYTES
 *   400 invalid_json           — body is not valid JSON
 *   400 validation_failed      — schema violations (errors array)
 */
function parseAndValidate(bodyText, contentType) {
  if (!acceptsJson(contentType)) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_content_type',
      errors: ['content-type: must be application/json'],
    };
  }
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    return { ok: false, status: 400, code: 'invalid_json', errors: ['payload: expected a JSON body'] };
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      errors: [`payload: exceeds ${MAX_BODY_BYTES} bytes`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, code: 'invalid_json', errors: ['payload: invalid JSON'] };
  }
  const result = validateReport(parsed);
  if (!result.ok) {
    return { ok: false, status: 400, code: 'validation_failed', errors: result.errors };
  }
  return { ok: true, report: result.report };
}

module.exports = {
  validateReport,
  parseAndValidate,
  acceptsJson,
  LIMITS,
  MAX_BODY_BYTES,
  ALLOWED_FIELDS,
};
