'use strict';

const assert = require('assert');
const branding = require('../lib/branding.cjs');

const tests = [];

// 1. An unbranded panel is still Hostkind, and every field is present.
tests.push(() => {
  const resolved = branding.resolve({});
  assert.strictEqual(resolved.name, 'Hostkind');
  assert.strictEqual(resolved.logoUrl, '');
  assert.strictEqual(resolved.faviconUrl, '');
  assert.strictEqual(resolved.supportUrl, '');
  assert.strictEqual(resolved.accent, null);
  // The shape must not vary with configuration - the SPA does no null checks.
  assert.deepStrictEqual(
    Object.keys(branding.resolve({ branding: { name: 'X', accentColor: '#ff6b35' } })).sort(),
    Object.keys(resolved).sort(),
  );
});

// 2. branding.name wins over appName; appName still works on its own, which is
//    what every existing install has.
tests.push(() => {
  assert.strictEqual(branding.resolve({ appName: 'Acme Panel' }).name, 'Acme Panel');
  assert.strictEqual(branding.resolve({ appName: 'Acme', branding: { name: 'Better' } }).name, 'Better');
  assert.strictEqual(branding.resolve({ appName: 'Acme', branding: { name: '   ' } }).name, 'Acme');
});

// 3. A name is trimmed and capped rather than allowed to break the sidebar.
tests.push(() => {
  assert.strictEqual(branding.resolve({ branding: { name: '  Spaced  ' } }).name, 'Spaced');
  const long = branding.resolve({ branding: { name: 'x'.repeat(200) } }).name;
  assert.strictEqual(long.length, branding.MAX_NAME_LENGTH);
});

// 4. URLs: same-origin paths and http(s) pass, anything that could execute does
//    not. These land in src/href attributes, so this is the XSS boundary.
tests.push(() => {
  const url = (value) => branding.resolve({ branding: { logoUrl: value } }).logoUrl;
  assert.strictEqual(url('/resources/logo.svg'), '/resources/logo.svg');
  assert.strictEqual(url('https://cdn.example.com/logo.png'), 'https://cdn.example.com/logo.png');
  assert.strictEqual(url('http://example.com/logo.png'), 'http://example.com/logo.png');

  assert.strictEqual(url('javascript:alert(1)'), '');
  assert.strictEqual(url('JavaScript:alert(1)'), '');
  assert.strictEqual(url('data:text/html,<script>alert(1)</script>'), '');
  assert.strictEqual(url('vbscript:msgbox(1)'), '');
  // Protocol-relative would silently leave the origin.
  assert.strictEqual(url('//evil.example.com/logo.png'), '');
  assert.strictEqual(url('logo.png'), '', 'a bare relative path is ambiguous, so it is refused');
  assert.strictEqual(url(''), '');
  assert.strictEqual(url(null), '');
});

// 5. Hex to OKLCH, against values the design system already states.
//    tokens.css: --ember-5: 74% 0.170 55. Its hex is #f0883e-ish; rather than
//    assert someone else's rounding, check the conversion's own invariants.
tests.push(() => {
  assert.strictEqual(branding.hexToOklch('nope'), null);
  assert.strictEqual(branding.hexToOklch('#12345'), null);
  assert.strictEqual(branding.hexToOklch(''), null);

  const white = branding.hexToOklch('#ffffff');
  assert.ok(white.l > 0.99, `white should be ~1.0 lightness, got ${white.l}`);
  assert.ok(white.c < 0.001, 'white has no chroma');

  const black = branding.hexToOklch('#000000');
  assert.ok(black.l < 0.001, 'black should be ~0 lightness');

  // Shorthand and longhand are the same colour.
  assert.deepStrictEqual(branding.hexToOklch('#f00'), branding.hexToOklch('#ff0000'));
  // With or without the hash.
  assert.deepStrictEqual(branding.hexToOklch('3b82f6'), branding.hexToOklch('#3b82f6'));

  const red = branding.hexToOklch('#ff0000');
  assert.ok(red.c > 0.2, 'saturated red should have real chroma');
  assert.ok(red.h > 20 && red.h < 40, `red sits near hue 29, got ${red.h}`);
});

// 6. The derived partners follow the ramp relationships design.md states.
tests.push(() => {
  const accent = branding.deriveAccent('#3b82f6');
  assert.ok(accent, 'a normal brand colour should derive');

  const parse = (triple) => {
    const [l, c, h] = triple.split(' ');
    return { l: parseFloat(l), c: parseFloat(c), h: parseFloat(h) };
  };
  const primary = parse(accent.primary);
  const strong = parse(accent.primaryStrong);
  const ring = parse(accent.ring);

  assert.ok(Math.abs(strong.l - (primary.l - 8)) < 0.2, 'primary-strong is one rung down (8pp darker)');
  assert.ok(strong.c > primary.c, 'the pressed partner is slightly more saturated');
  assert.ok(Math.abs(ring.l - (primary.l + 19)) < 0.2, 'the ring is 19 points clear of primary');
  assert.ok(ring.c < primary.c, 'the ring is desaturated so it is not the button colour');
  // Hue is the provider's; nothing may rotate it.
  assert.strictEqual(strong.h, primary.h);
  assert.strictEqual(ring.h, primary.h);
});

// 7. The label is chosen by measured contrast, not by a lightness threshold -
//    the case that made a threshold wrong is a mid-lightness blue vs yellow.
tests.push(() => {
  const lightnessOf = (triple) => parseFloat(triple.split(' ')[0]);

  // #7c3aed is a dark violet: it needs a light label.
  assert.ok(lightnessOf(branding.deriveAccent('#7c3aed').primaryForeground) > 90);
  // #f5c518 is a bright yellow: it needs a dark one.
  assert.ok(lightnessOf(branding.deriveAccent('#f5c518').primaryForeground) < 20);
  // #3b82f6 is the interesting one - mid OKLCH lightness, but black on it
  // measures 5.7:1 against white's 3.7:1.
  assert.ok(lightnessOf(branding.deriveAccent('#3b82f6').primaryForeground) < 20);
});

// 8. Colours that cannot produce a usable button are refused outright, leaving
//    the built-in ember accent in place rather than shipping an invisible one.
tests.push(() => {
  assert.strictEqual(branding.deriveAccent('#ffffff'), null);
  assert.strictEqual(branding.deriveAccent('#000000'), null);
  assert.strictEqual(branding.deriveAccent('#111111'), null);
  assert.strictEqual(branding.deriveAccent('not a colour'), null);
  assert.strictEqual(branding.deriveAccent(''), null);
  assert.strictEqual(branding.deriveAccent(undefined), null);
});

// 9. Every emitted value is a valid OKLCH component triple. A malformed one
//    would not throw - it would silently blank the panel's accent in CSS.
tests.push(() => {
  const TRIPLE = /^\d+(?:\.\d+)?% \d+\.\d{3} \d+(?:\.\d+)?$/;
  for (const hex of ['#3b82f6', '#f5c518', '#7c3aed', '#10b981', '#ff6b35', '#808080', '#2c2c2c']) {
    const accent = branding.deriveAccent(hex);
    if (!accent) continue;
    for (const [field, value] of Object.entries(accent)) {
      assert.ok(TRIPLE.test(value), `${hex} produced a malformed ${field}: "${value}"`);
      const [l, c] = value.split(' ');
      assert.ok(parseFloat(l) >= 5 && parseFloat(l) <= 99, `${hex} ${field} lightness out of range`);
      assert.ok(parseFloat(c) <= 0.37, `${hex} ${field} chroma out of gamut`);
    }
  }
});

// deriveGameTheme: structural rules, not byte-exact values.
tests.push(() => {
  const theme = branding.deriveGameTheme('#f0883e');
  assert.ok(theme, 'a usable hex derives a theme');
  assert.strictEqual(theme.ember.length, 7);
  assert.strictEqual(theme.coal.length, 8);
  assert.strictEqual(theme.ink.length, 4);
  assert.match(theme.inkOnEmber, /^\d+(\.\d+)?% \d+\.\d+ \d+(\.\d+)?$/);
  assert.deepStrictEqual(theme.ember.map((t) => parseFloat(t.split(' ')[0])), [30, 45, 56, 66, 74, 82, 93]);
});

// Hue offsets from the artwork-measured themes: ember [0,0,2,8,12,18,28],
// coal +20, ink [27,22,17,7], ink-on-ember +20. #8bbe36 is palworld's own
// accent (74% 0.170 128) - its OKLCH hue is exactly 128.
tests.push(() => {
  const theme = branding.deriveGameTheme('#8bbe36'); // hue 128, like palworld
  const hue = (t) => parseFloat(t.split(' ')[2]);
  assert.deepStrictEqual(theme.ember.map(hue).map((h) => Math.round((h - 128 + 360) % 360)), [0, 0, 2, 8, 12, 18, 28]);
  assert.ok(theme.coal.every((t) => Math.round((hue(t) - 128 + 360) % 360) === 20));
  assert.deepStrictEqual(theme.ink.map(hue).map((h) => Math.round((h - 128 + 360) % 360)), [27, 22, 17, 7]);
  assert.strictEqual(Math.round((hue(theme.inkOnEmber) - 128 + 360) % 360), 20);
});

// Gamut safety: every derived rung converts back inside sRGB (nothing the
// browser would clip).
tests.push(() => {
  for (const hex of ['#3b82f6', '#46a758', '#f5c518', '#d6409f']) {
    const theme = branding.deriveGameTheme(hex);
    assert.ok(theme);
    const all = [...theme.ember, ...theme.coal, ...theme.ink, theme.inkOnEmber];
    for (const triple of all) {
      const [l, c, h] = triple.split(' ').map(parseFloat);
      const rgb = branding.oklchToLinearRgb({ l: l / 100, c, h });
      assert.ok(rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6), `${hex} rung ${triple} clips`);
    }
  }
});

// Contrast: text-on-card and ink-on-ember pairs stay readable for arbitrary hues.
tests.push(() => {
  const theme = branding.deriveGameTheme('#3b82f6');
  const lum = (triple) => {
    const [l, c, h] = triple.split(' ').map(parseFloat);
    const rgb = branding.oklchToLinearRgb({ l: l / 100, c, h });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  assert.ok(ratio(theme.ink[0], theme.coal[3]) >= 4.5, 'text on card');
  assert.ok(ratio(theme.inkOnEmber, theme.ember[4]) >= 4.5, 'label on accent');
});

// Signal guard: an accent near the online green rotates --signal-online away.
tests.push(() => {
  const collides = branding.deriveGameTheme('#00c853'); // hue 148.3, exactly online
  assert.ok(collides.signalOnline, 'online collision must rotate the signal');
  const rotated = parseFloat(collides.signalOnline.split(' ')[2]);
  assert.ok(Math.abs(rotated - 165) < 1 || Math.abs(rotated - 131) < 1, `rotated to ${rotated}`);
  // Palworld's own accent hue (128) must land on 165, byte-identical to
  // src/tokens.css:138 (--signal-online: 76% 0.153 165).
  const palworld = branding.deriveGameTheme('#8bbe36'); // hue 128
  assert.strictEqual(palworld.signalOnline, '76% 0.153 165.0');
  // A far hue leaves the signal alone.
  const far = branding.deriveGameTheme('#3b82f6'); // hue 260
  assert.strictEqual(far.signalOnline, null);
});

// Invalid / unusable input -> null.
tests.push(() => {
  for (const bad of ['', 'red', '#ff0', '#000000', '#ffffff', null, undefined, '#999999']) {
    assert.strictEqual(branding.deriveGameTheme(bad), null, `'${bad}'`);
  }
});

// resolveGameAccents: stable shape, unknown keys ignored, blanks fall back.
tests.push(() => {
  const resolved = branding.resolveGameAccents({ gameAccents: { terraria: '#3b82f6', nope: '#ff0000' } });
  assert.deepStrictEqual(Object.keys(resolved).sort(), ['custom', 'minecraft', 'palworld', 'terraria', 'valheim']);
  assert.ok(resolved.terraria);
  assert.strictEqual(resolved.minecraft, null);
  assert.strictEqual(resolved.valheim, null);
  assert.deepStrictEqual(branding.resolveGameAccents({}), Object.fromEntries(['minecraft','terraria','valheim','palworld','custom'].map((id) => [id, null])));
});

// normalizeGameAccents: only known ids survive, only valid #rrggbb hexes, blank otherwise.
tests.push(() => {
  const out = branding.normalizeGameAccents({ terraria: ' #3B82F6 ', nope: '#ff0000', valheim: 'red', minecraft: '' });
  assert.deepStrictEqual(out, { minecraft: '', terraria: '#3b82f6', valheim: '', palworld: '', custom: '' });
  assert.deepStrictEqual(
    branding.normalizeGameAccents(null),
    { minecraft: '', terraria: '', valheim: '', palworld: '', custom: '' },
  );
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  branding test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  branding test ${i + 1}: ${e.message}\n${e.stack}`); }
}

if (failed) { console.error(`FAIL  ${failed} branding test(s) failed`); process.exit(1); }
console.log('PASS  branding');
