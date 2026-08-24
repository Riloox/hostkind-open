# Threat Model — Hostkind Upstream Bug Report Relay

Scope: the standalone relay service (`relay/`) that accepts public bug-report
submissions and creates GitHub issues in `Riloox/hostkind-open` with a
server-side GitHub credential.

## Assets

1. **GitHub credential** (fine-grained PAT, or GitHub App token). Scope:
   Issues read/write + Metadata read-only on the one destination repository.
   If compromised: attacker files issues (spam/abuse), reads/writes issue
   metadata in that repo. It grants nothing else.
2. **Queue integrity** — user-submitted reports, idempotency, durability.
3. **Operator trust** — the relay must never embarrass the operator: no
   secret leakage, no arbitrary GitHub API calls billed to the credential.
4. **Host** — the machine running the relay. Physical/OS compromise is out
   of scope here, but the relay must not make host compromise easier.

## Adversaries

- **Anonymous internet callers** (primary): anyone who can reach the tunnel
  hostname. They can submit arbitrary text, replay requests, and probe for
  misconfiguration.
- **Hostkind instances**: legitimate reporters; treated as untrusted input
  sources (a compromised panel is just a spammer).
- **Passive observers**: the tunnel edge, the upstream GitHub API, anyone
  reading the public issue tracker.

## Attack classes and mitigations

### 1. Secret exfiltration via report content
Attacker pastes `ghp_...`/`github_pat_...` tokens, passwords, private keys,
JWT, AWS keys, webhook URLs, credentials-in-URLs into report fields, hoping
they land in the public issue, the queue, logs, or an error response.

- **Redaction before persistence** (`lib/redact-report.cjs`): pattern-based
  redaction of tokens/passwords/keys/emails/IPs/home-path user names runs
  BEFORE the SQLite write and before issue creation. The queue only ever
  stores redacted payloads.
- **No echo of values**: validation errors are field-name + reason only; the
  submitted value is never returned in an error.
- **Redacted errors**: GitHub error bodies (which may echo secrets) are
  redacted twice — by `github-client.cjs` (knows the exact token literal)
  and by the store's `markFailed` — and truncated to 500 chars before
  persistence.
- **Credential in headers only**: the token rides exclusively in the
  Authorization header; never in URLs, bodies, issue bodies, or logs.

### 2. Prompt injection / hostile content in report text
Attacker embeds instructions ("ignore previous instructions…", markdown
headings, fake issue content) hoping the operator or automation acts on it.

- Report text is treated as **data, not instructions**: fixed issue body
  template (`buildIssueBody`), user text Markdown-heading-escaped, labels
  fixed server-side, destination fixed server-side.
- No LLM or automation ever executes content from reports.

### 3. SSRF / arbitrary GitHub API calls
Attacker supplies a repository, URL, or API path hoping the relay calls it
with the credential.

- The contract has **no client-selected repository, URL, label, or API
  path** field — unknown fields are rejected outright by the allowlist
  schema (`validate-report.cjs`).
- Destination (owner/repo/baseUrl) is fixed at construction from
  environment/config (`github-client.cjs`).
- The only outbound URLs the relay ever builds are
  `{base}/repos/{owner}/{repo}/issues` and
  `{base}/search/issues?q=repo:{owner}/{repo} "marker"` with
  `encodeURIComponent` on the fixed owner/repo and a bounded marker charset
  (`clientKey` is `[A-Za-z0-9._-]{8,100}`).

### 4. Spam / resource exhaustion / replay
Anonymous callers can flood the endpoint.

- Per-IP rate limit (10/hour) and global daily budget (500) in-process
  (`rate-limit.cjs`), 32 KiB body cap, field length caps, request timeout,
  GitHub timeout, bounded retry budget (5 attempts, exponential backoff,
  30-day age cap).
- **Replay**: idempotency marker (`clientKey` or server UUID, UNIQUE in
  SQLite) — a replayed submission returns the existing queue entry and can
  never create a duplicate issue.
- Edge rate limiting (Cloudflare WAF/rate rules) is recommended for public
  deployment; in-process limits are a coarse backstop only.

### 5. Duplicate issues from ambiguous timeouts
A create succeeds upstream but the response is lost; the retry must not file
a second issue.

- Marker reconciliation: on retry the worker searches for the marker
  upstream first and adopts the existing issue (`queue-worker.cjs`).
- A malformed 2xx (no issue number) is deliberately non-retryable.

### 6. Queue denial / single bad report stops sync
- The worker never throws out of a sync pass; a corrupt payload is marked
  failed non-retryable and the next row is processed.
- Storage failures are caught and logged; counts still return.

### 7. Information disclosure via responses/logs
- Responses contain only queue/sync state, id, and the public issue URL.
- No stack traces, no internal paths, no GitHub response bodies, no CORS
  headers (server-to-server only), `X-Request-Id` on everything.
- `X-Request-Id` accepts only a bounded safe charset; no other request
  header is reflected.
- `GET /healthz` exposes aggregate queue counts only.
- The relay does not bind a public interface itself: `127.0.0.1` only, and
  only the tunnel publishes it. There is no admin endpoint.

### 8. Credential misconfiguration
- The relay **fails closed** at startup when `RELAY_GITHUB_TOKEN` is missing
  (`githubClientFromEnv` throws; `server.cjs` exits non-zero).
- Non-retryable GitHub authorization failures (401/403/404/422) exhaust the
  retry budget immediately so a broken setup is not hammered or billed.

## Out of scope / residual risks

- **Host/OS compromise** defeats everything app-level; operators must apply
  least privilege, network controls, restricted administrative access, and
  root-only protection for credential files.
- **Credential rotation** is operator discipline; the relay cannot prevent a
  leaked token from being used once it is out.
- **In-memory rate limits reset on restart**; a determined attacker can
  rotate IPs or wait. Edge limiting and, if abuse appears, instance
  registration / CAPTCHA are possible follow-ups for a future release.
- **Email/IP redaction is pattern-based**: unusual encodings (base64,
  unicode homoglyphs) can slip through. Reports are public content; the
  reporter is told to avoid posting credentials.
