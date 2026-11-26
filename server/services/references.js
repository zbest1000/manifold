'use strict';

/**
 * Reference integrity between stored objects.
 *
 *   route (pipelines)  -> source broker, target broker | historian
 *   model              -> target broker, every attribute's source broker
 *   recording          -> broker, historian (historian target)
 *   contract           -> broker
 *   codec binding      -> broker (optional)
 *   alert rule         -> broker
 *   binding (mapping)  -> source / target broker, historian (read-only here)
 *
 * Three uses:
 *  - `missingRefs(kind, obj, ctx)`  validate on save (400 naming the missing thing),
 *  - `usersOfBroker(id, ctx)`       refuse deleting something still referenced (409),
 *  - `brokenRefs(kind, obj, ctx)`   status of a saved object whose reference is gone
 *                                   (API + UI row state, startup/import log).
 *
 * `ctx` = { profiles, mqttManager?, sparkplugPublisher? }. A broker exists when it
 * has a saved profile OR a live connection (Discovery and the socket can add
 * connections without a profile).
 */

const label = (o, fallback) => o?.name || fallback || o?.id;

function brokerExists(ctx, id) {
  if (!id) return false;
  if (ctx.profiles?.getBroker?.(id)) return true;
  if (ctx.profiles?.brokers?.().some((b) => b.config?.id === id)) return true;
  return Boolean(ctx.mqttManager?.getConnection?.(id));
}

function historianExists(ctx, id) {
  return Boolean(id && ctx.profiles?.getIn?.('historians', id));
}

/** Every reference an object carries: [{ kind: 'broker'|'historian', id, field }]. */
function refsOf(kind, obj) {
  const refs = [];
  const add = (k, id, field) => {
    if (id) refs.push({ kind: k, id, field });
  };
  switch (kind) {
    case 'pipelines':
      add('broker', obj.source?.brokerId, 'source.brokerId');
      if (obj.target?.type === 'mqtt') add('broker', obj.target.brokerId, 'target.brokerId');
      if (obj.target?.type === 'historian') add('historian', obj.target.historianId, 'target.historianId');
      break;
    case 'models':
      add('broker', obj.target?.brokerId, 'target.brokerId');
      (obj.attributes || []).forEach((a, i) => add('broker', a?.source?.brokerId, `attributes[${i}].source.brokerId`));
      break;
    case 'recordings':
      add('broker', obj.brokerId, 'brokerId');
      if (obj.target?.type === 'historian') add('historian', obj.target.historianId, 'target.historianId');
      break;
    case 'contracts':
    case 'alertRules':
    case 'codecs': // a codec binding's broker is optional (absent = every broker)
      add('broker', obj.brokerId, 'brokerId');
      break;
    case 'bindings':
      add('broker', obj.source?.brokerId, 'source.brokerId');
      add('broker', obj.target?.brokerId, 'target.brokerId');
      add('historian', obj.target?.historian?.historianId, 'target.historian.historianId');
      break;
    default:
      break;
  }
  // The same id twice (an attribute list sourcing one broker) is one missing thing.
  const seen = new Set();
  return refs.filter((r) => {
    const key = `${r.kind}\0${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Dangling references of a stored/unsaved object: [{ kind, id, field }]. */
function brokenRefs(kind, obj, ctx) {
  if (!obj) return [];
  return refsOf(kind, obj).filter((r) => (r.kind === 'broker' ? !brokerExists(ctx, r.id) : !historianExists(ctx, r.id)));
}

/** A sentence naming the first missing thing, or null. */
function missingRefsMessage(kind, obj, ctx) {
  const missing = brokenRefs(kind, obj, ctx);
  if (!missing.length) return null;
  const parts = missing.slice(0, 3).map((m) => `${m.kind} "${m.id}" (${m.field}) does not exist`);
  return `${parts.join('; ')}${missing.length > 3 ? `; and ${missing.length - 3} more` : ''}. Pick an existing ${missing[0].kind} or create it first.`;
}

/** Everything that still references broker `id`: [{ type, id, name }]. */
function usersOfBroker(id, ctx) {
  const out = [];
  const scan = (collection, type, listFn) => {
    for (const o of listFn()) {
      if (refsOf(collection, o).some((r) => r.kind === 'broker' && r.id === id)) out.push({ type, id: o.id, name: label(o, type) });
    }
  };
  const p = ctx.profiles;
  scan('pipelines', 'route', () => p.listIn('pipelines'));
  scan('bindings', 'mapping', () => p.listIn('bindings'));
  scan('recordings', 'recording', () => p.listIn('recordings'));
  scan('alertRules', 'alert rule', () => p.alertRules());
  scan('models', 'model', () => p.listIn('models'));
  scan('contracts', 'contract', () => p.listIn('contracts'));
  scan('codecs', 'codec binding', () => p.listIn('codecs'));
  const hosts = ctx.sparkplugPublisher?.hostSessions;
  if (hosts && typeof hosts.values === 'function') {
    for (const h of hosts.values()) {
      if (h.brokerId === id) out.push({ type: 'Sparkplug host session', id: h.key, name: `host "${h.hostId}"` });
    }
  }
  return out;
}

/** All broken objects across the collections: [{ type, id, name, missing }]. */
function scanBroken(ctx) {
  const out = [];
  const p = ctx.profiles;
  const add = (collection, type, list) => {
    for (const o of list) {
      const missing = brokenRefs(collection, o, ctx);
      if (missing.length) out.push({ type, id: o.id, name: label(o, type), missing });
    }
  };
  add('pipelines', 'route', p.listIn('pipelines'));
  add('bindings', 'mapping', p.listIn('bindings'));
  add('recordings', 'recording', p.listIn('recordings'));
  add('alertRules', 'alert rule', p.alertRules());
  add('models', 'model', p.listIn('models'));
  add('contracts', 'contract', p.listIn('contracts'));
  add('codecs', 'codec binding', p.listIn('codecs'));
  return out;
}

module.exports = { refsOf, brokenRefs, missingRefsMessage, usersOfBroker, scanBroken, brokerExists, historianExists };
