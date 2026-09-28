'use strict';

/*
 * A server's Overview answers "is it running, and does anything need me?":
 * KPI cards with their meaning attached, and one Needs attention list whose
 * items carry the button that deals with them.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { overviewView, serverControls, serverUrl, toasts } = require('../support/pages.cjs');
const { signInFast, openView, waitForLiveConnection } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');
const { seedFinding, clearFindings, seedCrash, crashAcknowledged } = require('../support/attention.cjs');

const LIFECYCLE = { timeout: 20_000 };

test.describe('needs attention', () => {
  test('shows a stale backup and a crash, each with a working button', async ({ page, newApp }) => {
    const panel = await newApp();
    const server = panel.server('Survival');
    seedFinding(panel, server.id);
    const crashId = seedCrash(panel, server.id, { count: 3 });

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    const overview = overviewView(page);

    // Most severe first: the crash, then the backup.
    await expect(overview.items.first()).toHaveAttribute('data-attention-item', 'crash');
    await expect(overview.item('crash')).toContainText('Crashed 3 times');
    await expect(overview.item('finding')).toContainText(en('health.rules.backup.stale.title'));
    await expect(overview.heading).toHaveText(en('overview.attentionCount', { count: 2 }));

    await overview.item('crash').getByRole('button', { name: en('overview.action.dismiss') }).click();
    await expect(overview.item('crash')).toHaveCount(0);
    await expect.poll(() => crashAcknowledged(panel, crashId)).toBe(true);

    await overview.item('finding').getByRole('button', { name: en('overview.action.backup') }).click();
    await expect(toasts(page).withText(en('backups.createdToast'))).toBeVisible();
    await expect(overview.item('finding')).toHaveCount(0);
    await expect(overview.allClear).toBeVisible();

    await expect(overview.facts).toContainText(en('overview.factLastBackup', { ago: en('notifications.justNow') }));
  });

  test('opens a crash from its item', async ({ page, newApp }) => {
    const panel = await newApp();
    const server = panel.server('Survival');
    const crashId = seedCrash(panel, server.id, { count: 1 });

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    await overviewView(page).item('crash').getByRole('button', { name: en('overview.action.crash') }).click();

    await expect(page).toHaveURL(serverUrl(`crashes/${crashId}`));
  });

  test('says all clear for a healthy server', async ({ page, newApp }) => {
    const panel = await newApp();
    const server = panel.server('Survival');
    // A verified backup keeps the backup rule quiet; the other rules need
    // hours of samples a fresh panel does not have.
    const api = await client(panel);
    const created = await api.post('/api/backups', { serverId: server.id });
    await api.post(`/api/backups/${encodeURIComponent(created.name)}/verify`, { serverId: server.id });
    clearFindings(panel, server.id);

    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });
    const overview = overviewView(page);

    await expect(overview.allClear).toContainText(en('overview.allClear'));
    await expect(overview.heading).toHaveText(en('overview.attention'));
    await expect(overview.facts).toContainText(en('overview.factLastBackup', { ago: en('notifications.justNow') }));
  });
});

test.describe('kpi cards', () => {
  test('an offline server shows dashes, no loaders, and a Start on Status', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'custom', 'dashboard', { origin: panel.url });
    await waitForLiveConnection(page);
    const overview = overviewView(page);

    await expect(overview.kpi('status')).toContainText(en('overview.state.offline'));
    await expect(overview.kpi('cpu')).toContainText(en('common.dashPlaceholder'));
    await expect(overview.kpi('cpu')).not.toHaveAttribute('aria-busy', 'true');
    // A process has no players: Status, CPU and Memory only.
    await expect(page.locator('[data-kpi]')).toHaveCount(3);

    await overview.kpi('status').getByRole('button', { name: en('header.start') }).click();
    await expect(overview.kpi('status')).toContainText(en('overview.state.online'), LIFECYCLE);
    await expect(serverControls(page).status).toHaveText(en('status.online'), LIFECYCLE);

    // Live numbers arrive and draw their trend, without axes.
    const cpuPlot = overview.kpi('cpu').locator('.uplot');
    await expect(cpuPlot).toBeVisible(LIFECYCLE);
    await expect(overview.kpi('cpu')).toContainText('%');
    await expect(overview.kpi('memory')).toContainText(/MB|GB/);

    await serverControls(page).stop.click();
    await expect(overview.kpi('status')).toContainText(en('overview.state.offline'), LIFECYCLE);
  });
});
