'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { installBatch } = require('../lib/modrinth-batch.cjs');

test('Modrinth installs selected projects with bounded parallel downloads', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-modrinth-selection-'));
  let active = 0;
  let maxActive = 0;
  const records = [];
  try {
    const result = await installBatch({
      projectIds: ['one', 'two', 'three'],
      compat: { loaders: ['fabric'], mcVersion: '1.20.1', folder: 'mods', label: 'Fabric' },
      rootDir,
      resolveVersionsImpl: async (projectId) => [{
        id: `version-${projectId}`,
        project_id: projectId,
        loaders: ['fabric'],
        game_versions: ['1.20.1'],
        files: [{ primary: true, filename: `${projectId}.jar`, url: `https://cdn.test/${projectId}.jar` }],
      }],
      downloadImpl: async (_url, destination) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'jar');
        active -= 1;
        return { sha256: 'hash' };
      },
      recordImpl: (entry) => records.push(entry),
      concurrency: 2,
    });
    assert.strictEqual(maxActive, 2);
    assert.deepStrictEqual(result.installed, ['one', 'two', 'three']);
    assert.strictEqual(records.length, 3);
    assert.ok(fs.existsSync(path.join(rootDir, 'mods', 'two.jar')));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('Modrinth creates the target content folder before downloading', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-modrinth-folder-'));
  try {
    const result = await installBatch({
      projectIds: ['one'],
      compat: { loaders: ['fabric'], mcVersion: '1.20.1', folder: 'mods', label: 'Fabric' },
      rootDir,
      resolveVersionsImpl: async () => [{ id: 'v1', project_id: 'one', loaders: ['fabric'], game_versions: ['1.20.1'], files: [{ filename: 'one.jar', url: 'https://cdn.test/one.jar' }] }],
      downloadImpl: async (_url, destination) => {
        assert.strictEqual(fs.existsSync(path.dirname(destination)), true);
        fs.writeFileSync(destination, 'jar');
      },
    });
    assert.deepStrictEqual(result.installed, ['one']);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});
