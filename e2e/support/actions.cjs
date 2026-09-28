'use strict';

/*
 * Flows: the multi-step things a spec does *to get somewhere*, as opposed to
 * the thing it is actually testing. Locators live in pages.cjs.
 *
 * Signing in has two doors on purpose. `signIn` drives the real form and is
 * what the auth specs use. `signInFast` gets a token over HTTP and plants it,
 * which is what every other spec should use - it saves ~2s per test and keeps
 * an unrelated failure in the login form from failing the whole suite.
 */

const { loginScreen, appShell } = require('./pages.cjs');
const { TOKEN_KEY } = require('./fixtures.cjs');

// The built bundle injects package.json's version as __APP_VERSION__
// (vite.config.js define). The profile menu marks "What's new" unread when the
// stored `fleetdeck_changelog_version` differs from it, so signInFast plants
// the same value: a spec starts from "seen", and one about the mark changes it.
const APP_VERSION = require('../../package.json').version;

/** Fill in the login form and submit it. Does not wait for the result. */
async function submitLogin(page, { identifier, password }) {
  const login = loginScreen(page);
  await login.identifier.fill(identifier);
  await login.password.fill(password);
  await login.submit.click();
}

/**
 * Sign in through the form and wait until the app shell has taken over.
 * `origin` targets a panel other than the worker's (one from newApp()).
 */
async function signIn(page, { identifier, password, origin = '' } = {}) {
  await page.goto(`${origin}/`);
  await loginScreen(page).heading.waitFor();
  await submitLogin(page, { identifier, password });
  await appShell(page).header.waitFor();
}

/*
 * Sessions reused across the tests of one worker. The login route allows 30
 * requests per 15 minutes per IP, and every spec in a worker signs in to the
 * same shared panel, so logging in afresh each time runs into that limit on a
 * long run. A cached token is checked against /api/me before reuse (which is
 * not rate limited), so a revoked or rotated session still falls back to a real
 * login. Panels from newApp() have their own URL and never share an entry.
 */
const sessions = new Map();

async function sessionFor(page, panel, account) {
  const key = `${panel.url}|${account.username}`;
  const cached = sessions.get(key);
  if (cached) {
    const me = await page.request.get(`${panel.url}/api/me`, { headers: { Authorization: `Bearer ${cached.token}` } });
    if (me.ok()) return cached;
    sessions.delete(key);
  }
  const response = await page.request.post(`${panel.url}/api/login`, {
    data: { username: account.username, password: account.password },
  });
  if (!response.ok()) {
    throw new Error(`could not sign ${account.username} in: ${response.status()} ${await response.text()}`);
  }
  const session = await response.json();
  sessions.set(key, { token: session.token, user: session.user });
  return session;
}

/**
 * Sign in over HTTP and plant the token, skipping the form. Also plants the
 * changelog version, so "What's new" starts out read.
 */
async function signInFast(page, panel, account = panel.admin) {
  const { token, user } = await sessionFor(page, panel, account);

  await page.addInitScript(([key, value, changelogVersion]) => {
    try {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem('fleetdeck_changelog_version', changelogVersion);
    } catch { /* ignore */ }
  }, [TOKEN_KEY, token, APP_VERSION]);

  return { token, user };
}

/**
 * Open one view directly by URL, e.g. openView(page, 'minecraft', 'files').
 * Waits for the shell rather than the view, so a spec can assert for itself
 * where a guard actually landed it.
 */
async function openView(page, game, view, { origin = '' } = {}) {
  await page.goto(`${origin}/games/${game}/${view}`);
  await appShell(page).header.waitFor();
}

/**
 * Wait until the shell's WebSocket is up.
 *
 * Status changes only reach the browser over that socket. A start clicked
 * before it connects still runs, but the frames announcing "starting" and
 * "online" are missed, and the row sits at "offline" until something refetches.
 * The panel shows a reconnecting banner while the socket is down, so its
 * absence is the signal. Anything that drives a server lifecycle should wait
 * for this first - without it the test is racing the connection, which is what
 * makes it fail only on a loaded machine.
 */
async function waitForLiveConnection(page) {
  const { en } = require('./fixtures.cjs');
  await page.getByText(en('common.reconnecting')).waitFor({ state: 'hidden' }).catch(() => {});
}

/**
 * Open the overview of a server of one game. Goes through the old game-scoped
 * link, which the panel rewrites onto that game's server.
 */
async function enterGame(page, gameId) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/games/${gameId}/dashboard`);
  await page.waitForURL(/\/servers\/[^/]+$/);
  await appShell(page).header.waitFor();
}

/**
 * Open one server's Settings -> General, where it is edited, cloned, removed
 * and (Palworld) its tools are opened. `panel` is the app fixture the server
 * was seeded into.
 */
async function openGeneralSettings(page, panel, name) {
  await page.goto(`${panel.url}/servers/${panel.server(name).id}/settings/general`);
  await appShell(page).header.waitFor();
}

// Mirrors METHODS in src/views/servers/AddServerDialogs.jsx: a game with a
// single way to add it skips the method step.
const ADD_METHODS = {
  minecraft: ['install', 'existing', 'modpack', 'template'],
  terraria: ['install', 'import'],
  valheim: ['install'],
  palworld: ['install', 'existing', 'importProfile'],
  custom: ['install'],
};

/**
 * Start the Add-server flow for one game and pick how, leaving the game's own
 * wizard or import dialog open. On a panel with no servers the game cards are
 * already on the page; anywhere else "Add server" opens them.
 */
async function startAddServer(page, game, method = 'install') {
  const { en } = require('./fixtures.cjs');
  const addButton = page.getByRole('button', { name: en('addServer.button'), exact: true }).first();
  const inlineChoice = page.locator(`main [data-game-choice="${game}"]`);
  await addButton.or(inlineChoice).first().waitFor();
  if (await addButton.isVisible()) await addButton.click();
  await page.locator(`[role="dialog"] [data-game-choice="${game}"], main [data-game-choice="${game}"]`).first().click();
  if ((ADD_METHODS[game] || ['install']).length > 1) {
    await page.locator(`[data-add-method="${method}"]`).click();
  }
}

/**
 * Expand a create wizard's "More options", where the optional fields live
 * (seed, parent folder, ...). Leaves it open if it already is.
 */
async function openMoreOptions(root) {
  const { en } = require('./fixtures.cjs');
  const details = root.locator('details').filter({ has: root.page().locator('summary', { hasText: en('serverRules.moreOptions') }) });
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
}

/** The session token as the browser has it, or null. */
function readToken(page) {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
}

/** Plant a session token before the app boots. */
function seedToken(page, token) {
  return page.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  }, [TOKEN_KEY, token]);
}

module.exports = {
  submitLogin, signIn, signInFast,
  openView, enterGame, openGeneralSettings, startAddServer, openMoreOptions, waitForLiveConnection,
  readToken, seedToken,
};
