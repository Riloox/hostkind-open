'use strict';

const PUBLIC_API_PATHS = new Set([
  '/login',
  '/auth-mode',
  '/product/pairing/consume',
]);

function isPublicApiPath(pathname) {
  return typeof pathname === 'string' && PUBLIC_API_PATHS.has(pathname);
}

module.exports = { PUBLIC_API_PATHS, isPublicApiPath };
