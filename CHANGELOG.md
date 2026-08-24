# Changelog

All notable changes to Hostkind are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Per-game custom colours** (`config.gameAccents` + Settings > Game colours):
  each game implementation (minecraft, terraria, valheim, palworld, custom) can
  take its own accent colour, either set by hand in `config.json` (one hex per
  game, blank or invalid keeps the built-in theme) or picked in an admin-only
  Settings section that applies immediately, no restart. The colour's hue
  drives the whole ramp (ember/coal/ink), gamut-fitted per rung, and the online
  status signal is rotated away when a hue would collide with it.

- **Upgrade-drill test** (`test/upgrade-drill.test.cjs`): automated proof
  that a v0.1.0-schema database (migrations 1–12) upgrades cleanly to the
  current version.  Covers idempotent no-op upgrade, pending-migration
  upgrade with snapshot creation, rollback-on-failure recovery, and full
  schema-completeness assertion.

### Changed

- **Onboarding tour completion is shared across games**: the per-game
  walkthroughs are near-identical, so finishing (or dismissing) the tour in
  one game now marks it seen in every game — entering another game never
  reopens it. Existing users who completed a game before this change are
  still treated as seen (their old per-game flag counts for all). Replay
  from Settings > Replay tour still works.

- **Snapshot prefix renamed** (`lib/migrations.cjs`): `takeSnapshot()` now
  writes `fleetdeck-<stamp>.db` instead of `lodestone-<stamp>.db`.
  `pruneSnapshots()` and `listSnapshots()` accept **both** prefixes so
  existing installations with `lodestone-*.db` snapshots continue to work.

### Notes

- v0.2 will also include **node-cron@4** upgrade and **Minecraft
  portability** work (owned by other agents; details deferred to their
  changelog entries).

- **No migration 13 was added.**  A thorough audit of query paths in
  `lib/` against hot tables (metric\_samples, health\_alerts, api\_keys,
  crash\_groups, audit\_events, backup\_manifests, template\_versions)
  found no underserved index or missing column.  The upgrade path is a
  valid idempotent no-op.

## [0.1.0] — 2026-08-11

First tagged release. This pass makes the project buildable, testable, and
shippable: CI gates every change, releases ship as a built, checksummed
artifact, and upgrades are documented and safe. The tag `v0.1.0` matches
`package.json` (CI asserts it).

### Added

- **CI** (`.github/workflows/ci.yml`): backend + module tests, the SPA build,
  and the Playwright browser suite run on Node 22 for every push to `main` and
  every pull request. A tag-triggered `release` job rebuilds the SPA, packages
  the artifact, and publishes it to a GitHub Release with checksums.
- **Packaging** (`npm run package`): produces `dist/hostkind-<version>.zip`
  from the prebuilt `public/`, `server.js`, `lib/`, `i18n.*`, `resources/`,
  license, config, and README files, plus a generated `version.json`. Emits
  `dist/SHA256SUMS` and a per-file `SHA256SUMS` inside the archive. Refuses to
  run when `public/` has not been built, so an artifact always contains the
  real panel.
- **Preflight start check** (`npm run prestart`): a fresh clone that has not
  run `npm run build` now fails fast with a clear message instead of serving a
  panel that renders nothing.
- **Upgrade documentation** (`UPGRADING.md`): how to back up, replace,
  verify checksums, and start the new release, and how the foundation
  migrations run (and are recovered) on boot.

### Changed

- **Hardening across the platform**: security fixes and durable
  operation/install improvements landed in `lib/` (capabilities, downloads,
  operations, install/resume, file-manager safety, server list, WebSocket
  commands) and their tests. See the individual commits for detail.
- **Licensing**: the project is licensed under AGPL-3.0-only with a separate
  commercial license, and third-party material is documented in
  `THIRD_PARTY_NOTICES.md`.
- **Assets**: releases ship the SPA prebuilt, so a deployment no longer needs a
  checkout-time build; `public/` remains gitignored in the repository.
- **Stability fixes since the first draft**: .NET runtime discovery tests are
  hermetic (no host dotnet interference), the folder-picker timeout test holds
  the event loop open (no CI hang on quiet runners), Windows service install
  lines are built with `path.win32` (host-independent), and the health
  correlations notice stacks under its title on narrow cards. Native-module
  install scripts are whitelisted via `allowScripts` so `npm ci` works on
  npm 11+.

### Notes

- Node `>=20` is required (`package.json` engines). CI validates on Node 22
  LTS, which is also the recommended runtime for the current Terraria/TShock
  toolchain.
