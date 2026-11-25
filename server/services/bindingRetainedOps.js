'use strict';

const model = require('./bindingModel');
const { matchFilter } = require('./mqttMatch');
const { publishFilters } = require('./bindingMqtt');

/**
 * Retained cleanup that survives restarts (the ledger is ./bindingRetained.js). Functions take the
 * TagBindings engine as their first argument.
 *
 * Owned = derived from the current configuration (`_status`, `_meta`, retained value / object
 * topics) or recorded at publish time by a binding whose names are only known at run time
 * (filter-mode MQTT source, Sparkplug source) and that still publishes there retained.
 * Orphan  = recorded in the ledger and not owned. Orphans are cleared (empty retained publish,
 * QoS 1) as soon as their broker is connected - at reconcile, on the retry timer, and so once at
 * startup - and dropped from the ledger only after the broker acknowledged the clear. Nothing that
 * is not in the ledger is ever cleared: the broker's contents are never guessed from.
 */

const keyOf = (brokerId, topic) => `${brokerId}\u0000${topic}`;

const connected = (engine, brokerId) => {
  const c = engine.manager.getConnection?.(brokerId);
  // Test doubles without connection state count as connected.
  return c ? c.status === 'connected' : !engine.manager.getConnection;
};

/** Recompute the config-derived owned set, record it in the ledger, clear orphans. */
function syncRetained(engine) {
  const next = new Map();
  for (const b of engine.profiles.listIn('bindings')) {
    for (const r of model.retainedTopics(b, engine.profiles)) {
      next.set(keyOf(r.brokerId, r.topic), r);
      engine.ledger.add(r.brokerId, r.topic, b.id, false, b.name);
    }
  }
  engine.retained = next;
  engine.ledger.save(); // config-derived entries hit the disk before anything is published
  // A unit whose meta topic was cleared must republish it if it comes back.
  for (const [unitId, sent] of engine.metaSent) {
    const [brokerId, topic] = sent.split(' ', 2);
    if (!next.has(keyOf(brokerId, topic))) engine.metaSent.delete(unitId);
  }
  clearOrphans(engine);
}

/** A run-time retained publish of a binding whose topics are not derivable from config. */
function recordDynamic(engine, brokerId, topic, bindingId) {
  const prev = engine.ledger.get(brokerId, topic);
  if (prev && prev.b === bindingId) return;
  if (engine.ledger.add(brokerId, topic, bindingId, true, engine.profiles.getIn('bindings', bindingId)?.name)) engine.ledger.saveSoon();
}

/** Why a ledger entry is no longer owned, or null while it is. */
function orphanReason(engine, brokerId, topic, e) {
  if (engine.retained.has(keyOf(brokerId, topic))) return null;
  const b = engine.profiles.getIn('bindings', e.b);
  if (!b) return 'mapping deleted';
  if (b.enabled === false) return 'mapping disabled';
  const t = b.target || {};
  if (t.brokerId !== brokerId) return 'mapping now publishes to another broker';
  if (!e.d) return 'no longer published by the mapping (renamed, retain or document switched off, tag removed)';
  if (!t.retain) return 'retain switched off';
  const units = [...engine.index().units.values()].filter((u) => u.binding.id === b.id);
  const covered = publishFilters(b, units).some((f) => matchFilter(f, topic));
  return covered ? null : 'outside the mapping’s current asset path';
}

/** [{ brokerId, topic, bindingId, bindingName, reason, connected }] (bounded by the ledger). */
function orphans(engine) {
  const out = [];
  for (const [brokerId, topic, e] of engine.ledger.entries()) {
    const reason = orphanReason(engine, brokerId, topic, e);
    if (!reason) continue;
    const b = engine.profiles.getIn('bindings', e.b);
    out.push({ brokerId, topic, bindingId: e.b, bindingName: b?.name || e.n || null, reason, connected: connected(engine, brokerId) });
  }
  return out.sort((a, c) => a.brokerId.localeCompare(c.brokerId) || a.topic.localeCompare(c.topic));
}

function clearOne(engine, o) {
  const k = keyOf(o.brokerId, o.topic);
  if (engine._clearing.has(k)) return Promise.resolve(false);
  engine._clearing.add(k);
  return Promise.resolve()
    .then(() => engine.manager.publish(o.brokerId, o.topic, '', { qos: 1, retain: true }))
    .then(() => {
      // Owned again meanwhile (re-created mapping)? Then it stays recorded.
      if (orphanReason(engine, o.brokerId, o.topic, engine.ledger.get(o.brokerId, o.topic) || { b: o.bindingId })) engine.ledger.delete(o.brokerId, o.topic);
      engine.ledger.saveSoon();
      return true;
    })
    .catch(() => false)
    .finally(() => engine._clearing.delete(k));
}

/** Clear every orphan on a connected broker; the rest wait for the retry timer. */
function clearOrphans(engine) {
  const list = orphans(engine);
  let waiting = false;
  for (const o of list) {
    if (!o.connected) {
      waiting = true;
      continue;
    }
    clearOne(engine, o).then((ok) => {
      if (!ok) engine._scheduleRetainedRetry();
    });
  }
  if (waiting) engine._scheduleRetainedRetry();
}

/** Explicit cleanup (POST /api/tags/bindings/cleanup-retained). */
async function cleanup(engine, { dryRun = true } = {}) {
  const list = orphans(engine);
  if (dryRun) return { dryRun: true, topics: list, cleared: 0, waiting: list.filter((o) => !o.connected).length, overflow: engine.ledger.overflow };
  const results = await Promise.all(list.map((o) => (o.connected ? clearOne(engine, o) : Promise.resolve(false))));
  engine.ledger.save();
  const topics = list.map((o, i) => ({ ...o, cleared: results[i] }));
  return { dryRun: false, topics, cleared: results.filter(Boolean).length, waiting: list.filter((o, i) => !results[i]).length, overflow: engine.ledger.overflow };
}

module.exports = { syncRetained, recordDynamic, orphans, clearOrphans, cleanup };
