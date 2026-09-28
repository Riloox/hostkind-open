'use strict';

/*
 * The panel-wide admin surfaces: accounts, capability grants, the sign-in
 * switch, the audit trail, schedules, and the update centre.
 *
 * Everything here writes to the instance's own config or database, so each
 * mutating test takes a private panel.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { toasts, dialog, appShell, userRow, serverUrl, panelSettings } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');

test.describe('users', () => {
  test('lists the accounts and marks which one is you', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'users');

    // Exact: the username is also a prefix of the seeded email address.
    await expect(page.getByText(app.admin.username, { exact: true })).toBeVisible();
    await expect(page.getByText(app.operator.username, { exact: true })).toBeVisible();
    await expect(userRow(page, app.admin.username).root).toContainText(en('users.youBadge'));
    await expect(userRow(page, app.admin.username).root).toContainText(en('users.roleAdmin'));
    await expect(userRow(page, app.operator.username).root).toContainText(en('users.roleOperator'));
  });

  test('adds an account', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await page.getByRole('button', { name: en('users.addUser') }).click();
    const form = dialog(page, en('users.addTitle'));
    await form.root.getByRole('textbox').nth(1).fill('newcomer');
    await form.root.locator('input[type="password"]').fill('Str0ngEnough!');
    await form.root.getByRole('button', { name: en('common.save') }).click();

    await expect(toasts(page).withText(en('users.createdToast'))).toBeVisible();
    await expect(page.getByText('newcomer')).toBeVisible();
    // New accounts are operators by default - least privilege.
    expect(panel.readConfig().users.find((u) => u.username === 'newcomer').role).toBe('operator');
  });

  test('refuses a password the policy will not accept', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await page.getByRole('button', { name: en('users.addUser') }).click();
    const form = dialog(page, en('users.addTitle'));
    await form.root.getByRole('textbox').nth(1).fill('weakling');
    await form.root.locator('input[type="password"]').fill('short');
    await form.root.getByRole('button', { name: en('common.save') }).click();

    await expect(form.root).toContainText('Password must be at least');
    expect(panel.readConfig().users.some((u) => u.username === 'weakling')).toBe(false);
  });

  test('refuses a username that is already taken', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await page.getByRole('button', { name: en('users.addUser') }).click();
    const form = dialog(page, en('users.addTitle'));
    await form.root.getByRole('textbox').nth(1).fill(panel.operator.username);
    await form.root.locator('input[type="password"]').fill('Str0ngEnough!');
    await form.root.getByRole('button', { name: en('common.save') }).click();

    await expect(form.root).toContainText(en('errors.usernameTaken'));
  });

  test('will not let you delete yourself', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'users');

    await expect(userRow(page, app.admin.username).root).toContainText(en('users.youBadge'));
    await expect(userRow(page, app.admin.username).remove).toBeDisabled();
  });

  test('deletes another account after confirming', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await userRow(page, panel.operator.username).remove.click();

    const confirm = dialog(page, en('users.deleteTitle'));
    await expect(confirm.root).toContainText(panel.operator.username);
    await confirm.root.getByRole('button', { name: en('common.delete') }).click();

    await expect(toasts(page).withText(en('users.deletedToast'))).toBeVisible();
    expect(panel.readConfig().users.some((u) => u.username === panel.operator.username)).toBe(false);
  });

  test('grants a capability to an operator and stores it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await userRow(page, panel.operator.username).permissions.click();

    const grants = dialog(page, `Permissions for ${panel.operator.username}`);
    await expect(grants.root).toBeVisible();
    // Global capabilities are offered without a server; per-server ones are
    // grouped under the server they belong to. The dialog humanizes the
    // capability id, so audit.view is offered as "Audit View".
    await expect(grants.root).toContainText(en('users.globalPermissions'));
    await expect(grants.root).toContainText('Survival');
    await grants.root.getByText('Audit View', { exact: true }).click();
    await grants.root.getByRole('button', { name: en('common.save') }).click();

    await expect(toasts(page).withText(en('users.permissionsSaved'))).toBeVisible();

    // Read it back the way the panel would.
    const api = await client(panel);
    const operatorId = await api.userId(panel.operator.username);
    const { permissions } = await api.get(`/api/users/${operatorId}/permissions`);
    expect(permissions.grants).toContainEqual({ serverId: null, capability: 'audit.view' });
  });

  test('turning sign-in off asks first, then opens the panel to anyone', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'users', { origin: panel.url });

    await expect(page.getByRole('heading', { name: en('security.title') })).toBeVisible();
    // The sign-in toggle is a checkbox, currently ticked.
    const requireSignIn = page.getByRole('checkbox').last();
    await expect(requireSignIn).toBeChecked();
    await requireSignIn.click();

    const confirm = dialog(page, en('security.disableTitle'));
    await confirm.root.getByRole('button', { name: en('common.save') }).click();

    await expect(toasts(page).withText(en('security.disabledToast'))).toBeVisible();
    expect(panel.readConfig().requireAuth).toBe(false);
  });
});

test.describe('audit trail', () => {
  test('records what happened, and to whom', async ({ page, newApp }) => {
    const panel = await newApp();
    // Something worth auditing: a sign-in and a server registration.
    const api = await client(panel);
    await api.post('/api/servers', { name: 'Audited', dir: panel.server('Survival').dir, jar: 'server.jar' });

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'audit', { origin: panel.url });

    await expect(panelSettings(page).tab('audit')).toHaveAttribute('data-state', 'active');
    await expect(page.getByText(panel.admin.username).first()).toBeVisible();
    await expect(page.getByText('auth.login').first()).toBeVisible();
  });

  test('is closed to an operator without the grant', async ({ page, app }) => {
    await signInFast(page, app, app.operator);
    await openView(page, 'minecraft', 'audit');

    // audit.view is global and ungranted here, so the tab is not offered and
    // its URL falls back to the first tab of Hostkind settings.
    await expect(page).toHaveURL(/\/settings$/);
    // Preferences, whether or not a tab bar shows (with one tab it does not).
    await expect(panelSettings(page).group('profile')).toBeVisible();
    await expect(panelSettings(page).tab('audit')).toHaveCount(0);
  });
});

test.describe('Hostkind settings', () => {
  test('shows an operator only the tabs they may use', async ({ page, app }) => {
    await signInFast(page, app, app.operator);
    await page.goto('/settings/users');

    await expect(page).toHaveURL(/\/settings$/);
    const settings = panelSettings(page);
    // No bar when Preferences is the only tab left, so look for its content.
    for (const tab of ['users', 'audit', 'updates']) await expect(settings.tab(tab)).toHaveCount(0);
    // Their own profile and password, but not the panel-wide admin settings.
    await expect(settings.group('profile')).toBeVisible();
    await expect(settings.group('watchdog')).toHaveCount(0);
  });

  test('gives an admin every tab, each at its own URL', async ({ page, app }) => {
    await signInFast(page, app);
    await page.goto('/settings');

    const settings = panelSettings(page);
    for (const tab of ['preferences', 'users', 'audit', 'updates']) await expect(settings.tab(tab)).toBeVisible();

    await settings.tab('audit').click();
    await expect(page).toHaveURL(/\/settings\/audit$/);
    await expect(page.getByRole('button', { name: 'CSV' })).toBeVisible();

    await settings.tab('users').click();
    await expect(page).toHaveURL(/\/settings\/users$/);

    // Back returns to the previous tab.
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/audit$/);
    await expect(settings.tab('audit')).toHaveAttribute('data-state', 'active');
  });
});

test.describe('schedules', () => {
  test('opens with nothing scheduled', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'tasks');

    await expect(page.getByRole('heading', { name: en('nav.schedules') })).toBeVisible();
    await expect(page.getByRole('button', { name: en('tasks.newTask') })).toHaveCount(1);
    await expect(page.getByText(en('tasks.empty'))).toBeVisible();
  });

  test('keeps a task it was given', async ({ page, newApp }) => {
    const panel = await newApp();
    const api = await client(panel);
    await api.post('/api/tasks', {
      serverId: panel.server('Survival').id,
      name: 'Nightly restart',
      action: 'restart',
      cron: '0 4 * * *',
      enabled: true,
    });

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'tasks', { origin: panel.url });

    await expect(page.getByText('Nightly restart')).toBeVisible();
    await expect(page.getByText('0 4 * * *')).toBeVisible();
  });
});

test.describe('schedules of one server', () => {
  test('lists only the open server schedules, next one first', async ({ page, newApp }) => {
    const seed = require('../support/seed.cjs');
    const panel = await newApp({
      servers: (dirs) => [seed.minecraft(dirs, { name: 'Survival' }), seed.minecraft(dirs, { name: 'Creative' })],
    });
    const api = await client(panel);
    const survival = panel.server('Survival').id;
    for (const [serverId, name, cron] of [
      [survival, 'Weekly restart', '0 3 * * 0'],
      [survival, 'Hourly backup', '0 * * * *'],
      [panel.server('Creative').id, 'Creative restart', '0 4 * * *'],
    ]) {
      await api.post('/api/tasks', { serverId, name, action: 'restart', cron, enabled: true });
    }

    await signInFast(page, panel);
    await page.goto(`${panel.url}/servers/${survival}/schedules`);

    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Hourly backup');
    await expect(rows.nth(1)).toContainText('Weekly restart');
    await expect(page.getByText('Creative restart')).toHaveCount(0);
  });
});

test.describe('updates', () => {
  test('offers the update centre for a game that has one', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'updates');

    await expect(appShell(page).sectionTab('updates')).toHaveAttribute('data-state', 'active');
    // Its scan button sits on the tab bar's row.
    await expect(page.locator('[data-section-actions]').getByRole('button').first()).toBeVisible();
  });

  test('is not offered for a game with no update path', async ({ page, app }) => {
    await signInFast(page, app);
    // The custom module declares no `updates` capability.
    await openView(page, 'custom', 'updates');

    await expect(page).toHaveURL(serverUrl());
    await expect(appShell(page).navItem('mods')).toHaveCount(0);
  });
});
