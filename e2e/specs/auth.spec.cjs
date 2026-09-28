'use strict';

/*
 * Signing in, failing to sign in, and signing out - through the browser.
 *
 * Tests that move panel-wide state take their own panel via newApp(): the
 * login rate limiter lives in the server process's memory, so a lockout in a
 * shared panel would follow every later test in that worker.
 */

const jwt = require('jsonwebtoken');
const { test, expect, en } = require('../support/fixtures.cjs');
const { loginScreen, homeScreen, appShell } = require('../support/pages.cjs');
const { submitLogin, signIn, enterGame, readToken, seedToken } = require('../support/actions.cjs');

test.describe('sign-in', () => {
  test('presents the sign-in screen and what it can vouch for', async ({ page }) => {
    await page.goto('/');

    const login = loginScreen(page);
    await expect(login.heading).toBeVisible();
    await expect(login.subheading).toBeVisible();
    await expect(login.identifier).toBeFocused();
    await expect(login.submit).toBeEnabled();

    // The pre-auth plate reports the origin the browser is actually on. Tests
    // run over loopback, which the panel calls out as a safe link.
    await expect(login.plate).toContainText(en('login.metaNode'));
    await expect(login.plate).toContainText(en('login.linkLoopback'));

    // Nothing is stored until someone actually signs in.
    expect(await readToken(page)).toBeNull();
  });

  test('signs in with a username and lands on home', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });

    await expect(page).toHaveURL(/\/$/);
    await expect(homeScreen(page).serverList).toBeVisible();
    await expect(loginScreen(page).heading).toBeHidden();
    expect(await readToken(page)).toBeTruthy();
  });

  test('signs in with an email address too', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.email, password: app.admin.password });

    await expect(homeScreen(page).serverList).toBeVisible();
    expect(await readToken(page)).toBeTruthy();
  });

  test('refuses a wrong password and stores nothing', async ({ page, app }) => {
    await page.goto('/');
    await submitLogin(page, { identifier: app.admin.username, password: 'not-the-password' });

    const login = loginScreen(page);
    await expect(login.error).toHaveText(en('errors.wrongCredentials'));
    await expect(login.heading).toBeVisible();
    await expect(login.submit).toBeEnabled();
    expect(await readToken(page)).toBeNull();
  });

  test('says the same thing about an account that does not exist', async ({ page }) => {
    await page.goto('/');
    await submitLogin(page, { identifier: 'nobody-here', password: 'whatever-it-is' });

    // Identical to the wrong-password message: the screen must not reveal
    // which half of the pair was wrong.
    await expect(loginScreen(page).error).toHaveText(en('errors.wrongCredentials'));
  });

  test('reveals and re-hides the password on request', async ({ page }) => {
    await page.goto('/');
    const login = loginScreen(page);
    await login.password.fill('E2Epassw0rd!');

    await expect(login.password).toHaveAttribute('type', 'password');
    await login.revealPassword.click();
    await expect(login.password).toHaveAttribute('type', 'text');
    await expect(login.password).toHaveValue('E2Epassw0rd!');

    await login.hidePassword.click();
    await expect(login.password).toHaveAttribute('type', 'password');
  });

  test('locks the account out after repeated failures', async ({ page, newApp }) => {
    // Own panel: the lockout counter is process-wide and would outlive this test.
    const panel = await newApp();
    await page.goto(`${panel.url}/`);

    const login = loginScreen(page);
    // The fifth failure for one identifier arms the lock (LOGIN_MAX_ATTEMPTS).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submitLogin(page, { identifier: panel.admin.username, password: `wrong-${attempt}` });
      await expect(login.error).toBeVisible();
    }

    // The next attempt is refused before the password is even considered - so
    // the *right* password gets the lockout notice too.
    await submitLogin(page, { identifier: panel.admin.username, password: panel.admin.password });
    // The lock runs for 15 minutes, so that is what the notice counts down from.
    await expect(login.error).toHaveText(en('errors.tooManyAttempts', { minutes: 15 }));
    await expect(login.heading).toBeVisible();
    expect(await readToken(page)).toBeNull();
  });
});

test.describe('session', () => {
  test('survives a reload', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });
    const token = await readToken(page);

    await page.reload();

    await expect(homeScreen(page).serverList).toBeVisible();
    await expect(loginScreen(page).heading).toBeHidden();
    expect(await readToken(page)).toBe(token);
  });

  test('sends an expired token back to the sign-in screen', async ({ page, app }) => {
    const config = app.readConfig();
    const user = config.users.find((candidate) => candidate.username === app.admin.username);
    // Signed with the panel's real secret, but already past its expiry - the
    // app rejects it locally, without a round trip.
    const expired = jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: '-1h' });

    await seedToken(page, expired);
    await page.goto('/');

    await expect(loginScreen(page).heading).toBeVisible();
    await expect(appShell(page).header).toBeHidden();
  });

  test('ends the session when the panel stops accepting the token', async ({ page }) => {
    // Structurally valid and unexpired, but signed with the wrong secret: the
    // app boots on it, then the first API call comes back 401.
    const foreign = jwt.sign({ sub: 'someone-else', email: 'ghost@fleetdeck.test' }, 'a-different-secret', { expiresIn: '1h' });

    await seedToken(page, foreign);
    await page.goto('/');

    await expect(loginScreen(page).heading).toBeVisible();
    expect(await readToken(page)).toBeNull();
  });

  test('signs out from the header menu', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });
    await enterGame(page, 'minecraft');

    const shell = appShell(page);
    await expect(shell.profileButton).toContainText(app.admin.name);
    await shell.profileButton.click();
    await shell.menuLogout.click();

    await expect(loginScreen(page).heading).toBeVisible();
    expect(await readToken(page)).toBeNull();

    // And the session is really gone: reloading does not restore it.
    await page.reload();
    await expect(loginScreen(page).heading).toBeVisible();
  });
});
