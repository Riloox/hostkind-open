'use strict';

/*
 * API keys: the non-interactive door into the panel.
 *
 * test/api-keys.test.cjs proves the credential itself - hashing, expiry,
 * revocation. This covers the part only a browser can: that the screen exists,
 * that the secret is shown once and never again, and that a key created here
 * actually works against the REST surface the way a billing system would use
 * it.
 *
 * Every test takes a private panel: a key is panel-wide state.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { toasts, dialog, apiKeyRow, panelSettings } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');

/** Drive the create dialog and return the token it revealed. */
async function createKey(page, { name, role }) {
  await page.getByRole('button', { name: en('apiKeys.addKey') }).click();
  const form = dialog(page, en('apiKeys.addTitle'));
  await form.root.getByRole('textbox').first().fill(name);
  if (role) await form.root.locator('select').selectOption(role);
  await form.root.getByRole('button', { name: en('common.save') }).click();

  const shown = dialog(page, en('apiKeys.createdTitle'));
  await expect(shown.root).toBeVisible();
  const token = await page.getByTestId('api-key-token').innerText();
  await shown.root.getByRole('button', { name: en('apiKeys.savedIt') }).click();
  return token.trim();
}

test.describe('api keys', () => {
  test('the users screen offers them, and starts with none', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await expect(page.getByRole('heading', { name: en('apiKeys.title') })).toBeVisible();
    await expect(page.getByText(en('apiKeys.empty'))).toBeVisible();
  });

  test('creates one, shows the secret once, and never again', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    const token = await createKey(page, { name: 'Billing system', role: 'admin' });
    expect(token).toMatch(/^fdk_[0-9a-f]{16}_.+/);

    await expect(apiKeyRow(page, 'Billing system').root).toBeVisible();
    await expect(apiKeyRow(page, 'Billing system').root).toContainText(en('users.roleAdmin'));
    await expect(apiKeyRow(page, 'Billing system').root).toContainText(en('apiKeys.neverUsed'));

    // The secret is gone from the page and from the API - only its hash was
    // kept, which is the promise the dialog makes.
    await expect(page.getByTestId('api-key-token')).toHaveCount(0);
    await page.reload();
    await expect(apiKeyRow(page, 'Billing system').root).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);

    const api = await client(panel);
    const { keys } = await api.get('/api/api-keys');
    expect(JSON.stringify(keys)).not.toContain(token.split('_')[1] + '_');
  });

  test('the created key actually authenticates against the API', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    const token = await createKey(page, { name: 'Provisioner', role: 'admin' });

    // What a billing system does: call the panel with no human involved.
    const response = await page.request.get(`${panel.url}/api/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBe(true);

    // And the panel now knows it was used.
    await page.reload();
    await expect(apiKeyRow(page, 'Provisioner').root).not.toContainText(en('apiKeys.neverUsed'));
  });

  test('an operator key is denied until it is granted something', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    const token = await createKey(page, { name: 'Restricted', role: 'operator' });

    const denied = await page.request.get(`${panel.url}/api/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.status()).toBe(403);

    // Grants are edited through the same dialog accounts use.
    await apiKeyRow(page, 'Restricted').permissions.click();
    const grants = dialog(page, 'Permissions for Restricted');
    await expect(grants.root).toBeVisible();
    await grants.root.getByText('Audit View', { exact: true }).click();
    await grants.root.getByRole('button', { name: en('common.save') }).click();
    await expect(toasts(page).withText(en('users.permissionsSaved'))).toBeVisible();

    const allowed = await page.request.get(`${panel.url}/api/audit`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.ok()).toBe(true);
  });

  test('revoking asks first, then kills the token immediately', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    const token = await createKey(page, { name: 'Doomed', role: 'admin' });
    expect((await page.request.get(`${panel.url}/api/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    })).ok()).toBe(true);

    await apiKeyRow(page, 'Doomed').revoke.click();
    const confirm = dialog(page, en('apiKeys.revokeTitle'));
    await expect(confirm.root).toContainText('Doomed');
    await confirm.root.getByRole('button', { name: en('apiKeys.revoke') }).click();

    await expect(toasts(page).withText(en('apiKeys.revokedToast'))).toBeVisible();
    await expect(apiKeyRow(page, 'Doomed').root).toContainText(en('apiKeys.revokedBadge'));

    const after = await page.request.get(`${panel.url}/api/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status()).toBe(401);
  });

  test('a key cannot mint or revoke another key', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    // An admin-role key: as privileged as a key gets.
    const token = await createKey(page, { name: 'Escalator', role: 'admin' });
    const auth = { Authorization: `Bearer ${token}` };

    // One leaked provisioning credential must not become permanent access -
    // revoking the leaked key has to be enough.
    expect((await page.request.get(`${panel.url}/api/api-keys`, { headers: auth })).status()).toBe(403);
    expect((await page.request.post(`${panel.url}/api/api-keys`, {
      headers: auth, data: { name: 'Child', role: 'admin' },
    })).status()).toBe(403);

    const api = await client(panel);
    const { keys } = await api.get('/api/api-keys');
    expect(keys.map((key) => key.name)).not.toContain('Child');
  });

  test('refuses a key with no name', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await page.getByRole('button', { name: en('apiKeys.addKey') }).click();
    const form = dialog(page, en('apiKeys.addTitle'));
    await form.root.getByRole('button', { name: en('common.save') }).click();

    await expect(form.root).toContainText(en('errors.apiKeyNameRequired'));
    await expect(page.getByTestId('api-key-token')).toHaveCount(0);
  });

  test('is closed to an operator without users.manage', async ({ page, app }) => {
    await signInFast(page, app, app.operator);
    await openView(page, 'minecraft', 'users');

    // The whole Users & access tab is gated on users.manage, keys included,
    // so it is not offered and its URL falls back to Hostkind settings.
    await expect(page).toHaveURL(/\/settings$/);
    await expect(panelSettings(page).tab('users')).toHaveCount(0);
    await expect(page.getByTestId('api-key-token')).toHaveCount(0);
  });
});
