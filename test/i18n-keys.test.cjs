'use strict';

/*
 * Every string the panel asks for exists, in both languages.
 *
 * t() falls back to the key itself, so a wrong namespace does not fail
 * anything: it renders `players.opped` or `worlds.op.clone` on screen. Both
 * shipped (Minecraft Players toasts until 0.2.0, Minecraft Worlds dialogs and
 * badges since the first commit). This reads the source instead:
 *
 *   1. en and es have the same keys.
 *   2. Every literal t('a.b') / tErr(user, 'a.b') names a key that exists.
 *   3. Every t(`a.${x}.b`) template can resolve: at least one key matches it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { dictionaries } = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n.json'), 'utf8'));

function flatten(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out.add(full);
  }
  return out;
}

function sourceFiles(dir, pattern, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'assets') sourceFiles(full, pattern, out);
    } else if (pattern.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const en = flatten(dictionaries.en);
const es = flatten(dictionaries.es);
const KEY = /^[a-zA-Z]\w*(?:\.[\w-]+)+$/;

const frontend = sourceFiles(path.join(ROOT, 'src'), /\.(?:js|jsx)$/);
const backend = [path.join(ROOT, 'server.js'), ...sourceFiles(path.join(ROOT, 'lib'), /\.cjs$/)];
const read = (file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') });

// 1. Same keys in both languages.
assert.deepEqual([...en].filter((key) => !es.has(key)), [], 'keys in en but not in es');
assert.deepEqual([...es].filter((key) => !en.has(key)), [], 'keys in es but not in en');

// 2. Literal keys exist.
const missing = [];
for (const { file, text } of frontend.map(read)) {
  for (const match of text.matchAll(/\bt\(\s*'([^'\n]+)'/g)) {
    if (KEY.test(match[1]) && !en.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
}
for (const { file, text } of backend.map(read)) {
  for (const match of text.matchAll(/\btErr\(\s*[\w.?]+\s*,\s*'([^'\n]+)'/g)) {
    if (KEY.test(match[1]) && !en.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
}
assert.deepEqual(missing, [], 'literal t() keys that do not exist');

// 3. Templates can resolve. A substitution may hold dots (rule ids such as
// `tps.low`) or a whole namespace, so it matches anything.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dead = [];
let templates = 0;
for (const { file, text } of frontend.map(read)) {
  for (const match of text.matchAll(/\bt\(\s*`([^`\n]*\$\{[^`\n]*)`/g)) {
    const pattern = new RegExp(`^${match[1].split(/\$\{[^}]*\}/).map(escape).join('.+')}$`);
    templates += 1;
    if (![...en].some((key) => pattern.test(key))) dead.push(`${file}: t(\`${match[1]}\`)`);
  }
}
assert.ok(templates > 20, `expected to find the panel's template keys, found ${templates}`);
assert.deepEqual(dead, [], 't() templates that match no key');

console.log(`PASS i18n-keys (${en.size} keys, ${templates} templates)`);
