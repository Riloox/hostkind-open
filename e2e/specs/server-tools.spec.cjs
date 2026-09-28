'use strict';

/*
 * Server tools should expose only controls that have a visible, working
 * destination. Non-functional panel-local branding controls are not offered.
 * They open from the server's Settings -> General.
 */

const { test, expect } = require('../support/fixtures.cjs');
const { generalSettings, serverTools } = require('../support/pages.cjs');
const { signInFast, openGeneralSettings } = require('../support/actions.cjs');

async function openTools(page, panel, name) {
  await signInFast(page, panel);
  await openGeneralSettings(page, panel, name);
  await generalSettings(page).tools.click();
  const tools = serverTools(page);
  await expect(tools.root).toBeVisible();
  return tools;
}

test.describe('server tools', () => {
  test('does not expose server tools for Minecraft', async ({ page, app }) => {
    await signInFast(page, app);
    await openGeneralSettings(page, app, 'Survival');
    // The page is there (its Remove button is), the tools are not.
    await expect(generalSettings(page).remove).toBeVisible();
    await expect(generalSettings(page).tools).toHaveCount(0);
  });

  test('keeps Palworld tools limited to connectivity and profile', async ({ page, app }) => {
    const tools = await openTools(page, app, 'Pal Camp');

    await expect(tools.tabs).toBeVisible();
    await expect(tools.tab('tabConnectivity')).toBeVisible();
    await expect(tools.tab('tabProfile')).toBeVisible();
    await expect(tools.tabs.getByRole('tab')).toHaveCount(2);
  });
});
