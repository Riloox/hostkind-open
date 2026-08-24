'use strict';

/*
 * The floating bug reporter (plan: report-bug-github, Task 5).
 *
 * Wave 1 of a test-first swarm: the feature does not exist in the bundle yet,
 * so every test here is expected to fail until Task 5 lands. These tests ARE
 * the contract - the implementer must make them pass without changing them.
 * Deliberately no test.fail() markers: this is not a known bug, it is a
 * not-yet-built feature.
 *
 * Contract the tests pin:
 *
 * Launcher (BugReportButton, mounted in App.jsx):
 *   - a <button> fixed in the bottom-right of every authenticated in-game
 *     screen, with aria-label and title = en('bugReport.launcher'), in the
 *     tab order, >= 44x44px hit target.
 *   - NOT rendered on the login screen or the games hub (/games).
 *   - never covering the bottom ControlBar on short viewports (its bottom
 *     edge stays above the dock's top edge).
 *   - hide/show control: a themed chevron button next to the launcher. Hiding
 *     slides the launcher off-screen and sets localStorage
 *     'fleetdeck_bug_report_hidden:<userId>' to '1'; a reload keeps it hidden.
 *
 * Dialog (BugReportDialog):
 *   - Radix dialog whose accessible name is en('bugReport.title'), opened by
 *     clicking the launcher, closed by Escape or its X (en('common.close')).
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
 * i18n keys required in BOTH dictionaries: bugReport.launcher,
 * bugReport.title, bugReport.summary, bugReport.description, bugReport.repro,
 * bugReport.expected, bugReport.context, bugReport.privacy,
 * bugReport.submit, bugReport.success, bugReport.pending, bugReport.hide,
 * settings.bugReport, settings.bugReportDesc, settings.bugReportRestore.
 */

const { test, expect, en, es } = require('../support/fixtures.cjs');
const { appShell, loginScreen, gamesHub, controlBar, dialog } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

const GITHUB_URL = 'https://github.com/Riloox/hostkind-open/issues/123';
const HIDDEN_KEY = 'fleetdeck_bug_report_hidden';

function launcher(page) {
  return page.getByRole('button', { name: en('bugReport.launcher'), exact: true });
}

function reporterDialog(page) {
  return page.getByRole('dialog', { name: en('bugReport.title'), exact: true });
}

test.describe('bug reporter launcher', () => {
  test('floats in the bottom-right of authenticated app screens', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    await expect(button).toBeVisible();

    // Fixed positioning, directly or through a fixed wrapper.
    const fixed = await button.evaluate((el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') return true;
      }
      return false;
    });
    expect(fixed).toBe(true);

    const box = await button.boundingBox();
    const arrow = page.getByRole('button', { name: en('bugReport.hide'), exact: true });
    const arrowBox = await arrow.boundingBox();
    const viewport = page.viewportSize();
    expect(arrowBox.x + arrowBox.width).toBeGreaterThan(viewport.width - 48);
    expect(box.y + box.height / 2).toBeGreaterThan(viewport.height / 2);
  });

  test('does not appear on the login screen or the games hub', async ({ page, app }) => {
    await page.goto('/');
    await expect(loginScreen(page).heading).toBeVisible();
    await expect(launcher(page)).toHaveCount(0);

    await signInFast(page, app);
    await page.goto('/games');
    await expect(gamesHub(page).carousel).toBeVisible();
    await expect(launcher(page)).toHaveCount(0);

    await openView(page, 'minecraft', 'dashboard');
    await expect(launcher(page)).toBeVisible();
  });

  test('has an accessible name, a tooltip and a 44px hit target', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', /.+/);

    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('is reachable with Tab and opens the dialog with Enter', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    await expect(button).toBeVisible();

    // Bounded walk: the launcher's place in the tab order depends on the
    // screen's other controls, which may change. 40 tabs is far beyond the
    // current page's focusables.
    let focused = false;
    for (let i = 0; i < 40 && !focused; i += 1) {
      await page.keyboard.press('Tab');
      focused = await button.evaluate((el) => el === document.activeElement);
    }
    expect(focused, 'launcher should be reachable from the keyboard').toBe(true);

    await page.keyboard.press('Enter');
    await expect(reporterDialog(page)).toBeVisible();
  });
});

test.describe('bug reporter dialog', () => {
  test('opens on click and closes on Escape or the X', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await launcher(page).click();
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await launcher(page).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: en('common.close'), exact: true }).click();
    await expect(dlg).toBeHidden();
  });

  test('captures and shows the current game, view and route when it opens', async ({ page, app }) => {
    await signInFast(page, app);
    // A non-default view, so a stale "dashboard" capture cannot pass.
    await openView(page, 'terraria', 'files');

    await launcher(page).click();
    const dlg = reporterDialog(page);
    await expect(dlg).toBeVisible();

    await expect(dlg.locator('[data-bug-report-context-game="terraria"]')).toBeVisible();
    await expect(dlg.locator('[data-bug-report-context-view="files"]')).toBeVisible();
    await expect(dlg.locator('[data-bug-report-context-route="/games/terraria/files"]')).toBeVisible();
    await expect(dlg).toContainText(en('bugReport.privacy'));
  });

  test('requires a summary and a description before submitting', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await launcher(page).click();
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

    await launcher(page).click();
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
      route: '/games/minecraft/dashboard',
    });
  });

  test('shows the pending message when GitHub is unavailable', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await launcher(page).click();
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

    await launcher(page).click();
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

    await launcher(page).click();
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

test.describe('bug reporter hide and restore', () => {
  test('hides per user and stays hidden after a reload', async ({ page, app }) => {
    const { user } = await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    await expect(button).toBeVisible();

    await page.getByRole('button', { name: en('bugReport.hide'), exact: true }).click();
    await expect(button).toHaveAttribute('data-bug-report-hidden', 'true');
    await expect(button).toHaveAttribute('tabindex', '-1');

    const hidden = await page.evaluate(
      ([key, userId]) => window.localStorage.getItem(`${key}:${userId}`),
      [HIDDEN_KEY, user.id],
    );
    expect(hidden).toBe('1');

    await page.reload();
    await expect(appShell(page).header).toBeVisible();
    await expect(button).toHaveAttribute('data-bug-report-hidden', 'true');
  });

  test('hidden state can be restored with the chevron', async ({ page, app }) => {
    const { user } = await signInFast(page, app);
    // Plant the hidden flag before the app boots: addInitScript runs on the
    // next navigation (openView's page.goto).
    await page.addInitScript(([key, value]) => {
      try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
    }, [`${HIDDEN_KEY}:${user.id}`, '1']);
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    await expect(button).toHaveAttribute('data-bug-report-hidden', 'true');
    await page.getByRole('button', { name: en('bugReport.show'), exact: true }).click();

    await expect(button).toBeVisible();
    const hidden = await page.evaluate(
      ([key, userId]) => window.localStorage.getItem(`${key}:${userId}`),
      [HIDDEN_KEY, user.id],
    );
    expect(hidden).not.toBe('1');
  });
});

test.describe('bug reporter layout', () => {
  test('sits above the control bar on a short viewport', async ({ page, app }) => {
    await signInFast(page, app);
    await page.setViewportSize({ width: 726, height: 337 });
    await openView(page, 'minecraft', 'dashboard');

    const button = launcher(page);
    const dock = controlBar(page).root;
    await expect(button).toBeVisible();
    await expect(dock).toBeVisible();

    // The launcher must not cover the dock: a 2px graze of the dock's top
    // border is tolerated, never more. Poll because fixed-position layout can
    // settle a frame late.
    const overlap = async () => {
      const b = await button.boundingBox();
      const d = await dock.boundingBox();
      return b.y + b.height - (d.y + 2);
    };
    await expect.poll(overlap, { timeout: 5000 }).toBeLessThanOrEqual(0);
  });
});

test.describe('bug reporter languages', () => {
  test.use({ uiLanguage: 'es' });

  test('launcher and dialog render in Spanish', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    const button = page.getByRole('button', { name: es('bugReport.launcher'), exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole('dialog', { name: es('bugReport.title'), exact: true })).toBeVisible();
  });
});
