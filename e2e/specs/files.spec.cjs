'use strict';

/*
 * The file manager, against a real server folder in a temp directory. Every
 * mutation here lands on disk, so each test asserts twice: what the browser
 * shows, and what is actually in the folder afterwards.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { toasts, dialog, tableRow } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

const entry = (page, name) => tableRow(page, name);
const search = (page) => page.getByPlaceholder(en('files.searchPlaceholder'));

test.describe('file manager', () => {
  test('lists the server folder', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'files');

    // The seeded Minecraft tree, as the panel sees it.
    await expect(entry(page, 'server.properties')).toBeVisible();
    await expect(entry(page, 'plugins')).toBeVisible();
    await expect(entry(page, 'world')).toBeVisible();
    await expect(entry(page, 'server.jar')).toBeVisible();
  });

  test('walks into a folder and back out again', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'files');

    await entry(page, 'plugins').click();

    await expect(entry(page, 'EssentialsX.jar')).toBeVisible();
    await expect(entry(page, 'server.properties')).toHaveCount(0);

    await page.getByRole('button', { name: en('files.up'), exact: true }).click();
    await expect(entry(page, 'server.properties')).toBeVisible();
  });

  test('filters the listing by name', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'files');

    await search(page).fill('properties');
    await expect(entry(page, 'server.properties')).toBeVisible();
    await expect(entry(page, 'plugins')).toHaveCount(0);

    await search(page).fill('nothing-is-called-this');
    await expect(page.getByText(en('files.emptySearch'))).toBeVisible();
  });

  test('edits a file and writes it to disk', async ({ page, newApp }) => {
    const panel = await newApp();
    const file = path.join(panel.server('Survival').dir, 'server.properties');
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    await entry(page, 'server.properties').getByLabel(en('files.edit')).click();
    const editor = dialog(page, 'server.properties');
    const textarea = editor.root.locator('textarea');
    await expect(textarea).toContainText('motd=A Hostkind test server');

    await textarea.fill('motd=Edited from the browser\n');
    await editor.root.getByRole('button', { name: en('common.save') }).click();

    await expect(toasts(page).withText(en('files.savedToast'))).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe('motd=Edited from the browser\n');
  });

  test('will not save an edit that changed nothing', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'files');

    await entry(page, 'server.properties').getByLabel(en('files.edit')).click();
    const editor = dialog(page, 'server.properties');

    // Nothing typed yet, so there is nothing to save.
    await expect(editor.root.getByRole('button', { name: en('common.save') })).toBeDisabled();
  });

  test('creates a folder', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    await page.getByRole('button', { name: en('files.folder'), exact: true }).click();
    const prompt = dialog(page, en('files.folder'));
    await prompt.root.getByRole('textbox').fill('datapacks');
    await prompt.root.getByRole('button', { name: en('common.add') }).click();

    await expect(entry(page, 'datapacks')).toBeVisible();
    expect(fs.existsSync(path.join(panel.server('Survival').dir, 'datapacks'))).toBe(true);
  });

  test('renames a file', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    await entry(page, 'eula.txt').getByLabel(en('files.rename')).click();
    const prompt = dialog(page, en('files.rename'));
    await prompt.root.getByRole('textbox').fill('eula.txt.bak');
    await prompt.root.getByRole('button', { name: en('common.save') }).click();

    await expect(entry(page, 'eula.txt.bak')).toBeVisible();
    expect(fs.existsSync(path.join(dir, 'eula.txt.bak'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'eula.txt'))).toBe(false);
  });

  test('deletes a file, but asks first', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    await entry(page, 'ops.json').getByLabel(en('common.delete')).click();

    const confirm = dialog(page, en('files.deleteTitle'));
    await expect(confirm.root).toContainText('ops.json');
    await confirm.root.getByRole('button', { name: en('common.delete') }).click();

    await expect(toasts(page).withText(en('files.deletedToast'))).toBeVisible();
    await expect(entry(page, 'ops.json')).toHaveCount(0);
    expect(fs.existsSync(path.join(dir, 'ops.json'))).toBe(false);
  });

  test('leaves the file alone when the delete is cancelled', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'files', { origin: panel.url });

    await entry(page, 'ops.json').getByLabel(en('common.delete')).click();
    await dialog(page, en('files.deleteTitle')).root
      .getByRole('button', { name: en('common.cancel') }).click();

    await expect(entry(page, 'ops.json')).toBeVisible();
    expect(fs.existsSync(path.join(dir, 'ops.json'))).toBe(true);
  });

  test('stays inside the server folder', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'files');
    await expect(entry(page, 'server.properties')).toBeVisible();

    // Ask the API directly for something above the root. The view has no way
    // to request this, which is exactly why it is worth checking.
    const escaped = await page.evaluate(async (token) => {
      const response = await fetch(`/api/files?path=${encodeURIComponent('../../..')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status };
    }, await page.evaluate(() => window.localStorage.getItem('fleetdeck_token')));

    expect(escaped.status).toBeGreaterThanOrEqual(400);
  });
});
