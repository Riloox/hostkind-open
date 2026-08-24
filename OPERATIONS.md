# Operations — keeping the panel up across reboots

This document is about running the panel unattended: what the autostart
service does, how the panel comes back after a machine restart, and how the
servers it supervises survive a panel restart.

## The reboot story

Nothing in the panel starts it. `server.js` is a single Node process launched
from a terminal (`npm start`); when the machine reboots, nothing runs it
again unless something on the OS asks it to. That something is the autostart
service described below.

Once the panel is running again, it does **not** restart your game servers
from scratch — there is nothing to "start" because the previous session never
stopped them. The panel intentionally leaves supervised processes alive on
shutdown (see `shutdown()` in `server.js`), records each child's pid in
`running.json` beside your config, and on boot calls `adoptOrphans()`
(`server.js`, boot path) which re-attaches to every still-running child:

- it reads the pid map written by the previous session,
- checks each recorded process is genuinely alive and is the same process
  that was started (`pidMatches` compares pid and start time, so a recycled
  pid is never adopted),
- and re-wraps it in a `ServerManager`, so status, metrics, watchdog and the
  stop/restart controls work exactly as if the panel had spawned it.

A re-adopted process is a *detached* child: it has no stdin/stdout pipes to
reach, so its console is read-only until you stop or restart it from the
panel. Stop still works (SIGTERM runs the process's own shutdown hook, e.g.
Minecraft still saves the world). That is why the console shows a
"re-attached to … left running by a previous panel session" line after a
restart.

So the correct mental model is: **the panel restarts; the servers it was
watching were never down.** The one thing the reboot can lose is the panel
itself, which is the gap the service closes.

## What the service does

`scripts/install-service.cjs` creates an OS autostart entry that runs
`node server.js` from the install directory on boot/logon:

- **Linux (systemd):** writes `<name>.service` (default `hostkind`) into
  `/etc/systemd/system/`, `daemon-reload`s, and `enable --now`s it. The unit
  pins `WorkingDirectory` to the install dir (so relative paths in config
  resolve), sets `Restart=on-failure`, optionally runs as `User=<user>`
  (`--user`), and forwards `FLEETDECK_CONFIG` when that env var is set.
- **Windows:** creates a Task Scheduler task (`schtasks /Create /SC ONLOGON`)
  that runs `node server.js` from the install dir when the operator logs in,
  so a headless/rebooted box brings the panel back without a console session.

`scripts/uninstall-service.cjs` removes the entry again (`systemctl disable
--now` and delete the unit; `schtasks /Delete`).

```bash
npm run service:install            # autostart, current user, detected install dir
npm run service:install -- --user hostkind     # systemd: run as this user
npm run service:install -- --name games-panel   # different unit/task name
npm run service:uninstall
```

The service runs the same code `npm start` runs (`node server.js`), minus the
prestart build guard — a service must not fail because `public/` is stale; you
build once, the service just keeps it running.

## What the service does not do

- It does not start game servers. The panel adopts whatever is still running
  and leaves anything offline offline.
- It does not wrap the panel in the panel's own watchdog. The panel's
  watchdog (`config.watchdog`, or per-server `watchdog`) restarts a *crashed
  game server* up to `maxRestarts` times within `windowMinutes` — it is for
  game processes, not for the panel. The panel process itself is guarded by
  the service's `Restart=on-failure` (systemd) instead.
- It does not create a container or VM policy. On a host where the whole
  machine is supervised (a VPS provider, systemd in a container, an OOB
  agent), use that layer to restart the panel too; the service is the
  panel-only default.

## Config notes

- Keep `config.json` where `server.js` expects it (defaults to the install
  dir; override with `FLEETDECK_CONFIG`). If you use `FLEETDECK_CONFIG`, the
  installer forwards it into the service, and `running.json` — the pid map
  `adoptOrphans` reads — is written beside that config, so a panel that reads
  a moved config also re-adopts from the same place.
- The watchdog is a panel-level switch you can flip from **Settings → Crash
  watchdog** (admin only), and per server from that server's own settings
  when one is set. Servers without their own watchdog inherit the panel-wide
  value.

## Bug reports (GitHub issues)

The panel stores every in-app bug report locally first, then (when enabled)
creates one GitHub issue per report. Reports are durable before any network
call, so a GitHub outage never loses user feedback — the row stays `pending`
and a once-a-minute scheduler retries it with backoff.

### Enabling the integration

1. Create a fine-grained PAT with **Issues: read and write** on the
   destination repository.
2. Export it for the panel process:

   ```sh
   export FLEETDECK_GITHUB_TOKEN=github_pat_...
   ```

   On a systemd service, add `Environment=FLEETDECK_GITHUB_TOKEN=...` to the
   unit (or use an `EnvironmentFile` with mode 0600) and restart the service.
   The token is read from the environment on every sync and on every config
   change, so rotating it is just an environment change + service restart —
   no config edit, and it never lands in `config.json` (which is commonly
   backed up) nor in any API response.
3. Enable the feature from the admin settings, or:

   ```sh
   curl -X PUT http://localhost:2121/api/config/bug-reports \
     -H "Authorization: Bearer <admin-token>" -H "Content-Type: application/json" \
     -d '{"enabled":true,"owner":"Riloox","repo":"hostkind-open","labels":["bug"]}'
   ```

   Only `enabled`, `owner`, `repo`, and `labels` are accepted; a `token` field
   in the request is ignored. The response config never contains a token.

### Operational notes

- **One-way sync.** Issue creation only — comments/status are not mirrored
  back. Retries are idempotent via a stored marker (searched before
  re-creating), so ambiguous network failures cannot duplicate issues.
- **Auth failures are budget-exhausting.** A 401/403 (bad or expired token,
  wrong repo) marks the report failed and stops retrying it, so a broken
  credential is not hammered. Transient failures (429/5xx/network) retry with
  exponential backoff up to 5 attempts over 30 days.
- **Privacy.** Issue bodies are public content: reporter username, panel
  version, user agent, screen (`game`/`view`/`route`), and timestamp are
  included by design; passwords, tokens, server paths, logs, and email are
  not. Audit events record report id + outcome + issue number/url only.
- **Per-user throttling.** Each user may submit up to 5 reports per minute
  (`429 rate_limited` beyond that); the throttle is in-memory and resets on
  panel restart.
- **Diagnostics.** `bug_report.created` and `bug_report.sync` audit events
  carry the report id, sync state, and GitHub issue number/url. Pending/failed
  rows live in `data/fleetdeck.db` (`bug_reports` table) with the last
  redacted error.
