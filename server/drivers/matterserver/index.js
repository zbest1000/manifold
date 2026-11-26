'use strict';

/**
 * Matter through the open-source Matter Server (python-matter-server / matter.js server) —
 * READ-ONLY subscription driver. One Manifold device = one Matter Server.
 *
 * Values arrive by subscription: `start_listening` returns every node with its attribute
 * cache and then streams attribute_updated / node_* events. The driver keeps that cache;
 * `subscribe()` pushes changes as they arrive, `plan`/`execute` re-read the cache on the poll
 * group interval (no network traffic: it confirms the values are current while the
 * subscription is alive) and `get_nodes` re-synchronises the cache periodically.
 * Manifold never commissions, controls, writes, removes or interviews anything: see
 * ./client.js READ_COMMANDS for the complete list of commands it can send.
 */

const { MatterServerConnection, SCHEMA_TESTED } = require('./client');
const { parseAddress, describePath, ADDRESS_HELP } = require('./address');
const { clusterById, attributeDef, sampleTypeOf, convert, CONC_UNITS, DEVICE_TYPES, hex } = require('./clusters');
const { wsDeviceFields, wsTarget, activeSecretFields } = require('../common/wsTarget');

const protocol = 'matter-server';
const DEFAULT_PORT = 5580;
const DEFAULT_PATH = '/ws';
const TAG_TYPES = ['number', 'bool', 'string', 'json'];
const DEFAULT_RESYNC_S = 300;
const DEFAULT_MAX_MESSAGE_MB = 32;
const Q_GOOD = 192;
const Q_BAD = 0;

const CAPS = { browse: true, subscribe: true, maxInFlight: 1 };

function describe() {
  return {
    protocol,
    label: 'Matter (Matter Server)',
    defaultPort: DEFAULT_PORT,
    readOnly: true,
    experimental: true, // verified against the in-process simulator only; see NOTES.md
    browseNoun: 'server',
    capabilities: { ...CAPS },
    secretFields: ['authToken'],
    deviceFields: wsDeviceFields({ defaultPath: DEFAULT_PATH }),
    optionFields: [
      { name: 'resyncIntervalS', label: 'Full resync every (s)', type: 'integer', min: 0, max: 86400, default: DEFAULT_RESYNC_S, help: 'Re-reads the server\'s node list (get_nodes) to repair anything the event stream missed. 0 = never.' },
      { name: 'maxMessageMB', label: 'Max message size (MB)', type: 'integer', min: 1, max: 256, default: DEFAULT_MAX_MESSAGE_MB, help: 'The node dump of a large installation is one message; a larger message closes the connection.' },
    ],
    tagTypes: TAG_TYPES,
    tagTypeOptional: true,
    addressHelp: ADDRESS_HELP + ' Leave the type empty to use the cluster table (scaled number, bool, text) or the raw value.',
    prerequisites: [
      'Point Manifold at the Matter Server\'s WebSocket API (default ws://<host>:5580/ws). In Home Assistant, the Matter Server add-on exposes port 5580 only after it is enabled in the add-on\'s Network settings.',
      'Manifold only reads: it never commissions, controls, writes, removes or re-interviews nodes. Commission devices with Home Assistant or the server\'s own dashboard.',
      'The Matter Server WebSocket API has no authentication of its own: anyone who can reach port 5580 can control every device. Keep the port on a trusted network, or put an authenticating reverse proxy in front and give Manifold its token.',
    ].join('\n'),
  };
}

function compileTag(tagDef) {
  if (!tagDef || typeof tagDef !== 'object') throw new Error('tag definition must be an object');
  if (typeof tagDef.key !== 'string' || !tagDef.key) throw new Error('tag needs a non-empty string key');
  const a = parseAddress(tagDef.address);
  const type = tagDef.type === undefined || tagDef.type === null || tagDef.type === '' ? '' : String(tagDef.type).toLowerCase();
  if (type && !TAG_TYPES.includes(type)) throw new Error(`unknown type "${tagDef.type}"; use ${TAG_TYPES.join(', ')} or leave it empty`);
  const def = attributeDef(a.cluster, a.attribute);
  return { key: tagDef.key, ...a, type, def, ...(tagDef.pollGroup !== undefined ? { pollGroup: tagDef.pollGroup } : {}) };
}

function validateTag(tagDef) {
  try {
    const t = compileTag(tagDef);
    const auto = sampleTypeOf(t.def);
    return {
      ok: true,
      normalized: {
        key: t.key,
        address: t.address,
        nodeId: t.nodeId,
        endpoint: t.endpoint,
        cluster: t.cluster,
        attribute: t.attribute,
        name: describePath(t.cluster, t.attribute),
        ...(t.type ? { type: t.type } : auto ? { resolvedType: auto } : {}),
        ...(t.def && t.def.unit ? { unit: t.def.unit } : {}),
        ...(t.pollGroup !== undefined ? { pollGroup: t.pollGroup } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Apply the user's type override to a converted value. */
function coerce(conv, type) {
  if (!type || !conv.ok) return conv;
  const v = conv.v;
  if (type === 'number') {
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? { ok: true, v: n, type: 'float64' } : { ok: false, reason: 'not a number' }; // one type for every sample
  }
  if (type === 'bool') {
    if (typeof v === 'boolean') return { ok: true, v, type: 'bool' };
    if (typeof v === 'number') return { ok: true, v: v !== 0, type: 'bool' };
    return { ok: false, reason: 'not a boolean' };
  }
  if (type === 'string') return { ok: true, v: typeof v === 'string' ? v : JSON.stringify(v), type: 'string' };
  return { ok: true, v: typeof v === 'string' && conv.type === 'json' ? v : JSON.stringify(v), type: 'json' };
}

const SAMPLE_TYPE = (t) => (t === 'json' ? 'string' : t);

function nodeLabel(node) {
  const a = (node && node.attributes) || {};
  const label = a['0/40/5'] || a['0/40/3'] || '';
  const vendor = a['0/40/1'] || '';
  return [vendor, label].filter((x) => typeof x === 'string' && x).join(' ');
}

function deviceTypesOf(node, ep) {
  const list = node.attributes ? node.attributes[`${ep}/29/0`] : null;
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => (d && typeof d === 'object' ? (d.deviceType ?? d['0']) : null))
    .filter((x) => Number.isInteger(x))
    .map((id) => DEVICE_TYPES[id] || `Device type ${hex(id)}`);
}

function splitPath(path) {
  const [ep, cl, at] = String(path).split('/').map(Number);
  return { ep, cl, at };
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
  const byPath = new Map(); // "node/ep/cl/attr" -> [tag]
  const byNode = new Map(); // nodeId -> [tag]
  const tagErrors = [];
  for (const t of device.tags || []) {
    try {
      const c = compileTag(t);
      if (tags.has(c.key)) throw new Error('duplicate key');
      tags.set(c.key, c);
      const k = `${c.nodeId}/${c.path}`;
      if (!byPath.has(k)) byPath.set(k, []);
      byPath.get(k).push(c);
      if (!byNode.has(c.nodeId)) byNode.set(c.nodeId, []);
      byNode.get(c.nodeId).push(c);
    } catch (e) {
      tagErrors.push({ key: t && t.key, error: e.message });
    }
  }

  let conn = null;
  let nodes = new Map(); // nodeId -> node data
  let subscriber = null;
  let lostReason = null;
  let resyncTimer = null;
  let resyncing = false;
  const last = new Map(); // key -> "v|q|reason" of the last pushed sample
  const stats = { events: 0, attributeUpdates: 0, resyncs: 0, resyncErrors: 0 };

  function sampleFor(tag) {
    const bad = (qReason) => ({ key: tag.key, v: null, type: SAMPLE_TYPE(tag.type || sampleTypeOf(tag.def) || 'json'), q: Q_BAD, qReason });
    const node = nodes.get(tag.nodeId);
    if (!node) return bad('node not found');
    if (node.available === false) return bad('node unavailable');
    const attrs = node.attributes || {};
    if (!Object.prototype.hasOwnProperty.call(attrs, tag.path)) return bad('attribute not reported by the node');
    const conv = coerce(convert(tag.def, attrs[tag.path]), tag.type);
    if (!conv.ok) return bad(conv.reason);
    return { key: tag.key, v: conv.v, type: SAMPLE_TYPE(conv.type), q: Q_GOOD };
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

  function setNodes(list) {
    const next = new Map();
    for (const n of list) if (n && Number.isSafeInteger(n.node_id)) next.set(n.node_id, { ...n, attributes: n.attributes && typeof n.attributes === 'object' ? { ...n.attributes } : {} });
    nodes = next;
  }

  function onEvent({ event, data }) {
    stats.events++;
    switch (event) {
      case 'attribute_updated': {
        if (!Array.isArray(data) || data.length < 3) return;
        const [nodeId, path, value] = data;
        const node = nodes.get(nodeId);
        if (!node || typeof path !== 'string') return;
        node.attributes[path] = value;
        stats.attributeUpdates++;
        push(byPath.get(`${nodeId}/${path}`));
        return;
      }
      case 'node_added':
      case 'node_updated': {
        if (!data || !Number.isSafeInteger(data.node_id)) return;
        nodes.set(data.node_id, { ...data, attributes: data.attributes && typeof data.attributes === 'object' ? { ...data.attributes } : {} });
        push(byNode.get(data.node_id));
        return;
      }
      case 'node_removed': {
        const id = typeof data === 'object' && data ? data.node_id : data;
        nodes.delete(id);
        push(byNode.get(id));
        return;
      }
      case 'endpoint_removed': {
        const node = data && nodes.get(data.node_id);
        if (!node) return;
        for (const k of Object.keys(node.attributes)) if (k.startsWith(`${data.endpoint_id}/`)) delete node.attributes[k];
        push(byNode.get(data.node_id));
        return;
      }
      case 'endpoint_added': {
        if (!data || !nodes.has(data.node_id) || !conn) return;
        conn
          .getNode(data.node_id)
          .then((n) => {
            if (n && n.node_id === data.node_id) onEvent({ event: 'node_updated', data: n });
          })
          .catch(() => {});
        return;
      }
      case 'server_info_updated':
        if (data && typeof data === 'object' && conn) conn.info = data;
        return;
      case 'server_shutdown':
        lose('the Matter Server is shutting down');
        if (conn) conn.close().catch(() => {});
        return;
      default:
        return; // node_event (button presses etc.) carries no attribute value
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

  async function resync() {
    if (resyncing || !conn || !conn.isOpen()) return;
    resyncing = true;
    try {
      setNodes(await conn.getNodes());
      stats.resyncs++;
      push([...tags.values()], { onlyChanged: true });
    } catch {
      stats.resyncErrors++; // a lost connection is reported through 'lost'
    } finally {
      resyncing = false;
    }
  }

  function info() {
    const i = (conn && conn.info) || {};
    const rep = (conn && conn.report) || { notes: [] };
    const list = [...nodes.values()];
    return {
      server: 'Matter Server',
      url: target.url,
      schemaVersion: i.schema_version,
      minSupportedSchemaVersion: i.min_supported_schema_version,
      sdkVersion: i.sdk_version,
      fabricId: i.fabric_id,
      compressedFabricId: i.compressed_fabric_id,
      nodeCount: list.length,
      nodesAvailable: list.filter((n) => n.available !== false).length,
      ...(rep.notes.length ? { schemaNotes: rep.notes.join('; ') } : {}),
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
      const c = new MatterServerConnection({
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
      setNodes(await c.startListening());
      if (resyncS > 0) {
        resyncTimer = timers.setInterval(() => resync(), resyncS * 1000);
        if (resyncTimer && resyncTimer.unref) resyncTimer.unref();
      }
      return info();
    },

    isConnected() {
      return Boolean(conn && conn.isOpen() && !lostReason);
    },

    /** One cache read for all keys: no network traffic. */
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

    /** Push path: changes as they arrive, plus the full current state right away. */
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
          .sort((a, b) => a.node_id - b.node_id)
          .map((n) => {
            const label = nodeLabel(n);
            return {
              id: `node:${n.node_id}`,
              name: `Node ${n.node_id}${label ? ` - ${label}` : ''}${n.available === false ? ' (unavailable)' : ''}`,
              kind: 'folder',
              address: '',
              meta: { nodeId: n.node_id, available: n.available !== false, isBridge: Boolean(n.is_bridge) },
            };
          });
      }
      let m = /^node:(\d+)$/.exec(node);
      if (m) {
        const n = nodes.get(Number(m[1]));
        if (!n) throw new Error(`node ${m[1]} is not known to the server`);
        const eps = [...new Set(Object.keys(n.attributes).map((k) => splitPath(k).ep))].filter(Number.isInteger).sort((a, b) => a - b);
        return eps.map((ep) => {
          const types = deviceTypesOf(n, ep);
          const bridged = n.attributes[`${ep}/57/5`] || n.attributes[`${ep}/57/3`];
          const label = [typeof bridged === 'string' ? bridged : '', types.join(', ')].filter(Boolean).join(' - ');
          return { id: `ep:${n.node_id}/${ep}`, name: `Endpoint ${ep}${label ? ` - ${label}` : ''}`, kind: 'folder', address: '', meta: { nodeId: n.node_id, endpoint: ep } };
        });
      }
      m = /^ep:(\d+)\/(\d+)$/.exec(node);
      if (m) {
        const n = nodes.get(Number(m[1]));
        if (!n) throw new Error(`node ${m[1]} is not known to the server`);
        const ep = Number(m[2]);
        const cls = [...new Set(Object.keys(n.attributes).map(splitPath).filter((p) => p.ep === ep).map((p) => p.cl))].sort((a, b) => a - b);
        return cls.map((cl) => {
          const c = clusterById(cl);
          return { id: `cl:${n.node_id}/${ep}/${cl}`, name: `${c ? c.name : 'Cluster'} (${hex(cl)})`, kind: 'folder', address: '', meta: { cluster: cl, known: Boolean(c) } };
        });
      }
      m = /^cl:(\d+)\/(\d+)\/(\d+)$/.exec(node);
      if (m) {
        const n = nodes.get(Number(m[1]));
        if (!n) throw new Error(`node ${m[1]} is not known to the server`);
        const ep = Number(m[2]);
        const cl = Number(m[3]);
        const prefix = `${ep}/${cl}/`;
        return Object.keys(n.attributes)
          .filter((k) => k.startsWith(prefix))
          .map((k) => splitPath(k).at)
          .sort((a, b) => a - b)
          .map((at) => {
            const def = attributeDef(cl, at);
            const raw = n.attributes[`${prefix}${at}`];
            let unit = def && def.unit;
            if (def && def.unitFrom !== undefined) unit = CONC_UNITS[n.attributes[`${prefix}${def.unitFrom}`]] || undefined;
            const conv = convert(def, raw);
            const states = def && def.states ? Object.entries(def.states).map(([value, label]) => `${value}=${label}`).join(', ') : '';
            const t = sampleTypeOf(def) || (conv.ok ? conv.type : 'json');
            return {
              id: `at:${n.node_id}/${prefix}${at}`,
              name: `${def ? def.name : 'Attribute'} (${hex(at)})`,
              kind: 'tag',
              address: `${n.node_id}/${prefix}${at}`,
              meta: {
                dataType: t === 'bool' ? 'bool' : t === 'string' ? 'string' : t === 'json' ? 'json' : 'number',
                matterType: def ? def.type : 'unknown',
                ...(unit ? { unit } : {}),
                description: [describePath(cl, at), states, def && def.description].filter(Boolean).join(' - ').slice(0, 500),
                value: conv.ok ? conv.v : null,
                ...(conv.ok ? {} : { valueNote: conv.reason }),
              },
            };
          });
      }
      throw new Error(`unknown browse node "${node}"`);
    },

    /**
     * Read one attribute. With schema >= 9 this is a live read_attribute through the server
     * (a Matter read interaction to the node); otherwise the server's cached value.
     */
    async probe({ address } = {}) {
      if (!driver.isConnected()) throw new Error('not connected');
      const a = parseAddress(address);
      const def = attributeDef(a.cluster, a.attribute);
      const node = nodes.get(a.nodeId);
      if (!node) throw new Error(`node ${a.nodeId} is not known to the server`);
      let raw;
      let source = 'server cache';
      if (conn.report.canReadAttribute && node.available !== false) {
        const r = await conn.readAttribute(a.nodeId, a.path);
        raw = r[a.path];
        source = 'live read';
      } else {
        raw = node.attributes[a.path];
      }
      const conv = convert(def, raw);
      return {
        address: a.address,
        name: describePath(a.cluster, a.attribute),
        source,
        type: `${def ? def.type : 'unknown'} (${source})`,
        rawHex: raw === undefined ? 'not reported' : JSON.stringify(raw),
        available: node.available !== false,
        decodings: {
          raw: raw === undefined ? null : JSON.stringify(raw),
          value: conv.ok ? conv.v : null,
          ...(conv.ok ? {} : { note: conv.reason }),
          ...(def && def.unit ? { unit: def.unit } : {}),
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

    /** Test/diagnostic view. */
    debugState() {
      return { nodes: nodes.size, stats: { ...stats }, schemaTested: SCHEMA_TESTED, lostReason };
    },
  };
  return driver;
}

module.exports = { protocol, describe, validateTag, createDriver, activeSecretFields };
