'use strict';

/*
 * Capability-based authorization primitives.
 *
 * Spec contract (docs/roadmap/README.md "Authorization and audit"):
 *   - "Backend capability middleware is authoritative. Admins have
 *      unconditional access. Non-admins have only explicit
 *      (userId, serverId, capability) grants - no wildcards or inheritance."
 *   - "Migration grants every existing operator equivalent access to every
 *      existing server; new users and new servers receive no non-admin
 *      grants."
 *   - "User and server UUIDs remain external references; confirmed deletion
 *      cleans dependent rows transactionally."
 *
 * This module is the *table* layer + middleware; the higher-level
 * "user management" UX (listing, creating operators, etc.) is a separate
 * spec and lives elsewhere. The middleware here is what every mutating
 * route attaches to.
 *
 * serverId === null in a grant means "server-agnostic" - i.e. the capability
 * applies regardless of which server the request targets. Admins short-
 * circuit the grant lookup; every other request must match a row in
 * capability_grants exactly.
 */

const { open } = require('./db.cjs');

/*
 * The canonical capability list. Any new feature that needs a permission
 * adds its name here; tests and the migrations contract read this set.
 *
 * The values are short, stable identifiers that show up in audit logs and
 * API responses. They are intentionally not hierarchical (e.g. "files.read"
 * not "files/read") so we don't have to maintain a tree.
 */
const CAPABILITIES = Object.freeze({
  // Per-server capabilities (need a serverId).
  SERVER_VIEW:     'server.view',
  CONSOLE_VIEW:    'console.view',
  CONSOLE_MANAGE:  'console.manage',
  COMMANDS_RUN:    'commands.run',
  PLAYERS_VIEW:    'players.view',
  PLAYERS_MANAGE:  'players.manage',
  MAP_VIEW:        'map.view',
  MAP_MANAGE:      'map.manage',
  ANNOUNCEMENTS_SEND: 'announcements.send',
  FILES_VIEW:      'files.view',
  FILES_MANAGE:    'files.manage',
  CONFIGS_VIEW:    'configs.view',
  CONFIGS_EDIT:    'configs.edit',
  CONFIGS_RESTORE: 'configs.restore',
  CONFIGS_MANAGE:  'configs.manage',
  PLUGINS_MANAGE:  'plugins.manage',
  BACKUPS_MANAGE:  'backups.manage', // legacy umbrella grant
  BACKUPS_VIEW:    'backups.view',
  BACKUPS_CREATE:  'backups.create',
  BACKUPS_RESTORE: 'backups.restore',
  BACKUPS_DELETE:  'backups.delete',
  SERVER_CONTROL:  'server.control',
  SERVER_REGISTER: 'server.register',
  SCHEDULES_VIEW:  'schedules.view',
  SCHEDULES_MANAGE: 'schedules.manage',
  HEALTH_VIEW:     'health.view',
  HEALTH_MANAGE:   'health.manage',
  UPDATES_VIEW:    'updates.view',
  UPDATES_APPLY:   'updates.apply',
  UPDATES_POLICY:  'updates.policy',
  CONTENT_VIEW:    'content.view',
  CONTENT_INSTALL: 'content.install',
  SERVER_MANAGE:   'server.manage',
  WORLDS_VIEW:     'worlds.view',
  WORLDS_MANAGE:   'worlds.manage',
  WORLDS_PREGENERATE: 'worlds.pregenerate',
  // Server-agnostic capabilities (serverId === null in the grant).
  USERS_MANAGE:    'users.manage',
  FLEET_VIEW:      'fleet.view',
  AUDIT_VIEW:      'audit.view',
  AUDIT_EXPORT:    'audit.export',
  AUDIT_RETENTION: 'audit.retention',
});

/*
 * For convenience in migrations / migration grants: every per-server
 * capability above. Used by the operator-bulk-grant helper.
 */
function perServerCapabilities() {
  return [
    CAPABILITIES.SERVER_VIEW,
    CAPABILITIES.CONSOLE_VIEW,
    CAPABILITIES.CONSOLE_MANAGE,
    CAPABILITIES.COMMANDS_RUN,
    CAPABILITIES.PLAYERS_VIEW,
    CAPABILITIES.PLAYERS_MANAGE,
    CAPABILITIES.MAP_VIEW,
    CAPABILITIES.MAP_MANAGE,
    CAPABILITIES.ANNOUNCEMENTS_SEND,
    CAPABILITIES.FILES_VIEW,
    CAPABILITIES.FILES_MANAGE,
    CAPABILITIES.CONFIGS_VIEW,
    CAPABILITIES.CONFIGS_EDIT,
    CAPABILITIES.CONFIGS_RESTORE,
    CAPABILITIES.CONFIGS_MANAGE,
    CAPABILITIES.PLUGINS_MANAGE,
    CAPABILITIES.BACKUPS_MANAGE,
    CAPABILITIES.BACKUPS_VIEW,
    CAPABILITIES.BACKUPS_CREATE,
    CAPABILITIES.BACKUPS_RESTORE,
    CAPABILITIES.BACKUPS_DELETE,
    CAPABILITIES.SERVER_CONTROL,
    CAPABILITIES.SERVER_REGISTER,
    CAPABILITIES.SCHEDULES_VIEW,
    CAPABILITIES.SCHEDULES_MANAGE,
    CAPABILITIES.HEALTH_VIEW,
    CAPABILITIES.HEALTH_MANAGE,
    CAPABILITIES.UPDATES_VIEW,
    CAPABILITIES.UPDATES_APPLY,
    CAPABILITIES.UPDATES_POLICY,
    CAPABILITIES.CONTENT_VIEW,
    CAPABILITIES.CONTENT_INSTALL,
    CAPABILITIES.SERVER_MANAGE,
    CAPABILITIES.WORLDS_VIEW,
    CAPABILITIES.WORLDS_MANAGE,
    CAPABILITIES.WORLDS_PREGENERATE,
  ];
}

function globalCapabilities() {
  return [
    CAPABILITIES.USERS_MANAGE,
    CAPABILITIES.FLEET_VIEW,
    CAPABILITIES.AUDIT_VIEW,
    CAPABILITIES.AUDIT_EXPORT,
    CAPABILITIES.AUDIT_RETENTION,
  ];
}

function isKnown(capability) {
  return Object.values(CAPABILITIES).includes(capability);
}

function isGlobal(capability) {
  return globalCapabilities().includes(capability);
}

function grant(userId, serverId, capability, grantedBy = null) {
  if (!userId) throw new Error('capabilities.grant: userId required');
  if (!capability) throw new Error('capabilities.grant: capability required');
  if (serverId != null && typeof serverId !== 'string') {
    throw new Error('capabilities.grant: serverId must be null or string');
  }
  const db = open();
  db.prepare(`
    INSERT OR IGNORE INTO capability_grants (user_id, server_id, capability, granted_at, granted_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, serverId, capability, Date.now(), grantedBy);
}

function revoke(userId, serverId, capability) {
  const db = open();
  db.prepare(`
    DELETE FROM capability_grants
     WHERE user_id = ? AND (server_id = ? OR (server_id IS NULL AND ? IS NULL)) AND capability = ?
  `).run(userId, serverId, serverId, capability);
}

/*
 * Authoritative check. Admins always pass. Otherwise we look up a row that
 * matches (userId, serverId, capability) exactly. A NULL server is only for
 * a genuinely server-agnostic capability; it is never a wildcard.
 */
function has(user, serverId, capability) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const db = open();
  let row = db.prepare(`
    SELECT 1 FROM capability_grants
     WHERE user_id = ?
       AND capability = ?
       AND (server_id = ? OR (server_id IS NULL AND ? IS NULL))
     LIMIT 1
  `).get(user.id, capability, serverId || null, serverId || null);
  // Existing installations granted the pre-roadmap umbrella permission.
  if (!row && capability.startsWith('backups.')) {
    row = db.prepare(`SELECT 1 FROM capability_grants WHERE user_id=? AND server_id=? AND capability=? LIMIT 1`)
      .get(user.id, serverId || null, CAPABILITIES.BACKUPS_MANAGE);
  }
  // Schedules used to live under the server-control grant; installs that
  // predate the split keep working without a re-grant.
  if (!row && capability.startsWith('schedules.')) {
    row = db.prepare(`SELECT 1 FROM capability_grants WHERE user_id=? AND server_id=? AND capability=? LIMIT 1`)
      .get(user.id, serverId || null, CAPABILITIES.SERVER_CONTROL);
  }
  if (!row && (capability === CAPABILITIES.CONFIGS_EDIT || capability === CAPABILITIES.CONFIGS_RESTORE)) {
    row = db.prepare(`SELECT 1 FROM capability_grants WHERE user_id=? AND server_id=? AND capability=? LIMIT 1`)
      .get(user.id, serverId || null, CAPABILITIES.CONFIGS_MANAGE);
  }
  return !!row;
}

function listForUser(userId) {
  const db = open();
  return db.prepare(`
    SELECT user_id, server_id, capability, granted_at, granted_by
      FROM capability_grants
     WHERE user_id = ?
     ORDER BY server_id, capability
  `).all(userId);
}

/*
 * Whether `user` holds any per-server capability on `serverId`. This is the
 * gate the fleet list needs: an operator with even one grant anywhere still
 * gets a view onto the servers they actually manage, without ever implying a
 * registration capability. Admins and the guest identity always pass.
 */
function hasAnyPerServerGrant(user, serverId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!serverId) return false;
  const perServer = new Set(perServerCapabilities());
  const db = open();
  const rows = db.prepare('SELECT capability FROM capability_grants WHERE user_id = ? AND server_id = ?').all(user.id, serverId);
  return rows.some((row) => perServer.has(row.capability));
}

function replaceForUser(userId, grants, grantedBy = null) {
  if (!userId) throw new Error('capabilities.replaceForUser: userId required');
  if (!Array.isArray(grants)) throw new Error('capabilities.replaceForUser: grants must be an array');
  const normalized = grants.map((item) => {
    const capability = String(item?.capability || '');
    const serverId = item?.serverId == null ? null : String(item.serverId);
    if (!isKnown(capability)) throw new Error(`Unknown capability: ${capability}`);
    if (isGlobal(capability) !== (serverId === null)) {
      throw new Error(`Invalid scope for capability: ${capability}`);
    }
    return { capability, serverId };
  });
  const unique = [...new Map(normalized.map((item) => [`${item.serverId || ''}\0${item.capability}`, item])).values()];
  const db = open();
  db.transaction(() => {
    db.prepare('DELETE FROM capability_grants WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO capability_grants (user_id, server_id, capability, granted_at, granted_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const item of unique) insert.run(userId, item.serverId, item.capability, now, grantedBy);
  })();
  return listForUser(userId);
}

/*
 * Express middleware factory. Usage:
 *
 *   app.post('/api/...', requireCap(CAPABILITIES.SERVER_CONTROL), handler)
 *
 * Reads the user off req.user (set by the auth middleware earlier in the
 * chain). 403s with a redacted, plain-English error if the grant is missing.
 */
function requireCap(capability, { getServerId } = {}) {
  return function (req, res, next) {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    let serverId = null;
    if (typeof getServerId === 'function') {
      try { serverId = getServerId(req) || null; } catch { serverId = null; }
    } else {
      serverId = (req.query && req.query.serverId) || (req.body && req.body.serverId) || null;
    }
    if (!has(user, serverId, capability)) {
      return res.status(403).json({ error: 'forbidden', capability });
    }
    req.serverId = serverId;
    next();
  };
}

/*
 * Clean up dependent rows for a deleted user or server. Spec:
 *   "User and server UUIDs remain external references; confirmed deletion
 *    cleans dependent rows transactionally."
 */
function deleteUserGrants(userId) {
  const db = open();
  return db.prepare('DELETE FROM capability_grants WHERE user_id = ?').run(userId).changes;
}

function deleteServerGrants(serverId) {
  const db = open();
  return db.prepare('DELETE FROM capability_grants WHERE server_id = ?').run(serverId).changes;
}

module.exports = {
  CAPABILITIES,
  perServerCapabilities,
  globalCapabilities,
  isKnown,
  isGlobal,
  grant,
  revoke,
  has,
  listForUser,
  hasAnyPerServerGrant,
  replaceForUser,
  requireCap,
  deleteUserGrants,
  deleteServerGrants,
};
