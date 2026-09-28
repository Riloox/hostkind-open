'use strict';

/*
 * Presets in the create wizards (src/lib/serverPresets.js, PresetPicker.jsx).
 *
 * A preset is only form values: choosing one fills the form, every field stays
 * editable, the highlighted preset is whichever the form still matches, and a
 * suggested name follows the preset until the user types their own. The unit
 * test (test/server-presets.test.cjs) holds every preset inside what
 * POST /api/create accepts; this spec proves the wizard shows and sends them.
 *
 * Nothing is installed. Version lists are stubbed (they are resolved upstream),
 * and the one submission is answered with a stream error after its body has
 * been read.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { minecraftWizard, presetButton, fieldByLabel } = require('../support/pages.cjs');
const { signInFast, openView, startAddServer, openMoreOptions } = require('../support/actions.cjs');

const presetName = (game, preset) => en('serverPresets.name', { game: en(`games.${game}`), preset: en(`serverPresets.${game}.${preset}.title`) });

// The preset that is highlighted, or none: exactly one button may be pressed.
async function expectPressed(root, id) {
  const pressed = root.locator('[data-server-preset][aria-pressed="true"]');
  if (id) {
    await expect(pressed).toHaveCount(1);
    await expect(pressed).toHaveAttribute('data-server-preset', id);
  } else {
    await expect(pressed).toHaveCount(0);
  }
}

async function openMinecraftWizard(page, app) {
  await page.route('**/api/create/versions*', (route) => {
    const type = new URL(route.request().url()).searchParams.get('type');
    return route.fulfill({ json: { versions: type === 'fabric' ? ['1.21.1'] : ['1.21.4', '1.21.3'] } });
  });
  await signInFast(page, app);
  await openView(page, 'minecraft', 'servers');
  await startAddServer(page, 'minecraft');
  const wizard = minecraftWizard(page);
  await expect(wizard.version).toHaveValue('1.21.4');
  return wizard;
}

test.describe('create presets', () => {
  test('the Minecraft wizard opens on Survival and a preset fills the form', async ({ page, app }) => {
    const wizard = await openMinecraftWizard(page, app);
    const { root } = wizard;
    const name = fieldByLabel(root, en('servers.fieldName'));
    const gamemode = root.getByLabel(en('serverRules.gamemode'));
    const difficulty = root.getByLabel(en('servers.fieldDifficulty'));

    await expectPressed(root, 'survival');
    await expect(name).toHaveValue(presetName('minecraft', 'survival'));
    await expect(wizard.type).toHaveValue('paper');

    // Hardcore is one life on hard: the game mode and difficulty are fixed.
    await presetButton(root, 'hardcore').click();
    await expectPressed(root, 'hardcore');
    await expect(root.getByLabel(en('serverRules.hardcore'))).toBeChecked();
    await expect(difficulty).toHaveValue('hard');
    await expect(difficulty).toBeDisabled();
    await expect(gamemode).toBeDisabled();
    await expect(name).toHaveValue(presetName('minecraft', 'hardcore'));

    // A mod-loader preset switches the server type, so the version list is
    // resolved again for that type.
    await presetButton(root, 'fabric').click();
    await expectPressed(root, 'fabric');
    await expect(wizard.type).toHaveValue('fabric');
    await expect(wizard.version).toHaveValue('1.21.1');
    await expect(root.getByLabel(en('serverRules.hardcore'))).not.toBeChecked();
    await expect(difficulty).toBeEnabled();

    // Editing a field the preset set means the form is no longer that preset.
    await difficulty.selectOption('peaceful');
    await expectPressed(root, null);
    await expect(wizard.type).toHaveValue('fabric');
  });

  test('a name you typed survives switching presets', async ({ page, app }) => {
    const { root } = await openMinecraftWizard(page, app);
    const name = fieldByLabel(root, en('servers.fieldName'));

    await name.fill('Our World');
    await presetButton(root, 'creative').click();

    await expectPressed(root, 'creative');
    await expect(root.getByLabel(en('serverRules.gamemode'))).toHaveValue('creative');
    await expect(name).toHaveValue('Our World');
  });

  test('the wizard sends the preset rules and no folder by default', async ({ page, app }) => {
    const wizard = await openMinecraftWizard(page, app);
    const { root } = wizard;

    await presetButton(root, 'hardcore').click();

    // No folder picked means Hostkind's own; the field says where that is.
    await openMoreOptions(root);
    const parent = fieldByLabel(root, en('servers.fieldParent'));
    await expect(parent).toHaveValue('');
    await expect(parent).toHaveAttribute('placeholder', /Hostkind Servers/);

    let sent = null;
    await page.route((url) => url.pathname === '/api/create', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sent = route.request().postDataJSON();
      return route.fulfill({
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'error', error: 'stopped by the test' })}\n`,
      });
    });

    await root.getByLabel(en('minecraft.servers.eula')).check();
    await wizard.submit.click();
    await expect(root.getByText('stopped by the test')).toBeVisible();

    expect(sent).toMatchObject({
      name: presetName('minecraft', 'hardcore'),
      type: 'paper',
      mcVersion: '1.21.4',
      gamemode: 'survival',
      difficulty: 'hard',
      hardcore: true,
      parentDir: '',
      eula: true,
    });
  });

  test('Valheim presets set the world difficulty and who can join', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'valheim');
    const { root } = minecraftWizard(page);
    const world = root.getByLabel(en('serverPresets.valheimWorld'));
    const listed = root.getByLabel(en('servers.fieldPublic'));

    await expectPressed(root, 'friends');
    // Valheim will not start without a join password, so one is made up.
    await expect(fieldByLabel(root, en('servers.fieldPassword'))).not.toHaveValue('');

    await presetButton(root, 'relaxed').click();
    await expect(world).toHaveValue('casual');
    await expect(listed).not.toBeChecked();

    await presetButton(root, 'public').click();
    await expectPressed(root, 'public');
    await expect(world).toHaveValue('normal');
    await expect(listed).toBeChecked();
    await expect(fieldByLabel(root, en('servers.fieldName'))).toHaveValue(presetName('valheim', 'public'));
  });

  test('Palworld presets set the death penalty, rates and PvP', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'palworld');
    const { root } = minecraftWizard(page);

    await expectPressed(root, 'friends');
    await presetButton(root, 'relaxed').click();
    await expect(root.getByLabel(en('serverRules.deathPenalty'))).toHaveValue('None');
    await expect(root.getByLabel(en('serverRules.expRate'))).toHaveValue('2');
    await expect(root.getByLabel(en('serverRules.captureRate'))).toHaveValue('2');

    await presetButton(root, 'pvp').click();
    await expect(root.getByLabel(en('serverRules.deathPenalty'))).toHaveValue('ItemAndEquipment');
    await expect(root.getByLabel(en('serverRules.pvp'))).toBeChecked();
    await expect(root.getByLabel(en('serverRules.expRate'))).toHaveValue('1');
    await expect(fieldByLabel(root, en('servers.fieldMaxPlayers'))).toHaveValue('16');
  });

  test('a Terraria preset can switch the variant, and its versions follow', async ({ page, app }) => {
    const variants = [];
    await page.route('**/api/terraria/versions*', (route) => {
      const variant = new URL(route.request().url()).searchParams.get('variant');
      variants.push(variant);
      return route.fulfill({ json: { variant, versions: [{ id: `${variant}-1`, gameVersion: '1.4.5', supported: true }] } });
    });
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers');
    await startAddServer(page, 'terraria');
    const { root } = minecraftWizard(page);
    const version = root.locator('#terraria-version');
    // The variant picker's buttons, not the presets (whose hints name variants too).
    const variant = (key) => root.locator('button[aria-pressed]:not([data-server-preset])', { hasText: en(`terraria.variant.${key}`) });

    await expectPressed(root, 'classic');
    await expect(version).toHaveValue('vanilla-1');

    // Community runs TShock: the variant changes and its own builds load.
    await presetButton(root, 'community').click();
    await expectPressed(root, 'community');
    await expect(variant('tshock')).toHaveAttribute('aria-pressed', 'true');
    await expect(version).toHaveValue('tshock-1');
    await expect(fieldByLabel(root, en('servers.fieldMaxPlayers'))).toHaveValue('32');
    expect(variants).toEqual(['vanilla', 'tshock']);
  });
});
