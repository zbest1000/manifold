'use strict';

const { matchParts, matchFilter, compiledView } = require('./mqttMatch');

/**
 * Pipeline engine — Manifold's DataOps core: source → transforms → target
 * routes over the live message stream.
 *
 * Routes are persisted in the profile store and evaluated against the
 * manager's coalesced message tap (bounded by topics touched per flush, never
 * raw publish rate). The route table is COMPILED (filters pre-split, disabled
 * routes excluded) and rebuilt only when the profile store's revision changes,
 * so the steady-state per-message cost is one topic split plus array walks —
 * no allocation per route.
 *
 * Transforms are a small, ordered vocabulary — enough to re-path a messy
 * namespace into a clean UNS, reshape payloads, convert units, flatten
 * Sparkplug, and wrap values in a TVQ envelope — deliberately not a general
 * scripting runtime.
 *
 * Loop safety, two layers:
 * - Static: output matching the route's OWN source filter is blocked outright.
 * - Dynamic hop count: every published (broker, topic) is remembered briefly;
 *   a message whose topic we recently published carries that hop depth, and
 *   crossing MAX_HOPS blocks delivery. This catches A→B→A cycles across
 *   routes/brokers that no static check can see through repath templates.
 *
 * Historian delivery goes through the HistorianOutbox (store-and-forward) —
 * this engine never talks to a historian directly.
 */

const MAX_HOPS = 4;
const HOP_TTL_MS = 10_000;
const HOP_SWEEP_AT = 10_000;

// ---- transforms ---------------------------------------------------------------

/**
 * Apply `{n}` segment templates: `{1}`..`{n}` = 1-based source segment,
 * `{n-}` = segments n..end joined, `{topic}` = whole source topic.
 */
function applyTemplate(template, topic) {
  const segs = topic.split('/');
  return String(template)
    .replace(/\{topic\}/g, topic)
    .replace(/\{(\d+)-\}/g, (_, n) => segs.slice(Number(n) - 1).join('/'))
    .replace(/\{(\d+)\}/g, (_, n) => segs[Number(n) - 1] ?? '');
}

/** Best available quality for a tapped MQTT message (OPC 0-255 scale). */
function messageQuality(msg) {
  // The intake surfaces quality from TVQ envelopes and Sparkplug payloads; a
  // payload that failed to decode is the one case we can call bad ourselves.
  if (msg.sparkplugError) return 0; // bad
  if (msg.quality === 0 || msg.quality === 64 || msg.quality === 192) return msg.quality;
  return 192; // good — the value did arrive over a live session
}

const MIN_SOURCE_TS = Date.UTC(2000, 0, 1);

/**
 * Timestamp for a tapped message: the source timestamp when the payload
 * carried a plausible one (TVQ `t`, Sparkplug timestamp), else arrival time.
 * A device clock that is unset or far in the future must not corrupt history.
 */
function messageTime(msg, now = Date.now()) {
  const src = Number(msg.sourceTimestamp);
  if (Number.isFinite(src) && src >= MIN_SOURCE_TS && src <= now + 86_400_000) return src;
  return new Date(msg.timestamp).getTime() || now;
}

/**
 * Run the transform chain over one message. Returns { topic, payload } or
 * null when a step filtered the message out. Never throws on payload shape —
 * a transform that doesn't apply passes the message through unchanged.
 */
function applyTransforms(transforms, msg) {
  let topic = msg.topic;
  let payload = msg.payload;

  for (const t of transforms || []) {
    switch (t.type) {
      case 'repath':
        topic = applyTemplate(t.to || '{topic}', msg.topic);
        break;
      case 'pick':
        if (payload && typeof payload === 'object' && Array.isArray(t.fields)) {
          const next = {};
          for (const f of t.fields) if (f in payload) next[f] = payload[f];
          payload = next;
        }
        break;
      case 'rename':
        if (payload && typeof payload === 'object' && t.map && typeof t.map === 'object') {
          const next = {};
          for (const [k, v] of Object.entries(payload)) next[t.map[k] || k] = v;
          payload = next;
        }
        break;
      case 'set':
        if (t.values && typeof t.values === 'object') {
          payload = payload && typeof payload === 'object' ? { ...payload, ...t.values } : { value: payload, ...t.values };
        }
        break;
      case 'scale': {
        const mul = Number.isFinite(Number(t.mul)) ? Number(t.mul) : 1;
        const add = Number.isFinite(Number(t.add)) ? Number(t.add) : 0;
        if (t.field && payload && typeof payload === 'object') {
          const v = Number(payload[t.field]);
          if (Number.isFinite(v)) payload = { ...payload, [t.field]: v * mul + add };
        } else {
          const v = Number(payload);
          if (Number.isFinite(v)) payload = v * mul + add;
        }
        break;
      }
      case 'numeric': {
        const v = t.field && payload && typeof payload === 'object' ? Number(payload[t.field]) : Number(payload);
        if (!Number.isFinite(v)) return null; // not numeric → drop (filter semantics)
        payload = v;
        break;
      }
      case 'sparkplugFlatten':
        if (msg.sparkplug && Array.isArray(msg.sparkplug.metrics)) {
          const next = {};
          for (const m of msg.sparkplug.metrics) {
            // Propagate declared nulls honestly: an is_null metric is "no
            // value", not "value undefined" — consumers must see the null.
            if (m && m.name !== undefined) next[m.name] = m.is_null ? null : m.value ?? null;
          }
          payload = next;
        }
        break;
      case 'envelope':
        // TVQ envelope: derived UNS data carries value, source timestamp, and
        // quality — so consumers can tell "value is 0" from "value is dead".
        payload = {
          v: payload,
          t: messageTime(msg),
          q: messageQuality(msg)
        };
        break;
      default:
        break; // unknown step: pass through (forward compatibility)
    }
  }
  return { topic, payload };
}

class PipelineEngine {
  constructor({ mqttManager, profiles, outbox }) {
    this.manager = mqttManager;
    this.profiles = profiles;
    this.outbox = outbox;
    this.metrics = new Map(); // routeId -> { matched, published, errors, loopBlocked, lastError, lastTs }
    this.hops = new Map(); // `${brokerId}\0${topic}` -> { depth, ts }
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    // Compiled route table: filters pre-split, disabled/malformed excluded.
    this.table = compiledView(profiles, () =>
      this.profiles
        .listIn('pipelines')
        .filter((r) => r.enabled !== false && r.source?.brokerId && r.source?.filter)
        .map((r) => ({ route: r, parts: String(r.source.filter).split('/') }))
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
  }

  stop() {
    this.manager.off('message', this.onMessage);
    this.started = false;
  }

  _metric(routeId) {
    let m = this.metrics.get(routeId);
    if (!m) {
      m = { matched: 0, published: 0, errors: 0, loopBlocked: 0, lastError: null, lastTs: 0 };
      this.metrics.set(routeId, m);
    }
    return m;
  }

  _hopDepth(brokerId, topic) {
    const h = this.hops.get(`${brokerId}\0${topic}`);
    return h && Date.now() - h.ts < HOP_TTL_MS ? h.depth : 0;
  }

  _recordHop(brokerId, topic, depth) {
    if (this.hops.size > HOP_SWEEP_AT) {
      const cutoff = Date.now() - HOP_TTL_MS;
      for (const [k, v] of this.hops) if (v.ts < cutoff) this.hops.delete(k);
    }
    this.hops.set(`${brokerId}\0${topic}`, { depth, ts: Date.now() });
  }

  onMessage(msg) {
    const table = this.table();
    if (!table.length) return;
    const topicParts = msg.topicParts || msg.topic.split('/');
    let incomingDepth = -1; // lazy: only look up when a route actually matches

    for (const { route, parts } of table) {
      if (route.source.brokerId !== msg.brokerId) continue;
      if (!matchParts(parts, topicParts)) continue;
      const m = this._metric(route.id);
      m.matched++;
      m.lastTs = Date.now();
      try {
        const out = applyTransforms(route.transforms, msg);
        if (!out) continue; // filtered by a transform (e.g. non-numeric dropped)
        if (incomingDepth < 0) incomingDepth = this._hopDepth(msg.brokerId, msg.topic);
        this._deliver(route, m, out, msg, incomingDepth);
      } catch (error) {
        m.errors++;
        m.lastError = error.message;
      }
    }
  }

  _deliver(route, m, out, msg, incomingDepth) {
    const target = route.target || {};
    if (target.type === 'mqtt') {
      // Layer 1: output re-entering this route's own source is a direct loop.
      if (target.brokerId === route.source.brokerId && matchFilter(route.source.filter, out.topic)) {
        m.loopBlocked++;
        m.lastError = `loop blocked: output topic "${out.topic}" matches the route's own source filter`;
        return;
      }
      // Layer 2: hop count catches indirect cycles (A→B→A across routes/brokers).
      const depth = incomingDepth + 1;
      if (depth > MAX_HOPS) {
        m.loopBlocked++;
        m.lastError = `loop blocked: message exceeded ${MAX_HOPS} pipeline hops (topic "${out.topic}")`;
        return;
      }
      this._recordHop(target.brokerId, out.topic, depth);
      this.manager
        .publish(target.brokerId, out.topic, out.payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
        .then(() => {
          m.published++;
        })
        .catch((error) => {
          m.errors++;
          m.lastError = error.message;
        });
    } else if (target.type === 'historian') {
      this.outbox.enqueue(target.historianId, [
        {
          tag: out.topic,
          ts: messageTime(msg),
          value: out.payload,
          quality: messageQuality(msg)
        }
      ]);
      m.published++; // admitted to the store-and-forward outbox
    }
  }

  /**
   * Dry-run a route against the observed topic set: resolve the source filter
   * via the trie, pull each sample's latest payload, run the transform chain,
   * and report the in→out mapping WITHOUT publishing anything.
   */
  preview(route, { sampleLimit = 25 } = {}) {
    const store = this.manager.stores.get(route.source?.brokerId);
    if (!store) return { error: 'source broker not connected', matchCount: 0, rows: [] };
    const resolved = this.manager.resolveSubscriptions(route.source.brokerId, [route.source.filter], { sampleLimit });
    const result = resolved?.results?.[0];
    if (!result) return { error: 'filter did not resolve', matchCount: 0, rows: [] };

    const rows = [];
    for (const s of result.sample) {
      const row = store.getLatest(s.topic);
      if (!row) continue;
      const msg = this.manager.buildMessage(route.source.brokerId, row);
      const out = applyTransforms(route.transforms, msg);
      rows.push({
        inTopic: s.topic,
        inPayload: msg.payload,
        outTopic: out ? out.topic : null,
        outPayload: out ? out.payload : null,
        dropped: !out,
        loop:
          Boolean(out) &&
          route.target?.type === 'mqtt' &&
          route.target.brokerId === route.source.brokerId &&
          matchFilter(route.source.filter, out.topic)
      });
    }
    return { matchCount: result.matchCount, sampleTruncated: result.sampleTruncated, rows };
  }

  getMetrics() {
    return Object.fromEntries(this.metrics);
  }
}

module.exports = { PipelineEngine, applyTransforms, applyTemplate, messageQuality, messageTime };
