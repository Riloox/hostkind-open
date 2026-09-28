'use strict';

/*
 * The shell every game shares - sidebar, header, profile menu, settings - and the
 * rule that decides which sections a given game is even offered.
 *
 * The gating table is the interesting part: each module declares what it can
 * do (its manager under lib/modules), and App.jsx turns that into which views
 * a server may open. These tests hold that mapping in place from the outside.
 */

const { test, expect, en, es } = require('../support/fixtures.cjs');
const { appShell, serverControls, toasts, dialog, homeScreen, serverUrl, serverRow, panelSettings } = require('../support/pages.cjs');
const { signIn, signInFast, openView, enterGame, waitForLiveConnection, seedToken } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');
const seed = require('../support/seed.cjs');
const net = require('net');

const APP_VERSION = require('../../package.json').version;

/** A free localhost port for the fake Palworld REST API of a runnable fixture. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test.describe('home', () => {
  test('lists every server, whatever its game', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/');

    await expect(homeScreen(page).serverList).toBeVisible();
    for (const name of ['Survival', 'Hardmode', 'Midgard', 'Pal Camp', 'Worker']) {
      await expect(serverRow(page, name).root).toHaveCount(1);
    }
  });

  test('opens a server and comes back home', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/');

    await serverRow(page, 'Hardmode').open.click();
    await expect(page).toHaveURL(serverUrl('', 'srv-hardmode'));
    await expect(appShell(page).header).toContainText('Terraria');

    await page.getByRole('button', { name: /go home/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(homeScreen(page).serverList).toBeVisible();
  });
});

test.describe('sidebar', () => {
  test('shows the active section and moves between them', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const shell = appShell(page);
    await expect(shell.navItem('dashboard')).toHaveAttribute('data-active', 'true');

    await shell.navItem('settings').click();

    await expect(page).toHaveURL(serverUrl('settings'));
    await expect(shell.navItem('settings')).toHaveAttribute('data-active', 'true');
    await expect(shell.navItem('dashboard')).toHaveAttribute('data-active', 'false');

    // A tab of the section is a URL of its own, and Back returns to the last one.
    await shell.sectionTab('files').click();
    await expect(page).toHaveURL(serverUrl('settings/files'));
    await expect(shell.navItem('settings')).toHaveAttribute('data-active', 'true');
    await page.goBack();
    await expect(page).toHaveURL(serverUrl('settings'));
    await expect(shell.sectionTab('game')).toHaveAttribute('data-state', 'active');
  });

  test('marks the overview as current on its details page', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'health');

    await expect(page).toHaveURL(serverUrl('details'));
    await expect(appShell(page).navItem('dashboard')).toHaveAttribute('data-active', 'true');
  });

  test('only lists the sections a game actually has', async ({ page, app }) => {
    await signInFast(page, app);

    // Minecraft is the fullest module: all eight sections, the old ones
    // merged into them.
    await openView(page, 'minecraft', 'dashboard');
    for (const view of ['dashboard', 'console', 'players', 'worlds', 'mods', 'backups', 'tasks', 'settings']) {
      await expect(appShell(page).navItem(view)).toHaveCount(1);
    }
    for (const view of ['health', 'map', 'addons', 'content', 'updates', 'configs', 'files']) {
      await expect(appShell(page).navItem(view)).toHaveCount(0);
    }
    // Panel-wide pages are tabs of Hostkind settings, not sidebar items: the
    // sidebar is only ever about the open server.
    for (const view of ['users', 'audit', 'panel']) {
      await expect(appShell(page).navItem(view)).toHaveCount(0);
    }
    await expect(appShell(page).sidebar.locator('[data-nav-item]')).toHaveCount(8);
    await appShell(page).navItem('mods').click();
    for (const tab of ['installed', 'browse', 'updates']) {
      await expect(appShell(page).sectionTab(tab)).toHaveCount(1);
    }

    // "Other processes" have a console and files, and nothing to do with a game.
    await openView(page, 'custom', 'dashboard');
    for (const view of ['console', 'backups', 'tasks', 'settings']) {
      await expect(appShell(page).navItem(view)).toHaveCount(1);
    }
    for (const view of ['players', 'worlds', 'mods']) {
      await expect(appShell(page).navItem(view)).toHaveCount(0);
    }
  });

  test('no longer offers integrations for any game', async ({ page, app }) => {
    await signInFast(page, app);

    // The Discord integration (and its view) were removed; no game offers the
    // section anymore.
    await openView(page, 'palworld', 'dashboard');
    await expect(appShell(page).navItem('integrations')).toHaveCount(0);

    // A typed URL for the removed view collapses to the dashboard.
    await page.goto('/games/palworld/integrations');
    await expect(page).toHaveURL(serverUrl());
  });
});

test.describe('phone width', () => {
  test('fits a 375px screen, with the sidebar as a drawer', async ({ page, app }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signInFast(page, app);
    await openView(page, 'minecraft', 'console');

    const shell = appShell(page);
    const sidebar = page.locator('[data-app-sidebar]');
    const toggle = page.locator('[data-nav-toggle]');

    // Nothing scrolls sideways, and the sidebar is off screen until asked for.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(sidebar).toHaveAttribute('data-drawer', 'closed');
    await expect(serverControls(page).start).toBeVisible();

    // Open it, go somewhere: the drawer closes behind the navigation.
    await toggle.click();
    await expect(sidebar).toHaveAttribute('data-drawer', 'open');
    await shell.navItem('backups').click();
    await expect(page).toHaveURL(serverUrl('backups'));
    await expect(sidebar).toHaveAttribute('data-drawer', 'closed');

    // Escape closes it too.
    await toggle.click();
    await expect(sidebar).toHaveAttribute('data-drawer', 'open');
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveAttribute('data-drawer', 'closed');
  });

  test('keeps the desktop sidebar on a wide screen', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await expect(page.locator('[data-nav-toggle]')).toBeHidden();
    await expect(page.locator('[data-app-sidebar]')).not.toHaveAttribute('data-drawer', /.+/);
    await expect(appShell(page).navItem('console')).toBeVisible();
  });
});

test.describe('view error boundary', () => {
  test('catches a crashing view without killing the shell', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/games/minecraft/dashboard?fleetdeckThrowView=1');

    // The recovery card renders inside the shell...
    const recovery = page.getByTestId('view-error-boundary');
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText(en('errors.viewCrashed'));
    // ...and the shell itself is still alive: header + sidebar nav remain.
    await expect(appShell(page).header).toBeVisible();

    // A reload without the probe renders the view normally (no boundary UI).
    await page.goto('/games/minecraft/dashboard');
    await expect(page.getByTestId('view-error-boundary')).toHaveCount(0);
  });
});

test.describe('per-game views', () => {
  test('gives Minecraft the Content browser and Terraria none', async ({ page, app }) => {
    await signInFast(page, app);

    await openView(page, 'minecraft', 'content');
    await expect(page).toHaveURL(serverUrl('mods/browse'));

    // content-install is Minecraft's alone.
    await openView(page, 'terraria', 'content');
    await expect(page).toHaveURL(serverUrl());
  });

  test('sends Terraria to its own mods view', async ({ page, app }) => {
    await signInFast(page, app);
    // The seeded Terraria server is vanilla, which has no mod support at all.
    await openView(page, 'terraria', 'addons');

    await expect(page).toHaveURL(serverUrl());
  });

  test('opens the tModLoader mods view for a tModLoader server', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [seed.terraria(dirs, { name: 'Modded', variant: 'tmodloader' })],
    });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });

    // Navigated to from inside the app, once the active server is known.
    await appShell(page).navItem('mods').click();

    await expect(page).toHaveURL(serverUrl('mods'));
    // One tab for this server, so no tab bar to choose from.
    await expect(page.locator('[data-section-tabs]')).toHaveCount(0);
    // Without a bar, the page carries the section's own name.
    await expect(page.getByRole('heading', { name: en('nav.mods'), exact: true })).toBeVisible();
  });

  test('opens a variant-gated view from a typed URL', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [seed.terraria(dirs, { name: 'Modded', variant: 'tmodloader' })],
    });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'addons', { origin: panel.url });

    await expect(page).toHaveURL(serverUrl('mods/installed'));
  });

  test('surfaces downloaded Workshop content on the Palworld addons view', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [
        seed.palworld(dirs, {
          name: 'Pal Camp',
          extra: {
            steamapps: {
              workshop: { content: { '1623730': { '777': { 'Info.json': '{}' } } } },
            },
          },
        }),
      ],
    });
    await signInFast(page, panel);

    // The catalog is fetched on mount; fail it immediately so the view is not
    // held hostage by the network.
    await page.route('https://steamcommunity.com/**', (route) => route.abort());
    await page.route('https://api.steampowered.com/**', (route) => route.abort());

    await openView(page, 'palworld', 'addons', { origin: panel.url });

    await expect(page).toHaveURL(serverUrl('mods/installed'));
    await expect(page.getByRole('heading', { name: en('nav.mods'), exact: true })).toBeVisible();

    // The seeded item lives in the server's own folder. It must surface as
    // downloadable content instead of silently vanishing.
    await page.getByRole('tab', { name: en('palworldMods.official.installedTab') }).click();
    await expect(page.getByText(en('palworldMods.official.downloadedTitle'))).toBeVisible();
    await expect(page.getByText('Workshop 777')).toBeVisible();
    await expect(page.getByRole('button', { name: en('palworldMods.official.reviewInstall') }).first()).toBeVisible();

    // The Sources tab names the server's own folder, so a SteamCMD download
    // landing there is visibly accounted for.
    await page.getByRole('tab', { name: en('palworldMods.official.sources') }).click();
    await expect(page.getByText(en('palworldMods.official.serverSource')).first()).toBeVisible();
  });

  test('gives the map view to the games that have a map', async ({ page, app }) => {
    await signInFast(page, app);

    await openView(page, 'palworld', 'map');
    await expect(page).toHaveURL(serverUrl('worlds/map'));

    // The bundled asset is served to the map canvas: an <img> under the
    // application region whose src hits the asset endpoint and that actually
    // decodes (naturalWidth > 0). A broken or missing built-in map would fail
    // here, not just at the URL level.
    const canvas = page.getByRole('application', { name: en('palworld.map.canvasLabel') });
    const mapImage = canvas.locator('img');
    await expect(mapImage).toBeVisible();
    await expect(mapImage).toHaveAttribute('src', /\/api\/palworld\/map\/asset\?/);
    await expect.poll(() => mapImage.evaluate((img) => img.naturalWidth), { timeout: 7000 }).toBeGreaterThan(0);

    // Valheim has worlds but no map: the section opens on what it has.
    await openView(page, 'valheim', 'map');
    await expect(page).toHaveURL(serverUrl('worlds'));
  });

  test('map canvas survives clicks and drags without page errors', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'palworld', 'map');

    const canvas = page.getByRole('application', { name: en('palworld.map.canvasLabel') });
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // A click (down + tiny jiggle + up) used to queue a transform updater that
    // ran after the drag ref was cleared, crashing with "Cannot read properties
    // of null (reading 'originX')". Any page error now fails this test.
    const errors = [];
    const passiveWarnings = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('preventDefault inside passive')) {
        passiveWarnings.push(message.text());
      }
    });
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 3, cy + 3);
    await page.mouse.up();

    // A real drag pans the map; pointer-cancel must not leave stale state.
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 5 });
    await page.mouse.up();

    // Wheel zoom must not trip React's passive listener warning (the old
    // onWheel called preventDefault() on a passive root listener).
    await page.mouse.wheel(0, -240);
    await page.mouse.wheel(0, 240);

    // The canvas must still be there and interactive after all that.
    await expect(canvas).toBeVisible();
    expect(errors).toEqual([]);
    expect(passiveWarnings).toEqual([]);
  });

  test('places live players on the map axes Palworld actually uses', async ({ page, newApp }) => {
    const restPort = await freePort();
    const panel = await newApp({
      servers: (dirs) => [seed.palworldRunnable(dirs, { name: 'Pal North', restPort })],
      // The child process inherits the panel's environment. Palworld's map runs
      // north along world X and east along world Y, so this places the player
      // three quarters of the way north (x) on the world's centre line (y).
      env: { FAKE_REST_PORT: String(restPort), FAKE_PLAYER_X: '105612', FAKE_PLAYER_Y: '158000' },
    });
    await signInFast(page, panel);
    await openView(page, 'palworld', 'servers', { origin: panel.url });
    await waitForLiveConnection(page);
    await serverRow(page, 'Pal North').start.click();
    await expect(serverRow(page, 'Pal North').status).toHaveText(en('status.online'), { timeout: 60_000 });

    await openView(page, 'palworld', 'map', { origin: panel.url });
    // A marker a quarter of the way down the image and centred horizontally.
    // Projecting x onto the horizontal axis - the bug this pins - would put it
    // at 75% across instead, out in the ocean.
    const marker = page
      .getByRole('application', { name: en('palworld.map.canvasLabel') })
      .getByRole('button', { name: /Lamball/ });
    await expect(marker).toBeVisible({ timeout: 15_000 });
    const [top, left] = await marker.evaluate((el) => [parseFloat(el.style.top), parseFloat(el.style.left)]);
    expect(top).toBeGreaterThan(24.5);
    expect(top).toBeLessThan(25.5);
    expect(left).toBeGreaterThan(49.5);
    expect(left).toBeLessThan(50.5);

    // The detail panel leads with the grid the game itself shows the player,
    // not the six-figure Unreal coordinates: this spot is half way north on the
    // centre line, so the game would call it (0, 500).
    await marker.click();
    await expect(page.getByText(en('palworld.map.gridCoords', { x: '0', y: '500' }))).toBeVisible();

    // The fake serves the real REST shape (flat location_x/location_y, no
    // location_z). The raw coordinates stay underneath and must render a player
    // like that without leaking "null" - the map only needs the horizontal plane.
    await expect(page.getByText(/Z —/)).toBeVisible();
    await expect(page.getByText(/Z null/)).toHaveCount(0);
  });

  test('calibration saves a content rect derived from an uploaded landscape image', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await client(panel);
    await signInFast(page, panel);
    await openView(page, 'palworld', 'map', { origin: panel.url });

    await page.getByRole('button', { name: en('palworld.map.calibration'), exact: true }).click();
    const dlg = dialog(page, en('palworld.map.calibration')).root;
    await dlg.locator('input[type=file]').setInputFiles({
      name: 'landscape.png',
      mimeType: 'image/png',
      // A 4x2 landscape: the dialog's probe derives a content band of v0=0.25.
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAFElEQVR4nGMUsQlggAEmOIuBgQEADxIApC6YflUAAAAASUVORK5CYII=', 'base64'),
    });
    // The provenance fields appear once the file has been read; the probe that
    // derives the content rect decodes a few pixels after that.
    await expect(dlg.getByLabel(en('palworld.map.source'))).toBeVisible();
    await page.waitForTimeout(200);
    await dlg.getByRole('button', { name: en('palworld.map.preview'), exact: true }).click();
    await expect(dlg.getByRole('button', { name: en('common.save'), exact: true })).toBeEnabled();
    await dlg.getByRole('button', { name: en('common.save'), exact: true }).click();
    await expect(dlg).toHaveCount(0);

    const { servers } = await api.get('/api/servers');
    const palworldServer = servers.find((server) => server.type === 'palworld');
    const state = await api.get(`/api/palworld/map?serverId=${palworldServer.id}`);
    expect(state.calibration.contentRect).toEqual({ u0: 0, v0: 0.25, u1: 1, v1: 0.75 });
  });

  test('keeps the details page for every game', async ({ page, app }) => {
    await signInFast(page, app);

    for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
      await openView(page, game, 'health');
      await expect(page).toHaveURL(serverUrl('details'));
    }
  });
});

test.describe('settings', () => {
  test('switches the panel language and keeps it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();

    await expect(page).toHaveURL(/\/settings$/);
    await panelSettings(page).group('language').getByRole('button', { name: 'Español', exact: false }).click();

    // The shell re-renders in Spanish...
    await expect(appShell(page).sidebar).toContainText(es('nav.console'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(await page.evaluate(() => window.localStorage.getItem('fleetdeck_lang'))).toBe('es');
  });

  test("the profile menu opens Hostkind settings, What's new and the language", async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    const shell = appShell(page);

    await shell.profileButton.click();
    await shell.menuWhatsNew.click();
    await expect(shell.changelog).toBeVisible();
    await shell.changelog.getByRole('button', { name: en('common.close'), exact: true }).first().click();
    await expect(shell.changelog).toBeHidden();

    await shell.profileButton.click();
    await shell.menuLanguage.click();
    await page.getByRole('menuitemradio', { name: 'Español' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(shell.sidebar).toContainText(es('nav.console'));
    await expect(page.getByRole('menu')).toHaveCount(0);

    await shell.profileButton.click();
    await page.getByRole('menuitem', { name: es('nav.panelSettings', { name: es('brand.name') }) }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // Nothing of the server is left in the sidebar's rail marker.
    await expect(shell.sidebar.locator('[data-nav-item][data-active="true"]')).toHaveCount(0);
  });

  test('flips the crash watchdog from settings', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();

    // The watchdog used to be config.json-only; Hostkind settings is the
    // surface that flips it, and the write lands in the panel config.
    const watchdog = panelSettings(page).group('watchdog');
    await expect(watchdog).toBeVisible();

    await watchdog.getByRole('checkbox').click();
    await watchdog.getByRole('spinbutton').nth(0).fill('5');
    await watchdog.getByRole('spinbutton').nth(1).fill('20');
    await watchdog.getByRole('button', { name: en('common.save'), exact: true }).click();

    await expect(toasts(page).withText(en('settings.watchdogSaved'))).toBeVisible();
    const cfg = panel.readConfig();
    expect(cfg.watchdog).toMatchObject({ enabled: true, maxRestarts: 5, windowMinutes: 20 });
  });
});

test.describe('first visit and updates', () => {
  test('a first sign-in opens the server with nothing in the way', async ({ page, newApp }) => {
    const panel = await newApp();
    // The real form, so nothing is planted: this is a brand-new browser.
    await signIn(page, { identifier: panel.admin.username, password: panel.admin.password, origin: panel.url });
    await page.goto(`${panel.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();

    // No tour, no changelog, no first-start modal, and nothing floating over
    // the page.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-bug-report-dock]')).toHaveCount(0);
    // A fresh browser has nothing new to read: it starts from this build.
    await expect(appShell(page).whatsNewDot).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem('fleetdeck_changelog_version'))).toBe(APP_VERSION);
  });

  test("after an update the profile menu marks What's new until it is opened", async ({ page, app }) => {
    // signInFast plants the current changelog version. Overwrite it with a
    // stale one on the first navigation only: that is what an upgrade looks
    // like. (addInitScript runs on every navigation, so a sessionStorage flag
    // keeps the reload below a normal visit.)
    await signInFast(page, app);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('changelog_stale_planted')) return;
      sessionStorage.setItem('changelog_stale_planted', '1');
      window.localStorage.setItem('fleetdeck_changelog_version', '0.0.0');
    });
    await page.goto(`${app.url}/games/minecraft/dashboard`);
    const shell = appShell(page);
    await expect(shell.header).toBeVisible();

    // It never opens by itself.
    await expect(shell.changelog).toBeHidden();
    await expect(shell.whatsNewDot).toBeVisible();

    await shell.profileButton.click();
    await expect(shell.menuWhatsNew).toHaveAttribute('data-whats-new-unread', 'true');
    await shell.menuWhatsNew.click();
    await expect(shell.changelog).toBeVisible();
    await expect(shell.changelog).toContainText('Changelog');
    await expect(shell.changelog).toContainText('Windows desktop support');
    await shell.changelog.getByRole('button', { name: en('common.close'), exact: true }).first().click();
    await expect(shell.changelog).toBeHidden();
    await expect(shell.whatsNewDot).toHaveCount(0);

    // Read stays read.
    await page.reload();
    await expect(shell.header).toBeVisible();
    await expect(shell.whatsNewDot).toHaveCount(0);
    await expect(shell.changelog).toBeHidden();
  });

  test("What's new stays read when the desktop port changes", async ({ page, newApp }) => {
    // Desktop launches choose a fresh loopback port. localStorage is scoped to
    // the origin (so to the port); cookies are not, and carry what was read.
    const first = await newApp();
    await signIn(page, { identifier: first.admin.username, password: first.admin.password, origin: first.url });
    await page.goto(`${first.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();

    const second = await newApp();
    const session = await client(second);
    await seedToken(page, session.token);
    // The new origin's localStorage says an old build; the cookie wins.
    await page.addInitScript(() => window.localStorage.setItem('fleetdeck_changelog_version', '0.0.0'));
    await page.goto(`${second.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();
    await expect(appShell(page).whatsNewDot).toHaveCount(0);
  });
});

test.describe('first start', () => {
  test('a never-started server says so on its content pages without blocking them', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Fresh', generated: false })] });
    await signInFast(page, panel);
    const id = panel.server('Fresh').id;
    const shell = appShell(page);

    // In-app navigation goes straight through; the notice sits on the page.
    await page.goto(`${panel.url}/servers/${id}`);
    await expect(shell.header).toBeVisible();
    await shell.navItem('mods').click();
    await expect(page).toHaveURL(serverUrl('mods', id));
    await expect(shell.firstStartNotice).toBeVisible();
    await expect(shell.firstStartNotice.getByRole('button', { name: en('firstStart.startNow'), exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    for (const segment of ['worlds', 'settings/game', 'settings/files']) {
      await page.goto(`${panel.url}/servers/${id}/${segment}`);
      await expect(shell.firstStartNotice, segment).toBeVisible();
    }
    // Settings -> General is the panel's own record of the server: nothing to generate.
    await page.goto(`${panel.url}/servers/${id}/settings/general`);
    await expect(shell.header).toBeVisible();
    await expect(shell.firstStartNotice).toHaveCount(0);
  });

  test('Start on the notice starts the server and the notice goes away', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.custom(dirs, { name: 'Worker', started: false })] });
    await signInFast(page, panel);
    const id = panel.server('Worker').id;
    await page.goto(`${panel.url}/servers/${id}/settings/files`);
    await waitForLiveConnection(page);
    const shell = appShell(page);
    await expect(shell.firstStartNotice).toBeVisible();

    await shell.firstStartNotice.getByRole('button', { name: en('firstStart.startNow'), exact: true }).click();
    await expect(serverControls(page).status).toHaveText(en('status.online'), { timeout: 20_000 });
    await expect(shell.firstStartNotice).toHaveCount(0);
    await expect(toasts(page).withText(en('firstStart.onlineToast'))).toBeVisible();

    // Once it has run, stopping it does not bring the notice back.
    await serverControls(page).stop.click();
    await expect(serverControls(page).start).toBeVisible();
    await expect(shell.firstStartNotice).toHaveCount(0);
  });
});

test.describe('server switching', () => {
  test('switches the open server from the sidebar', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [
        seed.minecraft(dirs, { name: 'Survival' }),
        seed.minecraft(dirs, { name: 'Creative' }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    const switcher = serverControls(page);
    await expect(switcher.picker).toContainText('Survival');

    await switcher.picker.click();
    await switcher.pickerOption('Creative').click();

    await expect(switcher.picker).toContainText('Creative');
    // The view follows the server: the file list is now the other folder's.
    await expect(page.getByRole('row').filter({ hasText: 'server.properties' })).toBeVisible();
  });

  test('remembers the active server per game', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [
        seed.minecraft(dirs, { name: 'Survival' }),
        seed.minecraft(dirs, { name: 'Creative' }),
        seed.terraria(dirs, { name: 'Hardmode' }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await serverControls(page).picker.click();
    await serverControls(page).pickerOption('Creative').click();
    await expect(serverControls(page).picker).toContainText('Creative');

    // Go somewhere else entirely, then come back.
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });
    await expect(serverControls(page).picker).toContainText('Hardmode');

    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    await expect(serverControls(page).picker).toContainText('Creative');
  });
});
