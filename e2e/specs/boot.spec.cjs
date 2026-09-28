'use strict';

/*
 * What the panel does with the first paint: which screen a visitor gets,
 * where a URL puts them, what an old link resolves to, and which language
 * they are greeted in.
 */

const { test, expect, en, es } = require('../support/fixtures.cjs');
const { loginScreen, homeScreen, serverUrl, appShell, dialog, panelSettings } = require('../support/pages.cjs');
const { submitLogin, signIn, signInFast, enterGame } = require('../support/actions.cjs');
const seed = require('../support/seed.cjs');

test.describe('boot', () => {
  test('opens the list of servers on a bare URL when there are several', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });

    // Several servers, nothing chosen: every server side by side, not some
    // default one.
    await expect(page).toHaveURL(/\/$/);
    await expect(homeScreen(page).serverList).toBeVisible();
  });

  test('opens the only server straight away', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Solo' })] });
    await signInFast(page, panel);

    await page.goto(`${panel.url}/`);

    await expect(page).toHaveURL(serverUrl('', 'srv-solo'));
    await expect(appShell(page).header).toContainText('Solo');
    await expect(appShell(page).navItem('dashboard')).toHaveAttribute('data-active', 'true');
  });

  test('offers the games to start from when there are no servers', async ({ page, newApp }) => {
    const panel = await newApp({ servers: [] });
    await signInFast(page, panel);

    await page.goto(`${panel.url}/`);

    const home = homeScreen(page);
    await expect(home.firstServer).toBeVisible();
    for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
      await expect(home.gameChoice(game)).toHaveCount(1);
    }

    // Choosing a game asks how to add it, for a game that has more than one way.
    await home.gameChoice('minecraft').click();
    const flow = dialog(page, en('addServer.title'));
    await expect(flow.root).toBeVisible();
    // Install, an existing folder, a modpack, a template.
    await expect(flow.root.locator('[data-add-method]')).toHaveCount(4);
  });

  test('collapses an unknown path to home', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });

    await page.goto('/not-a-real-page');

    await expect(page).toHaveURL(/\/$/);
    await expect(homeScreen(page).serverList).toBeVisible();
  });

  test('rewrites an old game link onto that game\'s server', async ({ page, app }) => {
    await signInFast(page, app);

    await page.goto('/games/terraria/files');
    await expect(page).toHaveURL(serverUrl('settings/files', 'srv-hardmode'));

    // The old hub link resumes the server used last rather than asking again.
    await page.goto('/games');
    await expect(page).toHaveURL(serverUrl('', 'srv-hardmode'));

    // A redirect keeps the query it was given.
    await page.goto('/games/valheim/console?from=bookmark');
    await expect(page).toHaveURL(/\/servers\/srv-midgard\/console\?from=bookmark$/);
  });

  test('sends a link that names no server to the last server used', async ({ page, app }) => {
    await signIn(page, { identifier: app.admin.username, password: app.admin.password });
    await enterGame(page, 'valheim');
    await expect(page).toHaveURL(serverUrl('', 'srv-midgard'));

    // An old pre-hub link names a section but no server.
    await page.goto('/console');

    await expect(page).toHaveURL(serverUrl('console', 'srv-midgard'));
    await expect(appShell(page).header).toBeVisible();
  });

  test('opens Hostkind settings at /settings, and old panel links on their tab', async ({ page, app }) => {
    await signInFast(page, app);
    // With a server used last, /settings still means the panel's settings,
    // not that server's Settings section.
    await page.goto('/games/valheim/dashboard');
    await expect(page).toHaveURL(serverUrl('', 'srv-midgard'));

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(appShell(page).header).toContainText(en('nav.panelSettings', { name: en('brand.name') }));
    await expect(panelSettings(page).tab('preferences')).toHaveAttribute('data-state', 'active');

    for (const [from, tab] of [['/users', 'users'], ['/audit', 'audit'], ['/games/minecraft/users', 'users'], ['/games/terraria/audit', 'audit']]) {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(`/settings/${tab}$`));
      await expect(panelSettings(page).tab(tab)).toHaveAttribute('data-state', 'active');
    }

    // A server's own Settings stays under the server.
    await page.goto('/servers/srv-midgard/settings');
    await expect(page).toHaveURL(serverUrl('settings', 'srv-midgard'));
    await expect(appShell(page).navItem('settings')).toHaveAttribute('data-active', 'true');
  });

  test('sends a server that no longer exists home', async ({ page, app }) => {
    await signInFast(page, app);

    await page.goto('/servers/srv-gone/console');

    await expect(page).toHaveURL(/\/$/);
  });

  test('drops a deep link taken before sign-in', async ({ page, app }) => {
    await page.goto('/servers/srv-survival/files');

    // Signed out, any path is the sign-in screen.
    await expect(loginScreen(page).heading).toBeVisible();

    await submitLogin(page, { identifier: app.admin.username, password: app.admin.password });

    // Signing in hands over to home rather than the link that was asked for.
    // Worth knowing about: it is the current behaviour, not an accident of
    // this test.
    await expect(page).toHaveURL(/\/$/);
    await expect(homeScreen(page).serverList).toBeVisible();
  });

  test('skips sign-in entirely when the panel has it switched off', async ({ page, newApp }) => {
    const guestPanel = await newApp({ requireAuth: false });

    await page.goto(`${guestPanel.url}/`);

    // Straight into the panel, with no login screen flashing on the way.
    await expect(appShell(page).header).toBeVisible();
    await expect(loginScreen(page).heading).toBeHidden();

    await enterGame(page, 'minecraft');
    const shell = appShell(page);
    await shell.profileButton.click();

    // A guest has no session to end, so the menu offers no way out - only
    // settings.
    await expect(shell.menuSettings).toBeVisible();
    await expect(shell.menuLogout).toHaveCount(0);
    await expect(page.getByText(en('security.guestDesc'))).toBeVisible();
  });

  test.describe('pre-sign-in language', () => {
    // Let the panel choose the language instead of pinning English.
    test.use({ uiLanguage: null });

    test('follows the panel-wide DEFAULT_LANGUAGE', async ({ page, newApp }) => {
      const spanishPanel = await newApp({ env: { DEFAULT_LANGUAGE: 'es' } });

      await page.goto(`${spanishPanel.url}/`);

      await expect(page.getByRole('heading', { name: es('login.heading') })).toBeVisible();
      await expect(page.getByRole('button', { name: es('login.submit'), exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    });
  });
});
