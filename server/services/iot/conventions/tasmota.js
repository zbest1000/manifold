'use strict';

const { LIMITS, GOOD, UNCERTAIN, text, typeOf, capValue, idPart } = require('../limits');

/**
 * Tasmota (documented MQTT topics, FullTopic default "%prefix%/%topic%/"). Read-only:
 *   tele/<topic>/LWT      "Online" / "Offline" (or the discovery config's onln/ofln)
 *   tele/<topic>/SENSOR   nested JSON, e.g. { "Time", "AM2301": { "Temperature", "Humidity" }, "TempUnit": "C" }
 *   tele/<topic>/STATE    POWER*, Dimmer, Wifi.RSSI/Signal, UptimeSec, ...
 *   stat/<topic>/POWER[n], stat/<topic>/RESULT, stat/<topic>/STATUS8|STATUS10 (StatusSNS)
 *   tasmota/discovery/<MAC>/config   native discovery: name, model, MAC, topic, FullTopic
 * cmnd/... is a command prefix and never read (and nothing here publishes).
 * "Time" in SENSOR/STATE is device-local time without a zone: it is NOT used as source time.
 */

const SKIP = new Set(['Time', 'TempUnit', 'PressureUnit', 'SpeedUnit', 'Epoch', 'TotalStartTime']);
const ENERGY_UNITS = { Total: 'kWh', Today: 'kWh', Yesterday: 'kWh', Power: 'W', ApparentPower: 'VA', ReactivePower: 'VAr', Voltage: 'V', Current: 'A', Frequency: 'Hz', Factor: null, ExportActive: 'kWh', ImportActive: 'kWh' };

function unitFor(path, units) {
  const leaf = path[path.length - 1];
  if (path[0] === 'ENERGY' && Object.hasOwn(ENERGY_UNITS, leaf)) return ENERGY_UNITS[leaf];
  if (/^(Temperature\d*|DewPoint|HeatIndex)$/.test(leaf)) return units.temp === 'F' ? '°F' : '°C';
  if (leaf === 'Humidity') return '%';
  if (leaf === 'Pressure' || leaf === 'SeaPressure') return units.pressure || 'hPa';
  if (leaf === 'Illuminance') return 'lx';
  if (leaf === 'CarbonDioxide' || leaf === 'CO2' || leaf === 'eCO2') return 'ppm';
  if (leaf === 'TVOC') return 'ppb';
  if (/^PM\d/.test(leaf)) return 'µg/m³';
  if (leaf === 'Distance') return 'cm';
  if (leaf === 'Speed') return units.speed || null;
  if (leaf === 'Signal') return 'dBm';
  if (leaf === 'RSSI' || leaf === 'Dimmer') return '%';
  if (leaf === 'UptimeSec') return 's';
  return null;
}

/** Scalar leaves of a JSON object, depth-bounded: [{ path, value }]. */
function leaves(obj, maxDepth = LIMITS.maxWalkDepth, cap = LIMITS.maxTagsPerDevice) {
  const out = [];
  const stack = [[obj, []]];
  while (stack.length && out.length < cap) {
    const [o, path] = stack.pop();
    if (path.length > maxDepth) continue;
    const entries = Object.entries(o);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, v] = entries[i];
      if (path.length === 0 && SKIP.has(k)) continue;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) stack.push([v, [...path, k]]);
      else out.push({ path: [...path, k], value: v });
    }
  }
  return out;
}

/** FullTopic -> matcher: { levels, prefixAt, topicAt, idAt[] } (one level per token). */
function compileFullTopic(fullTopic) {
  const levels = fullTopic.replace(/\/+$/, '').split('/');
  const m = { levels, prefixAt: levels.indexOf('%prefix%'), topicAt: levels.indexOf('%topic%'), ids: [] };
  levels.forEach((l, i) => {
    if (/^%(hostname|id)%$/.test(l)) m.ids.push(i);
  });
  return m;
}

function create(opts, reg) {
  const ft = compileFullTopic(opts.fullTopic);
  const discParts = opts.discoveryPrefix.split('/');
  const byTopic = new Map(); // device topic value -> { id, online, offline }
  const sensorKeys = new Map(); // device id -> Set(SENSOR tag keys) of the last SENSOR message

  function deviceForTopic(key, msg, info = null) {
    let e = byTopic.get(key);
    if (e && !info) return e;
    const id = info?.mac ? `tasmota:${idPart(info.mac)}` : e?.id || `tasmota:topic:${idPart(key)}`;
    if (e && e.id !== id) {
      // discovery told us the MAC: move the device to its stable id
      const old = reg.get(e.id);
      reg.removeDevice(e.id);
      if (old) reg.upsertDevice({ ...old, id, tags: [...old.tags.values()] });
    }
    const known = reg.get(id);
    const ok = reg.upsertDevice({
      id,
      convention: 'tasmota',
      stableId: info?.mac || key,
      name: text(info?.dn) || text(info?.fn?.[0]) || known?.name || key,
      manufacturer: 'Tasmota',
      model: text(info?.md) || known?.model || null,
      description: info?.sw ? `Tasmota ${text(info.sw, 40)}` : known?.description || null,
      details: { topic: key, mac: info?.mac ? text(info.mac) : known?.details?.mac || null, ip: info?.ip ? text(info.ip) : known?.details?.ip || null, hostname: text(info?.hn) || known?.details?.hostname || null },
      dynamicTags: true
    });
    if (!ok) return null;
    e = { id, online: info?.onln || e?.online || 'Online', offline: info?.ofln || e?.offline || 'Offline' };
    if (byTopic.size < LIMITS.maxDevicesPerBroker * 2) byTopic.set(key, e);
    return e;
  }

  function onSensorObject(id, obj, msg, scope) {
    const units = { temp: obj.TempUnit, pressure: text(obj.PressureUnit, 10), speed: text(obj.SpeedUnit, 10) };
    const seen = new Set();
    for (const { path, value } of leaves(obj)) {
      const key = path.join('.');
      seen.add(key);
      const unit = unitFor(path, units);
      reg.setValue(id, key, { v: capValue(value), q: GOOD }, { name: path.join(' '), type: Array.isArray(value) ? 'json' : typeOf(value), unit, topic: msg.topic, selector: key, diagnostic: scope === 'STATE' && !/^POWER|^Dimmer|^Channel/.test(key) });
    }
    if (scope === 'SENSOR') {
      for (const k of sensorKeys.get(id) || []) if (!seen.has(k)) reg.setValue(id, k, { v: null, q: UNCERTAIN, reason: 'not in the last SENSOR message' });
      sensorKeys.set(id, seen);
    }
    reg.touch(id, msg);
  }

  return {
    onMessage(msg) {
      const parts = msg.topicParts;
      // native discovery
      if (parts.length === discParts.length + 2 && discParts.every((p, i) => parts[i] === p)) {
        if (parts[parts.length - 1] !== 'config' || !msg.payload || typeof msg.payload !== 'object') return;
        const c = msg.payload;
        if (typeof c.t !== 'string' || !c.t) return;
        const e = deviceForTopic(c.t, msg, { mac: text(c.mac), dn: c.dn, fn: Array.isArray(c.fn) ? c.fn : null, md: c.md, sw: c.sw, ip: c.ip, hn: c.hn, onln: text(c.onln), ofln: text(c.ofln) });
        if (e) reg.setConventionInfo('tasmota', { discovery: true });
        return;
      }
      if (parts.length !== ft.levels.length + 1) return;
      for (let i = 0; i < ft.levels.length; i++) {
        const l = ft.levels[i];
        if (i === ft.prefixAt || i === ft.topicAt || ft.ids.includes(i)) continue;
        if (parts[i] !== l) return;
      }
      const prefix = ft.prefixAt >= 0 ? parts[ft.prefixAt] : null;
      if (prefix !== null && prefix !== 'tele' && prefix !== 'stat') return; // cmnd/ and anything else: never
      const key = [ft.topicAt, ...ft.ids].filter((i) => i >= 0).map((i) => parts[i]).join('/');
      if (!key) return;
      const suffix = parts[parts.length - 1];
      const payload = msg.payload;
      if (prefix === 'tele' && suffix === 'LWT') {
        const e = deviceForTopic(key, msg);
        if (!e) return;
        const s = String(payload);
        reg.setAvailability(e.id, s === e.online ? 'online' : s === e.offline ? 'offline' : 'unknown', s === e.offline ? 'LWT: Offline' : `LWT: ${text(s, 40) || 'empty'}`);
        return;
      }
      if (payload === '') return;
      if (prefix === 'tele' && (suffix === 'SENSOR' || suffix === 'STATE')) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const e = deviceForTopic(key, msg);
        if (e) onSensorObject(e.id, payload, msg, suffix);
        return;
      }
      if (prefix === 'stat') {
        const e = byTopic.get(key) || (/^(POWER\d*|RESULT|STATUS(8|10))$/.test(suffix) ? deviceForTopic(key, msg) : null);
        if (!e) return;
        if (/^POWER\d*$/.test(suffix)) {
          reg.setValue(e.id, suffix, { v: capValue(payload), q: GOOD }, { name: suffix, type: 'string', enum: ['ON', 'OFF'], topic: msg.topic, selector: suffix });
          reg.touch(e.id, msg);
        } else if (suffix === 'RESULT' && payload && typeof payload === 'object') {
          for (const [k, v] of Object.entries(payload)) if (/^POWER\d*$/.test(k)) reg.setValue(e.id, k, { v: capValue(v), q: GOOD }, { name: k, type: 'string', enum: ['ON', 'OFF'], topic: msg.topic, selector: k });
        } else if ((suffix === 'STATUS8' || suffix === 'STATUS10') && payload?.StatusSNS && typeof payload.StatusSNS === 'object') {
          onSensorObject(e.id, payload.StatusSNS, msg, 'SENSOR');
        }
      }
    },
    close() {}
  };
}

function normalize(opts = {}) {
  const fullTopic = typeof opts.fullTopic === 'string' && opts.fullTopic.trim() ? opts.fullTopic.trim() : '%prefix%/%topic%/';
  if (/[+#]/.test(fullTopic) || !fullTopic.includes('%topic%') || fullTopic.length > 200) throw new Error('tasmota.fullTopic must contain %topic% and no wildcards');
  const discoveryPrefix = typeof opts.discoveryPrefix === 'string' && opts.discoveryPrefix.trim() ? opts.discoveryPrefix.trim().replace(/\/+$/, '') : 'tasmota/discovery';
  if (/[+#]/.test(discoveryPrefix)) throw new Error('tasmota.discoveryPrefix must not contain wildcards');
  return { fullTopic, discoveryPrefix };
}

function filtersOf(o) {
  const levels = o.fullTopic.replace(/\/+$/, '').split('/');
  const f = (prefix) => [...levels.map((l) => (l === '%prefix%' ? prefix : /^%.*%$/.test(l) ? '+' : l)), '#'].join('/');
  return [f('tele'), f('stat'), `${o.discoveryPrefix}/#`];
}

module.exports = {
  id: 'tasmota',
  label: 'Tasmota',
  normalize,
  filters: filtersOf,
  detect(parts, msg) {
    if (parts.length === 4 && parts[0] === 'tasmota' && parts[1] === 'discovery' && parts[3] === 'config' && typeof msg.payload?.t === 'string') return {};
    if (parts.length === 3 && parts[0] === 'tele' && parts[2] === 'LWT' && (msg.payload === 'Online' || msg.payload === 'Offline')) return {};
    return null;
  },
  create,
  leaves,
  unitFor
};
