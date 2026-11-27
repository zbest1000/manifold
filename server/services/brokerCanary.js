'use strict';

/**
 * Broker canary: an opt-in, per-broker round-trip probe.
 *
 * "Connected" only says the TCP session is up. The canary answers the question that matters for intake:
 * does a message published through this broker come back to a subscriber, and how long does it take.
 *
 * It PUBLISHES. Each probe is a small JSON message on a canary topic (default
 * `manifold/canary/<id>`), never retained, through the same session Manifold uses for intake. The probe is
 * delivered back through Manifold's own subscription and the publish-to-deliver time is measured.
 *
 * Isolation: canary deliveries are claimed in MqttManager.handleMessage, before the topic store, so they
 * never reach the topic tree, UNS, recorder, pipelines, mappings, alerts or any other engine, and they are not
 * counted in the broker's message totals. Everything under CANARY_PREFIX is claimed (another Manifold's canary
 * on a shared broker included). A custom topic must also live under CANARY_PREFIX (see validateCanaryConfig).
 *
 * States: off, unknown (broker not connected), pending (no probe has finished), ok, slow, failing,
 * not-permitted (the broker refused the canary SUBSCRIBE, or answered the PUBLISH with "not authorized";
 * `refused` says which). A broker that silently drops publishes (QoS 0, no error) cannot be told apart from
 * a broken one: it shows as failing, and the detail names the possibility.
 */

const { performance } = require('perf_hooks');

const CANARY_PREFIX = 'manifold/canary/';
const WINDOW = 30; // probes kept per broker (rolling window)
const FAIL_AFTER = 2; // consecutive failed probes before the state is "failing"
const FIRST_PROBE_MS = 500;
const REASON_NOT_AUTHORIZED = 135; // MQTT 5 PUBACK / SUBACK reason code

const DEFAULTS = { enabled: false, qos: 0, intervalSec: 30, slowMs: 1000 };

// Levels that mark command, request or write topics in the conventions the IoT parsers know (Tasmota cmnd/,
// Zigbee2MQTT and Z-Wave JS .../set and .../get, Shelly .../command and .../rpc, LoRaWAN .../command/down,
// Z-Wave JS _CLIENTS/.../api/...) or Sparkplug's command verbs. A canary topic never contains one.
const COMMAND_LEVELS = new Set(['set', 'get', 'cmd', 'cmnd', 'command', 'commands', 'rpc', 'down', 'api', 'write', '_clients', 'ncmd', 'dcmd', 'scada']);

const defaultTopic = (brokerId) => `${CANARY_PREFIX}${String(brokerId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 8)}`;

/** Error text for an invalid canary config, or null. */
function validateCanaryConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'canary must be an object';
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return 'canary.enabled must be true or false';
  if (raw.qos !== undefined && ![0, 1, 2].includes(Number(raw.qos))) return 'canary.qos must be 0, 1 or 2';
  if (raw.intervalSec !== undefined) {
    const n = Number(raw.intervalSec);
    if (!Number.isFinite(n) || n < 5 || n > 3600) return 'canary.intervalSec must be between 5 and 3600';
  }
  if (raw.slowMs !== undefined) {
    const n = Number(raw.slowMs);
    if (!Number.isFinite(n) || n < 50 || n > 3000) return 'canary.slowMs must be between 50 and 3000';
  }
  if (raw.topic !== undefined && raw.topic !== '' && raw.topic !== null) {
    const t = raw.topic;
    if (typeof t !== 'string' || t.length > 200) return 'canary.topic must be a string of at most 200 characters';
    if (/[#+\0]/.test(t)) return 'canary.topic must be a plain topic without wildcards';
    if (t.startsWith('$') || t.startsWith('/') || t.endsWith('/') || t.includes('//')) return 'canary.topic must not start with $ or / and must have no empty levels';
    // The canary PUBLISHES, and a custom topic is excluded from intake: it must live under the canary
    // namespace, so it can neither hide real data nor reach a system topic ($...), a Sparkplug namespace
    // or another convention's command topic.
    if (!t.startsWith(CANARY_PREFIX) || t.length === CANARY_PREFIX.length) {
      return `canary.topic must start with ${CANARY_PREFIX} followed by a name, so it cannot hide real data or reach a command topic`;
    }
    const levels = t.slice(CANARY_PREFIX.length).split('/');
    const bad = levels.find((l) => COMMAND_LEVELS.has(l.toLowerCase()) || /^spbv\d/i.test(l));
    if (bad) return `canary.topic must not contain the level "${bad}": it is used by command, request or Sparkplug topics`;
  }
  return null;
}

/** Full canary config with defaults applied (assumes validateCanaryConfig passed). */
function normalizeCanaryConfig(raw, brokerId) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    topic: typeof c.topic === 'string' && c.topic ? c.topic : defaultTopic(brokerId),
    qos: [0, 1, 2].includes(Number(c.qos)) ? Number(c.qos) : DEFAULTS.qos,
    intervalSec: Number.isFinite(Number(c.intervalSec)) && c.intervalSec !== undefined ? Number(c.intervalSec) : DEFAULTS.intervalSec,
    slowMs: Number.isFinite(Number(c.slowMs)) && c.slowMs !== undefined ? Number(c.slowMs) : DEFAULTS.slowMs
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const isRefusal = (error, granted) =>
  (Array.isArray(error?.packet?.granted) && error.packet.granted.some((c) => c >= 128)) ||
  (!error && Array.isArray(granted) && granted.length > 0 && granted.every((g) => g.qos === 128));

class BrokerCanary {
  constructor(manager, { now = () => Date.now(), clock = () => performance.now() } = {}) {
    this.manager = manager;
    this.now = now;
    this.clock = clock;
    this.brokers = new Map(); // brokerId -> state
  }

  /** (Re)create the state of a broker from its normalized config; a disabled config removes it. */
  configure(brokerId, cfg) {
    this.remove(brokerId);
    if (!cfg?.enabled) return;
    this.brokers.set(brokerId, {
      brokerId,
      cfg,
      window: [], // { at, ok, rttMs?, reason? }, newest last
      sent: 0,
      okCount: 0,
      lastSuccessAt: null,
      lastError: null,
      refused: null, // 'publish' | 'subscribe'
      subscribed: false,
      seq: 0,
      pending: null, // { seq, nonce, startedAt, timer }
      timer: null,
      client: null
    });
  }

  remove(brokerId) {
    const st = this.brokers.get(brokerId);
    if (!st) return;
    this._stopTimers(st);
    this.brokers.delete(brokerId);
  }

  shutdown() {
    for (const id of [...this.brokers.keys()]) this.remove(id);
  }

  _stopTimers(st) {
    clearTimeout(st.timer);
    st.timer = null;
    if (st.pending) clearTimeout(st.pending.timer);
    st.pending = null;
  }

  /** True for topics the canary owns on this broker: they must never be ingested. */
  claims(brokerId, topic) {
    if (topic.startsWith(CANARY_PREFIX)) return true;
    const st = this.brokers.get(brokerId);
    return Boolean(st) && st.cfg.topic === topic;
  }

  /** The session (re)connected: subscribe, then probe. Subscriptions are not assumed to survive a reconnect. */
  onConnect(brokerId, client) {
    const st = this.brokers.get(brokerId);
    if (!st) return;
    this._stopTimers(st);
    st.client = client;
    st.subscribed = false;
    this._subscribe(st, client, st.cfg.qos);
  }

  /**
   * The session dropped; the schedule stops until it reconnects. A probe that was in flight counts as failed:
   * some brokers (Aedes, some Mosquitto setups) close the connection of a client that publishes to a topic it
   * may not use, and without this the canary would never see that failure.
   */
  onDisconnect(brokerId) {
    const st = this.brokers.get(brokerId);
    if (!st) return;
    const inFlight = Boolean(st.pending);
    this._forget(st);
    this._stopTimers(st);
    if (inFlight) {
      this._record(st, { ok: false, reason: 'the connection closed while a probe was in flight. Some brokers disconnect a client that publishes to a topic it may not use; check the publish ACL for this topic.' });
    }
    st.client = null;
    st.subscribed = false;
  }

  _subscribe(st, client, qos) {
    client.subscribe(st.cfg.topic, { qos }, (error, granted) => {
      if (st.client !== client || this.brokers.get(st.brokerId) !== st) return; // replaced meanwhile
      if (isRefusal(error, granted)) {
        // Some brokers refuse a QoS the ACL does not allow: try QoS 0 once before calling it a refusal.
        if (qos > 0) return this._subscribe(st, client, 0);
        st.refused = 'subscribe';
        st.lastError = 'The broker refused the canary subscription (SUBACK refused)';
        return;
      }
      if (error) {
        st.lastError = `Canary subscribe failed: ${error.message}`;
        this._schedule(st, st.cfg.intervalSec * 1000); // try again on the next round
        return;
      }
      if (st.refused === 'subscribe') st.refused = null;
      st.subscribed = true;
      this._schedule(st, FIRST_PROBE_MS);
    });
  }

  _schedule(st, ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => this.probe(st.brokerId), ms);
    st.timer.unref?.();
  }

  /** One probe round (also the timer body). Safe to call directly in tests. */
  probe(brokerId) {
    const st = this.brokers.get(brokerId);
    if (!st || !st.client || !st.client.connected) return;
    if (!st.subscribed) {
      // The subscription never completed (error path): retry it instead of probing blind.
      if (st.refused !== 'subscribe') this._subscribe(st, st.client, st.cfg.qos);
      return;
    }
    if (st.pending) this._finish(st, false, 'no probe answer'); // defensive: never two in flight
    const seq = ++st.seq;
    const nonce = Math.random().toString(36).slice(2, 10);
    const timeoutMs = Math.min(10_000, st.cfg.intervalSec * 800);
    const pending = { seq, nonce, startedAt: this.clock(), timer: null };
    pending.timer = setTimeout(() => {
      if (st.pending !== pending) return;
      this._forget(st);
      st.pending = null;
      const hint = st.cfg.qos === 0 ? ' The broker may be dropping the publish silently; check the publish ACL for this topic.' : '';
      this._record(st, { ok: false, reason: `no delivery within ${Math.round(timeoutMs / 100) / 10} s.${hint}` });
      this._next(st);
    }, timeoutMs);
    pending.timer.unref?.();
    st.pending = pending;
    st.sent++;

    const body = JSON.stringify({ canary: 'manifold', seq, nonce, t: this.now() });
    try {
      st.client.publish(st.cfg.topic, body, { qos: st.cfg.qos, retain: false }, (error) => {
        if (!error || st.pending !== pending) return;
        clearTimeout(pending.timer);
        st.pending = null;
        if (error.code === REASON_NOT_AUTHORIZED) {
          st.refused = 'publish';
          st.lastError = 'The broker answered the canary publish with "not authorized"';
          this._record(st, { ok: false, reason: st.lastError });
        } else {
          this._record(st, { ok: false, reason: `publish failed: ${error.message}` });
        }
        this._next(st);
      });
      // QoS 1/2 probes sit in the client's outgoing store until acknowledged and are replayed after a
      // reconnect. A probe that is over must not be sent again (it would also be a stale answer).
      if (st.cfg.qos > 0) pending.messageId = st.client.getLastMessageId?.();
    } catch (error) {
      clearTimeout(pending.timer);
      st.pending = null;
      this._record(st, { ok: false, reason: `publish failed: ${error.message}` });
      this._next(st);
    }
  }

  /** Drop the in-flight probe from the client's outgoing store so a reconnect does not replay it. */
  _forget(st) {
    const id = st.pending?.messageId;
    if (id === undefined || !st.client?.removeOutgoingMessage) return;
    try {
      st.client.removeOutgoingMessage(id);
    } catch {
      // already acknowledged
    }
  }

  _next(st) {
    if (this.brokers.get(st.brokerId) === st && st.client) this._schedule(st, st.cfg.intervalSec * 1000);
  }

  _finish(st, ok, reason) {
    if (st.pending) clearTimeout(st.pending.timer);
    st.pending = null;
    this._record(st, { ok, reason });
  }

  _record(st, { ok, rttMs, reason }) {
    const at = this.now();
    st.window.push({ at, ok, rttMs, reason });
    if (st.window.length > WINDOW) st.window.shift();
    if (ok) {
      st.okCount++;
      st.lastSuccessAt = at;
      st.lastError = null;
      st.refused = null; // a delivered probe proves publish and subscribe are both permitted
    } else if (reason) {
      st.lastError = reason;
    }
  }

  /** A delivery of a canary topic from the broker. Never throws: payloads are untrusted. */
  onDelivery(brokerId, topic, payload) {
    const st = this.brokers.get(brokerId);
    if (!st || topic !== st.cfg.topic || !st.pending) return;
    let body;
    try {
      body = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
    } catch {
      return;
    }
    const p = st.pending;
    // Overlapping subscriptions deliver twice; a late answer to an earlier probe is ignored (seq + nonce).
    if (!body || body.seq !== p.seq || body.nonce !== p.nonce) return;
    clearTimeout(p.timer);
    st.pending = null;
    this._record(st, { ok: true, rttMs: Math.max(0, Math.round((this.clock() - p.startedAt) * 10) / 10) });
    this._next(st);
  }

  /** Status of one broker: { state, detail, ...window numbers }, or { state: 'off' }. */
  getStatus(brokerId, now = this.now()) {
    const st = this.brokers.get(brokerId);
    if (!st) return { state: 'off' };
    const cfg = st.cfg;
    const w = st.window;
    const oks = w.filter((x) => x.ok).map((x) => x.rttMs).sort((a, b) => a - b);
    let consecutiveFailures = 0;
    for (let i = w.length - 1; i >= 0 && !w[i].ok; i--) consecutiveFailures++;
    const p50 = percentile(oks, 50);
    const p95 = percentile(oks, 95);
    const base = {
      topic: cfg.topic,
      qos: cfg.qos,
      intervalSec: cfg.intervalSec,
      slowMs: cfg.slowMs,
      sent: st.sent,
      window: w.length,
      successRate: w.length ? oks.length / w.length : null,
      p50Ms: p50,
      p95Ms: p95,
      lastRttMs: [...w].reverse().find((x) => x.ok)?.rttMs ?? null,
      lastSuccessAt: st.lastSuccessAt,
      sinceLastSuccessMs: st.lastSuccessAt === null ? null : Math.max(0, now - st.lastSuccessAt),
      lastError: st.lastError,
      refused: st.refused
    };
    const conn = this.manager.connections?.get(brokerId);
    if (!conn || conn.status !== 'connected') return { ...base, state: 'unknown', detail: 'The broker is not connected, so no probe is running.' };
    if (st.refused === 'subscribe') {
      return { ...base, state: 'not-permitted', detail: `The broker refused the subscription to ${cfg.topic}. Allow this client to subscribe to it, or choose a canary topic it may use.` };
    }
    if (st.refused === 'publish') {
      return { ...base, state: 'not-permitted', detail: `The broker refused to let this client publish to ${cfg.topic}. Allow publishing to it, or choose a canary topic it may use.` };
    }
    if (!w.length) return { ...base, state: 'pending', detail: 'Waiting for the first probe to finish.' };
    if (!oks.length && consecutiveFailures < FAIL_AFTER) return { ...base, state: 'pending', detail: 'No probe has been delivered yet.' };
    if (consecutiveFailures >= FAIL_AFTER || (w.length >= 6 && oks.length / w.length < 0.5)) {
      return { ...base, state: 'failing', detail: st.lastError || 'Probes are not coming back.' };
    }
    if (p95 !== null && p95 > cfg.slowMs) {
      return { ...base, state: 'slow', detail: `95th percentile ${p95} ms is above the ${cfg.slowMs} ms threshold.` };
    }
    return { ...base, state: 'ok', detail: 'Probes are being delivered.' };
  }

  /** Compact status for the broker-stats push and the list. */
  summary(brokerId) {
    const s = this.getStatus(brokerId);
    if (s.state === 'off') return null;
    return { state: s.state, refused: s.refused, p50Ms: s.p50Ms, p95Ms: s.p95Ms, successRate: s.successRate, detail: s.detail };
  }
}

module.exports = { BrokerCanary, CANARY_PREFIX, validateCanaryConfig, normalizeCanaryConfig, defaultTopic };
