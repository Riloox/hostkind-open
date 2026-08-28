'use strict';

/*
 * Branding resolution.
 *
 * A hosting provider shipping Hostkind under their own name has to be able to
 * do it from config.json. Before this module the visible wordmark came from
 * `t('brand.name')` in i18n.json, so a rebrand meant editing a translation file
 * and rebuilding the SPA - which is not an answer anyone accepts to "can we put
 * our name on it?".
 *
 * The accent is the only non-obvious part. Colour in the panel is an OKLCH
 * component triple ("74% 0.170 55") consumed as `oklch(var(--primary))`, and a
 * provider will hand over a hex. The conversion lives here rather than in the
 * SPA so there is one implementation, testable without a browser, and so the
 * three partners of --primary can be *derived* from the relationships design.md
 * already states for the ember ramp. A provider supplies one colour, not four,
 * and cannot accidentally ship an unreadable button.
 */

// Anything longer overflows the collapsed sidebar and the login card; a
// provider wanting a paragraph wants a logo instead.
const MAX_NAME_LENGTH = 32;
const DEFAULT_NAME = 'Hostkind';

// OKLCH stays inside sRGB for the ranges we clamp to; beyond ~0.37 chroma the
// browser gamut-maps and the derived partners stop tracking the source colour.
const MAX_CHROMA = 0.37;
const MIN_LIGHTNESS = 0.05;
const MAX_LIGHTNESS = 0.99;

/*
 * A URL that the SPA will put in `src` or `href`. Only same-origin paths and
 * explicit http(s) URLs pass - config.json is the panel operator's file, but a
 * `javascript:` logo URL would still be a stored-XSS foot-gun for anyone who
 * edits it from a template, and there is no legitimate use for one.
 */
function safeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch {
    return '';
  }
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/*
 * sRGB hex -> OKLCH. Coefficients are Björn Ottosson's published OKLab matrices.
 * Returns null for anything that is not a 3- or 6-digit hex, which is how the
 * caller decides to leave the built-in accent alone.
 */
function hexToLinear(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3) digits = digits.split('').map((ch) => ch + ch).join('');
  return {
    r: srgbToLinear(parseInt(digits.slice(0, 2), 16) / 255),
    g: srgbToLinear(parseInt(digits.slice(2, 4), 16) / 255),
    b: srgbToLinear(parseInt(digits.slice(4, 6), 16) / 255),
  };
}

// WCAG relative luminance. Used only to decide whether a button's label should
// be dark or light - see deriveAccent.
function relativeLuminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToOklch(hex) {
  const linear = hexToLinear(hex);
  if (!linear) return null;
  const { r, g, b } = linear;

  const lp = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mp = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sp = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const lightness = 0.2104542553 * lp + 0.7936177850 * mp - 0.0040720468 * sp;
  const a = 1.9779984951 * lp - 2.4285922050 * mp + 0.4505937099 * sp;
  const bb = 0.0259040371 * lp + 0.7827717662 * mp - 0.8086757660 * sp;

  let hue = Math.atan2(bb, a) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  // A grey has no meaningful hue; atan2 on two near-zero components returns
  // noise, so pin it rather than let the derived partners drift apart.
  const chroma = Math.sqrt(a * a + bb * bb);
  return { l: lightness, c: chroma, h: chroma < 0.0005 ? 0 : hue };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function triple({ l, c, h }) {
  const lightness = clamp(l, MIN_LIGHTNESS, MAX_LIGHTNESS);
  const chroma = clamp(c, 0, MAX_CHROMA);
  return `${(lightness * 100).toFixed(1)}% ${chroma.toFixed(3)} ${(h % 360).toFixed(1)}`;
}

/*
 * One brand colour -> the four tokens the panel actually reads. The offsets
 * mirror what the ember ramp does between its own rungs (design.md):
 *
 *   --primary-strong  one rung down: 8pp darker, slightly more saturated, so a
 *                     press reads as heat pushed into the control.
 *   --ring            "19 points of lightness clear of --primary", desaturated
 *                     so a focused primary button is not ringed in its own
 *                     colour. Hue is left alone - the ember ramp's hue drift is
 *                     an ember decision, not one to impose on someone's brand.
 *   --primary-foreground  whichever of near-black / near-white the accent can
 *                     carry. Tinted with the accent hue, like --ink-on-ember.
 */
function deriveAccent(hex) {
  const base = hexToOklch(hex);
  const linear = hexToLinear(hex);
  if (!base || !linear) return null;
  // A near-white or near-black "accent" produces partners that collapse onto
  // each other; refuse instead of shipping a panel with an invisible button.
  if (base.l > 0.95 || base.l < 0.20) return null;

  const luminance = relativeLuminance(linear);
  return {
    primary: triple(base),
    primaryStrong: triple({ l: base.l - 0.08, c: base.c + 0.015, h: base.h }),
    ring: triple({ l: base.l + 0.19, c: base.c * 0.36, h: base.h }),
    // Measured, not thresholded. A mid-lightness blue and a mid-lightness
    // yellow sit at the same OKLCH lightness and want opposite labels, so the
    // choice is whichever of dark/light actually contrasts better against the
    // accent. Both candidates are tinted with the accent hue rather than being
    // flat #000/#fff, the same way --ink-on-ember is tinted toward ember.
    primaryForeground: contrast(luminance, 0) >= contrast(luminance, 1)
      ? triple({ l: 0.13, c: 0.020, h: base.h })
      : triple({ l: 0.98, c: 0.005, h: base.h }),
  };
}

// WCAG contrast ratio between two relative luminances.
function contrast(a, b) {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Ottosson's inverse OKLab -> linear sRGB matrices (forward is already in hexToOklch).
const M1_INV = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147010],
];

function oklchToLinearRgb({ l, c, h }) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
  return [
    M1_INV[0][0] * l3 + M1_INV[0][1] * m3 + M1_INV[0][2] * s3,
    M1_INV[1][0] * l3 + M1_INV[1][1] * m3 + M1_INV[1][2] * s3,
    M1_INV[2][0] * l3 + M1_INV[2][1] * m3 + M1_INV[2][2] * s3,
  ];
}

// Largest chroma at (l, h) whose conversion stays inside sRGB [0,1] on all
// channels - the gamut boundary the browser would otherwise clip at. The 96%
// rule in tokens.css leaves 4% headroom.
function maxChromaAt(l, h) {
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 32; i += 1) {
    const mid = (lo + hi) / 2;
    const rgb = oklchToLinearRgb({ l, c: mid, h });
    if (rgb.every((v) => v >= -1e-9 && v <= 1 + 1e-9)) lo = mid; else hi = mid;
  }
  return lo;
}

// Structural constants copied verbatim from the built-in game themes in
// src/tokens.css (ember/coal/ink lightness ladders and coal/ink chroma are
// constants across all themes; only hue shifts - see the tokens.css header).
const RAMP = {
  ember: { lightness: [30, 45, 56, 66, 74, 82, 93], hueOffset: [0, 0, 2, 8, 12, 18, 28] },
  coal:  { lightness: [8.5, 10, 12.5, 16.5, 21, 25, 30, 39], hueOffset: Array(8).fill(20), chroma: [0.014, 0.016, 0.018, 0.020, 0.024, 0.028, 0.032, 0.034] },
  ink:   { lightness: [95, 80, 69, 50], hueOffset: [27, 22, 17, 7], chroma: [0.014, 0.016, 0.018, 0.018] },
  inkOnEmber: { lightness: 13, hueOffset: 20, chroma: 0.020 },
};

const GAME_IDS = ['minecraft', 'terraria', 'valheim', 'palworld', 'custom'];
const ONLINE_SIGNAL_HUE = 148;
const SIGNAL_MARGIN = 24;   // circular degrees; palworld sat 20 deg off and was rotated
const SIGNAL_ROTATE = 17;   // rotate to the farther of hue+-17, matching the palworld 148->165 fix

function circularDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * One game hex -> the full ramp, as { ember, coal, ink, inkOnEmber, signalOnline }.
 * signalOnline is null unless the accent hue collides with the online-green signal.
 * Returns null for unusable input (non-hex, or chroma < 0.005 -> no meaningful hue).
 */
function deriveGameTheme(hex) {
  const base = hexToOklch(hex);
  if (!base || base.c < 0.005) return null;
  // Near-white or near-black accents produce an unreadable ramp; refuse
  // (same gate as deriveAccent).
  if (base.l > 0.95 || base.l < 0.20) return null;
  const H = base.h;
  const rung = (lightness, hueOffset, chroma) => {
    const hue = (H + hueOffset) % 360;
    const fitted = Math.min(chroma ?? maxChromaAt(lightness / 100, hue) * 0.96, MAX_CHROMA);
    return triple({ l: lightness / 100, c: fitted, h: hue });
  };
  const ember = RAMP.ember.lightness.map((l, i) => rung(l, RAMP.ember.hueOffset[i], null));
  const coal = RAMP.coal.lightness.map((l, i) => rung(l, RAMP.coal.hueOffset[i], RAMP.coal.chroma[i]));
  const ink = RAMP.ink.lightness.map((l, i) => rung(l, RAMP.ink.hueOffset[i], RAMP.ink.chroma[i]));
  const inkOnEmber = rung(RAMP.inkOnEmber.lightness, RAMP.inkOnEmber.hueOffset, RAMP.inkOnEmber.chroma);

  // The palworld rule, generalized: the online signal within SIGNAL_MARGIN of
  // the accent hue moves to the farther of hue+-SIGNAL_ROTATE. Palworld's
  // accent (128) lands on 165, byte-identical to src/tokens.css:138.
  const accentHue = (H + RAMP.ember.hueOffset[4]) % 360; // ember-5 is the voice
  let signalOnline = null;
  if (circularDistance(accentHue, ONLINE_SIGNAL_HUE) < SIGNAL_MARGIN) {
    const plus = (ONLINE_SIGNAL_HUE + SIGNAL_ROTATE) % 360;
    const minus = (ONLINE_SIGNAL_HUE - SIGNAL_ROTATE + 360) % 360;
    signalOnline = circularDistance(plus, accentHue) >= circularDistance(minus, accentHue)
      ? `76% 0.153 ${plus.toFixed(1)}`
      : `76% 0.153 ${minus.toFixed(1)}`;
  }

  return { ember, coal, ink, inkOnEmber, signalOnline };
}

/** config.gameAccents -> a stable { minecraft: null|theme, ... } map for the SPA. */
function resolveGameAccents(config) {
  const raw = (config && typeof config.gameAccents === 'object' && !Array.isArray(config.gameAccents) && config.gameAccents) || {};
  const out = {};
  for (const id of GAME_IDS) out[id] = deriveGameTheme(raw[id]) ?? null;
  return out;
}

// The hex shape accepted for a game accent.
// ACCENT_RE. Duplicated on purpose: branding is a dependency-free pure lib and
// must not pull in the db module.
const ACCENT_HEX_RE = /^#(?:[0-9a-f]{6})$/i;

/** config.gameAccents validation: only known ids, only #rrggbb hexes, blank otherwise. */
function normalizeGameAccents(raw) {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for (const id of GAME_IDS) {
    const value = String(input[id] == null ? '' : input[id]).trim().toLowerCase();
    out[id] = ACCENT_HEX_RE.test(value) ? value : '';
  }
  return out;
}

/*
 * The panel's branding as the SPA should render it. Shape is stable: every
 * field is always present, empty string meaning "use the built-in", so the
 * client never has to distinguish absent from blank.
 */
function resolve(config) {
  const branding = (config && typeof config.branding === 'object' && !Array.isArray(config.branding) && config.branding) || {};
  // Trim before choosing, not after: a blank branding.name means "not set", and
  // should fall through to appName rather than skip it for the built-in default.
  const name = [branding.name, config && config.appName, DEFAULT_NAME]
    .map((candidate) => String(candidate == null ? '' : candidate).trim())
    .find((candidate) => candidate !== '');

  return {
    name: name.slice(0, MAX_NAME_LENGTH),
    logoUrl: safeUrl(branding.logoUrl),
    faviconUrl: safeUrl(branding.faviconUrl),
    supportUrl: safeUrl(branding.supportUrl),
    // Free-text line for the sidebar footer (a legal line, an operator note).
    // Trimmed, not validated: it is rendered as plain text by the SPA, never
    // as markup, and capped so a long paste cannot overflow the rail.
    legalFooter: String(branding.legalFooter == null ? '' : branding.legalFooter).trim().slice(0, 120),
    accent: deriveAccent(branding.accentColor),
  };
}

module.exports = { resolve, deriveAccent, hexToOklch, safeUrl, DEFAULT_NAME, MAX_NAME_LENGTH, oklchToLinearRgb, maxChromaAt, deriveGameTheme, resolveGameAccents, normalizeGameAccents };
