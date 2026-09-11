# Changelog

All notable changes to Hostkind are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No entries yet.

## [0.1.3.2] - 2026-09-11

### Added

- In-app updates are live: releases now ship a signed Ed25519 update manifest and installed binaries carry the built-in release public key, so outdated installs detect new versions and update with one click. `HOSTKIND_UPDATE_PUBLIC_KEY` overrides the built-in key for rotation and testing. Installs before 0.1.3.2 need one manual installer run to pick up the key.

## [0.1.3.1] - 2026-09-11

### Added

- Persistent, closeable in-app update notice: launching an outdated install shows a non-invasive toast with a one-click update flow (download, install, restart) plus a release-notes link. It reappears on next launch until updated and never interferes with other toasts.

### Improved

- The application updater now detects four-part versions (`X.Y.Z.W`): `0.1.3.1` registers as newer than `0.1.3`. Release packaging, signed update manifests, and the installer accept strict `X.Y.Z[.W]` versions, so four-part releases can ship a signed in-app update manifest instead of manual-download-only installers (activated in 0.1.3.2).

## [0.1.3] - 2026-09-10

### Added

- Minecraft Content brings Modrinth browsing, local plugin/mod JAR uploads, CurseForge server-pack ZIP imports, and FTB installer imports into one page.
- API-free CurseForge imports inspect user-supplied files before installation and report unsupported client exports that require unresolved downloads.
- Administrator-only FTB imports support pack IDs, latest or specific versions, source attestation, and explicit Minecraft EULA acceptance. Advanced controls prepare an official installer.
- Content APIs and database migration 16 record provider metadata and import provenance while preserving compatibility with existing routes.

### Improved

- Dedicated import dialogs separate CurseForge and FTB workflows, explain file requirements, label required fields, and show why an action is unavailable.
- Import inspection and installation display progress and errors, prevent duplicate installation, and adapt to mobile screens with keyboard-accessible controls.
- Panel, development, and tunnel launchers resolve configured ports consistently. Vite proxies follow the selected panel port.
- Windows and shell launch/stop scripts improve listener detection and port-release handling; a shell launcher is now available for the development manager.
- Public-repository guards cover install, secret-scan, and ZAP workflows. Contributor documentation describes local snapshot publication and public release validation.

### Fixed

- Updated database upgrade and server-template fixtures for the expanded content metadata schema.

### Compatibility

- CurseForge imports require local JARs or a self-contained server pack; Hostkind does not resolve client-export references through the CurseForge API.
- FTB installation requires an appropriate installer supplied by the administrator and explicit EULA acceptance.

## [0.1.2.3]

This release puts one-click installers on the Releases tab so non-technical
users can install Hostkind without Node.js, npm, or a terminal.

### Added

- **Windows installer**: `Hostkind-<version>-Setup.exe` (one-click NSIS,
  Start-menu launcher) published to every tagged GitHub Release, plus a
  `Hostkind-<version>-Portable.zip` fallback for hosts where Smart App
  Control blocks the unsigned setup.
- **Linux installers**: `hostkind_<version>_amd64.deb` for Ubuntu/Debian
  double-click installs and a `Hostkind-<version>.AppImage` portable
  fallback, both published to every tagged GitHub Release.
- **Release pipeline**: tag-triggered `build-installer-windows` and
  `build-installer-linux` CI jobs; the `release` job hashes every installer
  asset (`scripts/collect-installer-artifacts.cjs`), feeds the NSIS setup
  and AppImage into the signed Ed25519 update manifest, and attaches all
  assets with `.sha256` sidecars.
- **Documentation**: installer-first README, new `LINUX-DISTRIBUTION.md`,
  rewritten `WINDOWS-DISTRIBUTION.md`, and desktop upgrade notes in
  `UPGRADING.md`.

### Notes

- The Windows installer is published **unsigned** (no trusted Authenticode
  material is available): expect a SmartScreen / Smart App Control warning,
  use the portable ZIP when the setup is blocked, and never disable OS
  security controls. The Ed25519 update manifest + SHA-256 hashes protect
  update integrity but do not confer Authenticode trust.
- Desktop installers update by re-downloading the next release: the signed
  in-app update manifest only activates for strict `X.Y.Z` releases, so this
  patch build (`0.1.2.3`) upgrades through a fresh installer run.

## [0.1.2.2] - 2026-08-30

This release adds a guarded way to return Hostkind to a clean first-run state.

### Added

- **From-scratch reset**: `npm run reset` removes local credentials,
  configuration, application state, runtime state, and supported caches before
  starting a fresh panel process.
- **Optional server cleanup**: registered server folders and backups are kept by
  default. Passing `--include-servers` selects them for deletion.

### Security and reliability

- The detached panel started by reset no longer inherits terminal streams, which
  prevents dead terminal handles from wedging the API bootstrap after reset.
- Reset requires two exact confirmations and never accepts a non-interactive
  confirmation bypass. Server deletion requires a separate second token.
- The command refuses to run while Hostkind or a configured game server is
  active, validates every deletion target before mutation, and rejects unsafe or
  overlapping server paths.
- Reset coverage uses temporary filesystem fixtures and verifies both deletion
  and preservation behavior without touching an installed Hostkind instance.

### Release artifacts

- The release source includes the reset command, focused tests, and updated
  upgrade guidance. The packaged artifact includes a prebuilt panel and
  SHA-256 manifests.

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
