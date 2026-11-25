'use strict';

const { compiledView } = require('./mqttMatch');
const { messageTime } = require('./pipelineEngine');
const { OpcuaSource, opcQuality } = require('./tagSources/opcuaSource');
const { MqttSource } = require('./tagSources/mqttSource');
const model = require('./bindingModel');
const mqttRuntime = require('./bindingRuntimeMqtt');
const retainedOps = require('./bindingRetainedOps');
const { RetainedLedger, defaultLedgerFile } = require('./bindingRetained');

const { slug, targetTopic, statusTopic } = model;
const { normQuality } = require('./bindingMqtt');

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
 *         | { type: 'mqtt', brokerId, tags: [{ address: <topic>, name?, field?, ... }] | 'all', filter?,
 *             select?, overrides?, field?, staleAfterMs? }   (see ./bindingMqtt.js)
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
 *   Every owned topic is also recorded in a ledger file (./bindingRetained.js)
 *   so edits made while the server was down, a crash, or a clear aimed at a
 *   disconnected broker are cleaned once the broker is connected again
 *   (./bindingRetainedOps.js).
 * - MQTT-topic sources ride the coalesced message tap (./bindingRuntimeMqtt.js):
 *   a mapping never consumes what it publishes (refused at save, plus a hop
 *   guard shared with the pipeline engine at run time).
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

const DESCRIBE_BATCH = 8;
const DESCRIBE_MAX = 2000;
const DESCRIBE_BUDGET_MS = 30_000;

/** OPC UA describe() answer -> mapping metadata ({ type, unit, range: { min, max }, description }, set fields only) or null. */
function serverMetaFrom(d) {
  if (!d || typeof d !== 'object') return null;
  const m = {};
  if (d.type) m.type = d.type;
  if (d.unit) m.unit = String(d.unit);
  if (d.description) m.description = String(d.description);
  const r = d.range;
  if (r && Number.isFinite(Number(r.low ?? r.min)) && Number.isFinite(Number(r.high ?? r.max))) m.range = { min: Number(r.low ?? r.min), max: Number(r.high ?? r.max) };
  return Object.keys(m).length ? m : null;
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
    objectFlushMs = 50,
    pipelines = null,
    ledgerFile,
    brokerPollMs = 1000
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
    this.spMetaSent = new Map(); // unitId -> signature of the Sparkplug BIRTH properties last seen
    this._tx = { v: undefined, q: 0, r: undefined }; // reused transform result (no per-sample allocation)
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
    this.pipelines = pipelines; // hop registry shared with the pipeline engine (loop guard)
    this.hops = new Map(); // `${brokerId}\0${topic}` -> { depth, ts, by } of mqtt-sourced publishes
    this._hopOut = 0; // hop depth of the message being processed (0 = not mqtt-sourced)
    this._hopBy = null;
    this._rd = { v: undefined, q: 0, t: 0, u: undefined, r: undefined }; // reused MQTT read result
    this.rx = new Map(); // unitId -> Map(tagName -> last message time) (mqtt staleness)
    this.ledger = new RetainedLedger({ file: ledgerFile === undefined ? defaultLedgerFile(profiles) : ledgerFile });
    this._clearing = new Set();
    model.attachTopicSource(profiles, (brokerId, filter, limit) => mqttRuntime.observed(this.manager, brokerId, filter, limit));
    // OPC UA server metadata (unit, range, description, data type), read once per (re)connect.
    this.serverMeta = new Map(); // `${connectionId}\0${nodeId}` -> { type?, unit?, range?, description? }
    this._described = new Set(); // keys described on the current session of their connection
    this._describing = new Map(); // connectionId -> running describe pass
    this._describeAgain = new Set();
    this._metaVer = 0; // bumped when server metadata changed: the compiled index is rebuilt
    model.attachServerMeta(profiles, (connectionId, nodeId) => this.serverMeta.get(`${connectionId}\0${nodeId}`) || null);
    const self = this;
    const indexRev = {
      get rev() {
        return profiles.rev === undefined ? undefined : `${profiles.rev}:${self._metaVer}`;
      }
    };

    // Compiled index, rebuilt on profile-store revision change (and on new OPC UA server metadata).
    this.index = compiledView(indexRev, () => {
      const byKey = new Map(); // `${type} ${id} ${address}` -> [{ unit, tag }]
      const bySource = new Map(); // `${type} ${id}` -> [unit]
      const heartbeat = [];
      const units = new Map(); // unitId -> unit
      const mqttFilters = new Map(); // brokerId -> [{ unit, parts }] (filter-mode MQTT units)
      const mqttBrokers = new Set(); // brokers some MQTT-source unit reads
      const stale = []; // MQTT units with a staleness limit on some tag
      for (const b of this.profiles.listIn('bindings')) {
        const type = b.source?.type;
        if (b.enabled === false || !type || type === 'sparkplug') continue;
        for (const unit of model.expandUnits(b, this.profiles)) {
          if (unit.error) continue;
          unit.layout = model.layoutOf(b);
          unit.deadband = model.deadbandOf(b);
          // Publish plan, compiled once per profile-store revision: field lists,
          // per-tag transforms/labels/context (frozen) and Sparkplug BIRTH properties.
          const fp = model.fieldPlan(b);
          unit.envFields = fp.env;
          unit.memberFields = fp.member;
          unit.tagByName = new Map(unit.tags.map((t) => [t.name, t]));
          if (b.target?.mode === 'sparkplug') for (const t of unit.tags) t.spProps = model.sparkplugProps(t.meta, t);
          units.set(unit.id, unit);
          const sk = `${unit.sourceType} ${unit.sourceId}`;
          if (!bySource.has(sk)) bySource.set(sk, []);
          bySource.get(sk).push(unit);
          if (Number(b.rbe?.heartbeatMs) > 0) heartbeat.push(unit);
          if (unit.sourceType === 'mqtt') mqttRuntime.indexUnit(unit, { mqttFilters, mqttBrokers, stale });
          for (const tag of unit.tags) {
            const key = `${sk} ${tag.address}`;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push({ unit, tag });
          }
        }
      }
      return { byKey, bySource, heartbeat, units, mqttFilters, mqttBrokers, stale, mqttMiss: new Set() };
    });
    this.spIndex = compiledView(profiles, () =>
      this.profiles
        .listIn('bindings')
        .filter((b) => b.enabled !== false && b.source?.type === 'sparkplug')
        .map((b) => {
          const [unit] = model.expandUnits(b, this.profiles);
          unit.layout = 'topic-per-tag';
          unit.deadband = model.deadbandOf(b);
          unit.envFields = model.fieldPlan(b).env;
          unit.memberFields = null;
          unit.tagByName = new Map();
          unit.dynamicRetain = true; // metric names are only known at run time: retained topics go to the ledger
          return unit;
        })
    );

    if (opcuaManager) this.registerSource('opcua', new OpcuaSource(opcuaManager));
    this.mqttSource = new MqttSource(mqttManager, { pollMs: brokerPollMs });
    this.registerSource('mqtt', this.mqttSource);
  }

  /** Late wiring of the pipeline engine, whose hop registry the loop guard shares. */
  setPipelines(pipelines) {
    this.pipelines = pipelines || null;
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
    this.mqttSource?.close();
    this.ledger.save();
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.objectTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.objectTimer = null;
    this._dirtyObjects.clear();
    this.started = false;
    if (this.retainedRetryTimer) clearTimeout(this.retainedRetryTimer);
    this.retainedRetryTimer = null;
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
    for (const map of [this.last, this.objects, this.metaSent, this._dirtyObjects, this.spMetaSent]) {
      for (const unitId of [...map.keys()]) {
        if (!units.has(unitId) || changed.has(bindingIdOf(unitId))) {
          if ((map === this.metaSent || map === this.spMetaSent) && units.has(unitId)) continue; // meta compares content itself
          map.delete(unitId);
        }
      }
    }
    // Forget monitor requests no enabled binding wants any more (bounded set).
    const wanted = new Set();
    for (const unit of units.values()) for (const a of mqttRuntime.monitorAddresses(unit)) wanted.add(`${unit.sourceType} ${unit.sourceId} ${a}`);
    for (const k of this.monitored) if (!wanted.has(k)) this.monitored.delete(k);
    this.mqttSource?.retain(this.index().mqttBrokers);
    for (const id of [...this.rx.keys()]) if (!units.has(id)) this.rx.delete(id);

    this._syncRetained();
    this._publishMetaAll();
    this._refreshSparkplugMeta();
    this._publishStatusForNewUnits(changed);
    // New OPC UA tags on a connection that is already online get the server's metadata now.
    for (const [sk, st] of this.sourceState) if (st.state === 'online' && sk.startsWith('opcua ')) this._describeOpcua(sk.slice(6));
  }

  /**
   * Read what the OPC UA server says about every node an enabled mapping uses on this connection
   * (EngineeringUnits, EURange, Description, DataType) and merge it below the mapping's own settings.
   * Off the hot path: started on 'online' and after config changes, at most DESCRIBE_BATCH nodes in
   * flight, at most DESCRIBE_MAX nodes and DESCRIBE_BUDGET_MS per pass, each node once per session.
   * When anything changed, _meta documents and Sparkplug BIRTH properties are republished.
   */
  _describeOpcua(connectionId) {
    const adapter = this.sources.get('opcua')?.adapter;
    if (!adapter?.describe || !this.started) return null;
    if (this._describing.has(connectionId)) {
      this._describeAgain.add(connectionId);
      return this._describing.get(connectionId);
    }
    const sk = `opcua ${connectionId}`;
    const run = (async () => {
      const want = new Set();
      for (const unit of this.index().bySource.get(sk) || []) for (const t of unit.tags) want.add(t.address);
      const todo = [...want].filter((a) => !this._described.has(`${connectionId}\0${a}`)).slice(0, DESCRIBE_MAX);
      const deadline = Date.now() + DESCRIBE_BUDGET_MS;
      let changed = false;
      for (let i = 0; i < todo.length && Date.now() < deadline; i += DESCRIBE_BATCH) {
        if (!this.started || this.sourceState.get(sk)?.state !== 'online') break;
        const batch = todo.slice(i, i + DESCRIBE_BATCH);
        const answers = await Promise.all(batch.map((a) => Promise.resolve(adapter.describe(connectionId, a)).catch(() => undefined)));
        batch.forEach((address, j) => {
          if (answers[j] === undefined) return; // failed: tried again on the next (re)connect
          const key = `${connectionId}\0${address}`;
          this._described.add(key);
          const meta = serverMetaFrom(answers[j]);
          if (JSON.stringify(this.serverMeta.get(key) || null) === JSON.stringify(meta)) return;
          if (meta) this.serverMeta.set(key, meta);
          else this.serverMeta.delete(key);
          changed = true;
        });
      }
      if (changed && this.started) {
        this._metaVer++;
        this._publishMetaAll();
        this._refreshSparkplugMeta();
      }
    })()
      .catch(() => {})
      .finally(() => {
        this._describing.delete(connectionId);
        if (this._describeAgain.delete(connectionId)) this._describeOpcua(connectionId);
      });
    this._describing.set(connectionId, run);
    return run;
  }

  /**
   * Sparkplug targets carry metadata in BIRTH only: when a unit's metric
   * properties change (binding or device tag edit), ask the publisher for a
   * DBIRTH with the new properties. The publisher decides whether one can go
   * out now (session online, device birthed) and keeps its seq rules.
   */
  _refreshSparkplugMeta() {
    if (!this.spb?.refreshMetadata) return;
    for (const unit of this.index().units.values()) {
      const target = unit.binding.target || {};
      if (target.mode !== 'sparkplug') continue;
      const props = {};
      for (const t of unit.tags) props[t.name] = t.spProps;
      const sig = JSON.stringify([target.brokerId, target.group, target.edge, unit.spDevice, props]);
      const prev = this.spMetaSent.get(unit.id);
      this.spMetaSent.set(unit.id, sig);
      if (prev === undefined || prev === sig) continue; // first sight: properties travel with the first BIRTH
      try {
        this.spb.refreshMetadata({ brokerId: target.brokerId, group: target.group, edge: target.edge, device: unit.spDevice, properties: props });
      } catch (error) {
        const s = this._status(unit.binding.id);
        s.errors++;
        s.lastError = error.message;
      }
    }
  }

  /**
   * A binding created or edited while its source is already online gets its
   * status now; otherwise `_status` would not exist until the next transition.
   */
  _publishStatusForNewUnits(changed) {
    const units = this.index().units;
    if (!this._statusUnits) this._statusUnits = new Set();
    for (const id of [...this._statusUnits]) {
      if (!units.has(id) || changed.has(bindingIdOf(id))) this._statusUnits.delete(id);
    }
    for (const unit of units.values()) {
      if (this._statusUnits.has(unit.id)) continue;
      const st = this.sourceState.get(`${unit.sourceType} ${unit.sourceId}`);
      if (!st) continue; // source state unknown yet: the first transition publishes it
      this._statusUnits.add(unit.id);
      this._status(unit.binding.id).sourceState = { ...st };
      if ((unit.binding.target || {}).mode === 'mqtt') this._publishDeviceStatus(unit, st);
    }
  }

  /** Clear (empty retained publish) every retained topic the config no longer owns (see ./bindingRetainedOps.js). */
  _syncRetained() {
    retainedOps.syncRetained(this);
  }

  /** Retained topics recorded as ours that nothing owns any more: [{ brokerId, topic, bindingId, ... }]. */
  orphanedRetained() {
    return retainedOps.orphans(this);
  }

  /** Clear what orphanedRetained() lists (dryRun: only report). */
  cleanupRetained(opts) {
    return retainedOps.cleanup(this, opts);
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
          this.metaSent.delete(unit.id);
          this._scheduleRetainedRetry(); // e.g. broker not connected yet at startup
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
          for (const address of mqttRuntime.monitorAddresses(unit)) {
            const key = `${unit.sourceType} ${unit.sourceId} ${address}`;
            if (this.monitored.has(key)) continue;
            this.monitored.add(key);
            try {
              await src.adapter.ensureMonitored(unit.sourceId, address, interval);
            } catch (error) {
              this.monitored.delete(key); // retried on the slow timer
              failed = true;
              this._status(b.id).lastError = `monitor ${address}: ${error.message}`;
            }
          }
          // An MQTT-topic unit publishes what its topics already hold (retained, slow topics).
          if (unit.sourceType === 'mqtt' && mqttRuntime.monitorAddresses(unit).every((x) => this.monitored.has(`mqtt ${unit.sourceId} ${x}`))) mqttRuntime.seedUnit(this, unit);
        }
      } while (this._syncAgain);
      if (failed) this._scheduleRetry();
    })().finally(() => {
      this._syncing = null;
      // A request that arrived after the loop's last check (but before this ran) is not lost.
      if (this._syncAgain && this.started) this.syncMonitors();
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
      if (tag.plan) {
        // read -> device decode -> scale/offset -> cast; failure = Bad + reason, never a wrong value
        const r = model.applyTransform(tag.plan, smp.v, smp.q, this._tx);
        this._publishTag(unit, tag.name, r.v, r.q, ts, tag.outType, r.r, smp.v);
      } else {
        this._publishTag(unit, tag.name, smp.v, smp.q, ts, tag.outType || smp.type);
      }
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
      if (evt.sourceType === 'opcua') {
        // A new session may be a changed server: describe its nodes again (once per connect).
        for (const k of [...this._described]) if (k.startsWith(`${evt.sourceId}\0`)) this._described.delete(k);
        this._describeOpcua(evt.sourceId);
      }
    }
    for (const unit of this.index().bySource.get(sk) || []) {
      this._status(unit.binding.id).sourceState = { ...st };
      if (evt.state === 'offline') this._publishBad(unit, now);
      (this._statusUnits ||= new Set()).add(unit.id);
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
        e.r = undefined;
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
    if (target.format !== 'envelope') {
      // Plain payloads cannot carry quality, but history can: the direct
      // historian target still records the loss.
      if (target.historian?.historianId) {
        for (const [name, e] of m) {
          if (e.q === 0) continue;
          e.q = 0;
          this._toHistorian(unit, model.valueTopicOf(unit, name), e.v, 0, now);
        }
      }
      return;
    }
    for (const [name, e] of m) {
      if (e.q === 0) continue;
      e.q = 0;
      e.r = undefined;
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
        this._statusUnits?.delete(unit.id);
        this._scheduleRetainedRetry();
      });
  }

  /** Retained documents that could not be published are retried, not forgotten. */
  _scheduleRetainedRetry() {
    if (!this.started || this.retainedRetryTimer) return;
    this.retainedRetryTimer = setTimeout(() => {
      this.retainedRetryTimer = null;
      if (!this.started) return;
      this._publishMetaAll();
      this._publishStatusForNewUnits(new Set());
      retainedOps.clearOrphans(this);
    }, this.retryMs);
    this.retainedRetryTimer.unref?.();
  }

  _heartbeatSweep() {
    const now = Date.now();
    mqttRuntime.staleSweep(this, now);
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
        this._emit(unit, name, e.v, e.q, e.ts, e.type, { heartbeat: true, reason: e.r });
      }
    }
  }

  onMessage(msg) {
    const idx = this.index();
    if (idx.mqttBrokers.has(msg.brokerId) && !msg.sparkplug) mqttRuntime.onMqttMessage(this, msg, idx);
    const units = this.spIndex();
    if (!units.length || msg.topic.charCodeAt(0) !== 115 /* s */) return;
    // Topic: spBv1.0/{group}/{type}/{edge}[/{device}]
    const parts = msg.topicParts || msg.topic.split('/');
    if (parts[0] !== 'spBv1.0' || !/^(N|D)(DATA|BIRTH|DEATH)$/.test(parts[2] || '')) return;
    const [, group, kind, edge, device = null] = parts;

    for (const unit of units) {
      const src = unit.binding.source;
      if (src.brokerId !== msg.brokerId || src.group !== group || src.edge !== edge) continue;
      // Lifecycle -> source state: NDEATH takes the whole edge node down, DDEATH one device;
      // the endpoint's own BIRTH (DBIRTH for a device, NBIRTH for edge-node metrics) brings it back.
      if (kind === 'NDEATH' || (kind === 'DDEATH' && src.device && src.device === device)) {
        this._sparkplugState(unit, 'offline', `${kind} from ${edge}${device ? `/${device}` : ''}`);
        continue;
      }
      if (src.device && src.device !== device) continue;
      if (kind === 'DDEATH') continue; // another device of the edge node
      if (kind === (src.device ? 'DBIRTH' : 'NBIRTH') || this.sourceState.get((unit.spStateKey ||= `sparkplug ${unit.id}`))?.state !== 'online') {
        this._sparkplugState(unit, 'online', kind.endsWith('BIRTH') ? 'birth' : 'data');
      }
      if (!Array.isArray(msg.sparkplug?.metrics)) continue;
      const wanted = Array.isArray(src.metrics) && src.metrics.length ? new Set(src.metrics) : null;
      for (const m of msg.sparkplug.metrics) {
        if (!m || m.name === undefined || m.name === null) continue;
        if (wanted && !wanted.has(m.name)) continue;
        this._publishTag(
          unit,
          m.name,
          m.value,
          // per-metric quality/timestamp when the publisher supplied them (OPC 0-255 codes)
          Number.isFinite(m.quality) && m.quality >= 0 && m.quality <= 255 ? normQuality(m.quality) : 192,
          messageTime({ sourceTimestamp: m.sourceTimestamp ?? msg.sourceTimestamp, timestamp: msg.timestamp }),
          SPB_TYPES[m.datatypeName]
        );
      }
    }
  }

  /** Source state of a Sparkplug-source unit from BIRTH / DEATH (once per change). */
  _sparkplugState(unit, state, reason) {
    const key = `sparkplug ${unit.id}`;
    const prev = this.sourceState.get(key);
    if (prev?.state === state) return;
    const now = Date.now();
    const st = { state, since: now, reason };
    this.sourceState.set(key, st);
    this._status(unit.binding.id).sourceState = { ...st };
    if (state === 'offline') this._publishBad(unit, now);
    this._publishDeviceStatus(unit, st);
  }

  _objectState(unitId) {
    let o = this.objects.get(unitId);
    if (!o) {
      o = { dirty: false, pubAt: 0, t: 0, changed: new Set() };
      this.objects.set(unitId, o);
    }
    return o;
  }

  _publishTag(unit, tagName, value, quality, ts, type, reason, raw) {
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
    const tag = unit.tagByName.get(tagName);
    if (prev) {
      const db = tag && tag.deadband !== undefined ? tag.deadband : unit.deadband; // per-tag override
      const same = sameValue(value, prev.v) || model.withinDeadband(db, value, prev.v, tag?.meta.range);
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
      if (tag?.plan) {
        prev.r = reason;
        prev.raw = raw;
      }
    } else if (tag?.plan) {
      m.set(tagName, { v: value, q: quality, type, ts, pubAt: now, r: reason, raw });
    } else {
      m.set(tagName, { v: value, q: quality, type, ts, pubAt: now });
    }
    if (isObject) {
      const o = this._objectState(unit.id);
      if (this._hopOut > (o.hop || 0)) {
        o.hop = this._hopOut;
        o.hopBy = this._hopBy;
      }
      o.changed.add(tagName);
      if (ts > o.t) o.t = ts;
      o.dirty = true;
      this._dirtyObjects.set(unit.id, unit);
      this._scheduleObjectFlush();
      return;
    }
    this._emit(unit, tagName, value, quality, ts, type, { reason });
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
    for (const [name, e] of m) values[model.nameKey(unit, name)] = model.memberPayload(unit.memberFields, unit.tagByName.get(name), e);
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
    if (o.hop) {
      mqttRuntime.recordHop(this, target.brokerId, topic, o.hop, o.hopBy);
      o.hop = 0;
    }
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
        if (e) this._toHistorian(unit, model.valueTopicOf(unit, name), model.formatValue(unit.tagByName.get(name), e.v), e.q, e.ts);
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

  _emit(unit, tagName, value, quality, ts, type, { heartbeat = false, reason } = {}) {
    const binding = unit.binding;
    const s = this._status(binding.id);
    const target = binding.target || {};
    const tag = unit.tagByName.get(tagName);
    const out = tag ? model.formatValue(tag, value) : value; // precision + states 'replace'
    s.lastTs = Date.now();

    if (target.mode === 'sparkplug') {
      if (this._hopOut) mqttRuntime.recordHop(this, target.brokerId, `spBv1.0/${target.group}/DDATA/${target.edge}/${unit.spDevice}`, this._hopOut, this._hopBy);
      try {
        this.spb.updateDevice({
          brokerId: target.brokerId,
          group: target.group,
          edge: target.edge,
          device: unit.spDevice,
          metrics: [{ name: tagName, value: out, ts, type: type && type !== 'unknown' ? type : undefined, properties: tag ? tag.spProps : undefined }]
        });
        s.published++;
      } catch (error) {
        s.errors++;
        s.lastError = error.message;
      }
      if (!heartbeat) this._toHistorian(unit, `${target.group}/${target.edge}/${unit.spDevice}/${tagName}`, out, quality, ts);
      return;
    }

    // mqtt target
    const topic = model.valueTopicOf(unit, tagName);
    if (reason !== undefined && target.format !== 'envelope') {
      // A plain payload cannot carry quality: a failed cast is not published
      // (a wrong value never is); history still records the Bad sample.
      s.errors++;
      s.lastError = `${tagName}: ${reason}`;
      if (!heartbeat) this._toHistorian(unit, topic, null, quality, ts);
      return;
    }
    const payload = model.tagPayload(target.format, unit.envFields, tag, value, ts, quality, reason);
    if (this._hopOut) mqttRuntime.recordHop(this, target.brokerId, topic, this._hopOut, this._hopBy);
    if (target.retain && unit.dynamicRetain) retainedOps.recordDynamic(this, target.brokerId, topic, binding.id);
    this.manager
      .publish(target.brokerId, topic, payload, { qos: target.qos || 0, retain: Boolean(target.retain) })
      .then(() => {
        s.published++;
      })
      .catch((error) => {
        s.errors++;
        s.lastError = error.message;
      });
    if (!heartbeat) this._toHistorian(unit, topic, out, quality, ts);
  }

  /** Newest known sample for a unit's tag (preview): { v, q, t, type } or null. */
  latest(unitId, tagName) {
    const e = this.last.get(unitId)?.get(tagName);
    if (!e) return null;
    // Transformed tags remember the raw value so a preview can re-apply a (changed) transform.
    if (Object.hasOwn(e, 'raw')) return { v: e.raw, q: e.r !== undefined ? 192 : e.q, t: e.ts, type: e.type };
    return { v: e.v, q: e.q, t: e.ts, type: e.type };
  }

  getStatus() {
    return Object.fromEntries(this.status);
  }

  /** Newest message of an MQTT-source tag (preview): { v, q, t, type, u } or null. */
  latestMqtt(unit, tag) {
    return mqttRuntime.latestOf(this, unit, tag);
  }
}

module.exports = { TagBindings, opcQuality, targetTopic, statusTopic, slug };
