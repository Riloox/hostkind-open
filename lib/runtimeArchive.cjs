'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function zipCentralDir(fd, size) {
  const tail = Math.min(size, 65557);
  const buf = Buffer.alloc(tail);
  fs.readSync(fd, buf, 0, tail, size - tail);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip end-of-central-directory record not found');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOff = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipReadEntry(fd, rec) {
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, rec.localOff);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`invalid zip local header for ${rec.name}`);
  const dataOff = rec.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const comp = Buffer.alloc(rec.compSize);
  fs.readSync(fd, comp, 0, rec.compSize, dataOff);
  if (rec.method === 0) return comp;
  if (rec.method === 8) return zlib.inflateRawSync(comp);
  throw new Error(`unsupported zip compression method ${rec.method} for ${rec.name}`);
}

function safeZipTarget(destDir, name) {
  const normalizedName = String(name || '').replace(/\\/g, '/');
  if (!normalizedName || normalizedName.startsWith('/') || /^[A-Za-z]:\//.test(normalizedName)) return null;
  const out = path.resolve(destDir, ...normalizedName.split('/').filter(Boolean));
  const root = path.resolve(destDir);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (out !== root && !out.startsWith(rootWithSep)) return null;
  return out;
}

function extractZip(archive, destDir) {
  let fd;
  try {
    const size = fs.statSync(archive).size;
    fd = fs.openSync(archive, 'r');
    for (const rec of zipCentralDir(fd, size)) {
      const target = safeZipTarget(destDir, rec.name);
      if (!target) continue;
      if (rec.name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      const data = zipReadEntry(fd, rec);
      if (rec.uncompSize !== 0xffffffff && data.length !== rec.uncompSize) {
        throw new Error(`zip entry size mismatch for ${rec.name}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/*
 * GNU tar - the tar first on PATH on any Windows box with Git for Windows
 * installed - reads the `-f` operand as `[user@]host:path`, so an absolute
 * `C:\...` archive sends it looking for a network host named `C` and it exits
 * 128 with "Cannot connect to C: resolve failed". Naming the archive by
 * basename from its own directory keeps the colon out of that operand, which
 * GNU tar and the bsdtar Windows ships both accept. Only `-f` is parsed this
 * way, so other path arguments can stay absolute.
 */
function tarInvocation(archive) {
  return { name: path.basename(archive), cwd: path.dirname(path.resolve(archive)) };
}

function extractRuntimeArchive(archive, destDir, ext) {
  if (ext === 'zip') {
    extractZip(archive, destDir);
    return;
  }
  const tar = tarInvocation(archive);
  const target = path.resolve(destDir);
  const tarArgs = ext === 'tar.gz' ? ['-xzf', tar.name, '-C', target] : ['-xf', tar.name, '-C', target];
  const ex = spawnSync('tar', tarArgs, { encoding: 'utf8', cwd: tar.cwd });
  if (ex.error || ex.status !== 0) {
    throw new Error(`Could not extract Java runtime (tar): ${ex.error ? ex.error.message : (ex.stderr || ('exit ' + ex.status))}`);
  }
}

module.exports = {
  extractRuntimeArchive,
  extractZip,
  safeZipTarget,
  tarInvocation,
};
