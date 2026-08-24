# Hostkind Upstream Bug Report Relay

A small, standalone relay service that accepts validated bug-report payloads
from Hostkind instances and creates issues in a **fixed** upstream GitHub
repository (`Riloox/hostkind-open`) using a server-side credential.

The relay is deliberately separate from the Hostkind panel: it runs as an
independent service, owns its own SQLite queue, and is exposed only through a
separately managed edge layer. See `THREAT-MODEL.md` for the adversary model
this design defends against.

## Scope of this directory

| Path | Purpose |
| --- | --- |
| `server.cjs` | HTTP service: `POST /v1/reports`, `GET /healthz` |
| `lib/validate-report.cjs` | Pure, strict payload validation (allowlist schema, limits) |
| `lib/redact-report.cjs` | Secret-pattern redaction applied BEFORE persistence |
| `lib/store.cjs` | Durable SQLite queue with idempotency marker + retry gating |
| `lib/queue-worker.cjs` | Bounded-retry GitHub sync worker (injected client) |
| `lib/github-client.cjs` | Standalone GitHub Issues client (env credential, fail closed) |
| `lib/rate-limit.cjs` | In-memory fixed-window limiter (per-IP + daily budget) |

## Contract

### `POST /v1/reports`

Requests must be `Content-Type: application/json`, at most **32 KiB** total.
The body is a single JSON object with the allowlisted fields below.
**Unknown fields are rejected.** `title` and `description` are required;
every other field is optional and trimmed (empty strings normalize to
`null`).

| Field | Type | Max length | Notes |
| --- | --- | --- | --- |
| `title` | string | 200 | required |
| `description` | string | 20 000 | required |
| `reproSteps` | string | 5 000 | reproduction steps |
| `expected` | string | 5 000 | expected behaviour |
| `game` | string | 500 | game id, e.g. `minecraft` |
| `view` | string | 500 | panel view name |
| `route` | string | 500 | panel route, e.g. `/servers` |
| `userAgent` | string | 1 000 | browser user agent |
| `version` | string | 500 | Hostkind version |
| `clientKey` | string | 8–100 | optional client idempotency key; `[A-Za-z0-9._-]` only |

There is **no credential field** and **no client-selected repository, URL,
label, or GitHub API path** anywhere in the contract. The destination
repository, labels, and API base URL are fixed server-side.

**Responses** (JSON; never contain report content, credentials, stack traces,
or GitHub response bodies):

| Status | Meaning | Body |
| --- | --- | --- |
| `201` | issue created synchronously | `{ id, status: "synced", issueUrl, issueNumber }` |
| `202` | report queued for sync | `{ id, status: "queued", issueUrl: null, issueNumber: null }` |
| `400` | validation / invalid JSON | `{ error, errors[], requestId }` |
| `413` | body over 32 KiB | `{ error, errors[], requestId }` |
| `415` | non-JSON content type | `{ error, errors[], requestId }` |
| `429` | rate limited / daily budget | `{ error, errors[], requestId }` |
| `404` | unknown route | `{ error, errors[], requestId }` |
| `500` | internal error (generic) | `{ error, errors[], requestId }` |

Every response carries `X-Request-Id` (generated or a bounded caller value).

### `GET /healthz`

`200 { status: "ok", queue: { total, pending, failed, synced } }` — no
sensitive details.

### Queue and sync semantics

- A report is **persisted in SQLite before any GitHub call**.
- Idempotency marker: `clientKey` when supplied, otherwise a server-generated
  `relay-<uuid>`. Re-submitting the same marker returns the existing queue
  entry — it can never create a duplicate issue.
- On retry, the worker searches for the marker upstream first and adopts an
  existing issue instead of creating a new one.
- Retries are bounded: max 5 attempts, exponential backoff
  (`60s * 2^(attempts-1)`), max age 30 days. Non-retryable GitHub errors
  (401/403/404/422) exhaust the budget immediately.
- One bad report cannot stop the queue; the worker never throws out of a
  sync pass.

### Abuse controls

- Per-IP limit: 10 submissions/hour (in-memory; reset on restart).
- Global daily budget: 500 submissions (in-memory).
- These are coarse in-process controls; put real rate limiting at the edge
  (Cloudflare WAF/rate rules) for a public deployment.

## Running

The relay is a standalone Node service (Node >= 22, CommonJS). It uses
`better-sqlite3` and `express` — both already present in the repository root
`node_modules`; `npm install` inside `relay/` is not required for the tests.

```bash
# From the repository root — syntax check and relay test suite:
npm run check --prefix relay
npm run test --prefix relay

# Production start (the process entry point — binds 127.0.0.1 only):
RELAY_GITHUB_TOKEN=... \
RELAY_GITHUB_OWNER=Riloox \
RELAY_GITHUB_REPO=hostkind-open \
RELAY_DATA_DIR=/var/lib/fleetdeck-relay \
node relay/server.cjs
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_GITHUB_TOKEN` | — (required) | fine-grained PAT; the relay **fails closed** at startup when missing |
| `RELAY_GITHUB_OWNER` | `Riloox` | fixed destination owner |
| `RELAY_GITHUB_REPO` | `hostkind-open` | fixed destination repository |
| `RELAY_GITHUB_BASE_URL` | `https://api.github.com` | API base (tests / enterprise) |
| `RELAY_GITHUB_TIMEOUT_MS` | `15000` | GitHub request timeout |
| `RELAY_DATA_DIR` | `relay/data` | SQLite data directory |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8787` | bind address — do NOT bind `0.0.0.0` |

The token is never placed in React code, config files, request bodies, issue
bodies, logs, or responses. If a token is ever exposed, rotate it immediately
(see the rotation procedure in the plan, Task 8).

## Tests

```bash
node test/bug-report-relay-contract.test.cjs
node test/bug-report-relay-validation.test.cjs
node test/bug-report-relay-queue.test.cjs
node test/bug-report-relay-http.test.cjs
```

All tests are hermetic: SQLite databases live in temp directories, GitHub
calls are injected fake clients, and no live network or secret is used.
