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
  try {
    const raw = fs.readFileSync(configPath || defaultConfigPath(), 'utf8');
    const parsed = toValidPort(JSON.parse(raw).panelPort);
    if (parsed !== null) return parsed;
  } catch (_) { /* missing/unreadable config: use the default */ }
  return DEFAULT_PORT;
}

module.exports = { resolvePanelPort, DEFAULT_PORT };

if (require.main === module) {
  process.stdout.write(`${resolvePanelPort(process.argv[2])}\n`);
}
