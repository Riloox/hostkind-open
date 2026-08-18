'use strict';

/*
 * SQLite database for the platform foundation.
 *
 * Spec contract: open data/fleetdeck.db in WAL mode with foreign keys enabled
 * (docs/roadmap/README.md "Shared platform foundation"). Callers should treat
 * the returned handle as a singleton: every other foundation module reads the
 * same connection, the same prepared-statement cache, and the same pragmas.
 *
 * Why one file in lib/: the foundation has to be reusable across the planned
 * modules (operations, audit, capabilities, snapshots, ...). Concentrating
 * the open/pragma logic here keeps all of them on a single, well-known handle
 * and makes it easy to swap the driver later if we ever need to.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function defaultDataDir() {
  if (process.env.FLEETDECK_DATA_DIR) return process.env.FLEETDECK_DATA_DIR;
  // Deprecated alias: LODESTONE_DATA_DIR is the legacy env var from the pre-fleetdeck era.
  if (process.env.LODESTONE_DATA_DIR) return process.env.LODESTONE_DATA_DIR;
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = defaultDataDir();
const DB_PATH = path.join(DATA_DIR, 'fleetdeck.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'lodestone.db');

let dbInstance = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.renameSync(LEGACY_DB_PATH, DB_PATH);
  }
}

/*
 * Open the database. Idempotent: subsequent calls return the same handle.
 * The pragmas are reapplied defensively because some hosts (e.g. IDE tools
 * that touch the file) may reset them between runs.
 */
function open() {
  if (dbInstance) return dbInstance;
  ensureDataDir();
  const handle = new Database(DB_PATH);
  // WAL is required by the spec; journal_mode is sticky on the file.
  handle.pragma('journal_mode = WAL');
  // Foreign keys are off by default in SQLite; we want the spec's FK rules
  // to actually fire.
  handle.pragma('foreign_keys = ON');
  // Reasonable defaults for a server panel: serialized writes, NORMAL sync
  // (WAL is durable enough for our needs without the fsync storm of FULL).
  handle.pragma('synchronous = NORMAL');
  handle.pragma('busy_timeout = 5000');
  // The migrations runner takes its own short transactions; we want
  // immediate write visibility for the foreground HTTP request path.
  handle.pragma('read_uncommitted = false');
  dbInstance = handle;
  return handle;
}

/*
 * Close the database. Tests use this; the long-lived server.js process does
 * not (it just lets the process exit take down the handle).
 */
function close() {
  if (!dbInstance) return;
  try { dbInstance.close(); } catch { /* already closed */ }
  dbInstance = null;
}

function dbPath() {
  return DB_PATH;
}

function dataDir() {
  return DATA_DIR;
}

module.exports = { open, close, dbPath, dataDir, DATA_DIR, DB_PATH };
