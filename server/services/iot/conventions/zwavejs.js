'use strict';

const { LIMITS, GOOD, UNCERTAIN, text, num, typeOf, sourceTime, capValue } = require('../limits');

/**
 * Z-Wave JS UI (formerly zwavejs2mqtt) MQTT gateway. Read-only: value topics, node `status`,
 * `nodeinfo` and `lastActive`, and the gateway's `_CLIENTS/ZWAVE_GATEWAY-<name>/status`. Every
 * topic ending in `/set` (writes) and the `_CLIENTS/.../api/...` request topics are ignored.
 *
 * Topic layouts after the prefix (default "zwave"), with an optional location level when the
 * gateway uses node names:
 *   valueid: <node>/<commandClass>/<endpoint>/<property>[/<propertyKey>]       e.g. zwave/5/49/0/Air_temperature
 *   named:   <node>/<cc_name>/endpoint_<n>/<propertyName>[/<propertyKey>]    e.g. zwave/kitchen/sensor/sensor_multilevel/endpoint_0/Air_temperature
 *   configured topics: arbitrary; understood only with the "entire value object" payload (it names the node).
 * Payloads: JSON time-value { time, value }, the entire value object (with metadata), or just the value.
 */

const CC_NAME = /^[a-z][a-z0-9_]*$/;
const ENDPOINT_NAMED = /^endpoint_\d+$/;
const INT = /^\d+$/;

/** Index of the command-class level in the levels after the prefix, or -1. */
function ccIndex(s) {
  for (let i = 1; i + 2 < s.length; i++) {
    const cc = s[i];
    const ep = s[i + 1];
    if (INT.test(cc) && INT.test(ep) && Number(cc) >= 32 && Number(cc) <= 0xffff) return i;
    if (CC_NAME.test(cc) && ENDPOINT_NAMED.test(ep)) return i;
  }
  return -1;
}

function nodeIdOf(nodePart) {
  if (nodePart.length !== 1) return null;
  const m = /^(?:nodeID_)?(\d{1,4})$/i.exec(nodePart[0]);
  return m ? Number(m[1]) : null;
}

const isValueObject = (p) => p && typeof p === 'object' && !Array.isArray(p) && Object.hasOwn(p, 'commandClass') && Object.hasOwn(p, 'property') && Object.hasOwn(p, 'value');

const TYPES = { number: 'float64', boolean: 'bool', string: 'string' };

/** Tag metadata from an entire value object. */
function metaOf(p) {
  const m = { name: text(p.label) || text(p.propertyName) || text(p.property) };
  m.type = TYPES[p.type] || (p.type ? 'json' : typeOf(p.value));
  const unit = text(p.unit, 40);
  if (unit) m.unit = unit;
  const lo = num(p.min);
  const hi = num(p.max);
  if (lo !== undefined && hi !== undefined && lo <= hi) m.range = { min: lo, max: hi };
  if (p.states && typeof p.states === 'object') {
    const list = Array.isArray(p.states) ? p.states.map((s) => (s && typeof s === 'object' ? `${s.value} = ${s.text}` : null)) : Object.entries(p.states).map(([k, v]) => `${k} = ${v}`);
    m.enum = list.filter(Boolean).slice(0, 100).map((x) => text(x, 100));
  }
  const d = text(p.description, 300);
  if (d) m.description = d;
  if (p.commandClassName) m.description = m.description ? `${text(p.commandClassName)}: ${m.description}` : text(p.commandClassName);
  return m;
}

function valueKey(p) {
  return [p.commandClass, p.endpoint ?? 0, p.property, p.propertyKey].filter((x) => x !== undefined && x !== null && x !== '').map(String).join('-');
}

function create(opts, reg) {
  const prefixParts = opts.prefix.split('/');
  const nodes = new Map(); // nodeKey (topic node part) -> device id
  let gateway = null; // true | false | null

  const statusAvail = new Map(); // device id -> 'online' | 'offline'
  const pushAvail = (id) => {
    if (gateway === false) return reg.setAvailability(id, 'offline', 'Z-Wave JS UI gateway is offline');
    const s = statusAvail.get(id);
    if (s) return reg.setAvailability(id, s, s === 'offline' ? 'node reported dead' : 'node status');
    reg.setAvailability(id, gateway ? 'online' : 'unknown', gateway ? 'gateway online' : 'no node status seen');
  };

  function deviceFor(nodePart, nodeId) {
    const key = nodePart.join('/');
    let id = nodes.get(key);
    if (id && !(nodeId !== null && id !== `zwave:${nodeId}`)) return id;
    id = nodeId !== null ? `zwave:${nodeId}` : `zwave:topic:${key}`;
    const known = reg.get(id);
    const ok = reg.upsertDevice({
      id,
      convention: 'zwavejs',
      stableId: nodeId !== null ? `node ${nodeId}` : key,
      name: known?.name || (nodeId !== null && nodePart.length === 1 && INT.test(nodePart[0]) ? `Node ${nodeId}` : nodePart.join(' / ')),
      details: { ...(known?.details || {}), nodeId, topicNode: key },
      dynamicTags: true
    });
    if (!ok) return null;
    if (nodes.size < LIMITS.maxDevicesPerBroker * 2) nodes.set(key, id);
    if (!known) pushAvail(id);
    return id;
  }

  function onValue(id, key, topic, payload, msg, fallbackName) {
    let v;
    let t;
    let def;
    if (isValueObject(payload)) {
      if (payload.readable === false) return;
      def = metaOf(payload);
      v = payload.value;
      t = sourceTime(payload.lastUpdate);
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'value') && Object.hasOwn(payload, 'time')) {
      v = payload.value;
      t = sourceTime(payload.time);
      def = { name: fallbackName, type: typeOf(v) };
    } else {
      v = payload;
      def = { name: fallbackName, type: typeOf(v) };
    }
    const dev = reg.get(id);
    const tag = dev?.tags.get(key);
    // A richer description (entire value object) replaces a guessed one.
    if (tag && isValueObject(payload)) {
      const meta = { ...def, topic, selector: key };
      if (JSON.stringify([tag.name, tag.type, tag.unit, tag.range, tag.enum, tag.description]) !== JSON.stringify([meta.name, meta.type, meta.unit, meta.range, meta.enum, meta.description])) {
        const tags = [...dev.tags.values()].map((x) => (x.key === key ? { ...x, ...meta, key } : x));
        reg.upsertDevice({ id, tags });
      }
    }
    reg.setValue(id, key, { v: capValue(v === undefined ? null : v), q: v === undefined ? UNCERTAIN : GOOD, t, reason: v === undefined ? 'no value in payload' : undefined }, { ...def, topic, selector: key });
    reg.touch(id, msg);
  }

  return {
    onMessage(msg) {
      const parts = msg.topicParts;
      for (let i = 0; i < prefixParts.length; i++) if (parts[i] !== prefixParts[i]) return;
      const s = parts.slice(prefixParts.length);
      if (!s.length || s[s.length - 1] === 'set') return;
      if (s[0] === '_CLIENTS') {
        if (s.length === 3 && /^ZWAVE_GATEWAY-/.test(s[1]) && s[2] === 'status') {
          const p = msg.payload;
          const val = p && typeof p === 'object' ? p.value : p;
          gateway = val === true || val === 'true' ? true : val === false || val === 'false' ? false : null;
          reg.setConventionInfo('zwavejs', { gateway: s[1].slice('ZWAVE_GATEWAY-'.length), gatewayState: gateway === null ? 'unknown' : gateway ? 'online' : 'offline' });
          for (const id of new Set(nodes.values())) pushAvail(id);
        }
        return;
      }
      if (s[0].startsWith('_')) return; // _EVENTS and other gateway topics
      const payload = msg.payload;
      if (payload === '') return; // a cleared retained value: nothing to read
      const last = s[s.length - 1];
      if (s.length >= 2 && (last === 'status' || last === 'nodeinfo' || last === 'lastActive') && ccIndex(s) < 0) {
        const nodePart = s.slice(0, -1);
        const nodeId = nodeIdOf(nodePart) ?? (payload && typeof payload === 'object' && Number.isInteger(payload.id) ? payload.id : null);
        const id = deviceFor(nodePart, nodeId);
        if (!id) return;
        if (last === 'status') {
          const st = payload && typeof payload === 'object' ? payload.status ?? payload.value : payload;
          if (st === 'Dead' || st === false || st === 'false') statusAvail.set(id, 'offline');
          else if (st === 'Alive' || st === 'Awake' || st === 'Asleep' || st === true || st === 'true') statusAvail.set(id, 'online');
          pushAvail(id);
        } else if (last === 'nodeinfo' && payload && typeof payload === 'object') {
          reg.upsertDevice({
            id,
            name: text(payload.name) || reg.get(id)?.name,
            manufacturer: text(payload.manufacturer),
            model: text(payload.productLabel) || text(payload.productDescription),
            description: text(payload.productDescription, 300),
            details: { ...(reg.get(id)?.details || {}), location: text(payload.loc), firmware: text(payload.firmwareVersion, 40) }
          });
        } else reg.touch(id, msg);
        return;
      }
      const i = ccIndex(s);
      if (i > 0) {
        const nodePart = s.slice(0, i);
        const nodeId = isValueObject(payload) && Number.isInteger(payload.nodeId) ? payload.nodeId : nodeIdOf(nodePart);
        const id = deviceFor(nodePart, nodeId);
        if (!id) return;
        const key = isValueObject(payload) ? valueKey(payload) : s.slice(i).join('/');
        onValue(id, key, msg.topic, payload, msg, s.slice(i + 2).join(' / ').replace(/_/g, ' '));
        return;
      }
      // Configured topics: only the entire value object says which node and value it is.
      if (isValueObject(payload) && Number.isInteger(payload.nodeId)) {
        const id = deviceFor([`nodeID_${payload.nodeId}`], payload.nodeId);
        if (id) onValue(id, valueKey(payload), msg.topic, payload, msg, valueKey(payload));
      }
    },
    close() {}
  };
}

function normalize(opts = {}) {
  const prefix = typeof opts.prefix === 'string' && opts.prefix.trim() ? opts.prefix.trim().replace(/\/+$/, '') : 'zwave';
  if (/[+#]/.test(prefix) || prefix.length > 200) throw new Error('zwavejs.prefix must be a plain topic prefix without wildcards');
  return { prefix };
}

module.exports = {
  id: 'zwavejs',
  label: 'Z-Wave JS UI',
  normalize,
  filters: (o) => [`${o.prefix}/#`],
  detect(parts) {
    const n = parts.length;
    if (n < 3 || parts[n - 1] !== 'status' || !/^ZWAVE_GATEWAY-/.test(parts[n - 2]) || parts[n - 3] !== '_CLIENTS') return null;
    return { prefix: parts.slice(0, n - 3).join('/') || 'zwave' };
  },
  create,
  ccIndex,
  metaOf
};
