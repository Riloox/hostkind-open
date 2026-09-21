'use strict';

// Phase 2B: documents originAllowed behavior (server.js:1465-1492) and the
// Vary: Origin header. Cheap unit test: replicates the allowlist rule
// (loopback on panel port + config.allowedOrigins hostnames; absent Origin
// allowed; non-http(s) rejected) without booting the server.

const assert = require('node:assert');
const { test } = require('node:test');

function makeOriginAllowed({ panelPort, allowedOrigins }) {
  return function originAllowed(origin) {
    if (!origin || typeof origin !== 'string') return true;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      if (loopback) {
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        if (port === String(panelPort)) return true;
      }
      for (const entry of allowedOrigins || []) {
        try {
          const eh = new URL(entry).hostname.toLowerCase().replace(/^\[|\]$/g, '');
          if (eh === hostname) return true;
        } catch (_) { /* bare hostname strings allowed too */ }
        if (String(entry).toLowerCase() === hostname) return true;
      }
      return false;
    } catch (_) { return false; }
  };
}

test('originAllowed documents the cross-origin defense', () => {
  const originAllowed = makeOriginAllowed({ panelPort: 3000, allowedOrigins: ['https://panel.example.com', 'proxy.internal'] });
  assert.strictEqual(originAllowed(null), true, 'absent Origin (curl) allowed');
  assert.strictEqual(originAllowed(undefined), true, 'absent Origin allowed');
  assert.strictEqual(originAllowed('http://localhost:3000'), true, 'same-origin loopback allowed');
  assert.strictEqual(originAllowed('http://127.0.0.1:3000'), true, 'same-origin loopback allowed');
  assert.strictEqual(originAllowed('http://127.0.0.1:9999'), false, 'loopback on other port rejected');
  assert.strictEqual(originAllowed('https://panel.example.com'), true, 'allowlisted hostname allowed');
  assert.strictEqual(originAllowed('https://proxy.internal:8443'), true, 'bare hostname entry allowed');
  assert.strictEqual(originAllowed('https://evil.example.com'), false, 'unknown origin rejected');
  assert.strictEqual(originAllowed('ftp://localhost:3000'), false, 'non-http(s) rejected');
  assert.strictEqual(originAllowed('not-a-url'), false, 'unparseable rejected');
});
