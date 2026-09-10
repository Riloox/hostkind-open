'use strict';

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mapConcurrentSettled } = require('../lib/concurrency.cjs');
const addonState = require('../lib/addon-state.cjs');

test('mapConcurrentSettled keeps selection order while bounding active downloads', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrentSettled([40, 5, 20, 1], async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    if (index === 2) throw new Error('one item failed');
    return delay * 2;
  }, { concurrency: 2 });

  assert.equal(peak, 2);
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(results.map((item) => item.status === 'fulfilled' ? item.value : item.reason.message), [80, 10, 'one item failed', 2]);
});

test('addonState rejects non-boolean enabled state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-addon-state-'));
  assert.throws(() => addonState.setEnabled({
    activeDir: path.join(root, 'mods'),
    disabledDir: path.join(root, 'disabled'),
    names: ['one.jar'],
    enabled: 'true',
  }), (error) => error.code === 'invalid_enabled');
});

test('addonState moves a selected group between active and disabled folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-addon-state-'));
  const activeDir = path.join(root, 'mods');
  const disabledDir = path.join(root, '.hostkind', 'disabled', 'mods');
  try {
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'alpha.jar'), 'alpha');
    fs.writeFileSync(path.join(activeDir, 'beta.jar'), 'beta');
    fs.writeFileSync(path.join(disabledDir, 'gamma.jar'), 'gamma');

    assert.deepEqual(addonState.list({ activeDir, disabledDir }).map(({ name, enabled }) => ({ name, enabled })), [
      { name: 'alpha.jar', enabled: true },
      { name: 'beta.jar', enabled: true },
      { name: 'gamma.jar', enabled: false },
    ]);

    const disabled = addonState.setEnabled({ activeDir, disabledDir, names: ['alpha.jar', 'gamma.jar'], enabled: false });
    assert.deepEqual(disabled.changed, ['alpha.jar']);
    assert.equal(fs.existsSync(path.join(activeDir, 'alpha.jar')), false);
    assert.equal(fs.existsSync(path.join(disabledDir, 'alpha.jar')), true);

    const enabled = addonState.setEnabled({ activeDir, disabledDir, names: ['alpha.jar', 'gamma.jar'], enabled: true });
    assert.deepEqual(enabled.changed, ['alpha.jar', 'gamma.jar']);
    assert.equal(fs.existsSync(path.join(activeDir, 'alpha.jar')), true);
    assert.equal(fs.existsSync(path.join(activeDir, 'gamma.jar')), true);
    assert.equal(enabled.restartRequired, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
