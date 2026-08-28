'use strict';

/*
 * Create the signed metadata consumed by the installed binary updater.
 *
 * This script deliberately does not build executables. A binary packaging job
 * supplies the real GitHub release asset names, URLs, and SHA-256 values; this
 * module validates those values and signs the canonical manifest with Ed25519.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateManifest } = require('../lib/application-release.cjs');

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = sortCanonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalManifestJson(manifest) {
  const unsigned = { ...(manifest || {}) };
  delete unsigned.manifestSignature;
  return JSON.stringify(sortCanonical(unsigned));
}

function privateKeyObject(signingKey) {
  if (signingKey && typeof signingKey === 'object' && signingKey.type) return signingKey;
  if (typeof signingKey === 'string') return crypto.createPrivateKey(signingKey);
  throw new TypeError('createUpdateManifest requires an Ed25519 signingKey');
}

function createUpdateManifest({
  version,
  priority = 'normal',
  releaseNotesUrl,
  publishedAt = new Date().toISOString(),
  artifacts,
  signingKey,
  product = 'hostkind',
  edition = 'open',
  channel = 'stable',
  schema = 1,
} = {}) {
  const unsigned = {
    schema,
    product,
    edition,
    version,
    channel,
    priority,
    releaseNotesUrl,
    publishedAt,
    artifacts,
  };
  const platformKey = artifacts && artifacts['windows-x64'] ? 'windows-x64' : 'linux-x64';
  validateManifest(unsigned, { platformKey });
  const signature = crypto.sign(null, Buffer.from(canonicalManifestJson(unsigned)), privateKeyObject(signingKey));
  return { ...unsigned, manifestSignature: signature.toString('base64') };
}

function writeUpdateManifest({ output, ...options }) {
  if (typeof output !== 'string' || !output) throw new TypeError('writeUpdateManifest requires output');
  const manifest = createUpdateManifest(options);
  const target = path.resolve(output);
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
  return { path: target, manifest };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) out[key] = true;
    else { out[key] = value; i += 1; }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.version || !args['release-notes-url'] || !args['artifacts-file'] || !args.output || !args['signing-key-file']) {
    throw new Error('usage: node scripts/create-update-manifest.cjs --version X.Y.Z --release-notes-url URL --artifacts-file FILE --output FILE --signing-key-file FILE [--priority normal|high]');
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(args['artifacts-file']), 'utf8'));
  const artifacts = raw && raw.artifacts ? raw.artifacts : raw;
  const signingKey = fs.readFileSync(path.resolve(args['signing-key-file']), 'utf8');
  const result = writeUpdateManifest({
    output: args.output,
    version: args.version,
    priority: args.priority || 'normal',
    releaseNotesUrl: args['release-notes-url'],
    publishedAt: args['published-at'] || new Date().toISOString(),
    artifacts,
    signingKey,
  });
  process.stdout.write(`wrote ${result.path}\n`);
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`manifest failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  canonicalManifestJson,
  createUpdateManifest,
  writeUpdateManifest,
  parseArgs,
  main,
};
