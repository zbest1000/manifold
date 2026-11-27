'use strict';

const { LIMITS, GOOD, UNCERTAIN, getPath, text, num, typeOf, sourceTime, capValue } = require('../limits');

/**
 * Zigbee2MQTT (documented MQTT API of 1.x and 2.x). Read-only: only `<base>/bridge/devices`,
 * `<base>/bridge/groups`, `<base>/bridge/state`, `<base>/bridge/info`, the per-device state topic
 * `<base>/<friendly_name>` and `<base>/<friendly_name>/availability` are read. `/set`, `/get`,
 * `bridge/request/...` and every other topic are ignored. See ../NOTES.md.
 */

const ACCESS_STATE = 1; // "published state" bit of an expose's access
const MAX_PENDING = 500;

function exposeTags(exposes, cap = LIMITS.maxTagsPerDevice) {
  const out = [];
  const seen = new Set();
  const stack = (Array.isArray(exposes) ? exposes : []).map((e) => [e, [], 0]).reverse();
  while (stack.length && out.length < cap) {
    const [e, path, depth] = stack.pop();
    if (!e || typeof e !== 'object' || depth > 6) continue;
    const type = typeof e.type === 'string' ? e.type : '';
    if (Array.isArray(e.features) && type !== 'list') {
      // composite: its features live under payload[property]; specific (light, ...): at top level
      const sub = type === 'composite' && typeof e.property === 'string' && e.property ? [...path, e.property] : path;
      for (let i = e.features.length - 1; i >= 0; i--) stack.push([e.features[i], sub, depth + 1]);
      continue;
    }
    const property = typeof e.property === 'string' && e.property ? e.property : null;
    if (!property) continue;
    const access = Number.isInteger(e.access) ? e.access : ACCESS_STATE; // older bridges omitted access on some exposes
    if ((access & ACCESS_STATE) === 0) continue; // set/get-only property: never in the published state
    const p = [...path, property];
    const key = p.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = {
      key,
      path: p,
      name: text(e.label) || text(e.name) || property,
      description: text(e.description, 500),
      unit: text(e.unit, 40),
      diagnostic: e.category === 'diagnostic' || property === 'linkquality'
    };
    if (type === 'numeric') {
      tag.type = 'float64';
      const lo = num(e.value_min);
      const hi = num(e.value_max);
      if (lo !== undefined && hi !== undefined && lo <= hi) tag.range = { min: lo, max: hi };
      if (Array.isArray(e.presets)) tag.presets = e.presets.slice(0, 20).map((x) => ({ name: text(x?.name), value: num(x?.value) })).filter((x) => x.name);
    } else if (type === 'binary') {
      tag.type = 'bool';
      tag.valueOn = e.value_on;
      tag.valueOff = e.value_off;
    } else if (type === 'enum') {
      tag.type = 'string';
      if (Array.isArray(e.values)) tag.enum = e.values.slice(0, 100).map((x) => text(x, 100)).filter((x) => x !== null);
    } else if (type === 'list') {
      tag.type = 'json';
    } else {
      tag.type = 'string';
    }
    out.push(tag);
  }
  return out;
}

function readTag(tag, payload) {
  const raw = getPath(payload, tag.path);
  if (raw === undefined) return { v: null, q: UNCERTAIN, reason: `"${tag.key}" not in the last state message` };
  if (tag.type === 'bool') {
    if (raw === tag.valueOn || raw === true) return { v: true, q: GOOD };
    if (raw === tag.valueOff || raw === false) return { v: false, q: GOOD };
    return { v: capValue(raw), q: UNCERTAIN, reason: `value ${JSON.stringify(raw)?.slice(0, 40)} is neither value_on nor value_off` };
  }
  if (tag.type === 'float64' && typeof raw !== 'number') {
    const n = num(raw);
    return n === undefined ? { v: capValue(raw), q: UNCERTAIN, reason: 'not a number' } : { v: n, q: GOOD };
  }
  return { v: capValue(raw), q: GOOD };
}

/** Legacy string ("online") and JSON ({ "state": "online" }) availability / bridge state. */
function availabilityOf(payload) {
  const s = payload && typeof payload === 'object' ? payload.state : payload;
  if (s === 'online') return 'online';
  if (s === 'offline') return 'offline';
  return null;
}

function create(opts, reg) {
  const base = opts.baseTopic;
  const baseParts = base.split('/');
  const byName = new Map(); // friendly_name -> device id (devices and groups)
  const defs = new Map(); // device id -> { kind, friendly, tags }
  const pending = new Map(); // state/availability topics seen before the device list
  const ownAvail = new Map(); // device id -> 'online' | 'offline'
  let bridge = null; // 'online' | 'offline' | null
  let memberTags = new Map(); // ieee -> tags (for groups)
  let lastGroups = null;

  const avail = (id) => {
    if (bridge === 'offline') return { state: 'offline', reason: 'Zigbee2MQTT bridge is offline' };
    const own = ownAvail.get(id);
    if (own) return { state: own, reason: own === 'offline' ? 'Zigbee2MQTT reports the device offline' : 'Zigbee2MQTT availability' };
    return { state: bridge === 'online' ? 'online' : 'unknown', reason: bridge === 'online' ? 'bridge online (no availability reported for the device)' : 'no availability reported' };
  };
  const pushAvail = (id) => {
    const a = avail(id);
    reg.setAvailability(id, a.state, a.reason);
  };

  function onDevices(list) {
    if (!Array.isArray(list)) return;
    const keep = new Set();
    memberTags = new Map();
    for (const d of list) {
      if (!d || typeof d !== 'object' || typeof d.ieee_address !== 'string') continue;
      if (d.type === 'Coordinator' || d.disabled === true) continue;
      const friendly = text(d.friendly_name, 400);
      if (!friendly) continue;
      const id = `z2m:${d.ieee_address}`;
      const def = d.definition && typeof d.definition === 'object' ? d.definition : null;
      const tags = def ? exposeTags(def.exposes) : [];
      memberTags.set(d.ieee_address, tags);
      const ok = reg.upsertDevice({
        id,
        convention: 'zigbee2mqtt',
        stableId: d.ieee_address,
        name: friendly,
        manufacturer: text(def?.vendor) || text(d.manufacturer),
        model: text(def?.model) || text(d.model_id),
        description: text(def?.description, 300),
        details: { ieeeAddress: d.ieee_address, type: text(d.type), powerSource: text(d.power_source), supported: d.supported !== false && Boolean(def), stateTopic: `${base}/${friendly}` },
        dynamicTags: !def, // unsupported device: tags from the state keys it publishes
        tags: tags.map(({ path: _p, valueOn: _a, valueOff: _b, ...t }) => ({ ...t, topic: `${base}/${friendly}`, selector: t.key }))
      });
      if (!ok) continue;
      keep.add(id);
      for (const [name, other] of byName) if (other === id && name !== friendly) byName.delete(name); // renamed: old name freed
      byName.set(friendly, id);
      defs.set(id, { kind: 'device', friendly, tags });
      pushAvail(id);
    }
    for (const [id, d] of defs) {
      if (d.kind !== 'device' || keep.has(id)) continue;
      defs.delete(id);
      if (byName.get(d.friendly) === id) byName.delete(d.friendly);
      ownAvail.delete(id);
      reg.removeDevice(id);
    }
    if (lastGroups) onGroups(lastGroups);
    replayPending();
  }

  function onGroups(list) {
    if (!Array.isArray(list)) return;
    lastGroups = list;
    const keep = new Set();
    for (const g of list) {
      if (!g || typeof g !== 'object' || g.id === undefined) continue;
      const friendly = text(g.friendly_name, 400);
      if (!friendly) continue;
      const id = `z2m:group:${String(g.id).slice(0, 20)}`;
      // A group publishes the state of what its members share: the light/switch/cover/... features.
      const tags = [];
      const seen = new Set();
      for (const m of Array.isArray(g.members) ? g.members.slice(0, 200) : []) {
        for (const t of memberTags.get(m?.ieee_address) || []) {
          if (t.path.length !== 1 || t.diagnostic || seen.has(t.key)) continue;
          if (!['state', 'brightness', 'color_temp', 'position', 'tilt', 'color_mode'].includes(t.key)) continue;
          seen.add(t.key);
          tags.push(t);
        }
      }
      const ok = reg.upsertDevice({
        id,
        convention: 'zigbee2mqtt',
        stableId: `group ${g.id}`,
        name: friendly,
        manufacturer: null,
        model: 'Zigbee group',
        description: `Group of ${Array.isArray(g.members) ? g.members.length : 0} device(s)`,
        details: { groupId: g.id, stateTopic: `${base}/${friendly}` },
        dynamicTags: tags.length === 0,
        tags: tags.map(({ path: _p, valueOn: _a, valueOff: _b, ...t }) => ({ ...t, topic: `${base}/${friendly}`, selector: t.key }))
      });
      if (!ok) continue;
      keep.add(id);
      for (const [name, other] of byName) if (other === id && name !== friendly) byName.delete(name);
      byName.set(friendly, id);
      defs.set(id, { kind: 'group', friendly, tags });
      pushAvail(id);
    }
    for (const [id, d] of defs) {
      if (d.kind !== 'group' || keep.has(id)) continue;
      defs.delete(id);
      if (byName.get(d.friendly) === id) byName.delete(d.friendly);
      reg.removeDevice(id);
    }
  }

  function replayPending() {
    for (const [rest, msg] of [...pending]) {
      if (route(rest, msg)) pending.delete(rest);
    }
  }

  function onState(id, msg) {
    const d = defs.get(id);
    const payload = msg.payload;
    if (!d || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const t = sourceTime(payload.last_seen);
    if (reg.isDynamic(id)) {
      for (const [k, v] of Object.entries(payload).slice(0, LIMITS.maxTagsPerDevice)) {
        if (k === 'last_seen' || (v !== null && typeof v === 'object')) continue;
        reg.setValue(id, k, { v: capValue(v), q: GOOD, t }, { name: k, type: typeOf(v), topic: msg.topic, selector: k });
      }
      reg.touch(id, msg);
      return;
    }
    for (const tag of d.tags) reg.setValue(id, tag.key, { ...readTag(tag, payload), t });
    reg.touch(id, msg);
  }

  /** A topic below the base: true when it was understood (or deliberately ignored). */
  function route(rest, msg) {
    const id = byName.get(rest);
    if (id) {
      onState(id, msg);
      return true;
    }
    if (rest.endsWith('/availability')) {
      const aid = byName.get(rest.slice(0, -'/availability'.length));
      if (!aid) return false;
      const a = availabilityOf(msg.payload);
      if (a) ownAvail.set(aid, a);
      else ownAvail.delete(aid);
      pushAvail(aid);
      return true;
    }
    return false;
  }

  return {
    onMessage(msg) {
      const parts = msg.topicParts;
      for (let i = 0; i < baseParts.length; i++) if (parts[i] !== baseParts[i]) return;
      const restParts = parts.slice(baseParts.length);
      if (!restParts.length) return;
      if (restParts[0] === 'bridge') {
        const what = restParts.slice(1).join('/');
        if (what === 'devices') onDevices(msg.payload);
        else if (what === 'groups') onGroups(msg.payload);
        else if (what === 'state') {
          bridge = availabilityOf(msg.payload);
          reg.setConventionInfo('zigbee2mqtt', { bridgeState: bridge || 'unknown' });
          for (const id of defs.keys()) pushAvail(id);
        } else if (what === 'info' && msg.payload && typeof msg.payload === 'object') {
          reg.setConventionInfo('zigbee2mqtt', { version: text(msg.payload.version, 40), coordinator: text(msg.payload.coordinator?.type, 60) });
        }
        return;
      }
      const last = restParts[restParts.length - 1];
      const prev = restParts[restParts.length - 2];
      if (last === 'set' || last === 'get' || prev === 'set' || prev === 'get') return; // <name>/set[/attr], <name>/get[/attr]: commands, never ours
      const rest = restParts.join('/');
      if (route(rest, msg)) return;
      if (msg.payload === '' || pending.has(rest) || pending.size < MAX_PENDING) {
        if (msg.payload === '') pending.delete(rest);
        else pending.set(rest, msg);
      }
    },
    close() {
      pending.clear();
    }
  };
}

function normalize(opts = {}) {
  const baseTopic = typeof opts.baseTopic === 'string' && opts.baseTopic.trim() ? opts.baseTopic.trim().replace(/\/+$/, '') : 'zigbee2mqtt';
  if (/[+#]/.test(baseTopic) || baseTopic.length > 200) throw new Error('zigbee2mqtt.baseTopic must be a plain topic prefix without wildcards');
  return { baseTopic };
}

module.exports = {
  id: 'zigbee2mqtt',
  label: 'Zigbee2MQTT',
  normalize,
  filters: (o) => [`${o.baseTopic}/#`],
  /**
   * `<base>/bridge/devices|info|state` -> suggested options. These are retained topics, but a bridge
   * that starts after Manifold subscribed delivers them live (retain flag clear), so the payload
   * shape is checked instead of the flag.
   */
  detect(parts, msg) {
    if (parts.length < 3) return null;
    const last = parts[parts.length - 1];
    if (parts[parts.length - 2] !== 'bridge' || !['devices', 'info', 'state'].includes(last)) return null;
    if (last === 'devices' && !Array.isArray(msg.payload)) return null;
    if (last === 'info' && !(msg.payload && typeof msg.payload === 'object' && 'version' in msg.payload)) return null;
    if (last === 'state' && availabilityOf(msg.payload) === null) return null;
    return { baseTopic: parts.slice(0, -2).join('/') };
  },
  create,
  exposeTags,
  readTag
};
