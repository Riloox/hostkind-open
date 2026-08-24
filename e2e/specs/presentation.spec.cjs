'use strict';

/*
 * Panel presentation: the icon, banner, and accent an operator pins to a
 * server from the wrench dialog.
 *
 * test/portability-safety.test.cjs proves the assets are validated, stripped,
 * and stored outside the game root. What it cannot see is the part the
 * operator actually deals with: whether the tile shows them the image they
 * just uploaded, whether the accent they picked stuck, and whether a game with
 * nothing but presentation to offer gets a tab strip it cannot use.
 */

const path = require('path');
const { test, expect, en } = require('../support/fixtures.cjs');
const { serverRow, serverTools } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const seed = require('../support/seed.cjs');

// A real PNG the repo already ships: 256x256, 2 KB, inside both the icon and
// the banner limits. Uploading bytes assembled in the spec would prove the
// route accepts them but not that the preview decodes.
const IMAGE = path.join(__dirname, '..', '..', 'resources', 'hostkind_face.png');

/** Open the wrench dialog on a server row and return its locators. */
async function openTools(page, panel, game, name) {
  await signInFast(page, panel);
  await openView(page, game, 'servers', { origin: panel.url });
  await serverRow(page, name).tools.click();
  const tools = serverTools(page);
  await expect(tools.root).toBeVisible();
  return tools;
}

test.describe('the tools dialog', () => {
  test('gives a Minecraft server presentation with no tab strip to choose from', async ({ page, app }) => {
    const tools = await openTools(page, app, 'minecraft', 'Survival');

    // Presentation is the only tab this game has, so there is no tab strip:
    // a lone tab is a control that cannot do anything.
    await expect(tools.tabs).toHaveCount(0);
    await expect(tools.root).toContainText(en('portability.presentationScope'));
    await expect(tools.icon.tile).toBeVisible();
    await expect(tools.banner.tile).toBeVisible();
  });

  test('gives a Palworld server the connectivity and profile tabs as well', async ({ page, app }) => {
    const tools = await openTools(page, app, 'palworld', 'Pal Camp');

    await expect(tools.tabs).toBeVisible();
    await expect(tools.tab('tabConnectivity')).toBeVisible();
    await expect(tools.tab('tabProfile')).toBeVisible();
    await tools.tab('tabPresentation').click();
    await expect(tools.icon.tile).toBeVisible();
  });
});

test.describe('presentation', () => {
  test('says what each tile takes before anything is uploaded', async ({ page, app }) => {
    const tools = await openTools(page, app, 'minecraft', 'Survival');

    // An empty tile has to answer "what goes here?" on its own - it is the
    // only affordance in the block.
    await expect(tools.icon.block).toContainText(en('portability.iconHint'));
    await expect(tools.banner.block).toContainText(en('portability.bannerHint'));
    await expect(tools.icon.block).toContainText(en('portability.imageDropHint'));
    await expect(tools.icon.preview).toHaveCount(0);
    await expect(tools.icon.remove).toHaveCount(0);
    await expect(tools.root).toContainText(en('portability.accentNone'));
    // Nothing has been set, so there is nothing to reset.
    await expect(tools.reset).toBeDisabled();
  });

  test('previews an uploaded icon, and reports what was stored', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Survival' })] });
    const tools = await openTools(page, panel, 'minecraft', 'Survival');

    await tools.icon.file.setInputFiles(IMAGE);

    const preview = tools.icon.preview;
    await expect(preview).toBeVisible();
    // A broken <img> is worse than the empty tile it replaced.
    expect(await preview.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(tools.icon.block).toContainText('256×256');
    await expect(tools.icon.block).toContainText(en('portability.metadataStripped'));
    // The banner is a separate asset and stays empty.
    await expect(tools.banner.preview).toHaveCount(0);

    await tools.icon.remove.click();
    await expect(tools.icon.preview).toHaveCount(0);
    await expect(tools.icon.tile).toBeVisible();
  });

  test('keeps the icon across a reopen, and drops it on reset', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Survival' })] });
    const tools = await openTools(page, panel, 'minecraft', 'Survival');

    await tools.icon.file.setInputFiles(IMAGE);
    await expect(tools.icon.preview).toBeVisible();
    await tools.close.click();
    await expect(tools.root).toHaveCount(0);

    await serverRow(page, 'Survival').tools.click();
    const reopened = serverTools(page);
    await expect(reopened.icon.preview).toBeVisible();

    await reopened.reset.click();
    await expect(reopened.icon.preview).toHaveCount(0);
    await expect(reopened.reset).toBeDisabled();
  });

  test('sets an accent from a swatch and clears it again', async ({ page, newApp }) => {
    const panel = await newApp({ servers: (dirs) => [seed.minecraft(dirs, { name: 'Survival' })] });
    const tools = await openTools(page, panel, 'minecraft', 'Survival');

    await tools.accentSwatch('#3b82f6').click();
    // The chosen colour is printed, not just shown: an operator copying it into
    // their own theme needs the hex, and a swatch alone is not readable.
    await expect(tools.root).toContainText('#3b82f6');
    await expect(tools.accentSwatch('#3b82f6')).toHaveAttribute('aria-pressed', 'true');
    await expect(tools.reset).toBeEnabled();

    await tools.reset.click();
    await expect(tools.root).toContainText(en('portability.accentNone'));
    await expect(tools.accentSwatch('#3b82f6')).toHaveAttribute('aria-pressed', 'false');
  });
});
