'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { open } = require('./db.cjs');

const MAX_CONSOLE_LINES = 200;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_EVIDENCE_CHARS = 256 * 1024;
const RULESET_VERSION = 1;

function redact(text) {
  return String(text || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<address>')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/^(?:\[[^\]]+\]\s*)?\S+(?=\s+(?:has joined|has left|is connecting)\b)/gim, '<player>')
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>|]+/g, '<path>')
    .replace(/\/(?:home|Users|var|opt|srv|tmp)\/[^\s"'<>]+/g, '<path>');
}

function normalize(text) {
  return redact(text).replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[?\d{2}:\d{2}:\d{2}\]?/g, '<time>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?\b/g, '<timestamp>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s:]+/g, '<path>')
    .replace(/\.(?:java|cs):\d+/g, (match) => match.replace(/\d+$/, '<line>'))
    .replace(/(?:Thread|pool)-\d+(?:-thread-\d+)?/gi, '<thread>')
    .replace(/\s+/g, ' ').trim();
}

function fingerprint(evidence) {
  const legacy = [evidence.crashReport?.text, evidence.latestLog?.text, ...(evidence.console || []).map((l) => l.text)].filter(Boolean);
  const usesLegacyLayout = Object.prototype.hasOwnProperty.call(evidence, 'latestLog') || Object.prototype.hasOwnProperty.call(evidence, 'crashReport');
  const all = (usesLegacyLayout ? legacy : [evidenceText(evidence)]).join('\n');
  const stable = all.split(/\r?\n/).filter((line) => /(?:Exception|Error|Caused by:|\bat\s+[\w.$]+\()/i.test(line)).slice(-80).map(normalize).join('\n') || normalize(all).slice(-8192) || 'empty-crash';
  return crypto.createHash('sha256').update(`v1\n${stable}`).digest('hex');
}

function safeTail(root, candidate) {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { status: 'rejected', reason: 'outside-root' };
    const st = fs.lstatSync(candidate);
    if (!st.isFile() || st.isSymbolicLink()) return { status: 'rejected', reason: 'not-regular-file' };
    const fd = fs.openSync(real, 'r');
    try {
      const length = Math.min(st.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, Math.max(0, st.size - length));
      // Incident evidence is immutable and gets read back on any host, so the
      // recorded path stays in the '/' form the globs are written in rather
      // than the separator this particular machine happens to use.
      const relative = path.relative(realRoot, real).split(path.sep).join('/');
      return { status: 'captured', path: relative, truncated: st.size > length, text: redact(buf.toString('utf8').replace(/\u0000/g, '\ufffd')) };
    } finally { fs.closeSync(fd); }
  } catch (err) { return { status: 'absent', reason: err.code || 'read-failed' }; }
}

function newestMatching(root, glob, occurredAt, maxAgeMs = 24 * 3600000) {
  const normalized = String(glob || '').replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = path.join(root, slash >= 0 ? normalized.slice(0, slash) : '');
  const mask = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const escaped = mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const pattern = new RegExp(`^${escaped}$`, 'i');
  try {
    const candidates = fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name)).filter((file) => {
      try {
        const st = fs.lstatSync(file);
        return st.isFile() && !st.isSymbolicLink() && Math.abs(occurredAt - st.mtimeMs) <= maxAgeMs;
      } catch { return false; }
    }).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] ? safeTail(root, candidates[0]) : { status: 'absent', reason: 'no-relevant-report' };
  } catch (err) { return { status: 'absent', reason: err.code || 'read-failed' }; }
}

const DEFAULT_RULES = [
  { id: 'memory.oom', category: 'memory', pattern: /OutOfMemoryError|Java heap space|unable to create native thread|native memory allocation/i, confidence: 'high', reasoning: 'Memory exhaustion markers were found.', suggestions: ['Review the server memory limit and recent memory use.', 'Check for plugins or mods retaining excessive memory.'] },
  { id: 'java.incompatible', category: 'java', pattern: /UnsupportedClassVersionError|class file version|requires Java \d+/i, confidence: 'high', reasoning: 'Java class-version incompatibility markers were found.', suggestions: ['Use the Java major required by this Minecraft or loader version.', 'Check recently changed plugins or mods for Java requirements.'] },
  { id: 'watchdog.loop', category: 'watchdog', pattern: /watchdog|single server tick took|server has not responded/i, confidence: 'high', reasoning: 'Watchdog or stalled-tick markers were found.', suggestions: ['Inspect the named thread stack and the work running on the server tick.', 'Check recent CPU and memory pressure.'] },
  { id: 'loader.component', category: 'plugin_or_mod', pattern: /(?:Could not load|Error loading|ModLoadingException|Failed to load).*?(?:\.jar|plugin|mod)/i, confidence: 'medium', reasoning: 'A plugin or mod loading failure was found.', suggestions: ['Review the named component and its dependencies.', 'Confirm it supports this server loader and Minecraft version.'] },
];

function evidenceText(evidence) {
  return Object.values(evidence).flatMap((item) => {
    if (Array.isArray(item)) return item.map((line) => line && line.text);
    return item && typeof item === 'object' && !Array.isArray(item) ? [item.text] : [];
  }).filter(Boolean).join('\n');
}

function classify(evidence, environment, suppliedRules) {
  const text = evidenceText(evidence);
  const rules = suppliedRules || DEFAULT_RULES;
  const conclusions = rules.filter((rule) => {
    if (rule.when && !rule.when(environment)) return false;
    if (rule.pattern instanceof RegExp) { rule.pattern.lastIndex = 0; return rule.pattern.test(text); }
    return false;
  }).map((rule) => ({
    ruleId: rule.id,
    category: rule.category,
    confidence: rule.confidence,
    reasoning: Array.isArray(rule.reasoning) ? rule.reasoning : [rule.reasoning],
    suggestions: rule.suggestions || [],
    action: rule.action || null,
  }));
  if (environment.recentMetrics && (environment.recentMetrics.cpu >= 95 || (Number.isFinite(environment.heapLimitMb) && environment.recentMetrics.memoryMb >= environment.heapLimitMb * 0.95))) conclusions.push({ ruleId: 'resource.pressure', category: 'resources', confidence: 'medium', reasoning: ['Recent local metrics show resource pressure near the crash.'], suggestions: ['Compare the incident time with the Health resource charts.', 'Check host capacity and the configured heap limit.'] });
  return conclusions;
}

function capture({ serverId, root, history, exitCode, signal, occurredAt = Date.now(), runtimeMs, recentMetrics, heapLimitMb, sources, rules, lifecycle = 'crash' }) {
  const evidence = {
    version: 1,
    console: (history || []).slice(-MAX_CONSOLE_LINES).map((l) => ({ ts: l.ts, level: l.level, text: redact(l.text) })),
  };
  if (sources == null) {
    evidence.latestLog = safeTail(root, path.join(root, 'logs', 'latest.log'));
    evidence.crashReport = newestMatching(root, 'crash-reports/*', occurredAt);
  } else {
    for (const source of sources) {
      if (!source || !source.id || evidence[source.id]) continue;
      evidence[source.id] = source.relativePath
        ? safeTail(root, path.join(root, source.relativePath))
        : newestMatching(root, source.glob, occurredAt, source.maxAgeMs);
    }
  }
  const encoded = JSON.stringify(evidence);
  if (encoded.length > MAX_EVIDENCE_CHARS) {
    evidence.console = evidence.console.slice(-50);
    for (const source of Object.values(evidence)) {
      if (source?.text) source.text = source.text.slice(-80 * 1024);
    }
    evidence.storageTruncated = true;
  }
  const environment = { platform: process.platform, arch: process.arch, node: process.version, hostname: '<redacted>', recentMetrics: recentMetrics || null, heapLimitMb: heapLimitMb || null, rulesetVersion: RULESET_VERSION, lifecycle, signal: signal || null };
  const fp = fingerprint(evidence);
  const conclusions = classify(evidence, environment, rules);
  const category = conclusions[0]?.category || 'unknown';
  const db = open();
  const incidentId = crypto.randomUUID();
  const tx = db.transaction(() => {
    let group = db.prepare('SELECT id FROM crash_groups WHERE server_id = ? AND fingerprint = ?').get(serverId, fp);
    if (group) db.prepare('UPDATE crash_groups SET last_seen_at = ?, count = count + 1, category = ? WHERE id = ?').run(occurredAt, category, group.id);
    else { group = { id: crypto.randomUUID() }; db.prepare('INSERT INTO crash_groups (id,server_id,fingerprint,category,first_seen_at,last_seen_at,count) VALUES (?,?,?,?,?,?,1)').run(group.id, serverId, fp, category, occurredAt, occurredAt); }
    db.prepare('INSERT INTO crash_incidents (id,group_id,server_id,exit_code,signal,occurred_at,runtime_ms,evidence_json,environment_json) VALUES (?,?,?,?,?,?,?,?,?)').run(incidentId, group.id, serverId, Number.isInteger(exitCode) ? exitCode : null, signal || null, occurredAt, runtimeMs == null ? null : Math.max(0, runtimeMs), JSON.stringify(evidence), JSON.stringify(environment));
    const insert = db.prepare('INSERT INTO crash_conclusions (id,incident_id,rule_id,category,confidence,reasoning_json,suggestions_json) VALUES (?,?,?,?,?,?,?)');
    for (const c of conclusions) insert.run(crypto.randomUUID(), incidentId, c.ruleId, c.category, c.confidence, JSON.stringify(c.reasoning), JSON.stringify(c.suggestions));
    return group.id;
  });
  return { incidentId, groupId: tx(), category, fingerprint: fp };
}

function list({ cursor, serverId, acknowledged, from, to, includeLifecycle = false, limit = 50 } = {}) {
  const where = [], args = [];
  if (!includeLifecycle) where.push(`EXISTS (
    SELECT 1 FROM crash_incidents ci
     WHERE ci.group_id = crash_groups.id
       AND json_extract(ci.environment_json, '$.lifecycle') IN ('crash','failed_start')
  )`);
  if (serverId) { where.push('server_id = ?'); args.push(serverId); }
  if (acknowledged === true) where.push('acknowledged_at IS NOT NULL');
  if (acknowledged === false) where.push('acknowledged_at IS NULL');
  if (from) { where.push('last_seen_at >= ?'); args.push(from); }
  if (to) { where.push('last_seen_at <= ?'); args.push(to); }
  if (cursor) { where.push('last_seen_at < ?'); args.push(cursor); }
  const rows = open().prepare(`SELECT * FROM crash_groups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen_at DESC,id DESC LIMIT ?`).all(...args, limit + 1);
  const more = rows.length > limit; const items = more ? rows.slice(0, limit) : rows;
  return { items: items.map(groupRow), nextCursor: more ? items[items.length - 1].last_seen_at : null };
}
function groupRow(r) { return { id: r.id, serverId: r.server_id, fingerprint: r.fingerprint, category: r.category, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, count: r.count, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by }; }
function detail(id) {
  const db = open(); const group = db.prepare('SELECT * FROM crash_groups WHERE id=?').get(id); if (!group) return null;
  const incident = db.prepare('SELECT * FROM crash_incidents WHERE group_id=? ORDER BY occurred_at DESC LIMIT 1').get(id);
  const conclusions = db.prepare('SELECT * FROM crash_conclusions WHERE incident_id=?').all(incident.id).map((r) => ({ id: r.id, ruleId: r.rule_id, category: r.category, confidence: r.confidence, reasoning: JSON.parse(r.reasoning_json), suggestions: JSON.parse(r.suggestions_json) }));
  const backup = db.prepare(`
    SELECT m.id,m.filename,m.created_at,v.verified_at
      FROM backup_manifests m
      JOIN backup_verifications v ON v.backup_id=m.id AND v.status='verified'
     WHERE m.server_id=? AND m.created_at<=?
     ORDER BY m.created_at DESC LIMIT 1
  `).get(incident.server_id, incident.occurred_at);
  return {
    group: groupRow(group),
    incident: { id: incident.id, serverId: incident.server_id, exitCode: incident.exit_code, signal: incident.signal, occurredAt: incident.occurred_at, runtimeMs: incident.runtime_ms, evidence: JSON.parse(incident.evidence_json), environment: JSON.parse(incident.environment_json) },
    conclusions,
    backupBeforeIncident: backup ? { id: backup.id, filename: backup.filename, createdAt: backup.created_at, verifiedAt: backup.verified_at, ageMs: incident.occurred_at - backup.created_at } : null,
  };
}
function acknowledge(id, userId, value) { const at = value ? Date.now() : null; const result = open().prepare('UPDATE crash_groups SET acknowledged_at=?, acknowledged_by=? WHERE id=?').run(at, value ? userId : null, id); return result.changes ? { acknowledgedAt: at, acknowledgedBy: value ? userId : null } : null; }

module.exports = { capture, list, detail, acknowledge, normalize, fingerprint, classify, safeTail, newestMatching, redact, DEFAULT_RULES, constants: { MAX_CONSOLE_LINES, MAX_FILE_BYTES, MAX_EVIDENCE_CHARS } };
