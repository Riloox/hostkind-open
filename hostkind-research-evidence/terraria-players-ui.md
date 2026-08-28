# Terraria Players surface research

Status: verified implementation contract

## Findings

- The vanilla Terraria dedicated server documents `playing` as the console command that shows the current player list.[1]
- The same command reference documents `kick <player name>` and `ban <player name>` as vanilla server-console commands.[1]
- Vanilla Terraria has no documented operator, whitelist, or permissions model in this command surface. Its documented moderation surface is therefore not interchangeable with Minecraft's `op`, whitelist, or pardon flows.[1]
- TShock is a different server package with its own command/API layer and additional server-side administration features.[1][3]
- TShock's REST documentation exposes separate player endpoints, including `/v2/players/list`, `/v2/players/read`, `/v2/players/kick`, and `/v2/players/ban`. Its documented status/player fields include values such as nickname, username, IP, group, active, state, and team, but no character image or sprite field.[2]
- The TShock project describes server-side characters as a server feature, but that does not establish a browser-ready character-image endpoint or a renderer for the panel.[3]

## Character-image verdict

Leave the Terraria character slot blank for now. The authoritative vanilla server documentation exposes a player roster and moderation commands, not character appearance data.[1] The TShock REST documentation exposes player/account metadata and moderation endpoints, not a sprite/image representation.[2] A local `.plr` file or a server-side character object would not by itself be a reliable, current visual representation of the character inside a live server. No supported image contract was found during this research.[1][2][3]

The UI should therefore render an explicit empty character slot and must not fall back to a Minecraft skin service such as Minotar or Mojang.[1][2]

## Repository-local implementation contract

```text
Vanilla and tModLoader console surface
- Select TerrariaPlayersView for Terraria servers that are not TShock.
- Consume status.players, status.playerCount, and status.maxPlayers.
- Poll playing, track join/leave lines, and reconcile complete playing replies.
- GET /api/terraria/players returns names, source=console, and no character image.
- POST /api/terraria/players/:action accepts { target } and only supports kick/ban.
- Reject unsupported actions and validate player names before constructing commands.

TShock surface
- Keep TShock on its existing dedicated TerrariaTshockView and REST routes.
- Do not route TShock through the vanilla console roster or action endpoint.

UI behavior
- Show Terraria-specific title, roster, status, and empty state.
- Show only Kick and Ban in the player detail dialog.
- Show an explicit blank character slot; never use a Minecraft avatar URL.
- Keep backend capability checks authoritative.

Files under review
- src/views/TerrariaPlayersView.jsx
- src/views/PlayersView.jsx
- lib/modules/terraria/manager.cjs
- lib/modules/terraria/routes.cjs
- server.js
- test/terraria-players.test.cjs
- e2e/specs/terraria-players.spec.cjs
```

## Verification record

```text
Focused Terraria player contract, full backend suite, production build, full lint, and dedicated browser regression pass.
The browser regression caught and fixed a transient legacy playerlists request while the active Terraria server descriptor was loading.
```

## Sources

[1] https://terraria.wiki.gg/wiki/Server — Official Terraria Wiki: Server
[2] https://tshock.readme.io/v5.0/reference/rest-api-endpoints — TShock REST API endpoints
[3] https://github.com/Pryaxis/TShock — Pryaxis/TShock repository
