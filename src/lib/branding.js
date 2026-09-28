/*
 * Applies the branding the panel reported at boot to the document itself.
 *
 * These four things live outside React's tree - the accent is read by CSS via
 * custom properties, and the title and favicon belong to <head> - so they are
 * set imperatively once rather than rendered. The server has already validated
 * every value (lib/branding.cjs); nothing here decides anything, it only
 * installs what it was given.
 */

const DEFAULT_FAVICON = '/resources/favicon.svg';

// The tokens a provider's accent replaces. Each is an OKLCH component triple,
// consumed as oklch(var(--primary)) - so the values are set, not the colours.
const ACCENT_TOKENS = {
  primary: '--primary',
  primaryStrong: '--primary-strong',
  ring: '--ring',
  primaryForeground: '--primary-foreground',
};

export function applyBranding(branding) {
  if (!branding) return;
  const root = document.documentElement;

  if (branding.name) document.title = branding.name;

  for (const [field, token] of Object.entries(ACCENT_TOKENS)) {
    const value = branding.accent?.[field];
    // Removing rather than setting an empty string matters: the built-in ember
    // value must win again if branding is cleared, and an empty custom property
    // would shadow it with nothing.
    if (value) root.style.setProperty(token, value);
    else root.style.removeProperty(token);
  }

  const favicon = branding.faviconUrl || DEFAULT_FAVICON;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== favicon) {
    // A configured favicon can be any image type, so let the browser sniff it
    // instead of asserting the SVG type the built-in one happens to have.
    if (branding.faviconUrl) link.removeAttribute('type');
    else link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', favicon);
  }
}

// Tokens a custom game theme replaces. Every one is a ramp primitive in
// tokens.css (src/tokens.css [data-game] overrides the same names); the
// semantic roles in src/index.css alias them, so nothing else needs restating.
const RAMP_TOKENS = [
  '--ember-1', '--ember-2', '--ember-3', '--ember-4', '--ember-5',
  '--ember-6', '--ember-7',
  '--coal-1', '--coal-2', '--coal-3', '--coal-4', '--coal-5',
  '--coal-6', '--coal-7', '--coal-8',
  '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--ink-on-ember',
];

function themeRungs(theme) {
  return [
    ...theme.ember.map((value, i) => [`--ember-${i + 1}`, value]),
    ...theme.coal.map((value, i) => [`--coal-${i + 1}`, value]),
    ...theme.ink.map((value, i) => [`--ink-${i + 1}`, value]),
    ['--ink-on-ember', theme.inkOnEmber],
  ];
}

/** The ramp as a plain token->value map (the hub carousel styles slides with it). */
export function gameThemeStyle(theme) {
  const out = {};
  if (!theme) return out;
  for (const [token, value] of themeRungs(theme)) out[token] = value;
  if (theme.signalOnline) out['--signal-online'] = theme.signalOnline;
  return out;
}

/**
 * Installs (or clears) a game's custom ramp on the document. Inline styles on
 * <html> beat the [data-game] blocks in tokens.css; removeProperty reveals the
 * stylesheet ramp again, so an unset game or the hub falls back to the built-in.
 */
export function applyGameTheme(game, theme) {
  const root = document.documentElement;
  for (const token of RAMP_TOKENS) root.style.removeProperty(token);
  root.style.removeProperty('--signal-online');
  if (!game || !theme) return;
  for (const [token, value] of themeRungs(theme)) root.style.setProperty(token, value);
  if (theme.signalOnline) root.style.setProperty('--signal-online', theme.signalOnline);
}

// Switching servers re-tints the whole app. The ramp tokens are bare OKLCH
// triples, which CSS cannot transition (an unregistered custom property only
// snaps, and @property cannot type a mixed "L% C H" list), so the fade is
// driven here: sample every token before and after the change, then write the
// in-between values onto <html> each frame. Because every role aliases the
// ramp, that one loop moves every surface, portals included, and the page
// stays live throughout - nothing is frozen or snapshotted.
const FADE_TOKENS = [...RAMP_TOKENS, '--signal-online'];
const THEME_FADE_MS = 600;
const TRIPLE = /^\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*$/;
let fade = null;

function readTokens(root) {
  const style = getComputedStyle(root);
  return FADE_TOKENS.map((token) => style.getPropertyValue(token).trim());
}

function mixTriple(from, to, t) {
  const a = TRIPLE.exec(from);
  const b = TRIPLE.exec(to);
  if (!a || !b) return to;
  const lerp = (x, y) => x + (y - x) * t;
  // Hue takes the short way round the wheel, so ember to sky does not detour
  // through every colour in between.
  const dh = ((Number(b[3]) - Number(a[3]) + 540) % 360) - 180;
  const h = (Number(a[3]) + dh * t + 360) % 360;
  return `${lerp(Number(a[1]), Number(b[1])).toFixed(2)}% ${lerp(Number(a[2]), Number(b[2])).toFixed(4)} ${h.toFixed(1)}`;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Runs `apply` (which swaps the game theme on <html>) and fades the ramp from
 * the colours on screen to the new ones instead of snapping. Interrupting a
 * fade starts the next one from wherever the current one had got to.
 */
export function fadeGameTheme(apply) {
  const root = document.documentElement;
  if (fade) cancelAnimationFrame(fade);
  fade = null;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const from = readTokens(root);
  apply();
  if (reduced) return;
  const to = readTokens(root);
  if (from.every((value, i) => value === to[i])) return;

  // What `apply` left inline is the resting state to restore once the fade
  // lands: set values stay set, removed ones hand back to the stylesheet.
  const resting = FADE_TOKENS.map((token) => root.style.getPropertyValue(token));
  const start = performance.now();

  const frame = (now) => {
    const t = Math.min(1, (now - start) / THEME_FADE_MS);
    if (t >= 1) {
      FADE_TOKENS.forEach((token, i) => {
        if (resting[i]) root.style.setProperty(token, resting[i]);
        else root.style.removeProperty(token);
      });
      fade = null;
      return;
    }
    const k = easeInOut(t);
    FADE_TOKENS.forEach((token, i) => {
      if (from[i] && to[i]) root.style.setProperty(token, mixTriple(from[i], to[i], k));
    });
    fade = requestAnimationFrame(frame);
  };
  // Paint the old colours on this frame so nothing flashes before the fade.
  frame(start);
}
