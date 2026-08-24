# Browser tests

End-to-end tests that drive the panel in a real browser (Playwright + Chromium),
as a person uses it: type into the sign-in form, click the menu, follow the URL.
The suites under [`test/`](../test) cover the modules and HTTP routes underneath;
these cover the parts only a browser can see — rendering, routing, storage,
focus, and the order things happen in.

```bash
npm run test:e2e            # run everything, headless
npm run test:e2e:headed     # watch it happen in a visible browser
npm run test:e2e:ui         # Playwright's interactive runner (pick tests, time-travel)
npm run test:e2e:report     # open the HTML report from the last run
npx playwright test e2e/specs/auth.spec.cjs -g "locks the account"   # one test
```

There is a second, opt-in project that downloads and installs real game
servers — see [Installing real servers](#installing-real-servers).

First run on a new machine needs the browser binary:

```bash
npx playwright install chromium
```

## What runs against what

The panel serves the **built** SPA out of `public/`, so these tests exercise
whatever `npm run build` last produced — not your working copy of `src/`.

Global setup builds automatically when `public/` is missing, and warns when
sources are newer than the bundle. To rebuild first:

```bash
E2E_BUILD=1 npm run test:e2e
```

## Isolation

Nothing here touches your real `config.json`, `data/`, or registered servers.
Each panel under test is started by [`support/instance.cjs`](support/instance.cjs)
with its own temp directory and port, via two environment variables `server.js`
honours:

| Variable | Effect |
| --- | --- |
| `FLEETDECK_CONFIG` | Path to the config file to read and write (and where `running.json` is kept). Defaults to `<repo>/config.json`. |
| `FLEETDECK_DATA_DIR` | The foundation SQLite database and its snapshots. |

Accounts are seeded straight into the temp config with the same scrypt hashing
`server.js` uses, so tests never depend on the first-run default admin or on the
password policy. `instance.admin` and `instance.operator` carry the credentials.

## Seeded servers

Most of the panel is a view onto files — worlds are folders, configs are files,
backups are archives. So [`support/seed.cjs`](support/seed.cjs) lays down a
realistic tree in the instance's temp directory and registers a server pointing
at it. The panel then reads and writes for real, and a spec can assert on what
landed on disk.

Every panel starts with one server per module unless a spec says otherwise:

| Name | Module | What it has |
| --- | --- | --- |
| Survival | minecraft | `server.properties`, three worlds, plugins, a log |
| Hardmode | terraria | `serverconfig.txt` and a `.wld` with a real, parseable header |
| Midgard | valheim | `data/worlds_local/Midgard.{db,fwl}` |
| Pal Camp | palworld | `Pal/Saved/Config/…/PalWorldSettings.ini`, a save |
| Worker | custom | **Actually runs** — see below |

`Worker` points the custom module at
[`support/fake-process.cjs`](support/fake-process.cjs), a small script that
prints a ready line, echoes what it is sent, and exits on `stop` or on `boom`.
So starting it spawns a real child process, and the console tests drive the
whole path — stdin to the child, stdout back through the manager, over the
WebSocket, into the view. That is how lifecycle, status, crash handling and the
console are covered without installing Java or a game.

Override the fleet per test:

```js
const panel = await newApp({
  servers: (dirs) => [
    seed.minecraft(dirs, { name: 'Survival' }),
    seed.terraria(dirs, { name: 'Modded', variant: 'tmodloader' }),
  ],
});
```

## Installing real servers

`e2e/specs/install.spec.cjs` is a separate Playwright project that drives the
create wizard for real: it downloads from the actual upstream, checks what
landed on disk, and removes it again. It is **not** part of `npm run test:e2e`.
Opt in per game, because the sizes differ by orders of magnitude:

```bash
E2E_INSTALL=minecraft npm run test:e2e:install            # ~50 MB, under a minute
E2E_INSTALL=minecraft,terraria npm run test:e2e:install   # + a few hundred MB
E2E_INSTALL=all npm run test:e2e:install                  # + Valheim (~1 GB), Palworld (several GB)
```

Without `E2E_INSTALL` every test in that project skips itself. It runs one
worker and no retries — retrying a twenty-minute download to paper over a flake
helps nobody.

These install specs also run automatically in CI (workflow install-e2e.yml)
nightly and on version tags, so upstream breakage (a download URL or game
version moving) is caught without a manual run.

### Nothing survives the test

That is the whole point of the design, because an interrupted download is
expensive to leave behind. Four layers, in order:

1. **The test removes the server through the UI** — remove profile, move files
   to trash — because that round trip is what the test is for.
2. **The `installer` fixture sweeps** the folders it was given, which covers a
   test that died halfway through a download.
3. **The instance's temp directory goes at teardown.** Installs are written
   inside it, and the panel's installer cache and managed Java runtimes are
   redirected there too (`FLEETDECK_INSTALLER_CACHE`, `FLEETDECK_RUNTIMES_DIR`),
   so a half-downloaded SteamCMD does not survive either. Set
   `E2E_INSTALL_SHARED_CACHE=1` to reuse the repo's real `resources/installers`
   instead, which saves re-downloading SteamCMD while iterating.
4. **Global teardown sweeps this run's instance directories**, for the case
   none of the above ran: a worker killed outright never runs fixture teardown.
   Global setup also removes any directory older than an hour left by a run
   that crashed earlier.

Nothing is written into the repository, and nothing touches the developer's
real Hostkind install.

```js
test('installs and removes', async ({ page, installer }) => {
  const { panel, installs } = await installer();   // panel + tracked cleanup
  await signInFast(page, panel);
  // ... drive the wizard with installs.parentDir as the parent folder
});
```

## Fixtures

From [`support/fixtures.cjs`](support/fixtures.cjs):

- **`app`** — a panel shared by every test in the worker, because a boot costs
  ~2s. Safe for tests that read, or that write state they own.
- **`newApp(options)`** — a panel of your own, stopped when the test ends. Use
  it whenever a test moves state the next test would inherit: registering or
  removing a server, starting a process, granting a capability, tripping the
  login rate limiter, flipping `requireAuth`.
- **`baseURL`** — points at `app`, so `page.goto('/')` works. A panel from
  `newApp()` has its own `url`; pass it as `origin` to `openView`.
- **`uiLanguage`** — pins the browser's stored language, `'en'` by default, so
  assertions can be written against one dictionary. `test.use({ uiLanguage: null })`
  lets the panel choose, which is what the `DEFAULT_LANGUAGE` spec needs.
- The login screen's public-IP lookup (`api.ipify.org`) is aborted for every
  test — otherwise each sign-in pays that request's 3s timeout when offline.

## Writing a test

Three support modules, with a clear division:

- [`support/pages.cjs`](support/pages.cjs) — **locators only**. A markup or copy
  change is fixed in one place.
- [`support/actions.cjs`](support/actions.cjs) — **flows**: `signInFast`,
  `openView`, `enterGame`, `dismissTour`.
- [`support/api.cjs`](support/api.cjs) — **arranging state** over HTTP.

Arrange over HTTP, act and assert through the browser. Clicking through six
dialogs to reach the state a test is about makes it slow and makes it fail for
unrelated reasons — and those routes are already covered by `test/`.

```js
const { test, expect, en } = require('../support/fixtures.cjs');
const { serverRow, toasts } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');
const { client } = require('../support/api.cjs');

test('starts a process from its row', async ({ page, newApp }) => {
  const panel = await newApp();
  await signInFast(page, panel);                                  // no login form
  await openView(page, 'custom', 'servers', { origin: panel.url });

  await serverRow(page, 'Worker').start.click();

  await expect(serverRow(page, 'Worker').status).toHaveText(en('status.online'));
});
```

Text assertions read their strings from `i18n.cjs` — the same dictionary the UI
renders — so reworded copy doesn't break a test that was never about wording.

### Locator rules

- Prefer, in order: a role plus its accessible name, a `data-tour` or
  `data-nav-item` attribute the app already carries, then a form control's
  `autocomplete` token.
- **Name and title matching are substring matches.** `"Start"` also finds
  `"Restart"`; `"world"` also finds `"world_nether"`; `"Up"` also finds
  `"Updates"`. Pass `exact: true`, or use `tableRow` / `serverRow` / `userRow`,
  which match one exact cell value.
- `Field` (`src/components/ui/field.jsx`) renders its `<Label>` without a `for`,
  so form inputs it wraps are **not** reachable through `getByLabel`.
- Radix dialogs render in a portal. Scoping a click to the dialog root usually
  works, but if a control seems unclickable, address it at page level.

### Assert outcomes, not toasts

A toast lives 3.5 seconds. On a loaded machine a test can arrive after it has
gone, which makes a passing feature look broken. So for a success flow, assert
the thing that lasts — the row disappeared, the file changed on disk,
`panel.readConfig()` no longer lists it. Keep toast assertions for the cases
where the toast *is* the outcome: errors, warnings, "not supported".

### Known failures

When you find a real bug you are not fixing now, write the test for the
behaviour you *want*, mark it `test.fail()`, and put the cause in a comment
above it. Playwright counts an expected failure as a pass, and reports an
unexpected success as a failure — so whoever fixes the bug is told to remove
the marker. The suite currently carries none; the four that shipped with the
first browser pass (operator fleet load, Valheim worlds gating, the
`worlds.dimension.*` key, variant-gated cold loads) were cleared in the
hardening wave.

## Debugging a failure

Failures keep a screenshot and a trace under `e2e/results/` (both git-ignored):

```bash
npx playwright show-trace e2e/results/<test-name>/trace.zip
```

The trace has the DOM at every step, the network log, and the console. If the
panel itself is suspect, `instance.log()` returns everything it has printed.

## Scope

| Spec | Covers |
| --- | --- |
| `auth.spec.cjs` | Sign-in by username and email, wrong credentials, no account enumeration, lockout, password reveal, session persistence, expired and rejected tokens, sign-out. |
| `boot.spec.cjs` | First-paint routing, unknown paths, last-location restore, deep links dropped at sign-in, guest mode, pre-sign-in language. |
| `servers.spec.cjs` | The registry per game, active server, registering and validation, renaming, removal with and without trashing files, start/stop/restart against a real process, operator permissions, the folder picker round-trip. |
| `console.spec.cjs` | Live output, commands and replies, offline guard, history replay, reload, filtering, a 300-line burst, crash handling. |
| `files.spec.cjs` | Listing, walking folders, filtering, editing to disk, creating, renaming, deleting with confirmation, path traversal refused. |
| `configs.spec.cjs` | Friendly and raw editors, the diff before saving, the timestamped `.bak`, reset, Terraria's own editor, unsupported games. |
| `worlds.spec.cjs` | Minecraft worlds and missing ones, Terraria world headers, Valheim gating. |
| `backups.spec.cjs` | Creating a real archive, verifying, listing contents, deleting, retention limits. |
| `admin.spec.cjs` | Accounts and roles, password policy, duplicate usernames, self-deletion, capability grants, the sign-in switch, audit trail, schedules, update centre. |
| `shell.spec.cjs` | The games hub, sidebar navigation and per-game sections, module gating for every view, language switching, the onboarding tour, server switching and per-game memory. |
| `install.spec.cjs` | **Opt-in.** Real downloads and installs for Minecraft, Terraria, Valheim and Palworld, an interrupted install, and the removal of each afterwards. |

Deliberately not covered by the default run: starting an installed game server
and playing against it — that needs Java or a Steam runtime and minutes of
warm-up. The `custom` module's fake process covers the parts of the lifecycle
that are game-independent (spawn, stdout, commands, stop, crash), and the
module suites in `test/` cover the game-specific parsing underneath.

## Parallelism

Every worker runs a Chromium *and* a Node panel, and they all boot at once at
the start of a run. Past ~4 workers the boots queue behind each other and each
test in the first batch pays for it, which is why `workers` is capped in
[`playwright.config.js`](../playwright.config.js). If the whole first batch
looks slow, that is what you are seeing.
