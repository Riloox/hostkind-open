'use strict';

const { test, expect } = require('../support/fixtures.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { appShell, panelSettings } = require('../support/pages.cjs');

function statusFor(phase) {
  return {
    ok: true,
    status: {
      state: phase,
      currentVersion: '0.1.1',
      platformKey: 'windows-x64',
      checkedAt: '2026-08-25T12:00:00.000Z',
      update: {
        version: '0.1.2',
        priority: 'normal',
        releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v0.1.2',
      },
    },
  };
}

test('admin can review and explicitly approve a normal application update', async ({ page, newApp }) => {
  const panel = await newApp();
  let phase = 'available';
  let installBody = null;

  await page.route('**/api/application-update/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(statusFor(phase)),
  }));
  await page.route('**/api/application-update/download', (route) => {
    phase = 'ready';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statusFor(phase)),
    });
  });
  await page.route('**/api/application-update/install', async (route) => {
    installBody = JSON.parse(route.request().postData() || '{}');
    phase = 'restarting';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statusFor(phase)),
    });
  });

  await signInFast(page, panel);
  await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
  const shell = appShell(page);
  await shell.profileButton.click();
  await shell.menuSettings.click();
  // App updates is its own tab of Hostkind settings.
  await panelSettings(page).tab('updates').click();
  await expect(page).toHaveURL(/\/settings\/updates$/);

  await expect(page.getByTestId('application-update-section')).toBeVisible();
  await expect(page.getByText('0.1.2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download update', exact: true })).toBeVisible();
  expect(installBody).toBeNull();

  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install update', exact: true })).toBeVisible();
  expect(installBody).toBeNull();

  await page.getByRole('button', { name: 'Install update', exact: true }).click();
  await expect.poll(() => installBody).toEqual({ approved: true });
  await expect(page.getByTestId('application-update-section').getByText('Restarting Hostkind', { exact: true })).toBeVisible();
});
