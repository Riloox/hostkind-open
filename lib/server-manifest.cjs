'use strict';

/*
 * Portable server manifests - the versioned export/import contract.
 *
 * Spec contract (`.gauntlet/edge-product-contract.md` slice 1):
 *   - The portable document is deterministic except for the injected
 *     `now` value and contains only portable server-definition data.
 *   - It must never contain `dir`, absolute paths, runtime binaries,
 *     launch secrets, access tokens, password values, or machine-specific
 *     network bindings.
 *   - Content references contain provider/project/version/hash metadata,
 *     not binary payloads.
 *   - Network values use placeholders or nulls.
 *
 * This module only *describes* servers in a portable form; it never reads,
 * writes, or executes anything on disk.
 */

const SCHEMA_VERSION = 1;
const KIND = 'hostkind.server-manifest';

// Server fields that survive the portability filter. Everything else on the
// source server object (dir, jar, password, tokens, ...) is dropped before
// it can reach the document.
const PORTABLE_SERVER_FIELDS = Object.freeze([
  'id',
  'name',
  'type',
  'loader',
  'mcVersion',
  'worlds',
  'javaArgs',
]);

// Key names that are never allowed inside the portable document. The
// allowlist filter is the first line of defense; this check is the second,
// so a hand-built or future manifest cannot smuggle secrets or binaries in
// under a new field name.
const SENSITIVE_KEY =
  /(password|passwd|secret|token|private|credential|apikey|api_key|authorization|cookie|session|jar|\.exe$|\.key$|\.pem$|binary|bin$)/i;
const SENSITIVE_VALUE = /(password|passwd|secret|token|credential|apikey|api_key|authorization|cookie|session)\s*[:=]/i;

function containsSensitiveValue(value, seen = new Set()) {
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsSensitiveValue(item, seen));
}

const PORTABLE_CONTENT_FIELDS = Object.freeze(['path', 'kind', 'provider', 'projectId', 'versionId', 'sha256']);
const PORTABLE_SCHEDULE_FIELDS = Object.freeze(['name', 'type', 'cron']);
const PORTABLE_POLICY_FIELDS = Object.freeze(['backupRequired', 'sleepable', 'rollbackOnFailure']);

// Placeholders standing in for machine-specific values. A manifest is
// portable precisely because these are not the operator's real bindings.
const PLACEHOLDER_HOST = '{{SERVER_IP}}';
const PLACEHOLDER_PORT = '{{SERVER_PORT}}';

/*
 * Portable path rule for content references: a relative POSIX-style path.
 * Absolute paths, drive letters, backslashes, and traversal/empty segments
 * are all rejected - the document must never point outside its own tree.
 */
function portablePathProblem(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return 'path must be a non-empty string';
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) {
    return 'path must be a relative POSIX path (no leading slash, drive, or backslash)';
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'path must not contain traversal or empty segments';
  }
  return null;
}

function extractPortableServer(server) {
  const out = {};
  for (const field of PORTABLE_SERVER_FIELDS) {
    if (server[field] === undefined) continue;
    if (field === 'javaArgs') {
      if (Array.isArray(server[field])) {
        const args = server[field].filter((arg) => typeof arg === 'string' && !SENSITIVE_VALUE.test(arg));
        if (args.length) out[field] = args;
      }
      continue;
    }
    const value = server[field];
    if (containsSensitiveValue(value)) {
      throw new Error(`server.${field} contains a sensitive value`);
    }
    out[field] = value;
  }
  if (server.network && typeof server.network === 'object') {
    out.network = { host: PLACEHOLDER_HOST, port: PLACEHOLDER_PORT };
  } else {
    out.network = { host: null, port: null };
  }
  return out;
}

/*
 * Copy one content reference, keeping only portable metadata and refusing
 * binary/secret payload keys. Returns `{ error }` or `{ value }`.
 */
function sanitizeContentRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { error: 'content reference must be an object' };
  }
  const problem = portablePathProblem(ref.path);
  if (problem) return { error: 'content reference ' + problem };
  if (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))) {
    return { error: 'content reference sha256 must be a SHA-256 hex digest' };
  }
  const value = {};
  for (const key of PORTABLE_CONTENT_FIELDS) {
    if (ref[key] === undefined) continue;
    if (SENSITIVE_KEY.test(key)) continue;
    value[key] = ref[key];
  }
  return { value };
}

function sanitizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return {};
  const value = {};
  for (const key of PORTABLE_SCHEDULE_FIELDS) {
    if (schedule[key] !== undefined) value[key] = schedule[key];
  }
  return value;
}

function sanitizePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return {};
  const value = {};
  for (const key of PORTABLE_POLICY_FIELDS) {
    if (policy[key] !== undefined && typeof policy[key] === 'boolean') value[key] = policy[key];
  }
  return value;
}

/*
 * Build a portable manifest. Throws for invalid input that would corrupt
 * the document (a bad content path, a missing server); everything else is
 * an input-data problem, not a document problem.
 */
function createManifest({ server, contentRefs = [], schedules = [], policy = {}, now = Date.now() } = {}) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new TypeError('createManifest: server is required');
  }
  const content = [];
  for (const ref of contentRefs) {
    const { value, error } = sanitizeContentRef(ref);
    if (error) throw new Error(error);
    content.push(value);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    createdAt: now,
    server: extractPortableServer(server),
    content,
    schedules: Array.isArray(schedules) ? schedules.map(sanitizeSchedule) : [],
    policy: sanitizePolicy(policy),
  };
}

/*
 * Validate a manifest without ever throwing for ordinary invalid input.
 * Returns `{ ok, errors, value }`; `value` is the input when valid.
 */
function validateManifest(value) {
  const errors = [];
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, errors: ['manifest must be an object'], value: null };
    }
    if (value.schemaVersion !== SCHEMA_VERSION) {
      errors.push('schemaVersion must be ' + SCHEMA_VERSION);
    }
    if (value.kind !== KIND) {
      errors.push('kind must be ' + KIND);
    }
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
      errors.push('createdAt must be a finite number');
    }

    const server = value.server;
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      errors.push('server must be an object');
    } else {
      if (typeof server.name !== 'string' || server.name.length === 0) {
        errors.push('server.name must be a non-empty string');
      }
      if (typeof server.type !== 'string' || server.type.length === 0) {
        errors.push('server.type must be a non-empty string');
      }
      for (const key of Object.keys(server)) {
        if (key !== 'network' && !PORTABLE_SERVER_FIELDS.includes(key)) errors.push('server field "' + key + '" is not portable');
        if (SENSITIVE_KEY.test(key)) errors.push('server field "' + key + '" is not portable');
      }
      for (const field of PORTABLE_SERVER_FIELDS) {
        if (containsSensitiveValue(server[field])) errors.push('server field "' + field + '" contains a sensitive value');
      }
      const network = server.network;
      if (network !== undefined && network !== null) {
        if (typeof network !== 'object' || Array.isArray(network)) {
          errors.push('server.network must be an object');
        } else {
          for (const key of Object.keys(network)) {
            if (key !== 'host' && key !== 'port') {
              errors.push('server.network field "' + key + '" is not portable');
            }
          }
          if (!(network.host == null || network.host === PLACEHOLDER_HOST)) {
            errors.push('server.network.host must be a placeholder or null');
          }
          if (!(network.port == null || network.port === PLACEHOLDER_PORT)) {
            errors.push('server.network.port must be a placeholder or null');
          }
        }
      }
    }

    if (!Array.isArray(value.content)) {
      errors.push('content must be an array');
    } else {
      value.content.forEach((ref, index) => {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
          errors.push('content[' + index + '] must be an object');
          return;
        }
        const problem = portablePathProblem(ref.path);
        if (problem) errors.push('content[' + index + '] ' + problem);
        if (ref.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(ref.sha256)) {
          errors.push('content[' + index + '].sha256 must be a SHA-256 hex digest');
        }
        for (const key of Object.keys(ref)) {
          if (SENSITIVE_KEY.test(key) || key === 'data' || key === 'payload' || key === 'buffer' || key === 'bytes' || key === 'base64') {
            errors.push('content[' + index + '] field "' + key + '" is not portable');
          }
        }
      });
    }

    if (!Array.isArray(value.schedules)) {
      errors.push('schedules must be an array');
    } else {
      value.schedules.forEach((schedule, index) => {
        if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
          errors.push('schedules[' + index + '] must be an object');
        } else {
          for (const key of Object.keys(schedule)) {
            if (!PORTABLE_SCHEDULE_FIELDS.includes(key)) errors.push('schedules[' + index + '] field "' + key + '" is not portable');
          }
          if (typeof schedule.name !== 'string') errors.push('schedules[' + index + '].name must be a string');
          if (typeof schedule.type !== 'string') errors.push('schedules[' + index + '].type must be a string');
          if (schedule.cron !== undefined && typeof schedule.cron !== 'string') {
            errors.push('schedules[' + index + '].cron must be a string');
          }
        }
      });
    }

    if (value.policy !== undefined && (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy))) {
      errors.push('policy must be an object');
    } else if (value.policy) {
      for (const key of Object.keys(value.policy)) {
        if (!PORTABLE_POLICY_FIELDS.includes(key)) errors.push('policy field "' + key + '" is not portable');
        else if (typeof value.policy[key] !== 'boolean') errors.push('policy.' + key + ' must be boolean');
      }
    }
  } catch (error) {
    return { ok: false, errors: ['manifest validation failed: ' + error.message], value: null };
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

/*
 * Convenience wrapper: manifest for a server with default empty
 * content references, schedules, and policy.
 */
function manifestFromServer(server, options = {}) {
  return createManifest({ server, ...options });
}

module.exports = {
  SCHEMA_VERSION,
  KIND,
  createManifest,
  validateManifest,
  manifestFromServer,
};