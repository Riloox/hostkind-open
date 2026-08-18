'use strict';

/*
 * Test bootstrap: redirect the database to a temp file, reset the singleton,
 * and clean up. Every test file calls this once at the top.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Canonicalize through realpath: on Windows runners os.tmpdir() can carry an
// 8.3 short name (e.g. C:\Users\RUNNER~1\...) while the code under test
// resolves paths to their long form, so raw-string comparisons of derived
// paths would fail. Realpath'ing the root once keeps every derived path in
// the same canonical form on every platform.
const TMP_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-test-')));

function setupDataDir() {
  // Override the data directory for this test process. We do this by
  // monkey-patching the db module's constants via the test process's
  // own requires: tests import the lib modules directly, and we reset
  // module-level paths through NODE_DATADIR.
  process.env.FLEETDECK_DATA_DIR = path.join(TMP_ROOT, 'data');
  fs.mkdirSync(process.env.FLEETDECK_DATA_DIR, { recursive: true });
}

function teardown() {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
}

module.exports = { setupDataDir, teardown, TMP_ROOT };
