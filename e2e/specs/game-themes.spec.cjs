'use strict';

/*
 * Per-game custom colours: config.gameAccents retints a game's whole ramp.
 * The unit tests in test/branding.test.cjs prove the derivation rules; this
 * spec proves the values actually reach the document when the game is entered.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { appShell, panelSettings } = require('../support/pages.cjs');

/*
 * Read a custom property back from the document. Not compared as a string:
 * the browser normalises an OKLCH triple when it round-trips through the
 * cascade ("74.0%" comes back as "74"), so parse into floats first.
 */
async function accentToken(page, token) {
  const raw = await page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);
  return raw.split(/\s+/).map((part) => parseFloat(part));
}

test.describe('per-game custom colours', () => {
  test('a configured game theme repaints the ramp on entry', async ({ page, newApp }) => {
    const panel = await newApp({ config: (config) => { config.gameAccents = { terraria: '#3b82f6' }; } });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });

    // ember-5 is the accent voice: hue = base (#3b82f6 -> 259.81) + 12, L 74.
    const ember5 = await accentToken(page, '--ember-5');
    expect(ember5[0]).toBe(74);
    expect(Math.abs(ember5[2] - 271.8)).toBeLessThan(1.5);
    // Coal follows the game hue too (base + 20), not the default 40.
    const coal3 = await accentToken(page, '--coal-3');
    expect(Math.abs(coal3[2] - 279.8)).toBeLessThan(1.5);
  });

  test('an unconfigured game keeps its built-in theme', async ({ page, newApp }) => {
    const panel = await newApp({ config: (config) => { config.gameAccents = { terraria: '#3b82f6' }; } });
    await signInFast(page, panel);
    await openView(page, 'valheim', 'dashboard', { origin: panel.url });

    // Built-in valheim ember-5 after the violet-blue re-tune (tokens.css).
    expect(await accentToken(page, '--ember-5')).toEqual([74, 0.131, 280]);
  });

  test('switching games swaps the theme without leaking', async ({ page, newApp }) => {
    const panel = await newApp({ config: (config) => { config.gameAccents = { terraria: '#3b82f6', palworld: '#d6409f' }; } });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });
    expect(Math.abs((await accentToken(page, '--ember-5'))[2] - 271.8)).toBeLessThan(1.5);

    // A direct URL navigation re-enters under palworld; its hue must win and
    // terraria's must not leak (the inline tokens are removed first).
    await openView(page, 'palworld', 'dashboard', { origin: panel.url });
    expect(Math.abs((await accentToken(page, '--ember-5'))[2] - 358.0)).toBeLessThan(1.5);
  });

  test('an unusable colour leaves the built-in theme alone', async ({ page, newApp }) => {
    const panel = await newApp({ config: (config) => { config.gameAccents = { terraria: '#000000' }; } });
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });

    // Near-black cannot carry a hue; the panel keeps the built-in sky ramp.
    expect(await accentToken(page, '--ember-5')).toEqual([74, 0.123, 210]);
  });

  test('the Settings picker retints the document without a restart', async ({ page, newApp }) => {
    const panel = await newApp(); // no gameAccents configured
    await signInFast(page, panel);
    await openView(page, 'terraria', 'dashboard', { origin: panel.url });
    expect(await accentToken(page, '--ember-5')).toEqual([74, 0.123, 210]); // built-in sky

    // Profile menu -> Hostkind settings -> Game colours.
    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();
    const colours = panelSettings(page).group('game-colors');
    await expect(colours).toBeVisible();

    const terrariaRow = colours.getByText(en('games.terraria'), { exact: true })
      .locator('xpath=ancestor::div[contains(@class, "space-y-1.5")]');
    await terrariaRow.getByRole('button', { name: en('portability.accentSwatch', { value: '#3b82f6' }), exact: true }).click();

    // The debounced PUT round-trips through context and the theme re-applies:
    // the document retints without a restart or reload.
    await expect(async () => {
      const [l, c, h] = await accentToken(page, '--ember-5');
      expect(l).toBe(74);
      expect(Math.abs(h - 271.8)).toBeLessThan(1.5);
    }).toPass();

    // Persisted: the panel's own config.json on disk carries the hex.
    expect(panel.readConfig().gameAccents.terraria).toBe('#3b82f6');
  });

  test('operators do not see the game-colour section', async ({ page, newApp }) => {
    const panel = await newApp(); // seeds ADMIN + OPERATOR
    await signInFast(page, panel, panel.operator);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await appShell(page).profileButton.click();
    await appShell(page).menuSettings.click();
    await expect(panelSettings(page).group('language')).toBeVisible();

    await expect(panelSettings(page).group('game-colors')).toHaveCount(0);
  });
});
