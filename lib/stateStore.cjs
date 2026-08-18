'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./db.cjs');

const STATE_DIR = path.join(dataDir(), 'state');

/**
 * Synchronous read of a previously-written JSON blob.
 * Returns the parsed value, or null if the file is missing / corrupted.
 * NEVER throws — callers fall back to fetching fresh data.
 */
function read(namespace, key) {
  const filePath = stateFilePath(namespace, key);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Synchronous write-through.  Creates the state directory if needed.
 */
function write(namespace, key, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const filePath = stateFilePath(namespace, key);
  const tmp = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

/* internal */
function stateFilePath(namespace, key) {
  // Sanitise namespace and key to avoid path traversal.
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(STATE_DIR, `${safe(namespace)}-${safe(key)}.json`);
}

module.exports = { read, write };
