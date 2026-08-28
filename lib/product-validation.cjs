'use strict';

// Privacy-safe product validation events and summaries for beta/pricing
// decisions. Directional and bounded: the event layer never carries secrets,
// paths, usernames, descriptions, or raw request data.

const EVENT_TYPES = [
  'first_playable', 'manifest_exported', 'manifest_imported', 'byoc_target_created',
  'pairing_completed', 'restore_verified', 'restore_drill_succeeded', 'pricing_interest', 'byoc_beta_requested',
];

const STRING_FIELDS = ['serverId', 'game', 'plan', 'source'];

function sanitizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const event = {};
  if (EVENT_TYPES.includes(input.type)) event.type = input.type;
  for (const key of STRING_FIELDS) {
    if (typeof input[key] === 'string' && input[key]) event[key] = input[key];
  }
  if (typeof input.value === 'number' && Number.isFinite(input.value)) event.value = input.value;
  if (typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt)) event.occurredAt = input.occurredAt;
  return event;
}

function summarizeEvents(events, options = {}) {
  const { from = -Infinity, to = Infinity } = options || {};
  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0]));
  const funnel = { firstPlayable: 0, byocBetaRequested: 0, pricingInterest: 0, firstToByoc: 0, byocToPricing: 0 };
  const byServer = new Map();

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    if (!EVENT_TYPES.includes(event.type)) continue;
    if (typeof event.occurredAt !== 'number' || event.occurredAt < from || event.occurredAt > to) continue;

    counts[event.type] += 1;
    if (event.type === 'first_playable') funnel.firstPlayable += 1;
    else if (event.type === 'byoc_beta_requested') funnel.byocBetaRequested += 1;
    else if (event.type === 'pricing_interest') funnel.pricingInterest += 1;

    const serverKey = typeof event.serverId === 'string' && event.serverId ? event.serverId : '\u0000';
    if (!byServer.has(serverKey)) byServer.set(serverKey, []);
    byServer.get(serverKey).push(event);
  }

  for (const timeline of byServer.values()) {
    timeline.sort((a, b) => a.occurredAt - b.occurredAt);
    let hasFirst = false;
    let hasByoc = false;
    for (const event of timeline) {
      if (event.type === 'first_playable') hasFirst = true;
      else if (event.type === 'byoc_beta_requested') {
        if (hasFirst) funnel.firstToByoc += 1;
        hasByoc = true;
      } else if (event.type === 'pricing_interest' && hasByoc) {
        funnel.byocToPricing += 1;
      }
    }
  }

  return { counts, funnel };
}

function createRecorder({ now, sink }) {
  const events = [];
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const sinkFn = typeof sink === 'function' ? sink : () => {};
  return {
    record(input) {
      const event = sanitizeEvent(input);
      if (!event.type) return undefined;
      if (typeof event.occurredAt !== 'number') event.occurredAt = nowFn();
      events.push(event);
      sinkFn(event);
      return event;
    },
    all() {
      return events.slice();
    },
  };
}

module.exports = { EVENT_TYPES, sanitizeEvent, summarizeEvents, createRecorder };