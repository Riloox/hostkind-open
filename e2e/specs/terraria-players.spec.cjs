'use strict';

const { test, expect, en } = require('../support/fixtures.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

/*
 * This is intentionally an offline fixture: the behavior under test is the
 * Terraria surface selection and its absence of Minecraft-only requests. The
 * normalized live roster itself is covered by test/terraria-players.test.cjs.
 */
test('Terraria Players uses a game-specific empty roster surface', async ({ page, app }) => {
  const minecraftRequests = [];
  page.on('request', (request) => {
    if (/\/api\/(?:playerlists|whitelist|players\/lookup)(?:\/|\?|$)/.test(request.url())) {
      minecraftRequests.push(request.url());
    }
  });

  await signInFast(page, app);
  await openView(page, 'terraria', 'players');

  await expect(page.getByTestId('terraria-players-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: en('terraria.players.title'), exact: true })).toBeVisible();
  await expect(page.getByTestId('terraria-players-empty')).toBeVisible();
  await expect(page.getByRole('button', { name: en('minecraft.players.makeOp'), exact: true })).toHaveCount(0);
  await expect(page.locator('img[src*="minotar.net"]')).toHaveCount(0);
  expect(minecraftRequests).toEqual([]);
});
