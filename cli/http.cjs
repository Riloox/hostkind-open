'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_TIMEOUT_MS = 30_000;

class CliHttpError extends Error {
  constructor(message, { status, code, details, response } = {}) {
    super(message);
    this.name = 'CliHttpError';
    this.status = status;
    this.code = code || (status ? `http_${status}` : 'http_error');
    this.details = details;
    this.response = response;
  }
}

function joinUrl(base, target) {
  if (/^https?:\/\//i.test(target)) return target;
  return `${String(base).replace(/\/+$/, '')}/${String(target).replace(/^\/+/, '')}`;
}

function parseDispositionFilename(header) {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].trim()); } catch (_) { /* fall through */ }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted) return quoted[1];
  const plain = /filename=([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

function serializableQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text;
}

async function toBlob(filePath) {
  const absolute = path.resolve(filePath);
  const stat = await fsp.stat(absolute);
  if (!stat.isFile()) throw Object.assign(new Error(`Not a file: ${filePath}`), { code: 'not_a_file' });
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(absolute);
  return new Blob([await fsp.readFile(absolute)]);
}

function createClient({
  baseUrl,
  token = null,
  authType = null,
  server = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  verbose = false,
  userAgent = 'hostkind-cli',
} = {}) {
  if (!baseUrl) throw new Error('createClient requires a base URL');
  let resolvedServer = null;
  let serverResolved = false;
  let serverLookup = null;

  function authHeaders() {
    const out = { ...headers };
    if (token) out.Authorization = `Bearer ${token}`;
    out['User-Agent'] = userAgent;
    out.Accept = 'application/json';
    return out;
  }

  function applyServerQuery(url, id) {
    if (id && !url.searchParams.has('serverId')) url.searchParams.set('serverId', id);
  }

  function withTimeout(signal, durationMs = timeoutMs) {
    const controller = new AbortController();
    let timer = null;
    const onAbort = () => controller.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (durationMs > 0) {
      timer = setTimeout(() => controller.abort(Object.assign(new Error('Request timed out'), { code: 'timeout' })), durationMs);
    }
    return {
      signal: controller.signal,
      timedOut: () => !!timer && controller.signal.aborted,
      done() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      },
    };
  }

  async function resolveServerId() {
    if (serverResolved) return resolvedServer;
    if (!server) { serverResolved = true; return null; }
    if (server === 'active') { serverResolved = true; return null; }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(server)) {
      resolvedServer = server;
      serverResolved = true;
      return resolvedServer;
    }
    if (!serverLookup) {
      serverLookup = (async () => {
        let data;
        try {
          data = await request('GET', '/api/servers', { noServer: true });
        } catch (err) {
          // A name lookup is a convenience. If the panel refuses the fleet list,
          // let the real request answer with the authorization error instead of
          // hiding it behind a lookup failure.
          resolvedServer = server;
          return resolvedServer;
        }
        const servers = Array.isArray(data && data.servers) ? data.servers : [];
        const matches = servers.filter((item) => {
          if (!item) return false;
          return item.id === server
            || String(item.name || '').toLowerCase() === String(server).toLowerCase();
        });
        if (matches.length === 1) {
          resolvedServer = matches[0].id;
          return resolvedServer;
        }
        if (matches.length > 1) {
          throw Object.assign(new Error(`Server name "${server}" is ambiguous. Use a server id.`), {
            code: 'ambiguous_server',
            hint: matches.map((item) => item.id).join(', '),
          });
        }
        throw Object.assign(new Error(`No server named "${server}" is registered.`), { code: 'server_not_found' });
      })().finally(() => { serverResolved = true; serverLookup = null; });
    }
    return serverLookup;
  }

  // Shared by request, requestNdjson, and download: build the URL and headers,
  // attach the server scope, and send. Returns the fetch Response or throws a
  // CliHttpError that says what went wrong in plain words.
  async function send(method, target, options, label) {
    const {
      query, json, form, body, headers: extraHeaders, signal, noServer = false,
    } = options;
    const url = new URL(joinUrl(baseUrl, target));
    if (query && Object.keys(query).length) {
      const text = serializableQuery(query);
      if (text) url.search = text;
    }
    const requestHeaders = authHeaders();
    Object.assign(requestHeaders, extraHeaders || {});
    let requestBody;
    if (form) {
      requestBody = form;
      delete requestHeaders['Content-Type'];
    } else if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(json);
    } else if (body !== undefined) {
      requestBody = body;
    }
    if (!noServer) {
      const id = await resolveServerId();
      if (id) {
        requestHeaders['X-Hostkind-Server-Id'] = id;
        applyServerQuery(url, id);
      }
    }
    if (method === 'GET' || method === 'HEAD') requestBody = undefined;
    if (verbose) process.stderr.write(`> ${method} ${url.pathname}${url.search}${label ? ` (${label})` : ''}\n`);
    const effectiveTimeout = options.timeout === undefined ? timeoutMs : options.timeout;
    const guard = withTimeout(signal, effectiveTimeout);
    let response;
    try {
      const init = { method, headers: requestHeaders, signal: guard.signal, redirect: 'follow' };
      if (requestBody !== undefined) init.body = requestBody;
      response = await fetch(url, init);
    } catch (err) {
      guard.done();
      throw fetchError(err, guard.timedOut(), effectiveTimeout);
    }
    if (verbose) process.stderr.write(`< ${response.status} ${response.statusText}\n`);
    if (!response.ok) {
      guard.done();
      throw await httpError(response);
    }
    return { response, url, guard };
  }

  function fetchError(err, timedOut, effectiveTimeout) {
    let wrapped;
    if (err && err.name === 'AbortError') {
      wrapped = timedOut
        ? new CliHttpError(`The panel did not answer within ${Math.round(effectiveTimeout / 1000)}s. Raise --timeout or pass --timeout 0.`, { code: 'timeout' })
        : new CliHttpError('Request aborted.', { code: 'aborted' });
    } else {
      const cause = err && err.cause;
      const reason = cause && cause.code === 'ECONNREFUSED' ? 'connection refused'
        : cause && cause.code === 'ENOTFOUND' ? 'host not found'
          : cause && cause.code === 'ECONNRESET' ? 'connection reset'
            : (cause && (cause.code || cause.message)) || (err && err.message) || 'network error';
      wrapped = new CliHttpError(`Could not reach the panel at ${baseUrl} (${reason}).`, { code: 'fetch_failed' });
    }
    wrapped.cause = err;
    return wrapped;
  }

  async function httpError(response) {
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON proxy error */ }
    const message = (payload && (payload.error || payload.message))
      || text.trim().slice(0, 300)
      || response.statusText
      || `HTTP ${response.status}`;
    return new CliHttpError(String(message), {
      status: response.status,
      code: payload && payload.code,
      details: payload || undefined,
    });
  }

  async function request(method, target, options = {}) {
    const { response, url, guard } = await send(method, target, options);
    try {
      if (options.raw) return { response, url };
      if (response.status === 204) return null;
      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      if (!contentType.includes('application/json')) return text;
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) {
        throw new CliHttpError('The panel returned invalid JSON.', { status: response.status, code: 'invalid_json' });
      }
    } finally {
      guard.done();
    }
  }

  async function requestNdjson(method, target, options = {}) {
    const { onEvent } = options;
    const { response, guard } = await send(method, target, options, 'ndjson');
    const decoder = new TextDecoder();
    let buffer = '';
    let last = null;
    let count = 0;
    const handle = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try { event = JSON.parse(trimmed); } catch (_) { event = { type: 'output', line: trimmed }; }
      last = event;
      count += 1;
      if (typeof onEvent === 'function') onEvent(event);
    };
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer);
    } finally {
      guard.done();
    }
    return { last, count };
  }

  async function download(method, target, options = {}) {
    const { output = null, stdout = process.stdout } = options;
    const { response, guard } = await send(method, target, { ...options, form: undefined, body: undefined }, 'download');
    const headerName = parseDispositionFilename(response.headers.get('content-disposition'));
    // The panel names the file; never let that name escape the destination
    // directory (a header is data, not a trusted path).
    let safeName = headerName
      ? path.basename(String(headerName).replace(/\\/g, '/'))
      : 'hostkind-download';
    if (!safeName || safeName.charCodeAt(0) === 0) safeName = 'hostkind-download';
    let destination = output;
    if (destination === '-') destination = null;
    if (!destination) {
      destination = safeName;
    } else {
      destination = path.resolve(destination);
      try {
        if (fs.statSync(destination).isDirectory()) destination = path.join(destination, safeName);
      } catch (_) {
        if (/[\\/]$/.test(output)) destination = path.join(destination, safeName);
      }
    }
    const streamToStdout = output === '-' || (!output && !process.stdout.isTTY && !headerName);
    try {
      if (streamToStdout) {
        await pipeline(Readable.fromWeb(response.body), stdout, { end: false });
        return { status: response.status, filename: null, bytes: null, stdout: true };
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const local = createByteCounter();
      await pipeline(Readable.fromWeb(response.body), local.counter, fs.createWriteStream(destination));
      return { status: response.status, filename: destination, bytes: local.bytes(), stdout: false };
    } finally {
      guard.done();
    }
  }

  function createByteCounter() {
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    return { counter, bytes: () => bytes };
  }

  async function multipart(files, fields = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) form.append(key, String(item));
      } else {
        form.append(key, String(value));
      }
    }
    for (const file of files) {
      const blob = await toBlob(file.path);
      form.append(file.field || 'file', blob, file.name || path.basename(file.path));
    }
    return form;
  }

  function wsUrl() {
    const url = new URL(joinUrl(baseUrl, '/ws'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  return {
    baseUrl,
    token,
    authType,
    server,
    timeoutMs,
    request,
    requestNdjson,
    download,
    multipart,
    wsUrl,
    resolveServerId,
    joinUrl: (target) => joinUrl(baseUrl, target),
  };
}

module.exports = {
  CliHttpError,
  createClient,
  joinUrl,
  parseDispositionFilename,
  serializableQuery,
  DEFAULT_TIMEOUT_MS,
};
