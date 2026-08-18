'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ADAPTER_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_NAME = /^[^"\\\u0000-\u001f\u007f]{1,64}$/;
const ADMIN_PERMISSIONS = /^(?:tshock\.admin|tshock\.superadmin|tshock\.cfg|tshock\.group|tshock\.user)/i;

class TShockError extends Error {
  constructor(state, code, message, status = 503) {
    super(message);
    this.name = 'TShockError';
    this.state = state;
    this.code = code;
    this.status = status;
  }
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function initialHealth(configured = false) {
  return {
    state: configured ? 'unavailable' : 'disabled',
    code: configured ? 'not_polled' : 'not_configured',
    lastOkAt: null,
    lastErrorAt: null,
  };
}

function tshockConfig(desc = {}) {
  const value = desc.tshock && typeof desc.tshock === 'object' && !Array.isArray(desc.tshock) ? desc.tshock : {};
  let file = {};
  try {
    const root = path.resolve(String(desc.dir || desc.cwd || '.'));
    file = JSON.parse(fs.readFileSync(path.join(root, 'tshock', 'config.json'), 'utf8'));
  } catch (_) {}
  const storedTokens = file.ApplicationRestTokens;
  const discoveredToken = Array.isArray(storedTokens)
    ? clean(storedTokens[0]?.Token || storedTokens[0]?.token || storedTokens[0])
    : clean(Object.values(storedTokens || {})[0]?.Token || Object.keys(storedTokens || {})[0]);
  return {
    enabled: value.restEnabled === true || file.RestApiEnabled === true,
    host: clean(value.restHost) || '127.0.0.1',
    port: Number(value.restPort || file.RestApiPort),
    token: clean(value.restToken) || discoveredToken,
  };
}

function assertLoopback(host) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase())) {
    throw new TShockError('misconfigured', 'non_loopback_host', 'TShock REST must be bound to loopback.', 409);
  }
}

function createAdapter(deps = {}) {
  const fetchImpl = deps.fetch || global.fetch;
  const timeoutMs = Number(deps.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let currentHealth = initialHealth(false);

  async function request(config, method, endpoint, body) {
    const rest = config?.tshock ? tshockConfig(config) : config;
    try {
      assertLoopback(rest.host);
      if (!rest.enabled || !rest.token || !Number.isInteger(rest.port) || rest.port < 1 || rest.port > 65535) {
        throw new TShockError('disabled', 'not_configured', 'TShock REST is not configured.', 409);
      }
      if (!/^\/[a-z0-9/_-]*$/i.test(endpoint)) {
        throw new TShockError('unavailable', 'invalid_endpoint', 'Invalid TShock REST endpoint.', 400);
      }
      const url = new URL(`http://127.0.0.1:${rest.port}${endpoint}`);
      url.searchParams.set('token', rest.token);
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new TShockError(timeout ? 'timeout' : 'unavailable', timeout ? 'request_timeout' : 'connection_failed',
          timeout ? 'TShock REST timed out.' : 'TShock REST is unavailable.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new TShockError('unauthorized', 'authentication_failed', 'TShock REST rejected authentication.', 401);
      }
      if (!response.ok) throw new TShockError('unavailable', `http_${response.status}`, 'TShock REST request failed.');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new TShockError('malformed', 'response_too_large', 'TShock REST response is too large.');
      }
      let result = {};
      try { result = text ? JSON.parse(text) : {}; }
      catch { throw new TShockError('malformed', 'invalid_json', 'TShock REST returned invalid JSON.'); }
      if (result && Number(result.status) >= 400) {
        throw new TShockError(Number(result.status) === 403 ? 'unauthorized' : 'unavailable',
          `tshock_${result.status}`, clean(result.error) || 'TShock REST rejected the request.');
      }
      currentHealth = { state: 'healthy', code: null, lastOkAt: new Date().toISOString(), lastErrorAt: currentHealth.lastErrorAt };
      return result;
    } catch (error) {
      const safe = error instanceof TShockError ? error : new TShockError('unavailable', 'request_failed', 'TShock REST is unavailable.');
      currentHealth = { state: safe.state, code: safe.code, lastOkAt: currentHealth.lastOkAt, lastErrorAt: new Date().toISOString() };
      throw safe;
    }
  }

  return { request, health: () => ({ ...currentHealth }), version: ADAPTER_VERSION };
}

function databasePath(desc = {}) {
  const root = path.resolve(String(desc.dir || desc.cwd || '.'));
  const configured = clean(desc.tshock?.database);
  const candidate = path.resolve(root, configured || 'tshock.sqlite');
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new TShockError('misconfigured', 'database_outside_server', 'TShock database must be inside the server folder.', 400);
  }
  return candidate;
}

function openDatabase(desc, { write = false } = {}) {
  const file = databasePath(desc);
  if (!fs.existsSync(file)) throw new TShockError('unavailable', 'database_missing', 'TShock database was not found.', 404);
  if (write && fs.existsSync(`${file}-wal`)) {
    throw new TShockError('unavailable', 'database_live', 'Offline changes are unavailable while the TShock database has a live WAL.', 409);
  }
  try { return new Database(file, { readonly: !write, fileMustExist: true, timeout: 250 }); }
  catch { throw new TShockError('unavailable', 'database_locked', 'TShock database is locked.', 409); }
}

function withDatabase(desc, fn, options) {
  const db = openDatabase(desc, options);
  try { return fn(db); } finally { db.close(); }
}

function rows(db, sql) {
  try { return db.prepare(sql).all(); } catch (_) { return []; }
}

function splitPermissions(value) {
  return [...new Set(String(value || '').split(/[, ]+/).map((item) => item.trim()).filter(Boolean))].sort();
}

function sourceItems(items, source) {
  return items.map((item) => ({ ...item, source }));
}

function offlinePlayers() {
  throw new TShockError('unavailable', 'server_offline', 'Live players are unavailable while the server is offline.', 409);
}

function listPlayers(desc, options = {}) {
  if (options.online === false) return offlinePlayers();
  const roster = options.manager?.module?.listPlayers?.(options.manager)
    || options.manager?.moduleState?.players
    || [];
  const values = roster instanceof Set ? [...roster] : roster;
  return sourceItems(values.map((entry, index) => ({
    name: clean(entry?.name) || String(entry),
    account: clean(entry?.account),
    group: clean(entry?.group),
    index: Number.isInteger(entry?.index) ? entry.index : index,
    muted: Boolean(entry?.muted),
  })), 'console');
}

function listAccounts(desc) {
  return sourceItems(withDatabase(desc, (db) => rows(db,
    'SELECT Username AS name, Usergroup AS userGroup, LastAccessed AS lastLogin, Registered AS registeredAt FROM Users',
  ).map((row) => ({
    name: clean(row.name), group: clean(row.userGroup), lastLogin: row.lastLogin || null, registeredAt: row.registeredAt || null,
  }))), 'database');
}

function listGroups(desc) {
  return sourceItems(withDatabase(desc, (db) => rows(db,
    'SELECT GroupName AS name, Parent AS parent, Commands AS permissions, ChatColor AS chatColor, Prefix AS prefix, Suffix AS suffix FROM GroupList',
  ).map((row) => ({
    name: clean(row.name), parent: clean(row.parent), permissions: splitPermissions(row.permissions),
    chatColor: clean(row.chatColor), prefix: clean(row.prefix), suffix: clean(row.suffix),
  }))), 'database');
}

function listBans(desc) {
  return sourceItems(withDatabase(desc, (db) => rows(db,
    "SELECT COALESCE(NULLIF(Name, ''), NULLIF(UUID, ''), ID) AS identifier, Reason AS reason, Expiration AS expiration, BanningUser AS bannedBy FROM Bans",
  ).map((row) => ({
    identifier: String(row.identifier), reason: clean(row.reason), expiration: row.expiration || null, bannedBy: clean(row.bannedBy),
  }))), 'database');
}

function permissionCatalogue(desc, options = {}) {
  const known = new Set();
  for (const group of listGroups(desc)) for (const permission of group.permissions) known.add(permission);
  for (const permission of options.remembered || desc.tshock?.knownPermissions || []) if (clean(permission)) known.add(permission.trim());
  return [...known].sort().map((name) => ({ name, source: 'assigned', recognized: true }));
}

function validateName(value, label = 'Name') {
  const result = clean(value);
  if (!result || !SAFE_NAME.test(result)) throw new TShockError('invalid', 'invalid_name', `${label} is invalid.`, 400);
  return result;
}

function consoleText(value, label, limit = 512) {
  const result = clean(value);
  if (!result) return null;
  if (result.length > limit || /["\\\u0000-\u001f\u007f]/.test(result)) {
    throw new TShockError('invalid', 'invalid_text', `${label} is invalid.`, 400);
  }
  return result;
}

function effectivePermissions(groups, name, visiting = new Set()) {
  if (visiting.has(name)) throw new TShockError('invalid', 'parent_cycle', 'A group cannot inherit from itself.', 400);
  const group = groups.find((entry) => entry.name === name);
  if (!group) return [];
  visiting.add(name);
  const inherited = group.parent ? effectivePermissions(groups, group.parent, visiting) : [];
  visiting.delete(name);
  return [...new Set([...inherited, ...group.permissions])].sort();
}

function previewGroup(desc, payload, actorAccount = null) {
  const groups = listGroups(desc);
  const name = validateName(payload?.name, 'Group name');
  const previous = groups.find((group) => group.name === name) || null;
  const next = {
    name,
    parent: clean(payload?.parent),
    permissions: [...new Set((payload?.permissions || []).map((item) => validateName(item, 'Permission')))].sort(),
  };
  const simulated = groups.filter((group) => group.name !== name).concat(next);
  effectivePermissions(simulated, name);
  const before = previous?.permissions || [];
  const added = next.permissions.filter((permission) => !before.includes(permission));
  const removed = before.filter((permission) => !next.permissions.includes(permission));
  const selfLockout = actorAccount?.group === name && removed.some((permission) => ADMIN_PERMISSIONS.test(permission));
  return {
    source: 'database',
    name,
    before: previous,
    after: next,
    added,
    removed,
    parentChanged: (previous?.parent || null) !== next.parent,
    selfLockout,
    unknownPermissions: next.permissions.filter((permission) => !permissionCatalogue(desc).some((known) => known.name === permission)),
  };
}

function snapshotDatabase(desc) {
  const file = databasePath(desc);
  const directory = path.join(path.dirname(file), '.fleetdeck-snapshots');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `tshock-${Date.now()}.sqlite`);
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  return path.basename(target);
}

function groupAction(desc, action, payload, options = {}) {
  if (options.online !== false) throw new TShockError('unavailable', 'rest_mutation_unavailable', 'This group change requires the server to be offline.', 409);
  const name = validateName(payload?.name, 'Group name');
  const groups = listGroups(desc);
  if (action === 'delete') {
    if (['guest', 'default'].includes(name.toLowerCase())) throw new TShockError('invalid', 'protected_group', 'The default or guest group cannot be deleted.', 409);
    const members = listAccounts(desc).filter((account) => account.group === name);
    if (members.length) throw new TShockError('invalid', 'group_has_members', `${members.length} account(s) still use this group.`, 409);
  }
  const preview = action === 'delete' ? null : previewGroup(desc, payload, options.actorAccount);
  if (preview?.selfLockout && options.confirmSelfLockout !== true) {
    throw new TShockError('invalid', 'self_lockout_confirmation_required', 'This change can remove your own administrative access.', 409);
  }
  const snapshot = snapshotDatabase(desc);
  return withDatabase(desc, (db) => db.transaction(() => {
    if (action === 'delete') db.prepare('DELETE FROM GroupList WHERE GroupName = ?').run(name);
    else {
      const permissions = preview.after.permissions.join(',');
      const existing = groups.some((group) => group.name === name);
      if (existing) db.prepare('UPDATE GroupList SET Parent = ?, Commands = ? WHERE GroupName = ?').run(preview.after.parent || '', permissions, name);
      else db.prepare('INSERT INTO GroupList (GroupName, Parent, Commands, ChatColor, Prefix, Suffix) VALUES (?, ?, ?, ?, ?, ?)').run(
        name, preview.after.parent || '', permissions, payload.chatColor || '255,255,255', payload.prefix || '', payload.suffix || '',
      );
    }
    return { ok: true, source: 'database', snapshot, preview };
  })(), { write: true });
}

function accountAction(desc, action, payload, options = {}) {
  const name = validateName(payload?.name, 'Account name');
  const manager = options.manager;
  if (options.online !== false && manager?.sendCommand) {
    let command;
    if (action === 'create') command = `user add "${name}" "${validateName(payload.password, 'Password')}" "${validateName(payload.group || 'default', 'Group')}"`;
    else if (action === 'delete') command = `user del "${name}"`;
    else if (action === 'setGroup') command = `user group "${name}" "${validateName(payload.group, 'Group')}"`;
    else if (action === 'setPassword') command = `user password "${name}" "${validateName(payload.password, 'Password')}"`;
    else throw new TShockError('invalid', 'invalid_action', 'Unsupported account action.', 400);
    manager.sendCommand(command, true);
    return { ok: true, source: 'console', passwordChanged: action === 'setPassword' || action === 'create' };
  }
  throw new TShockError('unavailable', 'offline_account_mutation_unavailable', 'Account changes require the TShock server to be online.', 409);
}

function playerAction(desc, action, target, options = {}) {
  const manager = options.manager;
  if (!manager?.sendCommand || options.online === false) throw new TShockError('unavailable', 'server_offline', 'Player actions require the server to be online.', 409);
  const name = validateName(target, 'Player');
  const reason = consoleText(options.reason, 'Reason');
  const duration = consoleText(options.duration, 'Duration', 32);
  let command;
  if (action === 'kick') command = `kick "${name}"${reason ? ` "${reason}"` : ''}`;
  else if (action === 'ban') command = `ban add "${name}"${duration ? ` ${duration}` : ''}${reason ? ` "${reason}"` : ''}`;
  else if (action === 'unban') command = `ban del "${name}"`;
  else if (action === 'mute') command = `mute "${name}"`;
  else if (action === 'unmute') command = `unmute "${name}"`;
  else if (action === 'whisper') command = `whisper "${name}" "${validateName(options.message, 'Message')}"`;
  else throw new TShockError('invalid', 'invalid_action', 'Unsupported player action.', 400);
  manager.sendCommand(command, true);
  return { ok: true, source: 'console' };
}

module.exports = {
  ADAPTER_VERSION,
  TShockError,
  createAdapter,
  initialHealth,
  tshockConfig,
  assertLoopback,
  databasePath,
  listPlayers,
  playerAction,
  listAccounts,
  accountAction,
  listGroups,
  groupAction,
  listBans,
  permissionCatalogue,
  previewGroup,
  effectivePermissions,
  splitPermissions,
};
