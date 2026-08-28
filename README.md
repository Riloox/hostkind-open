<div align="center">

# Hostkind

**Run your game servers from one local dashboard.**

Start, stop, monitor, update, and back up your servers without handing your data to a hosted service.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-ff6b35?style=flat-square&logo=github&logoColor=white)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-23140e?style=flat-square&logo=terminal&logoColor=white)](#download-and-run)

</div>

![Hostkind dashboard](resources/hero.webp)

Hostkind is a free, self-hosted app for dedicated game servers and other long-running processes. It runs on your own computer, keeps your files local, and does not require a cloud account.

## What you can do

- Start, stop, restart, and monitor multiple servers
- Use a live console to see output and send commands
- Check players, health, and resource usage where the game supports it
- Browse server files and edit supported settings
- Manage worlds and save files
- Create, restore, download, and schedule backups
- Run scheduled commands and restarts
- Give other people access with local user roles

Some tools are game-specific. Hostkind only shows the tools supported by the active server.

## Supported games

- **Minecraft**: install or register Vanilla, Paper, Spigot, Fabric, Forge, and NeoForge servers. Hostkind can manage the required Java runtime and install compatible Modrinth content.
- **Terraria**: install or register Vanilla, TShock, or tModLoader servers. Manage worlds and backups, with player administration for TShock servers.
- **Valheim**: install the dedicated server through SteamCMD or register an existing server. Manage world saves, updates, and backups.
- **Palworld**: install the dedicated server through SteamCMD or register an existing server. Manage settings, players, map data, updates, mods, and backups.
- **Other Processes**: register another long-running command and configure how Hostkind starts, stops, and checks it.

## Download and run

The current public release is a prebuilt ZIP. It does not include a Windows installer.

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Download `hostkind-<version>.zip` from the [GitHub Releases page](https://github.com/Riloox/hostkind-open/releases).
3. Extract the ZIP to a folder where you want Hostkind to live.
4. Open a terminal in the extracted folder and run:

   ```sh
   npm ci --omit=dev
   npm start
   ```

5. Open [http://localhost:2121](http://localhost:2121) in your browser.

The release already contains the built panel, so you do not need to run a build. Keep the terminal open while Hostkind is running and press `Ctrl+C` when you want to stop it.

On first start, Hostkind creates `config.json` locally and generates a one-time administrator password. The username is `admin`; the password is printed in the terminal and saved in `initial-admin-password.txt` next to `config.json`. Sign in once, then change the password in Settings. The password file is removed after the first successful sign-in.

If port `2121` is already in use, stop the other panel or choose another port in `config.json` before starting Hostkind.

## Updates and data

To update, stop Hostkind, download the next ZIP, and extract it over the current files or into a new folder. Keep your existing `config.json`, `data/`, server folders, and backups. They are not part of the release archive.

Each release includes a ZIP checksum and a `SHA256SUMS` file. The full upgrade guide is in [UPGRADING.md](UPGRADING.md).

Hostkind listens on your local machine by default. Do not expose the panel to a network or the Internet unless you have deliberately configured authentication and secured the connection.

## For contributors

```sh
npm ci
npm run build
npm start
```

The panel is then available at <http://localhost:2121>. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [OPERATIONS.md](OPERATIONS.md) for deployment guidance.

## License

Hostkind is licensed under AGPL-3.0. See [`LICENSE`](LICENSE) for the full license text.
