'use strict';

/*
 * Cleanup for tests that install a real server.
 *
 * A download can be interrupted anywhere - the network drops, an upstream
 * changes a URL, the test times out mid-extract - and whatever landed on disk
 * so far is still there. Several gigabytes of it, in the Palworld case. So the
 * rule for these tests is: whatever you create, you name here first, and it is
 * removed when the test ends whether it passed or failed.
 *
 * Two layers do the work, deliberately:
 *
 *   1. the test itself removes the server through the UI, because that is the
 *      product behaviour worth testing (remove profile + move files to trash);
 *   2. this tracker sweeps afterwards, because layer 1 does not run when a
 *      test fails halfway.
 *
 * The instance's own temp directory is removed on stop() as well, so this is
 * really a third net. It exists because an install test is the one place where
 * leaving something behind is expensive.
 */

const fs = require('fs');
const path = require('path');

// Removing a freshly-written tree on Windows can lose a race with whatever
// wrote it (an antivirus scan, a handle the installer has not closed yet), so
// retry rather than fail the test on a transient EBUSY/EPERM.
async function removeTree(target, { attempts = 5 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(target)) return true;
    } catch { /* fall through to the retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  return !fs.existsSync(target);
}

function directorySize(target) {
  let total = 0;
  const walk = (entry) => {
    let stat;
    try { stat = fs.statSync(entry); } catch { return; }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
    } else {
      total += stat.size;
    }
  };
  walk(target);
  return total;
}

/**
 * Create a tracker for one test.
 *
 * @param {object} panel  the instance the test is driving
 */
function createTracker(panel) {
  const parent = path.join(panel.dirs.root, 'installs');
  fs.mkdirSync(parent, { recursive: true });

  // The parent is tracked from the start, so an install that dies before the
  // test learns the folder's name is still swept. The panel derives that name
  // by slugifying the server's, which is its business, not the test's.
  const tracked = new Set([parent]);

  return {
    /** The folder to hand the create wizard as its parent directory. */
    parentDir: parent,

    /** Track something created outside `parentDir`. */
    track(target) {
      tracked.add(path.resolve(target));
      return target;
    },

    /** What is actually on disk right now, with sizes - useful in a message. */
    report() {
      return [...tracked]
        .filter((target) => fs.existsSync(target))
        .map((target) => `${target} (${(directorySize(target) / 1e6).toFixed(1)} MB)`);
    },

    /**
     * Remove everything tracked. Returns what could not be removed, so the
     * caller can fail loudly rather than leave gigabytes lying around quietly.
     */
    async cleanup() {
      const stubborn = [];
      for (const target of tracked) {
        if (!fs.existsSync(target)) continue;
        if (!await removeTree(target)) stubborn.push(target);
      }
      return stubborn;
    },
  };
}

module.exports = { createTracker, removeTree, directorySize };
