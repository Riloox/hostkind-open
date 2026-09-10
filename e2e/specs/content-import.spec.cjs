const { test, expect } = require('../support/fixtures.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

test('import dialog separates sources and validates FTB details at desktop and mobile sizes', async ({ page, app }) => {
  await signInFast(page, app);
  await openView(page, 'minecraft', 'content');
  await page.getByRole('tab', { name: 'Modpacks', exact: true }).click();
  await expect(page.getByText('FTB pack ID', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Import modpack', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: 'Choose ZIP file' })).toBeVisible();
  await modal.getByRole('tab', { name: 'FTB installer', exact: true }).click();
  const upload = modal.getByRole('button', { name: 'Choose FTB installer', exact: true });
  await expect(upload).toBeDisabled();
  await modal.getByLabel('FTB pack ID', { exact: true }).fill('123');
  await modal.getByRole('checkbox', { name: 'I downloaded this installer' }).check();
  await modal.getByRole('checkbox', { name: 'I accept the Minecraft EULA' }).first().check();
  await expect(upload).toBeEnabled();
  await modal.getByLabel('Pack version', { exact: true }).selectOption('specific');
  await expect(upload).toBeDisabled();
  await modal.getByLabel('FTB version ID', { exact: true }).fill('abc');
  await expect(upload).toBeDisabled();
  await modal.getByLabel('FTB version ID', { exact: true }).fill('456');
  await expect(upload).toBeEnabled();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(upload).toBeInViewport();
    expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `e2e/results/import-ftb-${width}.png` });
  }
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import modpack', exact: true })).toBeFocused();
});

