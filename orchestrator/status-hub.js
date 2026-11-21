// Status hub (spec §9): one reading per source, shared by every client, with an honest freshness label.
// Every item says where its value came from (source), when the source measured it (observedAt), when we got
// it (receivedAt) and whether it is fresh, stale, unknown or an error. A value nobody measured is unknown —
// never a 0%. Only what the vendor reports is shown: percentages and reset times, no invented remainders.
const { EventEmitter } = require('node:events');

const KINDS = new Set(['quota', 'login', 'models', 'version', 'availability', 'upgrade']);
const FRESHNESS = new Set(['fresh', 'stale', 'unknown', 'error']);
// Sources that are not a documented vendor API are marked, so the client can say so (D12).
const UNOFFICIAL = new Set(['claude_usage']);
const DEFAULT_PERIOD_MS = 60_000;
const MIN_READ_INTERVAL_MS = 10_000;

function iso(value) {
  if (value === undefined || value === null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function freshness({ value, observedAt, error, periodMs = DEFAULT_PERIOD_MS, now = Date.now() }) {
  if (error) return 'error';
  const time = observedAt ? Date.parse(observedAt) : NaN;
  if (value === undefined || value === null || !Number.isFinite(time)) return 'unknown';
  return now - time > 2 * periodMs ? 'stale' : 'fresh';
}

function item({ provider, kind, value = null, source = null, observedAt = null, receivedAt, periodMs = DEFAULT_PERIOD_MS,
  error = null, estimated = false, now = Date.now() }) {
  if (!KINDS.has(kind)) throw new Error('invalid_status_kind');
  const observed = iso(observedAt);
  const result = {
    provider, kind, value: value ?? null, source, observedAt: observed, receivedAt: iso(receivedAt ?? now),
    periodMs, error: error ? String(error).slice(0, 200) : null, estimated: Boolean(estimated),
    unofficial: UNOFFICIAL.has(source),
  };
  result.freshness = freshness({ value: result.value, observedAt: observed, error: result.error, periodMs, now });
  return result;
}

// Turns the orchestrator's quotaStatus() result into status items. Windows without a reading stay null.
function quotaItems(list, { now = Date.now(), periodMs = DEFAULT_PERIOD_MS, receivedAt = now } = {}) {
  return (Array.isArray(list) ? list : []).map((entry) => {
    const usable = entry.state === 'available' && Array.isArray(entry.buckets) && entry.buckets.length;
    const value = usable ? {
      buckets: entry.buckets.map(({ id, fiveHour, weekly }) => ({
        id,
        fiveHour: fiveHour ? { usedPercent: fiveHour.usedPercent, ...(fiveHour.resetsAt && { resetsAt: fiveHour.resetsAt }) } : null,
        weekly: weekly ? { usedPercent: weekly.usedPercent, ...(weekly.resetsAt && { resetsAt: weekly.resetsAt }) } : null,
      })),
    } : null;
    const error = entry.state === 'unavailable' && entry.reason && entry.reason !== 'no_quota_source' ? entry.reason : null;
    return item({ provider: entry.provider, kind: 'quota', value, source: entry.source || (entry.estimated ? 'call_limits' : null),
      observedAt: usable ? entry.observedAt : null, receivedAt, periodMs, error, estimated: Boolean(entry.estimated), now });
  });
}

// readers: { name: async () => [item-like objects] }. A reader that throws yields one error item for its name.
class StatusHub extends EventEmitter {
  constructor({ readers = {}, periodMs = DEFAULT_PERIOD_MS, minIntervalMs = MIN_READ_INTERVAL_MS, now = Date.now } = {}) {
    super();
    this.readers = readers;
    this.periodMs = periodMs;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.items = new Map();
    this.lastRead = 0;
    this.reading = null;
    this.timer = null;
  }

  key(value) { return value.provider + '/' + value.kind; }

  snapshot() {
    const now = this.now();
    // Freshness is recomputed when read, so a value nobody refreshed turns stale by itself.
    return [...this.items.values()].map((value) => ({ ...value,
      freshness: freshness({ value: value.value, observedAt: value.observedAt, error: value.error, periodMs: value.periodMs, now }) }));
  }

  publish(values) {
    const changed = [];
    for (const raw of values) {
      const value = raw.freshness && FRESHNESS.has(raw.freshness) && raw.receivedAt ? raw
        : item({ periodMs: this.periodMs, now: this.now(), ...raw });
      const key = this.key(value);
      const before = this.items.get(key);
      this.items.set(key, value);
      if (!before || JSON.stringify({ ...before, receivedAt: 0 }) !== JSON.stringify({ ...value, receivedAt: 0 })) changed.push(value);
    }
    if (changed.length) this.emit('updated', changed);
    return changed;
  }

  // Reads all sources at most once per minIntervalMs; concurrent callers share one reading.
  refresh({ force = false } = {}) {
    if (this.reading) return this.reading;
    if (!force && this.now() - this.lastRead < this.minIntervalMs) return Promise.resolve(this.snapshot());
    this.reading = (async () => {
      const results = await Promise.all(Object.entries(this.readers).map(async ([name, read]) => {
        try { return await read(); }
        catch (error) { return [{ provider: name, kind: 'availability', error: error.message || 'status_read_failed' }]; }
      }));
      this.lastRead = this.now();
      this.publish(results.flat().filter(Boolean));
      return this.snapshot();
    })().finally(() => { this.reading = null; });
    return this.reading;
  }

  subscribe(listener) {
    this.on('updated', listener);
    return () => this.off('updated', listener);
  }

  start(intervalMs = this.periodMs) {
    this.stop();
    this.timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
    this.timer.unref?.();
    return this.refresh();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { StatusHub, item, quotaItems, freshness, KINDS, UNOFFICIAL, DEFAULT_PERIOD_MS };
