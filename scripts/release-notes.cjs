'use strict';

/*
 * Hostkind - release notes from CHANGELOG.md (single source of truth).
 *
 * Pulls the "## [X.Y.Z]" section for one version out of CHANGELOG.md, so the
 * GitHub release page and the Discord #changelog post say exactly what the
 * changelog says. Relative links (PRIVACY.md) are rewritten to point at the
 * tagged tree, since neither GitHub release bodies nor Discord resolve them.
 *
 *   node scripts/release-notes.cjs --version 0.2.1                 # print
 *   node scripts/release-notes.cjs --version 0.2.1 --output n.md   # write
 *   node scripts/release-notes.cjs --version 0.2.1 --discord       # post
 *
 * --discord posts one embed to $DISCORD_CHANGELOG_WEBHOOK. When the variable
 * is empty it prints a notice and exits 0, so a missing secret never fails a
 * release.
 */

const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/Riloox/hostkind-open';
// --ember-5 (oklch 74% 0.170 55) from tokens.css, the "signal" orange.
const BRAND_COLOR = 0xfa8927;
// Discord caps an embed description at 4096 characters.
const EMBED_DESCRIPTION_MAX = 4096;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function absolutizeLinks(markdown, tag) {
  return markdown.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, target) =>
    `](${REPO_URL}/blob/${tag}/${target.replace(/^\.?\//, '')})`);
}

function releaseNotes(version, changelogPath = path.join(__dirname, '..', 'CHANGELOG.md')) {
  const section = extractSection(fs.readFileSync(changelogPath, 'utf8'), version);
  if (!section) throw new Error(`no "## [${version}]" section in ${changelogPath}`);
  return absolutizeLinks(section, `v${version}`);
}

function discordPayload(version, notes) {
  const releaseUrl = `${REPO_URL}/releases/tag/v${version}`;
  let description = notes;
  if (description.length > EMBED_DESCRIPTION_MAX) {
    const more = `\n\n… [Read the full notes](${releaseUrl})`;
    const cut = description.lastIndexOf('\n', EMBED_DESCRIPTION_MAX - more.length);
    description = description.slice(0, cut > 0 ? cut : EMBED_DESCRIPTION_MAX - more.length) + more;
  }
  return {
    username: 'Hostkind Releases',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Hostkind ${version}`,
      url: releaseUrl,
      description,
      color: BRAND_COLOR,
    }],
  };
}

async function postToDiscord(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
}

function parseArgs(argv) {
  const args = { version: null, output: null, discord: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--discord') args.discord = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.version) throw new Error('--version X.Y.Z is required');
  args.version = args.version.replace(/^v/, '');
  return args;
}

module.exports = { extractSection, absolutizeLinks, releaseNotes, discordPayload };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const notes = releaseNotes(args.version);
    if (args.output) fs.writeFileSync(args.output, `${notes}\n`);
    if (args.discord) {
      const webhook = process.env.DISCORD_CHANGELOG_WEBHOOK || '';
      if (!webhook) {
        console.log('::notice::skipping Discord post (DISCORD_CHANGELOG_WEBHOOK not set)');
        return;
      }
      await postToDiscord(webhook, discordPayload(args.version, notes));
      console.log(`release-notes: posted Hostkind ${args.version} to Discord`);
    }
    if (!args.output && !args.discord) process.stdout.write(`${notes}\n`);
  })().catch((err) => {
    console.error(`release-notes: ${err.message}`);
    process.exit(1);
  });
}
