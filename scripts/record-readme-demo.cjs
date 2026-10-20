'use strict';

/*
 * Records the README demo: a fresh panel, the Minecraft card, the Survival
 * preset, a real Paper download, the first start, and the console reaching
 * "Done". Nothing is mocked - the download and the server are real - so the
 * waits are long; the encode at the end speeds up only the stretches marked
 * as waiting, and writes the animated WebP the README shows.
 *
 *   node scripts/record-readme-demo.cjs [outDir]      # -> outDir/demo.webp
 *   cp <outDir>/demo.webp docs/media/first-server.webp
 *
 * Runs on the isolated E2E panel (its own temp config, data and installer
 * cache), so the developer's real Hostkind install is never touched. Needs the
 * network, a built panel (npm run build), Playwright's Chromium and ffmpeg
 * with libwebp on PATH.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('@playwright/test');
const { startInstance } = require('../e2e/support/instance.cjs');
const { signInFast, waitForLiveConnection } = require('../e2e/support/actions.cjs');
const { minecraftWizard, serverControls } = require('../e2e/support/pages.cjs');
const { en } = require('../e2e/support/fixtures.cjs');

const OUT_DIR = path.resolve(process.argv[2] || 'demo-capture');
const SIZE = { width: 1280, height: 760 };
const INSTALL_TIMEOUT = 15 * 60 * 1000;
// A wait plays back in at most this many seconds, however long it really took.
const WAIT_PLAYBACK = 1.6;
const WEBP = { width: 1280, fps: 12, quality: 78 };
/*
 * The console prints the Java path it starts the server with. Under the temp
 * instance that path carries the user's name and the test-run prefix, so on
 * Windows the runtime goes to a plain C:\Hostkind\runtimes for the take and is
 * removed afterwards. Elsewhere it stays in the instance's temp directory.
 */
const DEMO_RUNTIMES = process.platform === 'win32'
  ? path.join(path.parse(os.tmpdir()).root, 'Hostkind', 'runtimes')
  : null;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Headless recordings have no pointer, so clicks would read as jump cuts.
// Draw one that follows the mouse and pulses on press. Runs in the page.
function installCursor() {
  const draw = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none;
        width: 22px; height: 22px; margin: -2px 0 0 -3px; left: 640px; top: 380px;
        transition: transform 120ms ease-out; }
      #demo-cursor.down { transform: scale(0.85); }
      #demo-cursor::after { content: ''; position: absolute; left: -10px; top: -10px;
        width: 24px; height: 24px; border-radius: 50%; border: 2px solid #ff8a3d;
        opacity: 0; transform: scale(0.4); }
      #demo-cursor.down::after { opacity: 0.9; transform: scale(1);
        transition: transform 180ms ease-out, opacity 180ms; }`;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.5 20.5 L13.2 19.3 L10.3 12.8 L16.5 12.6 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.head.appendChild(style);
    document.body.appendChild(cursor);
    // A full navigation repaints it where the pointer last was.
    try {
      const saved = JSON.parse(window.sessionStorage.getItem('demo-cursor') || 'null');
      if (saved) Object.assign(cursor.style, saved);
    } catch { /* ignore */ }
  };
  window.addEventListener('mousemove', (event) => {
    const cursor = document.getElementById('demo-cursor');
    if (!cursor) return;
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    try {
      window.sessionStorage.setItem('demo-cursor', JSON.stringify({ left: cursor.style.left, top: cursor.style.top }));
    } catch { /* ignore */ }
  }, true);
  const press = (down) => () => document.getElementById('demo-cursor')?.classList.toggle('down', down);
  window.addEventListener('mousedown', press(true), true);
  window.addEventListener('mouseup', press(false), true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
}

let pointer = { x: 640, y: 380 };

/** Glide the pointer to the middle of `locator`, then click it. */
async function clickOn(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to click');
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(target.x - pointer.x, target.y - pointer.y);
  await page.mouse.move(target.x, target.y, { steps: Math.max(8, Math.round(distance / 22)) });
  pointer = target;
  await pause(220);
  await page.mouse.down();
  await pause(110);
  await page.mouse.up();
  await pause(250);
}

/*
 * Keep the live stretches at real speed, squeeze each wait into
 * WAIT_PLAYBACK seconds, and encode an animated WebP that loops.
 */
function renderWebp(video, marks, outPath) {
  const segments = [];
  for (let i = 0; i < marks.length - 1; i += 1) {
    const start = marks[i].at;
    const end = marks[i + 1].at;
    if (end - start < 0.05) continue;
    const speed = marks[i].kind === 'wait' ? Math.max(1, (end - start) / WAIT_PLAYBACK) : 1;
    segments.push({ start, end, speed });
  }
  const parts = segments.map((segment, i) =>
    `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=(PTS-STARTPTS)/${segment.speed.toFixed(3)}[s${i}]`);
  const joined = segments.map((_, i) => `[s${i}]`).join('');
  const filter = [
    ...parts,
    `${joined}concat=n=${segments.length}:v=1:a=0,fps=${WEBP.fps},scale=${WEBP.width}:-1:flags=lanczos`,
  ].join(';');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', video, '-filter_complex', filter,
    '-c:v', 'libwebp_anim', '-quality', String(WEBP.quality), '-compression_level', '4', '-loop', '0', outPath,
  ], { stdio: 'inherit' });
  return segments;
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (DEMO_RUNTIMES && fs.existsSync(path.dirname(DEMO_RUNTIMES))) {
    throw new Error(`${path.dirname(DEMO_RUNTIMES)} already exists; move it aside so the take can use and then remove it`);
  }

  const panel = await startInstance({
    servers: [],
    env: (dirs) => ({
      FLEETDECK_INSTALLER_CACHE: path.join(dirs.root, 'installer-cache'),
      FLEETDECK_RUNTIMES_DIR: DEMO_RUNTIMES || path.join(dirs.root, 'runtimes'),
    }),
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT_DIR, size: SIZE },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const video = page.video();

  // Phase marks, in seconds from the start of the recording. Everything
  // between a `wait` mark and the next mark is dead time the encoder speeds up.
  const t0 = Date.now();
  const marks = [];
  const mark = (name, kind = 'live') => {
    marks.push({ name, kind, at: (Date.now() - t0) / 1000 });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`);
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

  try {
    await page.addInitScript(installCursor);
    await signInFast(page, panel);
    mark('boot', 'wait');
    await page.goto(`${panel.url}/`);
    await page.locator('main [data-game-choice="minecraft"]').waitFor();
    await waitForLiveConnection(page);
    await page.mouse.move(pointer.x, pointer.y);
    await pause(300);
    mark('home');
    await shot('01-home');
    await pause(1200);

    await clickOn(page, page.locator('main [data-game-choice="minecraft"]'));
    await clickOn(page, page.locator('[data-add-method="install"]'));
    const wizard = minecraftWizard(page);
    await wizard.version.waitFor();
    mark('wizard-loading', 'wait');
    // The version list resolves upstream; the form is ready when it lands.
    await page.waitForFunction(() => {
      const select = document.querySelector('#mc-version');
      return select && !select.disabled && select.value;
    }, null, { timeout: 60_000 });
    mark('wizard');
    await pause(1600);
    await shot('02-wizard');

    await clickOn(page, wizard.root.getByLabel(en('minecraft.servers.eula')));
    await pause(500);
    await clickOn(page, wizard.submit);
    await pause(1200);
    mark('installing', 'wait');
    await shot('03-installing');

    const controls = serverControls(page);
    await controls.start.waitFor({ timeout: INSTALL_TIMEOUT });
    mark('installed');
    await pause(1600);
    await shot('04-installed');

    await clickOn(page, controls.start);
    await clickOn(page, page.locator('[data-nav-item="console"]'));
    await pause(600);
    mark('starting', 'wait');
    await shot('05-starting');
    await page.locator('header[data-app-header] .status-pill:visible')
      .filter({ hasText: en('status.online') })
      .first()
      .waitFor({ timeout: 5 * 60 * 1000 });
    mark('online');
    await pause(2400);
    await shot('06-console');

    await clickOn(page, page.locator('[data-nav-item="dashboard"]'));
    await pause(2800);
    await shot('07-overview');
    mark('end');

    // Stop it before the panel goes, so Paper is not killed mid-save.
    await controls.stop.click().catch(() => {});
    await controls.start.waitFor({ timeout: 60_000 }).catch(() => {});
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await panel.stop();
    if (DEMO_RUNTIMES) fs.rmSync(path.dirname(DEMO_RUNTIMES), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  const recorded = await video.path();
  const finalPath = path.join(OUT_DIR, 'demo.webm');
  fs.renameSync(recorded, finalPath);
  fs.writeFileSync(path.join(OUT_DIR, 'marks.json'), JSON.stringify(marks, null, 2));

  // Signing in and the first paint are not part of the story: start at home.
  const story = marks.slice(marks.findIndex((entry) => entry.name === 'home'));
  const webpPath = path.join(OUT_DIR, 'demo.webp');
  const segments = renderWebp(finalPath, story, webpPath);
  const playback = segments.reduce((total, segment) => total + (segment.end - segment.start) / segment.speed, 0);
  console.log(JSON.stringify({
    webp: webpPath,
    realSeconds: Math.round(story.at(-1).at - story[0].at),
    playbackSeconds: Math.round(playback),
    sizeMB: +(fs.statSync(webpPath).size / 1e6).toFixed(2),
  }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
