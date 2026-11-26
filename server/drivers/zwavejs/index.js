'use strict';

/**
 * Z-Wave through Z-Wave JS Server (@zwave-js/server, the server behind Home Assistant's Z-Wave
 * integration and Z-Wave JS UI) — READ-ONLY subscription driver. One Manifold device = one server.
 *
 * `start_listening` returns the controller and every node with its values and metadata, then
 * the server streams value / metadata / node-status events. The driver keeps that state and
 * pushes changes as they arrive (subscribe), the poll groups re-read the local copy, and when
 * the schema has node.get_value the tagged values are re-read from the SERVER'S cache
 * periodically. Nothing Manifold sends reaches the Z-Wave radio: battery devices are never
 * woken, and values of a sleeping node keep their last value (Good, noted "sleeping").
 * See ./client.js READ_COMMANDS for the complete list of commands it can send.
 */

const { ZwaveJsConnection, SCHEMA_MAX } = require('./client');
const { ccName, hex2, parseValueId, formatValueId, valueKey, convertValue, tagTypeOf, ADDRESS_HELP } = require('./values');
const { wsDeviceFields, wsTarget, activeSecretFields } = require('../common/wsTarget');

const protocol = 'zwave-js';
const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/';
const TAG_TYPES = ['number', 'bool', 'string', 'json'];
const DEFAULT_RESYNC_S = 300;
const DEFAULT_MAX_MESSAGE_MB = 32;
const RESYNC_CONCURRENCY = 8;
const Q_GOOD = 192;
const Q_BAD = 0;
const STATUS = { 0: 'unknown', 1: 'asleep', 2: 'awake', 3: 'dead', 4: 'alive' };
const CAPS = { browse: true, subscribe: true, maxInFlight: 1 };

function describe() {
  return {
    protocol,
    label: 'Z-Wave (Z-Wave JS Server)',
    defaultPort: DEFAULT_PORT,
    readOnly: true,
    experimental: true,
    browseNoun: 'server',
    capabilities: { ...CAPS },
    secretFields: ['authToken'],
    deviceFields: wsDeviceFields({ defaultPath: DEFAULT_PATH }),
    optionFields: [
      { name: 'resyncIntervalS', label: 'Re-read values every (s)', type: 'integer', min: 0, max: 86400, default: DEFAULT_RESYNC_S, help: 'Re-reads the tagged values from the server\'s cache (node.get_value, schema 14+), never from the devices. 0 = never.' },
      { name: 'maxMessageMB', label: 'Max message size (MB)', type: 'integer', min: 1, max: 256, default: DEFAULT_MAX_MESSAGE_MB, help: 'The full network state is one message; a larger message closes the connection.' },
    ],
    tagTypes: TAG_TYPES,
    tagTypeOptional: true,
    addressHelp: ADDRESS_HELP + ' Leave the type empty to use the value\'s metadata.',
    prerequisites: [
      'Point Manifold at Z-Wave JS Server (default ws://<host>:3000). In Home Assistant the Z-Wave JS add-on runs it on port 3000; Z-Wave JS UI enables it under Settings > Home Assistant > WS Server.',
      'Manifold only reads the server\'s cached state: it never includes, excludes, heals, updates firmware, sets or polls values, so battery devices are never woken. Values of sleeping devices update when the device reports on its own.',
      'Z-Wave JS Server has no authentication of its own: anyone who can reach the port can control the network. Keep it on a trusted network or behind an authenticating reverse proxy (give Manifold its token).',
    ].join('\n'),
  };
}

function compileTag(tagDef) {
  if (!tagDef || typeof tagDef !== 'object') throw new Error('tag definition must be an object');
  if (typeof tagDef.key !== 'string' || !tagDef.key) throw new Error('tag needs a non-empty string key');
  const a = parseValueId(tagDef.address);
  const type = tagDef.type === undefined || tagDef.type === null || tagDef.type === '' ? '' : String(tagDef.type).toLowerCase();
  if (type && !TAG_TYPES.includes(type)) throw new Error(`unknown type "${tagDef.type}"; use ${TAG_TYPES.join(', ')} or leave it empty`);
  return { key: tagDef.key, ...a, type, ...(tagDef.pollGroup !== undefined ? { pollGroup: tagDef.pollGroup } : {}) };
}

function validateTag(tagDef) {
  try {
    const t = compileTag(tagDef);
    return {
      ok: true,
      normalized: {
        key: t.key,
        address: t.address,
        nodeId: t.nodeId,
        commandClass: t.commandClass,
        commandClassName: ccName(t.commandClass),
        endpoint: t.endpoint,
        property: t.property,
        ...(t.propertyKey !== undefined ? { propertyKey: t.propertyKey } : {}),
        ...(t.type ? { type: t.type } : {}),
        ...(t.pollGroup !== undefined ? { pollGroup: t.pollGroup } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function coerce(conv, type) {
  if (!type || !conv.ok) return conv;
  const v = conv.v;
  if (type === 'number') {
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? { ok: true, v: n, type: 'float64' } : { ok: false, reason: 'not a number' };
  }
  if (type === 'bool') {
    if (typeof v === 'boolean') return { ok: true, v, type: 'bool' };
    if (typeof v === 'number') return { ok: true, v: v !== 0, type: 'bool' };
    return { ok: false, reason: 'not a boolean' };
  }
  if (type === 'string') return { ok: true, v: typeof v === 'string' ? v : JSON.stringify(v), type: 'string' };
  return { ok: true, v: conv.type === 'json' ? v : JSON.stringify(v), type: 'json' };
}

const SAMPLE_TYPE = (t) => (t === 'json' ? 'string' : t);

/** Node state from the server -> our record: { nodeId, status, ready, info, values: Map(key -> {id, value, metadata}) } */
function toNode(n) {
  const values = new Map();
  for (const v of Array.isArray(n.values) ? n.values : []) {
    if (!v || v.commandClass === undefined || v.property === undefined) continue;
    values.set(valueKey(v), { id: { commandClass: v.commandClass, endpoint: v.endpoint || 0, property: v.property, propertyKey: v.propertyKey }, value: v.value, metadata: v.metadata || {}, names: { cc: v.commandClassName, property: v.propertyName, key: v.propertyKeyName } });
  }
  return {
    nodeId: n.nodeId,
    status: Number.isInteger(n.status) ? n.status : 0,
    ready: n.ready !== false,
    isController: Boolean(n.isControllerNode),
    label: [n.name, n.deviceConfig && n.deviceConfig.manufacturer, n.label || n.productLabel || (n.deviceConfig && n.deviceConfig.label)].filter((x) => typeof x === 'string' && x).join(' '),
    description: (n.deviceConfig && n.deviceConfig.description) || n.productDescription || '',
    location: n.location || '',
    isListening: n.isListening,
    values,
  };
}

function createDriver(device, deps = {}) {
  if (!device || typeof device !== 'object') throw new Error('device config required');
  const target = wsTarget(device, { defaultPort: DEFAULT_PORT, defaultPath: DEFAULT_PATH });
  const options = device.options || {};
  const limits = { requestDeadlineMs: 10000, connectTimeoutMs: 5000, ...(device.limits || {}) };
  const resyncS = options.resyncIntervalS === undefined || options.resyncIntervalS === '' ? DEFAULT_RESYNC_S : Number(options.resyncIntervalS);
  if (!Number.isInteger(resyncS) || resyncS < 0 || resyncS > 86400) throw new Error('resyncIntervalS must be 0-86400');
  const maxMb = options.maxMessageMB === undefined || options.maxMessageMB === '' ? DEFAULT_MAX_MESSAGE_MB : Number(options.maxMessageMB);
  if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 256) throw new Error('maxMessageMB must be 1-256');
  const timers = deps.timers || { setInterval, clearInterval };

  const tags = new Map();
  const byValue = new Map(); // "node/key" -> [tag]
  const byNode = new Map();
  const tagErrors = [];
  for (const t of device.tags || []) {
    try {
      const c = compileTag(t);
      if (tags.has(c.key)) throw new Error('duplicate key');
      tags.set(c.key, c);
      const vk = `${c.nodeId}/${valueKey(c.valueId)}`;
      if (!byValue.has(vk)) byValue.set(vk, []);
      byValue.get(vk).push(c);
      if (!byNode.has(c.nodeId)) byNode.set(c.nodeId, []);
      byNode.get(c.nodeId).push(c);
    } catch (e) {
      tagErrors.push({ key: t && t.key, error: e.message });
    }
  }

  let conn = null;
  let nodes = new Map();
  let controller = null;
  let driverState = null;
  let subscriber = null;
  let lostReason = null;
  let resyncTimer = null;
  let resyncing = false;
  const last = new Map();
  const stats = { events: 0, valueEvents: 0, resyncs: 0, resyncErrors: 0 };

  function sampleFor(tag) {
    const node = nodes.get(tag.nodeId);
    const rec = node && node.values.get(valueKey(tag.valueId));
    const autoType = tag.type || (rec ? tagTypeOf(rec.metadata) : 'json');
    const bad = (qReason) => ({ key: tag.key, v: null, type: SAMPLE_TYPE(autoType === 'number' ? 'float64' : autoType), q: Q_BAD, qReason });
    if (!node) return bad('node not found');
    if (node.status === 3) return bad('node dead');
    if (!rec) return bad('value not reported by the node');
    if (rec.metadata && rec.metadata.readable === false) return bad('value is write-only');
    const conv = coerce(convertValue(rec.metadata, rec.value), tag.type);
    if (!conv.ok) return bad(conv.reason);
    const s = { key: tag.key, v: conv.v, type: SAMPLE_TYPE(conv.type), q: Q_GOOD };
    if (node.status === 1) s.qReason = 'sleeping'; // last reported value, kept with normal quality
    return s;
  }

  function push(list, { onlyChanged = false } = {}) {
    if (!subscriber || !list || !list.length) return;
    const out = [];
    for (const tag of list) {
      const s = sampleFor(tag);
      const sig = `${JSON.stringify(s.v)}|${s.q}|${s.qReason || ''}`;
      if (onlyChanged && last.get(tag.key) === sig) continue;
      last.set(tag.key, sig);
      out.push(s);
    }
    if (out.length) subscriber.onSamples(out);
  }

  function setValue(nodeId, args, value, { remove = false, metadata } = {}) {
    const node = nodes.get(nodeId);
    if (!node || !args || args.commandClass === undefined || args.property === undefined) return;
    const id = { commandClass: args.commandClass, endpoint: args.endpoint || 0, property: args.property, propertyKey: args.propertyKey };
    const k = valueKey(id);
    if (remove) node.values.delete(k);
    else {
      const rec = node.values.get(k) || { id, value: undefined, metadata: {}, names: { cc: args.commandClassName, property: args.propertyName, key: args.propertyKeyName } };
      if (metadata) rec.metadata = metadata;
      else rec.value = value;
      node.values.set(k, rec);
    }
    stats.valueEvents++;
    push(byValue.get(`${nodeId}/${k}`));
  }

  function setStatus(nodeId, status) {
    const node = nodes.get(nodeId);
    if (!node) return;
    node.status = status;
    push(byNode.get(nodeId));
  }

  function onEvent(e) {
    stats.events++;
    const { source, event } = e;
    if (source === 'node') {
      const id = e.nodeId;
      const a = e.args || {};
      switch (event) {
        case 'value updated':
        case 'value added':
          return setValue(id, a, a.newValue);
        case 'value notification':
          return setValue(id, a, a.value);
        case 'value removed':
          return setValue(id, a, undefined, { remove: true });
        case 'metadata updated':
          return setValue(id, a, undefined, { metadata: a.metadata || {} });
        case 'sleep':
          return setStatus(id, 1);
        case 'wake up':
          return setStatus(id, 2);
        case 'dead':
          return setStatus(id, 3);
        case 'alive':
          return setStatus(id, 4);
        case 'ready':
          if (e.nodeState && e.nodeState.nodeId === id) {
            nodes.set(id, toNode(e.nodeState));
            push(byNode.get(id));
          }
          return;
        default:
          return; // statistics, interview progress, notifications without a value
      }
    }
    if (source === 'controller') {
      if (event === 'node added' && e.node && Number.isInteger(e.node.nodeId)) {
        nodes.set(e.node.nodeId, toNode(e.node));
        push(byNode.get(e.node.nodeId));
      } else if (event === 'node removed' && e.node && Number.isInteger(e.node.nodeId)) {
        nodes.delete(e.node.nodeId);
        push(byNode.get(e.node.nodeId));
      }
      return;
    }
    if (source === 'driver' && event === 'driver ready') {
      // The server restarted its Z-Wave driver: our state is stale, reload it.
      lose('the Z-Wave driver restarted');
      if (conn) conn.close().catch(() => {});
    }
  }

  function lose(reason) {
    if (lostReason) return;
    lostReason = reason;
    stopResync();
    if (subscriber) subscriber.onLost(reason);
  }

  function stopResync() {
    if (resyncTimer) timers.clearInterval(resyncTimer);
    resyncTimer = null;
  }

  /** Re-read every tagged value from the server's cache (node.get_value; no radio traffic). */
  async function resync() {
    if (resyncing || !conn || !conn.isOpen() || !conn.schema.canGetValue) return;
    resyncing = true;
    try {
      const work = [...byValue.values()].map((list) => list[0]).filter((t) => nodes.has(t.nodeId));
      let i = 0;
      const worker = async () => {
        while (i < work.length && conn && conn.isOpen()) {
          const t = work[i++];
          try {
            const value = await conn.getValue(t.nodeId, t.valueId);
            const node = nodes.get(t.nodeId);
            const rec = node && node.values.get(valueKey(t.valueId));
            if (rec) rec.value = value;
            else if (node && value !== undefined) node.values.set(valueKey(t.valueId), { id: t.valueId, value, metadata: {}, names: {} });
          } catch {
            stats.resyncErrors++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(RESYNC_CONCURRENCY, work.length) }, worker));
      stats.resyncs++;
      push([...tags.values()], { onlyChanged: true });
    } finally {
      resyncing = false;
    }
  }

  function info() {
    const v = (conn && conn.version) || {};
    const sch = (conn && conn.schema) || { notes: [] };
    const list = [...nodes.values()];
    const count = (st) => list.filter((n) => n.status === st).length;
    return {
      server: 'Z-Wave JS Server',
      url: target.url,
      serverVersion: v.serverVersion,
      driverVersion: v.driverVersion,
      homeId: v.homeId !== undefined ? `0x${Number(v.homeId).toString(16)}` : undefined,
      schemaVersion: sch.schema,
      serverSchemaRange: `${v.minSchemaVersion}-${v.maxSchemaVersion}`,
      nodeCount: list.length,
      nodesAsleep: count(1),
      nodesDead: count(3),
      ...(controller && controller.sdkVersion ? { controllerSdk: controller.sdkVersion } : {}),
      ...(sch.notes.length ? { schemaNotes: sch.notes.join('; ') } : {}),
    };
  }

  const driver = {
    protocol,
    capabilities: { ...CAPS },
    tagErrors,

    async connect() {
      if (conn) await conn.close().catch(() => {});
      lostReason = null;
      last.clear();
      nodes = new Map();
      const c = new ZwaveJsConnection({
        target,
        timeouts: { hello: limits.connectTimeoutMs, request: limits.requestDeadlineMs, listen: Math.max(30000, limits.requestDeadlineMs) },
        ws: { connectTimeoutMs: limits.connectTimeoutMs, maxMessageBytes: maxMb * 1024 * 1024, maxFrameBytes: maxMb * 1024 * 1024, ...(deps.ws || {}) },
        createWs: deps.createWs,
      });
      conn = c;
      c.on('lost', (r) => {
        if (conn === c) lose(r);
      });
      await c.open();
      c.on('event', onEvent);
      const state = await c.startListening();
      controller = state.controller || null;
      driverState = state.driver || null;
      for (const n of state.nodes) if (n && Number.isInteger(n.nodeId)) nodes.set(n.nodeId, toNode(n));
      if (resyncS > 0 && c.schema.canGetValue) {
        resyncTimer = timers.setInterval(() => resync().catch(() => {}), resyncS * 1000);
        if (resyncTimer && resyncTimer.unref) resyncTimer.unref();
      }
      return info();
    },

    isConnected() {
      return Boolean(conn && conn.isOpen() && !lostReason);
    },

    plan(tagKeys) {
      const keys = (Array.isArray(tagKeys) ? tagKeys : [...tags.keys()]).filter((k) => tags.has(k));
      return keys.length ? [{ id: 'cache', kind: 'cache', items: keys.map((key) => ({ key })) }] : [];
    },

    async execute(request) {
      if (!driver.isConnected()) return { ok: false, kind: 'transport', fatal: true, message: lostReason || 'not connected' };
      return { ok: true, results: request.items.map((it) => sampleFor(tags.get(it.key))) };
    },

    bisect() {
      return [];
    },

    subscribe(sub) {
      subscriber = sub;
      if (lostReason) {
        const r = lostReason;
        setImmediate(() => sub.onLost(r));
        return;
      }
      push([...tags.values()]);
    },

    async browse(node) {
      if (!driver.isConnected()) throw new Error('not connected');
      if (!node) {
        return [...nodes.values()]
          .sort((a, b) => a.nodeId - b.nodeId)
          .map((n) => ({
            id: `node:${n.nodeId}`,
            name: `Node ${n.nodeId}${n.label ? ` - ${n.label}` : ''}${n.isController ? ' (controller)' : ''} (${STATUS[n.status] || 'unknown'})`,
            kind: 'folder',
            address: '',
            meta: { nodeId: n.nodeId, status: STATUS[n.status] || 'unknown', ready: n.ready, location: n.location, description: n.description },
          }));
      }
      let m = /^node:(\d+)$/.exec(node);
      if (m) {
        const n = nodes.get(Number(m[1]));
        if (!n) throw new Error(`node ${m[1]} is not known to the server`);
        const ccs = new Map();
        for (const rec of n.values.values()) {
          if (rec.metadata && rec.metadata.readable === false) continue;
          if (!ccs.has(rec.id.commandClass)) ccs.set(rec.id.commandClass, rec.names.cc || ccName(rec.id.commandClass));
        }
        return [...ccs.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([cc, name]) => ({ id: `cc:${n.nodeId}/${cc}`, name: `${name} (${hex2(cc)})`, kind: 'folder', address: '', meta: { commandClass: cc } }));
      }
      m = /^cc:(\d+)\/(\d+)$/.exec(node);
      if (m) {
        const n = nodes.get(Number(m[1]));
        if (!n) throw new Error(`node ${m[1]} is not known to the server`);
        const cc = Number(m[2]);
        return [...n.values.values()]
          .filter((rec) => rec.id.commandClass === cc && !(rec.metadata && rec.metadata.readable === false))
          .sort((a, b) => a.id.endpoint - b.id.endpoint || String(a.id.property).localeCompare(String(b.id.property)) || String(a.id.propertyKey ?? '').localeCompare(String(b.id.propertyKey ?? '')))
          .map((rec) => {
            const md = rec.metadata || {};
            const address = formatValueId(n.nodeId, rec.id);
            const conv = convertValue(md, rec.value);
            const states = md.states && typeof md.states === 'object' ? Object.entries(md.states).map(([k, v]) => `${k}=${v}`).join(', ') : '';
            const range = [md.min !== undefined ? `min ${md.min}` : '', md.max !== undefined ? `max ${md.max}` : ''].filter(Boolean).join(', ');
            const label = md.label || rec.names.property || String(rec.id.property);
            const keyLabel = rec.id.propertyKey !== undefined ? ` [${rec.names.key || rec.id.propertyKey}]` : '';
            return {
              id: `v:${address}`,
              name: `${label}${keyLabel}${rec.id.endpoint ? ` (endpoint ${rec.id.endpoint})` : ''}`,
              kind: 'tag',
              address,
              meta: {
                dataType: tagTypeOf(md),
                valueType: md.type || 'any',
                ...(md.unit ? { unit: md.unit } : {}),
                description: [md.description, range, states, md.writeable ? 'writeable on the device (Manifold only reads)' : ''].filter(Boolean).join(' - ').slice(0, 500),
                ...(md.min !== undefined ? { min: md.min } : {}),
                ...(md.max !== undefined ? { max: md.max } : {}),
                ...(md.states ? { states: md.states } : {}),
                value: conv.ok ? conv.v : null,
                ...(n.status === 1 ? { note: 'node is asleep: last reported value' } : {}),
              },
            };
          });
      }
      throw new Error(`unknown browse node "${node}"`);
    },

    /** The server's cached value and metadata of one value id (no radio traffic). */
    async probe({ address } = {}) {
      if (!driver.isConnected()) throw new Error('not connected');
      const a = parseValueId(address);
      const node = nodes.get(a.nodeId);
      if (!node) throw new Error(`node ${a.nodeId} is not known to the server`);
      const metadata = await conn.getValueMetadata(a.nodeId, a.valueId);
      let value;
      let source = 'driver copy of the event stream';
      if (conn.schema.canGetValue) {
        value = await conn.getValue(a.nodeId, a.valueId);
        source = 'server cache (node.get_value)';
      } else {
        const rec = node.values.get(valueKey(a.valueId));
        value = rec ? rec.value : undefined;
      }
      const conv = convertValue(metadata, value);
      return {
        address: a.address,
        source,
        type: `${(metadata && metadata.type) || 'unknown'} (${source})`,
        rawHex: value === undefined ? 'not reported' : JSON.stringify(value),
        nodeStatus: STATUS[node.status] || 'unknown',
        decodings: {
          value: conv.ok ? conv.v : null,
          ...(conv.ok ? {} : { note: conv.reason }),
          ...(metadata && metadata.label ? { label: metadata.label } : {}),
          ...(metadata && metadata.unit ? { unit: metadata.unit } : {}),
          readable: !(metadata && metadata.readable === false),
          nodeStatus: STATUS[node.status] || 'unknown',
        },
      };
    },

    async close() {
      stopResync();
      subscriber = null;
      const c = conn;
      conn = null;
      if (c) await c.close();
    },

    debugState() {
      return { nodes: nodes.size, stats: { ...stats }, schemaMax: SCHEMA_MAX, lostReason, driverState };
    },

    resyncNow: () => resync(),
  };
  return driver;
}

module.exports = { protocol, describe, validateTag, createDriver, activeSecretFields };
