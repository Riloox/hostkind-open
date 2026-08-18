'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'oxlint.config.mjs');
const OXLINT = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const RULE_NAMES = [
  'no-chained-type-assertions',
  'no-conditional-empty-object-spread',
  'no-known-value-widening',
  'no-module-mocking',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
];

function lintFixture(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-anti-slop-'));
  const file = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(file, source);
  try {
    const result = spawnSync(OXLINT, ['oxlint', '--config', CONFIG, '--format', 'json', file], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    const report = JSON.parse(result.stdout);
    return { result, report };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const config = fs.readFileSync(CONFIG, 'utf8');
for (const name of RULE_NAMES) {
  assert.match(config, new RegExp(`anti-slop/${name}`), `rule is not registered: ${name}`);
}

{
  const { result, report } = lintFixture('const shape = {}; void shape;\n');
  assert.equal(result.status, 1, 'the forbidden standalone name should fail lint');
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.code === 'anti-slop(no-shape-in-symbol-names)'),
    'shape diagnostic should be reported',
  );
}

{
  const { result, report } = lintFixture('const reshaped = {}; void reshaped;\n');
  assert.equal(result.status, 0, 'domain terms containing shape should remain allowed');
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.code === 'anti-slop(no-shape-in-symbol-names)'),
    false,
    'reshaped should not trigger the standalone-name rule',
  );
}

// --- no-runtime-typeof: focused policy tests (allowed vs reported) ---
const TYPEOF_CODE = 'anti-slop(no-runtime-typeof)';
function expectTypeofAllowed(source, label) {
  const { result, report } = lintFixture(source);
  assert.equal(result.status, 0, `${label}: fixture should lint clean`);
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.code === TYPEOF_CODE),
    false,
    `${label}: should NOT report no-runtime-typeof`,
  );
}
function expectTypeofReported(source, label) {
  const { result, report } = lintFixture(source);
  assert.equal(result.status, 1, `${label}: fixture should fail lint`);
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.code === TYPEOF_CODE),
    `${label}: should report no-runtime-typeof`,
  );
}

// Allowed: ordinary primitive boundary validation.
expectTypeofAllowed(
  "function pick(v) { return typeof v === 'string' ? v : null; }\nvoid pick;\n",
  'typeof string check',
);
expectTypeofAllowed(
  "function num(v) { if (typeof v !== 'number') return 0; return v; }\nvoid num;\n",
  'typeof number rejection',
);
expectTypeofAllowed(
  "function bool(v) { return typeof v === 'boolean' ? v : false; }\nvoid bool;\n",
  'typeof boolean check',
);

// Allowed: callable capability checks and feature/existence probes.
expectTypeofAllowed(
  "function cap(fn) { if (typeof fn === 'function') return fn(); return null; }\nvoid cap;\n",
  'typeof function capability check',
);
expectTypeofAllowed(
  "function ssr() { if (typeof window === 'undefined') return 'loopback'; return 'browser'; }\nvoid ssr;\n",
  'typeof undefined feature probe',
);

// Allowed: object guards that exclude null and/or arrays in the guard context.
expectTypeofAllowed(
  "function guard2(v) { if (v && typeof v === 'object') return Object.keys(v).length; return 0; }\nvoid guard2;\n",
  'typeof object guard with truthiness check',
);
expectTypeofAllowed(
  "function guard3(v) { return v === null || typeof v === 'object'; }\nvoid guard3;\n",
  'typeof object check with null-discharge disjunct',
);
expectTypeofAllowed(
  "function walk(v) {\n  if (v == null) return v;\n  if (Array.isArray(v)) return v.length;\n  if (typeof v === 'object') return Object.keys(v).length;\n  return 0;\n}\nvoid walk;\n",
  'typeof object check after preceding terminal if-guards',
);

// Allowed: bare typeof as an assertion operand (callability check).
expectTypeofAllowed(
  "const assert = require('node:assert');\nfunction fact() { return () => 1; }\nvoid assert.equal(typeof fact(), 'function');\n",
  'bare typeof in an assert call',
);

// Reported: positive object acceptance with no guard excluding null/arrays,
// including guards that only constrain a different operand.
expectTypeofReported(
  "function bad(v) { if (typeof v === 'object') return Object.keys(v); return null; }\nvoid bad;\n",
  'contract-free typeof object acceptance',
);
expectTypeofReported(
  "function weak(cfg) { if (cfg && typeof cfg.mods === 'object') return cfg.mods; return null; }\nvoid weak;\n",
  'typeof object check guarded only on a different operand',
);

// Reported: comparisons against type names typeof can never produce.
expectTypeofReported(
  "function dead(v) { return typeof v === 'integer' ? v : null; }\nvoid dead;\n",
  'typeof compared against a non-canonical literal',
);

console.log(`PASS anti-slop-rules (${RULE_NAMES.length} rules registered; shape and typeof policies smoke-tested)`);
