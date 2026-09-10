# Linux distribution

Since 0.1.2.3, the GitHub Release for each tag ships Linux installers built
from the same Electron desktop app as the Windows installer. You do not need
Node.js, npm, or a terminal to install Hostkind.

## Which file to download

From the [GitHub Releases page](https://github.com/Riloox/hostkind-open/releases),
pick one of:

- `hostkind_<version>_amd64.deb` — for Ubuntu, Debian, and derivatives.
  Double-click it (or open it with the Software Center) and install. This is
  the recommended path: it adds a Hostkind launcher to your applications menu.
- `Hostkind-<version>.AppImage` — portable fallback for other distributions.
  Make it executable once, then double-click it:

  ```sh
  chmod +x Hostkind-<version>.AppImage
  ./Hostkind-<version>.AppImage
  ```

Both files contain the full application (backend + panel), so there is
nothing else to download or build.

## First run

Launch Hostkind from your applications menu (`.deb`) or by running the
AppImage. The panel opens in its own window; there is nothing to configure
before the first launch.

On first start, Hostkind creates its configuration and data in per-user
locations outside the install directory:

- settings and database: your Electron user-data directory
  (typically `~/.config/Hostkind/`),
- downloaded installers and runtimes: `~/.cache/Hostkind/`,
- servers and backups: `~/Documents/Hostkind/`.

Reinstalling or upgrading never touches these directories, so your servers,
worlds, and backups survive.

## Verifying the download

Each installer ships with a `.sha256` sidecar. To check the AppImage:

```sh
sha256sum -c Hostkind-<version>.AppImage.sha256
```

The `.deb` can be verified the same way against its own sidecar.

## Uninstalling

- `.deb`: remove it with your package manager
  (`sudo apt remove hostkind`); your data directories above are kept.
- AppImage: delete the `.AppImage` file; your data directories above are kept.

## Advanced: headless ZIP install

Operators who prefer a server-style install can still use
`hostkind-<version>.zip` with Node.js 22+: extract it, run
`npm ci --omit=dev`, then `npm start`. See [UPGRADING.md](UPGRADING.md) and
[OPERATIONS.md](OPERATIONS.md) for that path.
