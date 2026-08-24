# Design — Hostkind

A locked design system for Hostkind. Every view uses this system; extend it here before introducing local visual exceptions.

## Genre

Atmospheric brutalist. The atmosphere comes from deep, warm-black surfaces and restrained game artwork. The brutalism comes from hard geometry, decisive typography, exposed structure, and controls that look operable rather than ornamental.

## Macrostructure family

- Marketing pages: Marquee Hero, if a marketing surface is added later.
- App pages: Workbench. Views are stations on one operations desk; each has a dominant working surface with secondary data around it.
- Content pages: Long Document for audit trails, release notes, and reference-heavy screens.

## Theme

Ember. The palette is a heat scale, not a set of swatches: a coal bed read from
dead ash up to white-hot, with the whole neutral field sitting on the same warm
hue so the desk looks lit rather than grey.

Ramp (`--ember-1` … `--ember-7`):

- `--ember-1`: `oklch(30% 0.055 32)` — ash
- `--ember-2`: `oklch(45% 0.130 30)` — coal red
- `--ember-3`: `oklch(56% 0.165 36)` — red-orange
- `--ember-4`: `oklch(66% 0.185 46)` — ember orange (hover/pressed)
- `--ember-5`: `oklch(74% 0.170 55)` — **signal**, the one accent
- `--ember-6`: `oklch(82% 0.135 68)` — hot amber
- `--ember-7`: `oklch(93% 0.062 88)` — white-hot (focus, commands)

Coal neutrals (`--coal-1` … `--coal-8`), hue 40:

- `--coal-1`: `oklch(8.5% 0.014 40)` — console bed
- `--coal-2`: `oklch(10% 0.016 40)` — sidebar
- `--coal-3`: `oklch(12.5% 0.018 40)` — background
- `--coal-4`: `oklch(16.5% 0.020 40)` — card
- `--coal-5`: `oklch(21% 0.024 40)` — popover / secondary
- `--coal-6`: `oklch(25% 0.028 42)` — accent surface / muted
- `--coal-7`: `oklch(30% 0.032 42)` — border / input
- `--coal-8`: `oklch(39% 0.034 42)` — strong rule

Ink `--ink-1` `oklch(95% 0.014 70)` → `--ink-4` `oklch(50% 0.018 50)`.

Functional signals, deliberately off-ramp so server state stays readable at a
glance: `--signal-online` `oklch(76% 0.155 148)`, `--signal-warn`
`oklch(85% 0.150 92)`, `--signal-error` `oklch(66% 0.190 22)`, `--signal-idle`
`oklch(56% 0.016 45)`.

### Per-game hue

Entering a game re-tints the app in the colour of that game's hero artwork,
measured off the image itself: pixels binned by hue in OKLCH, weighted by
chroma and lightness, dominant sector wins. Minecraft 52 (firelight), Terraria
210 (sky), Valheim 234 (fog), Palworld 128 (foliage); the Custom slide's
artwork is greyscale and keeps the default.

Only the *hue* moves. The ramps above keep their lightness rungs and their
role assignments exactly - chroma is re-fitted to what sRGB holds at the new
hue - so every contrast pair holds and nothing has to be restated per game.
The blocks live in `src/tokens.css` under `[data-game]`, which `src/App.jsx`
mirrors onto `<html>` so portalled layers are themed with the shell. A signal
is rotated only when a game's accent lands within ~30 degrees of it and would
blunt it: Palworld moves `--signal-online` to 165.

## Typography

One superfamily at two widths — the esports/gaming brand backbone — plus a mono
confined to code:

- Brand: Saira, weight 700 — the regular-width cut gives the wordmark open,
  stable proportions beside the square stacked-deck glyph.
- Display: Saira Condensed, weight 800 (700 available), normal.
- Body: Saira, weight 400 (600/700 for emphasis, true italic 400) — same family,
  regular width.
- Mono: IBM Plex Mono, weights 400/600 — **code surfaces only**.
- Pixel: Press Start 2P, weight 400 — the game carousel only.
- Brand: 16px, tracking `+0.04em`.
- Display tracking: `+0.01em`. Small uppercase titles take `+0.03em`. All display
  tracking is positive; a condensed face jams if pulled tight.
- Type scale anchor: `--text-display: clamp(2.75rem, 4.5vw + 1rem, 5.25rem)`.
- Role floor: `--text-label` 12px, the smallest size any UI label may use.

Display and body are one superfamily on purpose: an earlier two-family pairing
(grotesk display, serif body) read as two unrelated systems wherever they met.

Fonts are bundled or loaded with robust local fallbacks. Headings never use italics.

## Spacing

Four-point named scale. Values live in root `tokens.css`; application CSS consumes named tokens wherever custom CSS is used.

## Motion

- Enter: opacity with at most 6px of vertical translation.
- Interaction: 120ms press and state changes; 220ms menus and tooltips.
- Reduced motion: opacity-only, no more than 150ms.
- No decorative infinite animation. Functional loaders may rotate.

## Microinteractions stance

- Silent success for routine operations; toasts only when persistence or recovery benefits from acknowledgement.
- Hover tooltips: 800ms. Keyboard-focus tooltips: immediate.
- Buttons depress by one pixel; cards do not float.
- Focus rings are immediate, high-contrast, and never animated.

## CTA voice

- Primary: ember fill, near-square corners, concrete verb first.
- Secondary: hard outline, transparent surface, same dimensions.
- Destructive: red signal plus icon/text; colour is never the only signal.

## Per-page allowances

- App hub and dashboard may use official or press-kit game artwork as low-contrast environmental imagery.
- Dense operational views use artwork only in a narrow identity rail or page backdrop below 10% perceived contrast.
- Console and configuration editors prioritize function and use no key art behind working text.

## What pages MUST share

- Hostkind mark and wordmark treatment.
- Ember accent placement, limited to active state, focus, status emphasis, and primary action.
- Typography, spacing, control geometry, focus treatment, and surface hierarchy.
- Workbench rhythm: one dominant working surface, then supporting tools.

## What pages MAY differ on

- Game-specific environmental artwork and a muted identity hue.
- Density appropriate to the job: dashboard broad, console dense, forms measured.
- Section composition inside the Workbench family.

## Exports

### tokens.css

The canonical implementation is [`tokens.css`](tokens.css).

### Tailwind `@theme` (v4 shape)

> This project is on **Tailwind v3** and maps tokens through
> `tailwind.config.js`, not `@theme`. The block below is an export for
> consumers on v4, not what Hostkind itself runs.

```css
@theme {
  --color-coal-1: oklch(8.5% 0.014 40);
  --color-coal-3: oklch(12.5% 0.018 40);
  --color-coal-4: oklch(16.5% 0.020 40);
  --color-coal-7: oklch(30% 0.032 42);
  --color-ink-1: oklch(95% 0.014 70);
  --color-ink-2: oklch(80% 0.016 65);
  --color-ember-4: oklch(66% 0.185 46);
  --color-ember-5: oklch(74% 0.170 55);
  --color-ember-7: oklch(93% 0.062 88);
  --font-brand: "Saira", sans-serif;
  --font-display: "Saira Condensed", sans-serif;
  --font-body: "Saira", sans-serif;
  --font-outlier: "IBM Plex Mono", monospace;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG tokens.json

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "coal-3": { "$value": "oklch(12.5% 0.018 40)", "$type": "color" },
    "coal-4": { "$value": "oklch(16.5% 0.020 40)", "$type": "color" },
    "ink-1": { "$value": "oklch(95% 0.014 70)", "$type": "color" },
    "ember-5": { "$value": "oklch(74% 0.170 55)", "$type": "color" }
  },
  "font": {
    "brand": { "$value": "Saira", "$type": "fontFamily" },
    "display": { "$value": "Saira Condensed", "$type": "fontFamily" },
    "body": { "$value": "Saira", "$type": "fontFamily" },
    "outlier": { "$value": "IBM Plex Mono", "$type": "fontFamily" }
  },
  "space": { "md": { "$value": "1rem", "$type": "dimension" } }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 12.5% 0.018 40;
  --foreground: 95% 0.014 70;
  --card: 16.5% 0.020 40;
  --card-foreground: 95% 0.014 70;
  --primary: 74% 0.170 55;
  --primary-strong: 66% 0.185 46;
  --primary-foreground: 13% 0.020 40;
  --secondary: 21% 0.024 40;
  --secondary-foreground: 95% 0.014 70;
  --muted: 25% 0.028 42;
  --muted-foreground: 69% 0.018 60;
  --border: 30% 0.032 42;
  --input: 30% 0.032 42;
  --ring: 93% 0.062 88;
  --radius: 0.25rem;
}
```
