'use strict';

const { LIMITS, GOOD, text, typeOf, sourceTime, capValue, idPart } = require('../limits');

/**
 * Shelly devices over MQTT (documented Gen1 and Gen2+ APIs). Read-only.
 *
 * Gen1: shellies/<id>/<path> scalar topics (relay/0, relay/0/power, sensor/temperature, ...),
 *       shellies/<id>/online (true/false), shellies/<id>/announce (JSON: id, model, mac, fw_ver).
 *       shellies/<id>/.../command, shellies/command and .../set are commands: ignored.
 * Gen2+: <prefix>/online ("true"/"false"), <prefix>/status/<component> (JSON, e.g. switch:0),
 *       <prefix>/events/rpc NotifyStatus / NotifyFullStatus (partial component updates, params.ts
 *       = source time in seconds). <prefix>/rpc and <prefix>/command are requests: ignored.
 *       The default prefix is the device id; any prefix works because the status topic shapes
 *       are recognised (only known component names are accepted, to avoid false matches).
 */

const GEN2_COMPONENT = /^(switch|cover|light|rgb|rgbw|cct|input|em|em1|emdata|em1data|pm1|temperature|humidity|devicepower|sys|wifi|voltmeter|illuminance|smoke|flood|pro_output|pm)(:\d+)?$/;
const GEN2_UNITS = {
  apower: 'W', aprt_power: 'VA', act_power: 'W', voltage: 'V', current: 'A', freq: 'Hz', 'aenergy.total': 'Wh', 'ret_aenergy.total': 'Wh',
  'temperature.tC': '°C', 'temperature.tF': '°F', tC: '°C', tF: '°F', rh: '%', 'battery.percent': '%', 'battery.V': 'V', lux: 'lx', rssi: 'dBm',
  uptime: 's', current_pos: '%', a_act_power: 'W', b_act_power: 'W', c_act_power: 'W', a_voltage: 'V', b_voltage: 'V', c_voltage: 'V',
  a_current: 'A', b_current: 'A', c_current: 'A', total_act_power: 'W', total_current: 'A', brightness: '%'
};
const GEN1_UNITS = [
  [/^relay\/\d+\/power$|^meter\/\d+\/power$|^emeter\/\d+\/power$|^light\/\d+\/power$/, 'W'],
  [/\/energy$/, 'Wmin'], // Gen1 reports energy in watt-minutes
  [/^emeter\/\d+\/(total|total_returned)$/, 'Wh'],
  [/\/voltage$|^voltage$/, 'V'],
  [/\/current$/, 'A'],
  [/temperature_f$/, '°F'],
  [/temperature$/, '°C'],
  [/humidity$/, '%'],
  [/battery$/, '%'],
  [/lux$/, 'lx'],
  [/^roller\/\d+\/pos$/, '%']
];
const SKIP_GEN2 = new Set(['id', 'source']);

function gen2Leaves(obj, comp, cap = LIMITS.maxTagsPerDevice) {
  const out = [];
  const stack = [[obj, []]];
  while (stack.length && out.length < cap) {
    const [o, path] = stack.pop();
    if (path.length > LIMITS.maxWalkDepth) continue;
    for (const [k, v] of Object.entries(o)) {
      if (path.length === 0 && SKIP_GEN2.has(k)) continue;
      if (Array.isArray(v)) continue; // by_minute histories and similar: not a tag
      if (v !== null && typeof v === 'object') stack.push([v, [...path, k]]);
      else out.push({ sub: [...path, k].join('.'), key: `${comp}.${[...path, k].join('.')}`, value: v });
    }
  }
  return out;
}

function create(opts, reg) {
  const g1 = opts.gen1Prefix;
  const devs = new Map(); // `${gen}:${prefix}` -> device id

  function device(gen, prefix, info = {}) {
    const k = `${gen}:${prefix}`;
    let id = devs.get(k);
    if (id && !info.force) return id;
    id = id || `shelly:${idPart(prefix)}`;
    const known = reg.get(id);
    const ok = reg.upsertDevice({
      id,
      convention: 'shelly',
      stableId: prefix,
      name: known?.name || text(info.name) || prefix,
      manufacturer: 'Shelly',
      model: text(info.model) || known?.model || (gen === 1 ? text(prefix.replace(/-[0-9A-Fa-f]{6,12}$/, '')) : null),
      description: info.fw ? `firmware ${text(info.fw, 60)}` : known?.description || (gen === 1 ? 'Gen1' : 'Gen2+'),
      details: { generation: gen === 1 ? 1 : 2, topicPrefix: prefix, mac: text(info.mac) || known?.details?.mac || null, ip: text(info.ip) || known?.details?.ip || null },
      dynamicTags: true
    });
    if (!ok) return null;
    if (devs.size < LIMITS.maxDevicesPerBroker * 2) devs.set(k, id);
    return id;
  }

  function gen2Component(id, comp, obj, msg, t) {
    for (const leaf of gen2Leaves(obj, comp)) {
      const unit = GEN2_UNITS[leaf.sub] || GEN2_UNITS[leaf.sub.split('.').pop()] || null;
      reg.setValue(id, leaf.key, { v: capValue(leaf.value), q: GOOD, t }, { name: `${comp} ${leaf.sub}`, type: typeOf(leaf.value), unit, topic: msg.topic, selector: leaf.key, diagnostic: /^(sys|wifi)\b/.test(comp) });
    }
    reg.touch(id, msg);
  }

  return {
    onMessage(msg) {
      const p = msg.topicParts;
      const payload = msg.payload;
      // ---- Gen1
      if (p[0] === g1 && p.length >= 2) {
        if (p.length === 2) return; // shellies/announce, shellies/command
        const prefix = p[1];
        const rest = p.slice(2).join('/');
        const last = p[p.length - 1];
        if (last === 'command' || last === 'set' || rest.startsWith('command')) return;
        if (rest === 'announce') {
          if (payload && typeof payload === 'object') device(1, prefix, { force: true, model: payload.model, mac: payload.mac, ip: payload.ip, fw: payload.fw_ver });
          return;
        }
        if (rest === 'info') return; // large status document; the scalar topics carry the same values
        const id = device(1, prefix);
        if (!id) return;
        if (rest === 'online') {
          const on = payload === true || payload === 'true';
          const off = payload === false || payload === 'false';
          reg.setAvailability(id, on ? 'online' : off ? 'offline' : 'unknown', on ? 'online topic' : off ? 'device reported offline' : 'online topic unreadable');
          return;
        }
        if (payload === '' || (payload !== null && typeof payload === 'object')) return;
        const unit = (GEN1_UNITS.find(([re]) => re.test(rest)) || [])[1] || null;
        reg.setValue(id, rest, { v: capValue(payload), q: GOOD }, { name: rest.replace(/\//g, ' '), type: typeOf(payload), unit, topic: msg.topic, selector: '(payload)' });
        reg.touch(id, msg);
        return;
      }
      // ---- Gen2+
      if (p.length === 2 && p[1] === 'online' && (payload === true || payload === false || payload === 'true' || payload === 'false')) {
        if (!devs.has(`2:${p[0]}`) && !/^shelly/i.test(p[0])) return; // unknown prefix: wait for a status topic first
        const id = device(2, p[0]);
        if (!id) return;
        const on = payload === true || payload === 'true';
        reg.setAvailability(id, on ? 'online' : 'offline', on ? 'online topic' : 'device reported offline');
        return;
      }
      if (p.length === 3 && p[1] === 'status' && GEN2_COMPONENT.test(p[2])) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const id = device(2, p[0], p[2] === 'sys' ? { force: true, mac: payload.mac } : {});
        if (id) gen2Component(id, p[2], payload, msg);
        return;
      }
      if (p.length === 3 && p[1] === 'events' && p[2] === 'rpc') {
        if (!payload || typeof payload !== 'object' || (payload.method !== 'NotifyStatus' && payload.method !== 'NotifyFullStatus')) return;
        const params = payload.params;
        if (!params || typeof params !== 'object') return;
        const id = device(2, p[0]);
        if (!id) return;
        const t = sourceTime(params.ts, { seconds: true });
        for (const [comp, obj] of Object.entries(params)) {
          if (comp === 'ts' || !GEN2_COMPONENT.test(comp) || !obj || typeof obj !== 'object') continue;
          gen2Component(id, comp, obj, msg, t);
        }
      }
    },
    close() {}
  };
}

function normalize(opts = {}) {
  const gen1Prefix = typeof opts.gen1Prefix === 'string' && opts.gen1Prefix.trim() ? opts.gen1Prefix.trim() : 'shellies';
  if (/[+#/]/.test(gen1Prefix)) throw new Error('shelly.gen1Prefix must be a single topic level');
  return { gen1Prefix };
}

module.exports = {
  id: 'shelly',
  label: 'Shelly',
  normalize,
  filters: (o) => [`${o.gen1Prefix}/#`, '+/online', '+/status/+', '+/events/rpc'],
  detect(parts, msg) {
    if (parts[0] === 'shellies' && parts.length === 3 && (parts[2] === 'online' || parts[2] === 'announce')) return {};
    if (parts.length === 3 && parts[1] === 'status' && GEN2_COMPONENT.test(parts[2]) && msg.payloadFormat === 'json') return {};
    if (parts.length === 3 && parts[1] === 'events' && parts[2] === 'rpc' && /^shelly/i.test(String(msg.payload?.src || ''))) return {};
    return null;
  },
  create,
  gen2Leaves
};
