'use strict';

/*
 * Redactor: the single source of truth for what "secret-like" looks like.
 *
 * Spec contract: "Logs, responses, exports, operation summaries, and audit
 * records use the same secret redactor." So this is a leaf module - audit,
 * operations, downloads, archive errors, and the REST error path all funnel
 * through redactString() / redactObject() to keep the rule set in one place.
 *
 * The default rule set covers the kinds of secrets Hostkind actually has or
 * can see: passwords, JWTs, webhook URLs, API keys, scrypt hashes, Minecraft
 * player names, IP addresses, and so on. Each rule is a {name, pattern, mask}
 * triple. Adding a new secret type = adding a rule here, not chasing call
 * sites.
 */

const SECRET_PATTERNS = [
  { name: 'password',   pattern: /("?(?:password|passwd|pwd)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;'"]+)/gi, mask: '$1[REDACTED]' },
  // A game console takes its password as a bare argument, not a key/value pair:
  // Terraria's `password <pass>`, TShock's `/password <pass>`. Anchored to the
  // start of the text so it only fires on something shaped like a command, and
  // not on prose that happens to contain the word.
  { name: 'console-password', pattern: /^(\s*\/?(?:password|setpassword|passwd)\s+)\S+/gim, mask: '$1[REDACTED]' },
  { name: 'jwt',        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mask: '[REDACTED_JWT]' },
  { name: 'bearer',     pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}\b/g, mask: 'Bearer [REDACTED]' },
  { name: 'discord-webhook', pattern: /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, mask: '[REDACTED_WEBHOOK]' },
  { name: 'modrinth-token', pattern: /modrinth[_A-Za-z]*[Tt]oken\s*[:=]\s*[^\s,;'"]+/g, mask: 'modrinth_token=[REDACTED]' },
  { name: 'curseforge-key', pattern: /\$CF_[A-Za-z0-9]{8,}|\bcurseforge[-_ ]?api[-_ ]?key\s*[:=]\s*[^\s,;'"]+/gi, mask: '[REDACTED_API_KEY]' },
  { name: 'aws-key',    pattern: /\bAKIA[0-9A-Z]{16}\b/g, mask: '[REDACTED_AWS_KEY]' },
  { name: 's3',         pattern: /s3[:_-][A-Za-z0-9+/=_-]{20,}/g, mask: '[REDACTED_S3]' },
  { name: 'ssh-key',    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, mask: '[REDACTED_PRIVATE_KEY]' },
  { name: 'scrypt-hash', pattern: /[0-9a-f]{32}:[0-9a-f]{64,}/g, mask: '[REDACTED_HASH]' },
  { name: 'ip',         pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, mask: '[REDACTED_IP]' },
  { name: 'ipv6',       pattern: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, mask: '[REDACTED_IPV6]' },
];

/*
 * Redact a single string. Returns a new string with all matches replaced.
 * The list of rules that fired is returned alongside (for tests / debugging).
 */
function redactString(input) {
  if (input == null) return { text: '', hits: [] };
  let text = String(input);
  const hits = [];
  for (const rule of SECRET_PATTERNS) {
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
 * Walk an object/array and redact every string leaf. Non-string leaves are
 * preserved as-is. Cycles are tolerated (we cap depth to keep stack bounded).
 * Keys whose name suggests they hold a secret have their value masked even
 * if the value's text doesn't match a pattern.
 */
const SECRET_KEYS = new Set([
  'password', 'passwd', 'pwd', 'token', 'secret', 'apikey', 'api_key',
  'privatekey', 'private_key', 'authorization', 'auth', 'jwt', 'webhook',
  'webhookurl', 'webhook_url', 'clientsecret', 'client_secret',
  'accesskey', 'access_key', 'sessionid', 'session_id',
]);

function isSecretKey(k) {
  if (!k) return false;
  const lower = String(k).toLowerCase();
  if (SECRET_KEYS.has(lower)) return true;
  if (lower.endsWith('token') || lower.endsWith('password') || lower.endsWith('secret')) return true;
  if (lower.startsWith('x-api') || lower.startsWith('x-auth')) return true;
  return false;
}

function redactObject(value, depth = 0) {
  if (depth > 16) return '[REDACTED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value).text;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (isSecretKey(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObject(value[k], depth + 1);
      }
    }
    return out;
  }
  return value;
}

module.exports = { redactString, redactObject, SECRET_PATTERNS };
