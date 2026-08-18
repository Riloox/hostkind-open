import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function fmtBytes(b) {
  if (b == null) return '-';
  const mb = b / 1048576;
  if (mb < 1024) return mb.toFixed(0) + ' MB';
  return (mb / 1024).toFixed(1) + ' GB';
}

export function fmtUptime(ms) {
  if (!ms) return '';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h || d) parts.push(h + 'h');
  parts.push(m + 'm');
  return parts.join(' ');
}

export function fmtBytesRaw(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

export function fmtMB(mb) {
  if (mb == null) return '-';
  if (mb < 1024) return Math.round(mb) + ' MB';
  return (mb / 1024).toFixed(1) + ' GB';
}

// Decode a JWT's payload without verifying it - the signature is the server's
// business; the client only reads the claims it already trusts itself to act on
// (expiry, subject). Returns null for anything that isn't a well-formed token.
export function decodeJwt(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function isJwtExpired(jwt) {
  const payload = decodeJwt(jwt);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp * 1000 <= Date.now();
}

// The user id the token was issued for. Available synchronously on boot, well
// before `/api/me` resolves, which is what lets us restore per-user UI state on
// the very first render instead of flashing a default first.
export function jwtSubject(jwt) {
  const sub = decodeJwt(jwt)?.sub;
  return typeof sub === 'string' && sub ? sub : '';
}

// Best-effort guess of the OS the browser is running on, so path examples in
// the UI look native (Windows backslashes vs. POSIX slashes) instead of always
// showing a Windows path. Falls back to Linux-style when unsure.
export function detectOs() {
  const p = (
    (typeof navigator !== 'undefined' &&
      (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) || ''
  ).toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'mac';
  return 'linux';
}

// Example filesystem path for the current OS. `kind` is 'parent' (a folder to
// create a server inside) or 'server' (a specific server folder).
export function osExamplePath(kind = 'parent') {
  const os = detectOs();
  if (os === 'windows') {
    return kind === 'server' ? 'C:\\Servers\\My Server' : 'C:\\Servers';
  }
  if (os === 'mac') {
    return kind === 'server' ? '/Users/you/Servers/My Server' : '/Users/you/Servers';
  }
  return kind === 'server' ? '/home/you/servers/my-server' : '/home/you/servers';
}

export function joinRel(base, name) {
  return base ? base + '/' + name : name;
}

export function joinPath(base, name, sep = '/') {
  if (!base) return name;
  return base.replace(/[\\/]+$/, '') + sep + name;
}
