'use strict';

/*
 * Worlds -> Map on a Minecraft server with no map yet (MapSetup.jsx).
 *
 * The tab asks GET /api/minecraft/content/map-plugins what is on disk. For a
 * plugin that is not installed the panel also asks Modrinth whether it has a
 * build for this server, so the install flow stubs that one route and the
 * install itself (a real Modrinth download). The rest runs against the panel
 * as-is: a vanilla server needs no lookup, and a server that already has the
 * plugins on disk is answered from its folder alone.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { mapSetup } = require('../support/pages.cjs');
const { signInFast } = require('../support/actions.cjs');
const seed = require('../support/seed.cjs');

// Every known map plugin as a jar, so nothing is left to ask Modrinth about.
// BlueMap's web server is moved off its default port, and it has not yet been
// allowed to download Mojang's resources.
function withMapsOnDisk(dirs) {
  return [seed.minecraft(dirs, {
    name: 'Mapped',
    extra: {
      plugins: {
        'EssentialsX.jar': 'plugin',
        'bluemap-5.4-paper.jar': 'plugin',
        'Dynmap-3.7-spigot.jar': 'plugin',
        'squaremap-paper-1.3.jar': 'plugin',
        'Pl3xMap-1.21.jar': 'plugin',
        BlueMap: {
          'webserver.conf': 'enabled: true\nport: 8200\n',
          'core.conf': 'accept-download: false\nrender-thread-count: 1\n',
        },
      },
    },
  })];
}

async function openMap(page, panel, name) {
  await signInFast(page, panel);
  await page.goto(`${panel.url}/servers/${panel.server(name).id}/worlds/map`);
}

const mapUrlOf = (panel, name) => panel.readConfig().servers.find((s) => s.name === name).mapUrl;

test.describe('map setup', () => {
  test('a vanilla server says maps need Paper or Fabric', async ({ page, newApp }) => {
    const panel = await newApp({
      servers: (dirs) => [{ ...seed.minecraft(dirs, { name: 'Plain' }), jar: 'minecraft_server.1.20.4.jar' }],
    });
    await openMap(page, panel, 'Plain');

    await expect(page.getByText(en('minecraft.mapView.vanillaTitle'), { exact: true })).toBeVisible();
    await expect(page.locator('[data-map-plugin]')).toHaveCount(0);
  });

  test('installs a map, points the tab at it, and asks for a start', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Survival' })] });
    let installed = false;
    const plugin = (key, name, port, available) => ({ key, name, port, installed: installed && key === 'bluemap', file: null, available });
    await page.route((url) => url.pathname === '/api/minecraft/content/map-plugins', (route) => route.fulfill({
      json: {
        supported: true,
        reason: null,
        running: false,
        compat: { label: 'Paper', mcVersion: '1.20.4' },
        blueMapDownload: null,
        plugins: [
          plugin('bluemap', 'BlueMap', 8100, true),
          plugin('dynmap', 'Dynmap', 8123, false),
          plugin('squaremap', 'squaremap', 8080, true),
          plugin('pl3xmap', 'Pl3xMap', 8080, true),
        ],
      },
    }));
    const installs = [];
    await page.route((url) => /^\/api\/minecraft\/content\/map-plugins\/[^/]+\/install$/.test(url.pathname), (route) => {
      installs.push(new URL(route.request().url()).pathname.split('/')[5]);
      installed = true;
      return route.fulfill({ json: { ok: true, key: 'bluemap', name: 'bluemap-5.4-paper.jar', port: 8100, running: false } });
    });

    await openMap(page, panel, 'Survival');
    const setup = mapSetup(page);

    // Modrinth has no Dynmap build for this server: said, and not offered.
    await expect(setup.plugin('dynmap').root).toHaveAttribute('data-available', 'false');
    await expect(setup.plugin('dynmap').install).toBeDisabled();
    await expect(setup.plugin('dynmap').root).toContainText(en('minecraft.mapView.unavailable', { target: 'Paper 1.20.4' }));

    await setup.plugin('bluemap').install.click();

    // Stopped server: the map builds on the next start, and the tab says so.
    await expect(page.getByText(en('minecraft.mapView.startTitle', { name: 'BlueMap' }), { exact: true })).toBeVisible();
    expect(installs).toEqual(['bluemap']);
    // The tab now points at the plugin's own web server on this host.
    await expect.poll(() => mapUrlOf(panel, 'Survival')).toMatch(/^http:\/\/[^/]+:8100$/);
  });

  test('finds a map already on disk and shows it on its own port', async ({ page, newApp }) => {
    const panel = await newApp({ servers: withMapsOnDisk });
    await openMap(page, panel, 'Mapped');
    const setup = mapSetup(page);

    await expect(page.getByText(en('minecraft.mapView.detectedTitle', { name: 'BlueMap' }), { exact: true })).toBeVisible();
    await setup.showMap.click();

    // The port comes from BlueMap's webserver.conf, not its default 8100.
    await expect(setup.frame).toHaveAttribute('src', /:8200$/);
    await expect.poll(() => mapUrlOf(panel, 'Mapped')).toMatch(/:8200$/);
  });

  test('BlueMap download consent is one click, and lands in core.conf', async ({ page, newApp }) => {
    const panel = await newApp({ servers: withMapsOnDisk });
    const coreConf = path.join(panel.server('Mapped').dir, 'plugins', 'BlueMap', 'core.conf');
    await openMap(page, panel, 'Mapped');
    const setup = mapSetup(page);

    await expect(setup.consent).toBeVisible();
    await setup.consent.click();

    await expect(setup.consent).toHaveCount(0);
    const text = fs.readFileSync(coreConf, 'utf8');
    expect(text).toMatch(/^accept-download: true$/m);
    // Only that line changes.
    expect(text).toContain('render-thread-count: 1');
  });
});
