'use strict';

/*
 * The shell every game shares - sidebar, header, settings, tour - and the
 * rule that decides which sections a given game is even offered.
 *
 * The gating table is the interesting part: each module declares what it can
 * do (its manager under lib/modules), and App.jsx turns that into which views
 * a server may open. These tests hold that mapping in place from the outside.
 */

const { test, expect, en, es } = require('../support/fixtures.cjs');
const { appShell, controlBar, toasts, dialog, gamesHub, serverRow } = require('../support/pages.cjs');
const { signIn, signInFast, openView, enterGame, waitForLiveConnection, seedToken } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');
const seed = require('../support/seed.cjs');
const net = require('net');

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

test.describe('games hub', () => {
  test('offers every game the panel supports', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/games');

    for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
      await expect(gamesHub(page).game(game)).toHaveCount(1);
    }
  });

  test('enters a game and comes back to the hub', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/games');

    await enterGame(page, 'terraria');
    await expect(page).toHaveURL(/\/games\/terraria\/dashboard$/);
    await expect(appShell(page).header).toContainText('Terraria');

    await page.getByRole('button', { name: /go to all games/i }).click();
    await expect(page).toHaveURL(/\/games$/);
    await expect(gamesHub(page).carousel).toBeVisible();
  });
});

test.describe('sidebar', () => {
  test('shows the active section and moves between them', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const shell = appShell(page);
    await expect(shell.navItem('dashboard')).toHaveAttribute('data-active', 'true');

    await shell.navItem('files').click();

    await expect(page).toHaveURL(/\/games\/minecraft\/files$/);
    await expect(shell.navItem('files')).toHaveAttribute('data-active', 'true');
    await expect(shell.navItem('dashboard')).toHaveAttribute('data-active', 'false');
  });

  test('only lists the sections a game actually has', async ({ page, app }) => {
    await signInFast(page, app);

    // Minecraft is the fullest module: worlds, mods, a map, a player list.
    await openView(page, 'minecraft', 'dashboard');
    for (const view of ['console', 'players', 'addons', 'modrinth', 'worlds', 'map', 'configs', 'backups']) {
      await expect(appShell(page).navItem(view)).toHaveCount(1);
    }

    // "Other processes" have a console and files, and nothing to do with a game.
    await openView(page, 'custom', 'dashboard');
    for (const view of ['console', 'files', 'backups', 'tasks']) {
      await expect(appShell(page).navItem(view)).toHaveCount(1);
    }
    for (const view of ['players', 'worlds', 'map', 'modrinth', 'updates']) {
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
    await expect(page).toHaveURL(/\/games\/palworld\/dashboard$/);
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
  test('gives Minecraft the Modrinth browser and Terraria none', async ({ page, app }) => {
    await signInFast(page, app);

    await openView(page, 'minecraft', 'modrinth');
    await expect(page).toHaveURL(/\/games\/minecraft\/modrinth$/);

    // content-install is Minecraft's alone.
    await openView(page, 'terraria', 'modrinth');
    await expect(page).toHaveURL(/\/games\/terraria\/dashboard$/);
  });

  test('sends Terraria to its own mods view', async ({ page, app }) => {
    await signInFast(page, app);
    // The seeded Terraria server is vanilla, which has no mod support at all.
    await openView(page, 'terraria', 'addons');

    await expect(page).toHaveURL(/\/games\/terraria\/dashboard$/);
  });

  test('opens the tModLoader mods view for a tModLoader server', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [seed.terraria(dirs, { name: 'Modded', variant: 'tmodloader' })],
    });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });

    // Navigated to from inside the app, once the active server is known.
    await appShell(page).navItem('addons').click();

    await expect(page).toHaveURL(/\/games\/terraria\/addons$/);
    await expect(page.getByText(en('terraria.mods.title'))).toBeVisible();
  });

  test('opens a variant-gated view from a typed URL', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [seed.terraria(dirs, { name: 'Modded', variant: 'tmodloader' })],
    });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'addons', { origin: panel.url });

    await expect(page).toHaveURL(/\/games\/terraria\/addons$/);
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

    await expect(page).toHaveURL(/\/games\/palworld\/addons$/);
    await expect(page.getByRole('heading', { name: en('palworldMods.title') })).toBeVisible();

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
    await expect(page).toHaveURL(/\/games\/palworld\/map$/);

    // The bundled asset is served to the map canvas: an <img> under the
    // application region whose src hits the asset endpoint and that actually
    // decodes (naturalWidth > 0). A broken or missing built-in map would fail
    // here, not just at the URL level.
    const canvas = page.getByRole('application', { name: en('palworld.map.canvasLabel') });
    const mapImage = canvas.locator('img');
    await expect(mapImage).toBeVisible();
    await expect(mapImage).toHaveAttribute('src', /\/api\/palworld\/map\/asset\?/);
    await expect.poll(() => mapImage.evaluate((img) => img.naturalWidth), { timeout: 7000 }).toBeGreaterThan(0);

    await openView(page, 'valheim', 'map');
    await expect(page).toHaveURL(/\/games\/valheim\/dashboard$/);
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

  test('keeps the health view for every game', async ({ page, app }) => {
    await signInFast(page, app);

    for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
      await openView(page, game, 'health');
      await expect(page).toHaveURL(new RegExp(`/games/${game}/health$`));
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

    const settings = dialog(page, en('settings.title'));
    await expect(settings.root).toBeVisible();
    await page.getByRole('button', { name: 'Español', exact: false }).click();

    // The shell re-renders in Spanish...
    await expect(appShell(page).sidebar).toContainText(es('nav.servers'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(await page.evaluate(() => window.localStorage.getItem('fleetdeck_lang'))).toBe('es');
  });

  test('flips the crash watchdog from settings', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();

    // The watchdog used to be config.json-only; the admin settings dialog is
    // the surface that flips it, and the write lands in the panel config.
    const settings = dialog(page, en('settings.title'));
    const watchdog = settings.root.getByRole('checkbox').locator('xpath=ancestor::section');
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

test.describe('onboarding tour', () => {
  test('greets you the first time you enter a game, once', async ({ page, newApp }) => {
    const panel = await newApp();
    // Deliberately not signInFast, which marks the tour as already seen.
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();

    // Second visit to the same game: no tour.
    await page.goto(`${panel.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();
    await expect(tour).toBeHidden();
  });

  test('does not close when the backdrop is clicked', async ({ page, newApp }) => {
    const panel = await newApp();
    // Deliberately not signInFast, which marks the tour as already seen.
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // The welcome card is centered, so the top-left corner is on the dimmed
    // backdrop. Clicking it must not dismiss the tour - only the X button or
    // Escape may.
    await page.mouse.click(10, 10);
    await expect(tour).toBeVisible();

    // Same with a spotlight target: the far side of the sidebar is dimmed,
    // and the click must be swallowed rather than passed to the app below.
    await page.keyboard.press('ArrowRight');
    await expect(tour).toBeVisible();
    await page.mouse.click(1250, 400);
    await expect(tour).toBeVisible();

    // Escape still closes it.
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();
  });

  test('can be replayed from settings', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');
    await expect(appShell(page).tour).toBeHidden();

    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();
    const settings = dialog(page, en('settings.title'));
    await settings.root.getByRole('button', { name: en('settings.tourRepeat') }).click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // The X button closes it too.
    await tour.getByRole('button', { name: en('common.close') }).click();
    await expect(tour).toBeHidden();
  });

  test('ArrowRight walks forward through the tour until Finish appears', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // Back button should not be visible on the first step.
    await expect(tour.getByRole('button', { name: en('common.back'), exact: true })).toHaveCount(0);

    // Advance through all steps with ArrowRight, bounded to avoid infinite
    // loops if the tour changes step count in parallel.
    let finishVisible = false;
    for (let i = 0; i < 15; i += 1) {
      if (await tour.getByRole('button', { name: en('tour.finish'), exact: true }).isVisible()) {
        finishVisible = true;
        break;
      }
      await page.keyboard.press('ArrowRight');
      // Small pause so React can re-render between steps.
      await tour.getByRole('button', { name: /Next|Finish/i }).waitFor();
    }

    expect(finishVisible).toBe(true);

    // Finish button is present on the last step.
    await expect(tour.getByRole('button', { name: en('tour.finish'), exact: true })).toBeVisible();
  });

  test('ArrowLeft walks back after advancing', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // First step: Back is absent.
    await expect(tour.getByRole('button', { name: en('common.back'), exact: true })).toHaveCount(0);

    // Advance one step — Back should appear.
    await page.keyboard.press('ArrowRight');
    await expect(tour.getByRole('button', { name: en('common.back'), exact: true })).toBeVisible();

    // Go back — Back should disappear again.
    await page.keyboard.press('ArrowLeft');
    await expect(tour.getByRole('button', { name: en('common.back'), exact: true })).toHaveCount(0);
  });

  test('Finish button closes the tour and marks it seen', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // Navigate to the last step.
    for (let i = 0; i < 15; i += 1) {
      if (await tour.getByRole('button', { name: en('tour.finish'), exact: true }).isVisible()) break;
      await page.keyboard.press('ArrowRight');
      await tour.getByRole('button', { name: /Next|Finish/i }).waitFor();
    }

    await tour.getByRole('button', { name: en('tour.finish'), exact: true }).click();
    await expect(tour).toBeHidden();

    // Tour is marked seen in localStorage.
    const seen = await page.evaluate(
      ([key, userId, game]) => window.localStorage.getItem(`${key}:${userId}:${game}`),
      ['fleetdeck_tour_seen', api.user.id, 'minecraft'],
    );
    expect(seen).toBe('1');
  });

  test('completing the tour in one game marks it seen in every game', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // Walk to the last step and Finish.
    for (let i = 0; i < 15; i += 1) {
      if (await tour.getByRole('button', { name: en('tour.finish'), exact: true }).isVisible()) break;
      await page.keyboard.press('ArrowRight');
      await tour.getByRole('button', { name: /Next|Finish/i }).waitFor();
    }
    await tour.getByRole('button', { name: en('tour.finish'), exact: true }).click();
    await expect(tour).toBeHidden();

    // The walkthroughs are near-identical per game, so finishing it once
    // marks it seen for every game in the catalogue.
    const seen = await page.evaluate(
      ([key, userId]) => Object.fromEntries(
        ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']
          .map((game) => [game, window.localStorage.getItem(`${key}:${userId}:${game}`)]),
      ),
      ['fleetdeck_tour_seen', api.user.id],
    );
    for (const game of ['minecraft', 'terraria', 'valheim', 'palworld', 'custom']) {
      expect(seen[game], `seen flag for ${game}`).toBe('1');
    }

    // ...so entering another game opens no tour at all. The carousel
    // centers a slide on the first click and enters it on the second.
    await page.goto(`${panel.url}/games`);
    const terraria = gamesHub(page).game('terraria');
    await terraria.click();
    await terraria.click();
    await expect(appShell(page).header).toBeVisible();
    await expect(appShell(page).tour).toBeHidden();
  });

  test('controlbar step keeps the dock visible on a short viewport', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    // A short window is where the bug lives: the card cannot fit above the
    // bottom dock, and the old positioning clamp parked the card on top of
    // the very controls the step is teaching about.
    await page.setViewportSize({ width: 726, height: 337 });
    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // Walk to the controlbar step (the one describing the server controls dock).
    for (let i = 0; i < 15; i += 1) {
      if (await tour.getByRole('heading', { name: en('tour.controlbar.title') }).isVisible()) break;
      await page.keyboard.press('ArrowRight');
      await tour.getByRole('button', { name: /Next|Finish/i }).waitFor();
    }
    await expect(tour.getByRole('heading', { name: en('tour.controlbar.title') })).toBeVisible();

    // The card must not bury the dock: on an extreme viewport it may graze
    // the dock's top edge, but its bottom must stay above the dock's vertical
    // centre so the controls remain visible. Poll because the spotlight rect
    // lands a double-rAF after the step renders.
    const card = tour.locator('div[tabindex="-1"]');
    const dock = page.locator('[data-tour="controlbar"]');
    await expect(dock).toBeVisible();
    const overhang = async () => {
      const cardBox = await card.boundingBox();
      const dockBox = await dock.boundingBox();
      return cardBox.y + cardBox.height - (dockBox.y + dockBox.height / 2);
    };
    await expect.poll(overhang, { timeout: 5000 }).toBeLessThanOrEqual(0);
  });

  test('X button mid-tour closes and marks it seen', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // Advance a couple of steps to be mid-tour.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    // Click the X (Close) button.
    await tour.getByRole('button', { name: en('common.close'), exact: true }).click();
    await expect(tour).toBeHidden();

    // Tour is marked seen in localStorage.
    const seen = await page.evaluate(
      ([key, userId, game]) => window.localStorage.getItem(`${key}:${userId}:${game}`),
      ['fleetdeck_tour_seen', api.user.id, 'minecraft'],
    );
    expect(seen).toBe('1');
  });

  test('backdrop click advances a spotlight step without closing', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await require('../support/api.cjs').client(panel);
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, ['fleetdeck_token', api.token]);

    await page.goto(`${panel.url}/games`);
    await gamesHub(page).game('minecraft').click();

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();

    // The selected progress dot's aria-label is the badge text, which names
    // the current step - so a change in it proves the step advanced.
    const selected = () => tour.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label');

    // Move to a spotlight step first (welcome is a centered card, where the
    // backdrop must stay swallowed).
    await page.keyboard.press('ArrowRight');
    await expect(tour).toBeVisible();
    const before = await selected();

    // Click the dimmed area far from the card: the tour must not close, and
    // on a spotlight step it advances instead.
    await page.mouse.click(1250, 400);
    await expect(tour).toBeVisible();
    await expect.poll(selected).not.toBe(before);

    // Escape still closes it.
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();
  });

  test("shows a condensed what's-new tour to returning users", async ({ page, app }) => {
    // signInFast marks the tour as seen for every game and plants the current
    // build version. Overwrite that with a stale version once, on the first
    // navigation only: that is what an upgrade looks like - the tour was
    // seen, but the stored version predates the build, so the app opens the
    // what's-new variant instead of the full tour. (addInitScript runs on
    // every navigation, so guard it with a sessionStorage flag; a second
    // navigation must look like a normal post-upgrade visit.)
    await signInFast(page, app);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('tour_stale_planted')) return;
      sessionStorage.setItem('tour_stale_planted', '1');
      window.localStorage.setItem('fleetdeck_tour_version', '0.0.0');
    });
    await page.goto(`${app.url}/games/minecraft/dashboard`);

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();
    await expect(tour).toContainText(en('tour.whatsnew.title'));
    // Not the full welcome card.
    await expect(tour).not.toContainText(en('tour.welcome.title'));

    // Once seen, it does not re-open on the next visit.
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();
    await page.goto(`${app.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();
    await expect(tour).toBeHidden();
  });

  test("does not show what's-new again when the desktop port changes", async ({ page, newApp }) => {
    // Desktop launches choose a fresh loopback port. Browser localStorage is
    // origin-scoped (and therefore port-scoped), while cookies are not. A
    // completed tour must remain dismissed across that boundary.
    const first = await newApp();
    await signIn(page, {
      identifier: first.admin.username,
      password: first.admin.password,
      origin: first.url,
    });
    await page.goto(`${first.url}/games/minecraft/dashboard`);

    const tour = appShell(page).tour;
    await expect(tour).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();

    const second = await newApp();
    const session = await client(second);
    await seedToken(page, session.token);
    await page.context().addCookies([{
      name: `fleetdeck_tour_seen_${session.user.id}_minecraft`,
      value: '1',
      domain: '127.0.0.1',
      path: '/',
    }]);
    await page.goto(`${second.url}/games/minecraft/dashboard`);
    await expect(appShell(page).header).toBeVisible();
    await expect(tour).toBeHidden();
  });
});

test.describe('server switching', () => {
  test('switches the active server from the dock', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [
        seed.minecraft(dirs, { name: 'Survival' }),
        seed.minecraft(dirs, { name: 'Creative' }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    const dock = controlBar(page);
    await expect(dock.picker).toContainText('Survival');

    await dock.picker.click();
    await dock.pickerOption('Creative').click();

    await expect(dock.picker).toContainText('Creative');
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

    await controlBar(page).picker.click();
    await controlBar(page).pickerOption('Creative').click();
    await expect(controlBar(page).picker).toContainText('Creative');

    // Go somewhere else entirely, then come back.
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });
    await expect(controlBar(page).picker).toContainText('Hardmode');

    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    await expect(controlBar(page).picker).toContainText('Creative');
  });
});
