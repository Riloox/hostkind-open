'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SELECTION = 200;
const JAR_NAME = /^[^\\/]+\.jar$/i;

class AddonStateError extends Error {
  constructor(message, status = 400, code = 'addon_state_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jarName(value) {
  const name = String(value || '');
  if (!name || path.basename(name) !== name || !JAR_NAME.test(name)) {
    throw new AddonStateError('Only .jar addon names can be selected.', 400, 'invalid_addon_name');
  }
  return name;
}

function regularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function listFolder(dir, enabled) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && JAR_NAME.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, size: stat.size, mtime: stat.mtimeMs, enabled };
    });
}

function list({ activeDir, disabledDir } = {}) {
  const active = listFolder(activeDir, true);
  const disabled = listFolder(disabledDir, false);
  const byName = new Map();
  for (const item of [...active, ...disabled]) {
    const previous = byName.get(item.name);
    if (!previous) byName.set(item.name, item);
    else byName.set(item.name, { ...previous, conflict: true });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function selectionNames(names) {
  if (!Array.isArray(names)) throw new AddonStateError('Select at least one addon.', 400, 'selection_required');
  const unique = [...new Set(names.map(jarName))];
  if (!unique.length) throw new AddonStateError('Select at least one addon.', 400, 'selection_required');
  if (unique.length > MAX_SELECTION) throw new AddonStateError(`Select no more than ${MAX_SELECTION} addons at once.`, 400, 'selection_too_large');
  return unique;
}

function setEnabled({ activeDir, disabledDir, names, enabled }) {
  if (typeof enabled !== 'boolean') throw new AddonStateError('enabled must be a boolean.', 400, 'invalid_enabled');
  const selected = selectionNames(names);
  const moves = [];
  for (const name of selected) {
    const active = path.join(activeDir, name);
    const disabled = path.join(disabledDir, name);
    const activeExists = regularFile(active);
    const disabledExists = regularFile(disabled);
    if (activeExists && disabledExists) throw new AddonStateError(`Both active and disabled copies of ${name} exist.`, 409, 'addon_conflict');
    if (enabled === true) {
      if (activeExists) continue;
      if (!disabledExists) throw new AddonStateError(`${name} is not installed.`, 404, 'addon_not_found');
      moves.push({ name, from: disabled, to: active });
    } else {
      if (disabledExists) continue;
      if (!activeExists) throw new AddonStateError(`${name} is not installed.`, 404, 'addon_not_found');
      moves.push({ name, from: active, to: disabled });
    }
  }

  fs.mkdirSync(enabled === true ? activeDir : disabledDir, { recursive: true });
  const completed = [];
  try {
    for (const move of moves) {
      if (fs.existsSync(move.to)) throw new AddonStateError(`${move.name} already exists in the destination folder.`, 409, 'addon_conflict');
      fs.renameSync(move.from, move.to);
      completed.push(move);
    }
  } catch (error) {
    let rollbackOk = true;
    for (const move of completed.reverse()) {
      try {
        if (fs.existsSync(move.to) && !fs.existsSync(move.from)) fs.renameSync(move.to, move.from);
      } catch {
        rollbackOk = false;
      }
    }
    if (!rollbackOk) throw new AddonStateError('Addon state could not be restored after a failed batch.', 500, 'recovery_required');
    throw error;
  }

  return { ok: true, enabled: enabled === true, changed: moves.map((move) => move.name), restartRequired: moves.length > 0 };
}

function disabledDir(serverDir, kind) {
  const safeKind = String(kind).toLowerCase() === 'mods' ? 'mods' : 'plugins';
  return path.join(serverDir, '.hostkind', 'disabled', safeKind);
}

module.exports = { MAX_SELECTION, AddonStateError, disabledDir, list, setEnabled };
