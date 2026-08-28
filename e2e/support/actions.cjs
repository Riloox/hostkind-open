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

const { loginScreen, gamesHub, appShell } = require('./pages.cjs');
const { TOKEN_KEY } = require('./fixtures.cjs');

// The built bundle injects package.json's version as __APP_VERSION__
// (vite.config.js define). The changelog popup reopens for seen users whose
// stored `fleetdeck_changelog_version` differs from it, so signInFast must
// plant the same value or a fresh browser profile meets the popup anyway.
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
  await page.waitForURL(/\/games$/);
  await gamesHub(page).carousel.waitFor();
}

/**
 * Sign in over HTTP and plant the token, skipping the form. Also marks the
 * onboarding tour as seen for every game and plants the changelog version, so
 * a later navigation is not met by a modal the test did not come to look at -
 * neither the first-time tour nor the post-update changelog popup (which
 * reopens when the stored version differs from the build's).
 */
async function signInFast(page, panel, account = panel.admin) {
  const response = await page.request.post(`${panel.url}/api/login`, {
    data: { username: account.username, password: account.password },
  });
  if (!response.ok()) {
    throw new Error(`could not sign ${account.username} in: ${response.status()} ${await response.text()}`);
  }
  const { token, user } = await response.json();

  await page.addInitScript(([key, value, userId, changelogVersion]) => {
    try {
      window.localStorage.setItem(key, value);
      for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
        window.localStorage.setItem(`fleetdeck_tour_seen:${userId}:${game}`, '1');
      }
      // Plant the current version so the changelog popup never shows in specs
      // that just want to get to the UI.
      window.localStorage.setItem('fleetdeck_changelog_version', changelogVersion);
    } catch { /* ignore */ }
  }, [TOKEN_KEY, token, user.id, APP_VERSION]);

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
  await dismissTour(page);
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

/** Close the onboarding tour if it is up. Safe to call when it is not. */
async function dismissTour(page) {
  const tour = appShell(page).tour;
  if (await tour.isVisible()) {
    await page.keyboard.press('Escape');
    await tour.waitFor({ state: 'hidden' });
  }
}

/**
 * Leave the games hub for one game's workbench, dismissing the onboarding
 * tour that opens the first time a user enters it.
 */
async function enterGame(page, gameId) {
  // The hub is a carousel: clicking a slide that is not the current one only
  // brings it to the front. It takes a second click to actually enter, which
  // is why this clicks until the URL moves rather than once.
  const slide = gamesHub(page).game(gameId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await slide.click();
    try {
      await page.waitForURL(new RegExp(`/games/${gameId}/`), { timeout: 2_000 });
      break;
    } catch {
      if (attempt === 2) throw new Error(`could not enter ${gameId} from the hub`);
    }
  }
  await appShell(page).header.waitFor();
  await dismissTour(page);
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
  openView, enterGame, dismissTour, waitForLiveConnection,
  readToken, seedToken,
};
