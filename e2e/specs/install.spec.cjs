'use strict';

/*
 * Installing a real server, for real: these tests drive the create wizard,
 * let the panel download from the actual upstream, check what landed on disk,
 * and then remove it again.
 *
 * They are NOT part of the normal run. They need the network, they take
 * minutes, and Palworld alone pulls several gigabytes. Opt in per game:
 *
 *   E2E_INSTALL=minecraft npm run test:e2e:install
 *   E2E_INSTALL=minecraft,terraria npm run test:e2e:install
 *   E2E_INSTALL=all npm run test:e2e:install          # includes the big ones
 *
 * Everything a test creates is removed when it ends, pass or fail:
 *
 *   1. the test removes the server through the UI, because that round trip is
 *      the point;
 *   2. the `installer` fixture sweeps the folders it was told about, which is
 *      what covers a test that died mid-download;
 *   3. the panel's whole temp directory goes at teardown - and because the
 *      installer cache and managed Java runtimes are redirected into it, a
 *      half-downloaded SteamCMD does not survive either.
 *
 * Nothing is written to the repo, and nothing is written to the developer's
 * real Hostkind install.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { serverRow, dialog, fieldByLabel, minecraftWizard } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

// Which games this run is allowed to download.
const requested = String(process.env.E2E_INSTALL || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const wants = (game) => requested.includes('all') || requested.includes(game);

// A download of hundreds of megabytes over an unknown link. Generous, and
// still bounded so a stalled mirror fails rather than hangs the run.
const INSTALL_TIMEOUT = 20 * 60 * 1000;

/**
 * Drive the shared parts of a create wizard and wait for the row to appear.
 * `panel` is the instance doing the installing - every navigation here has to
 * name it, because the default baseURL points at the shared read-only panel.
 */
async function createServer(page, panel, { game, name, fill }) {
  await openView(page, game, 'servers', { origin: panel.url });
  const createNew = page.getByRole('button', { name: en('servers.createNew') }).first();
  // The install flow runs without retries on slow CI runners; wait for the
  // view to finish rendering before clicking (the wizard's version select
  // below has the same explicit grace).
  await expect(createNew).toBeEnabled({ timeout: 60_000 });
  await createNew.click();

  const wizard = dialog(page, en('servers.createTitle'));
  await fill(wizard);

  // The install streams progress; the row appearing is the finish line.
  await expect(serverRow(page, name).root).toBeVisible({ timeout: INSTALL_TIMEOUT });
}

/** Where the panel actually put a server it just installed. */
function installedDir(panel, name) {
  const registered = panel.readConfig().servers.find((server) => server.name === name);
  expect(registered, `no server named ${name} in the config`).toBeTruthy();
  expect(fs.existsSync(registered.dir)).toBe(true);
  return registered.dir;
}

/** Remove through the UI and confirm the registry really let go. */
async function removeServer(page, panel, name, { trashFiles }) {
  await serverRow(page, name).remove.click();
  const confirm = dialog(page, en('servers.removeTitle'));
  if (trashFiles) await confirm.root.getByText(en('portability.trashFilesLabel')).click();

  const [removal] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'DELETE' && response.url().includes('/api/servers/')),
    confirm.root.getByRole('button', {
      name: trashFiles ? en('portability.removeAndTrash') : en('portability.removeProfile'),
    }).click(),
  ]);
  expect(removal.status(), await removal.text()).toBe(200);

  await expect(serverRow(page, name).root).toHaveCount(0);
  expect(panel.readConfig().servers.some((server) => server.name === name)).toBe(false);
}

test.describe('installing a real server', () => {
  test.describe.configure({ timeout: INSTALL_TIMEOUT + 5 * 60 * 1000 });

  test('downloads a Paper server, runs the wizard, then removes it', async ({ page, installer }) => {
    test.skip(!wants('minecraft'), 'set E2E_INSTALL=minecraft to download a Minecraft server');

    const { panel, installs } = await installer();
    await signInFast(page, panel);

    await createServer(page, panel, {
      game: 'minecraft',
      name: 'PaperTest',
      async fill(wizard) {
        await fieldByLabel(wizard.root, en('servers.fieldName')).fill('PaperTest');
        await fieldByLabel(wizard.root, en('servers.fieldParent')).fill(installs.parentDir);
        // The EULA checkbox is the panel's own gate; without it nothing runs.
        await wizard.root.getByRole('checkbox').first().check();
        // Paper's version list resolves upstream; submitting before it lands
        // posts an empty mcVersion and is refused.
        await expect(minecraftWizard(page).version).toBeEnabled({ timeout: 60_000 });
        await wizard.root.getByRole('button', { name: en('minecraft.servers.downloadAndCreate') }).click();
      },
    });

    const target = installedDir(panel, 'PaperTest');
    // A jar really arrived, and it is a jar rather than an error page.
    const jars = fs.readdirSync(target).filter((name) => name.endsWith('.jar'));
    expect(jars.length).toBeGreaterThan(0);
    expect(fs.statSync(path.join(target, jars[0])).size).toBeGreaterThan(1_000_000);
    // The panel registered what it installed, pointed at that folder.
    const registered = panel.readConfig().servers.find((server) => server.name === 'PaperTest');
    expect(path.resolve(registered.dir)).toBe(path.resolve(target));

    await removeServer(page, panel, 'PaperTest', { trashFiles: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  test('installs a Terraria server, then removes it', async ({ page, installer }) => {
    test.skip(!wants('terraria'), 'set E2E_INSTALL=terraria to download a Terraria server');

    const { panel, installs } = await installer();
    await signInFast(page, panel);

    await createServer(page, panel, {
      game: 'terraria',
      name: 'TerrariaTest',
      async fill(wizard) {
        await fieldByLabel(wizard.root, en('servers.fieldName')).fill('TerrariaTest');
        await fieldByLabel(wizard.root, en('servers.fieldParent')).fill(installs.parentDir);
        // Vanilla is the default edition; the version list resolves upstream.
        await expect(wizard.root.locator('#terraria-version')).toBeEnabled({ timeout: 60_000 });
        await wizard.root.getByRole('button', { name: en('servers.installServer') }).click();
      },
    });

    const target = installedDir(panel, 'TerrariaTest');
    /*
     * What a real vanilla install looks like: the upstream zip extracts to a
     * version-numbered folder holding Linux/, Mac/ and Windows/ builds, and
     * the panel writes its own serverconfig.txt and worlds/ beside it.
     */
    const entries = fs.readdirSync(target);
    expect(entries).toContain('serverconfig.txt');
    expect(entries).toContain('worlds');
    expect(entries.some((name) => /^\d+$/.test(name))).toBe(true);

    // It registered an executable, and that executable is really there.
    const registered = panel.readConfig().servers.find((server) => server.name === 'TerrariaTest');
    expect(registered.executable).toBeTruthy();
    expect(fs.existsSync(registered.executable)).toBe(true);
    // NOTE: on Windows it currently picks the Linux build's TerrariaServer.exe,
    // because the candidate is a bare filename and every platform folder in
    // the archive contains one. Tracked separately; asserting the right build
    // here would need a second multi-minute download to demonstrate.

    await removeServer(page, panel, 'TerrariaTest', { trashFiles: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  test('installs a Valheim server through SteamCMD, then removes it', async ({ page, installer }) => {
    test.skip(!wants('valheim'), 'set E2E_INSTALL=valheim to download a Valheim server (~1 GB)');

    const { panel, installs } = await installer();
    await signInFast(page, panel);

    await createServer(page, panel, {
      game: 'valheim',
      name: 'ValheimTest',
      async fill(wizard) {
        await fieldByLabel(wizard.root, en('servers.fieldName')).fill('ValheimTest');
        await fieldByLabel(wizard.root, en('servers.fieldParent')).fill(installs.parentDir);
        // Valheim requires a password of at least five characters.
        await fieldByLabel(wizard.root, en('servers.fieldPassword')).fill('fleetdeck');
        await wizard.root.getByRole('button', { name: en('servers.installServer') }).click();
      },
    });

    const target = installedDir(panel, 'ValheimTest');
    const entries = fs.readdirSync(target);
    expect(entries.some((name) => /valheim_server/i.test(name))).toBe(true);

    await removeServer(page, panel, 'ValheimTest', { trashFiles: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  test('installs a Palworld server through SteamCMD, then removes it', async ({ page, installer }) => {
    test.skip(!wants('palworld'), 'set E2E_INSTALL=palworld to download a Palworld server (several GB)');

    const { panel, installs } = await installer();
    await signInFast(page, panel);

    await createServer(page, panel, {
      game: 'palworld',
      name: 'PalworldTest',
      async fill(wizard) {
        await fieldByLabel(wizard.root, en('servers.fieldName')).fill('PalworldTest');
        await fieldByLabel(wizard.root, en('servers.fieldParent')).fill(installs.parentDir);
        await wizard.root.getByRole('button', { name: en('servers.installServer') }).click();
      },
    });

    const target = installedDir(panel, 'PalworldTest');
    // Palworld writes its settings file as part of the install.
    const platform = process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
    expect(fs.existsSync(path.join(target, 'Pal', 'Saved', 'Config', platform, 'PalWorldSettings.ini'))).toBe(true);

    await removeServer(page, panel, 'PalworldTest', { trashFiles: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  test('leaves nothing behind when an install is interrupted', async ({ page, installer }) => {
    test.skip(!wants('minecraft'), 'set E2E_INSTALL=minecraft to exercise the interrupted-install path');

    const { panel, installs } = await installer();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
    const wizard = dialog(page, en('servers.createTitle'));
    await fieldByLabel(wizard.root, en('servers.fieldName')).fill('Abandoned');
    await fieldByLabel(wizard.root, en('servers.fieldParent')).fill(installs.parentDir);
    await wizard.root.getByRole('checkbox').first().check();
    // Without this the click lands before the version list resolves and the
    // install never starts - which would leave the assertions below passing
    // on a 400 rather than on the cancel path this test is about.
    await expect(minecraftWizard(page).version).toBeEnabled({ timeout: 60_000 });
    await wizard.root.getByRole('button', { name: en('minecraft.servers.downloadAndCreate') }).click();

    // Walk out mid-download. The wizard cancels the request it started.
    await expect(wizard.root.getByRole('button', { name: en('common.cancel') })).toBeVisible();
    await wizard.root.getByRole('button', { name: en('common.cancel') }).click();

    // Nothing half-installed is left registered, whatever reached the disk.
    await expect(serverRow(page, 'Abandoned').root).toHaveCount(0);
    expect(panel.readConfig().servers.some((server) => server.name === 'Abandoned')).toBe(false);

    // Whatever reached the disk before the cancel, the sweep takes it - and
    // this asserts the sweep is really wired up rather than assumed.
    expect(await installs.cleanup()).toEqual([]);
    expect(fs.existsSync(installs.parentDir)).toBe(false);
  });
});



