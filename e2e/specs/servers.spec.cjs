'use strict';

/*
 * The server registry: the all-servers list, opening a server from it,
 * starting and stopping them, and editing or removing one from its own
 * Settings -> General and the header's menu.
 *
 * The lifecycle tests drive the "Worker" fixture - a custom-module server
 * pointed at e2e/support/fake-process.cjs - so a start here spawns a real
 * child process, streams its real stdout, and stops it through the module's
 * real stop sequence.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const {
  serverControls, serverRow, serverUrl, homeScreen, generalSettings, serverMenu,
  toasts, dialog, fieldByLabel, minecraftWizard, folderBrowser,
} = require('../support/pages.cjs');
const { signInFast, openView, openGeneralSettings, startAddServer, openMoreOptions, waitForLiveConnection } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');
const seed = require('../support/seed.cjs');

const row = (page, name) => serverRow(page, name).root;

// Spawning a real process and hearing back about it takes longer than a render,
// and longer still when every worker is doing it at once.
const LIFECYCLE = { timeout: 20_000 };

test.describe('registry', () => {
  test('lists every server, whatever its game', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');

    await expect(homeScreen(page).serverList).toBeVisible();
    // Servers of different games sit side by side; the list is not scoped to
    // the game of whichever server was open last.
    for (const name of ['Survival', 'Hardmode', 'Midgard', 'Pal Camp', 'Worker']) {
      await expect(row(page, name)).toBeVisible();
    }
  });

  test('shows the game and status of each server', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');

    const survival = serverRow(page, 'Survival');
    await expect(survival.root).toContainText(en('games.minecraft'));
    await expect(survival.status).toHaveText(en('status.offline'));
    // Nothing is running, so players and resources have nothing to report,
    // and the only lifecycle button is Start.
    await expect(survival.root).toContainText(en('common.dashPlaceholder'));
    await expect(survival.start).toBeVisible();
    await expect(survival.stop).toHaveCount(0);
    // Folders are configuration, not status: they live on Settings -> General.
    await expect(survival.root).not.toContainText(app.server('Survival').dir);
  });

  test('has no "active" server to pick', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');

    await expect(homeScreen(page).serverList).toBeVisible();
    // The server you look at is the one in the URL; the list never asks you
    // to choose one for the other pages to act on.
    await expect(page.getByTitle('Set active')).toHaveCount(0);
    await expect(homeScreen(page).serverList.getByText('active', { exact: true })).toHaveCount(0);
  });

  test('opens a server from its row', async ({ page, newApp }) => {
    const panel = await newApp({
      servers: (dirs) => [
        seed.minecraft(dirs, { name: 'Survival' }),
        seed.minecraft(dirs, { name: 'Creative' }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    // Anywhere on the row opens it, not just the button.
    await serverRow(page, 'Creative').root.getByText('Creative', { exact: true }).click();

    // Opening a server is a navigation: the URL names it, and the switcher follows.
    await expect(page).toHaveURL(serverUrl('', 'srv-creative'));
    await expect(serverControls(page).picker).toContainText('Creative');

    await page.goBack();
    await serverRow(page, 'Survival').open.click();
    await expect(page).toHaveURL(serverUrl('', 'srv-survival'));
  });

  test('offers the game picker when nothing is registered', async ({ page, newApp }) => {
    const panel = await newApp({ servers: [] });
    await signInFast(page, panel);
    await openView(page, 'valheim', 'servers', { origin: panel.url });

    // An empty list is the same first step as an empty home: pick a game.
    await expect(homeScreen(page).firstServer).toBeVisible();
    await expect(homeScreen(page).gameChoice('valheim')).toBeVisible();
  });
});

test.describe('registering', () => {
  test('refuses a folder that is not there', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    // Adding an existing Minecraft folder opens the adoption dialog, which
    // inspects the folder before anything is registered.
    await startAddServer(page, 'minecraft', 'existing');
    const form = dialog(page, en('portability.minecraftAdoptTitle'));
    await form.root.getByRole('textbox').first().fill(path.join(panel.dirs.servers, 'nowhere'));
    await form.root.getByRole('button', { name: en('portability.inspect') }).click();

    // The inspect step refuses a dead path, so nothing is registered.
    await expect(form.root).toContainText('That folder does not exist');
    await expect(row(page, 'Ghost')).toHaveCount(0);
  });

  test('uses the host native picker for Minecraft adoption', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    let pickRequests = 0;
    await page.route('**/api/pick-folder**', async (route) => {
      pickRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: panel.dirs.servers }),
      });
    });

    await startAddServer(page, 'minecraft', 'existing');
    const form = dialog(page, en('portability.minecraftAdoptTitle'));
    const browse = form.root.getByRole('button', { name: en('servers.browse'), exact: true });

    await browse.click();

    await expect(form.root.getByRole('textbox').first()).toHaveValue(panel.dirs.servers);
    expect(pickRequests).toBe(1);
    await expect(folderBrowser(page).root).toHaveCount(0);
  });

  test('adopts a folder that has exactly one jar in it', async ({ page, newApp }) => {
    const panel = await newApp();
    // A server folder that exists on disk but the panel does not know about.
    const dir = path.join(panel.dirs.servers, 'adopted');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper-1.20.1.jar'), 'jar');

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await startAddServer(page, 'minecraft', 'existing');
    const form = dialog(page, en('portability.minecraftAdoptTitle'));
    await form.root.getByRole('textbox').first().fill(dir);
    await form.root.getByRole('button', { name: en('portability.inspect') }).click();

    // Detection succeeded: the name auto-fills from the folder name, the
    // server type is detected from the jar, and adoption registers it.
    await expect(form.root.getByRole('textbox').nth(1)).toHaveValue('adopted');
    await form.root.getByRole('button', { name: en('portability.minecraftAdopt') }).click();

    // The server that was just added opens straight away.
    await expect(page).toHaveURL(serverUrl());
    await expect(page.getByRole('heading', { name: 'adopted', exact: true })).toBeVisible();
    // And it is in the config, not just on screen.
    expect(panel.readConfig().servers.some((server) => server.name === 'adopted')).toBe(true);
  });

  test('adopts a NeoForge folder launched through a generated argfile', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = path.join(panel.dirs.servers, 'neoforge-adopted');
    // findForgeLaunchTarget looks for the platform-specific argfile the
    // installer produces, so the fixture must create the one matching the
    // OS under test (a win-only fixture is invisible on Linux).
    const argName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const argRelative = path.join('libraries', 'net', 'neoforged', 'neoforge', '21.4.157', argName);
    fs.mkdirSync(path.dirname(path.join(dir, argRelative)), { recursive: true });
    fs.writeFileSync(path.join(dir, argRelative), [
      '--module-path',
      'libraries',
      '--fml.neoForgeVersion',
      '21.4.157',
      '--fml.mcVersion',
      '1.21.4',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'server.properties'), [
      'server-port=25565',
      'motd=A NeoForge Server',
      'level-name=world',
      'max-players=20',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level');

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await startAddServer(page, 'minecraft', 'existing');
    const form = dialog(page, en('portability.minecraftAdoptTitle'));
    await form.root.getByRole('textbox').first().fill(dir);
    await form.root.getByRole('button', { name: en('portability.inspect') }).click();

    await expect(form.root).toContainText('NeoForge');
    await expect(form.root).toContainText('neoforge-server');
    await expect(form.root.getByRole('button', { name: en('portability.minecraftAdopt') })).toBeEnabled();
    await form.root.getByRole('button', { name: en('portability.minecraftAdopt') }).click();

    await expect(page).toHaveURL(serverUrl());
    await expect(page.getByRole('heading', { name: 'neoforge-adopted', exact: true })).toBeVisible();
    const registered = panel.readConfig().servers.find((server) => server.name === 'neoforge-adopted');
    expect(registered.launchArgs).toEqual([`@libraries/net/neoforged/neoforge/21.4.157/${argName}`, 'nogui']);
    expect(registered.mcVersion).toBe('1.21.4');
  });

  /*
   * The create wizard, end to end, with no network involved: a custom process
   * is the one kind of server the panel makes without downloading anything.
   * The games that do download are covered by install.spec.cjs, which is
   * opt-in; this keeps the create-then-remove round trip under test on every
   * run.
   */
  test('creates a process through the wizard and removes it again', async ({ page, newApp }) => {
    const panel = await newApp({ servers: [] });
    const workdir = path.join(panel.dirs.servers, 'wizard-made');
    // The wizard refuses an executable outside the working directory, so the
    // process to run has to be in there first.
    const runnable = seed.plantRunnable(workdir);

    await signInFast(page, panel);
    await openView(page, 'custom', 'servers', { origin: panel.url });

    await startAddServer(page, 'custom');
    const wizard = dialog(page, en('servers.createTitle'));

    await fieldByLabel(wizard.root, en('servers.fieldName')).fill('Wizard Made');
    await fieldByLabel(wizard.root, en('servers.fieldWorkingDirectory')).fill(workdir);
    await fieldByLabel(wizard.root, en('servers.fieldStartCommand')).fill(runnable.startCommand);
    await fieldByLabel(wizard.root, en('servers.fieldHealthCheckRegex')).fill('\\[fake\\] ready');
    await wizard.root.getByRole('button', { name: en('servers.createProcess') }).click();

    // Registered and opened, and the config agrees.
    await expect(page).toHaveURL(serverUrl());
    const created = page.url();
    await page.goto(`${panel.url}/servers`);
    await expect(row(page, 'Wizard Made')).toBeVisible();
    expect(panel.readConfig().servers.some((server) => server.name === 'Wizard Made')).toBe(true);

    // And it is a working server, not just a row: start it, then stop it.
    await waitForLiveConnection(page);
    await serverRow(page, 'Wizard Made').start.click();
    await expect(serverRow(page, 'Wizard Made').status).toHaveText(en('status.online'), LIFECYCLE);
    await serverRow(page, 'Wizard Made').stop.click();
    await expect(serverRow(page, 'Wizard Made').status).toHaveText(en('status.offline'), LIFECYCLE);

    /*
     * Now take it away again. This removes the profile and keeps the files:
     * trashing them here would move a folder whose executable exited seconds
     * ago, and Windows can still hold that image handle - the rename fails
     * with EPERM. Trashing is covered by the sibling test, on a folder nothing
     * has ever run from. The waitForResponse is so a refusal reports itself
     * instead of showing up as a server that mysteriously stayed put.
     */
    await page.goto(`${created}/settings/general`);
    await generalSettings(page).remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    const [removal] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === 'DELETE' && response.url().includes('/api/servers/')),
      confirm.root.getByRole('button', { name: en('portability.removeProfile') }).click(),
    ]);
    expect(removal.status(), await removal.text()).toBe(200);

    // Its pages have nothing behind them any more.
    await expect(page).not.toHaveURL(/\/servers\//);
    expect(panel.readConfig().servers.some((server) => server.name === 'Wizard Made')).toBe(false);
    // Keeping the files is the promise of that button, so they are still here.
    expect(fs.existsSync(workdir)).toBe(true);
  });

  /*
   * Choosing Minecraft and "install" goes straight to the Minecraft form: custom
   * processes are their own game in the picker, so the form never offers a
   * second kind to pick first.
   */
  test('opens the Minecraft wizard with no kind to pick first', async ({ page, app }) => {
    await signInFast(page, app);
    // Stubbed so the wizard's version lookup never reaches PaperMC.
    await page.route('**/api/create/versions*', (route) => route.fulfill({ json: { versions: ['1.21.4'] } }));

    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'minecraft');

    const wizard = minecraftWizard(page);
    await expect(wizard.type).toBeVisible();
    await expect(wizard.version).toBeEnabled();
    // And no way to reach the custom-process form from in here.
    await expect(wizard.root.getByRole('button', { name: en('servers.createProcess') })).toHaveCount(0);
  });

  /*
   * The Minecraft wizard resolves its version list from PaperMC on open, and
   * the form has no version until that lands. It used to render the dropdown
   * and the submit button enabled meanwhile, so a click inside that window
   * posted an empty mcVersion and came back 400 "pick a version" - next to a
   * dropdown that had by then filled itself in. Holding the response open here
   * makes that window as wide as the test needs; nothing is downloaded.
   */
  test('holds the Minecraft wizard shut until the version list arrives', async ({ page, app }) => {
    await signInFast(page, app);

    let release;
    let held = new Promise((resolve) => { release = resolve; });
    const hold = () => { held = new Promise((resolve) => { release = resolve; }); };
    await page.route('**/api/create/versions*', async (route) => {
      await held;
      const type = new URL(route.request().url()).searchParams.get('type');
      await route.fulfill({ json: { versions: type === 'vanilla' ? ['1.20.6'] : ['1.21.4', '1.21.3'] } });
    });

    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'minecraft');
    const wizard = minecraftWizard(page);

    // In flight: neither control may be touched, and nothing can be posted.
    await expect(wizard.version).toBeDisabled();
    await expect(wizard.submit).toBeDisabled();

    release();
    await expect(wizard.version).toBeEnabled();
    await expect(wizard.version).toHaveValue('1.21.4');
    await expect(wizard.submit).toBeEnabled();

    // Changing the type reopens the same window, so the gate has to hold again.
    hold();
    await wizard.type.selectOption('vanilla');
    await expect(wizard.version).toBeDisabled();
    await expect(wizard.submit).toBeDisabled();

    release();
    await expect(wizard.version).toHaveValue('1.20.6');
    await expect(wizard.submit).toBeEnabled();
  });

  test('renames a server from its own settings', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await page.goto(`${panel.url}/servers/${panel.server('Survival').id}/settings/general`);

    const save = page.getByRole('button', { name: en('common.save'), exact: true });
    // Nothing to save until something changed.
    await expect(save).toBeDisabled();
    await page.getByRole('textbox').first().fill('Survival Reborn');
    await save.click();

    await expect(page.locator('header h1')).toHaveText('Survival Reborn');
    expect(panel.readConfig().servers.some((server) => server.name === 'Survival Reborn')).toBe(true);
  });

  test('reaches a server\'s settings from the header menu', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto(`/servers/${app.server('Survival').id}/console`);

    const menu = serverMenu(page);
    await menu.trigger.click();
    await menu.settings.click();
    await expect(page).toHaveURL(serverUrl('settings/general', app.server('Survival').id));
  });

  test('makes a Minecraft server from a template through Add server', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/servers');

    await startAddServer(page, 'minecraft', 'template');
    await expect(dialog(page, en('servers.templatesTitle')).root).toBeVisible();
  });
});

test.describe('removing', () => {
  test('removes the profile from the header menu and leaves the files alone', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await page.goto(`${panel.url}/servers/${panel.server('Survival').id}`);

    const menu = serverMenu(page);
    await menu.trigger.click();
    await menu.remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    await confirm.root.getByRole('button', { name: en('portability.removeProfile') }).click();

    // The outcome, not the toast: a toast lives 3.5s and a loaded machine can
    // miss it, but the registry either lost the server or it did not.
    await expect(page).not.toHaveURL(/\/servers\//);
    await expect(row(page, 'Hardmode')).toBeVisible();
    await expect(row(page, 'Survival')).toHaveCount(0);
    expect(panel.readConfig().servers.some((server) => server.name === 'Survival')).toBe(false);
    // The point of the default: the world is still on disk.
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('removes a server from its own settings and leaves it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await page.goto(`${panel.url}/servers/${panel.server('Survival').id}/settings/general`);

    await page.getByRole('button', { name: en('servers.btnRemove'), exact: true }).click();
    const confirm = dialog(page, en('servers.removeTitle'));
    await confirm.root.getByRole('button', { name: en('portability.removeProfile') }).click();

    // The page it was on no longer has a server behind it.
    await expect(page).not.toHaveURL(/\/servers\//);
    expect(panel.readConfig().servers.some((server) => server.name === 'Survival')).toBe(false);
  });

  test('can also move the files to trash, which is recoverable', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openGeneralSettings(page, panel, 'Survival');

    await generalSettings(page).remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    await confirm.root.getByText(en('portability.trashFilesLabel')).click();
    await confirm.root.getByRole('button', { name: en('portability.removeAndTrash') }).click();

    await expect(page).not.toHaveURL(/\/servers\//);
    // Moved, not deleted: gone from where it was, still somewhere.
    await expect.poll(() => fs.existsSync(dir)).toBe(false);

    // The trash sits under the list of servers, one click from getting it back.
    await page.goto(`${panel.url}/servers`);
    const home = homeScreen(page);
    await expect(home.trash).toBeVisible();
    await home.restore.first().click();
    await expect.poll(() => fs.existsSync(dir)).toBe(true);
  });
});

test.describe('lifecycle', () => {
  // Every test here starts a real process, so none of them can share a panel.
  test('starts and stops a process from its row', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'servers', { origin: panel.url });

    await waitForLiveConnection(page);
    const worker = row(page, 'Worker');
    await expect(worker.locator('.status-pill')).toHaveText(en('status.offline'));

    await serverRow(page, 'Worker').start.click();
    // The fixture prints its ready line, which is what promotes it to online.
    await expect(worker.locator('.status-pill')).toHaveText(en('status.online'), LIFECYCLE);

    await serverRow(page, 'Worker').stop.click();
    await expect(worker.locator('.status-pill')).toHaveText(en('status.offline'), LIFECYCLE);
  });

  test('drives the same process from the header', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'dashboard', { origin: panel.url });

    await waitForLiveConnection(page);
    const controls = serverControls(page);
    await expect(controls.status).toHaveText(en('status.offline'));

    await controls.start.click();
    await expect(controls.status).toHaveText(en('status.online'), LIFECYCLE);
    // Start gives way to restart and stop once it is up.
    await expect(controls.start).toHaveCount(0);
    await expect(controls.stop).toBeVisible();

    await controls.stop.click();
    await expect(controls.status).toHaveText(en('status.offline'), LIFECYCLE);
    await expect(controls.start).toBeVisible();
  });

  test('asks before a restart, because it kicks everyone', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'dashboard', { origin: panel.url });

    await waitForLiveConnection(page);
    const controls = serverControls(page);
    await controls.start.click();
    await expect(controls.status).toHaveText(en('status.online'), LIFECYCLE);

    await controls.restart.click();
    const confirm = dialog(page, en('header.restart'));
    await expect(confirm.root).toContainText(en('header.restartConfirm'));

    await confirm.root.getByRole('button', { name: en('header.restart') }).click();
    // It comes back up on its own.
    await expect(controls.status).toHaveText(en('status.online'), LIFECYCLE);
  });

  test('refuses to edit or remove a server while it is running', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'servers', { origin: panel.url });

    await waitForLiveConnection(page);
    const worker = row(page, 'Worker');
    await serverRow(page, 'Worker').start.click();
    await expect(worker.locator('.status-pill')).toHaveText(en('status.online'), LIFECYCLE);

    await openGeneralSettings(page, panel, 'Worker');
    await generalSettings(page).remove.click();
    await dialog(page, en('servers.removeTitle')).root
      .getByRole('button', { name: en('portability.removeProfile') }).click();

    await expect(toasts(page).withText(en('errors.stopBeforeRemove'))).toBeVisible();
    expect(panel.readConfig().servers.some((server) => server.name === 'Worker')).toBe(true);
  });
});

test.describe('permissions', () => {
  test('shows an operator nothing until a capability is granted', async ({ page, newApp }) => {
    const panel = await newApp();
    // Boot grants existing operators parity access to every existing server
    // (foundation boot's capability-parity import), so "no grants" has to be
    // stated explicitly: clear the operator's grants, then the fleet is empty.
    const api = await client(panel);
    await api.grant(await api.userId(panel.operator.username), []);

    await signInFast(page, panel, panel.operator);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    // The registry itself is behind per-server grants, so an operator with no
    // grants cannot even enumerate the fleet - and cannot add to it either.
    await expect(page.getByText(en('home.firstBodyViewer'))).toBeVisible();
    await expect(homeScreen(page).gameChoice('minecraft')).toHaveCount(0);
    await expect(row(page, 'Survival')).toHaveCount(0);
  });

  test('lets a granted operator read the registry but not change it', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await client(panel);
    const operatorId = await api.userId(panel.operator.username);
    await api.grant(operatorId, [
      { serverId: panel.server('Survival').id, capability: 'server.register' },
    ]);

    await signInFast(page, panel, panel.operator);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await expect(row(page, 'Survival')).toBeVisible();
    // Registry-changing controls are admin-only in the UI regardless of grants.
    await expect(homeScreen(page).addServer).toHaveCount(0);
    await openGeneralSettings(page, panel, 'Survival');
    await expect(serverMenu(page).trigger).toHaveCount(0);
    await expect(generalSettings(page).remove).toHaveCount(0);
    await expect(generalSettings(page).clone).toHaveCount(0);
  });
});

test.describe('folder picker', () => {
  /*
   * The native dialog is an OS window the browser cannot reach, but its
   * round-trip is what a double-click hits: the pick-folder request stays in
   * flight until the dialog closes, and another click in that window used to
   * fire a second PowerShell and stack a second dialog. The Browse button must
   * disable for the whole round-trip so a second click cannot happen, and the
   * request that does fire must be the only one.
   */
  test('Browse disables for the whole round-trip and fires exactly one request', async ({ page, app }) => {
    await signInFast(page, app);

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let pickRequests = 0;
    await page.route('**/api/pick-folder**', async (route) => {
      pickRequests += 1;
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: app.dirs.servers }),
      });
    });

    await openView(page, 'custom', 'servers');
    await startAddServer(page, 'custom');
    const wizard = dialog(page, en('servers.createTitle'));
    const browse = wizard.root.getByRole('button', { name: en('servers.browse'), exact: true });

    await browse.click();
    // While the dialog is open (the request is held), the button is dead.
    await expect(browse).toBeDisabled();

    // Let the "dialog" close: the response lands, the button wakes up, and the
    // held request is the only one that ever went out.
    release();
    await expect(browse).toBeEnabled();
    expect(pickRequests).toBe(1);

    // The chosen folder landed in the working-directory field.
    await expect(fieldByLabel(wizard.root, en('servers.fieldWorkingDirectory'))).toHaveValue(app.dirs.servers);
  });

  /*
   * The native dialog is the one thing in the create flow that depends on the
   * host OS cooperating, and when it did not the wizard died with it: the
   * request never came back, so Browse stayed disabled and there was no way
   * forward or back to a folder. Whatever the OS does, the button has to wake
   * up and the built-in browser has to take over.
   */
  test('Browse recovers into the built-in browser when the native dialog fails', async ({ page, app }) => {
    await signInFast(page, app);

    await page.route('**/api/pick-folder**', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unable to find type [ModernFolderDialog].' }),
    }));

    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'minecraft');
    const wizard = minecraftWizard(page);
    // The parent folder is optional, so it sits under More options.
    await openMoreOptions(wizard.root);
    const parent = fieldByLabel(wizard.root, en('servers.fieldParent'));
    const browse = wizard.root.getByRole('button', { name: en('servers.browse'), exact: true });

    // The built-in browser opens wherever the field points, so start it
    // somewhere real - it is the folder the assertion below picks.
    await parent.fill(app.dirs.servers);
    await browse.click();

    // The in-panel folder browser takes the native dialog's place instead of
    // the click going nowhere, and it opens where the field was pointing.
    // While it is up it is the only dialog the a11y tree exposes, so the
    // wizard's own controls are asserted on after it closes.
    const builtIn = folderBrowser(page);
    await expect(builtIn.root).toBeVisible();
    await expect(builtIn.at(app.dirs.servers)).toBeVisible();

    // And it is a working way out, not just a consolation dialog.
    await builtIn.use.click();
    await expect(builtIn.root).toBeHidden();
    await expect(parent).toHaveValue(app.dirs.servers);

    // The button woke up: the flow can be retried rather than being dead for
    // the rest of the wizard's life.
    await expect(browse).toBeEnabled();
  });

  /*
   * The Browse button sits next to the parent-folder input in a flex row.
   * It used to be size="sm" (h-9) against the input's h-11, so it rendered
   * 8px shorter, top-aligned, with its content centered above the input's
   * text. The fix pins the button to the input's height (h-11 shrink-0),
   * which also keeps the row from squashing it when the dialog is narrow.
   * Assert the geometry directly: same box height, same top edge - i.e. the
   * button spans exactly the input's vertical band instead of hanging off it.
   */
  test('Browse button matches the parent-folder input height', async ({ page, app }) => {
    await signInFast(page, app);

    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'minecraft');
    const wizard = minecraftWizard(page);
    // The parent folder is optional, so it sits under More options.
    await openMoreOptions(wizard.root);
    const parent = fieldByLabel(wizard.root, en('servers.fieldParent'));
    const browse = wizard.root.getByRole('button', { name: en('servers.browse'), exact: true });

    await expect(browse).toBeVisible();
    const inputBox = await parent.boundingBox();
    const browseBox = await browse.boundingBox();

    // Same height (±1px) and effectively the same top edge. Chromium can
    // report fractional flex-row offsets on Windows, so allow up to 2px for
    // the top edge while still rejecting the old 8px misalignment.
    expect(Math.abs(inputBox.height - browseBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(inputBox.y - browseBox.y)).toBeLessThanOrEqual(2);
  });
});



