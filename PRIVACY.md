# Hostkind Privacy Policy

Last updated: 2026-10-20

This policy explains what information Hostkind handles, where it goes, and who is responsible for it. It complements section 7 ("Your data") of the [Terms of Use](TERMS.md). Keep it in step with the code: if a feature starts sending something new off the machine, this file changes in the same commit.

## 1. Who is responsible

Hostkind is self-hosted software. Whoever installs and runs a Hostkind panel (the "operator") decides who can use it and is responsible for the information stored in it. The Authors (Federico Prunell Alza and the project's contributors) do not host, operate, or have access to any installation.

The Authors are responsible for one thing only: the optional bug-report relay described in section 4, which they operate at `bugs.hostkind.site`.

## 2. What stays on your machine

Hostkind stores its data on the machine it runs on. None of the following is sent to the Authors:

- **Panel accounts:** usernames, password hashes, roles, permissions, and API keys.
- **Activity records:** the audit log (who did what and when), console history, notifications, and local product events used to show health and status inside the panel.
- **Your servers:** server folders, configuration files, worlds, backups, mods, and player lists reported by the game servers.

Hostkind does not send usage telemetry or analytics to the Authors.

## 3. Third-party services Hostkind contacts

Some features contact third-party services directly from your machine or from the browser you use to open the panel. Those services see the request, including your IP address, and handle it under their own privacy policies. Hostkind contacts them only when you use the feature that needs them:

| Feature | Services |
| --- | --- |
| Checking for and downloading Hostkind updates | GitHub |
| Installing and updating game servers and runtimes | Valve (SteamCMD, Steam Web API), PaperMC, Fabric, Forge, NeoForge, GetBukkit, Re-Logic (terraria.org), Eclipse Adoptium, GitHub (TShock and tModLoader releases) |
| Browsing and installing mods and modpacks | Modrinth (including its image CDN), Steam Workshop |
| Minecraft players page | Mojang (`api.mojang.com`) to look up player names you add; Minotar (`minotar.net`) for player-head images, which receives the names being shown |
| Bug reports, when enabled | The Hostkind relay (section 4) and GitHub |

## 4. Bug reports

Bug reporting is off unless the operator turns it on, and nothing is sent until a user writes a report and presses submit.

**What is sent:** the title, description, reproduction steps, and expected behavior the user typed; the game, panel view, and route the report was filed from; the browser's user-agent string; the Hostkind version; and a random key used to avoid duplicate reports. Common secret patterns (tokens, passwords, keys) are removed before the report is stored.

**Where it goes:** the report is sent to the relay at `bugs.hostkind.site`, which the Authors run behind Cloudflare. The relay **publishes it as a public issue** in the [Riloox/hostkind-open](https://github.com/Riloox/hostkind-open) GitHub repository. Do not include personal or secret information in a report.

**What the relay keeps:** a copy of each report in its queue database, so it can retry publishing if GitHub is unavailable. The copy is deleted automatically 30 days after the report is published, or 30 days after the relay gives up publishing it. The relay uses the sender's IP address in memory for rate limiting and does not write it to disk or to its request log. That log records only method, route, status, and duration.

**Your choices:** to have a published report removed, open an issue or contact the maintainer through the GitHub repository and say which report it is. The public issue is not removed automatically; only the relay's queue copy is, on the schedule above.

## 5. Cookies and browser storage

Hostkind does not use advertising or analytics cookies and loads no third-party tracking scripts. The panel stores only what it needs to work in your browser:

| Name | Type | Purpose | Lifetime |
| --- | --- | --- | --- |
| `fleetdeck_token` | Local storage | Keeps you signed in. Removed when you sign out. | Until sign-out |
| Changelog version | Cookie and local storage | Remembers which "What's new" entry you already saw. | 1 year |
| Language, sidebar mode, last opened server, config editor mode, console command history | Local storage | Remembers your preferences in this browser. | Until cleared |
| Dismissed update notice | Session storage | Hides an update notice you dismissed. | Until the tab closes |

All of these serve features you asked for, never tracking. Under the EU/UK ePrivacy rules and similar laws, that kind of storage is "strictly necessary" and needs no consent banner. If you add anything that tracks or profiles users, you need consent first and this section must be updated.

You can clear all of it at any time through your browser's site-data settings. You will then be signed out and your preferences will reset.

## 6. Operators' obligations

If you run Hostkind for other people, for example the players or admins of a community server, you are the one collecting their information, and the privacy laws that apply to you may require you to tell them what you store and why. You can point them to this file for how the software itself behaves.

## 7. Children

Hostkind is an administration tool and is not directed at children. Operators who give panel accounts to minors are responsible for any consent that the law requires.

## 8. Changes

If this policy changes in substance, the change is recorded in the [CHANGELOG](CHANGELOG.md) and in this file's history.

## 9. Contact

Questions about this policy or about a bug report you sent can be raised on the project's GitHub page: https://github.com/Riloox/hostkind-open.
