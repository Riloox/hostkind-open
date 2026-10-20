'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  extractSection, absolutizeLinks, releaseNotes, discordPayload,
} = require('../scripts/release-notes.cjs');

const changelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  'No entries yet.',
  '',
  '## [1.2.0] - 2026-01-02',
  '',
  '### Added',
  '',
  '- A thing.',
  '',
  '## [1.1.0] - 2026-01-01',
  '',
  '- Older.',
].join('\n');

assert.strictEqual(extractSection(changelog, '1.2.0'), '### Added\n\n- A thing.');
assert.strictEqual(extractSection(changelog, '1.1.0'), '- Older.');
assert.strictEqual(extractSection(changelog, '1.2'), null, 'version must match exactly');
assert.strictEqual(extractSection(changelog, '9.9.9'), null);

assert.strictEqual(
  absolutizeLinks('See [Privacy](PRIVACY.md), [site](https://x.io) and [top](#a).', 'v1.2.0'),
  'See [Privacy](https://github.com/Riloox/hostkind-open/blob/v1.2.0/PRIVACY.md), [site](https://x.io) and [top](#a).',
);

// The real changelog's newest release must extract and fit one embed.
const pkgVersion = require('../package.json').version;
const notes = releaseNotes(pkgVersion);
assert.ok(notes.length > 0 && !/^## /m.test(notes), 'section must not include its own or the next heading');
const payload = discordPayload(pkgVersion, notes);
const embed = payload.embeds[0];
assert.strictEqual(embed.title, `Hostkind ${pkgVersion}`);
assert.strictEqual(embed.url, `https://github.com/Riloox/hostkind-open/releases/tag/v${pkgVersion}`);
assert.strictEqual(embed.color, 0xfa8927);
assert.deepStrictEqual(payload.allowed_mentions, { parse: [] });

const long = discordPayload('1.0.0', '- line\n'.repeat(1000)).embeds[0].description;
assert.ok(long.length <= 4096, 'long notes must be cut to the embed limit');
assert.ok(long.endsWith('(https://github.com/Riloox/hostkind-open/releases/tag/v1.0.0)'));

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
assert.ok(!workflow.includes('--generate-notes'), 'release body must come from CHANGELOG.md');
assert.ok(workflow.includes('--notes-file "$RUNNER_TEMP/release-notes.md"'));
assert.ok(
  workflow.indexOf('- name: Post release notes to Discord') > workflow.indexOf('- name: Publish GitHub release'),
  'Discord post must follow release creation',
);

console.log('PASS release-notes');
