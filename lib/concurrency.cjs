'use strict';

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

function boundedConcurrency(value, length) {
  const requested = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : DEFAULT_CONCURRENCY;
  return Math.min(Math.max(1, requested), MAX_CONCURRENCY, Math.max(1, length));
}

/**
 * Run a batch without opening one connection per selected item. Results stay in
 * input order and each failure is retained, so callers can report partial
 * success without throwing away completed downloads.
 */
async function mapConcurrentSettled(items, worker, { concurrency = DEFAULT_CONCURRENCY, onProgress } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  if (!items.length) return [];

  const results = Array.from({ length: items.length });
  const limit = boundedConcurrency(concurrency, items.length);
  let cursor = 0;
  let completed = 0;
  let active = 0;

  async function consume() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      active += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      } finally {
        active -= 1;
        completed += 1;
        if (typeof onProgress === 'function') onProgress({ completed, total: items.length, active });
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => consume()));
  return results;
}

module.exports = { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, boundedConcurrency, mapConcurrentSettled };
