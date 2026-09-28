'use strict';

/*
 * Where POST /api/create installs a new server.
 *
 * A parent folder the user picked is used as-is: the server goes in
 * <parent>/<slug>, and an occupied folder there is refused by the caller
 * (existing destinations are never merged into).
 *
 * No parent folder means "wherever Hostkind keeps new servers", which is what
 * lets a preset install with nothing but a name. That default lives in the
 * user's home and not in the panel's data folder, because a panel reset
 * clears the data folder and must never take worlds with it. Since nobody
 * chose the folder name, a taken one is not an error: the next free
 * "<slug>-2", "<slug>-3"... is used instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FOLDER_NAME = 'Hostkind Servers';

function defaultServersDir() {
  return path.join(os.homedir(), DEFAULT_FOLDER_NAME);
}

function occupied(dir) {
  try {
    return fs.readdirSync(dir).length > 0 || !fs.statSync(dir).isDirectory();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    if (err.code === 'ENOTDIR') return true;
    throw err;
  }
}

/**
 * @param {object}   input
 * @param {string}   input.parentDir  What the user sent; empty for the default.
 * @param {string}   input.name       The server's display name.
 * @param {function} input.slugify    Folder name for a display name.
 * @param {string}   [input.root]     The default parent; defaultServersDir().
 * @returns {{ parentDir: string, dir: string, defaulted: boolean }}
 */
function resolveDestination({ parentDir, name, slugify, root = defaultServersDir() }) {
  const chosen = String(parentDir || '').trim();
  const slug = slugify(name);
  if (chosen) return { parentDir: chosen, dir: path.join(chosen, slug), defaulted: false };
  fs.mkdirSync(root, { recursive: true });
  let dir = path.join(root, slug);
  for (let n = 2; occupied(dir); n++) dir = path.join(root, `${slug}-${n}`);
  return { parentDir: root, dir, defaulted: true };
}

module.exports = { resolveDestination, defaultServersDir, DEFAULT_FOLDER_NAME };
