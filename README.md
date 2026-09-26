<div align="center">

# Hostkind

**Run your game servers from one local dashboard.**

Start, stop, monitor, update, and back up your servers without handing your data to a hosted service.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-ff6b35?style=flat-square&logo=github&logoColor=white)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-23140e?style=flat-square&logo=terminal&logoColor=white)](#download-and-run)

</div>

![Hostkind dashboard](resources/hero.webp)

Hostkind is a free, self-hosted app for dedicated game servers and other long-running processes. It runs on your own computer, keeps your files local, and does not require a cloud account, external database, or API key.

---

## Features

|  |  |
| --- | --- |
| **Process supervision** | Start, stop, restart, and monitor multiple servers, with crash detection and watchdog restarts. |
| **Live consoles** | Stream console output and send commands over WebSocket. |
| **Metrics & health** | Track players, CPU, memory, disk, uptime, and game-specific health signals. |
| **File manager** | Browse and edit files with path-traversal protection and safety snapshots. |
| **Worlds** | Manage, import, and back up worlds and save files. |
| **Backups** | Create, download, restore, verify, schedule, and retain backups. |
| **Mods & content** | Install mods, plugins, and modpacks for supported games. |
| **Schedules** | Run scheduled commands, restarts, and maintenance actions. |
| **Users & roles** | Local users with admin and operator roles, plus API keys. |
| **Audit trail** | Record administrative and security-relevant activity in a local audit log. |
| **In-app updates** | Check for, review, and install new Hostkind releases from Settings. |
| **Languages** | English and Spanish. |

Some tools are game-specific. Hostkind only shows the tools supported by the active server.

## Supported games

| Game | Server types | Highlights |
| --- | --- | --- |
| **Minecraft** | Vanilla, Paper, Spigot, Fabric, Forge, NeoForge | Fetches current stable versions and provisions the right Java runtime. Modrinth browsing and modpacks (`.mrpack`), local plugin/mod JAR uploads, CurseForge server-pack imports, and FTB installer imports. Player and world management with safe world backups. |
| **Terraria** | Vanilla, TShock, tModLoader | Install or register servers, edit `serverconfig.txt` with history, manage and import worlds. Live player roster with kick and ban, TShock REST administration, and reviewed tModLoader Workshop mod imports. |
| **Valheim** | Dedicated server | Install through SteamCMD or register an existing server. Manage world saves, updates, and backups. |
| **Palworld** | Dedicated server | Install through SteamCMD on Windows and Linux. Loopback-only REST API integration for health, players, announcements, saves, and guarded shutdown. Settings editor, map data, updates, mods, and backups. |
| **Other processes** | Any long-running command | Register a command and configure how Hostkind starts, stops, and checks it. |

Hostkind keeps process management generic and puts game-specific behavior (launch preparation, readiness detection, graceful shutdown, console parsing, health checks, content workflows) in modules under `lib/modules/`.

## Download and run

Each release on the [Releases page](https://github.com/Riloox/hostkind-open/releases) ships ready-to-run installers:

- **Windows**: download `Hostkind-<version>-Setup.exe`, double-click it, then
  launch Hostkind from the Start menu. The installer is unsigned, so Windows
  may warn about it; if it is blocked, extract
  `Hostkind-<version>-Portable.zip` and run `Hostkind.exe` instead. Never
  disable Smart App Control or Defender to run it. See
  [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).
- **Linux**: download `hostkind_<version>_amd64.deb` and double-click it to
  install (Ubuntu/Debian), or make `Hostkind-<version>.AppImage` executable
  and double-click it on other distributions. See
  [LINUX-DISTRIBUTION.md](LINUX-DISTRIBUTION.md).

The desktop app keeps your servers and settings in per-user folders outside the install directory, so updating or reinstalling never deletes them. Updates install from **Settings → Application update**.

### Advanced: headless install (Node.js 22+)

On Windows, double-click `start-panel.bat`. On Linux or macOS:

```sh
./start-panel.sh
```

The launcher installs dependencies on first use, builds the frontend, creates local configuration, and starts the panel at <http://localhost:2121>. To run the steps yourself:

```sh
npm ci
npm run build
npm start
```

Prebuilt `hostkind-<version>.zip` releases already contain the built panel, so `npm ci --omit=dev` and `npm start` are enough.

On first start, Hostkind creates `config.json` and generates a one-time administrator password. The username is `admin`; the password is printed in the terminal and saved in `initial-admin-password.txt` next to `config.json`. Sign in once, then change the password in Settings.

### Configuration

To customise settings before the first start, copy `config.example.json` to `config.json` and edit it. The config holds the panel address, users, servers, backup settings, schedules, and optional integrations. Secrets and machine-specific paths are git-ignored.

Hostkind listens on your local machine by default. Do not expose the panel to a network or the Internet unless you have deliberately configured authentication and secured the connection. See [OPERATIONS.md](OPERATIONS.md).

### Reset to a fresh state

Stop the panel and all game servers first, then run:

```sh
npm run reset
```

The default reset removes local credentials, configuration, application data, running state, metrics, runtimes, installer data, and supported caches. Registered server folders and backups are preserved. To also remove registered server folders, run `npm run reset -- --include-servers`.

Both modes require two exact confirmations, and server deletion uses a separate confirmation token. Add `--no-start` to reset without launching a fresh panel.

## Releases

A version tag (`vX.Y.Z[.W]`) runs the release pipeline in this repository and publishes a GitHub Release with:

- `hostkind-<version>.zip` (prebuilt source distribution) with its SHA256 checksum and full manifest,
- `Hostkind-<version>-Setup.exe` plus the `Hostkind-<version>-Portable.zip` fallback (Windows),
- `hostkind_<version>_amd64.deb` and `Hostkind-<version>.AppImage` (Linux).

Verify a download with:

```sh
sha256sum -c hostkind-<version>.zip.sha256
```

Each installer ships its own `.sha256` sidecar, verified the same way.

## Open edition

This repository is the open edition of Hostkind. Every feature is included, with no activation or keys. Code lands here as release snapshots rather than as a continuously synced history.

## License

Hostkind is licensed under AGPL-3.0: you are free to use, modify, and distribute it, and if you distribute a modified version you must share those modifications under the same license. The full text is in [`LICENSE`](LICENSE). A commercial license is available for deployments that run ads or offer Hostkind as a managed service; contact the author via <https://github.com/Riloox>.

Using Hostkind also means accepting its [Terms of Use](TERMS.md): you are responsible for what you run with it, and it comes with no warranty. The panel asks each user to accept them on first sign-in.

## Documentation

| Document | Purpose |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [UPGRADING.md](UPGRADING.md) | Upgrading between releases |
| [OPERATIONS.md](OPERATIONS.md) | Running Hostkind in production |
| [WINDOWS-DESKTOP.md](WINDOWS-DESKTOP.md) | Windows desktop app |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide and Developer Certificate of Origin |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party attributions |

Copyright 2026 Federico Prunell Alza
