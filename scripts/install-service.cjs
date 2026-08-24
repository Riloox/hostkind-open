'use strict';

/*
 * Install the panel as an OS service so it comes back after a reboot.
 *
 * Nothing in the panel auto-starts: `server.js` re-adopts live server
 * processes on boot (see `adoptOrphans`), but the panel itself has to be
 * launched. This script creates the autostart entry:
 *
 *   Linux   a systemd unit, enabled with systemctl
 *   Windows a Task Scheduler task (schtasks) that runs at user logon
 *
 * The unit/task runs `node server.js` directly (the npm `start` script is
 * exactly that, minus the prestart build guard, which a service must not
 * fail on), with the working directory pinned to the install folder and
 * FLEETDECK_CONFIG forwarded when set, so relative paths in the config
 * resolve exactly as they do for `npm start`.
 *
 * Usage:
 *   node scripts/install-service.cjs [--name hostkind] [--user <unix user>]
 *
 * The generator functions are exported so test/service-wrappers.test.cjs can
 * assert the exact unit/task content without executing anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_NAME = 'hostkind';

// The unit/task needs the same Node that runs this script, so an operator
// using a version manager gets a service that starts with the version they
// actually tested with. Falls back to the PATH lookup at runtime.
function resolveNodePath() {
  return process.execPath || 'node';
}

// The install dir is the repo root, detected from this script's location so a
// relocated checkout re-registers its own path.
function detectInstallDir() {
  return path.resolve(__dirname, '..');
}

function serviceName(name) {
  // schtasks task names may not contain slashes or backslashes; systemd unit
  // names share the restriction.
  return String(name || DEFAULT_NAME).replace(/[\\/]/g, '-');
}

function parseArgs(argv) {
  const args = { name: DEFAULT_NAME, user: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--name') args.name = argv[++i] || DEFAULT_NAME;
    else if (argv[i] === '--user') args.user = argv[++i] || null;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

// The full systemd unit, exactly as it would be written to
// /etc/systemd/system/<name>.service. Pure string assembly so a test can pin
// the content.
function systemdUnit({ name, user = null, installDir, nodePath, configPath }) {
  // A unit is a Linux file even when generated on Windows, so the ExecStart
  // path must use forward slashes regardless of the host's separator.
  const serverPath = path.posix.join(installDir, 'server.js');
  const execStart = `${nodePath} ${serverPath}`;
  const lines = [
    '[Unit]',
    `Description=Hostkind game-server panel (${name})`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  // A dedicated service user keeps the panel from running as root; when none
  // is given the unit inherits the account that installs it.
  if (user) lines.push(`User=${user}`, `Group=${user}`);
  lines.push(
    `WorkingDirectory=${installDir}`,
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
  );
  if (configPath) lines.push(`Environment=FLEETDECK_CONFIG=${configPath}`);
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

// The schtasks command that creates the Windows task. /TR is a single command
// line, so the "cd to the install dir" requirement is folded into a cmd /c
// wrapper. Returns the argv array (no shell quoting surprises) plus the /TN.
function schtasksCreateCommand({ name, installDir, nodePath, configPath }) {
  const taskName = serviceName(name);
  const envSet = configPath ? `set "FLEETDECK_CONFIG=${configPath}" && ` : '';
  const serverJs = path.win32.join(installDir, 'server.js');
  const inner = `cd /d "${installDir}" && ${envSet}"${nodePath}" "${serverJs}"`;
  return {
    name: taskName,
    args: [
      '/Create', '/F',
      '/TN', taskName,
      // /SC ONLOGON starts the panel when the operator logs in - the Windows
      // analogue of a systemd user service, and the reason the panel keeps
      // re-adopting live servers across logons.
      '/SC', 'ONLOGON',
      '/TR', `cmd /c ${inner}`,
      '/RL', 'HIGHEST',
    ],
  };
}

function schtasksDeleteCommand({ name }) {
  const taskName = serviceName(name);
  return { name: taskName, args: ['/Delete', '/F', '/TN', taskName] };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  return r.status;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/install-service.cjs [--name <service>] [--user <unix user>]');
    return;
  }
  const name = serviceName(args.name);
  const installDir = detectInstallDir();
  const nodePath = resolveNodePath();
  const configPath = process.env.FLEETDECK_CONFIG || '';
  const configEnv = configPath ? ` FLEETDECK_CONFIG=${configPath}` : '';

  if (process.platform === 'win32') {
    const { args: schargs } = schtasksCreateCommand({ name, installDir, nodePath, configPath });
    console.log(`Installing Windows task "${name}" (logon autostart)...`);
    const status = run('schtasks', schargs);
    if (status !== 0) process.exitCode = status || 1;
    console.log(`Done. The panel starts at your next logon (or run: schtasks /Run /TN ${name}).`);
    return;
  }

  // systemd: write the unit, reload, and enable it for boot.
  const unit = systemdUnit({ name, user: args.user, installDir, nodePath, configPath });
  const unitPath = `/etc/systemd/system/${name}.service`;
  if (!fs.existsSync('/etc/systemd/system')) {
    console.error('This host does not use systemd. Install the panel with your init system instead.');
    process.exitCode = 1;
    return;
  }
  console.log(`Writing ${unitPath}...`);
  try {
    fs.writeFileSync(unitPath, unit, 'utf8');
  } catch (err) {
    console.error(`Could not write ${unitPath} (need root?): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Enabling and starting ${name}.service...`);
  if (run('systemctl', ['daemon-reload']) !== 0) { process.exitCode = 1; return; }
  if (run('systemctl', ['enable', `${name}.service`]) !== 0) { process.exitCode = 1; return; }
  run('systemctl', ['start', `${name}.service`]);
  console.log(`Done. ${name}.service will start the panel on every boot.${configEnv}`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_NAME,
  serviceName,
  parseArgs,
  detectInstallDir,
  resolveNodePath,
  systemdUnit,
  schtasksCreateCommand,
  schtasksDeleteCommand,
};
