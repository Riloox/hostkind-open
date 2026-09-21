'use strict';

/*
 * Shared CLI helpers for scripts/*.cjs.
 *
 * Two duplications this removes:
 *   1. Manual `--flag value` / `--flag=value` parsing, re-implemented in
 *      collect-installer-artifacts.cjs, install-service.cjs (also reused by
 *      uninstall-service.cjs via require), and ad-hoc elsewhere.
 *   2. spawnSync result handling (`error` -> throw, `signal` -> throw,
 *      else exit status), previously inlined in both install-service.cjs /
 *      uninstall-service.cjs `run()` and build-desktop.cjs.
 *
 * The parseArgs functions in each script keep their exact public shapes
 * (pinned by test/installer-artifacts.test.cjs and
 * test/service-wrappers.test.cjs); they are implemented on top of these
 * helpers, not replaced by a generic parser.
 */

const { spawnSync } = require('child_process');

function isHelpFlag(arg) {
  return arg === '--help' || arg === '-h';
}

// Split one argv entry into { name, value, inline }:
//   '--tag'     -> { name: 'tag', value: undefined, inline: false }
//   '--tag=v'   -> { name: 'tag', value: 'v',       inline: true  }
//   'positional', '-h', undefined -> { name: null, ... }
function splitFlag(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) {
    return { name: null, value: undefined, inline: false };
  }
  const eq = arg.indexOf('=');
  if (eq === -1) return { name: arg.slice(2), value: undefined, inline: false };
  return { name: arg.slice(2, eq), value: arg.slice(eq + 1), inline: true };
}

// Resolve the value for a `--name value` / `--name=value` flag seen at
// argv[i] (already split with splitFlag). Inline `--name=value` wins;
// otherwise the next argv entry is consumed. When neither is present the
// caller-supplied fallback is used (matching the old `argv[i] || fallback`
// idiom). Returns { value, nextIndex } where nextIndex is the last argv
// index consumed, so callers do `i = result.nextIndex`.
function flagValue(argv, i, parsed, fallback) {
  if (parsed.inline) return { value: parsed.value, nextIndex: i };
  const next = argv[i + 1];
  if (next === undefined) return { value: fallback, nextIndex: i + 1 };
  return { value: next, nextIndex: i + 1 };
}

// Shared spawn-result contract: a spawn error throws, termination by signal
// throws, otherwise the exit status is returned (1 when the runner reports
// no numeric status). Accepts the plain `{ status }` fakes used in tests.
function checkSpawnResult(label, result) {
  if (!result) return 1;
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}`);
  if (typeof result.status !== 'number') return 1;
  return result.status;
}

// Spawn a command and apply checkSpawnResult. `spawnFn` is injectable so
// tests can stub the child process (as build-desktop.cjs does); `label`
// overrides the command name in signal errors.
function runChecked(cmd, args, { spawnFn = spawnSync, label = cmd, ...options } = {}) {
  const result = spawnFn(cmd, args, { stdio: 'inherit', shell: false, ...options });
  return checkSpawnResult(label, result);
}

module.exports = {
  isHelpFlag,
  splitFlag,
  flagValue,
  checkSpawnResult,
  runChecked,
};
