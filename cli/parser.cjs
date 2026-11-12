'use strict';

const GLOBAL_VALUE_FLAGS = new Set([
  'url', 'token', 'api-key', 'profile', 'server', 'format', 'output', 'data', 'data-file',
  'query', 'header', 'idempotency-key', 'timeout', 'wait-timeout', 'username', 'email',
  'password', 'password-file', 'preview-token', 'token-file', 'key', 'content',
  'content-file', 'field', 'lines', 'since', 'until', 'interval',
]);

const GLOBAL_BOOLEAN_FLAGS = new Set([
  'help', 'json', 'table', 'quiet', 'verbose', 'yes', 'preview', 'wait', 'no-wait',
  'no-color', 'stdout', 'all', 'follow', 'no-follow', 'stats', 'notifications',
  'once', 'force', 'raw', 'insecure', 'show-token', 'password-stdin', 'compact',
  'stdin', 'ndjson',
]);

const SHORT_FLAGS = {
  h: 'help',
  v: 'verbose',
  V: 'version',
  q: 'quiet',
  y: 'yes',
  o: 'output',
  s: 'server',
  u: 'url',
  t: 'token',
  f: 'file',
  p: 'profile',
};

function buildIndex(commands) {
  const byName = new Map();
  const byKey = new Map();
  const groups = new Map();
  for (const command of commands) {
    const name = command.name || [command.group, command.action].filter(Boolean).join(' ');
    command.name = name;
    byName.set(name, command);
    const key = name.split(/\s+/).filter(Boolean).join(' ');
    byKey.set(key, command);
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
    for (const alias of command.aliases || []) {
      const aliasKey = alias.split(/\s+/).filter(Boolean).join(' ');
      byKey.set(aliasKey, command);
    }
  }
  return { commands, byName, byKey, groups };
}

function maxTokens(index) {
  let longest = 0;
  for (const key of index.byKey.keys()) longest = Math.max(longest, key.split(/\s+/).length);
  return longest;
}

function matchingGroups(index, first) {
  const names = [];
  for (const group of index.groups.keys()) {
    if (group === first || group.split(/\s+/)[0] === first) names.push(group);
  }
  return [...new Set(names)].sort();
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// Closest command names that extend `prefix` by one word, ranked by how close
// that word is to what was typed.
function suggest(index, prefix, typed) {
  const depth = prefix ? prefix.split(' ').length : 0;
  const words = new Set();
  for (const key of index.byKey.keys()) {
    const parts = key.split(' ');
    if (parts.length <= depth) continue;
    if (prefix && parts.slice(0, depth).join(' ') !== prefix) continue;
    words.add(parts[depth]);
  }
  const limit = Math.max(2, Math.floor(typed.length / 3));
  return [...words]
    .map((word) => ({ word, distance: word.startsWith(typed) ? 0 : editDistance(typed, word) }))
    .filter((item) => item.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word))
    .slice(0, 3)
    .map((item) => (prefix ? `${prefix} ${item.word}` : item.word));
}

function unknownCommand(index, prefix, typed) {
  const shown = prefix ? `${prefix} ${typed}` : typed;
  const options = suggest(index, prefix, typed);
  const hint = options.length
    ? `Did you mean ${options.map((name) => `\`hostkind ${name}\``).join(', ')}?`
    : `Run \`hostkind ${prefix ? `help ${prefix}` : '--help'}\` to see what is available.`;
  return { kind: 'error', message: `Unknown command: ${shown}`, hint };
}

function hasChildren(index, key) {
  for (const other of index.byKey.keys()) {
    if (other.startsWith(`${key} `)) return true;
  }
  return false;
}

function takesPositionals(spec) {
  return !!((spec.args && spec.args.length) || spec.bodyArgs || spec.queryArgs
    || spec.bodyArrayArgs || spec.special === 'api');
}

function matchCommand(argv, index) {
  if (!argv.length) return { kind: 'root' };
  const first = argv[0];
  if (first === 'help') {
    return { kind: 'help', rest: argv.slice(1) };
  }
  if (first === '--help' || first === '-h') return { kind: 'help', rest: [] };
  if (first === '--version' || first === '-V') return { kind: 'version' };
  if (first.startsWith('-')) {
    return { kind: 'error', message: `Unknown option before a command: ${first}`, hint: 'Put the command first, then its options: `hostkind servers list --json`.' };
  }

  const longest = maxTokens(index);
  for (let length = Math.min(longest, argv.length); length >= 1; length -= 1) {
    const key = argv.slice(0, length).join(' ');
    const spec = index.byKey.get(key);
    if (!spec) continue;
    // `servers lst` would otherwise run `servers` (an alias for `servers list`)
    // and fail with "too many arguments". When the command takes no
    // positionals and has subcommands, a stray word is a mistyped subcommand.
    const next = argv[length];
    if (next !== undefined && !next.startsWith('-') && !takesPositionals(spec) && hasChildren(index, key)) {
      return unknownCommand(index, key, next);
    }
    return { kind: 'command', spec, name: key, rest: argv.slice(length) };
  }

  const groups = matchingGroups(index, first);
  if (groups.length && argv.length === 1) {
    return { kind: 'group', group: groups[0] };
  }
  if (groups.length) return unknownCommand(index, first, argv[1]);
  return unknownCommand(index, '', first);
}

function isDashValue(value) {
  return value === '-' || /^-\d/.test(value);
}

function parseOptions(tokens, spec = {}) {
  const flags = {};
  const positionals = [];
  const booleanFlags = new Set(GLOBAL_BOOLEAN_FLAGS);
  const valueFlags = new Set(GLOBAL_VALUE_FLAGS);
  for (const [name, meta] of Object.entries(spec.options || {})) {
    if (meta && (meta.type === 'boolean' || meta.boolean)) booleanFlags.add(name);
    else valueFlags.add(name);
  }
  for (const name of spec.booleanFlags || []) booleanFlags.add(name);
  for (const name of spec.valueFlags || []) valueFlags.add(name);

  function coerce(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }

  function assign(name, value) {
    value = coerce(value);
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      if (!Array.isArray(flags[name])) flags[name] = [flags[name]];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token === '-') {
      positionals.push(token);
      continue;
    }
    if (token.startsWith('--')) {
      let raw = token.slice(2);
      let value;
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        value = raw.slice(eq + 1);
        raw = raw.slice(0, eq);
      }
      if (!raw) continue;
      const name = raw;
      const isNegated = name.startsWith('no-') && !booleanFlags.has(name);
      const base = isNegated ? name.slice(3) : name;
      if (value !== undefined) {
        assign(base, value);
        if (isNegated) flags[name] = true;
        continue;
      }
      if (booleanFlags.has(name) || booleanFlags.has(base)) {
        if (isNegated) {
          flags[base] = false;
        } else {
          assign(name, true);
          if (name.startsWith('no-') && booleanFlags.has(name.slice(3))) flags[name.slice(3)] = false;
        }
        continue;
      }
      const next = tokens[i + 1];
      if (next !== undefined && (!next.startsWith('-') || isDashValue(next))) {
        assign(base, next);
        i += 1;
      } else if (isNegated) {
        flags[base] = false;
        flags[name] = true;
      } else {
        assign(base, true);
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      const name = SHORT_FLAGS[short];
      if (!name) {
        positionals.push(token);
        continue;
      }
      if (name === 'help' || name === 'verbose' || name === 'quiet' || name === 'yes') {
        assign(name, true);
      } else {
        const next = tokens[i + 1];
        if (next !== undefined && (!next.startsWith('-') || isDashValue(next))) {
          assign(name, next);
          i += 1;
        } else {
          assign(name, true);
        }
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function camelKey(key) {
  return String(key).replace(/-([a-z0-9])/g, (_match, letter) => letter.toUpperCase());
}

function parseData(value) {
  if (value === undefined || value === null) return undefined;
  let text = String(value);
  if (text.startsWith('@')) {
    const file = text.slice(1);
    text = require('fs').readFileSync(file, 'utf8');
  }
  try { return JSON.parse(text); } catch (err) {
    throw Object.assign(new Error(`--data is not valid JSON: ${err.message}`), { code: 'invalid_data' });
  }
}

function parseKeyValue(text, label = 'value') {
  const raw = String(text);
  const eq = raw.indexOf('=');
  if (eq < 0) throw Object.assign(new Error(`${label} must be key=value: ${raw}`), { code: 'invalid_kv' });
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function parseQuery(values) {
  if (values === undefined) return {};
  const list = Array.isArray(values) ? values : [values];
  const query = {};
  for (const value of list) {
    const text = String(value).trim();
    if (!text) continue;
    if (text.startsWith('{')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (err) {
        throw Object.assign(new Error(`--query is not valid JSON: ${err.message}`), { code: 'invalid_query' });
      }
      Object.assign(query, parsed);
      continue;
    }
    const [key, item] = parseKeyValue(text, '--query');
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      if (!Array.isArray(query[key])) query[key] = [query[key]];
      query[key].push(item);
    } else {
      query[key] = item;
    }
  }
  return query;
}

function parseHeaders(values) {
  if (values === undefined) return {};
  const list = Array.isArray(values) ? values : [values];
  const headers = {};
  for (const value of list) {
    const raw = String(value);
    const colon = raw.indexOf(':');
    const equals = raw.indexOf('=');
    const index = colon >= 0 && (equals < 0 || colon < equals) ? colon : equals;
    if (index < 0) throw Object.assign(new Error(`--header must be "Name: value": ${raw}`), { code: 'invalid_header' });
    headers[raw.slice(0, index).trim()] = raw.slice(index + 1).trim();
  }
  return headers;
}

function parseFields(values) {
  if (values === undefined) return {};
  const list = Array.isArray(values) ? values : [values];
  const fields = {};
  for (const value of list) {
    const [key, item] = parseKeyValue(value, '--field');
    fields[key] = item;
  }
  return fields;
}

module.exports = {
  buildIndex,
  suggest,
  matchCommand,
  parseOptions,
  parseData,
  parseQuery,
  parseHeaders,
  parseFields,
  parseKeyValue,
  camelKey,
  GLOBAL_VALUE_FLAGS,
  GLOBAL_BOOLEAN_FLAGS,
};
