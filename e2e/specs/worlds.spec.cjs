'use strict';

/*
 * The worlds view, which is really three views behind one route: Minecraft's
 * folder-per-world, Terraria's file-per-world, and Valheim's .db/.fwl pair.
 * All three are seeded on disk, so what shows up here is what is really there.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { appShell } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

test.describe('worlds', () => {
  test('lists the configured Minecraft worlds and their sizes', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'worlds');

    await expect(page.getByRole('heading', { name: en('minecraft.worlds.title'), exact: true })).toBeVisible();
    // Each world's name appears twice on its card - as the title and as the
    // folder underneath it - so this only asks that it is on screen at all.
    for (const world of ['world', 'world_nether', 'world_the_end']) {
      await expect(page.getByText(world, { exact: true }).first()).toBeVisible();
    }
    // Three of them exist on disk, and the summary agrees.
    await expect(page.getByText(en('minecraft.worlds.summaryWorlds'))).toBeVisible();
  });

  test('labels each world with its dimension', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'worlds');

    await expect(page.getByText(en('minecraft.worlds.dimension.overworld'), { exact: true }).first()).toBeVisible();
    await expect(page.getByText('worlds.dimension.overworld')).toHaveCount(0);
  });

  test('flags a configured world that is not on disk', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [
        // Configured for four, but only the first three were ever created.
        Object.assign(seed.minecraft(dirs, { name: 'Survival' }), {
          worlds: ['world', 'world_nether', 'world_the_end', 'world_missing'],
        }),
      ],
    });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'worlds', { origin: panel.url });

    await expect(page.getByText('world_missing', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(en('minecraft.worlds.missing')).first()).toBeVisible();
  });

  test('reads a Terraria world file well enough to name it', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'terraria', 'worlds');

    // The seeded .wld carries a real header, so the panel can read the name
    // out of the file rather than guessing from the filename.
    await expect(page.getByText('Fixture').first()).toBeVisible();
  });

  test('reaches the Valheim worlds view', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'valheim', 'worlds');

    await expect(page).toHaveURL(/\/games\/valheim\/worlds$/);
    // The world name appears on its card and in the dock's server picker.
    await expect(page.getByText('Midgard', { exact: true }).first()).toBeVisible();
  });

  test('offers Valheim a working Worlds sidebar entry', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'valheim', 'dashboard');

    const worlds = appShell(page).navItem('worlds');
    // Natively disabled when there is nothing to show (Sidebar renders
    // disabled=, not aria-disabled=, so assert the enabled state directly).
    await expect(worlds).toBeEnabled();

    await worlds.click();

    await expect(page).toHaveURL(/\/games\/valheim\/worlds$/);
    await expect(page.getByText('Midgard', { exact: true }).first()).toBeVisible();
  });

  test('is not offered for a game with no world model', async ({ page, app }) => {
    await signInFast(page, app);
    // "Other processes" have files, not worlds.
    await openView(page, 'custom', 'worlds');

    await expect(page).toHaveURL(/\/games\/custom\/dashboard$/);
  });
});
