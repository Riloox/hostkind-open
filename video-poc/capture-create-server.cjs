'use strict';

/* Throwaway capture for the Fleetdeck promo POC.
 * It reuses the repository's isolated E2E panel and real create wizard.
 * The generated WebM is converted to MP4 by the parent render step.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { startInstance } = require('../e2e/support/instance.cjs');
const seed = require('../e2e/support/seed.cjs');
const { signInFast, openView } = require('../e2e/support/actions.cjs');
const { dialog, fieldByLabel } = require('../e2e/support/pages.cjs');
const { en } = require('../e2e/support/fixtures.cjs');

const OUTPUT_DIR = path.resolve('C:/Users/USUARIO/Documents/github/fleetdeck-landing/video-poc/capture');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const panel = await startInstance({ servers: [] });
  const workdir = path.join(panel.dirs.servers, 'survival-lab');
  const runnable = seed.plantRunnable(workdir);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUTPUT_DIR, size: { width: 1280, height: 720 } },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const video = page.video();

  try {
    await signInFast(page, panel);
    await openView(page, 'custom', 'servers', { origin: panel.url });
    await pause(1100);

    const createButton = page.getByRole('button', { name: en('servers.createNew') }).first();
    await createButton.click();
    await pause(650);

    const wizard = dialog(page, en('servers.createTitle'));
    await fieldByLabel(wizard.root, en('servers.fieldName')).fill('Survival Lab');
    await pause(450);
    await fieldByLabel(wizard.root, en('servers.fieldWorkingDirectory')).fill(workdir);
    await pause(450);
    await fieldByLabel(wizard.root, en('servers.fieldStartCommand')).fill(runnable.startCommand);
    await pause(450);
    await fieldByLabel(wizard.root, en('servers.fieldHealthCheckRegex')).fill('\\[fake\\] ready');
    await pause(500);

    await wizard.root.getByRole('button', { name: en('servers.createProcess') }).click();
    await pause(2100);

    const row = page.getByRole('row').filter({ has: page.getByText('Survival Lab', { exact: true }) });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'registered-server.png'), fullPage: false });
    await pause(1900);

    const config = panel.readConfig();
    const registered = config.servers.some((server) => server.name === 'Survival Lab');
    if (!registered) throw new Error('The UI row appeared, but config verification failed');

    await context.close();
    await browser.close();
    const recordedPath = await video.path();
    const finalPath = path.join(OUTPUT_DIR, 'create-server.webm');
    if (recordedPath !== finalPath) fs.copyFileSync(recordedPath, finalPath);
    console.log(JSON.stringify({
      status: 'ok',
      panelUrl: panel.url,
      output: finalPath,
      screenshot: path.join(OUTPUT_DIR, 'registered-server.png'),
      registered,
      serverName: 'Survival Lab',
    }));
  } finally {
    try { await context.close(); } catch { /* already closed */ }
    try { await browser.close(); } catch { /* already closed */ }
    await panel.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
