'use strict';

/*
 * CLI profiles and local panel discovery.
 *
 * The CLI never reads the panel's config.json for secrets. It uses it only to
 * find the local panel port and the one-time first-run password, so a fresh
 * install can be driven without copying a password between terminals.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE_DEFAULT = 'default';

function configDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Hostkind');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'hostkind');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'hostkind');
}

function configPath() {
  return process.env.HOSTKIND_CLI_CONFIG
    ? path.resolve(process.env.HOSTKIND_CLI_CONFIG)
    : path.join(configDir(), 'cli.json');
}

function emptyConfig() {
  return {
    version: 1,
    defaultProfile: PROFILE_DEFAULT,
    profiles: {},
  };
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {
    version: 1,
    defaultProfile: typeof cfg.defaultProfile === 'string' && cfg.defaultProfile ? cfg.defaultProfile : PROFILE_DEFAULT,
    profiles: cfg.profiles && typeof cfg.profiles === 'object' && !Array.isArray(cfg.profiles) ? cfg.profiles : {},
  };
  for (const [name, profile] of Object.entries(out.profiles)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      delete out.profiles[name];
      continue;
    }
    out.profiles[name] = {
      url: typeof profile.url === 'string' ? profile.url : undefined,
      token: typeof profile.token === 'string' ? profile.token : undefined,
      apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : undefined,
      server: typeof profile.server === 'string' ? profile.server : undefined,
      username: typeof profile.username === 'string' ? profile.username : undefined,
    };
  }
  return out;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyConfig();
    if (err && err.name === 'SyntaxError') {
      throw Object.assign(new Error(`The CLI config at ${configPath()} is not valid JSON.`), { code: 'cli_config_invalid' });
    }
    throw err;
  }
}

function saveConfig(cfg) {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(normalizeConfig(cfg), null, 2);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ignores POSIX modes */ }
  return file;
}

function selectedProfileName(cfg, flags = {}) {
  return String(flags.profile || process.env.HOSTKIND_PROFILE || cfg.defaultProfile || PROFILE_DEFAULT);
}

function getProfile(cfg, name) {
  return cfg.profiles && cfg.profiles[name] ? cfg.profiles[name] : {};
}

function setProfile(cfg, name, patch) {
  const current = getProfile(cfg, name);
  cfg.profiles[name] = { ...current, ...patch };
  for (const key of Object.keys(cfg.profiles[name])) {
    if (cfg.profiles[name][key] === undefined || cfg.profiles[name][key] === null || cfg.profiles[name][key] === '') {
      delete cfg.profiles[name][key];
    }
  }
  return cfg.profiles[name];
}

function removeProfile(cfg, name) {
  const existed = !!cfg.profiles[name];
  delete cfg.profiles[name];
  if (cfg.defaultProfile === name) {
    cfg.defaultProfile = Object.keys(cfg.profiles)[0] || PROFILE_DEFAULT;
  }
  return existed;
}

function localPanelConfigPath() {
  const candidates = [];
  if (process.env.FLEETDECK_CONFIG) candidates.push(path.resolve(process.env.FLEETDECK_CONFIG));
  if (process.env.HOSTKIND_CONFIG) candidates.push(path.resolve(process.env.HOSTKIND_CONFIG));
  candidates.push(path.resolve(process.cwd(), 'config.json'));
  candidates.push(path.resolve(__dirname, '..', 'config.json'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function localPanelInfo() {
  const file = localPanelConfigPath();
  if (!file) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawPort = Number(cfg.panelPort);
    const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 2121;
    const host = cfg.panelHost && cfg.panelHost !== '0.0.0.0' && cfg.panelHost !== '::' ? cfg.panelHost : '127.0.0.1';
    return { file, dir: path.dirname(file), port, host };
  } catch (_) {
    return { file, dir: path.dirname(file), port: 2121, host: '127.0.0.1' };
  }
}

function localInitialPassword() {
  const info = localPanelInfo();
  if (!info) return null;
  try {
    const raw = fs.readFileSync(path.join(info.dir, 'initial-admin-password.txt'), 'utf8');
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } catch (_) {
    return null;
  }
}

function resolveUrl(flags, cfg, profileName) {
  const profile = getProfile(cfg, profileName);
  let raw = flags.url || process.env.HOSTKIND_URL || profile.url;
  if (!raw) {
    const info = localPanelInfo();
    const port = process.env.FLEETDECK_PORT || process.env.LODESTONE_PORT || (info && info.port) || 2121;
    const host = info && info.host ? info.host : '127.0.0.1';
    raw = `http://${host}:${port}`;
  }
  raw = String(raw).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return raw.replace(/\/+$/, '');
}

function resolveCredentials(flags, cfg, profileName) {
  const profile = getProfile(cfg, profileName);
  const apiKey = flags['api-key'] || process.env.HOSTKIND_API_KEY || profile.apiKey || null;
  const token = flags.token || process.env.HOSTKIND_TOKEN || profile.token || null;
  // An explicit --api-key wins over a stored JWT, and vice versa. Never send both.
  if (apiKey) return { auth: apiKey, type: 'api-key' };
  if (token) return { auth: token, type: 'token' };
  return { auth: null, type: null };
}

function resolveServer(flags, cfg, profileName) {
  const profile = getProfile(cfg, profileName);
  return flags.server || process.env.HOSTKIND_SERVER || profile.server || null;
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function publicProfile(profile) {
  return {
    url: profile.url || null,
    server: profile.server || null,
    username: profile.username || null,
    token: profile.token ? maskSecret(profile.token) : null,
    apiKey: profile.apiKey ? maskSecret(profile.apiKey) : null,
  };
}

module.exports = {
  PROFILE_DEFAULT,
  configDir,
  configPath,
  loadConfig,
  saveConfig,
  selectedProfileName,
  getProfile,
  setProfile,
  removeProfile,
  localPanelConfigPath,
  localPanelInfo,
  localInitialPassword,
  resolveUrl,
  resolveCredentials,
  resolveServer,
  maskSecret,
  publicProfile,
  emptyConfig,
};
