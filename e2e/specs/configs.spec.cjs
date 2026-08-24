'use strict';

/*
 * The config editor. Saving really rewrites the file in the seeded server
 * folder (and leaves the .bak the panel promises), so each test checks the
 * disk as well as the screen.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { toasts, dialog } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

test.describe('config editor', () => {
  test('opens server.properties in the friendly editor', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'configs');

    await expect(page.getByText(en('configs.title'))).toBeVisible();
    await expect(page.getByRole('button', { name: 'server.properties' })).toBeVisible();

    // The friendly editor labels each key in plain language rather than
    // showing the raw file, and fills the field from what is on disk.
    await expect(page.getByText(en('minecraft.configs.field.motd.label'))).toBeVisible();
    await expect(page.locator('#cfg-motd')).toHaveValue('A Hostkind test server');
    await expect(page.locator('#cfg-max-players')).toHaveValue('20');
  });

  test('switches between the friendly and raw views', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'configs');

    await page.getByRole('button', { name: en('configs.switchToRaw') }).click();

    // Raw shows the file as it is written.
    const raw = page.locator('textarea').first();
    await expect(raw).toContainText('motd=A Hostkind test server');

    await page.getByRole('button', { name: en('configs.switchToFriendly') }).click();
    await expect(page.locator('textarea')).toHaveCount(0);
  });

  test('shows a diff before it writes anything', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'configs', { origin: panel.url });

    await page.getByRole('button', { name: en('configs.switchToRaw') }).click();
    const raw = page.locator('textarea').first();
    await raw.fill('motd=A different message\nmax-players=32\n');

    // The change is held until it is confirmed.
    await expect(page.getByText(en('configs.unsavedChanges'))).toBeVisible();
    await page.getByRole('button', { name: en('common.save') }).click();

    const diff = dialog(page, 'Changes to server.properties');
    await expect(diff.root).toContainText('max-players=32');
  });

  test('saves the file and keeps a .bak beside it', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'configs', { origin: panel.url });

    await page.getByRole('button', { name: en('configs.switchToRaw') }).click();
    await page.locator('textarea').first().fill('motd=Saved from the browser\n');
    await page.getByRole('button', { name: en('common.save') }).click();

    const diff = dialog(page, 'Changes to server.properties');
    await diff.root.getByRole('button', { name: en('common.save') }).click();

    await expect(toasts(page).withText('Saved')).toBeVisible();
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toContain('Saved from the browser');
    // The panel promises a .bak in the same breath as the save. It is stamped
    // with the time, which is what makes the History dropdown possible.
    const backups = fs.readdirSync(dir).filter((name) => /^server\.properties\..+\.bak$/.test(name));
    expect(backups).toHaveLength(1);
  });

  test('throws away an edit on reset', async ({ page, newApp }) => {
    const panel = await newApp();
    const dir = panel.server('Survival').dir;
    const before = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'configs', { origin: panel.url });

    await page.getByRole('button', { name: en('configs.switchToRaw') }).click();
    await page.locator('textarea').first().fill('motd=Never mind\n');
    await page.getByRole('button', { name: en('configs.resetChanges') }).click();

    await expect(page.getByText(en('configs.unsavedChanges'))).toHaveCount(0);
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toBe(before);
  });

  test('gives Terraria its own editor', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'terraria', 'configs');

    // Terraria's serverconfig.txt is not server.properties, and the view says so.
    await expect(page.getByRole('button', { name: en('configs.switchToRaw') })).toHaveCount(0);
    await expect(page.getByText(en('configs.title'))).toBeVisible();
  });

  test('gives Palworld its structured settings editor', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'palworld', 'configs');

    // The `configs` capability used to be withheld from the Palworld module,
    // which left its settings editor unreachable (the route guard bounced and
    // the sidebar entry never appeared). Now it is offered, and the view is
    // the structured editor, not the raw file pane.
    await expect(page).toHaveURL(/\/games\/palworld\/configs$/);
    await expect(page.getByText(en('configs.title'))).toBeVisible();
    await expect(page.getByText(en('palworldSettings.syntaxValid'))).toBeVisible();
    await expect(page.getByText(en('configs.switchToRaw'))).toHaveCount(0);
  });

  test('is not offered for a game that has no config surface', async ({ page, app }) => {
    await signInFast(page, app);
    // Valheim's module declares no `configs` capability, so a typed URL is
    // bounced. Note the bounce is silent on a cold load - the "not supported"
    // toast only fires for in-app navigation, and the sidebar disables the
    // entry there anyway.
    await openView(page, 'valheim', 'configs');

    await expect(page).toHaveURL(/\/games\/valheim\/dashboard$/);
    await expect(page.getByText(en('configs.title'))).toHaveCount(0);
  });
});
