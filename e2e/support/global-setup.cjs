'use strict';

/*
 * The panel serves the built SPA out of public/, so these tests only ever see
 * what `npm run build` last produced. That build is committed, so the common
 * case is that it is already current - but a run against a stale bundle would
 * quietly test yesterday's UI, which is worse than failing.
 *
 * So: build when there is nothing to serve, build when asked (E2E_BUILD=1),
 * and otherwise say plainly that sources are newer than the bundle.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'public', 'index.html');

// Everything the bundle is built from. Newer than the bundle means stale.
const SOURCES = ['src', 'index.html', 'tokens.css', 'tailwind.config.js', 'vite.config.js', 'i18n.json', 'i18n.cjs'];

function newestMtime(target, budget = { files: 5000 }) {
  let newest = 0;
  const walk = (entry) => {
    if (budget.files <= 0) return;
    let stat;
    try { stat = fs.statSync(entry); } catch { return; }
    budget.files -= 1;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  walk(target);
  return newest;
}

function build(reason) {
  console.log(`[e2e] ${reason} - running \`npm run build\`...`);
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error('[e2e] frontend build failed; cannot run browser tests');
}

module.exports = function globalSetup() {
  /*
   * Name this run, so every instance directory it creates is identifiable and
   * global teardown can remove exactly those. Workers inherit this.
   */
  process.env.E2E_RUN_ID = process.env.E2E_RUN_ID
    || `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

  /*
   * Sweep instance directories from earlier runs that died without cleaning up
   * (a killed worker never runs its fixture teardown). An hour old is well
   * past any live run, so this cannot take a concurrent one's directories.
   */
  const { sweepInstanceDirs } = require('./instance.cjs');
  const stale = sweepInstanceDirs({ olderThanMs: 60 * 60 * 1000 });
  if (stale.length) {
    console.log(`[e2e] removed ${stale.length} leftover instance director${stale.length === 1 ? 'y' : 'ies'} from an earlier run`);
  }

  if (!fs.existsSync(BUNDLE)) {
    build('public/index.html is missing');
    return;
  }
  if (process.env.E2E_BUILD === '1') {
    build('E2E_BUILD=1');
    return;
  }

  const bundledAt = fs.statSync(BUNDLE).mtimeMs;
  const sourcedAt = Math.max(...SOURCES.map((entry) => newestMtime(path.join(REPO_ROOT, entry))));
  if (sourcedAt > bundledAt) {
    console.warn([
      '',
      '[e2e] WARNING: sources are newer than the bundle in public/.',
      '[e2e] These tests drive the built panel, so recent UI changes are NOT covered by this run.',
      '[e2e] Run `npm run build` first, or `E2E_BUILD=1 npm run test:e2e` to rebuild automatically.',
      '',
    ].join('\n'));
  }
};
