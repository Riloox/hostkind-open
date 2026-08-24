'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeResolveNoFollow } = require('./files.cjs');
const { Transaction } = require('./fsTransaction.cjs');
const snapshots = require('./snapshots.cjs');

/*
 * `serverconfig.txt` parser and serializer (docs/terraria/04-configuration.md
 * step 1).
 *
 * Phase 3 needs one key written - `world=` - and needs every other byte of the
 * file to survive it. That is the whole reason this module exists now rather
 * than in phase 4: the alternative was a one-off regex in the world module,
 * which is exactly the "friendly-form save rewrites the file from a template"
 * failure the configuration phase is written to prevent.
 *
 * What is here is only the round-tripping core phase 4 declares:
 *
 *   parse(text)              -> document
 *   serialize(document)      -> text
 *   patch(document, changes) -> { document, diff }
 *   get(document, key)       -> value | null
 *
 * The field schema, the defaults read off the shipped commented template, the
 * history and the routes are phase 4's. Nothing here knows what a key means.
 *
 * The governing rule, from that phase: **Hostkind does not own these files.**
 *
 *   - The byte-order mark, line endings, comments, blank lines, key order,
 *     unknown keys and surrounding whitespace are preserved.
 *   - Each line carries its own terminator, so a file with mixed endings
 *     round-trips unchanged instead of being normalized to one of them.
 *   - Only changed lines are re-emitted; a parse -> serialize round trip with no
 *     changes is byte-identical.
 *   - A duplicated key is refused rather than resolved. Silently writing the
 *     last occurrence is how a setting change appears to do nothing.
 */

class ConfigError extends Error {
  constructor(message, { status = 400, code = 'config_error', key = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

const fail = (message, status, code, key) => { throw new ConfigError(message, { status, code, key }); };

// A Terraria config key is a bare identifier. Anything else in the key position
// is not a setting, and treating it as one is how a comment becomes a write
// target. This is deliberately a scanner rather than a backtracking regular
// expression: configuration text can be supplied by an operator, and parsing
// it must remain linear even for adversarial whitespace.
function parseKeyValue(raw) {
  let at = 0;
  while (at < raw.length && (raw[at] === ' ' || raw[at] === '\t')) at += 1;
  const indent = raw.slice(0, at);
  if (at >= raw.length) return null;

  const first = raw.charCodeAt(at);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) return null;
  const keyStart = at;
  at += 1;
  while (at < raw.length) {
    const code = raw.charCodeAt(at);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 95 || code === 46 || code === 45;
    if (!valid) break;
    at += 1;
  }
  const key = raw.slice(keyStart, at);
  const separatorStart = at;
  while (at < raw.length && (raw[at] === ' ' || raw[at] === '\t')) at += 1;
  if (raw[at] !== '=') return null;
  at += 1;
  while (at < raw.length && (raw[at] === ' ' || raw[at] === '\t')) at += 1;
  const value = raw.slice(at);
  if (value.includes(String.fromCharCode(13)) || value.includes(String.fromCharCode(10)) || value.includes(String.fromCharCode(0x2028)) || value.includes(String.fromCharCode(0x2029))) return null;
  return { key, value, indent, separator: raw.slice(separatorStart, at) };
}

const BOM = '\ufeff';

/*
 * Split text into lines that each keep the terminator that followed them. The
 * last element has an empty terminator when the file does not end in a newline,
 * which is the difference between "ends with a blank line" and "does not end
 * with a newline" - and losing it would rewrite the last byte of every file.
 */
function splitLines(text) {
  const out = [];
  let start = 0;
  // Scan newline to newline with indexOf instead of a counter loop: the
  // iteration count is bounded by the number of '\n' in the text itself, so a
  // user-supplied string cannot drive an unbounded loop (CodeQL
  // js/loop-bound-injection). Slices and terminators are identical to before.
  let at = text.indexOf('\n', start);
  while (at !== -1) {
    const crlf = at > start && text[at - 1] === '\r';
    out.push({ raw: text.slice(start, crlf ? at - 1 : at), eol: crlf ? '\r\n' : '\n' });
    start = at + 1;
    at = text.indexOf('\n', start);
  }
  if (start < text.length) out.push({ raw: text.slice(start), eol: '' });
  return out;
}

function parse(text) {
  const source = String(text == null ? '' : text);
  const bom = source.startsWith(BOM) ? BOM : '';
  const body = bom ? source.slice(BOM.length) : source;
  const lines = splitLines(body);

  const entries = lines.map((line, index) => {
    const match = parseKeyValue(line.raw);
    if (match) {
      return {
        raw: line.raw,
        eol: line.eol,
        index,
        kind: 'pair',
        key: match.key,
        value: match.value,
        // The exact whitespace around the key and the separator, so rewriting a
        // value cannot silently reformat the line.
        indent: match.indent,
        separator: match.separator,
      };
    }
    return {
      raw: line.raw,
      eol: line.eol,
      index,
      kind: line.raw.trim() === '' ? 'blank' : 'comment',
      key: null,
      value: null,
    };
  });

  // The terminator new lines get. The file's own dominant one, so an append to
  // a CRLF file does not leave one lone LF behind; os.EOL is not consulted -
  // the file is the authority, not the host.
  const crlf = entries.filter((e) => e.eol === '\r\n').length;
  const lf = entries.filter((e) => e.eol === '\n').length;
  const eol = crlf > lf ? '\r\n' : '\n';

  return { bom, eol, entries };
}

const SOURCE = Object.freeze({
  url: 'https://terraria.wiki.gg/wiki/Server',
  build: 'Terraria dedicated server configuration reference',
  observedDefault: 'Installed serverconfig.txt template',
  verifiedAt: '2026-07-25',
});

function field(key, type, group, constraints = {}, extra = {}) {
  return Object.freeze({
    key, type, group, constraints, restartRequired: true, secret: false,
    variants: ['vanilla', 'tshock', 'tmodloader'],
    defaultSource: SOURCE,
    ...extra,
  });
}

const SCHEMA = Object.freeze([
  field('port', 'integer', 'network', { min: 1, max: 65535 }),
  field('maxplayers', 'integer', 'network', { min: 1, max: 255 }),
  field('password', 'secret', 'network', { maxLength: 128 }, { secret: true }),
  field('secure', 'boolean', 'network'),
  field('upnp', 'boolean', 'network'),
  field('world', 'path', 'world', {}, { managedBy: 'worlds' }),
  field('worldpath', 'path', 'world', {}, { managedBy: 'worlds' }),
  field('autocreate', 'enum', 'world', { options: ['1', '2', '3'] }),
  field('worldname', 'string', 'world', { maxLength: 80 }),
  field('seed', 'string', 'world', { maxLength: 80 }),
  field('difficulty', 'enum', 'world', { options: ['0', '1', '2', '3'] }),
  field('motd', 'string', 'presentation', { maxLength: 200 }),
  field('language', 'string', 'presentation', { maxLength: 16 }),
  field('banlist', 'path', 'moderation'),
  field('npcstream', 'integer', 'performance', { min: 0, max: 10 }),
  field('priority', 'integer', 'performance', { min: 0, max: 5 }),
].map(Object.freeze));

const TSHOCK_SCHEMA = Object.freeze([
  field('ServerName', 'string', 'presentation', { maxLength: 80 }, { file: 'tshock/config.json', variants: ['tshock'] }),
  field('ServerDescription', 'string', 'presentation', { maxLength: 200 }, { file: 'tshock/config.json', variants: ['tshock'] }),
  field('MaxSlots', 'integer', 'network', { min: 1, max: 255 }, { file: 'tshock/config.json', variants: ['tshock'] }),
  field('SaveWorldInterval', 'integer', 'performance', { min: 1 }, { file: 'tshock/config.json', variants: ['tshock'] }),
  field('EnableWhitelist', 'boolean', 'moderation', {}, { file: 'tshock/config.json', variants: ['tshock'] }),
  field('DisableSpewLogs', 'boolean', 'moderation', {}, { file: 'tshock/config.json', variants: ['tshock'] }),
]);

const TSHOCK_PROTECTED = new Set([
  'RestApiEnabled', 'RestApiPort', 'ApplicationRestTokens', 'ApplicationRestTokensEnabled',
]);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const SECRET_PLACEHOLDER = '<fleetdeck-secret-redacted>';
const previews = new Map();
const replays = new Map();

function variant(desc) {
  const value = String(desc?.terrariaVariant || 'vanilla').toLowerCase();
  return ['vanilla', 'tshock', 'tmodloader'].includes(value) ? value : 'vanilla';
}

function filesFor(desc) {
  return variant(desc) === 'tshock'
    ? ['serverconfig.txt', 'tshock/config.json', 'tshock/sscconfig.json']
    : ['serverconfig.txt'];
}

function configSchema(desc) {
  return {
    files: filesFor(desc),
    fields: variant(desc) === 'tshock' ? [...SCHEMA, ...TSHOCK_SCHEMA] : [...SCHEMA],
  };
}

function resolveFile(server, rel, write = false) {
  const file = String(rel || '').replace(/\\/g, '/');
  if (!filesFor(server.desc).includes(file)) {
    fail('This file is not available in the Terraria configuration editor.', 403, 'file_not_allowed');
  }
  try {
    return safeResolveNoFollow(server.dir, file);
  } catch {
    fail('The configuration path is outside the server folder.', 403, 'path_not_allowed');
  }
}

function revisionFor(file) {
  const buffer = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return `${crypto.createHash('sha256').update(buffer).digest('hex')}:${Math.trunc(stat.mtimeMs)}`;
}

function duplicates(document) {
  const count = new Map();
  for (const entry of document.entries) {
    if (entry.kind === 'pair') count.set(entry.key, (count.get(entry.key) || 0) + 1);
  }
  return [...count].filter(([, total]) => total > 1).map(([key, total]) => ({ key, count: total }));
}

function parseCommentDefaults(document) {
  const values = new Map();
  for (const entry of document.entries) {
    const match = /^\s*#\s*([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(entry.raw);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  return values;
}

function publicValue(fieldInfo, value) {
  if (fieldInfo.secret) return undefined;
  return value;
}

function read(server) {
  const main = resolveFile(server, 'serverconfig.txt');
  if (!fs.existsSync(main)) fail('serverconfig.txt was not found.', 404, 'config_not_found');
  const document = parse(fs.readFileSync(main, 'utf8'));
  const dups = duplicates(document);
  const defaults = parseCommentDefaults(document);
  const present = new Map(document.entries.filter((entry) => entry.kind === 'pair').map((entry) => [entry.key, entry.value]));
  const known = new Set(SCHEMA.map((entry) => entry.key));
  const fields = SCHEMA.map((entry) => ({
    ...entry,
    file: 'serverconfig.txt',
    state: present.has(entry.key) ? (present.get(entry.key) === '' ? 'empty' : 'set') : 'absent',
    ...(entry.secret
      ? { isSet: present.has(entry.key) && present.get(entry.key) !== '' }
      : { value: present.has(entry.key) ? present.get(entry.key) : null }),
    defaultValue: publicValue(entry, defaults.get(entry.key) ?? null),
  }));
  const unknown = document.entries
    .filter((entry) => entry.kind === 'pair' && !known.has(entry.key))
    .map((entry) => ({ key: entry.key, file: 'serverconfig.txt' }));

  let tshock = null;
  if (variant(server.desc) === 'tshock') {
    const rel = 'tshock/config.json';
    const file = resolveFile(server, rel);
    if (!fs.existsSync(file)) {
      tshock = { exists: false, file: rel, message: 'TShock creates this file after its first successful start.' };
    } else {
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { value = null; dups.push({ key: rel, count: 1, error: `Invalid JSON: ${error.message}` }); }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const knownTshock = new Set(TSHOCK_SCHEMA.map((entry) => entry.key));
        fields.push(...TSHOCK_SCHEMA.map((entry) => ({
          ...entry,
          state: Object.hasOwn(value, entry.key) ? 'set' : 'absent',
          value: Object.hasOwn(value, entry.key) ? value[entry.key] : null,
          defaultValue: null,
        })));
        unknown.push(...Object.keys(value).filter((key) => !knownTshock.has(key)).map((key) => ({
          key, file: rel, protected: TSHOCK_PROTECTED.has(key),
        })));
        tshock = {
          exists: true, file: rel,
          admin: Object.fromEntries([...TSHOCK_PROTECTED].map((key) => [
            key, key.toLowerCase().includes('token') ? { configured: Boolean(value[key]) } : { value: value[key] ?? null },
          ])),
        };
      }
    }
  }
  return {
    ok: true, schemaVersion: 1, revision: revisionFor(main), editable: dups.length === 0,
    errors: dups.map((entry) => entry.error || `"${entry.key}" appears ${entry.count} times.`),
    file: 'serverconfig.txt', files: filesFor(server.desc), fields, unknown, tshock,
    source: SOURCE, restartRequired: false,
  };
}

function normalizeValue(fieldInfo, value) {
  if (value === null) return null;
  if (fieldInfo.type === 'boolean') {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (!['0', '1', 'true', 'false'].includes(String(value).toLowerCase())) fail(`"${fieldInfo.key}" must be true or false.`, 422, 'validation_error', fieldInfo.key);
    return ['1', 'true'].includes(String(value).toLowerCase()) ? '1' : '0';
  }
  if (fieldInfo.type === 'integer') {
    const number = Number(value);
    if (!Number.isInteger(number)) fail(`"${fieldInfo.key}" must be a whole number.`, 422, 'validation_error', fieldInfo.key);
    if (fieldInfo.constraints.min != null && number < fieldInfo.constraints.min) fail(`"${fieldInfo.key}" must be at least ${fieldInfo.constraints.min}.`, 422, 'validation_error', fieldInfo.key);
    if (fieldInfo.constraints.max != null && number > fieldInfo.constraints.max) fail(`"${fieldInfo.key}" must be at most ${fieldInfo.constraints.max}.`, 422, 'validation_error', fieldInfo.key);
    return String(number);
  }
  const text = String(value);
  if (fieldInfo.constraints.maxLength && text.length > fieldInfo.constraints.maxLength) fail(`"${fieldInfo.key}" is too long.`, 422, 'validation_error', fieldInfo.key);
  if (fieldInfo.constraints.options && !fieldInfo.constraints.options.includes(text)) fail(`"${fieldInfo.key}" is not a supported value.`, 422, 'validation_error', fieldInfo.key);
  return text;
}

function validateChanges(server, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('A configuration patch is required.', 400, 'patch_required');
  const allowed = new Map(configSchema(server.desc).fields.map((entry) => [entry.key, entry]));
  const normalized = {};
  for (const [key, value] of Object.entries(changes)) {
    const entry = allowed.get(key);
    if (!entry) fail(`"${key}" is not available in the friendly editor.`, 422, 'unknown_field', key);
    if (entry.managedBy === 'worlds') fail(`"${key}" is managed in the worlds view.`, 409, 'worlds_view_required', key);
    normalized[key] = normalizeValue(entry, value);
  }
  return normalized;
}

function preview(server, actorId, body) {
  const file = resolveFile(server, 'serverconfig.txt');
  const revision = revisionFor(file);
  if (body?.revision !== revision) fail('The configuration changed. Reload before previewing.', 409, 'revision_mismatch');
  const normalized = validateChanges(server, body?.changes);
  const document = parse(fs.readFileSync(file, 'utf8'));
  if (duplicates(document).length) fail('Resolve duplicate keys in the raw editor before using the friendly form.', 409, 'duplicate_key');
  const serverChanges = Object.fromEntries(Object.entries(normalized).filter(([key]) => !TSHOCK_SCHEMA.some((fieldInfo) => fieldInfo.key === key)));
  const result = patch(document, serverChanges);
  const byKey = new Map(SCHEMA.map((entry) => [entry.key, entry]));
  const changes = result.diff.map((item) => {
    const secret = byKey.get(item.key)?.secret;
    return {
      key: item.key, before: secret ? null : item.from, after: secret ? null : item.to,
      secret: !!secret, restartRequired: true,
    };
  });
  const tshockPatch = Object.entries(normalized).filter(([key]) => TSHOCK_SCHEMA.some((entry) => entry.key === key));
  if (tshockPatch.length) {
    const tshockFile = resolveFile(server, 'tshock/config.json');
    if (!fs.existsSync(tshockFile)) fail('TShock creates config.json after its first successful start.', 409, 'config_not_found');
    const current = JSON.parse(fs.readFileSync(tshockFile, 'utf8'));
    for (const [key, value] of tshockPatch) {
      const schema = TSHOCK_SCHEMA.find((entry) => entry.key === key);
      const after = value === null ? null : (schema.type === 'boolean' ? value === '1' : (schema.type === 'integer' ? Number(value) : value));
      if (current[key] !== after) changes.push({ key, before: current[key] ?? null, after, secret: false, restartRequired: true });
    }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  previews.set(token, {
    actorId, serverId: server.id, revision, changes: normalized,
    tshockRevision: tshockPatch.length ? revisionFor(resolveFile(server, 'tshock/config.json')) : null,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return { ok: true, previewToken: token, revision, changes, restartRequired: changes.length > 0 };
}

function snapshotAndWrite(server, rel, data, reason, changedKeys = []) {
  resolveFile(server, rel, true);
  const snapshot = snapshots.take({
    serverId: server.id, sourceDir: server.dir, scope: [rel], kind: 'terraria-config',
    reason: JSON.stringify({ text: reason, changedKeys: changedKeys.filter((key) => key !== 'password') }),
  });
  if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  const tx = new Transaction({ serverDir: server.dir, operationId: `terraria-config-${crypto.randomUUID()}` });
  const staged = tx.stageWrite(rel, data);
  validateRaw(rel, fs.readFileSync(staged, 'utf8'));
  tx.commit();
  return snapshot;
}

function apply(server, actorId, body, idempotencyKey) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required.', 400, 'idempotency_key_required');
  const replayKey = `${server.id}:${actorId}:${idempotencyKey}`;
  if (replays.has(replayKey)) return replays.get(replayKey);
  const record = previews.get(body?.previewToken);
  if (!record || record.actorId !== actorId || record.serverId !== server.id || record.expiresAt < Date.now()) {
    fail('The preview expired or is invalid. Preview the changes again.', 409, 'invalid_preview');
  }
  const file = resolveFile(server, 'serverconfig.txt');
  if (body?.revision !== record.revision || revisionFor(file) !== record.revision) {
    fail('The configuration changed. Preview the changes again.', 409, 'revision_mismatch');
  }
  const document = parse(fs.readFileSync(file, 'utf8'));
  const serverChanges = Object.fromEntries(Object.entries(record.changes).filter(([key]) => !TSHOCK_SCHEMA.some((fieldInfo) => fieldInfo.key === key)));
  const tshockChanges = Object.fromEntries(Object.entries(record.changes).filter(([key]) => TSHOCK_SCHEMA.some((fieldInfo) => fieldInfo.key === key)));
  if (record.tshockRevision && revisionFor(resolveFile(server, 'tshock/config.json')) !== record.tshockRevision) {
    fail('The TShock configuration changed. Preview the changes again.', 409, 'revision_mismatch');
  }
  const changedKeys = Object.keys(record.changes);
  const next = patch(document, serverChanges);
  const writes = [['serverconfig.txt', serialize(next.document)]];
  if (Object.keys(tshockChanges).length) {
    const rel = 'tshock/config.json';
    const tshockFile = resolveFile(server, rel, true);
    if (!fs.existsSync(tshockFile)) fail('TShock creates config.json after its first successful start.', 409, 'config_not_found');
    const text = fs.readFileSync(tshockFile, 'utf8');
    const value = JSON.parse(text);
    for (const [key, raw] of Object.entries(tshockChanges)) {
      if (raw === null) delete value[key];
      else {
        const schema = TSHOCK_SCHEMA.find((entry) => entry.key === key);
        value[key] = schema.type === 'boolean' ? raw === '1' : (schema.type === 'integer' ? Number(raw) : raw);
      }
    }
    const indent = /^\{\r?\n(\s+)"/.exec(text)?.[1] || '  ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    writes.push([rel, JSON.stringify(value, null, indent).replace(/\n/g, eol) + (text.endsWith('\n') ? eol : '')]);
  }
  const scope = writes.map(([rel]) => rel);
  const snapshot = snapshots.take({
    serverId: server.id, sourceDir: server.dir, scope, kind: 'terraria-config',
    reason: JSON.stringify({ text: `Configuration revision ${record.revision.slice(0, 12)}`, changedKeys: changedKeys.filter((key) => key !== 'password') }),
  });
  if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  const tx = new Transaction({ serverDir: server.dir, operationId: `terraria-config-${crypto.randomUUID()}` });
  for (const [rel, content] of writes) {
    const staged = tx.stageWrite(rel, content);
    validateRaw(rel, fs.readFileSync(staged, 'utf8'));
  }
  tx.commit();
  previews.delete(body.previewToken);
  const result = { ok: true, revision: revisionFor(file), snapshotId: snapshot.id, restartRequired: changedKeys.length > 0 };
  replays.set(replayKey, result);
  return result;
}

function lineFromJsonError(error, text) {
  const match = /position\s+(\d+)/i.exec(error.message);
  if (!match) return 1;
  return text.slice(0, Number(match[1])).split(/\r\n|\n|\r/).length;
}

function validateRaw(rel, text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) fail('This configuration file is too large to edit.', 413, 'file_too_large');
  if (rel === 'serverconfig.txt') {
    const document = parse(text);
    const malformed = document.entries.find((entry) => entry.kind === 'comment' && entry.raw.trim() && !entry.raw.trim().startsWith('#'));
    if (malformed) fail(`Invalid configuration syntax on line ${malformed.index + 1}.`, 422, 'parse_error');
    return;
  }
  try { JSON.parse(text); }
  catch (error) { fail(`Invalid JSON on line ${lineFromJsonError(error, text)}: ${error.message}`, 422, 'parse_error'); }
}

function readRaw(server, rel) {
  const file = resolveFile(server, rel);
  if (!fs.existsSync(file)) fail('The configuration file does not exist yet.', 404, 'config_not_found');
  const stat = fs.statSync(file);
  if (stat.size > MAX_EDIT_BYTES) fail('This configuration file is too large to edit.', 413, 'file_too_large');
  let content = fs.readFileSync(file, 'utf8');
  if (rel === 'serverconfig.txt') {
    const document = parse(content);
    const secret = entriesFor(document, 'password');
    if (secret.length === 1) content = serialize(patch(document, { password: SECRET_PLACEHOLDER }).document);
  }
  return { ok: true, file: rel, content, revision: revisionFor(file) };
}

function writeRaw(server, actorId, body) {
  const rel = String(body?.file || '');
  const file = resolveFile(server, rel, true);
  if (!fs.existsSync(file)) fail('The configuration file does not exist yet.', 404, 'config_not_found');
  if (body?.revision !== revisionFor(file)) fail('The configuration changed. Reload before saving.', 409, 'revision_mismatch');
  let content = String(body?.content ?? '');
  if (rel === 'serverconfig.txt' && content.includes(SECRET_PLACEHOLDER)) {
    const currentDocument = parse(fs.readFileSync(file, 'utf8'));
    const password = get(currentDocument, 'password');
    content = serialize(patch(parse(content), { password }).document);
  }
  validateRaw(rel, content);
  const before = fs.readFileSync(file, 'utf8');
  const snapshot = snapshotAndWrite(server, rel, content, `Raw configuration edit by ${actorId}`, ['raw']);
  return { ok: true, revision: revisionFor(file), snapshotId: snapshot.id, restartRequired: before !== content };
}

function history(server) {
  return snapshots.list(server.id).filter((entry) => entry.kind === 'terraria-config').map((entry) => {
    let reason = entry.reason;
    let changedKeys = [];
    try {
      const parsed = JSON.parse(reason);
      reason = parsed.text;
      changedKeys = parsed.changedKeys || [];
    } catch { /* legacy reason */ }
    return {
      id: entry.id, createdAt: new Date(entry.taken_at).toISOString(), actor: null,
      changedKeys, revision: entry.id, reason, verified: !!entry.verified,
    };
  });
}

function restore(server, id) {
  const entry = history(server).find((item) => item.id === id);
  if (!entry) fail('Configuration history entry was not found.', 404, 'history_not_found');
  const current = snapshots.take({
    serverId: server.id, sourceDir: server.dir, scope: filesFor(server.desc),
    kind: 'terraria-config', reason: JSON.stringify({ text: `Before restoring ${id}`, changedKeys: ['restore'] }),
  });
  if (!snapshots.verify(current.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  const result = snapshots.restore({ id, targetDir: server.dir });
  if (!result.ok) fail('The configuration snapshot could not be restored.', 500, 'restore_failed');
  for (const rel of filesFor(server.desc)) {
    const file = resolveFile(server, rel);
    if (fs.existsSync(file)) validateRaw(rel, fs.readFileSync(file, 'utf8'));
  }
  return { ok: true, restartRequired: true, snapshotId: current.id };
}

function serialize(document) {
  const entries = Array.isArray(document && document.entries) ? document.entries : [];
  return (document.bom || '') + entries.map((entry) => entry.raw + entry.eol).join('');
}

// Every entry for a key, in file order. Callers use the length: one is a value,
// more than one is an ambiguity nobody may resolve on the operator's behalf.
function entriesFor(document, key) {
  const wanted = String(key);
  return (document.entries || []).filter((entry) => entry.kind === 'pair' && entry.key === wanted);
}

/*
 * The value of a key, or null when it is absent. An empty value is `''`, which
 * is deliberately distinguishable from absent: Terraria reads `password=` as
 * "no password" and a missing `password` as "no password" too, but a form that
 * cannot tell them apart cannot show the difference either.
 */
function get(document, key) {
  const found = entriesFor(document, key);
  if (!found.length) return null;
  if (found.length > 1) fail(`"${key}" appears ${found.length} times in this file.`, 409, 'duplicate_key', key);
  return found[0].value;
}

function assertValue(key, value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) fail(`The value for "${key}" may not contain a line break.`, 400, 'invalid_value', key);
  return text;
}

/*
 * Apply changes to a parsed document, returning a new document and the diff.
 *
 * `null` removes the key's line; a string sets it. A key that is present is
 * rewritten in place (its indentation and separator whitespace preserved); a
 * key that is absent is appended. Nothing else in the document is touched, so
 * the serialized result differs from the input in exactly the changed lines.
 */
function patch(document, changes = {}) {
  const entries = (document.entries || []).map((entry) => ({ ...entry }));
  const next = { ...document, entries };
  const diff = [];

  for (const [key, raw] of Object.entries(changes)) {
    const found = entries.filter((entry) => entry.kind === 'pair' && entry.key === key);
    if (found.length > 1) {
      fail(`"${key}" appears ${found.length} times in this file. Resolve the duplicates before changing it.`, 409, 'duplicate_key', key);
    }
    const current = found.length ? found[0].value : null;

    if (raw === null) {
      if (!found.length) continue;
      const at = entries.indexOf(found[0]);
      entries.splice(at, 1);
      for (let i = at; i < entries.length; i++) entries[i].index = i;
      diff.push({ key, from: current, to: null });
      continue;
    }

    const value = assertValue(key, raw);
    if (current === value) continue;

    if (found.length) {
      const entry = found[0];
      entry.value = value;
      entry.raw = `${entry.indent}${entry.key}${entry.separator}${value}`;
      diff.push({ key, from: current, to: value });
      continue;
    }

    // Appended. A file whose last line has no terminator gets one first, so the
    // new key does not land on the end of an existing line.
    const last = entries[entries.length - 1];
    if (last && last.eol === '') last.eol = next.eol;
    entries.push({
      raw: `${key}=${value}`,
      eol: next.eol,
      index: entries.length,
      kind: 'pair',
      key,
      value,
      indent: '',
      separator: '=',
    });
    diff.push({ key, from: null, to: value });
  }

  return { document: next, diff };
}

module.exports = {
  ConfigError, SOURCE, SCHEMA, TSHOCK_SCHEMA, TSHOCK_PROTECTED, MAX_EDIT_BYTES,
  parse, serialize, patch, get, entriesFor, configSchema, filesFor,
  read, preview, apply, readRaw, writeRaw, history, restore, validateRaw, revisionFor,
};
