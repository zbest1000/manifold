/**
 * Live state for the UNS topology: which branches are publishing, the latest
 * value per leaf, per-branch rates and inter-arrival statistics. Module-level
 * maps so the draw loop and the detail panel read them without React renders.
 */

export const LIVE_WINDOW_MS = 10_000; // a branch counts as "publishing" this long after a message

// `${brokerId}:${path}` -> last-message ts
export const unsLiveMap = new Map();
// `${brokerId}:${path}` -> { value, ts } for LEAF topics
export const unsValueMap = new Map();
// Rolling msgs/s per path (aggregated up the ancestor chain), rolled each second
export const unsRateMap = new Map();
const rateCounters = new Map();
// Inter-arrival EMA per leaf: the basis for honest staleness. A topic publishing
// every 500ms is "overdue" seconds after it stops; a daily report isn't.
const gapStats = new Map(); // key -> { emaGap, lastTs }
// Last time ANY message hit the namespace: the idle-throttle signal for the draw loop.
export const liveMeta = { lastDataAt: 0 };

export function resetLiveState() {
  unsLiveMap.clear();
  unsValueMap.clear();
  unsRateMap.clear();
  rateCounters.clear();
  gapStats.clear();
  liveMeta.lastDataAt = 0;
}

export function lastActive(node) {
  return unsLiveMap.get(`${node.brokerId}:${node.path}`) || 0;
}

export function nodeValue(node) {
  return unsValueMap.get(`${node.brokerId}:${node.path}`) || null;
}

export function nodeRate(node) {
  return unsRateMap.get(`${node.brokerId}:${node.path}`) || 0;
}

/**
 * Staleness verdict for a leaf topic: null (not enough data yet), 'fresh',
 * 'overdue' (3x its own typical interval, min 15s), or 'dead' (10x, min 2min).
 */
export function staleness(node, now = Date.now()) {
  const s = gapStats.get(`${node.brokerId}:${node.path}`);
  if (!s || !s.emaGap) return null;
  const age = now - s.lastTs;
  if (age > Math.max(s.emaGap * 10, 120_000)) return 'dead';
  if (age > Math.max(s.emaGap * 3, 15_000)) return 'overdue';
  return 'fresh';
}

export function expectedInterval(node) {
  const s = gapStats.get(`${node.brokerId}:${node.path}`);
  return s?.emaGap || 0;
}

export function formatValue(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'object') {
    try {
      return JSON.stringify(payload);
    } catch {
      return '[object]';
    }
  }
  return String(payload);
}

const fmtNumber = (n) => (Number.isInteger(n) ? n.toLocaleString() : Number(n.toFixed(Math.abs(n) < 1 ? 3 : 2)).toLocaleString());

/**
 * A short, readable value for the canvas caption: a value envelope
 * ({ value|v, unit|u }) shows as "57 C", numbers get at most 3 decimals, other
 * objects fall back to compact JSON.
 */
export function displayValue(payload) {
  if (typeof payload === 'number') return Number.isFinite(payload) ? fmtNumber(payload) : String(payload);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const v = 'value' in payload ? payload.value : 'v' in payload ? payload.v : undefined;
    if (v !== undefined && (typeof v !== 'object' || v === null)) {
      const unit = typeof payload.unit === 'string' ? payload.unit : typeof payload.u === 'string' ? payload.u : '';
      const text = typeof v === 'number' ? fmtNumber(v) : String(v);
      return unit ? `${text} ${unit}` : text;
    }
  }
  return formatValue(payload);
}

/**
 * Stamp every ancestor path of an incoming message, count it for per-branch
 * rates, and record the leaf's value + inter-arrival EMA.
 */
export function recordActivity(msg, now = Date.now()) {
  if (!msg?.topic || msg.topic.startsWith('$')) return;
  liveMeta.lastDataAt = now;
  const rootKey = `${msg.brokerId}:`;
  unsLiveMap.set(rootKey, now);
  rateCounters.set(rootKey, (rateCounters.get(rootKey) || 0) + 1);
  const segs = msg.topic.split('/').filter(Boolean);
  let path = '';
  for (let i = 0; i < segs.length; i++) {
    path = i === 0 ? segs[i] : `${path}/${segs[i]}`;
    const key = `${msg.brokerId}:${path}`;
    unsLiveMap.set(key, now);
    rateCounters.set(key, (rateCounters.get(key) || 0) + 1);
  }
  const leafKey = `${msg.brokerId}:${path}`;
  unsValueMap.set(leafKey, { value: formatValue(msg.payload), display: displayValue(msg.payload), ts: now });
  const s = gapStats.get(leafKey);
  if (s) {
    const gap = now - s.lastTs;
    // Ignore sub-5ms bursts (coalesced batch replay) for the interval model.
    if (gap > 5) s.emaGap = s.emaGap ? 0.3 * gap + 0.7 * s.emaGap : gap;
    s.lastTs = now;
  } else {
    gapStats.set(leafKey, { emaGap: 0, lastTs: now });
  }
}

/** Roll the per-second counters into rates (call once a second). */
export function rollRates() {
  unsRateMap.clear();
  for (const [key, count] of rateCounters) unsRateMap.set(key, count);
  rateCounters.clear();
}
