'use strict';

/*
 * Server tools should expose only controls that have a visible, working
 * destination. Non-functional panel-local branding controls are not offered.
 */

const { test, expect } = require('../support/fixtures.cjs');
const { serverRow, serverTools } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

async function openTools(page, panel, game, name) {
  await signInFast(page, panel);
  await openView(page, game, 'servers', { origin: panel.url });
  await serverRow(page, name).tools.click();
  const tools = serverTools(page);
  await expect(tools.root).toBeVisible();
  return tools;
}

test.describe('server tools', () => {
  test('does not expose server tools for Minecraft', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'servers', { origin: app.url });
    await expect(serverRow(page, 'Survival').tools).toHaveCount(0);
  });

  test('keeps Palworld tools limited to connectivity and profile', async ({ page, app }) => {
    const tools = await openTools(page, app, 'palworld', 'Pal Camp');

    await expect(tools.tabs).toBeVisible();
    await expect(tools.tab('tabConnectivity')).toBeVisible();
    await expect(tools.tab('tabProfile')).toBeVisible();
    await expect(tools.tabs.getByRole('tab')).toHaveCount(2);
  });
});
