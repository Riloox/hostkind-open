'use strict';

/*
 * GET    /api/me                      - current user + permissions
 * PUT    /api/me                      - self-service profile edit
 * PUT    /api/me/password             - self-service password change
 * PUT    /api/me/language             - manual language switch
 * PUT    /api/me/terms                - accept a version of the Terms of Use
 * GET    /api/users                   - list users
 * GET    /api/users/:id/permissions   - read one user's grants
 * PUT    /api/users/:id/permissions   - replace one user's grants
 * POST   /api/users                   - create a user
 * PUT    /api/users/:id               - edit a user
 * DELETE /api/users/:id               - delete a user
 * GET    /api/api-keys                - list machine principals
 * POST   /api/api-keys                - mint a machine principal
 * GET    /api/api-keys/:id/permissions - read one key's grants
 * PUT    /api/api-keys/:id/permissions - replace one key's grants
 * DELETE /api/api-keys/:id            - revoke a key
 *
 * Mounted at /api, so router paths are relative (e.g. '/me', '/users').
 * Registration order matches the original inline block in server.js.
 * Auth and capability gates are unchanged: the shared /api auth middleware
 * and the USERS_MANAGE capability gate run before this router, and the
 * requireHuman gate on key management travels with the key routes.
 */

const express = require('express');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

// Username rules: 1-32 chars, no leading/trailing whitespace, no '@' (so
// usernames can't be confused with emails on login). Letters, digits,
// dot, dash, underscore are fine.
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;

// Terms versions are release dates: YYYY-MM-DD.
const TERMS_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateIdentifier({ email, username }) {
  const e = email === undefined ? undefined : normalizeEmail(email);
  const u = username === undefined ? undefined : normalizeUsername(username);
  if (e === undefined || e === '') {
    // only fail if the caller tried to set email and it's malformed
  } else if (!e.includes('@')) {
    return { error: 'emailInvalid' };
  }
  if (u !== undefined && u !== '' && !USERNAME_RE.test(u)) {
    return { error: 'usernameInvalid' };
  }
  return { email: e, username: u };
}

function normalizeRole(role) {
  return role === 'operator' ? 'operator' : role === 'admin' ? 'admin' : null;
}

module.exports = function usersRouter({
  getConfig,
  saveConfig,
  apiKeys,
  foundationCapabilities,
  foundationAudit,
  publicUser,
  publicPermissions,
  publicKeyPermissions,
  requireHuman,
  tErr,
  httpError,
  findUser,
  findUserByEmail,
  findUserByUsername,
  adminCount,
  genId,
  isGuestUser,
  verifyPassword,
  hashPassword,
  passwordIssue,
  MIN_PASSWORD_LENGTH,
  i18n,
  log,
}) {
  const router = express.Router();

  router.get('/me', (req, res) => res.json({ ...publicUser(req.user), permissions: publicPermissions(req.user) }));

  // Self-service profile edit. A user can change their own name, email, and
  // username, but never their own role (that would let an operator promote
  // themselves) and never another account.
  router.put('/me', (req, res) => {
    const user = req.user;
    if (isGuestUser(user)) return res.status(400).json({ error: tErr(user, 'errors.guestAccount') });
    const { email, username, name } = req.body || {};
    if (email !== undefined) {
      const e = normalizeEmail(email);
      if (e && !e.includes('@')) return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
      if (e) {
        const clash = findUserByEmail(e);
        if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
      }
      user.email = e;
    }
    if (username !== undefined) {
      const u = normalizeUsername(username);
      if (u && !USERNAME_RE.test(u)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
      if (u) {
        const clash = findUserByUsername(u);
        if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
      }
      user.username = u;
    }
    if (!user.email && !user.username) {
      return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
    }
    if (name !== undefined) user.name = String(name || '').trim();
    saveConfig(getConfig());
    res.json({ user: publicUser(user) });
  });

  // Self-service password change. Requires the current password, so a hijacked
  // session (or a shoulder-surfer) can't silently swap it.
  router.put('/me/password', (req, res) => {
    const user = req.user;
    if (isGuestUser(user)) return res.status(400).json({ error: tErr(user, 'errors.guestAccount') });
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(400).json({ error: tErr(req.user, 'errors.currentPasswordWrong') });
    }
    const pwIssue = passwordIssue(newPassword);
    if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
    user.passwordHash = hashPassword(newPassword);
    saveConfig(getConfig());
    res.json({ ok: true });
  });

  // Manual language switch. The user can change it any time from the header.
  router.put('/me/language', (req, res) => {
    if (isGuestUser(req.user)) return res.status(400).json({ error: tErr(req.user, 'errors.guestAccount') });
    const next = i18n.normalizeLang((req.body || {}).language);
    if (!i18n.SUPPORTED_LANGS.includes(next)) {
      return res.status(400).json({ error: tErr(req.user, 'errors.langInvalid') });
    }
    if (req.user.language !== next) {
      req.user.language = next;
      saveConfig(getConfig());
    }
    res.json({ user: publicUser(req.user) });
  });

  // Terms of Use acceptance. The version is the date string from
  // src/lib/terms.js; the client asks again whenever it no longer matches.
  router.put('/me/terms', (req, res) => {
    const version = String((req.body || {}).version || '');
    if (!TERMS_VERSION_RE.test(version)) return res.status(400).json({ error: tErr(req.user, 'errors.termsVersionInvalid') });
    const acceptedAt = new Date().toISOString();
    if (isGuestUser(req.user)) {
      getConfig().guestTermsAccepted = { version, acceptedAt };
    } else {
      req.user.termsAcceptedVersion = version;
      req.user.termsAcceptedAt = acceptedAt;
    }
    saveConfig(getConfig());
    try {
      foundationAudit.record({
        actorId: req.user.id, actorUsername: req.user.username,
        action: 'terms.accept', outcome: 'success', requestId: req.requestId, metadata: { version },
      });
    } catch (err) { log('audit: terms acceptance capture failed:', err.message); }
    res.json({ user: publicUser(req.user) });
  });

  router.get('/users', (req, res) => {
    res.json({ users: (getConfig().users || []).map((user) => ({ ...publicUser(user), permissions: publicPermissions(user) })) });
  });

  router.get('/users/:id/permissions', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
    res.json({
      permissions: publicPermissions(user),
      capabilities: {
        perServer: foundationCapabilities.perServerCapabilities(),
        global: foundationCapabilities.globalCapabilities(),
      },
    });
  });

  router.put('/users/:id/permissions', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
    if (user.role === 'admin') return res.status(400).json({ error: tErr(req.user, 'errors.adminPermissions') });
    try {
      const grants = foundationCapabilities.replaceForUser(user.id, req.body?.grants, req.user.id);
      res.json({ ok: true, permissions: { admin: false, grants: grants.map((grant) => ({ serverId: grant.server_id, capability: grant.capability })) } });
    } catch (err) {
      httpError(res, req, err, 400);
    }
  });

  router.post('/users', (req, res) => {
    const config = getConfig();
    const { email, username, name, password, role } = req.body || {};
    const v = validateIdentifier({ email, username });
    if (v.error === 'emailInvalid') return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
    if (v.error === 'usernameInvalid') return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
    if (!v.email && !v.username) return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
    const pwIssue = passwordIssue(password);
    if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
    if (v.email && findUserByEmail(v.email)) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
    if (v.username && findUserByUsername(v.username)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
    // New accounts default to operator (least privilege); an admin can grant the
    // admin role explicitly.
    const newRole = normalizeRole(role) || 'operator';
    const user = {
      id: genId(),
      email: v.email || '',
      username: v.username || '',
      name: String(name || '').trim(),
      role: newRole,
      passwordHash: hashPassword(password),
    };
    config.users.push(user);
    saveConfig(config);
    res.json({ user: publicUser(user) });
  });

  router.put('/users/:id', (req, res) => {
    const config = getConfig();
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
    const { email, username, name, password, role } = req.body || {};
    if (role !== undefined) {
      const r = normalizeRole(role);
      if (!r) return res.status(400).json({ error: tErr(req.user, 'errors.roleInvalid') });
      // Don't allow demoting the last remaining admin (would lock everyone out of
      // user management and global settings).
      if (user.role === 'admin' && r !== 'admin' && adminCount() <= 1) {
        return res.status(400).json({ error: tErr(req.user, 'errors.lastAdmin') });
      }
      user.role = r;
    }
    if (email !== undefined) {
      const e = normalizeEmail(email);
      if (e && !e.includes('@')) return res.status(400).json({ error: tErr(req.user, 'errors.emailInvalid') });
      if (e) {
        const clash = findUserByEmail(e);
        if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.emailTaken') });
      }
      user.email = e;
    }
    if (username !== undefined) {
      const u = normalizeUsername(username);
      if (u && !USERNAME_RE.test(u)) return res.status(400).json({ error: tErr(req.user, 'errors.usernameInvalid') });
      if (u) {
        const clash = findUserByUsername(u);
        if (clash && clash.id !== user.id) return res.status(400).json({ error: tErr(req.user, 'errors.usernameTaken') });
      }
      user.username = u;
    }
    // Make sure the user still has at least one way to log in.
    if (!user.email && !user.username) {
      return res.status(400).json({ error: tErr(req.user, 'errors.identifierRequired') });
    }
    if (name !== undefined) user.name = String(name || '').trim();
    if (password !== undefined && password !== '') {
      const pwIssue = passwordIssue(password);
      if (pwIssue) return res.status(400).json({ error: tErr(req.user, `errors.${pwIssue}`, { min: MIN_PASSWORD_LENGTH }) });
      user.passwordHash = hashPassword(password);
    }
    saveConfig(config);
    res.json({ user: publicUser(user) });
  });

  router.delete('/users/:id', (req, res) => {
    const config = getConfig();
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: tErr(req.user, 'errors.userNotFound') });
    if (config.users.length <= 1) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDeleteLastUser') });
    if (user.id === req.user.id) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDeleteSelf') });
    // Keep at least one admin alive.
    if (user.role === 'admin' && adminCount() <= 1) {
      return res.status(400).json({ error: tErr(req.user, 'errors.lastAdmin') });
    }
    config.users = config.users.filter((u) => u.id !== user.id);
    saveConfig(config);
    foundationCapabilities.deleteUserGrants(user.id);
    res.json({ ok: true });
  });

  // --- API keys ---------------------------------------------------------------
  // Machine principals for provisioning: a billing system creating a server when
  // an order is paid, and stopping it when it is not. All four routes are
  // requireHuman - see the comment there for why a key may not manage keys.

  router.get('/api-keys', requireHuman, (req, res) => {
    res.json({ keys: apiKeys.list(), roles: apiKeys.ROLES });
  });

  router.post('/api-keys', requireHuman, (req, res) => {
    const { name, role, expiresAt, grants } = req.body || {};
    if (!String(name || '').trim()) {
      return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyNameRequired') });
    }
    if (role !== undefined && !apiKeys.ROLES.includes(role)) {
      return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyRoleInvalid') });
    }
    // An expiry in the past would mint a key that is dead on arrival, which reads
    // as a silent failure to whoever pastes it into their billing system.
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyExpiryInvalid') });
    }

    let created;
    try {
      created = apiKeys.create({ name, role: role || 'operator', createdBy: req.user.id, expiresAt: expiresAt ?? null });
    } catch (err) {
      return httpError(res, req, err, 400);
    }

    // An operator-role key is useless without grants, so they are set in the same
    // request the key is created in - there is no window where a key exists with
    // permissions nobody chose.
    if (created.key.role !== 'admin' && Array.isArray(grants) && grants.length) {
      try {
        foundationCapabilities.replaceForUser(created.key.id, grants, req.user.id);
      } catch (err) {
        apiKeys.revoke(created.key.id, req.user.id);
        return httpError(res, req, err, 400);
      }
    }

    try {
      foundationAudit.record({
        actorId: req.user.id, actorUsername: req.user.username,
        action: 'apikey.create', targetType: 'api_key', targetId: created.key.id,
        outcome: 'success', metadata: { name: created.key.name, role: created.key.role },
      });
    } catch (err) { log('audit: api key creation capture failed:', err.message); }

    // The only time the plaintext exists outside the caller's memory.
    res.json({ key: created.key, token: created.token, permissions: publicKeyPermissions(created.key) });
  });

  router.get('/api-keys/:id/permissions', requireHuman, (req, res) => {
    const key = apiKeys.get(req.params.id);
    if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
    res.json({
      permissions: publicKeyPermissions(key),
      capabilities: {
        perServer: foundationCapabilities.perServerCapabilities(),
        global: foundationCapabilities.globalCapabilities(),
      },
    });
  });

  router.put('/api-keys/:id/permissions', requireHuman, (req, res) => {
    const key = apiKeys.get(req.params.id);
    if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
    if (key.revokedAt) return res.status(400).json({ error: tErr(req.user, 'errors.apiKeyRevoked') });
    if (key.role === 'admin') return res.status(400).json({ error: tErr(req.user, 'errors.adminPermissions') });
    try {
      foundationCapabilities.replaceForUser(key.id, req.body?.grants, req.user.id);
      res.json({ ok: true, permissions: publicKeyPermissions(apiKeys.get(key.id)) });
    } catch (err) {
      httpError(res, req, err, 400);
    }
  });

  router.delete('/api-keys/:id', requireHuman, (req, res) => {
    const key = apiKeys.get(req.params.id);
    if (!key) return res.status(404).json({ error: tErr(req.user, 'errors.apiKeyNotFound') });
    // Revoked rather than deleted: the row is what an audit trail dereferences
    // when it says which key did something six months ago.
    const revoked = apiKeys.revoke(key.id, req.user.id);
    if (revoked) {
      try {
        foundationAudit.record({
          actorId: req.user.id, actorUsername: req.user.username,
          action: 'apikey.revoke', targetType: 'api_key', targetId: key.id,
          outcome: 'success', metadata: { name: key.name },
        });
      } catch (err) { log('audit: api key revocation capture failed:', err.message); }
    }
    res.json({ ok: true, key: apiKeys.get(key.id) });
  });

  return router;
};
