'use strict';

/*
 * Remove the OS service entry created by scripts/install-service.cjs.
 *
 *   Linux   disables and stops the systemd unit, then deletes its file
 *   Windows deletes the Task Scheduler task
 *
 * Usage: node scripts/uninstall-service.cjs [--name hostkind]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_NAME,
  serviceName,
  parseArgs,
  schtasksDeleteCommand,
} = require('./install-service.cjs');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  return r.status;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = serviceName(args.name || DEFAULT_NAME);

  if (process.platform === 'win32') {
    const { args: schargs } = schtasksDeleteCommand({ name });
    console.log(`Deleting Windows task "${name}"...`);
    const status = run('schtasks', schargs);
    if (status !== 0) process.exitCode = status || 1;
    return;
  }

  const unitPath = `/etc/systemd/system/${name}.service`;
  console.log(`Disabling and stopping ${name}.service...`);
  if (run('systemctl', ['disable', '--now', `${name}.service`]) !== 0) {
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(unitPath)) {
    try {
      fs.unlinkSync(unitPath);
    } catch (err) {
      console.error(`Could not remove ${unitPath}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  run('systemctl', ['daemon-reload']);
  console.log(`Done. ${name} no longer starts on boot.`);
}

if (require.main === module) main();
