# Contributing to Hostkind

Thanks for considering a contribution. Hostkind is dual-licensed: the code is
`AGPL-3.0-only` (see `LICENSE`), and a separate commercial license exists for
hosting providers and OEM redistribution . By
contributing you keep the project clean enough to keep that promise — in practice
that means three things: sign your work (DCO), test what a user can see, and never
introduce unlicensed assets.

## Development setup

Requirements: Node.js 22 or newer.

```bash
npm install        # install dependencies
npm run dev        # Vite dev server on :5173, proxying the API to :2121
npm run build      # regenerate public/ from src/
npm start          # run the panel on the port in config.json (default 2121)
npm test           # backend and module tests (no framework, node test/*.test.cjs)
npm run test:e2e   # Playwright browser tests; see e2e/README.md
npm run test:e2e:install   # opt-in real downloads; needs E2E_INSTALL=<games>
```

Layout is documented in `CLAUDE.md`. The short version: `server.js` is the panel,
`lib/` is platform and module code, `lib/modules/<game>/` holds one folder per game
(`minecraft`, `terraria`, `valheim`, `palworld`, `custom`), `src/` is the React SPA,
`i18n.json` holds every user-facing string in English and Spanish, `test/` is the
Node test suite, and `e2e/` is the Playwright suite.

## Testing policy

**Every change to a user-facing feature ships with a browser test.** Not instead of
the unit tests — as well as. The suites under `test/` prove a route or module
behaves; they cannot tell you the button is unreachable, the guard bounces you to
the dashboard, or the label renders as a raw translation key. All three of those
were real bugs here.

Add or extend a spec in `e2e/specs/` when you:

- add or change a **view**, a **dialog**, or anything in the sidebar/header/dock;
- add or change a **route guard** or capability gate (who may open what);
- add a **module capability** — cover which views the game now offers, and which it still does not;
- change **navigation**, URL shape, or what survives a reload;
- fix a **UI bug** — the test is the thing that stops it coming back.

Backend-only work (a new lib function, a parser, a migration) belongs in `test/` and
does not need a browser test.

Run before you claim a change works:

```bash
npm run build && npx playwright test
```

The build is not optional: the panel serves the prebuilt `public/`, so an unbuilt
change is not the one under test. `E2E_BUILD=1 npm run test:e2e` does both. Read
`e2e/README.md` for the fixtures, the seeded servers, and the locator rules before
writing a spec. If you find a real bug you are not fixing in this change, write the
test for the behaviour you want, mark it `test.fail()`, and explain the cause in a
comment above it.

## Conventions worth keeping

- **No new user-facing strings in JSX.** Add them to `i18n.json` in both languages
  and call `t('key')`. Dynamic keys are invisible to static checks — verify those by
  eye or with a test.
- **Modules never borrow another game's behaviour.** An unknown server type resolves
  to the `unsupported` module rather than silently acting like Minecraft.
- **Capabilities are per-server unless they are genuinely global.** A `NULL` server
  scope is not a wildcard (`lib/capabilities.cjs`).
- **Destructive actions confirm first, and prefer trash to deletion.** Removing a
  server offers to move files to recoverable trash; it never deletes them.
- **Comments explain why, not what.** Match the existing density: the codebase
  documents the reasoning behind non-obvious choices, and skips narrating the obvious.
- **`config.json` and `data/` are the user's.** Never write to them from a test or a
  script; honour `FLEETDECK_CONFIG` and `FLEETDECK_DATA_DIR`.

## Contribution process

1. **Open a pull request** against `main`. Keep it focused; a reviewable change is a
   small change.
2. **Sign your commits (DCO).** Every commit must carry a
   `Signed-off-by: Name <email>` trailer certifying you have the right to contribute
   the work. See `DCO.md`. Use `git commit -s`.
3. **No unlicensed assets.** See "Asset provenance" below. A PR that adds an asset
   without a licence will be sent back.
4. **License headers.** New and substantially rewritten source files should carry the
   AGPL-3.0 short header from `docs/license-header.txt`
   (`SPDX-License-Identifier: AGPL-3.0-only`). See "License headers" below.
5. **Tests.** Include or extend the relevant `test/` and `e2e/` coverage per the
   testing policy, and confirm the suite is green before asking for review.

## Asset provenance (mandatory)

The repository ships under AGPL and commercially, so its art must be clean:

- **No unlicensed third-party game art.** Official logos, screenshots, and textures
  of Minecraft, Terraria, Valheim, Palworld, or any other game are not licensed to
  this project. They must not be added to the repo. This includes embedding them in
  larger composites (a mockup, a banner, a wallpaper).
- **Only add an asset you own or are licensed to redistribute.** If you bring in a
  genuinely third-party asset (a font, an icon set, a texture), include its licence
  and provenance in `THIRD_PARTY_NOTICES.md` in the same PR — source, author, licence,
  and a link — and confirm the licence permits bundling and (for the dual license)
  commercial redistribution.
- **Prefer generated or self-authored art** for panel and README graphics. Hostkind
  ships neutral, procedurally generated placeholders for exactly this reason (see
  `THIRD_PARTY_NOTICES.md`).
- **Preferred license list.** For libraries and fonts, prefer permissive or
  share-alike licenses (MIT, Apache-2.0, BSD, SIL OFL) whose terms permit redistribution
  in a commercially-licensed product. Avoid GPL-family assets that would taint the
  commercial distribution.
- **Provenance review is a merge requirement**, the same as a green test suite.

## License headers

The project license is `AGPL-3.0-only`. The short header template lives at
`docs/license-header.txt` and reads:

```
// SPDX-License-Identifier: AGPL-3.0-only
```

Apply it to new and substantially rewritten source files, in the comment syntax of
the language (for HTML/JSX, `<!-- ... -->`; for CSS, `/* ... */`). A bulk
re-header of existing files is not something a contributor should do casually —
check with the maintainer first so it lands once and does not conflict with
in-flight work.

## Docs

User-facing and code-adjacent docs live in `docs/`, next to the code they describe,
and at the repo root (`README.md`, `THIRD_PARTY_NOTICES.md`). Note that the `docs/`
tree is currently gitignored (`/docs/` in `.gitignore`) — it was pulled from the
repository as working material. Docs that need to travel with a clone live at the
root (`README.md`) or beside their code (`e2e/README.md`). If your change adds a doc
that must ship, it should live at the root or you should get `docs/` re-tracked as
part of the change.

## Reporting a problem

Open an issue describing what you expected, what happened, and the smallest
reproduction you can. If the problem is a user-facing bug, a browser test that
captures it is worth more than a paragraph.
