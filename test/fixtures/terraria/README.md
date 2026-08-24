# Terraria console fixtures

Real console output from real servers. Every pattern in
`lib/modules/terraria/console.cjs` names the fixture it was read off, and
`test/terraria-lifecycle.test.cjs` fails if a pattern matches nothing in the
fixture it claims. A pattern without a fixture does not ship
(docs/terraria/02-lifecycle-console.md).

Each `.log` starts with a one-line `#` header recording variant, version, host
OS, capture date, and source.

## What was captured

| Fixture | What it is |
| --- | --- |
| `vanilla-start.log` | cold start to `Server started`, then `playing` / `version` / `time` / `port` / `maxplayers` / `save` |
| `vanilla-stop.log` | `exit` to process exit |
| `vanilla-players.log` | two joins, a `playing` roster, two leaves, `exit` |
| `vanilla-worldgen.log` | world creation driven through the console menu |
| `tshock-start.log` | TShock's banner, the base server's start, its `playing` reply |
| `tshock-stop.log` | `exit` to process exit |
| `tshock-players.log` | two joins, two `playing` rosters, a leave, `exit` |
| `tmodloader-start.log` | mod loading, world selection, start, `playing`, `save` |
| `tmodloader-stop.log` | `exit` to process exit |
| `tmodloader-modload.log` | the mod-loading phase on its own |
| `tmodloader-worldgen.log` | world creation driven through the console menu |
| `interactive-menu.log` | a server started with no world configured, blocked on the prompt |
| `port-in-use.log` | the port already bound: the server prints `Listening on port`, then exits |
| `missing-world.log` | `world=` pointing at a file that is not there |

`port-in-use.log` is the negative fixture that pins readiness: the server prints
its listening line and leaves without ever printing `Server started`.

The join and leave lines have no tModLoader capture. A tModLoader server refuses
unmodded clients, so producing one needs a modded Terraria client Hostkind does
not have. The lines are vanilla's, and tModLoader ships the same strings -
`Game.19` / `Game.20` ("{0} has joined." / "{0} has left.") are in the
localization embedded in `tModLoader.dll` - which is what the tModLoader entry
on those rules rests on.

## Sanitization

Captures were passed through `lib/redact.cjs` plus two capture-specific rules:

- **Addresses.** Client addresses become `[REDACTED_IP]`. A four-part *version*
  number (`TShock 6.1.0.0`) is not an address and is left intact - the version
  patterns are read from those lines.
- **TShock setup code.** `/setup <code>` is a one-time admin credential and is
  masked to `[REDACTED_TOKEN]`.
- **Paths.** The capture directory is rewritten to `<fixture-root>`; no path
  outside it appears.

Player names are synthetic (`Hostkind Guest`, `Zoë Müller` - chosen because a
name with a space and a name with non-ASCII characters both have to round-trip).

Two shapes are not verbatim, and both are marked in the file:

- runs of identical progress ticks are cut to three followed by
  `# ... N more identical progress ticks elided ...`;
- the harness's own notes (`> command`, `# process exited: ...`) record what was
  typed at the console and how the process ended.
