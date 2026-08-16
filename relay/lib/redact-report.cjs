'use strict';

/*
 * Report redaction for the standalone relay.
 *
 * Every submitted report is treated as PUBLIC content once it reaches the
 * upstream issue tracker. This module is the single source of truth for what
 * "secret-like" looks like in report text. Redaction runs BEFORE persistence
 * (the SQLite queue only ever stores redacted payloads) and the GitHub issue
 * body is built from the redacted payload, so a pasted token can never reach
 * the queue, a log, an error, or the upstream issue.
 *
 * Rule set (documented in relay/THREAT-MODEL.md):
 *   - password/secret/token key:value assignments
 *   - console password commands (password <pass>)
 *   - GitHub PATs (ghp_ / github_pat_), Bearer headers, JWTs, AWS keys
 *   - PEM private key blocks, Discord webhook URLs
 *   - email addresses and IP addresses
 *   - credentials embedded in URLs (user:pass@host, ?token=...)
 *   - OS user names inside home paths (C:\Users\<name>, /home/<name>) —
 *     the path structure is kept so the bug report stays readable while the
 *     machine's user name is masked
 *
 * The redactor is deliberately conservative about free-form prose: it does
 * NOT strip arbitrary paths or console logs (those are bounded by the body
 * size limit and field caps in validate-report.cjs and are usually the
 * useful part of a bug report).
 */

const RULES = [
  {
    name: 'secret-assignment',
    // password=/token=/"secret": "value" forms — key must look like a secret
    // key, value is quoted or a bare token.
    pattern: /("?(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|client[-_]?secret|authorization|auth)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;'"}\]]+)/gi,
    mask: '$1[REDACTED]',
  },
  {
    name: 'console-password',
    // A game console takes a password as a bare argument (Terraria `password
    // <pass>`, TShock `/password <pass>`). Anchored to line start so prose
    // containing the word does not fire.
    pattern: /^(\s*\/?(?:password|setpassword|passwd)\s+)\S+/gim,
    mask: '$1[REDACTED]',
  },
  {
    name: 'github-pat',
    pattern: /(?:github_pat_|ghp_)[A-Za-z0-9_]+/g,
    mask: '[REDACTED]',
  },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g,
    mask: 'Bearer [REDACTED]',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    mask: '[REDACTED_JWT]',
  },
  {
    name: 'aws-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    mask: '[REDACTED_AWS_KEY]',
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    mask: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'discord-webhook',
    pattern: /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    mask: '[REDACTED_WEBHOOK]',
  },
  {
    name: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    mask: '[REDACTED_EMAIL]',
  },
  {
    name: 'ipv4',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: '[REDACTED_IP]',
  },
  {
    name: 'ipv6',
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    mask: '[REDACTED_IPV6]',
  },
  {
    name: 'url-credentials',
    pattern: /(https?:\/\/)[^/@\s]+@/gi,
    mask: '$1[REDACTED]@',
  },
  {
    name: 'url-query-secret',
    pattern: /([?&](?:token|key|api[-_]?key|access[-_]?token|sig(?:nature)?|secret|password|auth(?:orization)?|code)=)[^&\s]+/gi,
    mask: '$1[REDACTED]',
  },
  {
    name: 'win-home-user',
    pattern: /(C:\\Users\\)[^\\\s]+(?=\\)/gi,
    mask: '$1[REDACTED]',
  },
  {
    name: 'posix-home-user',
    pattern: /(\/home\/)[^/\s]+/g,
    mask: '$1[REDACTED]',
  },
];

/*
 * Redact a single string. Returns { text, hits } where hits lists the rule
 * names that fired (used by tests and the store's error path).
 */
function redactString(input) {
  if (input == null) return { text: '', hits: [] };
  let text = String(input);
  const hits = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      hits.push(rule.name);
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.mask);
    }
  }
  return { text, hits };
}

/*
 * Deep-redact a report object: returns { report, hits } where report is a
 * new object with every string leaf redacted and hits maps field -> [rules].
 * Non-string leaves are preserved untouched.
 */
function redactReport(value, depth = 0) {
  if (depth > 16) return { report: null, hits: { depth: ['redact-depth-limit'] } };
  if (value == null) return { report: value, hits: {} };
  if (typeof value === 'string') {
    const r = redactString(value);
    return r.hits.length ? { report: r.text, hits: r.hits } : { report: value, hits: [] };
  }
  if (Array.isArray(value)) {
    const out = [];
    const hits = {};
    for (let i = 0; i < value.length; i += 1) {
      const r = redactReport(value[i], depth + 1);
      out.push(r.report);
      if (Object.keys(r.hits).length > 0) hits[`[${i}]`] = r.hits;
    }
    return { report: out, hits };
  }
  if (typeof value === 'object') {
    const out = {};
    const hits = {};
    for (const key of Object.keys(value)) {
      const r = redactReport(value[key], depth + 1);
      out[key] = r.report;
      if (Object.keys(r.hits).length > 0) hits[key] = r.hits;
    }
    return { report: out, hits };
  }
  return { report: value, hits: {} };
}

/*
 * True when any redaction rule fires on the text. Convenience for tests.
 */
function containsSecret(text) {
  return redactString(text).hits.length > 0;
}

module.exports = { redactString, redactReport, containsSecret, RULES };
