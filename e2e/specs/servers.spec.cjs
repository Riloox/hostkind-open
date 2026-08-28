'use strict';

/*
 * The server registry: what is registered, which one is active, and starting
 * and stopping them.
 *
 * The lifecycle tests drive the "Worker" fixture - a custom-module server
 * pointed at e2e/support/fake-process.cjs - so a start here spawns a real
 * child process, streams its real stdout, and stops it through the module's
 * real stop sequence.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { controlBar, serverRow, toasts, dialog, fieldByLabel, minecraftWizard, folderBrowser } = require('../support/pages.cjs');
const { signInFast, openView, waitForLiveConnection } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');
const seed = require('../support/seed.cjs');

const row = (page, name) => serverRow(page, name).root;

// Spawning a real process and hearing back about it takes longer than a render,
// and longer still when every worker is doing it at once.
const LIFECYCLE = { timeout: 20_000 };

test.describe('registry', () => {
  test('lists only the servers belonging to the game you are in', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');

    await expect(page.getByText(en('servers.registeredTitle'))).toBeVisible();
    await expect(row(page, 'Survival')).toBeVisible();
    // The other games' servers are registered, but they are not this game's.
    await expect(row(page, 'Hardmode')).toHaveCount(0);
    await expect(row(page, 'Pal Camp')).toHaveCount(0);

    await openView(page, 'terraria', 'servers');
    await expect(row(page, 'Hardmode')).toBeVisible();
    await expect(row(page, 'Survival')).toHaveCount(0);
  });

  test('shows the folder and status of each server', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');

    const survival = row(page, 'Survival');
    await expect(survival).toContainText(app.server('Survival').dir);
    await expect(survival.locator('.status-pill')).toHaveText(en('status.offline'));
    // Nothing is running, so players and uptime have nothing to report.
    await expect(survival).toContainText(en('common.dashPlaceholder'));
  });

  test('marks the active server and moves the mark on request', async ({ page, newApp }) => {
    const panel = await newApp({
      servers: (dirs) => [
        seed.minecraft(dirs, { name: 'Survival' }),
        seed.minecraft(dirs, { name: 'Creative' }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await expect(row(page, 'Survival')).toContainText(en('servers.activeLabel'));
    await expect(row(page, 'Creative')).not.toContainText(en('servers.activeLabel'));

    await serverRow(page, 'Creative').setActive.click();

    await expect(row(page, 'Creative')).toContainText(en('servers.activeLabel'));
    await expect(row(page, 'Survival')).not.toContainText(en('servers.activeLabel'));
    // The dock follows the registry.
    await expect(controlBar(page).picker).toContainText('Creative');
  });

  test('offers an empty state for a game with nothing registered', async ({ page, newApp }) => {
    const panel = await newApp({ servers: [] });
    await signInFast(page, panel);
    await openView(page, 'valheim', 'servers', { origin: panel.url });

    await expect(page.getByText(en('servers.emptyTitle'))).toBeVisible();
    await expect(page.getByRole('button', { name: en('servers.createNew') }).first()).toBeVisible();
  });
});

test.describe('registering', () => {
  test('refuses a folder that is not there', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    // Minecraft's "add existing" opens the adoption dialog, which inspects the
    // folder before anything is registered.
    await page.getByRole('button', { name: en('servers.addExisting') }).click();
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

    await page.getByRole('button', { name: en('servers.addExisting') }).click();
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

    await page.getByRole('button', { name: en('servers.addExisting') }).click();
    const form = dialog(page, en('portability.minecraftAdoptTitle'));
    await form.root.getByRole('textbox').first().fill(dir);
    await form.root.getByRole('button', { name: en('portability.inspect') }).click();

    // Detection succeeded: the name auto-fills from the folder name, the
    // server type is detected from the jar, and adoption registers it.
    await expect(form.root.getByRole('textbox').nth(1)).toHaveValue('adopted');
    await form.root.getByRole('button', { name: en('portability.minecraftAdopt') }).click();

    await expect(row(page, 'adopted')).toBeVisible();
    // And it is in the config, not just on screen.
    expect(panel.readConfig().servers.some((server) => server.name === 'adopted')).toBe(true);
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

    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
    const wizard = dialog(page, en('servers.createTitle'));

    await fieldByLabel(wizard.root, en('servers.fieldName')).fill('Wizard Made');
    await fieldByLabel(wizard.root, en('servers.fieldWorkingDirectory')).fill(workdir);
    await fieldByLabel(wizard.root, en('servers.fieldStartCommand')).fill(runnable.startCommand);
    await fieldByLabel(wizard.root, en('servers.fieldHealthCheckRegex')).fill('\\[fake\\] ready');
    await wizard.root.getByRole('button', { name: en('servers.createProcess') }).click();

    // Registered, and the config agrees.
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
     * instead of showing up as a row that mysteriously stayed put.
     */
    await serverRow(page, 'Wizard Made').remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    const [removal] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === 'DELETE' && response.url().includes('/api/servers/')),
      confirm.root.getByRole('button', { name: en('portability.removeProfile') }).click(),
    ]);
    expect(removal.status(), await removal.text()).toBe(200);

    await expect(row(page, 'Wizard Made')).toHaveCount(0);
    expect(panel.readConfig().servers.some((server) => server.name === 'Wizard Made')).toBe(false);
    // Keeping the files is the promise of that button, so they are still here.
    expect(fs.existsSync(workdir)).toBe(true);
  });

  /*
   * Custom processes have their own game section now, so the create button on
   * Minecraft used to open a two-option picker whose second option duplicated
   * it. Nothing stands between the button and the Minecraft form any more.
   */
  test('opens the Minecraft wizard with no kind to pick first', async ({ page, app }) => {
    await signInFast(page, app);
    // Stubbed so the wizard's version lookup never reaches PaperMC.
    await page.route('**/api/create/versions*', (route) => route.fulfill({ json: { versions: ['1.21.4'] } }));

    await openView(page, 'minecraft', 'servers');
    await page.getByRole('button', { name: en('servers.createNew') }).first().click();

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
    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
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

  test('renames a server from the edit dialog', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await serverRow(page, 'Survival').edit.click();
    const form = dialog(page, en('servers.editTitle'));
    await form.root.getByRole('textbox').first().fill('Survival Reborn');
    await form.root.getByRole('button', { name: en('common.save') }).click();

    await expect(row(page, 'Survival Reborn')).toBeVisible();
    expect(panel.readConfig().servers.some((server) => server.name === 'Survival Reborn')).toBe(true);
  });
});

test.describe('removing', () => {
  test('removes the profile and leaves the files alone', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await serverRow(page, 'Survival').remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    await confirm.root.getByRole('button', { name: en('portability.removeProfile') }).click();

    // The outcome, not the toast: a toast lives 3.5s and a loaded machine can
    // miss it, but the registry either lost the server or it did not.
    await expect(row(page, 'Survival')).toHaveCount(0);
    expect(panel.readConfig().servers.some((server) => server.name === 'Survival')).toBe(false);
    // The point of the default: the world is still on disk.
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('can also move the files to trash, which is recoverable', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'servers', { origin: panel.url });

    await serverRow(page, 'Survival').remove.click();
    const confirm = dialog(page, en('servers.removeTitle'));
    await confirm.root.getByText(en('portability.trashFilesLabel')).click();
    await confirm.root.getByRole('button', { name: en('portability.removeAndTrash') }).click();

    await expect(row(page, 'Survival')).toHaveCount(0);
    // Moved, not deleted: gone from where it was, still somewhere.
    expect(fs.existsSync(dir)).toBe(false);
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

  test('drives the same process from the dock', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'dashboard', { origin: panel.url });

    await waitForLiveConnection(page);
    const dock = controlBar(page);
    await expect(dock.status).toHaveText(en('status.offline'));

    await dock.start.click();
    await expect(dock.status).toHaveText(en('status.online'), LIFECYCLE);
    // Start gives way to restart and stop once it is up.
    await expect(dock.start).toHaveCount(0);
    await expect(dock.stop).toBeVisible();

    await dock.stop.click();
    await expect(dock.status).toHaveText(en('status.offline'), LIFECYCLE);
    await expect(dock.start).toBeVisible();
  });

  test('asks before a restart, because it kicks everyone', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'dashboard', { origin: panel.url });

    await waitForLiveConnection(page);
    const dock = controlBar(page);
    await dock.start.click();
    await expect(dock.status).toHaveText(en('status.online'), LIFECYCLE);

    await dock.restart.click();
    const confirm = dialog(page, en('header.restart'));
    await expect(confirm.root).toContainText(en('header.restartConfirm'));

    await confirm.root.getByRole('button', { name: en('header.restart') }).click();
    // It comes back up on its own.
    await expect(dock.status).toHaveText(en('status.online'), LIFECYCLE);
  });

  test('refuses to edit or remove a server while it is running', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'servers', { origin: panel.url });

    await waitForLiveConnection(page);
    const worker = row(page, 'Worker');
    await serverRow(page, 'Worker').start.click();
    await expect(worker.locator('.status-pill')).toHaveText(en('status.online'), LIFECYCLE);

    await serverRow(page, 'Worker').remove.click();
    await dialog(page, en('servers.removeTitle')).root
      .getByRole('button', { name: en('portability.removeProfile') }).click();

    await expect(toasts(page).withText(en('errors.stopBeforeRemove'))).toBeVisible();
    await expect(row(page, 'Worker')).toBeVisible();
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
    // grants cannot even enumerate the fleet.
    await expect(page.getByText(en('servers.emptyTitle'))).toBeVisible();
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
    await expect(page.getByRole('button', { name: en('servers.createNew') })).toHaveCount(0);
    await expect(serverRow(page, 'Survival').edit).toHaveCount(0);
    await expect(serverRow(page, 'Survival').remove).toHaveCount(0);
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
    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
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
    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
    const wizard = minecraftWizard(page);
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
    await page.getByRole('button', { name: en('servers.createNew') }).first().click();
    const wizard = minecraftWizard(page);
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



