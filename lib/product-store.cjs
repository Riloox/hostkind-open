'use strict';

/*
 * Durable local/BYOC-beta storage for the product contracts.
 *
 * Secrets are deliberately absent from every table: targets keep an opaque
 * secretRef, pairing challenges keep token hashes, and product events are
 * sanitized before insertion.
 */

const crypto = require('crypto');
const { open } = require('./db.cjs');
const byoc = require('./byoc.cjs');
const pairing = require('./pairing.cjs');
const validation = require('./product-validation.cjs');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function id() {
  return crypto.randomUUID();
}

function rowToTarget(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    region: row.region,
    resourceTier: row.resource_tier,
    secretRef: row.secret_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at == null ? null : row.last_seen_at,
  };
}

function listTargets() {
  return open().prepare(`SELECT id,name,provider,endpoint,region,resource_tier,secret_ref,status,created_at,updated_at,last_seen_at
    FROM byoc_targets ORDER BY created_at ASC, id ASC`).all().map(rowToTarget);
}

function createTarget(input, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const target = byoc.normalizeTarget(input, { id: options.id || id(), now });
  open().prepare(`INSERT INTO byoc_targets
    (id,name,provider,endpoint,region,resource_tier,secret_ref,status,created_at,updated_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    target.id, target.name, target.provider, target.endpoint, target.region,
    target.resourceTier, target.secretRef, target.status, target.createdAt,
    target.updatedAt, target.lastSeenAt,
  );
  recordEvent({ type: 'byoc_target_created', plan: 'byoc-beta', source: 'byoc', value: 1, occurredAt: now });
  return target;
}

function updateTarget(targetId, status, options = {}) {
  const row = open().prepare('SELECT * FROM byoc_targets WHERE id=?').get(targetId);
  if (!row) return null;
  const current = rowToTarget(row);
  const next = byoc.transition(current, status, options.now === undefined ? Date.now() : options.now);
  open().prepare('UPDATE byoc_targets SET status=?,updated_at=?,last_seen_at=? WHERE id=?')
    .run(next.status, next.updatedAt, next.status === 'ready' ? next.updatedAt : next.lastSeenAt, targetId);
  return { ...next, lastSeenAt: next.status === 'ready' ? next.updatedAt : next.lastSeenAt };
}

function constantTimeHashEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createPairing({ targetId, actorId }, options = {}) {
  const target = open().prepare('SELECT id FROM byoc_targets WHERE id=?').get(targetId);
  if (!target) throw Object.assign(new Error('BYOC target not found.'), { code: 'target_not_found', status: 404 });
  const now = options.now === undefined ? Date.now() : options.now;
  const challengeId = options.id || id();
  const agentId = options.agentId || id();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + (options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs);
  const maxAttempts = options.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : options.maxAttempts;
  open().prepare(`INSERT INTO pairing_challenges
    (id,target_id,actor_id,token_hash,agent_id,created_at,expires_at,attempts,max_attempts,used_at)
    VALUES (?,?,?,?,?,?,?,?,?,NULL)`).run(
    challengeId, targetId, actorId || null, pairing.hashToken(token), agentId,
    now, expiresAt, 0, maxAttempts,
  );
  return { id: challengeId, targetId, token, expiresAt };
}

function consumePairing({ id: challengeId, token }, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const db = open();
  const row = db.prepare('SELECT * FROM pairing_challenges WHERE id=?').get(challengeId);
  if (!row) return { ok: false, code: 'not_found' };
  if (row.used_at != null) return { ok: false, code: 'already_used' };
  if (row.attempts >= row.max_attempts) return { ok: false, code: 'too_many_attempts' };
  if (now > row.expires_at) return { ok: false, code: 'expired' };
  const valid = constantTimeHashEqual(pairing.hashToken(token), row.token_hash);
  if (!valid) {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE pairing_challenges SET attempts=? WHERE id=?').run(attempts, challengeId);
    return { ok: false, code: attempts >= row.max_attempts ? 'too_many_attempts' : 'invalid_token' };
  }
  const agentToken = crypto.randomBytes(32).toString('base64url');
  const completedAt = now;
  db.transaction(() => {
    db.prepare('UPDATE pairing_challenges SET used_at=? WHERE id=?').run(completedAt, challengeId);
    db.prepare(`INSERT INTO byoc_agents (id,target_id,token_hash,created_at,revoked_at,last_seen_at)
      VALUES (?,?,?,?,NULL,NULL)`).run(row.agent_id, row.target_id, pairing.hashToken(agentToken), completedAt);
  })();
  recordEvent({ type: 'pairing_completed', plan: 'byoc-beta', source: 'pairing', value: 1, occurredAt: completedAt });
  return { ok: true, targetId: row.target_id, agentId: row.agent_id, agentToken };
}

function normalizeDrillReport(report, options = {}) {
  const label = /^[A-Za-z0-9._:-]{1,128}$/;
  if (!report || typeof report !== 'object' || !label.test(String(report.backupId || '')) || !label.test(String(report.target || ''))) {
    throw Object.assign(new Error('restore drill backupId and target must be safe labels'), { code: 'invalid_restore_drill', status: 400 });
  }
  if (report.status !== 'succeeded' && report.status !== 'failed') {
    throw Object.assign(new Error('restore drill status is invalid'), { code: 'invalid_restore_drill', status: 400 });
  }
  const diff = report.diff;
  if (!diff || typeof diff !== 'object' || !Array.isArray(diff.missing) || !Array.isArray(diff.unexpected) || !Array.isArray(diff.changed)) {
    throw Object.assign(new Error('restore drill diff is invalid'), { code: 'invalid_restore_drill', status: 400 });
  }
  const safeList = (values, name) => values.map((value) => {
    if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
      throw Object.assign(new Error(`restore drill ${name} contains an unsafe path`), { code: 'invalid_restore_drill', status: 400 });
    }
    return value;
  });
  const normalized = {
    id: options.id || id(),
    backupId: String(report.backupId),
    target: String(report.target),
    status: report.status,
    startedAt: report.startedAt == null ? null : report.startedAt,
    completedAt: report.completedAt == null ? null : report.completedAt,
    expectedCount: Number(report.expectedCount),
    actualCount: Number(report.actualCount),
    diff: {
      ok: diff.ok === true,
      missing: safeList(diff.missing, 'missing'),
      unexpected: safeList(diff.unexpected, 'unexpected'),
      changed: safeList(diff.changed, 'changed'),
    },
    createdAt: options.now === undefined ? Date.now() : options.now,
  };
  if (!Number.isSafeInteger(normalized.expectedCount) || normalized.expectedCount < 0 ||
      !Number.isSafeInteger(normalized.actualCount) || normalized.actualCount < 0) {
    throw Object.assign(new Error('restore drill counts must be non-negative integers'), { code: 'invalid_restore_drill', status: 400 });
  }
  if (normalized.status === 'succeeded' && !normalized.diff.ok) {
    throw Object.assign(new Error('a succeeded restore drill must have an exact match'), { code: 'invalid_restore_drill', status: 400 });
  }
  return normalized;
}

function restoreDrillFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    backupId: row.backup_id,
    target: row.target,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expectedCount: row.expected_count,
    actualCount: row.actual_count,
    diff: JSON.parse(row.diff_json),
    createdAt: row.created_at,
  };
}

function recordRestoreDrill(report, options = {}) {
  const normalized = normalizeDrillReport(report, options);
  open().prepare(`INSERT INTO restore_drills
    (id,backup_id,target,status,started_at,completed_at,expected_count,actual_count,diff_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    normalized.id, normalized.backupId, normalized.target, normalized.status,
    normalized.startedAt, normalized.completedAt, normalized.expectedCount, normalized.actualCount,
    JSON.stringify(normalized.diff), normalized.createdAt,
  );
  if (normalized.status === 'succeeded') {
    recordEvent({
      type: 'restore_drill_succeeded',
      source: 'restore-drill',
      value: normalized.actualCount,
      occurredAt: normalized.completedAt == null ? normalized.createdAt : normalized.completedAt,
    });
  }
  return normalized;
}

function latestRestoreDrill() {
  return restoreDrillFromRow(open().prepare('SELECT * FROM restore_drills ORDER BY created_at DESC, id DESC LIMIT 1').get());
}

function recordEvent(input) {
  const event = validation.sanitizeEvent(input);
  if (!event.type) throw Object.assign(new Error('Unknown or missing product event type.'), { code: 'invalid_event', status: 400 });
  const eventId = id();
  const now = Date.now();
  open().prepare(`INSERT INTO product_events
    (id,type,server_id,game,plan,source,value,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    eventId, event.type, event.serverId || null, event.game || null, event.plan || null,
    event.source || null, event.value === undefined ? null : event.value,
    event.occurredAt === undefined ? now : event.occurredAt, now,
  );
  return event;
}

function summaryEvents(range = {}) {
  const from = Number.isFinite(Number(range.from)) ? Number(range.from) : -Infinity;
  const to = Number.isFinite(Number(range.to)) ? Number(range.to) : Infinity;
  const rows = open().prepare(`SELECT type,server_id,game,plan,source,value,occurred_at
    FROM product_events WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at ASC, id ASC`).all(from, to);
  return validation.summarizeEvents(rows.map((row) => ({
    type: row.type, serverId: row.server_id || undefined, game: row.game || undefined,
    plan: row.plan || undefined, source: row.source || undefined,
    value: row.value == null ? undefined : row.value, occurredAt: row.occurred_at,
  })), { from, to });
}

module.exports = {
  listTargets,
  createTarget,
  updateTarget,
  createPairing,
  consumePairing,
  recordRestoreDrill,
  latestRestoreDrill,
  recordEvent,
  summaryEvents,
};
