'use strict';

/*
 * Terms of Use: the in-app copy (src/lib/terms.js) and TERMS.md stay in step,
 * and PUT /api/me/terms records acceptance for real users and the guest.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const usersRouter = require('../lib/routes/users.cjs');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/lib/terms.js'), 'utf8');
const md = fs.readFileSync(path.join(root, 'TERMS.md'), 'utf8');

// --- copy parity -----------------------------------------------------------
const version = src.match(/TERMS_VERSION = '([^']+)'/)[1];
assert.match(version, /^\d{4}-\d{2}-\d{2}$/, 'TERMS_VERSION is a date');
assert.ok(md.includes(`Last updated: ${version}`), 'TERMS.md carries the current TERMS_VERSION');

const block = (name) => src.slice(src.indexOf(`const ${name} = [`), src.indexOf('];', src.indexOf(`const ${name} = [`)));
const headings = (text) => [...text.matchAll(/heading: '([^']+)'/g)].map((m) => m[1]);
const en = headings(block('en'));
const es = headings(block('es'));
const mdHeadings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
assert.ok(en.length > 0, 'English terms have sections');
assert.deepStrictEqual(mdHeadings, en, 'TERMS.md headings match the English in-app terms');
assert.strictEqual(es.length, en.length, 'Spanish terms have the same number of sections');

// --- PUT /api/me/terms -----------------------------------------------------
async function run() {
  const config = { users: [{ id: 'u1', username: 'alice', role: 'admin' }] };
  const audits = [];
  let saves = 0;
  let current = config.users[0];
  const isGuestUser = (u) => u && u.id === 'guest';
  const publicUser = (u) => ({
    id: u.id,
    termsAcceptedVersion: (isGuestUser(u) ? config.guestTermsAccepted?.version : u.termsAcceptedVersion) || null,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = current; next(); });
  app.use('/api', usersRouter({
    getConfig: () => config,
    saveConfig: () => { saves++; },
    foundationAudit: { record: (e) => audits.push(e) },
    publicUser,
    publicPermissions: () => ({}),
    requireHuman: (_req, _res, next) => next(),
    tErr: (_u, key) => key,
    isGuestUser,
    i18n: { normalizeLang: (l) => l, SUPPORTED_LANGS: ['en'] },
    log: () => {},
  }));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const put = (body) => fetch(`${base}/me/terms`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    let res = await put({ version: 'not-a-date' });
    assert.strictEqual(res.status, 400, 'malformed version is rejected');
    assert.strictEqual(saves, 0);

    res = await put({ version });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).user.termsAcceptedVersion, version);
    assert.strictEqual(config.users[0].termsAcceptedVersion, version);
    assert.ok(config.users[0].termsAcceptedAt, 'acceptance time is recorded');
    assert.strictEqual(audits[0].action, 'terms.accept');
    assert.deepStrictEqual(audits[0].metadata, { version });

    current = { id: 'guest', username: 'guest', role: 'admin' };
    res = await put({ version });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).user.termsAcceptedVersion, version);
    assert.strictEqual(config.guestTermsAccepted.version, version, 'guest acceptance lives on the install');
    assert.strictEqual(current.termsAcceptedVersion, undefined, 'the synthetic guest is not mutated');
  } finally {
    server.close();
  }
  console.log('terms: ok');
}

run().catch((err) => { console.error(err); process.exit(1); });
