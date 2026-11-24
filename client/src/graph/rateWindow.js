/**
 * Sliding-window rate over a monotonically increasing counter.
 *
 * Why this exists: the UNS badge used to count message-bus events in 1-second
 * buckets and reset to zero each tick. The server coalesces traffic (one
 * forwarded message per topic per flush, and it samples beyond a cap), so a
 * bucket that fell between flushes read 0/s while data was flowing. The honest
 * signal is the server's own `messagesReceived` counter: rate = delta over a
 * window of several samples.
 */

export function createRateWindow(windowMs = 10_000) {
  let samples = []; // [{ t, c }] oldest first
  return {
    /** Record the counter value observed at time `t` (ms). */
    push(t, c) {
      const last = samples[samples.length - 1];
      if (last && c < last.c) samples = []; // counter reset (reconnect / restart)
      samples.push({ t, c });
      const cutoff = t - windowMs;
      // Keep one sample at/before the cutoff so the window spans its full length.
      while (samples.length > 2 && samples[1].t <= cutoff) samples.shift();
    },
    /** Messages per second over the window, or null with fewer than 2 samples. */
    rate() {
      if (samples.length < 2) return null;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0) return null;
      return Math.max(0, (b.c - a.c) / dt);
    },
    reset() {
      samples = [];
    },
    size: () => samples.length
  };
}

/** Sum a numeric metrics field over the brokers in scope (missing -> null). */
export function sumBrokerCounter(brokers, ids, field = 'messagesReceived') {
  let total = 0;
  let seen = false;
  for (const b of brokers) {
    if (ids && !ids.includes(b.id)) continue;
    const v = b.metrics?.[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

export function formatRate(r) {
  if (r == null || !Number.isFinite(r)) return '0';
  if (r >= 100) return Math.round(r).toLocaleString();
  if (r >= 10) return r.toFixed(0);
  return r.toFixed(1).replace(/\.0$/, '');
}
