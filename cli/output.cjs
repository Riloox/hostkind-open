'use strict';

/* Output formatting shared by every command. */

const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  CONFIRM: 4,
  TIMEOUT: 5,
});

const TABLE_ARRAY_KEYS = [
  'servers', 'backups', 'files', 'entries', 'templates', 'tasks', 'notifications',
  'operations', 'keys', 'users', 'worlds', 'players', 'items', 'events', 'history',
  'groups', 'accounts', 'bans', 'mods', 'targets', 'scorecards', 'points', 'changes',
  'addons', 'crashes', 'findings', 'links', 'rows', 'reports',
];

const TABLE_COLUMNS = [
  'id', 'name', 'status', 'state', 'type', 'version', 'username', 'role', 'action',
  'phase', 'progress', 'serverId', 'serverName', 'size', 'sizeBytes', 'createdAt',
  'updatedAt', 'dir', 'path', 'title', 'kind', 'enabled', 'outcome', 'occurredAt',
];

// Error codes that mean "the command line was wrong", not "the request failed".
const USAGE_CODES = new Set([
  'missing_argument', 'too_many_arguments', 'invalid_data', 'invalid_query', 'invalid_kv',
  'invalid_header', 'unknown_command', 'missing_file', 'too_many_files', 'invalid_timeout',
  'invalid_shell', 'missing_content', 'no_preview', 'profile_not_found', 'unknown_option',
]);

function exitCodeFor(err) {
  const status = Number(err && err.status);
  const code = err && err.code;
  if (code === 'confirmation_required' || code === 'cancelled') return EXIT.CONFIRM;
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (code === 'timeout' || code === 'wait_timeout') return EXIT.TIMEOUT;
  if (USAGE_CODES.has(code)) return EXIT.USAGE;
  return EXIT.ERROR;
}

function isTty(stream = process.stdout) {
  return !!stream && stream.isTTY === true;
}

// Human output is for a person at a terminal. Pipes, --json, and --quiet keep
// the machine contract (JSON on stdout) unchanged.
function isHuman(flags = {}, stream = process.stdout) {
  if (flags.json || flags.raw || flags.quiet || flags.format === 'json') return false;
  return isTty(stream);
}

function colorsEnabled(flags = {}, stream = process.stdout) {
  if (flags['no-color'] || process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return isTty(stream);
}

function paint(flags, code, text) {
  if (!colorsEnabled(flags)) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function red(flags, text) { return paint(flags, '31', text); }
function green(flags, text) { return paint(flags, '32', text); }
function yellow(flags, text) { return paint(flags, '33', text); }
function dim(flags, text) { return paint(flags, '2', text); }
function bold(flags, text) { return paint(flags, '1', text); }

function stringify(value, flags = {}) {
  if (value === undefined) return '';
  if (flags.raw) return typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(value, null, flags.compact ? 0 : 2);
}

function write(stream, text) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

function printJson(value, flags = {}, stream = process.stdout) {
  write(stream, stringify(value, flags));
}

function scalar(value) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const BYTE_COLUMNS = new Set(['size', 'sizeBytes', 'bytes', 'totalBytes']);
const TIME_COLUMNS = new Set(['createdAt', 'updatedAt', 'occurredAt', 'startedAt', 'finishedAt', 'ts', 'lastSeen', 'expiresAt']);

function formatTime(value) {
  const n = typeof value === 'number' ? value : (/^\d{12,}$/.test(String(value)) ? Number(value) : Date.parse(String(value)));
  if (!Number.isFinite(n) || n <= 0) return scalar(value);
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function cell(row, key) {
  const value = row && typeof row === 'object' ? row[key] : undefined;
  if (value === undefined || value === null || value === '') return '';
  if (BYTE_COLUMNS.has(key) && Number.isFinite(Number(value))) return formatBytes(value);
  if (TIME_COLUMNS.has(key)) return formatTime(value);
  return scalar(value);
}

function truncate(text, width) {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function pickRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const key of TABLE_ARRAY_KEYS) {
    if (Array.isArray(data[key])) return data[key];
  }
  const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
  return arrays.length === 1 ? arrays[0][1] : null;
}

// Auto-table only for plain lists: an array, or an object whose only nested
// value is the list. Anything richer stays JSON so nothing is hidden.
function listShaped(data) {
  if (Array.isArray(data)) return data.length > 0 && data.every((row) => row && typeof row === 'object' && !Array.isArray(row));
  const rows = pickRows(data);
  if (!rows || !rows.length || !rows.every((row) => row && typeof row === 'object')) return false;
  return Object.values(data).every((value) => value === rows || value === null || typeof value !== 'object');
}

function renderTable(data, flags = {}, stream = process.stdout) {
  const rows = pickRows(data);
  if (!rows) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const entries = Object.entries(data).filter(([, value]) => value === null || typeof value !== 'object');
      if (entries.length) {
        const width = Math.max(...entries.map(([key]) => key.length));
        for (const [key, value] of entries) {
          write(stream, `${key.padEnd(width)}  ${scalar(value)}`);
        }
        return;
      }
    }
    printJson(data, flags, stream);
    return;
  }
  if (!rows.length) {
    write(stream, dim(flags, '(none)'));
    return;
  }
  if (rows.every((row) => row === null || typeof row !== 'object')) {
    for (const row of rows) write(stream, scalar(row));
    return;
  }
  const keys = new Set();
  for (const row of rows.slice(0, 50)) {
    if (row && typeof row === 'object') for (const key of Object.keys(row)) keys.add(key);
  }
  // Prefer the well-known columns, then scalar extras; nested objects make
  // unreadable cells, so they only appear when nothing else is available.
  const scalarKeys = [...keys].filter((key) => rows.some((row) => row && row[key] != null && typeof row[key] !== 'object'));
  const ordered = [
    ...TABLE_COLUMNS.filter((key) => scalarKeys.includes(key)),
    ...scalarKeys.filter((key) => !TABLE_COLUMNS.includes(key)).sort(),
  ].slice(0, 7);
  if (!ordered.length) ordered.push(...[...keys].slice(0, 4));
  const cells = rows.map((row) => ordered.map((key) => cell(row, key)));
  const widths = ordered.map((key, index) => Math.min(42, cells.reduce(
    (max, row) => Math.max(max, row[index].length),
    key.length,
  )));
  // Ids are what people copy into the next command, so they never shrink.
  const fixed = ordered.map((key) => key === 'id' || key.endsWith('Id'));
  ordered.forEach((key, index) => {
    if (fixed[index]) widths[index] = cells.reduce((max, row) => Math.max(max, row[index].length), key.length);
  });
  fitWidths(widths, fixed, stream);
  const line = (texts, style = (text) => text) => texts
    .map((text, index) => {
      const clipped = truncate(text, widths[index]);
      return style(index === texts.length - 1 ? clipped : clipped.padEnd(widths[index]));
    })
    .join('  ');
  write(stream, line(ordered, (text) => bold(flags, text)));
  for (const row of cells) write(stream, line(row));
}

// Shrink the widest flexible column until the table fits the terminal.
function fitWidths(widths, fixed, stream) {
  const columns = stream && stream.isTTY && Number(stream.columns);
  if (!columns) return;
  const total = () => widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2;
  while (total() > columns) {
    let widest = -1;
    widths.forEach((width, index) => {
      if (!fixed[index] && (widest < 0 || width > widths[widest])) widest = index;
    });
    if (widest < 0 || widths[widest] <= 8) break;
    widths[widest] -= 1;
  }
}

function printResult(response, flags = {}, stream = process.stdout) {
  const human = isHuman(flags, stream);
  if (response === undefined || response === null || response === '') {
    write(stream, human ? green(flags, 'ok') : stringify({ ok: true }, flags));
    return;
  }
  if (flags.quiet) {
    const rows = pickRows(response);
    if (rows) {
      for (const row of rows) {
        if (row && typeof row === 'object') write(stream, String(row.id || row.name || row.key || ''));
        else write(stream, String(row));
      }
      return;
    }
    const id = response.operationId || response.id || response.serverId
      || (response.server && response.server.id)
      || (response.activeServerId);
    if (id) { write(stream, String(id)); return; }
  }
  if (typeof response === 'string' && !flags.json) {
    write(stream, response);
    return;
  }
  if (flags.format === 'table' || flags.table || (human && !flags.format && listShaped(response))) {
    renderTable(response, flags, stream);
    return;
  }
  printJson(response, flags, stream);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
  return `${n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

function formatNdjsonEvent(event, flags = {}) {
  if (flags.json) return JSON.stringify(event);
  if (!event || typeof event !== 'object') return String(event);
  if (event.type === 'progress') {
    const received = Number(event.received) || 0;
    const total = Number(event.total) || 0;
    const pct = total ? ` ${Math.floor((received / total) * 100)}%` : '';
    return `progress:${pct} ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`;
  }
  if (event.type === 'phase') return `phase: ${event.phase || ''}`;
  if (event.type === 'download-start') return `download: ${event.filename || ''}${event.total ? ` (${formatBytes(event.total)})` : ''}`;
  if (event.type === 'output') return String(event.line || '').replace(/\s+$/, '');
  if (event.type === 'done') {
    const server = event.server || {};
    return `done: ${server.name || 'server'}${server.id ? ` (${server.id})` : ''}`;
  }
  if (event.type === 'error') return `error: ${event.error || 'unknown error'}`;
  return JSON.stringify(event);
}

// `state` must outlive one event: it carries the progress throttle and whether
// an in-place progress line is still open on a terminal.
function printNdjsonEvent(event, flags = {}, stream = process.stderr, state = {}) {
  const live = !flags.json && isTty(stream);
  if (event && event.type === 'progress' && !flags.json) {
    const now = Date.now();
    if (state.lastProgressAt && now - state.lastProgressAt < 250) return;
    state.lastProgressAt = now;
    if (live) {
      stream.write(`\r\u001b[2K${formatNdjsonEvent(event, flags)}`);
      state.open = true;
      return;
    }
  }
  if (state.open) { stream.write('\n'); state.open = false; }
  write(stream, formatNdjsonEvent(event, flags));
}

function errorPayload(err) {
  const payload = {
    ok: false,
    error: err && err.message ? err.message : String(err),
    code: (err && err.code) || 'error',
    status: err && Number.isInteger(err.status) ? err.status : undefined,
  };
  if (err && err.hint) payload.hint = err.hint;
  if (err && err.details) payload.details = err.details;
  return payload;
}

function printError(err, flags = {}, stream = process.stderr) {
  const payload = errorPayload(err);
  if (flags.json) {
    write(stream, JSON.stringify(payload));
    return;
  }
  if (payload.code === 'cancelled') {
    write(stream, payload.error);
    return;
  }
  write(stream, red(flags, `error: ${payload.error}`));
  const hints = [];
  if (payload.status === 401) hints.push('Run `hostkind login` or pass --token/--api-key.');
  if (payload.status === 403) hints.push('This account or API key may not have the required capability.');
  if (payload.status === 429) hints.push('The panel is rate limiting; wait and retry.');
  if (payload.code === 'fetch_failed') hints.push('Is the panel running? Start it with `hostkind serve`, or check `hostkind doctor`.');
  if (payload.code === 'missing_server') hints.push('Pass --server <id|name> or select a server in the panel.');
  if (payload.code === 'server_not_found') hints.push('Run `hostkind servers list` to see registered servers.');
  if (err && err.hint) hints.push(err.hint);
  for (const hint of hints) write(stream, dim(flags, `hint: ${hint}`));
}

module.exports = {
  EXIT,
  exitCodeFor,
  isHuman,
  colorsEnabled,
  red,
  green,
  yellow,
  dim,
  bold,
  isTty,
  stringify,
  printJson,
  printResult,
  renderTable,
  pickRows,
  formatBytes,
  formatNdjsonEvent,
  printNdjsonEvent,
  errorPayload,
  printError,
};
