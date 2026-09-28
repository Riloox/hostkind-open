'use strict';

/*
 * The bug reporter: "Report a problem" in the profile menu opens
 * BugReportDialog. (It used to be a floating launcher in the bottom-right
 * corner; nothing floats over the page any more.)
 *
 * Contract the tests pin:
 *
 * Entry (Header's profile menu, dialog mounted in App.jsx):
 *   - a menu item named en('bugReport.menu') for any signed-in user, usable
 *     from the keyboard.
 *   - no fixed launcher ([data-bug-report-dock]); the old per-user
 *     'fleetdeck_bug_report_hidden:<userId>' flag means nothing.
 *
 * Dialog (BugReportDialog):
 *   - Radix dialog whose accessible name is en('bugReport.title'), opened by
 *     choosing the menu item, closed by Escape or its X (en('common.close')).
 *   - form controls carry name attributes: name="summary", name="description"
 *     (both required), name="repro", name="expected" (both optional).
 *   - current-screen context, captured when the dialog opens, rendered as
 *     visible elements carrying data-bug-report-context-game,
 *     data-bug-report-context-view and data-bug-report-context-route with the
 *     game id, view id and location pathname as values.
 *   - a privacy note whose rendered text contains en('bugReport.privacy').
 *   - submit: button en('bugReport.submit') POSTs JSON to /api/bug-reports
 *     with body { title, description, repro, expected, game, view, route }.
 *     A second click while a submit is in flight must not send a second
 *     request. On a synced response ({ sync: { state: 'synced', url } }) the
 *     dialog shows the GitHub url and en('bugReport.success'); on
 *     { sync: { state: 'pending', ... } } it shows en('bugReport.pending').
 *
 * i18n keys required in BOTH dictionaries: bugReport.menu,
 * bugReport.title, bugReport.summary, bugReport.description, bugReport.repro,
 * bugReport.expected, bugReport.context, bugReport.privacy,
 * bugReport.submit, bugReport.success, bugReport.pending.
 */

const { test, expect, en, es } = require('../support/fixtures.cjs');
const { appShell } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

const GITHUB_URL = 'https://github.com/Riloox/hostkind-open/issues/123';
const HIDDEN_KEY = 'fleetdeck_bug_report_hidden';

/** Open the reporter the way a user does: profile menu -> Report a problem. */
async function openReporter(page) {
  await appShell(page).profileButton.click();
  await appShell(page).menuReportProblem.click();
}

function reporterDialog(page) {
  return page.getByRole('dialog', { name: en('bugReport.title'), exact: true });
}

test.describe('bug reporter entry', () => {
  test('lives in the profile menu, with nothing floating over the page', async ({ page, app }) => {
    const { user } = await signInFast(page, app);
    // The old "hide the launcher" flag must not hide anything.
    await page.addInitScript(([key, value]) => {
      try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
    }, [`${HIDDEN_KEY}:${user.id}`, '1']);
    await openView(page, 'minecraft', 'dashboard');

    await expect(page.locator('[data-bug-report-dock]')).toHaveCount(0);
    await openReporter(page);
    await expect(reporterDialog(page)).toBeVisible();
  });

  test('opens from the keyboard', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await appShell(page).profileButton.focus();
    await page.keyboard.press('Enter');
    const item = appShell(page).menuReportProblem;
    await expect(item).toBeVisible();
    // Bounded walk down the menu: its order may change.
    let focused = false;
    for (let i = 0; i < 10 && !focused; i += 1) {
      await page.keyboard.press('ArrowDown');
      focused = await item.evaluate((el) => el === document.activeElement);
    }
    expect(focused, 'Report a problem should be reachable from the keyboard').toBe(true);

    await page.keyboard.press('Enter');
    await expect(reporterDialog(page)).toBeVisible();
  });
});

test.describe('bug reporter dialog', () => {
  test('opens on click and closes on Escape or the X', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await openReporter(page);
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: en('common.close'), exact: true }).click();
    await expect(dlg).toBeHidden();
  });

  test('captures and shows the current game, view and route when it opens', async ({ page, app }) => {
    await signInFast(page, app);
    // A non-default view, so a stale "dashboard" capture cannot pass.
    await openView(page, 'terraria', 'files');

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    await expect(dlg.locator('[data-bug-report-context-game="terraria"]')).toBeVisible();
    await expect(dlg.locator('[data-bug-report-context-view="settings/files"]')).toBeVisible();
    await expect(dlg.locator('[data-bug-report-context-route="/servers/srv-hardmode/settings/files"]')).toBeVisible();
    await expect(dlg).toContainText(en('bugReport.privacy'));
  });

  test('requires a summary and a description before submitting', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    let posts = 0;
    await page.route('**/api/bug-reports', (route) => {
      posts += 1;
      route.abort();
    });

    const summary = dlg.locator('[name="summary"]');
    const description = dlg.locator('[name="description"]');
    const submit = dlg.getByRole('button', { name: en('bugReport.submit'), exact: true });
    await expect(summary).toBeVisible();
    await expect(description).toBeVisible();

    // Completely empty form: nothing is sent, the dialog stays.
    await submit.click();
    await page.waitForTimeout(300);
    expect(posts).toBe(0);
    await expect(dlg).toBeVisible();

    // A description alone is still not enough.
    await description.fill('The console eats my commands.');
    await submit.click();
    await page.waitForTimeout(300);
    expect(posts).toBe(0);

    // A summary alone is still not enough.
    await description.fill('');
    await summary.fill('Console drops input');
    await submit.click();
    await page.waitForTimeout(300);
    expect(posts).toBe(0);
  });

  test('sends the expected payload and shows the GitHub URL on success', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    let payload = null;
    await page.route('**/api/bug-reports', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        json: {
          report: { id: '00000000-0000-4000-8000-000000000001' },
          sync: { state: 'synced', url: GITHUB_URL },
        },
      });
    });

    await dlg.locator('[name="summary"]').fill('Crash on start');
    await dlg.locator('[name="description"]').fill('The panel crashes when I open the console.');
    await dlg.locator('[name="repro"]').fill('1. Open the console view\n2. Press any key');
    await dlg.locator('[name="expected"]').fill('It should stay open');
    await dlg.getByRole('button', { name: en('bugReport.submit'), exact: true }).click();

    await expect(dlg).toContainText(GITHUB_URL);
    await expect(dlg).toContainText(en('bugReport.success'));

    expect(payload).toMatchObject({
      title: 'Crash on start',
      description: 'The panel crashes when I open the console.',
      repro: '1. Open the console view\n2. Press any key',
      expected: 'It should stay open',
      game: 'minecraft',
      view: 'dashboard',
      route: '/servers/srv-survival',
    });
  });

  test('shows the pending message when GitHub is unavailable', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    await page.route('**/api/bug-reports', (route) => route.fulfill({
      status: 200,
      json: {
        report: { id: '00000000-0000-4000-8000-000000000002' },
        sync: { state: 'pending', message: 'GitHub is unreachable; the report will be retried.' },
      },
    }));

    await dlg.locator('[name="summary"]').fill('Sync outage');
    await dlg.locator('[name="description"]').fill('Nothing syncs.');
    await dlg.getByRole('button', { name: en('bugReport.submit'), exact: true }).click();

    await expect(dlg).toContainText(en('bugReport.pending'));
  });

  test('offers the direct issue tracker link when sync is not configured', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    const tracker = 'https://github.com/Riloox/hostkind-open/issues/new/choose';
    await page.route('**/api/bug-reports', (route) => route.fulfill({
      status: 200,
      json: {
        report: { id: '00000000-0000-4000-8000-000000000004' },
        sync: { state: 'pending', reason: 'not_configured', trackerUrl: tracker, message: null, error: null },
      },
    }));

    await dlg.locator('[name="summary"]').fill('Not configured');
    await dlg.locator('[name="description"]').fill('Nothing is wired up.');
    await dlg.getByRole('button', { name: en('bugReport.submit'), exact: true }).click();

    await expect(dlg).toContainText(en('bugReport.notConfigured'));
    const link = dlg.getByRole('link', { name: en('bugReport.openTracker'), exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', tracker);
    await expect(link).toHaveAttribute('target', '_blank');
    // The link is only for the not-configured case: no issue URL is shown yet.
    await expect(dlg).not.toContainText(GITHUB_URL);
  });

  test('does not submit twice when the button is clicked rapidly', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await openReporter(page);
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    let calls = 0;
    await page.route('**/api/bug-reports', async (route) => {
      calls += 1;
      // Hold the first response open so the second click lands mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 201,
        json: {
          report: { id: '00000000-0000-4000-8000-000000000003' },
          sync: { state: 'synced', url: GITHUB_URL },
        },
      });
    });

    const submit = dlg.getByRole('button', { name: en('bugReport.submit'), exact: true });
    await dlg.locator('[name="summary"]').fill('Double click');
    await dlg.locator('[name="description"]').fill('Submitted twice.');
    await submit.click();
    // A second raw click while the first is still in flight. `force` skips the
    // actionability wait, so it lands even if the button just disabled itself.
    await submit.click({ force: true });

    await expect(dlg).toContainText(GITHUB_URL);
    expect(calls).toBe(1);
  });
});

test.describe('bug reporter languages', () => {
  test.use({ uiLanguage: 'es' });

  test('menu entry and dialog render in Spanish', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await appShell(page).profileButton.click();
    await page.getByRole('menuitem', { name: es('bugReport.menu') }).click();
    await expect(page.getByRole('dialog', { name: es('bugReport.title'), exact: true })).toBeVisible();
  });
});
