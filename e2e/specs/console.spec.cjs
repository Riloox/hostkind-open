'use strict';

/*
 * The console, driven against a process that is genuinely running.
 *
 * The "Worker" fixture is a custom-module server pointed at
 * e2e/support/fake-process.cjs, which echoes what it is sent. So these tests
 * exercise the whole path - stdin to the child, stdout back through the
 * manager, over the WebSocket, into the view - rather than a stubbed stream.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { controlBar, toasts } = require('../support/pages.cjs');
const { signInFast, openView, waitForLiveConnection } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');

const consoleArea = (page) => page.locator('.console-area');
const commandInput = (page) => page.getByPlaceholder(en('console.commandPlaceholder'));
const filterInput = (page) => page.getByPlaceholder(en('console.filterPlaceholder'));

/** Start the Worker over HTTP and wait until the panel calls it online. */
async function startWorker(page, panel) {
  const api = await client(panel);
  await api.post(`/api/servers/${panel.server('Worker').id}/start`);
  await openView(page, 'custom', 'console', { origin: panel.url });
  await waitForLiveConnection(page);
  // A real spawn, on a machine running several panels at once.
  await expect(controlBar(page).status).toHaveText(en('status.online'), { timeout: 20_000 });
}

test.describe('console', () => {
  test('streams what the process prints', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    // Both of the fixture's boot lines, in the order it printed them.
    await expect(consoleArea(page)).toContainText('[fake] booting');
    await expect(consoleArea(page)).toContainText('[fake] ready');
    // The panel narrates the launch itself, above the process's own output.
    await expect(consoleArea(page)).toContainText('[Hostkind] Starting "Worker"');
  });

  test('sends a command and shows the reply', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    await commandInput(page).fill('say hello from the browser');
    await commandInput(page).press('Enter');

    // The process really received it on stdin and answered.
    await expect(consoleArea(page)).toContainText('hello from the browser');
    // And the input is cleared, ready for the next one.
    await expect(commandInput(page)).toHaveValue('');
  });

  test('echoes an unrecognized command rather than swallowing it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    await commandInput(page).fill('list');
    await commandInput(page).press('Enter');

    await expect(consoleArea(page)).toContainText('[fake] echo: list');
  });

  test('refuses to send anything while the process is stopped', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'custom', 'console');
    await expect(controlBar(page).status).toHaveText(en('status.offline'));

    await commandInput(page).fill('say nobody is listening');
    await commandInput(page).press('Enter');

    await expect(toasts(page).withText(en('console.serverOffline'))).toBeVisible();
    await expect(consoleArea(page)).not.toContainText('nobody is listening');
  });

  test('replays the backlog when you come back to it', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    await commandInput(page).fill('say remember me');
    await commandInput(page).press('Enter');
    await expect(consoleArea(page)).toContainText('remember me');

    // Leave, come back: the history arrives from the server, not from React.
    await openView(page, 'custom', 'dashboard', { origin: panel.url });
    await openView(page, 'custom', 'console', { origin: panel.url });

    await expect(consoleArea(page)).toContainText('remember me');
    await expect(consoleArea(page)).toContainText('[fake] ready');
  });

  test('survives a reload with the backlog intact', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    await commandInput(page).fill('say still here');
    await commandInput(page).press('Enter');
    await expect(consoleArea(page)).toContainText('still here');

    await page.reload();

    await expect(consoleArea(page)).toContainText('still here');
  });

  test('filters the stream down to matching lines', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    await commandInput(page).fill('say needle in the haystack');
    await commandInput(page).press('Enter');
    await expect(consoleArea(page)).toContainText('needle in the haystack');

    await filterInput(page).fill('needle');

    await expect(consoleArea(page)).toContainText('needle in the haystack');
    // The boot lines are still in the buffer, just not on screen.
    await expect(consoleArea(page)).not.toContainText('[fake] booting');

    await page.getByRole('button', { name: en('console.clearFilter') }).click();
    await expect(consoleArea(page)).toContainText('[fake] booting');
  });

  test('keeps up with a burst without losing the last line', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    // 300 lines as fast as the process can write them.
    await commandInput(page).fill('spam 300');
    await commandInput(page).press('Enter');

    await expect(consoleArea(page)).toContainText('[fake] line 300');
  });

  test('reports a crash in the stream and drops the server offline', async ({ page, newApp }) => {
    const panel = await newApp();
    await signInFast(page, panel);
    await startWorker(page, panel);

    // The fixture exits 1 without a goodbye, which is what a crash looks like.
    await commandInput(page).fill('boom');
    await commandInput(page).press('Enter');

    await expect(controlBar(page).status).toHaveText(en('status.offline'), { timeout: 20_000 });
    await expect(consoleArea(page)).toContainText('exit');
  });
});
