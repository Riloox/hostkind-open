'use strict';

/*
 * Provider-neutral BYOC control-plane target management.
 *
 * Contract (.gauntlet/edge-product-contract.md #3):
 *   - PROVIDERS and STATUSES are fixed allowlists.
 *   - validateTarget returns { ok, errors } and never throws.
 *   - normalizeTarget produces a plain, predictable target object.
 *   - transition returns a NEW target and rejects unknown statuses.
 *
 * secretRef is an opaque environment/config reference only (e.g.
 * HOSTKIND_BYOC_PRIMARY). Plaintext credentials never enter target
 * objects or event payloads; provider adapters stay outside this contract.
 */

const PROVIDERS = ['generic-vps', 'hetzner'];
const STATUSES = ['pending', 'ready', 'offline', 'disabled'];
const DEFAULT_STATUS = 'pending';

// Opaque env/config references only: uppercase identifiers like
// HOSTKIND_BYOC_PRIMARY. Anything that looks like a secret value
// (lowercase, dashes, spaces, "=...") is rejected.
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const REQUIRED_FIELDS = ['name', 'provider', 'endpoint', 'region', 'resourceTier', 'secretRef'];

function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['target must be an object'] };
  }
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${field} is required`);
    }
  }
  if (!PROVIDERS.includes(input.provider)) {
    errors.push(`provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (typeof input.secretRef === 'string' && !SECRET_REF_PATTERN.test(input.secretRef)) {
    errors.push('secretRef must be an opaque environment/config reference (e.g. HOSTKIND_BYOC_PRIMARY)');
  }
  if (typeof input.endpoint === 'string') {
    let parsed = null;
    try {
      parsed = new URL(input.endpoint);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push('endpoint must be an http(s) URL');
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeTarget(input, { id, now } = {}) {
  if (id === undefined) {
    throw new Error('normalizeTarget requires an id');
  }
  if (now === undefined) {
    throw new Error('normalizeTarget requires now');
  }
  const validation = validateTarget(input);
  if (!validation.ok) {
    throw new Error(`invalid byoc target: ${validation.errors.join('; ')}`);
  }
  return {
    id,
    name: input.name,
    provider: input.provider,
    endpoint: input.endpoint,
    region: input.region,
    resourceTier: input.resourceTier,
    secretRef: input.secretRef,
    status: DEFAULT_STATUS,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
  };
}

function transition(target, status, now) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('invalid target');
  }
  if (!STATUSES.includes(status)) {
    throw new Error(`invalid target status: ${status}`);
  }
  const next = { ...target };
  next.status = status;
  if (now !== undefined) {
    next.updatedAt = now;
  }
  return next;
}

module.exports = { PROVIDERS, STATUSES, validateTarget, normalizeTarget, transition };