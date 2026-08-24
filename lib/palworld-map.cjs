'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const ASSET_TYPES = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
});

// Hostkind ships its own Palworld world map so the live map works with zero
// setup (see docs/game-assets.md). Servers that never touch calibration fall
// back to this asset and these bounds; uploading a custom image replaces both.
const BUILTIN_FILE = path.join(__dirname, '..', 'resources', 'maps', 'palworld-world.png');
const BUILTIN_ASSET = Object.freeze({
  source: 'Hostkind built-in',
  author: 'Hostkind',
  license: 'Bundled with Hostkind',
  version: 'fleetdeck-palpagos-3',
  mediaType: 'image/png',
});

// Palworld shows players a +/-1000 grid on its own map rather than the raw
// Unreal coordinates the REST API reports. The grid centres on this world point
// and steps 459 world units per grid unit; because the map runs east along
// world Y and north along world X, its pair reads (y, x). Derived from the
// published save-file min/max (https://github.com/palworldlol/palworld-coord).
const GRID_ORIGIN = Object.freeze({ x: -123888, y: 158000 });
const GRID_STEP = 459;
const GRID_RADIUS = 1000;

// The whole grid, which is the whole world: 918000 units on each axis.
const DEFAULT_BOUNDS = Object.freeze({
  minX: GRID_ORIGIN.x - GRID_STEP * GRID_RADIUS,
  maxX: GRID_ORIGIN.x + GRID_STEP * GRID_RADIUS,
  minY: GRID_ORIGIN.y - GRID_STEP * GRID_RADIUS,
  maxY: GRID_ORIGIN.y + GRID_STEP * GRID_RADIUS,
});

let builtinChecksum = null;

function error(message, status = 400, code = 'invalid_map') {
  const value = new Error(message);
  value.status = status;
  value.code = code;
  return value;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw error(`${label} must be a finite number.`);
  return number;
}

function normalizeBounds(value) {
  const bounds = {
    minX: finite(value?.minX, 'Minimum X'),
    maxX: finite(value?.maxX, 'Maximum X'),
    minY: finite(value?.minY, 'Minimum Y'),
    maxY: finite(value?.maxY, 'Maximum Y'),
  };
  if (bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
    throw error('Map bounds must have a positive width and height.');
  }
  return bounds;
}

function revisionOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || null)).digest('hex').slice(0, 24);
}

function checksumOf(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function builtinAsset() {
  if (!builtinChecksum) builtinChecksum = checksumOf(fs.readFileSync(BUILTIN_FILE));
  return { ...BUILTIN_ASSET, checksum: builtinChecksum, builtin: true, file: BUILTIN_FILE };
}

// The bundled artwork is a square canvas that frames the whole world square, so
// it needs no content rect: bounds cover the entire image. Only a custom upload
// whose artwork is letterboxed inside that square carries one.
function defaultCalibration() {
  return { assetVersion: BUILTIN_ASSET.version, bounds: { ...DEFAULT_BOUNDS } };
}

// A stored asset of `null` (never calibrated) or `{ builtin: true }` (reset to
// the bundled map) both resolve to the built-in asset. The absolute path is
// never persisted so configs stay portable between machines.
function resolveAsset(stored) {
  if (!stored || stored.builtin) return builtinAsset();
  return stored;
}

function publicAsset(server, asset) {
  return {
    source: asset.source,
    author: asset.author,
    license: asset.license,
    version: asset.version,
    checksum: asset.checksum,
    mediaType: asset.mediaType,
    builtin: !!asset.builtin,
    url: `/api/palworld/map/asset?serverId=${encodeURIComponent(server.id)}&v=${encodeURIComponent(asset.checksum)}`,
  };
}

function publicState(server) {
  const state = server.palworldMap || {};
  const asset = resolveAsset(state.asset);
  // A stored calibration names the asset it was aligned against; once the
  // bundled map is replaced - or, as in palpagos-3, the projection it was
  // measured against changes - that calibration is stale and projecting with it
  // would put markers in the wrong place. Fall back to the current defaults;
  // the old calibration survives in the stored state so a later upload of the
  // matching asset still has its bounds.
  const calibration = state.calibration && state.calibration.assetVersion === asset.version
    ? state.calibration
    : defaultCalibration();
  return {
    asset: publicAsset(server, asset),
    calibration,
    isDefault: !state.asset && !state.calibration,
    defaults: { bounds: { ...DEFAULT_BOUNDS } },
    revision: revisionOf({ asset: state.asset || null, calibration: state.calibration || null }),
    previousRevision: state.previous ? revisionOf(state.previous) : null,
  };
}

// Resolves what /api/palworld/map/asset should stream. Custom uploads stay
// inside the server's own .fleetdeck folder; the built-in map lives in the
// panel's resources folder and is exempt from that containment check.
function assetFile(server) {
  const asset = resolveAsset((server.palworldMap || {}).asset);
  if (asset.builtin) return { file: BUILTIN_FILE, mediaType: BUILTIN_ASSET.mediaType, builtin: true };
  if (!asset.file) return null;
  return { file: asset.file, mediaType: asset.mediaType, builtin: false };
}

function decodeAsset(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match || !ASSET_TYPES[match[1].toLowerCase()]) {
    throw error('Choose a PNG, JPEG, or WebP map image.');
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_ASSET_BYTES) {
    throw error('Map images must be 16 MB or smaller.');
  }
  return { buffer, mediaType: match[1].toLowerCase(), extension: ASSET_TYPES[match[1].toLowerCase()] };
}

// The letterbox band an asset's artwork occupies inside the padded square it is
// served as, in normalized coordinates. Absent = the whole image (legacy).
function normalizeContentRect(value) {
  if (value === undefined || value === null) return undefined;
  const rect = {
    u0: finite(value?.u0, 'Content rect u0'),
    v0: finite(value?.v0, 'Content rect v0'),
    u1: finite(value?.u1, 'Content rect u1'),
    v1: finite(value?.v1, 'Content rect v1'),
  };
  for (const key of ['u0', 'v0', 'u1', 'v1']) {
    if (rect[key] < 0 || rect[key] > 1) throw error(`${key} must be between 0 and 1.`);
  }
  if (rect.u0 >= rect.u1 || rect.v0 >= rect.v1) {
    throw error('Content rect must have a positive width and height.');
  }
  return rect;
}

function preview(server, body) {
  const current = publicState(server);
  if (String(body?.revision || '') !== current.revision) {
    throw error('The map changed since it was opened. Reload and try again.', 409, 'revision_conflict');
  }
  const bounds = normalizeBounds(body?.bounds);
  const hasUpload = !!body?.assetData;
  const decoded = hasUpload ? decodeAsset(body.assetData) : null;
  let asset;
  if (decoded) {
    const metadata = body?.asset || {};
    const checksum = checksumOf(decoded.buffer);
    asset = {
      source: String(metadata.source || '').trim() || 'Administrator upload',
      author: String(metadata.author || '').trim(),
      license: String(metadata.license || '').trim(),
      // The asset version keys the calibration, so derive a stable one from the
      // image itself when the admin does not name a version.
      version: String(metadata.version || '').trim() || `custom-${checksum.slice(7, 19)}`,
      checksum,
      mediaType: decoded.mediaType,
      builtin: false,
    };
  } else {
    asset = { ...current.asset };
    delete asset.url;
  }
  // An upload carries its own content rect (derived from the image's intrinsic
  // aspect by the dialog); a bounds-only edit keeps the stored asset's rect.
  const contentRect = hasUpload ? normalizeContentRect(body?.contentRect) : current.calibration?.contentRect;
  const calibration = {
    assetVersion: asset.version,
    bounds,
  };
  if (contentRect) calibration.contentRect = contentRect;
  const previewToken = revisionOf({ revision: current.revision, asset, calibration });
  return { ok: true, asset, calibration, revision: current.revision, previewToken, _decoded: decoded };
}

function apply(server, body) {
  const result = preview(server, body);
  if (!body?.previewToken || body.previewToken !== result.previewToken) {
    throw error('Preview these exact map changes before saving.', 409, 'preview_required');
  }
  const current = server.palworldMap || {};
  let storedAsset = current.asset || null;
  if (result._decoded) {
    const directory = path.join(server.dir, '.fleetdeck', 'palworld-map');
    fs.mkdirSync(directory, { recursive: true });
    const filename = `map-${result.asset.checksum.slice(7, 23)}${result._decoded.extension}`;
    const target = path.join(directory, filename);
    fs.writeFileSync(target, result._decoded.buffer);
    storedAsset = { ...result.asset, file: target };
  } else if (!storedAsset) {
    storedAsset = { builtin: true };
  }
  server.palworldMap = {
    asset: storedAsset,
    calibration: result.calibration,
    previous: current.asset || current.calibration
      ? { asset: current.asset || null, calibration: current.calibration || null }
      : null,
  };
  return publicState(server);
}

// Drops any custom image and calibration so the server goes back to the bundled
// map and default bounds, keeping the change reversible like a normal save.
function resetToDefault(server) {
  const current = server.palworldMap || {};
  server.palworldMap = {
    asset: { builtin: true },
    calibration: defaultCalibration(),
    previous: current.asset || current.calibration
      ? { asset: current.asset || null, calibration: current.calibration || null }
      : null,
  };
  return publicState(server);
}

function restore(server, revision) {
  const state = server.palworldMap;
  if (!state?.previous || revision !== revisionOf(state.previous)) {
    throw error('The saved map revision is no longer available.', 409, 'revision_conflict');
  }
  const current = { asset: state.asset || null, calibration: state.calibration || null };
  server.palworldMap = { ...state.previous, previous: current };
  return publicState(server);
}

// The coordinate pair the game itself puts on screen, so an admin can read a
// position out to a player and have it match the map the player is looking at.
// Unlike `project` this owes nothing to calibration: the grid is the game's,
// not the panel's, and a custom map image does not move it.
function grid(location) {
  const x = Number(location?.x);
  const y = Number(location?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.round((y - GRID_ORIGIN.y) / GRID_STEP),
    y: Math.round((x - GRID_ORIGIN.x) / GRID_STEP),
  };
}

function project(location, calibration) {
  if (!location || !calibration?.bounds) return null;
  const x = Number(location.x);
  const y = Number(location.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const bounds = normalizeBounds(calibration.bounds);
  // Palworld's map is a quarter turn away from the world the REST API reports:
  // the map runs east along world Y and north along world X (which is why the
  // game's own grid reads (y, x), not (x, y)). Feeding x into the horizontal
  // axis put every marker in the wrong quadrant.
  let u = (y - bounds.minY) / (bounds.maxY - bounds.minY);
  let v = 1 - ((x - bounds.minX) / (bounds.maxX - bounds.minX));
  const rect = calibration.contentRect;
  if (rect) {
    u = rect.u0 + u * (rect.u1 - rect.u0);
    v = rect.v0 + v * (rect.v1 - rect.v0);
  }
  return { u, v, inBounds: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

module.exports = {
  DEFAULT_BOUNDS,
  GRID_ORIGIN,
  GRID_STEP,
  MAX_ASSET_BYTES,
  apply,
  assetFile,
  defaultCalibration,
  grid,
  preview,
  project,
  publicState,
  resetToDefault,
  restore,
  revisionOf,
};
