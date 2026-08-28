'use strict';

/*
 * One-time secure remote pairing challenges.
 *
 * Contract (.gauntlet/edge-product-contract.md #4):
 *   - Tokens are high-entropy and returned plaintext exactly once, at create().
 *   - Internal storage keeps only SHA-256 hashes of tokens.
 *   - A pairing is bound to one target, expires after ttlMs, is single-use,
 *     and failed attempts are bounded by maxAttempts.
 *   - Every comparison is constant-time (timingSafeEqual).
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const TOKEN_BYTES = 32;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time comparison of two hex-encoded SHA-256 digests.
function safeEqualHex(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createPairingStore(options = {}) {
  const clock = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || ((size) => crypto.randomBytes(size));
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  const maxAttempts = options.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : options.maxAttempts;

  // Internal state: tokenHash only — never the plaintext token.
  const pairings = new Map();

  function create({ targetId, actorId } = {}) {
    if (!targetId) {
      throw new Error('pairing create requires targetId');
    }
    const id = randomBytes(12).toString('hex');
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const createdAt = clock();
    pairings.set(id, {
      id,
      targetId,
      actorId,
      tokenHash: hashToken(token),
      expiresAt: createdAt + ttlMs,
      attempts: 0,
    });
    return { id, targetId, token, expiresAt: createdAt + ttlMs };
  }

  function consume({ id, token, now } = {}) {
    const at = now === undefined ? clock() : now;
    const record = pairings.get(id);
    if (!record) {
      return { ok: false, error: 'pairing not found' };
    }
    if (record.attempts >= maxAttempts) {
      return { ok: false, error: 'pairing locked: too many failed attempts' };
    }
    if (at > record.expiresAt) {
      return { ok: false, error: 'pairing expired' };
    }
    if (!safeEqualHex(hashToken(token), record.tokenHash)) {
      record.attempts += 1;
      return { ok: false, error: 'invalid token' };
    }
    // Single use: consumed pairings are removed and can never match again.
    pairings.delete(id);
    return { ok: true, targetId: record.targetId, agentId: record.actorId };
  }

  return { create, consume };
}

module.exports = { createPairingStore, hashToken };