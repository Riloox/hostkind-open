'use strict';

const assert = require('assert');
const settings = require('../lib/palworld-settings.cjs');

function fixture(eol = '\n', bom = '') {
  return Buffer.from([
    `${bom}; Hostkind must preserve this comment`,
    '[/Script/Pal.PalGameWorldSettings]',
    'OptionSettings=(ServerName="Pal \\"Home\\"",ServerPlayerMaxNum=12,CommunityServer=False,FutureSetting="雪,=ok")',
    '',
  ].join(eol));
}

{
  const original = fixture('\r\n', '\ufeff');
  const parsed = settings.parse(original);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.revision, settings.parse(Buffer.from(original)).revision);
  assert.strictEqual(settings.applyPatch(parsed, {}).compare(original), 0, 'no-op must be byte-identical');
}

{
  const raw = Buffer.from(
    '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(RESTAPIEnabled=True,RESTAPIPort=8212,AdminPassword="secret")\n',
  );
  assert.deepStrictEqual(settings.validateProtectedRaw(raw, { restPort: 8212, adminPassword: 'secret' }), { ok: true });
  assert.strictEqual(settings.validateProtectedRaw(
    raw.toString('utf8').replace('RESTAPIEnabled=True', 'RESTAPIEnabled=False'),
    { restPort: 8212, adminPassword: 'secret' },
  ).ok, false);
}

{
  const original = fixture('\n');
  const changed = settings.applyPatch(settings.parse(original), { ServerPlayerMaxNum: 20 });
  const text = changed.toString('utf8');
  assert.ok(text.includes('ServerPlayerMaxNum=20'));
  assert.ok(text.includes('FutureSetting="雪,=ok"'), 'unknown members must survive');
  assert.ok(text.includes('ServerName="Pal \\"Home\\""'), 'escaped text must survive');
  assert.strictEqual(text.replace('ServerPlayerMaxNum=20', 'ServerPlayerMaxNum=12'), original.toString('utf8'));
}

{
  const original = fixture('\r\n');
  const changed = settings.applyPatch(settings.parse(original), { Region: 'South America' });
  assert.ok(changed.toString('utf8').includes(',Region="South America")'));
  assert.ok(changed.toString('utf8').includes('\r\n'));
}

{
  const parsed = settings.parse(Buffer.from(
    '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName="A",ServerName="B")\n',
  ));
  assert.ok(parsed.errors.some((error) => error.includes('Duplicate')));
  assert.throws(() => settings.applyPatch(parsed, { ServerName: 'C' }), /syntax is repaired/);
}

{
  const parsed = settings.parse(Buffer.from(
    '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName="A"\n',
  ));
  assert.ok(parsed.errors.some((error) => error.includes('malformed')));
}

{
  const { normalized, issues } = settings.validatePatch({
    ServerPlayerMaxNum: 100,
    RESTAPIEnabled: false,
  });
  assert.strictEqual(normalized.ServerPlayerMaxNum, 100);
  assert.strictEqual(issues.length, 2);
}

console.log('PASS  palworld-settings');
