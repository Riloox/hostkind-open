# Windows distribution

Since 0.1.2.3, the GitHub Release for each tag ships a Windows installer and
a portable fallback, both built from the Electron desktop app. You do not
need Node.js, npm, or a terminal to install Hostkind.

## Which file to download

From the [GitHub Releases page](https://github.com/Riloox/hostkind-open/releases),
pick one of:

- `Hostkind-<version>-Setup.exe` — the recommended one-click installer.
  Double-click it, approve the install, then launch Hostkind from the Start
  menu.
- `Hostkind-<version>-Portable.zip` — the fallback. Extract it anywhere and
  run `Hostkind.exe`. No installation step; useful when the installer itself
  is blocked (see below).

## Unsigned installer warning (expected)

No trusted Authenticode signing material is available for this project, so
the installer is published **unsigned**. Windows SmartScreen and Smart App
Control may warn about it or refuse to launch it. That is expected protection
behavior for an unsigned binary:

- Prefer the signed-integrity signal that does exist: each asset ships with a
  `.sha256` sidecar, and the in-app updater validates its Ed25519 release
  manifest plus the SHA-256 artifact hash before applying an update.
- If Smart App Control blocks the setup executable, use the portable ZIP
  instead of weakening the host policy.
- Do not disable Smart App Control, Defender, or other Windows security
  controls to run the installer.

## First run and data locations

The desktop app keeps all mutable state in per-user locations, outside the
install directory, so reinstalling never destroys your configuration, SQLite
state, downloaded installers, runtimes, servers, or backups
(`electron/runtime.cjs`):

- `%APPDATA%\Hostkind\` — `config.json`, `data/`, `running.json`, `logs/`,
- `%LOCALAPPDATA%\Hostkind\` — installer cache and runtimes,
- `Documents\Hostkind\` — servers and backups.

## Local desktop builds

The Electron entry points are `electron/main.cjs` and `electron/runtime.cjs`. The packager configuration is `packaging/windows/electron-builder.cjs`.

Build the source desktop smoke test:

```text
npm run desktop:smoke
```

Build the unpacked Windows application:

```text
npm run desktop:pack
```

Build the NSIS installer plus the portable fallback:

```text
npm run desktop:dist:win
```

`scripts/collect-installer-artifacts.cjs --portable-zip` zips
`dist-electron/win-unpacked` into `Hostkind-<version>-Portable.zip`.
`--manifest` hashes the installer assets and emits the updater payload
consumed by `scripts/create-update-manifest.cjs`.

On a host with Smart App Control enforcing, electron-builder may fail with
`spawn UNKNOWN` while it tries to launch the unsigned generated NSIS artifact to
extract the uninstaller. Do not disable security controls to bypass that step;
use `desktop:pack` and the packaged-ASAR smoke test instead, and do not treat a
partial `dist-electron` output as a distributable release.

All local Windows outputs are explicitly unsigned development artifacts when
built on your own machine. They are useful for packaging and updater tests;
only the CI-built assets attached to a tagged GitHub Release are releases.

The packaged archive can still be exercised through the installed Electron runtime:

```text
npm run desktop:smoke:packaged-asar
```

The direct packaged executable smoke test may be blocked by Smart App Control when the local executable is unsigned:

```text
npm run desktop:smoke:packaged
```

That block is expected protection behavior, not a reason to weaken the host policy.

## Update validation

The application updater validates its Ed25519 release manifest and SHA-256 artifact hash. That protects update integrity, but it is separate from Windows Authenticode and does not make an unsigned installer trusted by Smart App Control.

## Public CI release contract

`.github/workflows/ci.yml` runs the tested source/web release path plus two
tag-triggered installer jobs (`build-installer-windows` on `windows-latest`,
`build-installer-linux` on `ubuntu-latest`). The `release` job collects the
installer assets, hashes them (`scripts/collect-installer-artifacts.cjs`),
signs the update manifest when the signing secret exists, and publishes to
the GitHub Release: the source package with checksums, `Hostkind-*-Setup.exe`
with its portable ZIP fallback, the Linux `.deb` and `.AppImage`, and the
signed update manifest.
