# Changelog

All notable changes to Hostkind are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No entries yet.

## [0.1.2.1] - 2026-08-28

This release makes Terraria administration and update review clearer and safer.

### Added

- **Terraria player management**: vanilla Terraria servers now have a dedicated
  live roster with connected-player counts and Terraria-specific Kick and Ban
  actions. TShock keeps its existing REST-backed player surface.
- **In-app changelog**: returning users see the complete changelog for a new
  build instead of a condensed what's-new tour.

### Improved

- **tModLoader mod imports**: the review step now shows the exact source,
  Workshop item, planned changes, internal names, versions, and authors before
  any files are written.
- **Replacement safety**: replacing an installed mod requires an explicit
  acknowledgement, while blocked modpacks show why they cannot be applied yet.
- **Import timing**: the review explains that Hostkind creates and verifies a
  safety snapshot first, the server must be offline, and tModLoader applies the
  new set after its next restart.

### Security and reliability

- Steam Workshop thumbnail hosts are allowlisted explicitly in the Content
  Security Policy instead of permitting arbitrary remote images.
- Terraria player targets are validated before console commands are built, and
  unsupported Minecraft or TShock actions are rejected.
- Added focused coverage for Terraria player routing, console actions, Workshop
  image policy, and the translated import-review states.

## [0.1.2] - 2026-08-27

This release makes Hostkind easier to install, move, update, and recover.

### Added

- **Windows desktop support**: a packaged desktop path and launcher make it
  easier to run Hostkind locally, with clearer startup failures and logs.
- **In-app updates**: administrators can check for a release, review its notes,
  download it, and explicitly approve installation before Hostkind restarts.
- **Portable server definitions**: server setup can be described for moving to
  another machine without carrying over machine paths, credentials, tokens,
  binaries, or real network bindings.
- **Verified recovery checks**: restore drills compare the complete file list,
  sizes, and checksums instead of relying on a partial success signal.
- **Safer optional remote connections**: one-time pairing and lifecycle checks
  provide a clearer foundation for connecting and managing remote targets.

### Improved

- **Minecraft onboarding**: adopting an existing installation now has a folder
  picker as well as the direct path option.
- **Modpack installs**: background installation progress can be dismissed
  without cancelling the install.
- **Health incidents**: crash history is easier to scan, with clearer timing,
  evidence, backup context, suggested checks, and next actions.
- **Game colours**: each supported game can have its own accent colour in
  Settings, applied immediately without a restart.
- **Onboarding**: completing the tour in one game keeps it completed across the
  other games, while replay from Settings remains available.
- **Modrinth content**: project icons are now allowed to load in the panel.
- **Upgrades**: existing snapshots using the older name remain usable after an
  upgrade.

### Changed

- **Server Tools** now focuses on Palworld connectivity and profile controls.
  The former panel presentation controls are no longer shipped.

### Security and reliability

- Exported definitions, update metadata, pairing, and restore checks now apply
  stricter validation and keep sensitive machine details out of portable data.
- Release packaging, startup, migration, and Windows service paths have broader
  automated coverage so a release is less likely to fail after installation.

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
