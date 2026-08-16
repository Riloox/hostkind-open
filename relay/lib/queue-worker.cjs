'use strict';

/*
 * Queue worker for the standalone relay.
 *
 * Bridges the durable SQLite queue and the GitHub client: claims pending
 * rows, creates issues (reconciling by idempotency marker on retries first),
 * and records success/failure back on the row. A failed sync NEVER throws
 * out of runOnce() — the failure is recorded on the row for a later bounded
 * retry. Reports are durable in SQLite BEFORE any network call (enqueue
 * happens in the HTTP layer before runOnce is ever invoked).
 *
 * Retry policy: transient errors (network/5xx/429) bump attempts by one and
 * let the store's exponential backoff gate the next run; configuration
 * failures (auth/forbidden/not-found/validation) exhaust the budget
 * immediately so a broken setup is not hammered.
 *
 * Idempotency: when a row is retried (attempts > 0), the worker first asks
 * the client to search for the marker upstream. If the issue already exists
 * (an ambiguous earlier timeout), that issue is adopted instead of creating
 * a duplicate. Retrying therefore cannot create duplicate issues.
 *
 * The GitHub client is INJECTED (duck-typed { createIssue, findIssueByMarker })
 * so tests use fake clients and the relay never hard-codes a credential.
 */

const { buildIssueBody } = require('./github-client.cjs');
const { redactString } = require('./redact-report.cjs');

const DAY_MS = 86_400_000;

const noopLogger = { warn() {} };

function defaultBuildBody(report) {
  const p = report.payload || {};
  return buildIssueBody({
    summary: report.title,
    description: p.description,
    reproSteps: p.reproSteps,
    expected: p.expected,
    route: p.route,
    view: p.view,
    game: p.game,
    timestamp: report.created_at ? new Date(report.created_at).toISOString() : null,
    version: p.version,
    userAgent: p.userAgent,
    marker: report.marker,
  });
}

function createQueueWorker(deps = {}) {
  const client = deps.client;
  if (!client || typeof client.createIssue !== 'function') {
    throw new Error('relay-queue-worker: client (github) is required');
  }
  const store = deps.store;
  if (!store || typeof store.listPending !== 'function') {
    throw new Error('relay-queue-worker: store is required');
  }
  const buildBody = typeof deps.buildBody === 'function' ? deps.buildBody : defaultBuildBody;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const maxAttempts = deps.maxAttempts !== undefined ? deps.maxAttempts : 5;
  const backoffBaseMs = deps.backoffBaseMs !== undefined ? deps.backoffBaseMs : 60_000;
  const maxAgeMs = deps.maxAgeMs !== undefined ? deps.maxAgeMs : 30 * DAY_MS;
  const maxBatch = deps.maxBatch !== undefined ? deps.maxBatch : 10;
  const inFlight = deps.inFlight instanceof Set ? deps.inFlight : new Set();
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : noopLogger;

  /*
   * Error classification: retryable errors keep retrying (attempts+1);
   * everything else exhausts the budget so a config failure cannot be
   * hammered forever. Non-GitHubApiError throws are non-retryable.
   */
  function budgetAttempts(report, err) {
    return err && err.retryable === true ? report.attempts + 1 : maxAttempts;
  }

  /*
   * Process one report. Never throws: every failure path lands in
   * markFailed. Returns { succeeded } | { failed } | { skipped }.
   */
  async function processReport(report) {
    if (inFlight.has(report.id)) return { skipped: true };
    inFlight.add(report.id);
    try {
      if (report.payload == null) {
        // Corrupt persisted payload: nothing sane to send, never retry.
        store.markFailed(report.id, {
          error: 'relay-queue-worker: stored payload is not valid JSON',
          attempts: maxAttempts,
        }, { now: now() });
        return { failed: true };
      }

      let outcome;
      try {
        // On a retry, reconcile first: if the marker already exists upstream
        // (ambiguous previous timeout), adopt that issue instead of risking
        // a duplicate. A search failure is ambiguous — record it and do NOT
        // create.
        if (report.attempts > 0 && typeof client.findIssueByMarker === 'function') {
          const found = await client.findIssueByMarker(report.marker);
          if (found) {
            store.markSynced(report.id, {
              issueNumber: found.issueNumber,
              issueUrl: found.issueUrl,
            }, { now: now() });
            return { succeeded: true };
          }
        }

        const created = await client.createIssue({
          title: report.title,
          body: buildBody(report),
          marker: report.marker,
        });
        store.markSynced(report.id, {
          issueNumber: created.issueNumber,
          issueUrl: created.issueUrl,
        }, { now: now() });
        outcome = { succeeded: true };
      } catch (err) {
        const attempts = budgetAttempts(report, err);
        const message = err && err.message ? String(err.message) : String(err);
        const redacted = redactString(message).text;
        store.markFailed(report.id, { error: redacted, attempts }, { now: now() });
        logger.warn(`relay-queue-worker: report ${report.id} failed (attempts=${attempts}): ${redacted}`);
        outcome = { failed: true };
      }
      return outcome;
    } finally {
      inFlight.delete(report.id);
    }
  }

  /*
   * One bounded sync pass. Never rejects.
   * Returns { attempted, succeeded, failed, skipped }.
   */
  async function runOnce() {
    const counts = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    let rows = [];
    try {
      rows = store.listPending({
        now: now(),
        maxAttempts,
        backoffBaseMs,
        maxAgeMs,
        limit: maxBatch,
      });
    } catch (err) {
      logger.warn(`relay-queue-worker: listPending failed: ${err && err.message ? err.message : err}`);
      return counts;
    }

    for (const report of rows) {
      counts.attempted += 1;
      let result;
      try {
        result = await processReport(report);
      } catch (err) {
        // Defensive: storage failures inside processReport must not escape.
        logger.warn(`relay-queue-worker: unexpected error on report ${report.id}: ${err && err.message ? err.message : err}`);
        result = { failed: true };
      }
      if (result.skipped) {
        counts.attempted -= 1;
        counts.skipped += 1;
      } else if (result.succeeded) {
        counts.succeeded += 1;
      } else if (result.failed) {
        counts.failed += 1;
      }
    }
    return counts;
  }

  return { runOnce };
}

module.exports = { createQueueWorker, defaultBuildBody };
