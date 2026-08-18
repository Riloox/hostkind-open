'use strict';

/*
 * Test fixtures shared by every browser spec.
 *
 * `app` is worker-scoped: one panel boots per worker and is reused, because a
 * boot costs ~2s. That sharing is safe for tests that only read, or that write
 * state they own (a user, a server). It is NOT safe for tests that move
 * panel-wide state - the login rate limiter, the requireAuth switch - since the
 * next test in the worker would inherit it. Those call `newApp()` for a
 * dedicated panel that is torn down with the test.
 */

const path = require('path');
const base = require('@playwright/test');
const { startInstance, ADMIN, OPERATOR } = require('./instance.cjs');
const { createTracker } = require('./installs.cjs');
const seed = require('./seed.cjs');
const i18n = require('../../i18n.cjs');

/*
 * What every panel under test starts with, unless a spec says otherwise: one
 * registered server per module, none of them running, each with content on
 * disk. Keeping it identical everywhere means a spec can open any game's views
 * without arranging its own world first.
 *
 * "Worker" is the runnable one - the custom module points it at a real child
 * process, so lifecycle and console tests have something that genuinely starts.
 */
const STANDARD_FLEET = (dirs) => [
  seed.minecraft(dirs, { name: 'Survival' }),
  seed.terraria(dirs, { name: 'Hardmode' }),
  seed.valheim(dirs, { name: 'Midgard' }),
  seed.palworld(dirs, { name: 'Pal Camp' }),
  seed.custom(dirs, { name: 'Worker' }),
];

/** The English copy the UI will render, read from the shipped dictionary. */
const en = (key, vars) => i18n.t('en', key, vars);
/** Same, for the Spanish default-language check. */
const es = (key, vars) => i18n.t('es', key, vars);

const TOKEN_KEY = 'fleetdeck_token';
const LANG_KEY = 'fleetdeck_lang';

const test = base.test.extend({
  // ---- options ----------------------------------------------------------

  /*
   * Language pinned in the browser before the app boots, so assertions can be
   * written against one dictionary. Set to null (test.use({ uiLanguage: null }))
   * to let the panel decide, which is what the DEFAULT_LANGUAGE spec needs.
   */
  uiLanguage: ['en', { option: true }],

  // ---- the shared panel -------------------------------------------------

  app: [async ({}, use) => {
    const instance = await startInstance({ servers: STANDARD_FLEET });
    await use(instance);
    await instance.stop();
  }, { scope: 'worker' }],

  baseURL: async ({ app }, use) => {
    await use(app.url);
  },

  // ---- a private panel, on demand ---------------------------------------

  /*
   * newApp(options) boots a panel just for this test, seeded like `app` unless
   * `servers` says otherwise; see instance.cjs for the rest of the options.
   * Every one started here is stopped when the test ends.
   *
   * Reach for this whenever the test *changes* something the next test would
   * inherit: registering or removing a server, starting a process, granting a
   * capability, tripping the login rate limiter, flipping requireAuth.
   */
  newApp: async ({}, use) => {
    const started = [];
    await use(async (options = {}) => {
      const instance = await startInstance({ servers: STANDARD_FLEET, ...options });
      started.push(instance);
      return instance;
    });
    await Promise.all(started.map((instance) => instance.stop()));
  },

  // ---- installing real servers ------------------------------------------

  /*
   * A panel that may download and install a real game server, plus a tracker
   * that removes whatever it creates when the test ends - passed or failed.
   *
   * The panel keeps its installer cache and managed Java runtimes inside its
   * own temp directory, so an interrupted install cannot leave anything in the
   * repo either. Set E2E_INSTALL_SHARED_CACHE=1 to reuse the real
   * resources/installers instead, which saves re-downloading SteamCMD on every
   * run while iterating.
   */
  installer: async ({}, use) => {
    const started = [];
    const trackers = [];

    await use(async (options = {}) => {
      const shared = process.env.E2E_INSTALL_SHARED_CACHE === '1';
      const instance = await startInstance({
        servers: [],
        ...options,
        env: (dirs) => {
          const env = {};
          if (!shared) {
            env.FLEETDECK_INSTALLER_CACHE = path.join(dirs.root, 'installer-cache');
            env.FLEETDECK_RUNTIMES_DIR = path.join(dirs.root, 'runtimes');
          }
          Object.assign(env, typeof options.env === 'function' ? options.env(dirs) : options.env);
          return env;
        },
      });
      const tracker = createTracker(instance);
      started.push(instance);
      trackers.push(tracker);
      return { panel: instance, installs: tracker };
    });

    // Sweep first, stop second: the tracker's paths live inside the instance's
    // temp directory, and stopping removes that whole tree.
    const stubborn = [];
    for (const tracker of trackers) stubborn.push(...await tracker.cleanup());
    await Promise.all(started.map((instance) => instance.stop()));
    if (stubborn.length) {
      throw new Error(`install test left files behind:\n  ${stubborn.join('\n  ')}`);
    }
  },

  // ---- browser wiring ---------------------------------------------------

  context: async ({ context }, use) => {
    // The login screen asks api.ipify.org for the public IP before every
    // submit and waits up to 3s for it. Fail it immediately: offline CI would
    // otherwise pay that timeout on every attempt.
    await context.route('https://api.ipify.org/**', (route) => route.abort());
    await use(context);
  },

  page: async ({ page, uiLanguage }, use) => {
    if (uiLanguage) {
      await page.addInitScript(([key, lang]) => {
        try { window.localStorage.setItem(key, lang); } catch { /* ignore */ }
      }, [LANG_KEY, uiLanguage]);
    }
    await use(page);
  },
});

const { expect } = base;

module.exports = { test, expect, en, es, ADMIN, OPERATOR, TOKEN_KEY, LANG_KEY, STANDARD_FLEET };
