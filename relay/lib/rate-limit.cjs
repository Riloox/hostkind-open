'use strict';

/*
 * In-memory fixed-window rate limiter for the relay.
 *
 * Used for per-IP submission limits and the global daily budget. Buckets are
 * pruned lazily on each hit so memory stays bounded. The limiter is
 * per-process state; it is a coarse abuse control, not a substitute for the
 * edge/Cloudflare rate limiting described in relay/THREAT-MODEL.md.
 *
 * Pure and deterministic: `now` is injectable for tests.
 */

function createRateLimiter(opts = {}) {
  const windowMs = opts.windowMs !== undefined ? opts.windowMs : 60_000;
  const max = opts.max !== undefined ? opts.max : 10;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const buckets = new Map();

  function prune(t) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
    }
  }

  /*
   * Record one hit for a key. Returns
   * { allowed, remaining, resetAt } — allowed=false when the window budget
   * is exhausted.
   */
  function hit(key) {
    const t = now();
    prune(t);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  function reset(key) {
    buckets.delete(key);
  }

  function size() {
    return buckets.size;
  }

  return { hit, reset, size };
}

module.exports = { createRateLimiter };
