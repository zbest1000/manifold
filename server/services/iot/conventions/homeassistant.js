'use strict';

const { LIMITS, GOOD, UNCERTAIN, BAD, text, num, capValue, idPart } = require('../limits');
const tpl = require('../template');

/**
 * Home Assistant MQTT discovery (the documented discovery protocol, including the device-based
 * form `<prefix>/device/<object_id>/config` with `cmps`). Manifold reads discovery configs and
 * the STATE side of each entity only: state topics, availability and json_attributes topics.
 * command topics are never used (nothing here publishes at all).
 *
 *   <prefix>/<component>/[<node_id>/]<object_id>/config     (default prefix "homeassistant")
 *
 * - abbreviated keys are expanded (ABBREV / DEVICE_ABBREV / ORIGIN_ABBREV / AVTY_ABBREV);
 * - "~" at the start or end of a *_topic value is replaced by the config's "~" base;
 * - entities group into devices by device.identifiers[0] (else connections[0]); an entity without
 *   a device block becomes a device of its own;
 * - value templates go through ../template.js (a small safe subset); anything else -> the tag is
 *   marked "template not supported" and carries the raw payload;
 * - an empty retained config removes the entity (and the device once it has none left); a
 *   device-based config whose component is reduced to { platform } removes that component.
 */

const ABBREV = {
  act_t: 'action_topic', act_tpl: 'action_template', atype: 'automation_type', aux_stat_t: 'aux_state_topic', aux_stat_tpl: 'aux_state_template',
  avty: 'availability', avty_mode: 'availability_mode', avty_t: 'availability_topic', avty_tpl: 'availability_template',
  away_mode_stat_t: 'away_mode_state_topic', away_mode_stat_tpl: 'away_mode_state_template', bri_scl: 'brightness_scale',
  bri_stat_t: 'brightness_state_topic', bri_val_tpl: 'brightness_value_template', clr_temp_stat_t: 'color_temp_state_topic',
  clr_temp_val_tpl: 'color_temp_value_template', cmd_t: 'command_topic', cmd_tpl: 'command_template', cmps: 'components',
  curr_hum_t: 'current_humidity_topic', curr_hum_tpl: 'current_humidity_template', curr_temp_t: 'current_temperature_topic',
  curr_temp_tpl: 'current_temperature_template', dev: 'device', dev_cla: 'device_class', dsp_prc: 'suggested_display_precision',
  e: 'encoding', en: 'enabled_by_default', ent_cat: 'entity_category', ent_pic: 'entity_picture', exp_aft: 'expire_after',
  fan_mode_stat_t: 'fan_mode_state_topic', fan_mode_stat_tpl: 'fan_mode_state_template', frc_upd: 'force_update', ic: 'icon',
  json_attr: 'json_attributes', json_attr_t: 'json_attributes_topic', json_attr_tpl: 'json_attributes_template',
  l_ver_t: 'latest_version_topic', l_ver_tpl: 'latest_version_template', max: 'max', max_temp: 'max_temp', min: 'min', min_temp: 'min_temp',
  mode_stat_t: 'mode_state_topic', mode_stat_tpl: 'mode_state_template', name: 'name', obj_id: 'object_id', o: 'origin', off_dly: 'off_delay',
  opt: 'optimistic', osc_stat_t: 'oscillation_state_topic', osc_stat_tpl: 'oscillation_value_template', p: 'platform',
  pct_stat_t: 'percentage_state_topic', pct_val_tpl: 'percentage_value_template', pl_avail: 'payload_available', pl_not_avail: 'payload_not_available',
  pl_off: 'payload_off', pl_on: 'payload_on', pos_t: 'position_topic', pos_tpl: 'position_template', pr_mode_stat_t: 'preset_mode_state_topic',
  pr_mode_val_tpl: 'preset_mode_value_template', qos: 'qos', ret: 'retain', stat_cla: 'state_class', stat_clsd: 'state_closed', stat_closing: 'state_closing',
  stat_off: 'state_off', stat_on: 'state_on', stat_open: 'state_open', stat_opening: 'state_opening', stat_stopped: 'state_stopped',
  stat_locked: 'state_locked', stat_unlocked: 'state_unlocked', stat_t: 'state_topic', stat_tpl: 'state_template', stat_val_tpl: 'state_value_template',
  step: 'step', sup_clrm: 'supported_color_modes', sup_feat: 'supported_features', t: 'topic', temp_stat_t: 'temperature_state_topic',
  temp_stat_tpl: 'temperature_state_template', temp_unit: 'temperature_unit', tilt_status_t: 'tilt_status_topic', tilt_status_tpl: 'tilt_status_template',
  uniq_id: 'unique_id', unit_of_meas: 'unit_of_measurement', val_tpl: 'value_template', whit_val_stat_t: 'white_value_state_topic',
  rgb_stat_t: 'rgb_state_topic', rgb_val_tpl: 'rgb_value_template', xy_stat_t: 'xy_state_topic', xy_val_tpl: 'xy_value_template',
  hs_stat_t: 'hs_state_topic', hs_val_tpl: 'hs_value_template', fx_stat_t: 'effect_state_topic', fx_val_tpl: 'effect_value_template',
  pow_stat_t: 'power_state_topic', pow_stat_tpl: 'power_state_template', act_stat_t: 'action_state_topic', hold_stat_t: 'hold_state_topic',
  hold_stat_tpl: 'hold_state_template', schema: 'schema', sug_dsp_prc: 'suggested_display_precision', stat_val: 'state_value'
};
const DEVICE_ABBREV = { cns: 'connections', ids: 'identifiers', name: 'name', mf: 'manufacturer', mdl: 'model', mdl_id: 'model_id', hw: 'hw_version', sw: 'sw_version', sa: 'suggested_area', sn: 'serial_number', cu: 'configuration_url', via_device: 'via_device' };
const ORIGIN_ABBREV = { name: 'name', sw: 'sw_version', url: 'support_url' };
const AVTY_ABBREV = { t: 'topic', pl_avail: 'payload_available', pl_not_avail: 'payload_not_available', val_tpl: 'value_template' };

const COMPONENTS = new Set([
  'alarm_control_panel', 'binary_sensor', 'button', 'camera', 'climate', 'cover', 'device', 'device_automation', 'device_tracker', 'event', 'fan',
  'humidifier', 'image', 'lawn_mower', 'light', 'lock', 'notify', 'number', 'scene', 'select', 'sensor', 'siren', 'switch', 'tag', 'text', 'update',
  'vacuum', 'valve', 'water_heater'
]);
const MAX_REMEMBERED = 2000; // state payloads kept for configs that arrive after their state
const MAX_REMEMBERED_BYTES = 8 * 1024;
// Components that have no state side worth reading.
const NO_STATE = new Set(['button', 'scene', 'notify', 'device_automation', 'tag', 'camera', 'image']);

function expandKeys(obj, table) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[Object.hasOwn(table, k) ? table[k] : k] = v;
  }
  return out;
}

/** Expand a discovery config: abbreviations, nested device/origin/availability, "~" base. */
function expandConfig(raw) {
  const c = expandKeys(raw, ABBREV);
  if (c.device) c.device = expandKeys(c.device, DEVICE_ABBREV);
  if (c.origin) c.origin = expandKeys(c.origin, ORIGIN_ABBREV);
  if (Array.isArray(c.availability)) c.availability = c.availability.slice(0, 10).map((a) => expandKeys(a, AVTY_ABBREV));
  const base = typeof c['~'] === 'string' ? c['~'] : null;
  if (base !== null) {
    const fix = (v) => (typeof v === 'string' ? (v.startsWith('~') ? base + v.slice(1) : v.endsWith('~') ? v.slice(0, -1) + base : v) : v);
    for (const k of Object.keys(c)) if (k.endsWith('_topic') || k === 'topic') c[k] = fix(c[k]);
    if (Array.isArray(c.availability)) for (const a of c.availability) if (a && typeof a === 'object') a.topic = fix(a.topic);
  }
  return c;
}

/** The state-side topics of an entity: [{ suffix, topic, template }]. */
function stateTopics(component, c) {
  const out = [];
  if (NO_STATE.has(component)) return out;
  for (const k of Object.keys(c)) {
    if (typeof c[k] !== 'string' || !c[k]) continue;
    if (k === 'state_topic') out.push({ suffix: null, topic: c[k], template: c.value_template ?? c.state_value_template ?? c.state_template });
    else if (/_state_topic$|^current_.*_topic$|_status_topic$|^position_topic$|^latest_version_topic$/.test(k)) {
      const base = k.replace(/_topic$/, '');
      out.push({ suffix: base.replace(/_state$/, ''), topic: c[k], template: c[`${base}_template`] ?? c[`${base.replace(/_state$/, '')}_value_template`] ?? c[`${base}_value_template`] });
    }
  }
  return out.slice(0, 20);
}

/** Read one state payload into a value: { v, q, reason }. */
function readState(spec, msg) {
  const raw = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
  const json = msg.payloadFormat === 'json' ? msg.payload : undefined;
  let v;
  if (spec.compiled) {
    if (!spec.compiled.supported) return { v: capValue(raw), q: UNCERTAIN, reason: `template not supported (${spec.compiled.reason}); raw payload shown` };
    const r = tpl.evaluate(spec.compiled, raw, json);
    if (!r.ok) return { v: null, q: r.missing ? UNCERTAIN : BAD, reason: `value template: ${r.reason}` };
    v = r.v;
  } else v = json !== undefined && (json === null || typeof json !== 'object') ? json : raw;
  if (spec.component === 'binary_sensor') {
    const on = spec.payloadOn ?? 'ON';
    const off = spec.payloadOff ?? 'OFF';
    if (String(v) === String(on)) return { v: true, q: GOOD };
    if (String(v) === String(off)) return { v: false, q: GOOD };
    return { v: capValue(v), q: UNCERTAIN, reason: 'neither payload_on nor payload_off' };
  }
  if (spec.numeric && typeof v === 'string') {
    if (v === '' || v === 'unknown' || v === 'unavailable' || v === 'None') return { v: null, q: UNCERTAIN, reason: `state "${v}"` };
    const n = num(v);
    if (n !== undefined) v = n;
  }
  return { v: capValue(v), q: GOOD };
}

function create(opts, reg) {
  const prefix = opts.prefix;
  const prefixParts = prefix.split('/');
  const entities = new Map(); // discovery key -> { deviceId, tagKeys: [], topics: [], avty }
  const byTopic = new Map(); // state topic -> [{ entityKey, tagKey, spec }]
  const avtyByTopic = new Map(); // availability topic -> Set(entityKey)
  const avtyState = new Map(); // topic -> { v: raw payload, at }
  const deviceEntities = new Map(); // device id -> Set(entity key)
  const deviceTags = new Map(); // device id -> Map(tagKey -> def)

  const index = (map, k, v) => {
    let s = map.get(k);
    if (!s) map.set(k, (s = []));
    s.push(v);
  };

  function deviceAvail(deviceId) {
    // A device is offline when any entity's availability says so (entities share a device's link).
    let anyKnown = false;
    for (const ek of deviceEntities.get(deviceId) || []) {
      const e = entities.get(ek);
      if (!e?.avty) continue;
      const st = entityAvail(e.avty);
      if (st === 'offline') return { state: 'offline', reason: 'availability topic reports offline' };
      if (st === 'online') anyKnown = true;
    }
    return anyKnown ? { state: 'online', reason: 'availability topic' } : { state: 'unknown', reason: 'no availability reported' };
  }

  function entityAvail(avty) {
    const states = avty.list.map((a) => {
      const s = avtyState.get(a.topic);
      if (!s) return { st: 'unknown', at: 0 };
      let v = s.raw;
      if (a.compiled?.supported) {
        const r = tpl.evaluate(a.compiled, s.raw, s.json);
        v = r.ok ? String(r.v) : null;
      }
      const st = v === String(a.on) ? 'online' : v === String(a.off) ? 'offline' : 'unknown';
      return { st, at: s.at };
    });
    if (avty.mode === 'all') return states.every((s) => s.st === 'online') ? 'online' : states.some((s) => s.st === 'offline') ? 'offline' : 'unknown';
    if (avty.mode === 'any') return states.some((s) => s.st === 'online') ? 'online' : states.every((s) => s.st === 'offline') ? 'offline' : 'unknown';
    const known = states.filter((s) => s.st !== 'unknown').sort((a, b) => b.at - a.at);
    return known[0]?.st || 'unknown';
  }

  function removeEntity(key) {
    const e = entities.get(key);
    if (!e) return;
    entities.delete(key);
    for (const topic of e.topics) {
      const list = (byTopic.get(topic) || []).filter((x) => x.entityKey !== key);
      if (list.length) byTopic.set(topic, list);
      else byTopic.delete(topic);
    }
    for (const a of e.avty?.list || []) avtyByTopic.get(a.topic)?.delete(key);
    const set = deviceEntities.get(e.deviceId);
    set?.delete(key);
    const tags = deviceTags.get(e.deviceId);
    for (const tk of e.tagKeys) tags?.delete(tk);
    if (!set || !set.size) {
      deviceEntities.delete(e.deviceId);
      deviceTags.delete(e.deviceId);
      reg.removeDevice(e.deviceId);
    } else {
      reg.upsertDevice({ id: e.deviceId, tags: [...tags.values()] });
      const a = deviceAvail(e.deviceId);
      reg.setAvailability(e.deviceId, a.state, a.reason);
    }
  }

  function addEntity(key, component, objectId, c, shared = {}) {
    removeEntity(key);
    const merged = { ...shared, ...c };
    const dev = merged.device && typeof merged.device === 'object' ? merged.device : null;
    const ident = Array.isArray(dev?.identifiers) ? dev.identifiers[0] : typeof dev?.identifiers === 'string' ? dev.identifiers : Array.isArray(dev?.connections?.[0]) ? dev.connections[0].join(':') : null;
    const uniq = text(merged.unique_id, 200);
    const deviceId = ident !== null && ident !== undefined ? `ha:${idPart(ident)}` : `ha:entity:${idPart(uniq || key)}`;
    const entName = text(merged.name) ?? (merged.name === null ? text(dev?.name) : null) ?? objectId;
    const tagBase = uniq || key;
    const topics = stateTopics(component, merged);
    const tags = deviceTags.get(deviceId) || new Map();
    const tagKeys = [];
    const unit = text(merged.unit_of_measurement, 40);
    for (const st of topics) {
      const tagKey = st.suffix ? `${tagBase}#${st.suffix}` : tagBase;
      const compiled = st.template !== undefined && st.template !== null ? tpl.compile(st.template) : null;
      const numeric = component === 'sensor' && !st.suffix ? Boolean(unit || merged.state_class || num(merged.suggested_display_precision) !== undefined) : /temperature|humidity|position|percentage|brightness/.test(st.suffix || '');
      const def = {
        key: tagKey,
        name: st.suffix ? `${entName} ${st.suffix.replace(/_/g, ' ')}` : entName,
        type: component === 'binary_sensor' && !st.suffix ? 'bool' : numeric ? 'float64' : 'string',
        unit: !st.suffix ? unit : /temperature/.test(st.suffix) ? text(merged.temperature_unit, 10) : undefined,
        deviceClass: text(merged.device_class, 60),
        stateClass: text(merged.state_class, 60),
        diagnostic: merged.entity_category === 'diagnostic',
        description: `${component}${merged.device_class ? ` (${text(merged.device_class, 60)})` : ''}`,
        topic: st.topic,
        selector: st.template ? String(st.template).slice(0, 200) : '(payload)',
        unsupported: compiled && !compiled.supported ? `template not supported: ${compiled.reason}` : undefined
      };
      const lo = num(merged.min);
      const hi = num(merged.max);
      if (lo !== undefined && hi !== undefined && lo <= hi && !st.suffix) def.range = { min: lo, max: hi };
      if (Array.isArray(merged.options)) def.enum = merged.options.slice(0, 100).map((x) => text(x, 100)).filter(Boolean);
      if (tags.size >= LIMITS.maxTagsPerDevice) break;
      tags.set(tagKey, def);
      tagKeys.push(tagKey);
      const spec = { component: st.suffix ? 'state' : component, compiled, numeric, payloadOn: merged.payload_on, payloadOff: merged.payload_off };
      index(byTopic, st.topic, { entityKey: key, tagKey, spec, deviceId });
    }
    if (typeof merged.json_attributes_topic === 'string' && merged.json_attributes_topic && tags.size < LIMITS.maxTagsPerDevice) {
      const tagKey = `${tagBase}#attributes`;
      const compiled = merged.json_attributes_template ? tpl.compile(merged.json_attributes_template) : null;
      tags.set(tagKey, { key: tagKey, name: `${entName} attributes`, type: 'json', description: 'JSON attributes', topic: merged.json_attributes_topic, selector: '(attributes)', unsupported: compiled && !compiled.supported ? `template not supported: ${compiled.reason}` : undefined });
      tagKeys.push(tagKey);
      index(byTopic, merged.json_attributes_topic, { entityKey: key, tagKey, spec: { component: 'attributes', compiled }, deviceId });
    }
    // Availability: single topic, or a list with a mode (latest is the default).
    let avty = null;
    const list = [];
    if (typeof merged.availability_topic === 'string') {
      list.push({ topic: merged.availability_topic, on: merged.payload_available ?? 'online', off: merged.payload_not_available ?? 'offline', compiled: merged.availability_template ? tpl.compile(merged.availability_template) : null });
    }
    if (Array.isArray(merged.availability)) {
      for (const a of merged.availability) {
        if (!a || typeof a.topic !== 'string') continue;
        list.push({ topic: a.topic, on: a.payload_available ?? 'online', off: a.payload_not_available ?? 'offline', compiled: a.value_template ? tpl.compile(a.value_template) : null });
      }
    }
    if (list.length) {
      avty = { mode: ['all', 'any', 'latest'].includes(merged.availability_mode) ? merged.availability_mode : 'latest', list };
      for (const a of list) {
        let s = avtyByTopic.get(a.topic);
        if (!s) avtyByTopic.set(a.topic, (s = new Set()));
        s.add(key);
      }
    }
    const known = reg.get(deviceId); // entities after the first often repeat only the identifiers
    const ok = reg.upsertDevice({
      id: deviceId,
      convention: 'homeassistant',
      stableId: ident ?? uniq ?? key,
      name: text(dev?.name) || known?.name || entName,
      manufacturer: text(dev?.manufacturer) || known?.manufacturer || null,
      model: text(dev?.model) || text(dev?.model_id) || known?.model || null,
      description: dev?.sw_version ? `firmware ${text(dev.sw_version, 60)}` : known?.description || null,
      details: { identifiers: Array.isArray(dev?.identifiers) ? dev.identifiers.slice(0, 5).map((x) => text(x)) : ident ? [text(ident)] : [], viaDevice: text(dev?.via_device), area: text(dev?.suggested_area), origin: text(merged.origin?.name) },
      tags: [...tags.values()]
    });
    if (!ok) {
      for (const topic of new Set(topics.map((t) => t.topic))) byTopic.set(topic, (byTopic.get(topic) || []).filter((x) => x.entityKey !== key));
      return;
    }
    deviceTags.set(deviceId, tags);
    let set = deviceEntities.get(deviceId);
    if (!set) deviceEntities.set(deviceId, (set = new Set()));
    set.add(key);
    entities.set(key, { deviceId, tagKeys, topics: [...new Set([...topics.map((t) => t.topic), ...(merged.json_attributes_topic ? [merged.json_attributes_topic] : [])])], avty });
    const a = deviceAvail(deviceId);
    reg.setAvailability(deviceId, a.state, a.reason);
    // Values already seen on the state topics (retained ones can arrive before the config).
    for (const topic of entities.get(key).topics) {
      const last = lastState.get(topic);
      if (last) onState(last, key);
    }
  }

  const lastState = new Map(); // state topic -> last message (bounded) for configs that arrive later
  function onState(msg, onlyEntity = null) {
    for (const h of byTopic.get(msg.topic) || []) {
      if (onlyEntity && h.entityKey !== onlyEntity) continue;
      if (h.spec.component === 'attributes') {
        let v = msg.payloadFormat === 'json' ? msg.payload : null;
        if (h.spec.compiled?.supported) {
          const r = tpl.evaluate(h.spec.compiled, typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload), msg.payloadFormat === 'json' ? msg.payload : undefined);
          v = r.ok ? r.v : null;
        }
        reg.setValue(h.deviceId, h.tagKey, v && typeof v === 'object' ? { v: capValue(v), q: GOOD } : { v: null, q: UNCERTAIN, reason: 'attributes payload is not a JSON object' });
      } else reg.setValue(h.deviceId, h.tagKey, readState(h.spec, msg));
      reg.touch(h.deviceId, msg);
    }
  }

  function onConfig(parts, msg) {
    const component = parts[0];
    const node = parts.length === 4 ? parts[1] : null;
    const objectId = parts[parts.length - 2];
    const key = `${component}/${node ? `${node}/` : ''}${objectId}`;
    if (msg.payload === '' || msg.payload === null) {
      if (component === 'device') for (const k of [...entities.keys()]) if (k.startsWith(`${key}::`)) removeEntity(k);
      removeEntity(key);
      return;
    }
    if (msg.payloadFormat !== 'json' || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) return;
    const c = expandConfig(msg.payload);
    if (component === 'device') {
      // Device-based discovery: shared options at the top, one entry per component in `cmps`.
      const cmps = c.components && typeof c.components === 'object' ? c.components : {};
      const { components: _x, ...shared } = c;
      const seen = new Set();
      for (const [cid, raw] of Object.entries(cmps).slice(0, LIMITS.maxTagsPerDevice)) {
        const comp = expandConfig(raw);
        const platform = comp.platform;
        if (!COMPONENTS.has(platform) || platform === 'device') continue;
        const ek = `${key}::${cid}`;
        // A component reduced to { platform } is a removal.
        if (Object.keys(comp).length === 1) {
          removeEntity(ek);
          continue;
        }
        seen.add(ek);
        addEntity(ek, platform, cid, { ...comp, unique_id: comp.unique_id ?? `${objectId}_${cid}` }, expandConfig(shared));
      }
      for (const k of [...entities.keys()]) if (k.startsWith(`${key}::`) && !seen.has(k) && !Object.hasOwn(cmps, k.slice(key.length + 2))) removeEntity(k);
      return;
    }
    addEntity(key, component, objectId, c);
  }

  return {
    onMessage(msg) {
      const parts = msg.topicParts;
      let isPrefix = true;
      for (let i = 0; i < prefixParts.length; i++) if (parts[i] !== prefixParts[i]) isPrefix = false;
      if (isPrefix) {
        const rest = parts.slice(prefixParts.length);
        if ((rest.length === 3 || rest.length === 4) && rest[rest.length - 1] === 'config' && COMPONENTS.has(rest[0])) {
          onConfig(rest, msg);
          return;
        }
      }
      const avKeys = avtyByTopic.get(msg.topic);
      if (avKeys?.size) {
        avtyState.set(msg.topic, { raw: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload), json: msg.payloadFormat === 'json' ? msg.payload : undefined, at: Date.now() });
        const devs = new Set([...avKeys].map((k) => entities.get(k)?.deviceId).filter(Boolean));
        for (const d of devs) {
          const a = deviceAvail(d);
          reg.setAvailability(d, a.state, a.reason);
        }
      }
      if (avKeys?.size === 0) avtyByTopic.delete(msg.topic);
      const known = byTopic.has(msg.topic);
      if (known) onState(msg);
      // Remember a little of every small payload: retained state often arrives before its config.
      if (msg.payload === '') lastState.delete(msg.topic);
      else if (!isPrefix && (msg.size || 0) <= MAX_REMEMBERED_BYTES && (known || lastState.has(msg.topic) || lastState.size < MAX_REMEMBERED)) lastState.set(msg.topic, msg);
    },
    close() {
      lastState.clear();
    }
  };
}

function normalize(opts = {}) {
  const prefix = typeof opts.prefix === 'string' && opts.prefix.trim() ? opts.prefix.trim().replace(/\/+$/, '') : 'homeassistant';
  if (/[+#]/.test(prefix) || prefix.length > 200) throw new Error('homeassistant.prefix must be a plain topic prefix without wildcards');
  return { prefix };
}

module.exports = {
  id: 'homeassistant',
  label: 'Home Assistant MQTT discovery',
  normalize,
  // State topics can be anywhere: the broker intake (usually "#") must cover them; the prefix is
  // subscribed explicitly so discovery works with a narrower intake filter.
  filters: (o) => [`${o.prefix}/#`],
  wantsAllTopics: true,
  detect(parts, msg) {
    const n = parts.length;
    if (n < 4 || parts[n - 1] !== 'config' || msg.payloadFormat !== 'json' || !msg.payload || typeof msg.payload !== 'object') return null;
    if (!['name', 'stat_t', 'state_topic', 'uniq_id', 'unique_id', 'dev', 'device', 'cmps', 'components'].some((k) => Object.hasOwn(msg.payload, k))) return null;
    for (const k of [n - 3, n - 4]) {
      if (k >= 1 && COMPONENTS.has(parts[k]) && (k === n - 3 || k === n - 4)) return { prefix: parts.slice(0, k).join('/') };
    }
    return null;
  },
  create,
  expandConfig,
  stateTopics,
  readState
};
