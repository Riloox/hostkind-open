'use strict';

/*
 * Fixed-window rate limiter for the relay HTTP service.
 *
 * Deliberately dependency-free and synchronous: the relay must fail closed
 * under load and the limiter itself must never be an async race source.
 * The counter store is injectable (any Map-like object) so tests and the
 * server can share/reset windows deterministically; the default is an
 * in-process Map.
 *
 * Window semantics: `max` events per `windowMs` per key. The window is
 * fixed (not sliding) — simple, bounded memory, and adequate for abuse
 * control on an anonymous public endpoint. Expired entries are pruned
 * opportunistically once the store exceeds `maxKeys`.
 */

function createRateLimiter(opts = {}) {
  const max = opts.max !== undefined ? opts.max : 60;
  const windowMs = opts.windowMs !== undefined ? opts.windowMs : 60_000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const store = opts.store && typeof opts.store.get === 'function' ? opts.store : new Map();
  const maxKeys = opts.maxKeys !== undefined ? opts.maxKeys : 10_000;

  function prune(at) {
    if (store.size <= maxKeys) return;
    let removed = 0;
    for (const [key, entry] of store) {
      if (entry.resetAt <= at) {
        store.delete(key);
        removed += 1;
        if (removed >= 1024) break;
      }
    }
  }

  /*
   * Returns { allowed: boolean, retryAfterMs: number|null }.
   * `at` may be passed explicitly for deterministic tests; the key must be a
   * bounded string (unbounded/absent keys fail closed).
   */
  function check(key, at) {
    const nowMs = at !== undefined ? at : now();
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      return { allowed: false, retryAfterMs: windowMs };
    }
    prune(nowMs);
    const entry = store.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      store.set(key, { count: 1, resetAt: nowMs + windowMs });
      return { allowed: true, retryAfterMs: null };
    }
    if (entry.count < max) {
      entry.count += 1;
      return { allowed: true, retryAfterMs: null };
    }
    return { allowed: false, retryAfterMs: entry.resetAt - nowMs };
  }

  function reset(key) {
    store.delete(key);
  }

  function resetAll() {
    store.clear();
  }

  return { check, reset, resetAll };
}

module.exports = { createRateLimiter };
