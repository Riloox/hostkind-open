# Upgrading Hostkind

How to move an existing Hostkind installation from one release to the next.
Releases ship as a single zip (`hostkind-<version>.zip`) with the SPA
**prebuilt** — you never build the panel on the server, but you do need Node
and npm (see [Requirements](#requirements)).

For what changed in a given version, read `CHANGELOG.md` at the repository
root (it also ships inside the zip).

## Requirements

- **Node.js `>=22`** (declared in `package.json` `engines`; the launcher
  scripts enforce it at startup).
  what CI validates against. The current Terraria/TShock toolchain is paired
  with newer Node releases, so if you run Terraria servers, use 22+.
- **npm** (ships with Node). Dependencies are not vendored in the artifact.

## What is in the artifact

```
hostkind-<version>.zip
├── server.js                 the panel (Express + WebSocket)
├── scripts/                  launchers, packaging, and reset tooling
├── lib/                      platform code and game modules
├── i18n.cjs, i18n.json       all user-facing strings
├── public/                   the prebuilt SPA (built by npm run build)
├── resources/                static assets the panel serves
├── config.example.json       template config, never your config
├── package.json              + package-lock.json (for npm ci)
├── LICENSE, THIRD_PARTY_NOTICES.md
├── README.md, CHANGELOG.md
├── SHA256SUMS                sha256 of every shipped file
└── version.json              release metadata (name, version, builtAt)
```

Your `config.json` and `data/` directory are **not** in the artifact and are
**never** overwritten by an upgrade.

## Reset to a fresh Hostkind state

The release includes a guarded reset command for returning Hostkind to its first-run state. Stop the panel and all game servers before running it:

```bash
npm run reset
```

This removes local credentials, configuration, application state, running state, metrics, runtime and installer caches, and supported local build caches. Registered server folders and backups are preserved by default.

To delete registered server folders as well, use:

```bash
npm run reset -- --include-servers
```

Both modes require two exact confirmations. The server mode asks for a separate server-deletion confirmation. Use `--no-start` to leave the panel stopped after the reset.

## 1. Back up your state

Stop the panel first, so the upgrade never races a running process writing to
the database.

- `config.json` — where the panel looks for it: next to `server.js`, unless
  `FLEETDECK_CONFIG` points elsewhere.
- `data/` — the database `fleetdeck.db` (plus its `-wal`/`-shm` files) and the
  `snapshots/` folder. Lives next to the install unless `FLEETDECK_DATA_DIR`
  points elsewhere.

Copy both somewhere outside the install directory. This backup is your
rollback path; keep it until you have booted the new version and confirmed it
looks right.

## 2. Verify the download

Every release publishes its sha256 sums. Check the zip before unpacking it:

```bash
# Linux / macOS
sha256sum -c hostkind-<version>.zip.sha256     # run from the folder holding both

# Windows (PowerShell)
Get-FileHash hostkind-<version>.zip -Algorithm SHA256
```

Compare the output against the `<hash>  hostkind-<version>.zip` line in
`hostkind-<version>.zip.sha256` (or in `SHA256SUMS`). The hash must match.

## 3. Replace the application files

Two layouts, both fine:

- **In place** — unzip over the existing install. Keep your `config.json` and
  `data/` where they are (the zip does not contain them, so nothing is
  overwritten).
- **Fresh directory** — extract the zip into a new folder, then copy your
  `config.json` and `data/` across (or set `FLEETDECK_CONFIG` /
  `FLEETDECK_DATA_DIR` to point at the existing files).

After extracting, verify the tree against the shipped manifest:

```bash
cd hostkind-<version>   # extraction root
sha256sum -c SHA256SUMS  # must report every file as OK
```

## 4. Install dependencies

The artifact is a source release: it ships `package-lock.json` but not
`node_modules`.

```bash
npm ci --omit=dev   # installs exactly the locked production dependencies
```

## 5. Start the new version

```bash
npm start
```

`npm start` runs a preflight check first (`prestart`): if `public/` is
missing — a deployment mistake, never normal after step 3 — it prints
"Run `npm run build` first" and exits non-zero instead of serving a broken
panel.

## What happens on boot: migrations run automatically

Starting the panel calls `bootFoundation()` (`server.js`), which runs
`migrations.runMigrations()` (`lib/foundation.cjs`). The migration runner
(`lib/migrations.cjs`) does, in order:

1. Reads the versions already applied from `schema_migrations` in
   `data/fleetdeck.db`.
2. If anything is pending, **snapshots** the database first: a plain file copy
   to `data/snapshots/fleetdeck-<timestamp>.db`. The newest three snapshots are
   kept.  Legacy `lodestone-*.db` snapshots from earlier versions are still
   recognised for listing, pruning, and restoration.
3. Applies each pending migration in version order, each inside its **own
   transaction**, recording `version`/`name`/`applied_at` in
   `schema_migrations` as it goes.

A healthy boot logs:

```
[Hostkind ...] foundation: ready (db=<path>...\fleetdeck.db, applied=N)
```

where `N` is the number of migrations applied on that boot. You can also check
`GET /api/foundation/status` (admin) which lists the applied migrations.

## If a migration fails

The runner snapshots before it starts, so a failure is recoverable by design:

- The failed migration's transaction rolls back.
- The runner **restores the database from the pre-migration snapshot**,
  wiping any stale WAL/SHM files first (`lib/migrations.cjs`,
  `restoreFromSnapshot`), so the database is left exactly as it was before the
  upgrade — at the prior migration version.
- `bootFoundation` catches the error, logs
  `foundation: migration failed; foundation remains at prior version: <error>`,
  and continues. The panel keeps running with reduced capability; a database
  failure is not allowed to take down process supervision.

What to do:

1. **Keep the log** — the error names the failing migration version and name.
2. Do not keep restarting blindly; a migration that fails deterministically
   will fail the same way every boot.
3. Restore the pre-upgrade backup of `config.json` and `data/` if you want the
   old version running again immediately. Alternatively the snapshot
   `data/snapshots/fleetdeck-*.db` (or the older `lodestone-*.db`) can be
   copied back over `fleetdeck.db`
   (panel stopped) for the same effect.
4. Report the migration error (version, name, message) against the release;
   then retry the upgrade once it is fixed.

## Downgrading

Not supported in general: an older release's migration list may not match the
newer schema, and running it against a newer database is undefined. To go back,
restore your pre-upgrade `config.json` and `data/` and run the old version on
that — not on the migrated database.
