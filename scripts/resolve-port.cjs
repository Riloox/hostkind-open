'use strict';

/*
 * Hostkind - effective panel-port resolver (single source of truth).
 *
 * Precedence (must match server.js and vite.config.js):
 *   FLEETDECK_PORT > LODESTONE_PORT > config.json panelPort > 2121.
 *
 * CLI: prints the port on stdout and nothing else, always exits 0 so that
 * `for /f` (batch) and `$(...)` (bash) never capture an empty value:
 *
 *   node scripts/resolve-port.cjs [configPath]
 *
 * The optional configPath defaults to $FLEETDECK_CONFIG, else config.json
 * beside the repo root. Any failure (missing file, invalid JSON, ...) falls
 * back to 2121.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 2121;

function toValidPort(value) {
  const port = Number(String(value ?? '').trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function defaultConfigPath() {
  if (process.env.FLEETDECK_CONFIG) return path.resolve(process.env.FLEETDECK_CONFIG);
  return path.join(__dirname, '..', 'config.json');
}

function resolvePanelPort(configPath) {
  const fromEnv = toValidPort(process.env.FLEETDECK_PORT)
    ?? toValidPort(process.env.LODESTONE_PORT);
  if (fromEnv !== null) return fromEnv;
  const file = configPath || defaultConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) { /* missing/unreadable config: use the default */ return DEFAULT_PORT; }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // A corrupt config is almost certainly a real problem (a half-written
    // save, a merge conflict), so say so on stderr instead of silently
    // falling back to 2121 and splitting the panel across two ports.
    console.warn(`resolve-port: ignoring invalid JSON in ${file} (${err.message}); using default ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  const parsed = toValidPort(data && typeof data === 'object' ? data.panelPort : undefined);
  if (parsed !== null) return parsed;
  return DEFAULT_PORT;
}

module.exports = { resolvePanelPort, DEFAULT_PORT };

if (require.main === module) {
  process.stdout.write(`${resolvePanelPort(process.argv[2])}\n`);
}
