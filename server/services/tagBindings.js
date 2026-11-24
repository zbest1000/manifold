'use strict';

const { compiledView } = require('./mqttMatch');
const { OpcuaSource, opcQuality } = require('./tagSources/opcuaSource');

/**
 * Tag bindings - the bridge from "browse a device's tags" to "they live in the
 * UNS". A binding selects tags from a driver source and publishes their values
 * to a UNS destination:
 *
 *   source: { type: 'opcua', connectionId, samplingInterval?,
 *             tags: [{ address: <nodeId>, name }] }
 *         | { type: <any registered device source>, connectionId|deviceId,
 *             samplingInterval?, tags: [{ address, name }] }
 *         | { type: 'sparkplug', brokerId, group, edge, device?,
 *             metrics?: [names]   // omitted = all metrics of the endpoint
 *           }
 *   target: { mode: 'mqtt', brokerId, pathTemplate ('site/area/{name}'),
 *             format: 'plain' | 'envelope', qos?, retain?, deadband?,
 *             statusTopic? (false = no retained <path>/_status document) }
 *         | { mode: 'sparkplug', brokerId, group, edge, device }
 *   rbe?:   { heartbeatMs? }   // republish unchanged values at least this often
 *
 * (MQTT-source tags don't come through here - the wizard compiles those into
 * pipeline routes, which already do this job.)
 *
 * Tag sources are pluggable adapters (registerSource) emitting normalized
 * 'sample' and 'source-state' events; the OPC UA adapter is in
 * ./tagSources/opcuaSource.js and is registered automatically.
 *
 * Semantics the industry expects and this enforces:
 * - Report-by-exception: an absolute `deadband` suppresses numeric changes
 *   smaller than the band; other values publish on change only. Change
 *   detection keys on (value, quality); structured values compare by JSON.
 * - Quality propagation: quality rides along in `envelope` format. When a
 *   source goes offline every known tag of its bindings gets one Bad (q=0)
 *   publish (envelope only: `plain` cannot carry quality, so there only the
 *   retained status document changes). Recovery republishes as Good.
 * - Device status: mqtt targets get a retained `<path>/_status`
 *   { online, since, reason } document; sparkplug targets get DDEATH/DBIRTH.
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

function slug(name) {
  return String(name).trim().replace(/[\s/+#]+/g, '_');
}

function targetTopic(template, tagName) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, slug(tagName)) : `${t.replace(/\/+$/, '')}/${slug(tagName)}`;
}

/** Retained device-status topic: `{name}` -> `_status`, else `<template>/_status`. */
function statusTopic(template) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, '_status') : `${t.replace(/\/+$/, '')}/_status`;
}

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

const sourceIdOf = (b) => b.source.connectionId ?? b.source.deviceId;

class TagBindings {
  constructor({ mqttManager, opcuaManager, profiles, sparkplugPublisher, retryMs = 15000, heartbeatTickMs = 1000 }) {
    this.manager = mqttManager;
    this.opcua = opcuaManager;
    this.profiles = profiles;
    this.spb = sparkplugPublisher;
    this.retryMs = retryMs;
    this.heartbeatTickMs = heartbeatTickMs;
    this.status = new Map(); // bindingId -> { published, suppressed, errors, lastError, lastTs, sourceState }
    this.last = new Map(); // bindingId -> Map(tagName -> { v, q, type, ts, pubAt })
    this.sigs = new Map(); // bindingId -> config signature (edit detection)
    this.monitored = new Set(); // `${sourceType} ${sourceId} ${address}` monitor requests already made
    this.sourceState = new Map(); // `${sourceType} ${sourceId}` -> { state, since, reason }
    this.sources = new Map(); // sourceType -> { adapter, onSample, onState }
    this.onMessage = this.onMessage.bind(this);
    this.started = false;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this._syncing = null;
    this._syncAgain = false;

    // Compiled index, rebuilt on profile-store revision change.
    this.index = compiledView(profiles, () => {
      const byKey = new Map(); // `${type} ${id} ${address}` -> [{ binding, tag }]
      const bySource = new Map(); // `${type} ${id}` -> [binding]
      const heartbeat = [];
      for (const b of this.profiles.listIn('bindings')) {
        const type = b.source?.type;
        if (b.enabled === false || !type || type === 'sparkplug') continue;
        const sk = `${type} ${sourceIdOf(b)}`;
        if (!bySource.has(sk)) bySource.set(sk, []);
        bySource.get(sk).push(b);
        if (Number(b.rbe?.heartbeatMs) > 0) heartbeat.push(b);
        for (const tag of b.source.tags || []) {
          const key = `${sk} ${tag.address}`;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push({ binding: b, tag });
        }
      }
      return { byKey, bySource, heartbeat };
    });
    this.spIndex = compiledView(profiles, () =>
      this.profiles.listIn('bindings').filter((b) => b.enabled !== false && b.source?.type === 'sparkplug')
    );

    if (opcuaManager) this.registerSource('opcua', new OpcuaSource(opcuaManager));
  }

  /**
   * Register a tag source adapter: { on, off, ensureMonitored(sourceId, address, intervalMs) }
   * emitting 'sample' { sourceType, sourceId, address, v, type, q, qReason?, tSource?, tRead }
   * and 'source-state' { sourceType, sourceId, state: 'online'|'offline', reason }.
   */
  registerSource(type, adapter) {
    const prev = this.sources.get(type);
    if (prev) this._detach(prev);
    const entry = {
      adapter,
      onSample: (smp) => this.onSample(smp),
      onState: (evt) => this.onSourceState(evt)
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
  }

  _detach(e) {
    e.adapter.off?.('sample', e.onSample);
    e.adapter.off?.('source-state', e.onState);
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
    this.retryTimer = null;
    this.heartbeatTimer = null;
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
   * Drop state belonging to deleted bindings, and reset the value/status state
   * of bindings whose configuration changed. Call after any binding edit.
   */
  reconcile() {
    const live = new Map();
    for (const b of this.profiles.listIn('bindings')) live.set(b.id, b);
    for (const id of new Set([...this.status.keys(), ...this.last.keys(), ...this.sigs.keys()])) {
      if (!live.has(id)) {
        this.status.delete(id);
        this.last.delete(id);
        this.sigs.delete(id);
      }
    }
    for (const [id, b] of live) {
      const sig = JSON.stringify([b.enabled !== false, b.source, b.target, b.rbe]);
      if (this.sigs.has(id) && this.sigs.get(id) !== sig) {
        this.last.delete(id);
        this.status.delete(id);
      }
      this.sigs.set(id, sig);
    }
    // Forget monitor requests no enabled binding wants any more (bounded set).
    const wanted = new Set();
    for (const hits of this.index().byKey.values()) {
      for (const { binding: b, tag } of hits) wanted.add(`${b.source.type} ${sourceIdOf(b)} ${tag.address}`);
    }
    for (const k of this.monitored) if (!wanted.has(k)) this.monitored.delete(k);
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
        for (const b of this.profiles.listIn('bindings')) {
          const type = b.source?.type;
          if (b.enabled === false || !type || type === 'sparkplug') continue;
          const src = this.sources.get(type);
          if (!src) continue;
          const interval = Number(b.source.samplingInterval) > 0 ? Number(b.source.samplingInterval) : 1000;
          for (const tag of b.source.tags || []) {
            const key = `${type} ${sourceIdOf(b)} ${tag.address}`;
            if (this.monitored.has(key)) continue;
            this.monitored.add(key);
            try {
              await src.adapter.ensureMonitored(sourceIdOf(b), tag.address, interval);
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
    for (const { binding, tag } of hits) {
      this._publishTag(binding, tag.name || tag.address, smp.v, smp.q, ts, smp.type);
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
    for (const b of this.index().bySource.get(sk) || []) {
      this._status(b.id).sourceState = { ...st };
      if (evt.state === 'offline') this._publishBad(b, now);
      this._publishDeviceStatus(b, st);
    }
  }

  /** One Bad-quality publish per known tag (envelope only; plain cannot carry quality). */
  _publishBad(b, now) {
    const target = b.target || {};
    const m = this.last.get(b.id);
    if (!m || target.mode !== 'mqtt' || target.format !== 'envelope') return;
    for (const [name, e] of m) {
      if (e.q === 0) continue;
      e.q = 0;
      e.pubAt = now;
      this._emit(b, name, e.v, 0, now, e.type);
    }
  }

  _publishDeviceStatus(b, st) {
    const target = b.target || {};
    const s = this._status(b.id);
    if (target.mode === 'sparkplug') {
      try {
        this.spb?.setDeviceOnline?.({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: target.device || slug(b.name || b.id),
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
        statusTopic(target.pathTemplate),
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
    for (const b of this.index().heartbeat) {
      const m = this.last.get(b.id);
      if (!m) continue;
      const hb = Number(b.rbe.heartbeatMs);
      const st = this.sourceState.get(`${b.source.type} ${sourceIdOf(b)}`);
      // An offline source's stale values must not masquerade as live ones.
      if (st?.state === 'offline' && b.target?.format !== 'envelope') continue;
      for (const [name, e] of m) {
        if (now - e.pubAt < hb) continue;
        e.pubAt = now;
        this._emit(b, name, e.v, e.q, e.ts, e.type);
      }
    }
  }

  onMessage(msg) {
    const bindings = this.spIndex();
    if (!bindings.length || !msg.sparkplug || !Array.isArray(msg.sparkplug.metrics)) return;
    // Topic: spBv1.0/{group}/{type}/{edge}[/{device}]
    const parts = msg.topicParts || msg.topic.split('/');
    if (parts[0] !== 'spBv1.0' || !/^(N|D)(DATA|BIRTH)$/.test(parts[2] || '')) return;
    const [, group, , edge, device = null] = parts;

    for (const b of bindings) {
      const src = b.source;
      if (src.brokerId !== msg.brokerId || src.group !== group || src.edge !== edge) continue;
      if (src.device && src.device !== device) continue;
      const wanted = Array.isArray(src.metrics) && src.metrics.length ? new Set(src.metrics) : null;
      for (const m of msg.sparkplug.metrics) {
        if (!m || m.name === undefined || m.name === null) continue;
        if (wanted && !wanted.has(m.name)) continue;
        this._publishTag(
          b,
          m.name,
          m.value,
          192,
          new Date(msg.timestamp).getTime() || Date.now(),
          SPB_TYPES[m.datatypeName]
        );
      }
    }
  }

  _publishTag(binding, tagName, value, quality, ts, type) {
    const s = this._status(binding.id);
    const target = binding.target || {};
    let m = this.last.get(binding.id);
    if (!m) {
      m = new Map();
      this.last.set(binding.id, m);
    }
    const prev = m.get(tagName);
    const now = Date.now();

    // Report by exception on (value, quality): deadband for numerics,
    // structural compare for the rest. A quality change is always a change.
    if (prev) {
      let same;
      const band = Number(target.deadband) || 0;
      if (typeof value === 'number' && typeof prev.v === 'number' && band > 0) same = Math.abs(value - prev.v) < band;
      else same = sameValue(value, prev.v);
      if (same) {
        if (prev.q === quality) {
          s.suppressed++;
          return;
        }
        // Quality-only change: only the mqtt envelope can express it.
        if (!(target.mode === 'mqtt' && target.format === 'envelope')) {
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
    this._emit(binding, tagName, value, quality, ts, type);
  }

  _emit(binding, tagName, value, quality, ts, type) {
    const s = this._status(binding.id);
    const target = binding.target || {};
    s.lastTs = Date.now();

    if (target.mode === 'sparkplug') {
      try {
        this.spb.updateDevice({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: target.device || slug(binding.name || binding.id),
          metrics: [{ name: tagName, value, ts, type: type && type !== 'unknown' ? type : undefined }]
        });
        s.published++;
      } catch (error) {
        s.errors++;
        s.lastError = error.message;
      }
      return;
    }

    // mqtt target
    const topic = targetTopic(target.pathTemplate, tagName);
    const payload = target.format === 'envelope' ? { v: value, t: ts, q: quality } : value;
    this.manager
      .publish(target.brokerId, topic, payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
  }

  getStatus() {
    return Object.fromEntries(this.status);
  }
}

module.exports = { TagBindings, opcQuality, targetTopic, statusTopic, slug };
