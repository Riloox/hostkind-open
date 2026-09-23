'use strict';

/*
 * Terms of Use - a user who has not accepted the current version is held at
 * the acceptance dialog; accepting stores it, and Settings shows the terms.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { dialog } = require('../support/pages.cjs');
const { signInFast } = require('../support/actions.cjs');

const unaccepted = (config) => {
  for (const user of config.users) delete user.termsAcceptedVersion;
  delete config.guestTermsAccepted;
};

test.describe('terms of use', () => {
  test('holds a new user until they accept, then remembers it', async ({ page, newApp }) => {
    const panel = await newApp({ config: unaccepted });
    await signInFast(page, panel);
    await page.goto(`${panel.url}/games`);

    const terms = dialog(page, en('terms.title'));
    await expect(terms.root).toBeVisible();
    await expect(terms.root).toContainText('1. Acceptance');

    // Escape does not dismiss it, and accept stays off until the box is ticked.
    await page.keyboard.press('Escape');
    await expect(terms.root).toBeVisible();
    const accept = terms.root.getByRole('button', { name: en('terms.accept') });
    await expect(accept).toBeDisabled();

    await terms.root.getByRole('checkbox').click();
    await accept.click();
    await expect(terms.root).toBeHidden();

    const stored = panel.readConfig().users.find((u) => u.username === panel.admin.username);
    expect(stored.termsAcceptedVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await page.reload();
    await expect(page.getByRole('dialog', { name: en('terms.title') })).toHaveCount(0);
  });

  test('asks the guest once per install when sign-in is off', async ({ page, newApp }) => {
    const panel = await newApp({ requireAuth: false, config: unaccepted });
    await page.goto(`${panel.url}/games`);

    const terms = dialog(page, en('terms.title'));
    await expect(terms.root).toBeVisible();
    await expect(terms.root.getByRole('button', { name: en('terms.decline') })).toHaveCount(0);

    await terms.root.getByRole('checkbox').click();
    await terms.root.getByRole('button', { name: en('terms.accept') }).click();
    await expect(terms.root).toBeHidden();
    expect(panel.readConfig().guestTermsAccepted.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
