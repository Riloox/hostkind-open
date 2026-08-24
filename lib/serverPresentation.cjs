'use strict';

/*
 * Panel-local server presentation
 * (docs/palworld/07-portability-safety.md "Server presentation").
 *
 * Spec contract:
 *   - "Allow an optional Hostkind-local profile icon, banner, and accent
 *      chosen from uploaded assets. These are panel presentation only and must
 *      not be confused with in-game server identity."
 *   - "Validate file type/dimensions/size, strip metadata where practical,
 *      store outside the game root, and provide reset/default behavior."
 *
 * Uploaded images are decoded far enough to prove they are what they claim -
 * magic bytes plus a real dimension header - and then rewritten with every
 * metadata container dropped. Nothing here re-encodes pixels: stripping
 * ancillary chunks/segments removes EXIF (including GPS), XMP, colour profiles,
 * and comments while leaving the image itself byte-identical.
 *
 * Assets live under the Hostkind data directory, never inside a server folder:
 * a game update, a profile export, or a "move files to trash" must not be able
 * to take the panel's own presentation with it.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./db.cjs');

const KINDS = Object.freeze({
  icon: { id: 'icon', maxBytes: 2 * 1024 * 1024, maxWidth: 1024, maxHeight: 1024, minWidth: 16, minHeight: 16 },
  banner: { id: 'banner', maxBytes: 6 * 1024 * 1024, maxWidth: 3840, maxHeight: 1440, minWidth: 240, minHeight: 60 },
});
const ACCENT_RE = /^#(?:[0-9a-f]{6})$/i;

function fail(message, status = 400, code = 'presentation_error') {
  throw Object.assign(new Error(message), { status, code });
}

function root(serverId) {
  const id = String(serverId || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!id) fail('A server id is required.', 400, 'invalid_server');
  return path.join(dataDir(), 'presentation', id);
}

// --- format detection ------------------------------------------------------

function detect(buffer) {
  if (buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { format: 'png', ext: '.png', mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = jpegSize(buffer);
    return size ? { format: 'jpeg', ext: '.jpg', mime: 'image/jpeg', ...size } : null;
  }
  if (buffer.length > 30 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const size = webpSize(buffer);
    return size ? { format: 'webp', ext: '.webp', mime: 'image/webp', ...size } : null;
  }
  return null;
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15 except the non-frame markers carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && buffer.length > 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && buffer.length > 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// --- metadata stripping ----------------------------------------------------

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);

function stripPng(buffer) {
  const out = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > buffer.length) fail('That PNG file is truncated.', 400, 'invalid_image');
    if (PNG_KEEP.has(type)) out.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function stripJpeg(buffer) {
  const out = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) fail('That JPEG file is malformed.', 400, 'invalid_image');
    const marker = buffer[offset + 1];
    if (marker === 0xda) { out.push(buffer.subarray(offset)); break; } // start of scan: the rest is image data
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (end > buffer.length) fail('That JPEG file is truncated.', 400, 'invalid_image');
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(buffer.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(out);
}

const WEBP_DROP = new Set(['EXIF', 'XMP ', 'ICCP']);

function stripWebp(buffer) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('latin1');
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length + 1) fail('That WebP file is truncated.', 400, 'invalid_image');
    if (!WEBP_DROP.has(type)) chunks.push(buffer.subarray(offset, Math.min(end, buffer.length)));
    offset = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

function strip(format, buffer) {
  if (format === 'png') return stripPng(buffer);
  if (format === 'jpeg') return stripJpeg(buffer);
  return stripWebp(buffer);
}

// --- state -----------------------------------------------------------------

function metaPath(serverId) {
  return path.join(root(serverId), 'presentation.json');
}

function readMeta(serverId) {
  try { return JSON.parse(fs.readFileSync(metaPath(serverId), 'utf8')); } catch { return {}; }
}

function writeMeta(serverId, meta) {
  fs.mkdirSync(root(serverId), { recursive: true });
  fs.writeFileSync(metaPath(serverId), JSON.stringify(meta, null, 2));
  return meta;
}

function get(serverId) {
  const meta = readMeta(serverId);
  const asset = (kind) => {
    const entry = meta[kind];
    if (!entry || !entry.file) return null;
    const file = path.join(root(serverId), path.basename(entry.file));
    if (!fs.existsSync(file)) return null;
    return {
      kind,
      format: entry.format,
      mime: entry.mime,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      updatedAt: entry.updatedAt,
    };
  };
  return {
    ok: true,
    icon: asset('icon'),
    banner: asset('banner'),
    accent: ACCENT_RE.test(String(meta.accent || '')) ? meta.accent : null,
    // Presentation is panel-only. The UI repeats this so nobody mistakes it
    // for the name or identity players see in-game.
    scope: 'panel-only',
  };
}

function assetFile(serverId, kind) {
  const meta = readMeta(serverId);
  const entry = meta[String(kind)];
  if (!entry || !entry.file) fail('That asset is not set.', 404, 'not_found');
  const file = path.join(root(serverId), path.basename(entry.file));
  if (!fs.existsSync(file)) fail('That asset is not set.', 404, 'not_found');
  return { file, mime: entry.mime, bytes: entry.bytes };
}

function setAsset({ serverId, kind, buffer }) {
  const spec = KINDS[String(kind)];
  if (!spec) fail('Unsupported presentation asset.', 400, 'invalid_kind');
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('Upload an image file.', 400, 'empty_upload');
  if (buffer.length > spec.maxBytes) fail(`That image is larger than ${Math.round(spec.maxBytes / 1048576)} MB.`, 413, 'too_large');
  const detected = detect(buffer);
  if (!detected) fail('Upload a PNG, JPEG, or WebP image.', 415, 'unsupported_type');
  if (!Number.isInteger(detected.width) || !Number.isInteger(detected.height) || detected.width < 1 || detected.height < 1) {
    fail('That image has no readable dimensions.', 400, 'invalid_image');
  }
  if (detected.width > spec.maxWidth || detected.height > spec.maxHeight) {
    fail(`That image is larger than ${spec.maxWidth}x${spec.maxHeight}.`, 400, 'dimensions_too_large');
  }
  if (detected.width < spec.minWidth || detected.height < spec.minHeight) {
    fail(`That image is smaller than ${spec.minWidth}x${spec.minHeight}.`, 400, 'dimensions_too_small');
  }
  const stripped = strip(detected.format, buffer);
  if (!detect(stripped)) fail('The image could not be rewritten safely.', 500, 'strip_failed');

  const meta = readMeta(serverId);
  const previous = meta[spec.id]?.file;
  const file = `${spec.id}${detected.ext}`;
  fs.mkdirSync(root(serverId), { recursive: true });
  fs.writeFileSync(path.join(root(serverId), file), stripped);
  if (previous && previous !== file) fs.rmSync(path.join(root(serverId), path.basename(previous)), { force: true });
  meta[spec.id] = {
    file,
    format: detected.format,
    mime: detected.mime,
    width: detected.width,
    height: detected.height,
    bytes: stripped.length,
    updatedAt: new Date().toISOString(),
  };
  writeMeta(serverId, meta);
  return get(serverId);
}

function setAccent({ serverId, accent }) {
  const meta = readMeta(serverId);
  if (accent === null || accent === '' || accent === undefined) delete meta.accent;
  else if (!ACCENT_RE.test(String(accent))) fail('Enter a colour as #rrggbb.', 400, 'invalid_accent');
  else meta.accent = String(accent).toLowerCase();
  writeMeta(serverId, meta);
  return get(serverId);
}

function clearAsset({ serverId, kind }) {
  const spec = KINDS[String(kind)];
  if (!spec) fail('Unsupported presentation asset.', 400, 'invalid_kind');
  const meta = readMeta(serverId);
  const entry = meta[spec.id];
  if (entry?.file) fs.rmSync(path.join(root(serverId), path.basename(entry.file)), { force: true });
  delete meta[spec.id];
  writeMeta(serverId, meta);
  return get(serverId);
}

/* Reset to Hostkind defaults: no icon, no banner, no accent. */
function reset(serverId) {
  fs.rmSync(root(serverId), { recursive: true, force: true });
  return get(serverId);
}

module.exports = {
  KINDS,
  ACCENT_RE,
  detect,
  strip,
  get,
  assetFile,
  setAsset,
  setAccent,
  clearAsset,
  reset,
};
