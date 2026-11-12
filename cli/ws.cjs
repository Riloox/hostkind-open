'use strict';

let WsPackage = null;
try { WsPackage = require('ws'); } catch (_) { WsPackage = null; }

function connectSocket(url, timeoutMs) {
  if (WsPackage) {
    const socket = new WsPackage(url, { handshakeTimeout: timeoutMs || 30_000 });
    return {
      impl: 'ws',
      raw: socket,
      send: (text) => socket.send(text),
      close: () => { try { socket.close(); } catch (_) { /* ignore */ } },
      terminate: () => { try { socket.terminate(); } catch (_) { /* ignore */ } },
      isOpen: () => socket.readyState === WsPackage.OPEN,
    };
  }
  if (typeof WebSocket !== 'function') {
    throw Object.assign(new Error('This Node.js runtime has no WebSocket client.'), { code: 'ws_unavailable' });
  }
  const socket = new WebSocket(url);
  return {
    impl: 'global',
    raw: socket,
    send: (text) => socket.send(text),
    close: () => { try { socket.close(); } catch (_) { /* ignore */ } },
    terminate: () => { try { socket.close(); } catch (_) { /* ignore */ } },
    isOpen: () => socket.readyState === 1,
  };
}

const { dim, red, yellow, green } = require('./output.cjs');

function parseSince(value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatLine(line, flags) {
  if (line === undefined || line === null) return '';
  if (typeof line === 'string') return line;
  const text = line.text !== undefined ? line.text : (line.line !== undefined ? line.line : JSON.stringify(line));
  if (flags.json) return JSON.stringify(line);
  return String(text);
}

function openSocket(client, { onOpen, onMessage, onError, onClose }) {
  const socket = connectSocket(client.wsUrl(), client.timeoutMs);
  let opened = false;
  if (socket.impl === 'ws') {
    socket.raw.on('open', () => {
      opened = true;
      if (onOpen) onOpen(socket);
    });
    socket.raw.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch (_) { return; }
      if (onMessage) onMessage(frame, socket);
    });
    socket.raw.on('error', (err) => {
      if (onError) onError(err, socket);
    });
    socket.raw.on('unexpected-response', (request, response) => {
      const err = Object.assign(new Error(`WebSocket rejected with HTTP ${response.statusCode}`), {
        status: response.statusCode,
        code: response.statusCode === 401 ? 'unauthorized' : 'ws_rejected',
      });
      if (onError) onError(err, socket);
      socket.terminate();
    });
    socket.raw.on('close', (code, reason) => {
      if (onClose) onClose({ code, reason: reason ? reason.toString() : '', opened });
    });
  } else {
    socket.raw.addEventListener('open', () => {
      opened = true;
      if (onOpen) onOpen(socket);
    });
    socket.raw.addEventListener('message', (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch (_) { return; }
      if (onMessage) onMessage(frame, socket);
    });
    socket.raw.addEventListener('error', () => {
      if (onError) onError(Object.assign(new Error('WebSocket connection failed'), { code: 'ws_failed' }), socket);
    });
    socket.raw.addEventListener('close', (event) => {
      if (onClose) onClose({ code: event.code, reason: event.reason ? String(event.reason) : '', opened });
    });
  }
  return socket;
}

function lineVisible(line, since) {
  if (since == null) return true;
  const ts = Number(line && line.ts);
  return !Number.isFinite(ts) || ts >= since;
}

async function tail({ client, serverId, flags = {}, stdout = process.stdout, stderr = process.stderr }) {
  const since = parseSince(flags.since);
  const limit = Number(flags.lines || flags.tail || 0);
  const noFollow = flags.follow === false || flags['no-follow'] === true || flags.history === true;
  // Plain substring match: the value is typed by the user, and a regex built from
  // it can be made to backtrack for a very long time on a long console line.
  const until = flags.until ? String(flags.until) : null;
  const printStatus = flags.status === true;
  const timeoutSeconds = Number(flags.timeout || 0);
  const noFollowTimeout = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 10_000;

  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    let socket = null;
    let target = serverId || null;

    let finish = (code = 0, message) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (message) stderr.write(`${message}\n`);
      try { if (socket && socket.isOpen()) socket.close(); } catch (_) { /* ignore */ }
      resolve(code);
    };

    const writeLine = (line) => {
      if (!lineVisible(line, since)) return false;
      const text = formatLine(line, flags);
      if (text !== '') stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      if (until && text.includes(until)) {
        finish(0);
        return true;
      }
      return false;
    };

    socket = openSocket(client, {
      onOpen: (ws) => {
        if (target) ws.send(JSON.stringify({ type: 'selectServer', serverId: target }));
        if (noFollow) {
          timer = setTimeout(() => finish(0), noFollowTimeout);
        } else if (timeoutSeconds > 0) {
          timer = setTimeout(() => finish(0), timeoutSeconds * 1000);
        }
      },
      onMessage: (frame) => {
        if (frame.type === 'meta') {
          if (!target) target = frame.activeServerId || null;
          if (target && frame.servers && !frame.servers.some((item) => item.id === target)) {
            finish(1, red(flags, `Server ${target} is not visible to this principal.`));
          }
          return;
        }
        if (frame.type === 'history') {
          if (target && frame.serverId && frame.serverId !== target) return;
          const lines = Array.isArray(frame.lines) ? frame.lines : [];
          const visible = limit > 0 ? lines.slice(-limit) : lines;
          for (const line of visible) {
            if (writeLine(line)) return;
          }
          if (noFollow) finish(0);
          return;
        }
        if (frame.type === 'line') {
          if (target && frame.serverId && frame.serverId !== target) return;
          if (writeLine(frame.line || frame)) return;
          return;
        }
        if (frame.type === 'status' && printStatus) {
          if (flags.json) stdout.write(`${JSON.stringify(frame)}\n`);
          else stdout.write(`${dim(flags, 'status:')} ${frame.status && (frame.status.status || frame.status)}\n`);
          if (until && JSON.stringify(frame).includes(until)) finish(0);
          return;
        }
        if (frame.type === 'error') {
          const message = frame.error || frame.code || 'WebSocket error';
          if (noFollow) return;
          finish(1, red(flags, `error: ${message}`));
          return;
        }
        if (frame.type === 'notifications' && flags.notifications) {
          if (flags.json) stdout.write(`${JSON.stringify(frame)}\n`);
          else {
            for (const item of frame.notifications || []) stdout.write(`${yellow(flags, 'notification:')} ${item.title || item.message || item.id}\n`);
          }
        }
      },
      onError: (err) => {
        if (err && err.status === 401) finish(3, red(flags, `error: ${err.message}. Run \`hostkind login\`.`));
        else if (!finished) finish(1, red(flags, `error: ${err.message}`));
      },
      onClose: ({ code }) => {
        if (!finished) finish(code === 1000 ? 0 : 1);
      },
    });

    const onSignal = () => finish(0);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const cleanup = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    const originalFinish = finish;
    finish = (code, message) => { cleanup(); originalFinish(code, message); };
    if (socket.impl === 'ws') socket.raw.once('close', cleanup); else socket.raw.addEventListener('close', cleanup, { once: true });
  });
}

async function watch({ client, serverId, flags = {}, stdout = process.stdout, stderr = process.stderr }) {
  const noFollow = flags.follow === false || flags['no-follow'] === true;
  const timeoutSeconds = Number(flags.timeout || 0);
  const only = flags.stats ? 'stats'
    : flags.notifications ? 'notification'
      : flags.status ? 'status'
        : null;
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    let socket = null;
    let finish = (code = 0, message) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (message) stderr.write(`${message}\n`);
      try { if (socket && socket.isOpen()) socket.close(); } catch (_) { /* ignore */ }
      resolve(code);
    };
    const print = (frame) => {
      if (flags.json) {
        stdout.write(`${JSON.stringify(frame)}\n`);
      } else if (frame.type === 'status') {
        const status = frame.status || {};
        stdout.write(`${dim(flags, 'status')} ${status.name ? `${status.name} ` : ''}${status.status || ''}\n`);
      } else if (frame.type === 'stats') {
        const stats = frame.stats || {};
        stdout.write(`${dim(flags, 'stats')} cpu=${stats.cpu == null ? '-' : `${Math.round(stats.cpu)}%`} mem=${stats.memory == null ? '-' : `${Math.round(stats.memory / 1048576)}MB`} players=${stats.players ?? '-'}\n`);
      } else if (frame.type === 'notification') {
        const item = frame.notification || {};
        stdout.write(`${yellow(flags, 'notification')} ${item.title || item.message || item.id || ''}\n`);
      } else if (frame.type === 'server') {
        const server = frame.server || {};
        stdout.write(`${green(flags, 'server')} ${server.name || server.id || ''}\n`);
      } else if (frame.type === 'error') {
        stdout.write(`${red(flags, 'error')} ${frame.error || frame.code || ''}\n`);
      } else {
        stdout.write(`${JSON.stringify(frame)}\n`);
      }
      if (flags.once) finish(0);
    };

    socket = openSocket(client, {
      onOpen: (ws) => {
        if (serverId) ws.send(JSON.stringify({ type: 'selectServer', serverId }));
        if (timeoutSeconds > 0) timer = setTimeout(() => finish(0), timeoutSeconds * 1000);
        else if (noFollow) timer = setTimeout(() => finish(0), 1500);
      },
      onMessage: (frame) => {
        if (frame.type === 'meta') return;
        if (frame.type === 'history') return;
        if (frame.type === 'line') {
          if (flags.lines) print({ type: 'line', line: frame.line });
          return;
        }
        if (frame.type === 'notifications') return;
        if (only && frame.type !== only) return;
        print(frame);
      },
      onError: (err) => finish(err && err.status === 401 ? 3 : 1, red(flags, `error: ${err.message}`)),
      onClose: ({ code }) => { if (!finished) finish(code === 1000 ? 0 : 1); },
    });

    const onSignal = () => finish(0);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const cleanup = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    const originalFinish = finish;
    finish = (code, message) => { cleanup(); originalFinish(code, message); };
    if (socket.impl === 'ws') socket.raw.once('close', cleanup); else socket.raw.addEventListener('close', cleanup, { once: true });
  });
}

module.exports = { tail, watch, parseSince };
