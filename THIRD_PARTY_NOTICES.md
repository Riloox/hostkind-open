# THIRD_PARTY_NOTICES

Hostkind is published under the AGPL-3.0 (`SPDX-License-Identifier: AGPL-3.0-only`);
the full text is in `LICENSE`. This file records every bundled asset that is not
plain Hostkind original work, the provenance we could establish for it, and what
was done about it. Reviewed as of August 2026.

Statuses used below:

| Status | Meaning |
| --- | --- |
| **Original** | Created for Hostkind, owned by Hostkind. Safe to ship. |
| **Generated placeholder** | A neutral, procedurally generated asset produced for this pass to replace third-party art. Owned by Hostkind. Safe to ship. |
| **Third-party (official)** | Recognisable official artwork/trademarks of another party. Not licensed for redistribution here; ship only after replacement or a written licence. |
| **Third-party (unverified)** | Not identifiable as Hostkind origin, and no licence or source can be established. Treat as not licensed; replace or verify. |
| **Not shipped** | Not part of the distributed tree (gitignored runtime cache). |

Nothing in this file grants a licence. Where a status is not **Original** or
**Generated placeholder**, the asset must be replaced or cleared before any
commercial redistribution.

---

## 1. Panel artwork under `resources/`

| File | Purpose | Provenance | Status | Disposition |
| --- | --- | --- | --- | --- |
| `resources/favicon.svg` | Browser favicon (`index.html`), default branding icon. | Hand-written geometric SVG in the Hostkind ember palette (`#fdb25b` -> `#c14624` on `#23140e`); in repo since the initial commit. | **Original** | Keep. |
| `resources/hostkind.svg` | Default logo/favicon mark served by the panel and used by the SPA. | Identical geometry to `favicon.svg`; a Hostkind-authored mark. | **Original** | Keep. |
| `resources/maps/palworld-world.png` | Built-in Palworld world-map fallback streamed by `lib/palworld-map.cjs` (`/api/palworld/map/asset`). | The original shipped file was the official in-game Palworld world map (Pocketpair game art); no licence, no source recorded in git (introduced in the initial commit, `git log` shows binary blobs only). It was first replaced with a procedurally generated placeholder, then (Aug 2026) with the current 1128x1128 map. | **Generated placeholder** | **Replaced.** Current file is an AI-generated original world-map image (maintainer-authored via Gemini, star watermark removed, padded to square), no game-derived art. `lib/palworld-map.cjs` asset version bumped to `fleetdeck-palpagos-2`; the media type, bounds, and test contract (`test/palworld-map.test.cjs` passes) still hold. The original Pocketpair art remains in git history only. |
| `resources/hero.webp` | README hero banner. | Original file was a Hostkind dashboard mockup that embedded Minecraft (Mojang) and Palworld (Pocketpair) game icons; unlicensed third-party art inside an otherwise Hostkind-made graphic. Introduced with the README revamp commit. | **Generated placeholder** | **Replaced.** A branded banner (ember palette, Hostkind mark, abstract server cards, no game art) was generated and written over the same path; the README still references it and is unchanged apart from the alt text. |
| `resources/stone_tile.jpg` | Panel background texture in the Settings dialog (`src/components/shared/SettingsDialog.jsx`, served from `/resources/stone_tile.jpg`). | Original file was the Minecraft "stone" block texture (Mojang). In repo since the initial commit, no licence. | **Generated placeholder** | **Replaced.** A neutral, tileable stone/concrete texture was generated and written over the same path. No frontend change was needed because the path is unchanged. |
| `resources/lodestone.webp` | Unreferenced. "Lodestone" is the project's legacy codename ; the file was a render of the Minecraft "chiseled stone bricks" block (Mojang). | No code or docs reference it today; git history shows it in the initial commit. | **Generated placeholder** | **Replaced** with a neutral dark tile bearing the Hostkind mark. The file is still unreferenced and is a candidate for outright removal from the repo. |


## 2. Game-module artwork under `src/assets/games/`

These ship inside the built SPA (the game picker in `src/lib/games.js`). They were
not touched in this pass (frontend sources are owned by a parallel effort); they are
recorded here because they are a copyright/trademark exposure for a commercial
licensee and must be cleared by replacing them with licensed or original art.

| File | Used by | Provenance | Status |
| --- | --- | --- | --- |
| `src/assets/games/minecraft-logo.png` | Minecraft slide, `src/lib/games.js`. | Official Minecraft logotype (Mojang/Microsoft). | **Third-party (official)** - needs replacement or licence. |
| `src/assets/games/minecraft-hero-v2.png` | Minecraft slide artwork. | Fan-made 3D render in the Minecraft voxel aesthetic; author unknown, no licence recorded. | **Third-party (unverified)** - needs replacement. |
| `src/assets/games/minecraft-hero.png` | **Unused** (not imported by `src/lib/games.js`). | Official Minecraft promotional banner (Mojang). | **Third-party (official)** - delete or replace. |
| `src/assets/games/terraria-logo.png` | Terraria slide. | Official Terraria logo (Re-Logic). | **Third-party (official)** - needs replacement or licence. |
| `src/assets/games/terraria-hero.jpg` | Terraria slide artwork. | Official Terraria promotional artwork (Re-Logic). | **Third-party (official)** - needs replacement or licence. |
| `src/assets/games/valheim-logo.png` | Valheim slide. | **Not** the official Valheim logo; a fan/mod variant ("The Bog Witch" subtitle), author unknown. | **Third-party (unverified)** - needs replacement. |
| `src/assets/games/valheim-hero.jpg` | Valheim slide artwork. | Official Valheim in-game screenshot/artwork (Iron Gate Studio). | **Third-party (official)** - needs replacement or licence. |
| `src/assets/games/palworld-logo.png` | Palworld slide. | Official Palworld logotype (Pocketpair). | **Third-party (official)** - needs replacement or licence. |
| `src/assets/games/palworld-hero.jpg` | Palworld slide artwork. | Appears to be fan/promo art in the "Pokemon with guns" meme style, not official Palworld art; author unknown. | **Third-party (unverified)** - needs replacement. |
| `src/assets/games/custom-hero.jpg` | "Other Processes" slide. | AI-generated black-and-white collage embedding Nintendo/Mario/Pac-Man/Space Invaders and other third-party game references; author unknown. | **Third-party (unverified)** - needs replacement. |

**Action required:** every row above must reach **Original** or **Generated
placeholder** (or a written licence from the rights holder) before Hostkind ships
commercially. See `CONTRIBUTING.md` -> "Asset provenance" for the rule that prevents
new unlicensed art.

## 3. Fonts under `src/assets/fonts/`

| File(s) | Provenance | Status |
| --- | --- | --- |
| `saira-400/600/700.ttf`, `saira-condensed-700/800.ttf`, `saira-italic-400.ttf`, `saira-stencil-one-400.ttf` | Saira family, the Saira Project (Omnibus-Type); SIL Open Font License 1.1. | **Third-party (inferred OFL)** - the shipped binaries do not embed the licence text, so the OFL copyright/licence notices must be added to the distribution (recommended: ship an `OFL.txt` alongside). |
| `ibm-plex-mono-400/600.ttf` | IBM Plex Mono (IBM); SIL Open Font License 1.1. | Same as above. |
| `press-start-2p-400.ttf` | Press Start 2P (CodeMan38); SIL Open Font License 1.1. | Same as above. |

The SIL OFL permits bundling and modification, but requires the licence text and
copyright notice to accompany the fonts. Add the notices (and any modified-font
attribution) before commercial distribution.

## 4. Runtime downloads and caches (not shipped)

| Path | Status |
| --- | --- |
| `resources/installers/steamcmd/**` | SteamCMD binaries (Valve) and their cache. **Not committed**: confirmed gitignored (`git check-ignore` matches; `resources/installers/` is in `.gitignore`). `ensureSteamCmd()` re-downloads SteamCMD when the folder is missing. Valve's SteamCMD distribution terms apply to whoever downloads and runs it; Hostkind only orchestrates the download at runtime. |
| `runtimes/` | Downloaded Temurin JREs (per Minecraft Java major). Gitignored runtime cache, not distributed. |
| `data/`, `config.json`, `public/` | Local runtime data and build output. Not committed. |

---

## Rebuilding the generated placeholders

The placeholders were produced by throwaway scripts (kept out of the repo, under the
user's temp directory) that use only the Node standard library (`zlib`) and, for the
JPEG/WebP files, a stock Python `Pillow`. They are not build inputs and are not needed
to build or run Hostkind. Re-running them is not required for any workflow.
