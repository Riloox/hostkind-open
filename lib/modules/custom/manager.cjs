'use strict';

const fs = require('fs');

// Split a command line without involving a shell. This keeps custom processes
// consistent with the rest of Hostkind: arguments containing spaces work,
// while shell operators are passed literally instead of being executed.
function parseCommand(command) {
  const input = String(command || '').trim();
  const argv = [];
  let current = '';
  let quote = null;
  let started = false;

  // `input` is a string by construction, and a string's length is bounded by
  // the string itself, so the index loop below cannot loop indefinitely. Pin
  // the type explicitly - this is the guard CodeQL js/loop-bound-injection
  // recognizes before iterating a user-controlled value.
  if (typeof input !== 'string') return argv;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '\\' && quote !== '\'') {
      const next = input[i + 1];
      const escapesNext = next === quote || next === '"' || next === '\\' || (!quote && /\s/.test(next || ''));
      if (escapesNext) {
        current += next;
        i++;
      } else {
        current += char;
      }
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
    } else if (char === '"' || char === '\'') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (quote) throw new Error('Start command contains an unclosed quote');
  if (started) argv.push(current);
  return argv;
}

function createCustomModule() {
  return {
    id: 'custom',
    capabilities: ['console', 'files', 'backups', 'schedules', 'metrics', 'watchdog'],
    metadata: {
      automaticInstallHosts: [],
      manualRegistration: true,
      creationAvailable: false,
    },

    start(manager) {
      const desc = manager.desc();
      const cwd = String(desc.cwd || desc.dir || '').trim();
      if (!cwd) return { ok: false, error: 'No working directory configured' };
      let isDirectory = false;
      try { isDirectory = fs.statSync(cwd).isDirectory(); } catch {}
      if (!isDirectory) {
        return { ok: false, error: `Working directory not found: ${cwd}` };
      }

      let argv;
      try {
        argv = desc.executable
          ? [desc.executable, ...(Array.isArray(desc.args) ? desc.args : [])]
          : parseCommand(desc.startCommand);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (!argv.length) return { ok: false, error: 'No start command configured' };
      return manager._launch(argv[0], argv.slice(1));
    },

    preLaunch() {
      return { ok: true };
    },

    detectOnline(line, manager) {
      const source = String(manager.desc().healthCheckRegex || '').trim();
      if (!source) return line === null;
      if (line === null) return false;
      try {
        return new RegExp(source).test(line);
      } catch {
        return false;
      }
    },

    buildStopSequence(manager) {
      const desc = manager.desc();
      const command = String(desc.stopCommand || '').trim();
      return command
        ? { command }
        : { signal: String(desc.stopSignal || '').trim() || 'SIGTERM' };
    },

    statusFields() {
      return {};
    },

    backupSelection() {
      return ['.'];
    },
  };
}

module.exports = createCustomModule;
module.exports.parseCommand = parseCommand;
