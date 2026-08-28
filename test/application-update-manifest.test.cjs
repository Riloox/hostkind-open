'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createUpdateManifest, canonicalManifestJson } = require('../scripts/create-update-manifest.cjs');

const PRIVATE_KEY = crypto.generateKeyPairSync('ed25519').privateKey;
const PUBLIC_KEY = crypto.generateKeyPairSync('ed25519').publicKey;
const SHA = 'a'.repeat(64);

function artifacts() {
  return {
    'windows-x64': {
      name: 'hostkind-1.2.3-windows-x64.exe',
      url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-windows-x64.exe',
      sha256: SHA,
    },
    'linux-x64': {
      name: 'hostkind-1.2.3-linux-x64',
      url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-linux-x64',
      sha256: SHA,
    },
  };
}

assert.throws(
  () => createUpdateManifest({
    version: '1.2.3-beta.1',
    releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v1.2.3-beta.1',
    artifacts: artifacts(),
    signingKey: PRIVATE_KEY,
  }),
  /version|stable|semver/i,
);

const manifest = createUpdateManifest({
  version: '1.2.3',
  priority: 'high',
  publishedAt: '2026-08-25T12:00:00.000Z',
  releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v1.2.3',
  artifacts: artifacts(),
  signingKey: PRIVATE_KEY,
});

assert.strictEqual(manifest.schema, 1);
assert.strictEqual(manifest.product, 'hostkind');
assert.strictEqual(manifest.edition, 'open');
assert.strictEqual(manifest.channel, 'stable');
assert.strictEqual(manifest.priority, 'high');
assert.strictEqual(typeof manifest.manifestSignature, 'string');
assert.ok(manifest.manifestSignature.length > 20);

const signature = Buffer.from(manifest.manifestSignature, 'base64');
assert.strictEqual(
  crypto.verify(null, Buffer.from(canonicalManifestJson(manifest)), PUBLIC_KEY, signature),
  false,
  'a signature must not verify against an unrelated public key',
);

// Sign with the matching key and verify against the canonical payload exposed by
// the implementation. The helper must exclude manifestSignature from the payload.
const keyPair = crypto.generateKeyPairSync('ed25519');
const signed = createUpdateManifest({
  version: '1.2.3',
  releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v1.2.3',
  artifacts: artifacts(),
  signingKey: keyPair.privateKey,
});
assert.strictEqual(
  crypto.verify(
    null,
    Buffer.from(canonicalManifestJson(signed)),
    keyPair.publicKey,
    Buffer.from(signed.manifestSignature, 'base64'),
  ),
  true,
  'manifest signature must cover canonical metadata without the signature field',
);

const reordered = { ...signed, artifacts: { ...signed.artifacts } };
assert.strictEqual(canonicalManifestJson(reordered), canonicalManifestJson(signed));
console.log('PASS application-update-manifest');
