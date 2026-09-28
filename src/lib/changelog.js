// Which build's changelog this browser has seen, so the profile menu can mark
// "What's new" as unread after an update. The changelog never opens by itself.

const VERSION_KEY = 'fleetdeck_changelog_version';

// Keep reading the pre-dialog marker so an existing install does not lose its
// update history when the touring what's-new experience is replaced.
const LEGACY_VERSION_KEY = 'fleetdeck_tour_version';

// Desktop launches can use a different loopback port each time. Cookies are
// host-scoped, unlike localStorage, so keep the version there as well; the
// localStorage fallback preserves state from older browser installs.
function readVersionCookie(key) {
  const prefix = `${key}=`;
  try {
    const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) || null : null;
  } catch {
    return null;
  }
}

function readChangelogVersion() {
  for (const key of [VERSION_KEY, LEGACY_VERSION_KEY]) {
    const cookieVersion = readVersionCookie(key);
    if (cookieVersion) return cookieVersion;
    try {
      const storageVersion = localStorage.getItem(key);
      if (storageVersion) return storageVersion;
    } catch {}
  }
  return null;
}

function writeChangelogVersion(v) {
  const value = String(v || '');
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  for (const key of [VERSION_KEY, LEGACY_VERSION_KEY]) {
    try { localStorage.setItem(key, value); } catch {}
    try {
      document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch {}
  }
}

// Current build version injected by Vite's define (guarded for SSR/build contexts).
export function currentAppVersion() {
  try { return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''; }
  catch { return ''; }
}

/**
 * True when this browser last saw another build's changelog. A browser that
 * has seen none is a fresh install: nothing is new to it, so it starts from
 * the current build instead of showing the dot.
 */
export function changelogUnread() {
  const version = currentAppVersion();
  if (!version) return false;
  const seen = readChangelogVersion();
  if (!seen) {
    writeChangelogVersion(version);
    return false;
  }
  return seen !== version;
}

export function markChangelogRead() {
  const version = currentAppVersion();
  if (version) writeChangelogVersion(version);
}
