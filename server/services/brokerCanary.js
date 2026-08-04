'use strict';

/**
 * Broker round-trip canary — the honest per-broker health number. A TCP
 * session being "connected" says nothing about a broker that is swapping,
 * rate-limiting, or minutes behind on delivery; the only real measure is
 * publish → deliver latency through the broker itself. Every interval the
 * canary publishes a tiny timestamped probe on a per-instance topic through
 * each connected broker, subscribes to that same topic, and records how long
 * the broker took to hand the message back.
 *
 * Probes that never come back within a tick are counted as `missed` — a
 * missed canary on a "connected" broker is exactly the silent failure mode
 * this exists to expose.
 */

const INTERVAL_MS = 30_000;
const SAMPLES_MAX = 60; // ~30 min of history per broker at the default tick
const EMA_ALPHA = 0.3;

class BrokerCanary {
  constructor({ mqttManager, intervalMs = INTERVAL_MS, idSuffix = Math.random().toString(16).slice(2, 10) }) {
    this.manager = mqttManager;
    this.intervalMs = intervalMs;
    // Per-instance topic: two Manifolds watching one broker must not answer
    // each other's probes.
    this.topic = `manifold/canary/${idSuffix}`;
    this.stats = new Map(); // brokerId -> { lastRttMs, emaMs, samples, sent, missed, lastAt }
    this.pending = new Map(); // brokerId -> { seq, sentAt }
    this.seq = 0;
    this.timer = null;
    this.tapping = false;
    this.onMessage = this.onMessage.bind(this);
  }

  start() {
    if (!this.tapping && this.manager?.on) {
      this.manager.on('message', this.onMessage);
      this.tapping = true;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.tapping) {
      this.manager?.off?.('message', this.onMessage);
      this.tapping = false;
    }
  }

  _stat(brokerId) {
    let s = this.stats.get(brokerId);
    if (!s) {
      s = { lastRttMs: null, emaMs: null, samples: [], sent: 0, missed: 0, lastAt: null };
      this.stats.set(brokerId, s);
    }
    return s;
  }

  /** One probe round. Exposed for tests (pass `now` for determinism). */
  tick(now = Date.now()) {
    const conns = this.manager.getConnections?.() || [];
    const live = new Set();
    for (const c of conns) {
      if (c.status !== 'connected') continue;
      live.add(c.id);
      const s = this._stat(c.id);

      // Previous probe never came back — that's the signal, record it.
      if (this.pending.has(c.id)) {
        s.missed++;
        s.samples.push(null);
        if (s.samples.length > SAMPLES_MAX) s.samples.splice(0, s.samples.length - SAMPLES_MAX);
        this.pending.delete(c.id);
      }

      // (Re)subscribe each round: cheap, idempotent, and survives broker
      // reconnects that drop our subscription (brokers with scoped
      // subscribeFilter would otherwise never deliver the canary back).
      try {
        // quiet: re-asserted every tick, and a broker that refuses shows up
        // honestly as missed probes — no need to toast each round.
        this.manager.subscribe(c.id, this.topic, 0, { quiet: true });
      } catch {
        continue; // connection raced away — next tick
      }

      const seq = ++this.seq;
      this.pending.set(c.id, { seq, sentAt: now });
      s.sent++;
      // publish() never throws synchronously (manager contract); a failed
      // publish just becomes a missed sample next round.
      this.manager.publish(c.id, this.topic, { seq, t: now }, { qos: 0, retain: false });
    }
    // Brokers that disconnected take their pending probe with them.
    for (const id of this.pending.keys()) if (!live.has(id)) this.pending.delete(id);
  }

  onMessage(msg, now = Date.now()) {
    if (msg.topic !== this.topic) return;
    const p = this.pending.get(msg.brokerId);
    if (!p) return;
    const seq = msg.payload?.seq;
    if (seq !== p.seq) return; // stale straggler from an earlier round
    this.pending.delete(msg.brokerId);
    const rtt = Math.max(0, now - p.sentAt);
    const s = this._stat(msg.brokerId);
    s.lastRttMs = rtt;
    s.lastAt = now;
    s.emaMs = s.emaMs === null ? rtt : Math.round(EMA_ALPHA * rtt + (1 - EMA_ALPHA) * s.emaMs);
    s.samples.push(rtt);
    if (s.samples.length > SAMPLES_MAX) s.samples.splice(0, s.samples.length - SAMPLES_MAX);
  }

  getStats() {
    const out = {};
    for (const [brokerId, s] of this.stats) {
      out[brokerId] = { ...s, samples: [...s.samples] };
    }
    return { topic: this.topic, intervalMs: this.intervalMs, brokers: out };
  }
}

module.exports = { BrokerCanary };
