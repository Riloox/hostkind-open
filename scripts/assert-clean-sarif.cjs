#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'open-snapshot-sarif');

function sarifFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sarifFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.sarif')) found.push(target);
  }
  return found;
}

const files = sarifFiles(root);
if (!files.length) {
  console.error(`CodeQL gate: no SARIF reports found under ${root}`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const run of report.runs || []) {
    for (const result of run.results || []) {
      const location = result.locations?.[0]?.physicalLocation;
      findings.push({
        rule: result.ruleId || 'unknown-rule',
        level: result.level || 'warning',
        path: location?.artifactLocation?.uri || 'unknown-path',
        line: location?.region?.startLine || 0,
        message: String(result.message?.text || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
}

if (!findings.length) {
  console.log(`CodeQL gate: ${files.length} SARIF report(s), no findings`);
  process.exit(0);
}

console.error(`CodeQL gate: refusing to publish ${findings.length} finding(s):`);
for (const finding of findings) {
  console.error(`  ${finding.level} ${finding.rule} ${finding.path}:${finding.line} ${finding.message}`);
}
process.exit(1);
