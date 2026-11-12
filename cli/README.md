# Hostkind CLI

`hostkind` is a command-line client for the same authenticated API the panel
uses. It can manage servers, stream the console, edit files, run backups,
install content, and operate every game module without opening a browser. It
is also designed for agents: JSON output, deterministic exit codes, no
interactive prompts when stdin is not a TTY, and a generic `api` escape hatch.

The CLI is a client, not a second implementation. Authorization, preview
tokens, idempotency, audit logging, and module capability checks stay on the
panel, so a command can never do more than the signed-in principal is allowed
to do.

## Run it

From a source checkout:

```sh
npm run cli -- --help
# or directly
node bin/hostkind.cjs --help
```

The package also exposes a `hostkind` bin, so a global or linked install works:

```sh
npm link
hostkind --help
```

The panel must be running. If you have not started it yet:

```sh
hostkind serve                 # runs server.js in this terminal
hostkind serve --port 2122
```

## Sign in

```sh
hostkind login
hostkind login --url http://127.0.0.1:2121 --username admin
hostkind login --url https://panel.example.com --api-key "$HOSTKIND_API_KEY"
```

At a terminal, `login` asks for a username (default `admin`) and a password
with hidden input. For `admin` on a local panel it first tries
`initial-admin-password.txt` from the panel folder. In a non-interactive shell,
pass `--username` and one of `--password`, `--password-stdin`, or
`HOSTKIND_PASSWORD`.

Login writes a profile to:

* Linux: `~/.config/hostkind/cli.json`
* macOS: `~/Library/Application Support/hostkind/cli.json`
* Windows: `%APPDATA%\Hostkind\cli.json`

`HOSTKIND_CLI_CONFIG` overrides the path. The file is written with mode `0600`.

```sh
hostkind logout                 # clear credentials, keep the URL
hostkind logout --all           # remove every profile
hostkind profile list
hostkind profile use staging
hostkind profile set staging --url https://stage.example.com --api-key "$KEY"
hostkind profile remove staging
```

Credential precedence: flags → environment → selected profile → local panel
configuration. The environment variables are `HOSTKIND_URL`,
`HOSTKIND_TOKEN`, `HOSTKIND_API_KEY`, `HOSTKIND_SERVER`, and
`HOSTKIND_PROFILE`.

## Choose a server

Commands that act on one game server use `--server`. It accepts an id or a
unique server name:

```sh
hostkind servers list
hostkind backups list --server survival
hostkind console run say hello --server survival
```

`HOSTKIND_SERVER` sets a default. Without either, the panel's active server is
used. The CLI resolves names through `GET /api/servers`; an ambiguous name is
an error rather than a guess.

## Output and exit codes

When stdout is a terminal, lists print as tables (sized to the window, with
ids never truncated), and commands like `login` or `files download` print a
sentence. Everything else, and everything when stdout is piped or redirected,
is the panel's JSON, pretty-printed, with paths, ids, and status fields
preserved exactly. Prompts, progress, and hints always go to stderr.

```sh
hostkind servers list                  # table at a terminal, JSON in a pipe
hostkind servers list --json           # always JSON
hostkind servers list --table          # always a table
hostkind servers list --quiet          # ids only
hostkind servers list --format raw
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request, panel, or operation failure |
| `2` | Usage error |
| `3` | Authentication or authorization failure |
| `4` | Confirmation required (re-run with `--yes`) |
| `5` | Timeout |

API errors keep their server `code`, `status`, and details. Use `--json` to get
a machine-readable error object on stderr, including a `hint` when the CLI has
one. Mistyped commands exit `2` and suggest the closest match:

```text
$ hostkind servers lst
error: Unknown command: servers lst
hint: Did you mean `hostkind servers list`?
```

## Safety: destructive actions and previews

Actions that delete, restore, apply, install, roll back, or otherwise change
data are marked `[confirm]` in help. At a terminal the CLI asks once; for
commands with a preview step it prints the preview first, so you see what will
change before answering. When stdin is not a TTY it refuses with exit code `4`
unless you pass `--yes`:

```sh
hostkind worlds delete world --yes
```

Flows that require a server preview token support three forms:

```sh
# Inspect the impact and print the preview (including its token)
hostkind worlds delete world --preview

# Apply a token you already obtained
hostkind worlds delete world --preview-token "$TOKEN" --yes

# Let the CLI preview and then apply, in one command
hostkind worlds delete world --yes
```

`--yes` always runs the preview first when the command has one. The CLI then
uses the returned token, regenerates the idempotency key, and performs the
action. The preview is never skipped silently.

Every mutating request carries an `Idempotency-Key`. Override it with
`--idempotency-key` when you need retry semantics across processes.

### Long-running operations

Mutating commands that start a durable operation return an `operationId`. Add
`--wait` to follow it, or use the `wait` command later:

```sh
hostkind worlds pregenerate world --yes --wait
hostkind wait "$OPERATION_ID"
```

`--wait-timeout <seconds>` bounds the wait (default: no bound). Progress is
written to stderr so stdout stays parsable. At a terminal, a command that
starts an operation without `--wait` prints the matching `hostkind wait`
command.

## Console and live data

```sh
hostkind console run list --server survival
hostkind console run say Restarting in 5 minutes                 # words are joined
hostkind console tail --server survival
hostkind console tail --server survival --lines 100        # keep only the last 100 history lines
hostkind console history --server survival --lines 100     # history only, then exit
hostkind console tail --until "Done" --timeout 60          # stop at the first line containing "Done"
hostkind console tail --json
hostkind console watch                                     # status, stats, notifications
hostkind console watch --stats --once
```

`console run` uses `POST /api/command`. `console tail`, `console history`, and
`console watch` use the panel's `/ws` stream, so they see history, live lines,
status, resource statistics, and notifications exactly as the panel does.

## Command groups

`hostkind commands` prints the full catalog. `hostkind commands <group>` filters
it, and `hostkind commands --json` is a machine-readable manifest.

| Group | What it covers |
| --- | --- |
| `auth` | Sign-in state, current user, modules, foundation diagnostics |
| `panel` | Panel configuration, folder browser, host snapshot, metrics |
| `servers` | Register, edit, remove, select, start/stop/restart, create, clone |
| `console` | Console commands, history, live tail, status/stats watch |
| `players` | Minecraft player actions, whitelist, ops, bans, player lists |
| `worlds` | List, import, clone, archive, download, delete, pregenerate |
| `backups` | List, create, inspect, verify, impact, restore, download |
| `trash` | List, restore, or purge recoverable deletions |
| `files` | Browse, read, write, mkdir, rename, delete, upload, download |
| `configs` | Read/write editable config files and restore snapshots |
| `addons` | List, upload, enable/disable, delete plugins and mods |
| `tasks` | Scheduled commands and restarts |
| `templates` | Server template list, create, export, import, instantiate, recover |
| `minecraft` | Modrinth/CurseForge content, modpacks, map plugins, adoption |
| `palworld` | REST status, settings, players, map, updates, mods, profiles |
| `terraria` | Players, config, worlds, tModLoader mods/modpacks, TShock |
| `valheim` | Updates, worlds, imports, renames, downloads |
| `updates` | Managed content update scans, plans, apply, rollback |
| `application-update` | Hostkind release check, download, install |
| `audit` | Audit log, export, retention |
| `crashes` | Crash groups and acknowledgements |
| `health` | Findings, samples, thresholds |
| `operations` | Durable operation list, read, cancel, resume, rollback |
| `notifications` | Read, mark read, clear |
| `users`, `apikeys`, `me` | Accounts, grants, API keys, profile |
| `product`, `bug-reports` | BYOC/pairing/manifests, reports |

Every command has its own help:

```sh
hostkind backups restore --help
hostkind terraria worlds --help
```

### Examples

```sh
# Servers
hostkind servers list
hostkind servers create --type paper --name Community --version 1.21.4 --accept-eula --yes
hostkind servers start "$SERVER_ID"
hostkind servers stop "$SERVER_ID" --force

# Backups
hostkind backups create --server survival
hostkind backups verify 2026-11-12_03-00-00_survival.zip --server survival
hostkind backups restore 2026-11-12_03-00-00_survival.zip --server survival --yes --wait

# Files and config
hostkind files list --path plugins --server survival
hostkind files read server.properties --server survival
hostkind files write server.properties --content-file ./server.properties --server survival
hostkind files write server.properties --stdin --server survival < server.properties
hostkind configs history server.properties --server survival

# Worlds
hostkind worlds list --server survival
hostkind worlds import --file ./world.zip --server survival --yes --wait
hostkind worlds clone world --server survival --yes --wait
hostkind worlds download world --server survival --output ./

# Minecraft content
hostkind minecraft search --q sodium --kind mod --server survival
hostkind minecraft install --data '{"versionId":"..."}' --server survival --yes
hostkind minecraft import-preview --versionId "$VERSION" --server survival

# Players
hostkind players online --server survival
hostkind players kick Steve --server survival
hostkind players whitelist-add Steve --server survival

# Tasks
hostkind tasks list --server survival
hostkind tasks create --server-id "$SERVER_ID" --data '{"action":"restart","trigger":{"type":"cron","cron":"0 4 * * *"}}'
hostkind tasks run "$TASK_ID"

# Palworld
hostkind palworld status --server palworld
hostkind palworld players --server palworld
hostkind palworld announce "Server restart in 5 minutes" --server palworld
hostkind palworld updates preview --server palworld
hostkind palworld updates apply --server palworld --yes --wait
hostkind palworld mods catalog --q "..." --server palworld

# Terraria
hostkind terraria config --server terraria
hostkind terraria worlds --server terraria
hostkind terraria mods --server terraria
hostkind terraria tshock status --server terraria

# Valheim
hostkind valheim worlds --server valheim
hostkind valheim updates preview --server valheim
```

## Arbitrary endpoints: `hostkind api`

Every panel endpoint is reachable even when a named command does not exist yet.
`api` sends the method and path you give it, with the same auth, server header,
idempotency, timeout, and download handling.

```sh
hostkind api GET /api/servers
hostkind api GET /api/files --query path=server.properties --server survival
hostkind api POST /api/command --data '{"cmd":"list"}' --server survival
hostkind api POST /api/backups --data '{"offline":true}' --server survival
hostkind api GET /api/backups/file.zip/download --output ./
hostkind api POST /api/modrinth/install --data-file payload.json
```

For uploads, `--file` sends multipart with field `file`; use a named command
when the endpoint expects a different field name.

## Payloads and flags

Named commands expose the common fields as flags. Kebab-case flags become
camelCase JSON:

```sh
hostkind backups create --include-mods --offline
# body: {"includeMods":true,"offline":true}
```

Use `--data '<json>'` or `--data-file <path>` for nested payloads, conflict
decisions, policies, and anything a one-line flag cannot express. `--data`
always wins over generated fields.

`--server` is the request target (the `X-Hostkind-Server-Id` header). A few
endpoints take a server id in their body instead, such as templates, tasks, and
content update plans; pass `--server-id <id>` for those.

```sh
hostkind minecraft update --versionId "$VERSION" --data '{"decisions":{"mods/example.jar":"keep_local"}}'
```

Query parameters:

```sh
hostkind audit list --query from=2026-11-01 --query outcome=denied
hostkind files list --query path=plugins
```

Headers:

```sh
hostkind api GET /api/servers --header "X-Custom: value"
```

## Downloads and uploads

Download commands write to a file and print its path, or stream to stdout with
`--output -`:

```sh
hostkind backups download backup.zip --output ./backups/
hostkind worlds download world --output -
```

Uploads use `--file`, repeatable where the endpoint accepts several files:

```sh
hostkind files upload --file plugin.jar --path plugins --server survival
hostkind worlds import --file world.zip --server survival --yes
hostkind palworld mods preview --file package.zip --server palworld
```

## Streaming creation

`servers create` streams NDJSON from the panel. With `--json` every event is a
JSON line on stdout. Without it, progress goes to stderr and the created server
is printed at the end.

```sh
hostkind servers create --type paper --name Community --version 1.21.4 --accept-eula --yes
```

## Shell completion

```sh
hostkind completion bash >> ~/.bashrc
echo 'source <(hostkind completion zsh)' >> ~/.zshrc
hostkind completion fish > ~/.config/fish/completions/hostkind.fish
```

## Agent recipes

```sh
# Never prompt, always follow mutations, keep stdout JSON
hostkind servers list --json
hostkind backups restore "$BACKUP" --server survival --yes --wait --json

# Inspect an impact without side effects
hostkind worlds delete "$WORLD" --server survival --preview --json

# Resolve an id once, use it everywhere
SERVER_ID="$(hostkind servers list --quiet | head -1)"
hostkind backups list --server "$SERVER_ID" --json
```

The CLI sends no interactive prompts when stdin is not a TTY, which makes it
safe to run from an agent or a CI job. A missing confirmation is reported as
exit code `4`, not as a hang.
