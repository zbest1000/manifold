'use strict';

const model = require('./bindingModel');
const mq = require('./bindingMqtt');

/**
 * Run-time half of MQTT-topic sources (the pure half is ./bindingMqtt.js). Functions take the
 * TagBindings engine as their first argument.
 *
 * Hot path: one Map lookup per tapped message on a broker some MQTT-source mapping reads
 * (`byKey`, compiled per profile-store revision); a topic not yet known is tested once against the
 * filter-mode units of its broker and then either added to the index or remembered as a miss
 * (bounded). Reading a value reuses one scratch object.
 *
 * Loop safety at run time:
 *   - every publish made while handling an MQTT-sourced message is recorded with its hop depth and
 *     the binding that made it (short TTL, bounded), in this engine AND in the pipeline engine's
 *     hop registry when one is wired, so mapping -> pipeline -> mapping cycles count hops too;
 *   - a message on a topic this binding published itself is ignored;
 *   - a message whose hop depth reached MAX_HOPS is not consumed (counted as loopBlocked).
 */

const MAX_HOPS = 4;
const HOP_TTL_MS = 10_000;
const HOP_SWEEP_AT = 10_000;
const MAX_MISSES = 50_000;
const META_DEBOUNCE_MS = 250;

/** Observed topics under a filter (sorted, bounded), from the manager's topic trie. */
function observed(manager, brokerId, filter, limit) {
  const r = manager?.resolveSubscriptions?.(brokerId, [filter], { sampleLimit: limit });
  const sample = r?.results?.[0]?.sample || [];
  return sample.map((s) => s.topic).filter((t) => !t.startsWith('spBv1.0/')).sort();
}

/** Index one compiled MQTT unit (called while the engine compiles its view). */
function indexUnit(unit, { mqttFilters, mqttBrokers, stale }) {
  mqttBrokers.add(unit.sourceId);
  if (unit.mqtt.filter) {
    unit.dynamicRetain = true;
    if (!mqttFilters.has(unit.sourceId)) mqttFilters.set(unit.sourceId, []);
    mqttFilters.get(unit.sourceId).push({ unit, parts: unit.mqtt.filter.split('/') });
  }
  if (Number(unit.binding.source.staleAfterMs) > 0 || unit.tags.some((t) => t.staleAfterMs)) stale.push(unit);
}

/** What a unit asks its source to monitor: an MQTT filter once, else each tag address. */
function monitorAddresses(unit) {
  if (unit.sourceType === 'mqtt' && unit.mqtt?.filter) return [unit.mqtt.filter];
  return unit.tags.map((t) => t.address);
}

function recordHop(engine, brokerId, topic, depth, by) {
  const hops = engine.hops;
  if (hops.size > HOP_SWEEP_AT) {
    const cutoff = Date.now() - HOP_TTL_MS;
    for (const [k, v] of hops) if (v.ts < cutoff) hops.delete(k);
    if (hops.size > HOP_SWEEP_AT) hops.clear(); // still full of live entries: start over (bounded)
  }
  const key = `${brokerId}\u0000${topic}`;
  const prev = hops.get(key);
  if (prev) {
    prev.depth = depth;
    prev.ts = Date.now();
    prev.by = by;
  } else hops.set(key, { depth, ts: Date.now(), by });
  try {
    engine.pipelines?._recordHop?.(brokerId, topic, depth);
  } catch {
    /* the pipeline engine's registry is best effort */
  }
}

function newTopic(engine, msg, idx, key) {
  const filters = idx.mqttFilters.get(msg.brokerId);
  if (!filters || idx.mqttMiss.has(key)) return null;
  const parts = msg.topicParts || msg.topic.split('/');
  let hits = null;
  for (const { unit, parts: fp } of filters) {
    if (!mq.matchParts(fp, parts)) continue;
    const tag = model.addMqttTopic(unit, msg.topic);
    if (!tag) continue;
    unit.tagByName.set(tag.name, tag);
    (hits ||= []).push({ unit, tag });
    scheduleMeta(engine);
  }
  if (hits) idx.byKey.set(key, hits);
  else if (idx.mqttMiss.size < MAX_MISSES) idx.mqttMiss.add(key);
  return hits;
}

/** A unit's tag set or a learned unit changed: republish _meta soon (content-compared). */
function scheduleMeta(engine) {
  if (engine._metaTimer) return;
  engine._metaTimer = setTimeout(() => {
    engine._metaTimer = null;
    if (engine.started) {
      engine._publishMetaAll();
      engine._syncRetained();
    }
  }, META_DEBOUNCE_MS);
  engine._metaTimer.unref?.();
}

function rxMap(engine, unitId) {
  let m = engine.rx.get(unitId);
  if (!m) {
    m = new Map();
    engine.rx.set(unitId, m);
  }
  return m;
}

/** Live hop record of a (broker, topic) and the hop depth a message on it carries. */
function hopOf(engine, brokerId, topic) {
  const hop = engine.hops.get(`${brokerId}\u0000${topic}`);
  const live = hop && Date.now() - hop.ts < HOP_TTL_MS ? hop : null;
  let depth = live ? live.depth : 0;
  const pDepth = engine.pipelines?._hopDepth?.(brokerId, topic) || 0;
  if (pDepth > depth) depth = pDepth;
  return { live, depth };
}

/** One tapped message on a broker some MQTT-source mapping reads. */
function onMqttMessage(engine, msg, idx) {
  const key = `mqtt ${msg.brokerId} ${msg.topic}`;
  const hits = idx.byKey.get(key) || newTopic(engine, msg, idx, key);
  if (!hits) return;
  const { live, depth } = hopOf(engine, msg.brokerId, msg.topic);
  const now = Date.now();
  for (const { unit, tag } of hits) consume(engine, unit, tag, msg, live, depth, now);
}

/**
 * A mapping that starts (created, edited, server restart) publishes the newest message each of
 * its topics already has - a retained or slow topic would otherwise stay silent until it changes.
 * Once per tag while the unit lives (tags with a value already are skipped).
 */
function seedUnit(engine, unit) {
  const store = engine.manager.stores?.get(unit.sourceId);
  if (!store?.getLatest || !engine.manager.buildMessage) return;
  const now = Date.now();
  for (const tag of unit.tags) {
    if (engine.last.get(unit.id)?.has(tag.name)) continue;
    const row = store.getLatest(tag.address);
    if (!row) continue;
    const { live, depth } = hopOf(engine, unit.sourceId, tag.address);
    consume(engine, unit, tag, engine.manager.buildMessage(unit.sourceId, row), live, depth, now);
  }
}

/** Read one tag's value from a message and publish it (loop guards first). */
function consume(engine, unit, tag, msg, live, depth, now) {
  const rd = engine._rd;
  const b = unit.binding;
  if (live && live.by === b.id) return; // our own publication coming back
  if (depth >= MAX_HOPS) {
    const s = engine._status(b.id);
    s.loopBlocked = (s.loopBlocked || 0) + 1;
    s.lastError = `loop blocked: ${msg.topic} went through ${depth} mapping or pipeline hops`;
    return;
  }
  mq.readMessage(msg, tag.field, rd);
  if (rd.u && !tag.meta.unit) {
    tag.meta.unit = rd.u; // learned from the envelope; announced in _meta
    scheduleMeta(engine);
  }
  rxMap(engine, unit.id).set(tag.name, now);
  const prev = engine.last.get(unit.id)?.get(tag.name);
  if (prev?.stale) {
    prev.stale = false;
    prev.r = undefined;
    const s = engine._status(b.id);
    s.staleNow = Math.max(0, (s.staleNow || 0) - 1);
  }
  engine._hopOut = depth + 1;
  engine._hopBy = b.id;
  try {
    const type = tag.outType || mq.typeOfValue(rd.v);
    if (rd.r !== undefined) engine._publishTag(unit, tag.name, null, 0, rd.t, type, rd.r);
    else if (tag.plan) {
      const r = model.applyTransform(tag.plan, rd.v, rd.q, engine._tx);
      engine._publishTag(unit, tag.name, r.v, r.q, rd.t, type, r.r, rd.v);
    } else engine._publishTag(unit, tag.name, rd.v, rd.q, rd.t, type);
  } finally {
    engine._hopOut = 0;
    engine._hopBy = null;
  }
}

/** Tags of MQTT units that got no message for staleAfterMs: one Bad publish with reason 'stale'. */
function staleSweep(engine, now) {
  for (const unit of engine.index().stale) {
    const rx = engine.rx.get(unit.id);
    const m = engine.last.get(unit.id);
    if (!rx || !m) continue;
    const dflt = Number(unit.binding.source.staleAfterMs) || 0;
    for (const [name, at] of rx) {
      const limit = unit.tagByName.get(name)?.staleAfterMs || dflt;
      if (!limit || now - at < limit) continue;
      const e = m.get(name);
      if (!e || e.q === 0 || e.stale) continue;
      publishStale(engine, unit, name, e, now);
    }
  }
}

function publishStale(engine, unit, name, e, now) {
  const target = unit.binding.target || {};
  const s = engine._status(unit.binding.id);
  e.stale = true;
  s.staleNow = (s.staleNow || 0) + 1;
  s.staleEvents = (s.staleEvents || 0) + 1;
  e.q = 0;
  e.r = 'stale';
  if (target.mode !== 'mqtt') {
    s.suppressed++; // a Sparkplug metric carries no per-metric quality
    return;
  }
  if (unit.layout === 'object-per-asset') {
    const o = engine._objectState(unit.id);
    e.ts = now;
    o.changed.add(name);
    o.t = now;
    engine._flushObject(unit, { force: true });
    return;
  }
  if (target.format !== 'envelope') {
    engine._toHistorian(unit, model.valueTopicOf(unit, name), e.v, 0, now);
    return;
  }
  e.pubAt = now;
  engine._emit(unit, name, e.v, 0, now, e.type, { reason: 'stale' });
}

/** Newest message of an MQTT-source tag as a preview sample. */
function latestOf(engine, unit, tag) {
  const store = engine.manager.stores?.get(unit.sourceId);
  const row = store?.getLatest?.(tag.address);
  if (!row) return null;
  const msg = engine.manager.buildMessage(unit.sourceId, row);
  const rd = mq.readMessage(msg, tag.field, {});
  if (rd.u && !tag.meta.unit) tag.meta.unit = rd.u;
  if (rd.r !== undefined) return { v: null, q: 0, t: rd.t, type: 'unknown', r: rd.r };
  return { v: rd.v, q: rd.q, t: rd.t, type: mq.typeOfValue(rd.v) };
}

module.exports = { MAX_HOPS, observed, indexUnit, monitorAddresses, recordHop, onMqttMessage, seedUnit, staleSweep, latestOf };
