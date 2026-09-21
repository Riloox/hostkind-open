'use strict';

/*
 * Preview store: deduped TTL Map for preview tokens.
 *
 * Replaces the 7x `previews = new Map()` + bespoke sweepPreviews loops in:
 *   palworld-mods, palworld-portability, palworld-settings, palworld-workshop,
 *   terraria-import, terraria-config, terraria-mods (+ PREVIEW_TTL variants).
 *
 * Behavior contract (preserved from the originals):
 *   - Each entry carries `expiresAt` (ms epoch). Expired entries are dropped
 *     lazily on get/take/sweep and eagerly via an optional onExpire hook
 *     (used to unlink staged archives / rm staging dirs).
 *   - `set` with no explicit expiresAt defaults to now + ttlMs.
 *   - `get` returns null for missing/expired (after running onExpire).
 *   - `take` = get + delete (single-use preview tokens).
 *   - `sweep` removes all expired entries, returns the count removed.
 */

class PreviewStore {
  constructor({ ttlMs = 15 * 60_000, onExpire = null, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.onExpire = typeof onExpire === 'function' ? onExpire : null;
    this.now = typeof now === 'function' ? now : Date.now;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  _isExpired(record, now) {
    return !record || typeof record.expiresAt !== 'number' || record.expiresAt <= now;
  }

  _expire(token, record) {
    this.map.delete(token);
    if (this.onExpire) {
      try { this.onExpire(token, record); } catch (_) { /* best effort cleanup */ }
    }
  }

  set(token, record, { ttlMs = this.ttlMs } = {}) {
    const key = String(token);
    const now = this.now();
    const entry = { ...record, token: record && record.token !== undefined ? record.token : key };
    if (typeof entry.expiresAt !== 'number') entry.expiresAt = now + ttlMs;
    this.map.set(key, entry);
    return entry;
  }

  get(token, { now = this.now() } = {}) {
    const key = String(token || '');
    const record = this.map.get(key);
    if (!record) return null;
    if (this._isExpired(record, now)) {
      this._expire(key, record);
      return null;
    }
    return record;
  }

  has(token, { now = this.now() } = {}) {
    return this.get(token, { now }) !== null;
  }

  delete(token) {
    return this.map.delete(String(token || ''));
  }

  take(token, { now = this.now() } = {}) {
    const record = this.get(token, { now });
    if (record) this.map.delete(String(token || ''));
    return record;
  }

  sweep({ now = this.now() } = {}) {
    let removed = 0;
    for (const [token, record] of this.map) {
      if (this._isExpired(record, now)) {
        this._expire(token, record);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.map.clear();
  }

  values({ now = this.now() } = {}) {
    this.sweep({ now });
    return [...this.map.values()];
  }

  entries({ now = this.now() } = {}) {
    this.sweep({ now });
    return [...this.map.entries()];
  }

  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
}

function createPreviewStore(options) {
  return new PreviewStore(options);
}

module.exports = { PreviewStore, createPreviewStore };
