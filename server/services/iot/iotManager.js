'use strict';

const { EventEmitter } = require('events');
const { IotRegistry } = require('./registry');
const { LIMITS, BAD, GOOD, jsonDepth } = require('./limits');
const { filterCovers } = require('../bindingMqtt');
const zigbee2mqtt = require('./conventions/zigbee2mqtt');
const zwavejs = require('./conventions/zwavejs');
const homeassistant = require('./conventions/homeassistant');
const tasmota = require('./conventions/tasmota');
const shelly = require('./conventions/shelly');
const { chirpstack, ttn } = require('./conventions/lorawan');

/**
 * IoT over MQTT: consumer/prosumer ecosystems that already publish over MQTT (Zigbee2MQTT,
 * Z-Wave JS UI, Home Assistant discovery, Tasmota, Shelly, ChirpStack, The Things Stack) shown as
 * devices with named, typed tags instead of raw topics.
 *
 * READ-ONLY BY CONSTRUCTION: this module and the conventions it loads never call publish. The
 * manager is handed the MQTT manager for its message tap, connection state, subscriptions and
 * topic store only. Manifold does not pair, configure or control any of these devices.
 *
 * Per broker: opt-in per convention (stored in the profile store, collection 'iotDetection',
 * id = broker id), auto-detect suggestions when matching (retained) topics are seen, and one
 * IotRegistry of devices. It is also the binding engine's tag source 'iot':
 *   sourceId = `${brokerId}|${deviceId}`, address = tag key;
 *   'sample' { sourceType: 'iot', sourceId, address, v, type, q, qReason, tSource, tRead }
 *   'source-state' per device (offline availability or broker down -> offline)
 *   'meta-changed' when tag sets / metadata change (the engine rebuilds its compiled view).
 */

const CONVENTIONS = [zigbee2mqtt, zwavejs, homeassistant, tasmota, shelly, chirpstack, ttn];
const BY_ID = new Map(CONVENTIONS.map((c) => [c.id, c]));
const COLLECTION = 'iotDetection';
const MAX_REPLAY = 20_000;

const sourceIdOf = (brokerId, deviceId) => `${brokerId}|${deviceId}`;
function parseSourceId(sourceId) {
  const s = String(sourceId);
  const i = s.lastIndexOf('|');
  return i < 0 ? null : { brokerId: s.slice(0, i), deviceId: s.slice(i + 1) };
}

/** Validate and normalize a broker's detection config -> { conventions: { id: { enabled, ...options } } }. Throws on bad input. */
function normalizeConfig(body) {
  const src = body && typeof body === 'object' && body.conventions && typeof body.conventions === 'object' ? body.conventions : {};
  const out = {};
  for (const k of Object.keys(src)) if (!BY_ID.has(k)) throw new Error(`unknown convention "${k}" (known: ${CONVENTIONS.map((c) => c.id).join(', ')})`);
  for (const c of CONVENTIONS) {
    const o = src[c.id] && typeof src[c.id] === 'object' ? src[c.id] : {};
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw new Error(`${c.id}.enabled must be a boolean`);
    out[c.id] = { enabled: o.enabled === true, ...c.normalize(o) };
  }
  return { conventions: out };
}

class IotManager extends EventEmitter {
  constructor({ mqttManager, profiles, pollMs = 1000, metaDebounceMs = 50 } = {}) {
    super();
    this.manager = mqttManager;
    this.profiles = profiles;
    this.pollMs = pollMs;
    this.metaDebounceMs = metaDebounceMs;
    this.brokers = new Map(); // brokerId -> broker state
    this.suggest = new Map(); // brokerId -> Map(convention -> { options, topic, at })
    this.emitted = new Map(); // sourceId -> last emitted state key
    this.checked = new Set(); // brokers whose stored config was looked up on first traffic
    this.onMessage = this.onMessage.bind(this);
    this.timer = null;
    this.metaTimer = null;
    this.started = false;
  }

  static conventions() {
    return CONVENTIONS.map((c) => ({ id: c.id, label: c.label, defaults: c.normalize({}) }));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on('message', this.onMessage);
    for (const entry of this._stored()) {
      try {
        this._apply(entry.id, normalizeConfig(entry), { persist: false });
      } catch (error) {
        console.warn(`iot: stored config for broker ${entry.id} ignored: ${error.message}`);
      }
    }
    this.timer = setInterval(() => this._poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.started = false;
    this.manager.off('message', this.onMessage);
    clearInterval(this.timer);
    clearTimeout(this.metaTimer);
    this.timer = null;
    this.metaTimer = null;
    for (const b of this.brokers.values()) for (const h of b.handlers.values()) h.close?.();
  }

  _stored() {
    try {
      return this.profiles?.listIn ? this.profiles.listIn(COLLECTION) : [];
    } catch {
      return []; // a profile store without the collection (tests, older stores)
    }
  }

  // ---- configuration ---------------------------------------------------------------------

  _broker(brokerId) {
    let b = this.brokers.get(brokerId);
    if (!b) {
      b = {
        id: brokerId,
        config: normalizeConfig({}),
        handlers: new Map(),
        registry: new IotRegistry(brokerId, {
          onSample: (bid, dev, tag) => this._sample(bid, dev, tag),
          onState: (bid, dev) => this._state(bid, dev),
          onMeta: (bid, dev, opts) => this._meta(bid, dev, opts)
        }),
        stats: { messages: 0, refusedLarge: 0, refusedDepth: 0, errors: {}, lastError: null },
        connected: null
      };
      this.brokers.set(brokerId, b);
    }
    return b;
  }

  getConfig(brokerId) {
    return this.brokers.get(brokerId)?.config || normalizeConfig(this.profiles?.getIn?.(COLLECTION, brokerId) || {});
  }

  /** Validate, store and apply a broker's detection config (throws on invalid input). */
  setConfig(brokerId, body) {
    if (typeof brokerId !== 'string' || !brokerId) throw new Error('brokerId is required');
    const cfg = normalizeConfig(body);
    this._apply(brokerId, cfg, { persist: true });
    return cfg;
  }

  removeBroker(brokerId) {
    const b = this.brokers.get(brokerId);
    if (b) {
      for (const h of b.handlers.values()) h.close?.();
      b.registry.clear();
      this.brokers.delete(brokerId);
    }
    this.suggest.delete(brokerId);
    try {
      this.profiles?.removeIn?.(COLLECTION, brokerId);
    } catch {
      /* no stored config */
    }
  }

  _apply(brokerId, cfg, { persist }) {
    const b = this._broker(brokerId);
    const prev = b.config;
    b.config = cfg;
    if (persist) this.profiles?.upsertIn?.(COLLECTION, brokerId, cfg);
    const fresh = [];
    for (const c of CONVENTIONS) {
      const now = cfg.conventions[c.id];
      const was = prev.conventions[c.id];
      const same = b.handlers.has(c.id) && now.enabled && JSON.stringify(now) === JSON.stringify(was);
      if (same) continue;
      const h = b.handlers.get(c.id);
      if (h) {
        h.close?.();
        b.handlers.delete(c.id);
        b.registry.removeWhere((d) => d.convention === c.id);
      }
      if (now.enabled) {
        const { enabled: _e, ...opts } = now;
        b.handlers.set(c.id, c.create(opts, b.registry));
        fresh.push(c);
        this.suggest.get(brokerId)?.delete(c.id);
      }
    }
    if (fresh.length) {
      this._ensureSubscriptions(brokerId);
      this._replay(brokerId, fresh);
    }
  }

  /** Make sure the broker session receives what the enabled conventions read (one extra subscription per uncovered filter). */
  _ensureSubscriptions(brokerId) {
    const b = this.brokers.get(brokerId);
    const conn = this.manager.getConnection?.(brokerId);
    if (!b || conn?.status !== 'connected') return;
    const subs = (this.manager.getSubscriptions?.(brokerId) || []).map(String);
    for (const [id] of b.handlers) {
      const c = BY_ID.get(id);
      const { enabled: _e, ...opts } = b.config.conventions[id];
      for (const f of c.filters(opts)) {
        if (subs.some((s) => filterCovers(s, f))) continue;
        try {
          this.manager.subscribe?.(brokerId, f, 0);
          subs.push(f);
        } catch (error) {
          b.stats.lastError = `subscribe ${f}: ${error.message}`;
        }
      }
    }
  }

  /** Feed newly enabled conventions what the broker already delivered (retained device lists, configs, last states). */
  _replay(brokerId, conventions) {
    const b = this.brokers.get(brokerId);
    const store = this.manager.stores?.get?.(brokerId);
    if (!b || !store?.getLatest || !this.manager.buildMessage || !this.manager.resolveSubscriptions) return;
    const filters = new Set();
    for (const c of conventions) {
      const { enabled: _e, ...opts } = b.config.conventions[c.id];
      if (c.wantsAllTopics) filters.add('#');
      for (const f of c.filters(opts)) filters.add(f);
    }
    const r = this.manager.resolveSubscriptions(brokerId, [...filters], { sampleLimit: MAX_REPLAY });
    const topics = new Set();
    for (const res of r?.results || []) for (const s of res.sample || []) if (topics.size < MAX_REPLAY) topics.add(s.topic);
    // Device lists and discovery configs first, so state messages find their device.
    const rank = (t) => (/\/bridge\/(devices|groups)$|\/config$|\/announce$/.test(t) ? 0 : 1);
    const ordered = [...topics].filter((t) => !t.startsWith('spBv1.0/') && !t.startsWith('$')).sort((x, y) => rank(x) - rank(y));
    const handlers = conventions.map((c) => [c.id, b.handlers.get(c.id)]).filter(([, h]) => h);
    for (const topic of ordered) {
      const row = store.getLatest(topic);
      if (!row) continue;
      let msg;
      try {
        msg = this.manager.buildMessage(brokerId, row);
      } catch {
        continue;
      }
      msg.topicParts = msg.topic.split('/');
      this._dispatch(b, msg, handlers);
    }
  }

  // ---- message tap -------------------------------------------------------------------------

  onMessage(msg) {
    if (!msg || msg.sparkplug || typeof msg.topic !== 'string') return;
    const parts = msg.topicParts || (msg.topicParts = msg.topic.split('/'));
    let b = this.brokers.get(msg.brokerId);
    if (!b && !this.checked.has(msg.brokerId)) {
      // A broker added (or re-added) at run time with a stored detection config.
      this.checked.add(msg.brokerId);
      const stored = this.profiles?.getIn?.(COLLECTION, msg.brokerId);
      if (stored) {
        try {
          this._apply(msg.brokerId, normalizeConfig(stored), { persist: false });
          b = this.brokers.get(msg.brokerId);
        } catch {
          /* invalid stored config: ignored, as at start */
        }
      }
    }
    this._detect(msg.brokerId, parts, msg, b);
    if (!b || !b.handlers.size) return;
    this._dispatch(b, msg, b.handlers);
  }

  _dispatch(b, msg, handlers) {
    if (msg.payloadFormat === 'large' || (msg.size || 0) > LIMITS.maxPayloadBytes) {
      b.stats.refusedLarge++;
      return;
    }
    if (msg.payloadFormat === 'json' && msg.payload && typeof msg.payload === 'object' && jsonDepth(msg.payload) > LIMITS.maxJsonDepth) {
      b.stats.refusedDepth++;
      return;
    }
    b.stats.messages++;
    for (const [id, h] of handlers) {
      try {
        h.onMessage(msg);
      } catch (error) {
        // A hostile or unexpected payload must not stop ingest for anything else.
        b.stats.errors[id] = (b.stats.errors[id] || 0) + 1;
        b.stats.lastError = `${id}: ${msg.topic.slice(0, 200)}: ${error.message}`;
      }
    }
  }

  _detect(brokerId, parts, msg, b) {
    let s = this.suggest.get(brokerId);
    if (s && s.size >= CONVENTIONS.length) return;
    for (const c of CONVENTIONS) {
      if (s?.has(c.id) || b?.config.conventions[c.id]?.enabled) continue;
      let opts;
      try {
        opts = c.detect(parts, msg);
      } catch {
        opts = null;
      }
      if (!opts) continue;
      if (!s) this.suggest.set(brokerId, (s = new Map()));
      s.set(c.id, { convention: c.id, label: c.label, options: c.normalize(opts), topic: msg.topic.slice(0, 300), at: Date.now() });
    }
  }

  // ---- registry callbacks -> binding engine ---------------------------------------------

  _brokerUp(brokerId) {
    return this.manager.getConnection?.(brokerId)?.status === 'connected';
  }

  _sample(brokerId, dev, tag) {
    if (!this.listenerCount('sample')) return;
    const eff = IotRegistry.effective(dev, tag);
    const up = this._brokerUp(brokerId);
    this.emit('sample', {
      sourceType: 'iot',
      sourceId: sourceIdOf(brokerId, dev.id),
      address: tag.key,
      v: tag.value,
      type: tag.type !== 'unknown' ? tag.type : undefined,
      q: up ? eff.q ?? GOOD : BAD,
      qReason: up ? eff.reason : 'broker not connected',
      tSource: tag.t || undefined,
      tRead: tag.rx || Date.now()
    });
  }

  _stateOf(brokerId, dev) {
    if (!this._brokerUp(brokerId)) return { state: 'offline', reason: 'broker not connected' };
    if (!dev) return { state: 'offline', reason: 'device not (yet) seen on the broker' };
    if (dev.availability === 'offline') return { state: 'offline', reason: dev.availabilityReason || 'device offline' };
    return { state: 'online', reason: dev.availability === 'online' ? dev.availabilityReason || 'online' : 'no availability reported' };
  }

  _emitState(brokerId, deviceId, dev, force = false) {
    const sid = sourceIdOf(brokerId, deviceId);
    const st = this._stateOf(brokerId, dev);
    const key = `${st.state} ${st.reason}`;
    if (!force && this.emitted.get(sid) === key) return;
    if (!this.emitted.has(sid) && this.emitted.size > LIMITS.maxDevicesPerBroker * 8) return;
    this.emitted.set(sid, key);
    this.emit('source-state', { sourceType: 'iot', sourceId: sid, state: st.state, reason: st.reason });
  }

  _state(brokerId, dev) {
    this._emitState(brokerId, dev.id, dev);
    // Values under a changed availability get their new effective quality.
    for (const tag of dev.tags.values()) if (tag.rx) this._sample(brokerId, dev, tag);
  }

  _meta(brokerId, dev, opts = {}) {
    if (opts.removed) this._emitState(brokerId, dev.id, null);
    if (this.metaTimer) return;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      this.emit('meta-changed');
    }, this.metaDebounceMs);
    this.metaTimer.unref?.();
  }

  _poll() {
    for (const b of this.brokers.values()) {
      // A removed broker: its devices go (the stored detection config stays for when it returns).
      if (this.manager.getConnection && !this.manager.getConnection(b.id)) {
        for (const h of b.handlers.values()) h.close?.();
        b.registry.clear();
        this.brokers.delete(b.id);
        this.checked.delete(b.id);
        continue;
      }
      const up = this._brokerUp(b.id);
      if (up === b.connected) continue;
      b.connected = up;
      if (up) this._ensureSubscriptions(b.id);
      for (const dev of b.registry.devices.values()) this._state(b.id, dev);
    }
    // Watched sources whose device is unknown still need a state when the broker changes.
    for (const [sid] of this.emitted) {
      const p = parseSourceId(sid);
      if (!p) continue;
      const dev = this.brokers.get(p.brokerId)?.registry.get(p.deviceId) || null;
      if (!dev) this._emitState(p.brokerId, p.deviceId, null);
    }
  }

  // ---- tag source contract (TagBindings) --------------------------------------------------

  async ensureMonitored(sourceId, address) {
    const p = parseSourceId(sourceId);
    if (!p) throw new Error(`bad iot source id ${sourceId}`);
    if (!this._brokerUp(p.brokerId)) {
      this._emitState(p.brokerId, p.deviceId, null);
      throw new Error(`broker ${p.brokerId} is not connected`);
    }
    const b = this.brokers.get(p.brokerId);
    const dev = b?.registry.get(p.deviceId) || null;
    queueMicrotask(() => {
      this._emitState(p.brokerId, p.deviceId, dev);
      const tag = dev?.tags.get(address);
      if (tag?.rx) this._sample(p.brokerId, dev, tag); // what is already known publishes now
    });
  }

  // ---- reads for routes, the binding model and MCP -----------------------------------------

  /** Device -> plain summary (and tags with values when `withTags`). */
  view(brokerId, dev, { withTags = false } = {}) {
    const conn = this.manager.getConnection?.(brokerId);
    const out = {
      id: dev.id,
      sourceId: sourceIdOf(brokerId, dev.id),
      brokerId,
      brokerName: conn?.name || brokerId,
      convention: dev.convention,
      conventionLabel: BY_ID.get(dev.convention)?.label || dev.convention,
      stableId: dev.stableId ?? null,
      name: dev.name,
      manufacturer: dev.manufacturer || null,
      model: dev.model || null,
      description: dev.description || null,
      details: dev.details || {},
      availability: this._brokerUp(brokerId) ? dev.availability : 'offline',
      availabilityReason: this._brokerUp(brokerId) ? dev.availabilityReason : 'broker not connected',
      lastSeen: dev.lastSeen || null,
      tagCount: dev.tags.size
    };
    if (withTags) {
      out.tags = [...dev.tags.values()].map((t) => {
        const eff = this._brokerUp(brokerId) ? IotRegistry.effective(dev, t) : { q: BAD, reason: 'broker not connected' };
        const { value, q: _q, reason: _r, rx, t: ts, ...meta } = t;
        return { ...meta, value, quality: t.rx ? eff.q : null, qualityReason: t.rx ? eff.reason || null : 'no value received yet', sourceTime: ts || null, receivedAt: rx || null };
      });
    }
    return out;
  }

  listDevices({ brokerId = null, convention = null, q = null, limit = 5000 } = {}) {
    const out = [];
    const needle = q ? String(q).toLowerCase() : null;
    for (const b of this.brokers.values()) {
      if (brokerId && b.id !== brokerId) continue;
      for (const dev of b.registry.devices.values()) {
        if (convention && dev.convention !== convention) continue;
        if (needle && !`${dev.name} ${dev.model || ''} ${dev.manufacturer || ''} ${dev.id}`.toLowerCase().includes(needle)) continue;
        out.push(this.view(b.id, dev));
        if (out.length >= limit) return out;
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  getDevice(brokerId, deviceId) {
    const dev = this.brokers.get(brokerId)?.registry.get(deviceId);
    return dev ? this.view(brokerId, dev, { withTags: true }) : null;
  }

  /** Raw registry device (binding model: tag definitions). */
  rawDevice(brokerId, deviceId) {
    return this.brokers.get(brokerId)?.registry.get(deviceId) || null;
  }

  /** Detection status of one broker: config, suggestions, per-convention counts and stats. */
  status(brokerId) {
    const b = this.brokers.get(brokerId);
    const counts = {};
    for (const dev of b?.registry.devices.values() || []) counts[dev.convention] = (counts[dev.convention] || 0) + 1;
    return {
      brokerId,
      config: this.getConfig(brokerId),
      conventions: CONVENTIONS.map((c) => ({ id: c.id, label: c.label, devices: counts[c.id] || 0, errors: b?.stats.errors[c.id] || 0, info: b?.registry.info[c.id] || null })),
      suggestions: [...(this.suggest.get(brokerId)?.values() || [])].filter((s) => !b?.config.conventions[s.convention]?.enabled),
      stats: b ? { messages: b.stats.messages, refusedLarge: b.stats.refusedLarge, refusedDepth: b.stats.refusedDepth, lastError: b.stats.lastError, refusedDevices: b.registry.refused.devices, refusedTags: b.registry.refused.tags, devices: b.registry.devices.size, tags: b.registry.tagCount } : null,
      limits: { maxDevicesPerBroker: LIMITS.maxDevicesPerBroker, maxTagsPerDevice: LIMITS.maxTagsPerDevice, maxTagsPerBroker: LIMITS.maxTagsPerBroker, maxPayloadBytes: LIMITS.maxPayloadBytes, maxJsonDepth: LIMITS.maxJsonDepth }
    };
  }

  /** Topic filters the enabled conventions of a broker read (loop check at mapping save time). */
  readFilters(brokerId) {
    const b = this.brokers.get(brokerId);
    if (!b) return [];
    const out = [];
    for (const [id] of b.handlers) {
      const { enabled: _e, ...opts } = b.config.conventions[id];
      out.push(...BY_ID.get(id).filters(opts));
    }
    return out;
  }
}

module.exports = { IotManager, CONVENTIONS, normalizeConfig, sourceIdOf, parseSourceId, COLLECTION };
