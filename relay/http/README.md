# Relay HTTP service (`relay/http/`)

Narrow HTTP surface for the upstream bug-report relay.

## Endpoints

| Method | Path          | Purpose                                                              |
| ------ | ------------- | -------------------------------------------------------------------- |
| POST   | `/v1/reports` | Accept a validated bug-report payload; enqueue it durably            |
| GET    | `/healthz`    | Liveness probe; returns `{"status":"ok"}` with no sensitive details  |

Everything else (unknown paths, wrong methods, admin routes) returns a
uniform JSON `404`. There is no admin endpoint.

## POST /v1/reports

- `Content-Type` must be `application/json` (or `*+json`) — anything else is `415`.
- Body limit: **32 KiB** by default (`413 payload_too_large` above it).
- Fields (camelCase, matching the Hostkind store): `title` (required, ≤200),
  `description` (required), `actorId`, `actorUsername`, `game`, `view`, `route`
  (≤500), `reproSteps`, `expected` (≤5000), `userAgent` (≤1000), `version`
  (≤100), `marker` (≤100, `[A-Za-z0-9._-]`). Unknown fields are **dropped**;
  credential-shaped fields (`token`, `password`, `secret`, `authorization`,
  …) are rejected with `400 forbidden_field`.
- Responses:
  - `202` `{ "id": "<report-id>", "state": "queued", "issueUrl": null }` — queued (default).
  - `201` `{ "id": "<report-id>", "state": "synced", "issueUrl": "…" }` — only when the
    queue adapter reports a synchronous sync.
  - `400` validation (`invalid_json`, `title_required`, `description_required`,
    `field_invalid`, `field_too_long`, `forbidden_field`), `413`, `415`,
    `429 rate_limited` (with `Retry-After`), `503 timeout` / `503 unavailable`,
    `500 internal_error`. Error bodies are fixed strings — never stack traces,
    never GitHub bodies, never the submitted values, never internal paths.

The response contains only queue/sync state, the report id, and a public
issue URL when available. No credentials, no client-selected repository/URL.

## Request IDs and logging

Every response carries `X-Request-Id`. A client-supplied id is honoured only
when it matches `^[A-Za-z0-9._-]{1,64}$`; otherwise a server-side UUID is
generated. Log lines are structured and redacted: method, normalized route,
status, duration, request id. Bodies and headers are never logged; error
detail is token-redacted (`ghp_`, `github_pat_`, `Bearer …`).

## Rate limiting

Four fixed-window limiters run **before** body parsing (abuse control wins):
per-IP (`ip`), per-instance (`instance`), hourly and daily global budgets.
Defaults:

```js
ip:       { max: 10,   windowMs: 60_000 }
instance: { max: 600,  windowMs: 60_000 }
hourly:   { max: 1000, windowMs: 3_600_000 }
daily:    { max: 5000, windowMs: 86_400_000 }
```

`/healthz` is never rate-limited. The IP source defaults to the TCP peer
(`ipSource: 'socket'`), which is spoof-proof and correct when a Cloudflare
Tunnel terminates on the same host; set `ipSource: 'forwarded'` only behind
a trusted proxy that overwrites `X-Forwarded-For`.

## Wiring (dependency injection)

```js
const { createRelayServer } = require('./server.cjs');

const { app } = createRelayServer({
  enqueue: async (report, { requestId }) => {
    // durable queue adapter (Task 3: relay/lib/store.cjs). Must return
    // { id, state?, issueUrl? }; a resolve without id, or a reject, => 503.
  },
  validate: (body) => ({ ok: true, report }),   // Task 2 validator; defaults to the built-in strict validator
  logger: { info, warn, error },                // structured, redacted
  limits: { ip: {...}, instance: {...}, hourly: {...}, daily: {...} },
  bodyLimitBytes: 32 * 1024,
  requestTimeoutMs: 10_000,
  allowedOrigins: [],                           // [] = no CORS headers
  ipSource: 'socket',
  now: Date.now,
  requestId: crypto.randomUUID,
  limiterStore: new Map(),                      // injectable for tests
});
```

`createRelayServer()` throws when `enqueue` is missing — the relay fails
closed. Bind the server to `127.0.0.1` only and place public exposure behind
a separately managed edge layer. No credential is ever requested or stored by
this module.

## Tests

```bash
node test/bug-report-relay-http.test.cjs
```

In-process HTTP tests against an ephemeral-port server with injected fakes —
no network, no secrets, no long-running process.
