'use strict';

/*
 * A small authenticated client for *arranging* state, never for asserting it.
 *
 * The rule these specs follow: arrange over HTTP, act and assert through the
 * browser. Clicking through six dialogs to reach the state a test is actually
 * about makes the test slow and makes it fail for reasons that have nothing to
 * do with what it covers - and the routes themselves are already covered by
 * the suites under test/.
 *
 *   const api = await client(panel);            // as the seeded admin
 *   await api.put(`/api/users/${id}/permissions`, { grants });
 */

/** Sign in and return a client bound to that session. */
async function client(panel, account = panel.admin) {
  const response = await fetch(`${panel.url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  if (!response.ok) {
    throw new Error(`could not sign ${account.username} in: ${response.status} ${await response.text()}`);
  }
  const { token, user } = await response.json();

  async function send(method, path, body, { raw = false } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    const fetchOptions = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
    const result = await fetch(`${panel.url}${path}`, fetchOptions);
    const text = await result.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (raw) return { ok: result.ok, status: result.status, body: parsed };
    if (!result.ok) {
      const message = (parsed && parsed.error) || text || result.statusText;
      throw new Error(`${method} ${path} -> ${result.status}: ${message}`);
    }
    return parsed;
  }

  return {
    token,
    user,
    get: (path, options) => send('GET', path, undefined, options),
    post: (path, body, options) => send('POST', path, body ?? {}, options),
    put: (path, body, options) => send('PUT', path, body ?? {}, options),
    del: (path, options) => send('DELETE', path, undefined, options),

    /**
     * Replace an account's capability grants. `serverId: null` makes a grant
     * global. Admins cannot be granted to - they already have everything.
     */
    async grant(userId, grants) {
      return send('PUT', `/api/users/${userId}/permissions`, { grants });
    },

    /** The id of a seeded account, looked up by username. */
    async userId(username) {
      const { users } = await send('GET', '/api/users');
      const found = users.find((candidate) => candidate.username === username);
      if (!found) throw new Error(`no user named ${username}`);
      return found.id;
    },
  };
}

module.exports = { client };
