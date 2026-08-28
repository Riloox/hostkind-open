'use strict';

/*
 * HTTPS downloader with the spec's safety contract.
 *
 * Spec contract (docs/roadmap/README.md "Archive and download contract"):
 *   - "Downloads use allowlisted HTTPS origins, timeouts, size ceilings,
 *      streamed hashes, authoritative compatibility data, and atomic
 *      promotion after verification."
 *   - "Cached upstream data exposes source, retrieval time, staleness, and
 *      error state."
 *
 * The contract is: callers pass a URL (or list of mirrors), a destination
 * directory, and an options object. The downloader:
 *   1. Refuses non-HTTPS, refuses any origin not in the allowlist.
 *   2. Streams the body to <dest>/<id>.part, computing a SHA-256 on the fly.
 *   3. Aborts on size-ceiling overflow, on slow throughput past the
 *      deadline, or on a non-2xx status.
 *   4. Verifies the hash if one was provided.
 *   5. Atomically renames the .part to its final name.
 *
 * The compatibility cache lives in front of the network: for known upstream
 * data (Modrinth, Paper, etc.) the URL is normalized, the cache is checked,
 * and the cached file is reused if fresh.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 4;

class DownloadError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'download_error'; }
}

/*
 * In-memory cache metadata. The persistent cache (a real implementation
 * would put this in data/ or in lib/cache.cjs) is out of scope for the
 * foundation: this module returns the cache entry as a plain object so
 * callers can persist it. The key field is documented in the
 * CompatibilityCache type below.
 *
 * { key, source, url, retrievedAt, etag, contentLength, contentType, error }
 */
function newCacheEntry({ key, source, url }) {
  return { key, source, url, retrievedAt: 0, etag: null, contentLength: null, contentType: null, error: null, path: null };
}

/*
 * Fetch a URL into destPath. Returns { ok, path, sha256, contentLength,
 * contentType, etag, cache }.
 *
 * The body is streamed to <destPath>.part and atomically renamed on success.
 * With `resume: true` the .part is treated as durable state: the download
 * continues from its byte offset (Range: bytes=<done>-), a 206 is appended,
 * and a server that answers 200 anyway (it ignored the Range) restarts from
 * zero by truncating. A failure - or a process death mid-stream - leaves the
 * .part in place so a later call with `resume: true` picks up where it
 * stopped. `onProgress(received, total)` fires per chunk; `received` is
 * cumulative from byte 0 even across a resume.
 */
async function fetchToFile(url, destPath, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    expectedSha256 = null,
    allowlist = null,           // function(host) => bool; null = allow any
    allowInsecure = false,      // tests / explicit override
    extraHeaders = {},
    resume = false,
    onProgress = null,
    fetchImpl = globalThis.fetch,
  } = opts;

  if (typeof url !== 'string' || !url) throw new DownloadError('url required', 'no_url');
  if (typeof destPath !== 'string' || !destPath) throw new DownloadError('destPath required', 'no_dest_path');

  const partPath = destPath + '.part';
  let done = 0;
  if (resume && fs.existsSync(partPath)) {
    done = fs.statSync(partPath).size;
  }
  // The hash must still cover the whole file after a resume, so the bytes
  // already on disk are seeded into the hasher up front. A restart-from-zero
  // discards the seeded hasher and starts fresh.
  let seededHasher = null;
  if (done > 0) {
    seededHasher = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(partPath)) seededHasher.update(chunk);
  }

  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const parsed = new URL(current);
    if (!allowInsecure && parsed.protocol !== 'https:') {
      throw new DownloadError(`refusing non-https: ${current}`, 'insecure_scheme');
    }
    if (allowlist && !allowlist(parsed.host)) throw new DownloadError(`origin not in allowlist: ${parsed.host}`, 'origin_blocked');
    if (i === maxRedirects) throw new DownloadError('too many redirects', 'too_many_redirects');

    const headers = { 'user-agent': 'Hostkind/1.0', ...extraHeaders };
    if (done > 0) headers['range'] = `bytes=${done}-`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { signal: controller.signal, headers });
    } catch (err) {
      clearTimeout(timer);
      throw new DownloadError(`fetch failed: ${err.message}`, 'fetch_failed');
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError('redirect with no Location', 'bad_redirect');
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status === 416 && done > 0) {
      // The range is unsatisfiable because the .part already holds the whole
      // body - the process died between the final byte and the promoting
      // rename. Content-Range "bytes */<total>" tells us how big the file
      // really is; promote as-is when the part is at least that big.
      const cr = res.headers.get('content-range') || '';
      const m = /bytes\s+\*\s*\/\s*(\d+)/.exec(cr);
      clearTimeout(timer);
      if (m && Number(m[1]) <= done) {
        const sha256 = seededHasher ? seededHasher.digest('hex') : null;
        fs.renameSync(partPath, destPath);
        return {
          ok: true,
          path: destPath,
          sha256,
          contentLength: done,
          resumed: { from: done, to: done },
        };
      }
      throw new DownloadError(`HTTP 416 ${res.statusText}`, 'http_error');
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new DownloadError(`HTTP ${res.status} ${res.statusText}`, 'http_error');
    }

    // Range negotiation. `done` is the byte offset we asked for; a 206 that
    // confirms it lets us append, anything else restarts from zero.
    let start = done;
    let restarted = false;
    if (done > 0 && res.status === 206) {
      const cr = res.headers.get('content-range') || '';
      const m = /^bytes\s+(\d+)-\s*(\d+)?\s*\/\s*(\d+)?/.exec(cr);
      if (!m || Number(m[1]) !== done) {
        fs.truncateSync(partPath, 0);
        start = 0;
        restarted = true;
      }
    } else if (done > 0 && res.status === 200) {
      // The upstream ignored the Range header and sent the whole body.
      fs.truncateSync(partPath, 0);
      start = 0;
      restarted = true;
    }
    if (restarted) done = 0;

    const clenHeader = res.headers.get('content-length');
    const partialLength = clenHeader ? Number(clenHeader) : null;
    if (partialLength != null && partialLength > maxBytes) {
      clearTimeout(timer);
      throw new DownloadError(`content-length ${partialLength} exceeds ${maxBytes}`, 'too_large');
    }
    let total = start + (partialLength || 0);
    const crTotal = /\/\s*(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (res.status === 206 && crTotal) total = Number(crTotal[1]);
    const contentType = res.headers.get('content-type') || null;
    const etag = res.headers.get('etag') || null;

    const hasher = (!restarted && start > 0 && seededHasher) ? seededHasher : crypto.createHash('sha256');

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    let received = start;
    let bytesThisRun = 0;
    try {
      const out = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        received += value.length;
        bytesThisRun += value.length;
        if (received > maxBytes) {
          out.destroy();
          try { fs.unlinkSync(partPath); } catch { /* */ }
          throw new DownloadError(`downloaded ${received} exceeds ${maxBytes}`, 'too_large');
        }
        hasher.update(value);
        if (!out.write(value)) {
          await new Promise((r) => out.once('drain', r));
        }
        if (typeof onProgress === 'function') onProgress(received, total);
      }
      await new Promise((r, j) => out.end((err) => err ? j(err) : r()));
    } finally {
      clearTimeout(timer);
    }
    const sha256 = hasher.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      try { fs.unlinkSync(partPath); } catch { /* */ }
      throw new DownloadError(`hash mismatch: expected ${expectedSha256}, got ${sha256}`, 'hash_mismatch');
    }
    // Atomic promotion.
    fs.renameSync(partPath, destPath);
    return {
      ok: true,
      path: destPath,
      sha256,
      contentLength: total || received,
      contentType,
      etag,
      resumed: { from: start, to: received, restarted },
      bytesThisRun,
    };
  }
  throw new DownloadError('exhausted redirects', 'too_many_redirects');
}

/*
 * Compatibility-cache helper. Wraps fetchToFile with a small in-memory
 * cache record. Callers that want persistence should serialize the
 * returned `cache` field and rehydrate it on the next call.
 */
async function fetchWithCache({ cache, destPath, opts }) {
  if (cache && cache.retrievedAt && cache.path && fs.existsSync(cache.path)) {
    const ageMs = Date.now() - cache.retrievedAt;
    const maxAgeMs = (opts && opts.maxAgeMs) || 60 * 60 * 1000;
    if (ageMs < maxAgeMs && !cache.error) {
      return { ok: true, cached: true, path: cache.path, cache };
    }
  }
  try {
    const result = await fetchToFile(cache.url, destPath, opts);
    if (cache) {
      cache.retrievedAt = Date.now();
      cache.contentLength = result.contentLength;
      cache.contentType = result.contentType;
      cache.etag = result.etag;
      cache.path = result.path;
      cache.error = null;
    }
    return { ...result, cached: false, cache };
  } catch (err) {
    if (cache) {
      cache.error = { code: err.code, message: err.message, at: Date.now() };
    }
    throw err;
  }
}

module.exports = {
  fetchToFile,
  fetchWithCache,
  newCacheEntry,
  DownloadError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
};
