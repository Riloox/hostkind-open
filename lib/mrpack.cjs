'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { checkEntry } = require('./archiveGuard.cjs');

const MAX_INDEX_BYTES = 16 * 1024 * 1024;

const SUPPORTED_LOADERS = ['fabric', 'forge', 'neoforge'];

const LOADER_DEP_KEYS = {
  'fabric-loader': 'fabric',
  'fabric': 'fabric',
  'forge': 'forge',
  'neoforge': 'neoforge',
  'quilt-loader': 'quilt',
};

function readMrpackIndex(buffer) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer)) {
      return reject(new Error('Expected a Buffer'));
    }
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Failed to open mrpack: ${err.message}`));
      let found = false;
      zipfile.on('entry', (entry) => {
        if (entry.fileName === 'modrinth.index.json') {
          found = true;
          // The index is read whole into memory; a real one is a few hundred KB.
          if (entry.uncompressedSize > MAX_INDEX_BYTES) return reject(new Error('modrinth.index.json is too large'));
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2) return reject(new Error(`Failed to read modrinth.index.json: ${err2.message}`));
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch (e) {
                reject(new Error(`Invalid modrinth.index.json: ${e.message}`));
              }
            });
            stream.on('error', (e) => reject(new Error(`Stream error reading index: ${e.message}`)));
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => {
        if (!found) reject(new Error('modrinth.index.json not found in mrpack'));
      });
      zipfile.on('error', (e) => reject(new Error(`Zip read error: ${e.message}`)));
      zipfile.readEntry();
    });
  });
}

function manifestToSpec(index) {
  if (!index || typeof index !== 'object') {
    return { unsupported: true, reason: 'Invalid or missing index' };
  }
  const deps = index.dependencies;
  if (!deps || typeof deps !== 'object') {
    return { unsupported: true, reason: 'Index has no dependencies section' };
  }
  const mcVersion = deps.minecraft || deps.Minecraft || '';
  if (!mcVersion) {
    return { unsupported: true, reason: 'No Minecraft version in dependencies' };
  }

  let loaderType = null;
  let loaderVersion = null;
  for (const [key, mapped] of Object.entries(LOADER_DEP_KEYS)) {
    if (deps[key]) {
      loaderType = mapped;
      loaderVersion = deps[key];
      break;
    }
  }

  if (!loaderType) {
    return { unsupported: true, reason: 'No recognized mod loader in dependencies (expected fabric-loader, forge, or neoforge)', mcVersion };
  }

  if (!SUPPORTED_LOADERS.includes(loaderType)) {
    return { unsupported: true, reason: `Loader "${loaderType}" is not supported. Supported: ${SUPPORTED_LOADERS.join(', ')}`, loaderType, mcVersion, loaderVersion };
  }

  return {
    mcVersion,
    loaderType,
    loaderVersion,
    name: index.name || '',
    versionId: index.versionId || '',
    unsupported: false,
  };
}

function serverSideFiles(index) {
  if (!index || !Array.isArray(index.files)) return [];
  return index.files.filter((f) => {
    const env = f.env || {};
    if (env.server === 'unsupported') return false;
    return true;
  });
}

function fileCountByEnv(index) {
  if (!index || !Array.isArray(index.files)) return { total: 0, server: 0 };
  const server = serverSideFiles(index).length;
  return { total: index.files.length, server };
}

function safeResolve(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    return null;
  }
  return resolved;
}

// Overrides are configs and small assets. The bounds keep a hostile pack (a
// zip bomb, or sizes the central directory lies about) from exhausting memory
// or disk: each entry is buffered whole before it is written. The ratio is
// looser than the archive guard's default because repetitive config text
// compresses very well.
const OVERRIDE_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  maxEntrySize: 256 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

function collectZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    // validateEntrySizes (yauzl's default) fails a stream whose real size
    // differs from the declared one, so the checks below hold on the bytes.
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      zipfile.on('entry', (entry) => {
        entries.push(entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve({ zipfile, entries }));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

async function extractOverrides(zipBuffer, serverDir) {
  const { zipfile, entries } = await collectZipEntries(zipBuffer);

  const serverOverrideEntries = entries.filter(
    (e) => e.fileName.startsWith('serverOverrides/') && !e.fileName.endsWith('/')
  );
  const clientOverrideEntries = entries.filter(
    (e) => e.fileName.startsWith('clientOverrides/') && !e.fileName.endsWith('/')
  );
  const overrideEntries = serverOverrideEntries.length > 0 ? serverOverrideEntries : clientOverrideEntries;

  const prefix = serverOverrideEntries.length > 0 ? 'serverOverrides/' : 'clientOverrides/';
  let extracted = 0;

  const guardState = {};
  for (const entry of overrideEntries) checkEntry(entry, guardState, OVERRIDE_LIMITS);

  for (const entry of overrideEntries) {
    const relativePath = entry.fileName.slice(prefix.length);
    const dest = safeResolve(serverDir, relativePath);
    if (!dest) {
      throw new Error(`Overrides entry "${entry.fileName}" escapes the server directory`);
    }

    await new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, Buffer.concat(chunks));
            extracted++;
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        stream.on('error', reject);
      });
    });
  }

  return extracted;
}

async function downloadAndVerify(url, hashes, ua) {
  const response = await fetch(url, { headers: { 'User-Agent': ua } });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());

  if (hashes) {
    if (hashes.sha1) {
      const actual = crypto.createHash('sha1').update(buf).digest('hex');
      if (actual !== hashes.sha1) {
        throw new Error(`SHA-1 mismatch: expected ${hashes.sha1}, got ${actual}`);
      }
    }
    if (hashes.sha512) {
      const actual = crypto.createHash('sha512').update(buf).digest('hex');
      if (actual !== hashes.sha512) {
        throw new Error(`SHA-512 mismatch: expected ${hashes.sha512}, got ${actual}`);
      }
    }
  }

  return buf;
}

module.exports = {
  readMrpackIndex,
  manifestToSpec,
  serverSideFiles,
  fileCountByEnv,
  extractOverrides,
  downloadAndVerify,
  safeResolve,
  SUPPORTED_LOADERS,
  LOADER_DEP_KEYS,
};
