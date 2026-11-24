'use strict';

const { compiledView } = require('./mqttMatch');
const { OpcuaSource, opcQuality } = require('./tagSources/opcuaSource');
const model = require('./bindingModel');

const { slug, targetTopic, statusTopic } = model;

/**
 * Tag bindings - the bridge from "browse a device's tags" to "they live in the
 * UNS". A binding selects tags from a driver source and publishes their values
 * to a UNS destination:
 *
 *   source: { type: 'opcua', connectionId, samplingInterval?,
 *             tags: [{ address: <nodeId>, name, unit?, description?, type?, range? }] }
 *         | { type: 'device', deviceId, tags: [tagKey | { address: tagKey, name? }] | 'all' }
 *         | { type: 'device-profile', profileId, tags: [profile tag key | {address,name?}] | 'all' }
 *         | { type: <any registered source>, connectionId|deviceId, samplingInterval?, tags }
 *         | { type: 'sparkplug', brokerId, group, edge, device?,
 *             metrics?: [names]   // omitted = all metrics of the endpoint
 *           }
 *   target: { mode: 'mqtt', brokerId,
 *             assetPath ('acme/dallas/line4/filler')  | pathTemplate ('site/area/{name}', legacy)
 *             | assetPaths {deviceId: path} / assetPathTemplate ('acme/{device}')  (device-profile),
 *             layout: 'topic-per-tag' (default) | 'object-per-asset', maxObjectBytes?,
 *             format: 'plain' | 'envelope', qos?, retain?, deadband? (legacy absolute),
 *             statusTopic? (false = no retained <asset>/_status document),
 *             metaTopic?   (false = no retained <asset>/_meta document),
 *             historian?:  { historianId }   (opt-in direct store-and-forward target) }
 *         | { mode: 'sparkplug', brokerId, group, edge, device (device-profile: may use {device}/{param}),
 *             historian? }
 *   rbe?:   { heartbeatMs?, deadband?: { type: 'absolute'|'percent', value } }
 *
 * Topic resolution, payload shapes, the _meta document, the object-per-asset
 * format, deadband semantics and validation live in ./bindingModel.js (its
 * header documents them); this file is the runtime.
 *
 * Tag sources are pluggable adapters (registerSource) emitting normalized
 * 'sample' and 'source-state' events, and optionally 'batch-end'
 * { sourceType, sourceId } after each batch of samples (DeviceManager emits it
 * per poll-group cycle). object-per-asset units flush on batch-end; for
 * sources that never emit it they flush on a short timer (objectFlushMs).
 *
 * Semantics the industry expects and this enforces:
 * - Report-by-exception: deadband (absolute or percent) suppresses numeric
 *   changes smaller than the band; other values publish on change only. Change
 *   detection keys on (value, quality); structured values compare by JSON.
 * - Quality propagation: quality rides along in `envelope` format and always in
 *   object payloads. When a source goes offline every known tag of its bindings
 *   gets one Bad (q=0) publish (`plain` per-tag cannot carry quality, so there
 *   only the retained status document changes). Recovery republishes as Good.
 * - Device status: mqtt targets get a retained `<asset>/_status`
 *   { online, since, reason } document; sparkplug targets get DDEATH/DBIRTH.
 * - Metadata: a retained `<asset>/_meta` document per unit, (re)published on
 *   start and whenever the binding or its tags' metadata change; Sparkplug
 *   targets carry unit/description/range as metric properties in DBIRTH.
 * - Retained cleanup: reconcile() keeps the set of retained topics the current
 *   config owns (derived deterministically from config) and clears, with an
 *   empty retained publish, every topic that left the set - binding deleted,
 *   disabled, renamed (path/broker change), retain switched off, profile
 *   instance removed. Call reconcile() after any binding/device/profile edit.
 * - Lifecycle: on a source coming (back) online monitors are re-requested;
 *   failed monitor requests retry on a slow timer.
 * - Read-only: bindings never write to a device. There is deliberately no
 *   write path in this engine.
 */

const SPB_TYPES = {
  Int8: 'int8', Int16: 'int16', Int32: 'int32', Int64: 'int64', UInt8: 'uint8', UInt16: 'uint16',
  UInt32: 'uint32', UInt64: 'uint64', Float: 'float32', Double: 'float64', Boolean: 'bool',
  String: 'string', DateTime: 'datetime'
};

const MAX_COMPARE_JSON = 64 * 1024;
const NO_META = Object.freeze({});

/** Equality for change detection: primitives by Object.is, structures by bounded JSON. */
function sameValue(a, b) {
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    const ja = JSON.stringify(a);
    if (ja.length > MAX_COMPARE_JSON) return false; // too big to compare: treat as changed
    return ja === JSON.stringify(b);
  } catch {
    return false;
  }
}

const bindingIdOf = (unitId) => {
  const i = unitId.indexOf('#');
  return i < 0 ? unitId : unitId.slice(0, i);
};

class TagBindings {
  constructor({
    mqttManager,
    opcuaManager,
    profiles,
    sparkplugPublisher,
    outbox = null,
    retryMs = 15000,
    heartbeatTickMs = 1000,
    objectFlushMs = 50
  }) {
    this.manager = mqttManager;
    this.opcua = opcuaManager;
    this.profiles = profiles;
    this.spb = sparkplugPublisher;
    this.outbox = outbox;
    this.retryMs = retryMs;
    this.heartbeatTickMs = heartbeatTickMs;
    this.objectFlushMs = objectFlushMs;
    this.status = new Map(); // bindingId -> { published, suppressed, errors, lastError, lastTs, sourceState }
    this.last = new Map(); // unitId -> Map(tagName -> { v, q, type, ts, pubAt })
    this.objects = new Map(); // unitId -> { dirty, pubAt, t, changed:Set(name) } (object-per-asset units)
    this.sigs = new Map(); // bindingId -> config signature (edit detection)
    this.metaSent = new Map(); // unitId -> `${broker} ${topic} ${json}` of the last _meta publish
    this.retained = new Map(); // `${broker}\0${topic}` -> { brokerId, topic } owned by the current config
    this.monitored = new Set(); // `${sourceType} ${sourceId} ${address}` monitor requests already made
    this.sourceState = new Map(); // `${sourceType} ${sourceId}` -> { state, since, reason }
    this.sources = new Map(); // sourceType -> { adapter, onSample, onState, onBatchEnd }
    this._dirtyObjects = new Map(); // unitId -> unit awaiting an object flush
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.objectTimer = null;
    this._syncing = null;
    this._syncAgain = false;

    // Compiled index, rebuilt on profile-store revision change.
    this.index = compiledView(profiles, () => {
      const byKey = new Map(); // `${type} ${id} ${address}` -> [{ unit, tag }]
      const bySource = new Map(); // `${type} ${id}` -> [unit]
      const heartbeat = [];
      const units = new Map(); // unitId -> unit
      for (const b of this.profiles.listIn('bindings')) {
        const type = b.source?.type;
        if (b.enabled === false || !type || type === 'sparkplug') continue;
        for (const unit of model.expandUnits(b, this.profiles)) {
          if (unit.error) continue;
          unit.layout = model.layoutOf(b);
          unit.deadband = model.deadbandOf(b);
          unit.metaByName = new Map(unit.tags.map((t) => [t.name, t.meta]));
          units.set(unit.id, unit);
          const sk = `${unit.sourceType} ${unit.sourceId}`;
          if (!bySource.has(sk)) bySource.set(sk, []);
          bySource.get(sk).push(unit);
          if (Number(b.rbe?.heartbeatMs) > 0) heartbeat.push(unit);
          for (const tag of unit.tags) {
            const key = `${sk} ${tag.address}`;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push({ unit, tag });
          }
        }
      }
      return { byKey, bySource, heartbeat, units };
    });
    this.spIndex = compiledView(profiles, () =>
      this.profiles
        .listIn('bindings')
        .filter((b) => b.enabled !== false && b.source?.type === 'sparkplug')
        .map((b) => {
          const [unit] = model.expandUnits(b, this.profiles);
          unit.layout = 'topic-per-tag';
          unit.deadband = model.deadbandOf(b);
          unit.metaByName = new Map();
          return unit;
        })
    );

    if (opcuaManager) this.registerSource('opcua', new OpcuaSource(opcuaManager));
  }

  /** Late wiring of the historian outbox (direct historian targets). */
  setOutbox(outbox) {
    this.outbox = outbox || null;
  }

  /**
   * Register a tag source adapter: { on, off, ensureMonitored(sourceId, address, intervalMs) }
   * emitting 'sample' { sourceType, sourceId, address, v, type, q, qReason?, tSource?, tRead },
   * 'source-state' { sourceType, sourceId, state: 'online'|'offline', reason } and,
   * optionally, 'batch-end' { sourceType, sourceId }.
   */
  registerSource(type, adapter) {
    const prev = this.sources.get(type);
    if (prev) this._detach(prev);
    const entry = {
      adapter,
      onSample: (smp) => this.onSample(smp),
      onState: (evt) => this.onSourceState(evt),
      onBatchEnd: (evt) => this.onBatchEnd(evt)
    };
    this.sources.set(type, entry);
    if (this.started) {
      this._attach(entry);
      this.syncMonitors();
    }
  }

  _attach(e) {
    e.adapter.on('sample', e.onSample);
    e.adapter.on('source-state', e.onState);
    e.adapter.on('batch-end', e.onBatchEnd);
  }

  _detach(e) {
    e.adapter.off?.('sample', e.onSample);
    e.adapter.off?.('source-state', e.onState);
    e.adapter.off?.('batch-end', e.onBatchEnd);
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const e of this.sources.values()) this._attach(e);
    this.manager.on('message', this.onMessage);
    this.heartbeatTimer = setInterval(() => this._heartbeatSweep(), this.heartbeatTickMs);
    this.heartbeatTimer.unref?.();
    this.reconcile();
    this.syncMonitors();
  }

  stop() {
    for (const e of this.sources.values()) this._detach(e);
    this.manager.off('message', this.onMessage);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.objectTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.objectTimer = null;
    this._dirtyObjects.clear();
    this.started = false;
  }

  _status(id) {
    let s = this.status.get(id);
    if (!s) {
      s = { published: 0, suppressed: 0, errors: 0, lastError: null, lastTs: 0, sourceState: null };
      this.status.set(id, s);
    }
    return s;
  }

  /**
   * Drop state belonging to deleted bindings, reset the value/status state of
   * bindings whose configuration changed, clear retained topics the config no
   * longer owns and (re)publish changed _meta documents. Call after any
   * binding, device or profile edit.
   */
  reconcile() {
    const live = new Map();
    for (const b of this.profiles.listIn('bindings')) live.set(b.id, b);
    const changed = new Set();
    for (const id of new Set([...this.status.keys(), ...this.sigs.keys()])) {
      if (!live.has(id)) {
        this.status.delete(id);
        this.sigs.delete(id);
        changed.add(id);
      }
    }
    for (const [id, b] of live) {
      const sig = JSON.stringify([b.enabled !== false, b.source, b.target, b.rbe]);
      if (this.sigs.has(id) && this.sigs.get(id) !== sig) {
        this.status.delete(id);
        changed.add(id);
      }
      this.sigs.set(id, sig);
    }
    // Per-unit state: drop units that no longer exist or whose binding changed.
    const units = this.index().units;
    for (const map of [this.last, this.objects, this.metaSent, this._dirtyObjects]) {
      for (const unitId of [...map.keys()]) {
        if (!units.has(unitId) || changed.has(bindingIdOf(unitId))) {
          if (map === this.metaSent && units.has(unitId)) continue; // meta compares content itself
          map.delete(unitId);
        }
      }
    }
    // Forget monitor requests no enabled binding wants any more (bounded set).
    const wanted = new Set();
    for (const unit of units.values()) for (const tag of unit.tags) wanted.add(`${unit.sourceType} ${unit.sourceId} ${tag.address}`);
    for (const k of this.monitored) if (!wanted.has(k)) this.monitored.delete(k);

    this._syncRetained();
    this._publishMetaAll();
  }

  /** Clear (empty retained publish) every retained topic the config no longer owns. */
  _syncRetained() {
    const next = new Map();
    for (const b of this.profiles.listIn('bindings')) {
      for (const r of model.retainedTopics(b, this.profiles)) next.set(`${r.brokerId}\u0000${r.topic}`, r);
    }
    for (const [key, r] of this.retained) {
      if (next.has(key)) continue;
      Promise.resolve()
        .then(() => this.manager.publish(r.brokerId, r.topic, '', { qos: 1, retain: true }))
        .catch(() => {}); // broker gone: nothing to clear on it now
    }
    this.retained = next;
    // A unit whose meta topic was cleared must republish it if it comes back.
    for (const [unitId, sent] of this.metaSent) {
      const [brokerId, topic] = sent.split(' ', 2);
      if (!next.has(`${brokerId}\u0000${topic}`)) this.metaSent.delete(unitId);
    }
  }

  /** Publish the retained _meta document of every mqtt unit whose content changed. */
  _publishMetaAll() {
    const seen = new Set();
    for (const unit of this.index().units.values()) {
      const b = unit.binding;
      const target = b.target || {};
      if (target.mode !== 'mqtt' || target.metaTopic === false || !unit.tags.length || !target.brokerId) continue;
      seen.add(unit.id);
      const topic = model.metaTopicOf(unit);
      const doc = model.metaDoc(unit);
      const sig = `${target.brokerId} ${topic} ${JSON.stringify(doc)}`;
      if (this.metaSent.get(unit.id) === sig) continue;
      this.metaSent.set(unit.id, sig);
      const s = this._status(b.id);
      Promise.resolve()
        .then(() => this.manager.publish(target.brokerId, topic, { ...doc, updatedAt: Date.now() }, { qos: 1, retain: true }))
        .catch((error) => {
          s.errors++;
          s.lastError = `_meta: ${error.message}`;
          this.metaSent.delete(unit.id); // retried on the next reconcile
        });
    }
    for (const id of [...this.metaSent.keys()]) if (!seen.has(id)) this.metaSent.delete(id);
  }

  /** Ensure every device tag in an enabled binding has a monitored item. */
  syncMonitors() {
    if (this._syncing) {
      this._syncAgain = true;
      return this._syncing;
    }
    this._syncing = (async () => {
      let failed = false;
      do {
        this._syncAgain = false;
        for (const unit of [...this.index().units.values()]) {
          const src = this.sources.get(unit.sourceType);
          if (!src) continue;
          const b = unit.binding;
          const interval = Number(b.source.samplingInterval) > 0 ? Number(b.source.samplingInterval) : 1000;
          for (const tag of unit.tags) {
            const key = `${unit.sourceType} ${unit.sourceId} ${tag.address}`;
            if (this.monitored.has(key)) continue;
            this.monitored.add(key);
            try {
              await src.adapter.ensureMonitored(unit.sourceId, tag.address, interval);
            } catch (error) {
              this.monitored.delete(key); // retried on the slow timer
              failed = true;
              this._status(b.id).lastError = `monitor ${tag.address}: ${error.message}`;
            }
          }
        }
      } while (this._syncAgain);
      if (failed) this._scheduleRetry();
    })().finally(() => {
      this._syncing = null;
    });
    return this._syncing;
  }

  _scheduleRetry() {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.syncMonitors();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  onSample(smp) {
    const hits = this.index().byKey.get(`${smp.sourceType} ${smp.sourceId} ${smp.address}`);
    if (!hits) return;
    const ts = Number(smp.tSource) || Number(smp.tRead) || Date.now();
    for (const { unit, tag } of hits) {
      this._publishTag(unit, tag.name, smp.v, smp.q, ts, smp.type);
    }
  }

  /** Source batch boundary: flush the object payloads of that source's units. */
  onBatchEnd(evt) {
    if (!evt || !this._dirtyObjects.size) return;
    for (const unit of this.index().bySource.get(`${evt.sourceType} ${evt.sourceId}`) || []) {
      if (this._dirtyObjects.has(unit.id)) this._flushObject(unit);
    }
  }

  onSourceState(evt) {
    if (!evt || (evt.state !== 'online' && evt.state !== 'offline')) return;
    const sk = `${evt.sourceType} ${evt.sourceId}`;
    const now = Date.now();
    const prev = this.sourceState.get(sk);
    const st = {
      state: evt.state,
      since: prev && prev.state === evt.state ? prev.since : now,
      reason: evt.reason ?? null
    };
    this.sourceState.set(sk, st);

    if (evt.state === 'online') {
      // Session is (re)usable: monitored items may be gone, so re-request them.
      for (const k of [...this.monitored]) if (k.startsWith(`${sk} `)) this.monitored.delete(k);
      this.syncMonitors();
    }
    for (const unit of this.index().bySource.get(sk) || []) {
      this._status(unit.binding.id).sourceState = { ...st };
      if (evt.state === 'offline') this._publishBad(unit, now);
      this._publishDeviceStatus(unit, st);
    }
  }

  /** One Bad-quality publish per known tag (envelope / object only; plain cannot carry quality). */
  _publishBad(unit, now) {
    const target = unit.binding.target || {};
    const m = this.last.get(unit.id);
    if (!m || target.mode !== 'mqtt') return;
    if (unit.layout === 'object-per-asset') {
      const o = this._objectState(unit.id);
      let any = false;
      for (const [name, e] of m) {
        if (e.q === 0) continue;
        e.q = 0;
        e.ts = now;
        o.changed.add(name);
        any = true;
      }
      if (any) {
        o.t = now;
        this._flushObject(unit, { force: true });
      }
      return;
    }
    if (target.format !== 'envelope') return;
    for (const [name, e] of m) {
      if (e.q === 0) continue;
      e.q = 0;
      e.pubAt = now;
      this._emit(unit, name, e.v, 0, now, e.type);
    }
  }

  _publishDeviceStatus(unit, st) {
    const b = unit.binding;
    const target = b.target || {};
    const s = this._status(b.id);
    if (target.mode === 'sparkplug') {
      try {
        this.spb?.setDeviceOnline?.({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: unit.spDevice,
          online: st.state === 'online'
        });
      } catch (error) {
        s.errors++;
        s.lastError = error.message;
      }
      return;
    }
    if (target.mode !== 'mqtt' || target.statusTopic === false) return;
    Promise.resolve(
      this.manager.publish(
        target.brokerId,
        model.statusTopicOf(unit),
        { online: st.state === 'online', since: st.since, reason: st.reason },
        { qos: 1, retain: true }
      )
    )
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
  }

  _heartbeatSweep() {
    const now = Date.now();
    for (const unit of this.index().heartbeat) {
      const m = this.last.get(unit.id);
      if (!m) continue;
      const b = unit.binding;
      const hb = Number(b.rbe.heartbeatMs);
      const st = this.sourceState.get(`${unit.sourceType} ${unit.sourceId}`);
      if (unit.layout === 'object-per-asset') {
        const o = this.objects.get(unit.id);
        if (o && now - o.pubAt >= hb) this._flushObject(unit, { force: true, heartbeat: true });
        continue;
      }
      // An offline source's stale values must not masquerade as live ones.
      if (st?.state === 'offline' && b.target?.format !== 'envelope') continue;
      for (const [name, e] of m) {
        if (now - e.pubAt < hb) continue;
        e.pubAt = now;
        this._emit(unit, name, e.v, e.q, e.ts, e.type, { heartbeat: true });
      }
    }
  }

  onMessage(msg) {
    const units = this.spIndex();
    if (!units.length || !msg.sparkplug || !Array.isArray(msg.sparkplug.metrics)) return;
    // Topic: spBv1.0/{group}/{type}/{edge}[/{device}]
    const parts = msg.topicParts || msg.topic.split('/');
    if (parts[0] !== 'spBv1.0' || !/^(N|D)(DATA|BIRTH)$/.test(parts[2] || '')) return;
    const [, group, , edge, device = null] = parts;

    for (const unit of units) {
      const src = unit.binding.source;
      if (src.brokerId !== msg.brokerId || src.group !== group || src.edge !== edge) continue;
      if (src.device && src.device !== device) continue;
      const wanted = Array.isArray(src.metrics) && src.metrics.length ? new Set(src.metrics) : null;
      for (const m of msg.sparkplug.metrics) {
        if (!m || m.name === undefined || m.name === null) continue;
        if (wanted && !wanted.has(m.name)) continue;
        this._publishTag(
          unit,
          m.name,
          m.value,
          // per-metric quality/timestamp when the publisher supplied them
          m.quality === 0 || m.quality === 64 ? m.quality : 192,
          Number(m.sourceTimestamp) > 0 ? Number(m.sourceTimestamp) : new Date(msg.timestamp).getTime() || Date.now(),
          SPB_TYPES[m.datatypeName]
        );
      }
    }
  }

  _objectState(unitId) {
    let o = this.objects.get(unitId);
    if (!o) {
      o = { dirty: false, pubAt: 0, t: 0, changed: new Set() };
      this.objects.set(unitId, o);
    }
    return o;
  }

  _publishTag(unit, tagName, value, quality, ts, type) {
    const binding = unit.binding;
    const s = this._status(binding.id);
    const target = binding.target || {};
    const isObject = unit.layout === 'object-per-asset';
    let m = this.last.get(unit.id);
    if (!m) {
      m = new Map();
      this.last.set(unit.id, m);
    }
    const prev = m.get(tagName);
    const now = Date.now();

    // Report by exception on (value, quality): deadband for numerics,
    // structural compare for the rest. A quality change is always a change.
    if (prev) {
      const range = unit.metaByName.get(tagName)?.range;
      const same = sameValue(value, prev.v) || model.withinDeadband(unit.deadband, value, prev.v, range);
      if (same) {
        if (prev.q === quality) {
          s.suppressed++;
          return;
        }
        // Quality-only change: only the mqtt envelope / object payload can express it.
        if (!(target.mode === 'mqtt' && (target.format === 'envelope' || isObject))) {
          prev.q = quality;
          s.suppressed++;
          return;
        }
      }
      prev.v = value;
      prev.q = quality;
      prev.type = type;
      prev.ts = ts;
      prev.pubAt = now;
    } else {
      m.set(tagName, { v: value, q: quality, type, ts, pubAt: now });
    }
    if (isObject) {
      const o = this._objectState(unit.id);
      o.changed.add(tagName);
      if (ts > o.t) o.t = ts;
      o.dirty = true;
      this._dirtyObjects.set(unit.id, unit);
      this._scheduleObjectFlush();
      return;
    }
    this._emit(unit, tagName, value, quality, ts, type);
  }

  // ---- object-per-asset ----------------------------------------------------------

  _scheduleObjectFlush() {
    if (this.objectTimer) return;
    this.objectTimer = setTimeout(() => {
      this.objectTimer = null;
      for (const unit of [...this._dirtyObjects.values()]) this._flushObject(unit);
    }, this.objectFlushMs);
    this.objectTimer.unref?.();
  }

  _flushObject(unit, { force = false, heartbeat = false } = {}) {
    const o = this._objectState(unit.id);
    this._dirtyObjects.delete(unit.id);
    if (!o.dirty && !force) return;
    const m = this.last.get(unit.id);
    if (!m || !m.size) return;
    const b = unit.binding;
    const target = b.target || {};
    const s = this._status(b.id);
    const values = {};
    for (const [name, e] of m) values[slug(name)] = model.objectMember(e, unit.metaByName.get(name)?.unit);
    const payload = { t: o.t || Date.now(), values };
    const body = JSON.stringify(payload);
    const cap = model.objectCapOf(b);
    const changed = o.changed;
    o.dirty = false;
    o.changed = new Set();
    o.pubAt = Date.now();
    if (Buffer.byteLength(body) > cap) {
      s.errors++;
      s.lastError = `object payload of ${Buffer.byteLength(body)} bytes exceeds the ${cap}-byte cap; not published`;
      return;
    }
    s.lastTs = o.pubAt;
    const topic = model.objectTopicOf(unit);
    this.manager
      .publish(target.brokerId, topic, body, { qos: target.qos || 0, retain: Boolean(target.retain) })
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
    if (!heartbeat) {
      for (const name of changed) {
        const e = m.get(name);
        if (e) this._toHistorian(unit, model.valueTopicOf(unit, name), e.v, e.q, e.ts);
      }
    }
  }

  // ---- emit ------------------------------------------------------------------------

  _toHistorian(unit, tag, value, quality, ts) {
    const hid = unit.binding.target?.historian?.historianId;
    if (!hid || !this.outbox) return;
    try {
      this.outbox.enqueue(hid, [{ tag, ts, value, quality }]);
    } catch (error) {
      const s = this._status(unit.binding.id);
      s.errors++;
      s.lastError = `historian: ${error.message}`;
    }
  }

  _emit(unit, tagName, value, quality, ts, type, { heartbeat = false } = {}) {
    const binding = unit.binding;
    const s = this._status(binding.id);
    const target = binding.target || {};
    const meta = unit.metaByName.get(tagName) || NO_META;
    s.lastTs = Date.now();

    if (target.mode === 'sparkplug') {
      try {
        this.spb.updateDevice({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: unit.spDevice,
          metrics: [{ name: tagName, value, ts, type: type && type !== 'unknown' ? type : undefined, properties: model.sparkplugProps(meta) }]
        });
        s.published++;
      } catch (error) {
        s.errors++;
        s.lastError = error.message;
      }
      if (!heartbeat) this._toHistorian(unit, `${target.group}/${target.edge}/${unit.spDevice}/${tagName}`, value, quality, ts);
      return;
    }

    // mqtt target
    const topic = model.valueTopicOf(unit, tagName);
    const payload = target.format === 'envelope' ? model.envelope(value, ts, quality, meta.unit) : value;
    this.manager
      .publish(target.brokerId, topic, payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
    if (!heartbeat) this._toHistorian(unit, topic, value, quality, ts);
  }

  /** Newest known sample for a unit's tag (preview): { v, q, t, type } or null. */
  latest(unitId, tagName) {
    const e = this.last.get(unitId)?.get(tagName);
    return e ? { v: e.v, q: e.q, t: e.ts, type: e.type } : null;
  }

  getStatus() {
    return Object.fromEntries(this.status);
  }
}

module.exports = { TagBindings, opcQuality, targetTopic, statusTopic, slug };
