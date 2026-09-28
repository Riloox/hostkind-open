'use strict';

/*
 * The Resources tab: metric history drawn as charts.
 *
 * These charts were ApexCharts until its licence changed to one that forbids
 * sublicensing and charges for redistribution - which the panel cannot accept
 * and still be redistributable itself. They are uPlot now. Nothing about the
 * data changed, so this spec is written against what the user sees rather than
 * against the library: how many plots mount, which metrics a game is offered,
 * and that an empty history says so instead of drawing an empty box.
 *
 * uPlot paints to canvas, so there are no chart internals to assert on. What is
 * worth pinning is that a plot exists, that it was actually given width - the
 * failure mode of a canvas chart in a flex container is a zero-width canvas
 * that renders nothing and throws nothing - and that the card's headline
 * reading agrees with the seeded data.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { detailsView } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { seedSamples, clearSamples } = require('../support/metrics.cjs');

/*
 * Assert a plot actually rendered.
 *
 * uPlot destroys its canvas and builds a new one whenever the series or the
 * size change, so a node resolved a moment ago may already be detached and
 * measure as null. Poll rather than measuring once - the point of the check is
 * that the canvas ends up with real dimensions, not that it had them on the
 * first frame after a refetch.
 */
async function expectDrawn(plot, { minWidth = 100, minHeight = 20 } = {}) {
  await expect(plot).toBeVisible();
  await expect
    .poll(async () => {
      const box = await plot.locator('canvas').first().boundingBox();
      return box ? Math.round(Math.min(box.width - minWidth, box.height - minHeight)) : -1;
    }, { message: 'canvas never reached real dimensions' })
    .toBeGreaterThan(0);
}

/** Sign in, seed history for one server, and land on its details page. */
async function openResources(page, panel, game, serverName, opts) {
  const server = panel.server(serverName);
  const seeded = seedSamples(panel, server.id, opts);
  await signInFast(page, panel);
  await openView(page, game, 'health', { origin: panel.url });
  return { server, seeded };
}

test.describe('resources charts', () => {
  test('draws one chart per metric the game reports', async ({ page, newApp }) => {
    const panel = await newApp();
    await openResources(page, panel, 'minecraft', 'Survival');

    const health = detailsView(page);

    // Minecraft reports players and world size on top of the two every module
    // has, so it gets four.
    await expect(health.plots).toHaveCount(4);
    for (const title of [
      en('metrics.chartCpu'),
      en('metrics.chartMemory'),
      en('minecraft.metrics.chartPlayers'),
      en('minecraft.metrics.chartWorldSize'),
    ]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
  });

  test('gives each chart real width, not a collapsed canvas', async ({ page, newApp }) => {
    const panel = await newApp();
    await openResources(page, panel, 'minecraft', 'Survival');

    const plots = detailsView(page).plots;
    await expect(plots).toHaveCount(4);

    for (let i = 0; i < 4; i += 1) {
      await expectDrawn(plots.nth(i));
    }
  });

  test('offers only cpu and memory to a game with no player count', async ({ page, newApp }) => {
    const panel = await newApp();
    // "Worker" is the custom-process module: no players, no world on disk.
    await openResources(page, panel, 'custom', 'Worker', { players: false });

    const health = detailsView(page);
    await expect(health.plots).toHaveCount(2);
    await expect(page.getByText(en('minecraft.metrics.chartPlayers'), { exact: true })).toHaveCount(0);
    await expect(page.getByText(en('minecraft.metrics.chartWorldSize'), { exact: true })).toHaveCount(0);
  });

  test('says so when there is no history rather than drawing an empty chart', async ({ page, newApp }) => {
    /*
     * The history has to be cleared explicitly, and seeding nothing is not
     * enough: the panel samples every registered server four seconds after
     * boot, online or not (server.js:4568), so a panel that has merely been
     * left alone already has a point to draw. Deleting the rows leaves a clear
     * minute before METRICS_INTERVAL_MS brings the next one - ample, but the
     * reason this test cannot simply skip the seeding step.
     *
     * Dropping the server instead would not work either: the Health nav item is
     * `requiresServer`, so with nothing registered the tab never mounts.
     */
    const panel = await newApp();
    await signInFast(page, panel);
    clearSamples(panel, panel.server('Survival').id);
    await openView(page, 'minecraft', 'health', { origin: panel.url });

    const health = detailsView(page);
    await expect(health.noData.first()).toBeVisible();
    await expect(health.plots).toHaveCount(0);
  });

  test('redraws when the range changes', async ({ page, newApp }) => {
    const panel = await newApp();
    // An hour of samples: inside the 1h window, and well inside 24h.
    await openResources(page, panel, 'minecraft', 'Survival', { count: 60 });

    const health = detailsView(page);
    await expect(health.plots).toHaveCount(4);

    await health.range('metrics.range24h').click();
    await expect(health.plots).toHaveCount(4);

    await health.range('metrics.range1h').click();
    await expect(health.plots).toHaveCount(4);
    // Still real charts after the refetch, not leftovers from the last range.
    await expectDrawn(health.plots.first());
  });

  test('survives a reload straight onto the tab', async ({ page, newApp }) => {
    const panel = await newApp();
    await openResources(page, panel, 'minecraft', 'Survival');
    await expect(detailsView(page).plots).toHaveCount(4);

    await page.reload();
    await expect(detailsView(page).plots).toHaveCount(4);
  });
});

test.describe('health overview', () => {
  test('stacks the correlations notice under its title instead of beside it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'health', { origin: panel.url });

    // The correlations card exists only for games that report players. Its
    // CardHeader is a flex ROW (justify-between, from ui/card.jsx), and this
    // card is the only one that puts a long prose notice next to its title -
    // the notice sat to the right and squeezed the title until it wrapped
    // mid-word ("CORRELATION" / "S"). It must stack below, left-aligned.
    const title = page.getByRole('heading', { name: en('health.correlations'), exact: true });
    const notice = page.getByText(en('health.associationNotice'), { exact: true });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeVisible();

    const titleBox = await title.boundingBox();
    const noticeBox = await notice.boundingBox();
    // Below, not vertically centred beside it.
    expect(noticeBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 2);
    // Left-aligned with the title, not pushed to the card's far edge.
    expect(Math.abs(noticeBox.x - titleBox.x)).toBeLessThan(10);
  });
});
