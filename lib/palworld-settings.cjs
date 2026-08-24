'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeResolve } = require('./files.cjs');
const snapshots = require('./snapshots.cjs');

const FILE_RELATIVE = path.join('Pal', 'Saved', 'Config');
const FILE_NAME = 'PalWorldSettings.ini';
const SCHEMA_VERSION = 1;
const SOURCE = {
  url: 'https://tech.palworldgame.com/settings-and-operation/configuration/',
  build: 'Official dedicated server configuration reference',
  verifiedAt: '2026-07-23',
};
const SCHEMA = [
  ['ServerName', 'server', 'string', null, null],
  ['ServerDescription', 'server', 'string', null, null],
  ['ServerPlayerMaxNum', 'server', 'integer', 1, 32],
  ['PublicPort', 'network', 'integer', 1, 65535],
  ['PublicIP', 'network', 'string', null, null],
  ['Region', 'network', 'string', null, null],
  ['CommunityServer', 'network', 'boolean', null, null],
  ['Difficulty', 'gameplay', 'enum', null, null, ['None', 'Normal', 'Difficult']],
  ['DayTimeSpeedRate', 'gameplay', 'number', 0.1, 5],
  ['NightTimeSpeedRate', 'gameplay', 'number', 0.1, 5],
  ['ExpRate', 'gameplay', 'number', 0.1, 20],
  ['PalCaptureRate', 'gameplay', 'number', 0.1, 20],
  ['PalSpawnNumRate', 'gameplay', 'number', 0.1, 20],
  ['PlayerDamageRateAttack', 'combat', 'number', 0.1, 5],
  ['PlayerDamageRateDefense', 'combat', 'number', 0.1, 5],
  ['PalDamageRateAttack', 'combat', 'number', 0.1, 5],
  ['PalDamageRateDefense', 'combat', 'number', 0.1, 5],
  ['DeathPenalty', 'gameplay', 'enum', null, null, ['None', 'Item', 'ItemAndEquipment', 'All']],
  ['bEnablePlayerToPlayerDamage', 'combat', 'boolean', null, null],
  ['bEnableFriendlyFire', 'combat', 'boolean', null, null],
  ['bEnableInvaderEnemy', 'world', 'boolean', null, null],
  ['DropItemMaxNum', 'world', 'integer', 0, 10000],
  ['BaseCampMaxNum', 'world', 'integer', 1, 128],
  ['BaseCampWorkerMaxNum', 'world', 'integer', 1, 100],
  ['CoopPlayerMaxNum', 'server', 'integer', 1, 32],
].map(([key, category, type, min, max, options]) => ({
  key, category, type, min, max, options: options || null, restartRequired: true, source: SOURCE,
}));

const PROTECTED = new Set([
  'AdminPassword', 'ServerPassword', 'RESTAPIEnabled', 'RESTAPIPort',
  'bIsUseBackupSaveData', 'bAllowConnectPlatform',
]);
const previews = new Map();
const replays = new Map();

class SettingsError extends Error {
  constructor(message, status = 400, code = 'invalid_settings') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function configPath(serverDir) {
  const configRoot = safeResolve(serverDir, FILE_RELATIVE);
  const candidates = ['LinuxServer', 'WindowsServer'];
  const existing = candidates
    .map((dir) => safeResolve(configRoot, path.join(dir, FILE_NAME)))
    .find((file) => fs.existsSync(file));
  return existing || safeResolve(configRoot, path.join(process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer', FILE_NAME));
}

function revision(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function scanTuple(text, start) {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function parseMembers(text, tupleStart, tupleEnd) {
  const members = [];
  const errors = [];
  let segmentStart = tupleStart + 1;
  let quoted = false;
  let escaped = false;
  let nested = 0;
  const consume = (end) => {
    const raw = text.slice(segmentStart, end);
    let eq = -1;
    let q = false;
    let esc = false;
    let d = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (q) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') q = false;
      } else if (ch === '"') q = true;
      else if (ch === '(' || ch === '[' || ch === '{') d += 1;
      else if (ch === ')' || ch === ']' || ch === '}') d -= 1;
      else if (ch === '=' && d === 0) { eq = i; break; }
    }
    if (eq < 1) {
      if (raw.trim()) errors.push('A tuple member is malformed.');
      return;
    }
    const keyOffset = raw.search(/\S/);
    const key = raw.slice(keyOffset, eq).trim();
    const valueOffset = eq + 1 + (raw.slice(eq + 1).search(/\S|$/));
    const valueEnd = raw.length - (raw.match(/\s*$/)?.[0].length || 0);
    members.push({
      key,
      rawValue: raw.slice(valueOffset, valueEnd),
      valueStart: segmentStart + valueOffset,
      valueEnd: segmentStart + valueEnd,
      segmentStart,
      segmentEnd: end,
    });
  };
  for (let i = tupleStart + 1; i < tupleEnd; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '(' || ch === '[' || ch === '{') nested += 1;
    else if (ch === ')' || ch === ']' || ch === '}') nested -= 1;
    else if (ch === ',' && nested === 0) {
      consume(i);
      segmentStart = i + 1;
    }
  }
  consume(tupleEnd);
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.key)) errors.push(`Duplicate tuple member: ${member.key}.`);
    seen.add(member.key);
  }
  return { members, errors };
}

function parse(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const text = buffer.toString('utf8');
  const matches = [...text.matchAll(/^\s*OptionSettings\s*=\s*\(/gm)];
  const errors = [];
  if (matches.length !== 1) errors.push(matches.length ? 'Duplicate OptionSettings entries were found.' : 'OptionSettings tuple was not found.');
  if (!matches.length) return { buffer, text, members: [], errors, revision: revision(buffer) };
  const tupleStart = matches[0].index + matches[0][0].lastIndexOf('(');
  const tupleEnd = scanTuple(text, tupleStart);
  if (tupleEnd < 0) return { buffer, text, members: [], errors: [...errors, 'OptionSettings tuple is malformed.'], revision: revision(buffer) };
  const parsed = parseMembers(text, tupleStart, tupleEnd);
  return { buffer, text, tupleStart, tupleEnd, members: parsed.members, errors: [...errors, ...parsed.errors], revision: revision(buffer) };
}

function decode(raw) {
  const value = String(raw);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function encode(value, schema) {
  if (schema.type === 'boolean') return value ? 'True' : 'False';
  if (schema.type === 'integer' || schema.type === 'number') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('A settings patch is required.');
  const issues = [];
  const normalized = {};
  const byKey = new Map(SCHEMA.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field || PROTECTED.has(key)) {
      issues.push({ key, message: 'This setting cannot be changed in the friendly editor.' });
      continue;
    }
    if (value === null) { normalized[key] = null; continue; }
    let next = value;
    if (field.type === 'boolean' && typeof next !== 'boolean') issues.push({ key, message: 'Enter true or false.' });
    if (field.type === 'integer' && (!Number.isInteger(Number(next)))) issues.push({ key, message: 'Enter a whole number.' });
    if (field.type === 'number' && !Number.isFinite(Number(next))) issues.push({ key, message: 'Enter a number.' });
    if (field.type === 'integer' || field.type === 'number') {
      next = Number(next);
      if (field.min != null && next < field.min) issues.push({ key, message: `Minimum: ${field.min}.` });
      if (field.max != null && next > field.max) issues.push({ key, message: `Maximum: ${field.max}.` });
    }
    if (field.options && !field.options.includes(next)) issues.push({ key, message: 'Choose a supported value.' });
    normalized[key] = next;
  }
  return { normalized, issues };
}

function applyPatch(parsed, patch) {
  if (parsed.errors.length) throw new SettingsError('Friendly editing is unavailable until the file syntax is repaired.', 409, 'malformed_settings');
  const byKey = new Map(parsed.members.map((member) => [member.key, member]));
  const schema = new Map(SCHEMA.map((field) => [field.key, field]));
  const edits = [];
  for (const [key, value] of Object.entries(patch)) {
    const member = byKey.get(key);
    if (value === null) {
      if (!member) continue;
      let start = member.segmentStart;
      let end = member.segmentEnd;
      if (parsed.text[end] === ',') end += 1;
      else if (parsed.text[start - 1] === ',') start -= 1;
      edits.push({ start, end, text: '' });
    } else {
      const encoded = encode(value, schema.get(key));
      if (member) edits.push({ start: member.valueStart, end: member.valueEnd, text: encoded });
      else edits.push({ start: parsed.tupleEnd, end: parsed.tupleEnd, text: `${parsed.members.length ? ',' : ''}${key}=${encoded}` });
    }
  }
  let text = parsed.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const result = Buffer.from(text, 'utf8');
  const verified = parse(result);
  if (verified.errors.length) throw new SettingsError('The resulting settings file could not be verified.', 500, 'verification_failed');
  return result;
}

function semanticDiff(parsed, patch, defaults = new Map()) {
  const current = new Map(parsed.members.map((member) => [member.key, decode(member.rawValue)]));
  return Object.entries(patch)
    .filter(([key, value]) => value !== current.get(key) && !(value === null && !current.has(key)))
    .map(([key, value]) => ({
      key,
      before: PROTECTED.has(key) ? null : (current.has(key) ? current.get(key) : null),
      after: PROTECTED.has(key) ? null : value,
      effectiveAfter: value === null ? (defaults.get(key) ?? null) : value,
      restartRequired: true,
    }));
}

function readDefaults(serverDir) {
  const candidates = [
    path.join(serverDir, 'DefaultPalWorldSettings.ini'),
    path.join(serverDir, 'Pal', 'DefaultPalWorldSettings.ini'),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return { values: new Map(), source: null };
  const parsed = parse(fs.readFileSync(file));
  return {
    values: new Map(parsed.members.map((member) => [member.key, decode(member.rawValue)])),
    source: { kind: 'installed-template', file: path.relative(serverDir, file), revision: parsed.revision },
  };
}

function read(server) {
  const file = configPath(server.dir);
  if (!fs.existsSync(file)) throw new SettingsError('PalWorldSettings.ini was not found.', 404, 'settings_not_found');
  const parsed = parse(fs.readFileSync(file));
  const defaults = readDefaults(server.dir);
  const known = new Set(SCHEMA.map((field) => field.key));
  const values = new Map(parsed.members.map((member) => [member.key, decode(member.rawValue)]));
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    source: { ...SOURCE, template: defaults.source },
    revision: parsed.revision,
    editable: parsed.errors.length === 0,
    errors: parsed.errors,
    restartRequired: false,
    file: path.relative(server.dir, file),
    fields: SCHEMA.map((field) => ({
      ...field,
      state: values.has(field.key) ? (values.get(field.key) === '' ? 'empty' : 'set') : 'inherited',
      value: values.has(field.key) ? values.get(field.key) : null,
      effectiveValue: values.has(field.key) ? values.get(field.key) : (defaults.values.get(field.key) ?? null),
      defaultValue: defaults.values.get(field.key) ?? null,
    })),
    unknown: parsed.members.filter((member) => !known.has(member.key)).map((member) => ({
      key: member.key,
      protected: PROTECTED.has(member.key),
    })),
  };
}

function validateProtectedRaw(input, descriptor) {
  const parsed = parse(Buffer.from(input));
  if (parsed.errors.length) return { ok: false, error: parsed.errors.join(' ') };
  const values = new Map(parsed.members.map((member) => [member.key, decode(member.rawValue)]));
  if (values.get('RESTAPIEnabled') !== true) {
    return { ok: false, error: 'Palworld REST API must remain enabled.' };
  }
  if (Number(values.get('RESTAPIPort')) !== Number(descriptor?.restPort)) {
    return { ok: false, error: 'Palworld REST port is managed by Hostkind.' };
  }
  if (String(values.get('AdminPassword') || '') !== String(descriptor?.adminPassword || '')) {
    return { ok: false, error: 'Palworld administration password is managed by Hostkind.' };
  }
  return { ok: true };
}

function preview(server, actorId, body) {
  const file = configPath(server.dir);
  const before = fs.readFileSync(file);
  const parsed = parse(before);
  if (body?.revision !== parsed.revision) throw new SettingsError('The settings file changed. Reload before previewing.', 409, 'revision_mismatch');
  const { normalized, issues } = validatePatch(body.patch);
  if (issues.length) return { ok: false, issues, revision: parsed.revision };
  const after = applyPatch(parsed, normalized);
  const defaults = readDefaults(server.dir);
  const changes = semanticDiff(parsed, normalized, defaults.values);
  const token = crypto.randomBytes(32).toString('base64url');
  previews.set(token, {
    token, actorId, serverId: server.id, revision: parsed.revision, patch: normalized,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return {
    ok: true, previewToken: token, revision: parsed.revision, expiresAt: previews.get(token).expiresAt,
    changes,
    fileDiff: changes.map((change) => ({
      key: change.key,
      before: change.before,
      after: change.after,
      operation: change.after === null ? 'remove' : (change.before === null ? 'add' : 'replace'),
    })),
    restartRequired: changes.length > 0,
  };
}

function apply(server, actorId, body, idempotencyKey) {
  if (!idempotencyKey) throw new SettingsError('An Idempotency-Key header is required.', 400, 'idempotency_key_required');
  const replayKey = `${actorId}:${idempotencyKey}`;
  if (replays.has(replayKey)) return replays.get(replayKey);
  const token = previews.get(body?.previewToken);
  if (!token || token.expiresAt < Date.now() || token.actorId !== actorId || token.serverId !== server.id) {
    throw new SettingsError('The preview expired or is invalid. Preview the changes again.', 409, 'invalid_preview');
  }
  const file = configPath(server.dir);
  const before = fs.readFileSync(file);
  if (token.revision !== revision(before) || body?.revision !== token.revision) {
    throw new SettingsError('The settings file changed. Preview the changes again.', 409, 'revision_mismatch');
  }
  const after = applyPatch(parse(before), token.patch);
  const relative = path.relative(server.dir, file);
  const snapshot = snapshots.take({
    serverId: server.id, sourceDir: server.dir, scope: [relative],
    kind: 'palworld-settings', reason: `Settings revision ${token.revision.slice(0, 12)}`, retention: 20,
  });
  if (!snapshots.verify(snapshot.id).ok) throw new SettingsError('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = safeResolve(path.dirname(file), `.${FILE_NAME}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, after);
  if (parse(fs.readFileSync(temporary)).errors.length) {
    fs.unlinkSync(temporary);
    throw new SettingsError('The staged settings file could not be verified.', 500, 'verification_failed');
  }
  fs.renameSync(temporary, file);
  previews.delete(token.token);
  const result = { ok: true, revision: revision(after), snapshotId: snapshot.id, restartRequired: !before.equals(after) };
  replays.set(replayKey, result);
  return result;
}

function history(server) {
  return snapshots.list(server.id)
    .filter((entry) => entry.kind === 'palworld-settings')
    .map((entry) => ({ id: entry.id, createdAt: new Date(entry.taken_at).toISOString(), reason: entry.reason, verified: !!entry.verified }));
}

function restore(server, id) {
  const entry = history(server).find((item) => item.id === id);
  if (!entry) throw new SettingsError('Settings history entry was not found.', 404, 'history_not_found');
  const current = fs.readFileSync(configPath(server.dir));
  const currentParsed = parse(current);
  if (currentParsed.errors.length) throw new SettingsError('The current settings file is malformed.', 409, 'malformed_settings');
  const relative = path.relative(server.dir, configPath(server.dir));
  const rollback = snapshots.take({
    serverId: server.id, sourceDir: server.dir, scope: [relative],
    kind: 'palworld-settings', reason: `Before restoring ${id}`, retention: 20,
  });
  if (!snapshots.verify(rollback.id).ok) throw new SettingsError('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  const restored = snapshots.restore({ id, targetDir: server.dir });
  if (!restored.ok) throw new SettingsError('The settings snapshot could not be restored.', 500, 'restore_failed');
  const next = fs.readFileSync(configPath(server.dir));
  if (parse(next).errors.length) {
    snapshots.restore({ id: rollback.id, targetDir: server.dir });
    throw new SettingsError('The restored settings file is malformed.', 500, 'verification_failed');
  }
  return { ok: true, revision: revision(next), restartRequired: true, snapshotId: rollback.id };
}

module.exports = {
  FILE_NAME, SCHEMA_VERSION, SCHEMA, PROTECTED, SettingsError,
  configPath, parse, decode, validatePatch, validateProtectedRaw, applyPatch, read, preview, apply, history, restore,
};
