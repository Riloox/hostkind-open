'use strict';

// Lifecycle scorecard: keeps support deep for a small set of games.
// A lifecycle capability counts as supported only when the module exposes the
// corresponding hook or explicitly advertises the capability. This is a
// diagnostic/selection contract, not permission to claim unsupported behavior.

const REQUIRED_LIFECYCLE = ['install', 'import', 'update', 'backup', 'restore', 'sleep', 'wake', 'migrate'];

function advertises(advertisement, key) {
  if (!advertisement) return false;
  if (Array.isArray(advertisement)) return advertisement.includes(key);
  if (typeof advertisement === 'object') return advertisement[key] === true;
  return false;
}

function supports(module, descriptor, key) {
  if (module && typeof module[key] === 'function') return true;
  if (module && advertises(module.capabilities, key)) return true;
  if (descriptor && advertises(descriptor.capabilities, key)) return true;
  return false;
}

function scoreModule(module, descriptor) {
  const desc = descriptor && typeof descriptor === 'object' ? descriptor : {};
  const lifecycle = {};
  const missing = [];
  let score = 0;
  for (const key of REQUIRED_LIFECYCLE) {
    const ok = supports(module, desc, key);
    lifecycle[key] = ok;
    if (ok) score += 1;
    else missing.push(key);
  }
  const moduleId = (module && module.id) || desc.type || 'unknown';
  return {
    moduleId,
    supported: score === REQUIRED_LIFECYCLE.length,
    score,
    total: REQUIRED_LIFECYCLE.length,
    missing,
    lifecycle,
  };
}

function selectDeepSupport(modules, ids, descriptorById) {
  const byId = new Map((modules || []).map((m) => [m && m.id, m]));
  return (ids || []).map((id) => {
    const module = byId.get(id);
    const descriptor = (descriptorById && descriptorById[id]) || {};
    const card = scoreModule(module, descriptor);
    card.moduleId = id;
    return card;
  });
}

module.exports = { REQUIRED_LIFECYCLE, scoreModule, selectDeepSupport };