const { test } = require('node:test');
const assert = require('node:assert');

const { IotRegistry } = require('../services/iot/registry');
const tpl = require('../services/iot/template');
const limits = require('../services/iot/limits');
const z2m = require('../services/iot/conventions/zigbee2mqtt');
const zw = require('../services/iot/conventions/zwavejs');
const ha = require('../services/iot/conventions/homeassistant');
const tasmota = require('../services/iot/conventions/tasmota');
const shelly = require('../services/iot/conventions/shelly');
const { chirpstack, ttn } = require('../services/iot/conventions/lorawan');

// Parsers of each IoT-over-MQTT convention against the documented example payloads, driven
// without a broker: messages are shaped like MqttManager's tapped messages.

/** A tapped message like MqttManager.buildMessage + topicParts would produce. */
function m(topic, payload, { retain = false, size } = {}) {
  let p = payload;
  let fmt = 'text';
  if (typeof payload === 'string') {
    try {
      if (/^\s*[[{"\d-tfn]/.test(payload)) {
        p = JSON.parse(payload);
        fmt = 'json';
      }
    } catch {
      p = payload;
    }
  } else fmt = 'json';
  return { brokerId: 'b1', topic, topicParts: topic.split('/'), payload: p, payloadFormat: fmt, retain, timestamp: new Date().toISOString(), size: size ?? JSON.stringify(payload ?? '').length };
}

function harness(conv, opts = {}) {
  const samples = [];
  const states = [];
  const reg = new IotRegistry('b1', { onSample: (_b, dev, tag) => samples.push({ dev: dev.id, key: tag.key, v: tag.value, q: tag.q, reason: tag.reason, t: tag.t }), onState: (_b, dev) => states.push({ dev: dev.id, state: dev.availability }) });
  const h = conv.create(conv.normalize(opts), reg);
  const send = (...a) => h.onMessage(m(...a));
  const tag = (dev, key) => reg.get(dev)?.tags.get(key);
  return { reg, h, send, samples, states, tag };
}

// ---- template evaluator ------------------------------------------------------------------

test('template: the supported subset evaluates; everything else is refused, never executed', () => {
  const ev = (t, raw, json) => tpl.evaluate(tpl.compile(t), raw, json);
  assert.deepStrictEqual(ev('{{ value_json.a.b }}', '', { a: { b: 7 } }), { ok: true, v: 7 });
  assert.deepStrictEqual(ev("{{ value_json['a']['b c'] }}", '', { a: { 'b c': 'x' } }), { ok: true, v: 'x' });
  assert.deepStrictEqual(ev('{{ value_json.list[1] }}', '', { list: [5, 6] }), { ok: true, v: 6 });
  assert.deepStrictEqual(ev('{{ value | float }}', '21.5'), { ok: true, v: 21.5 });
  assert.deepStrictEqual(ev('{{ value | int }}', '21.9'), { ok: true, v: 21 });
  assert.deepStrictEqual(ev('{{ (value_json.p / 1000) | round(2) }}', '', { p: 1234567 }), { ok: true, v: 1234.57 });
  assert.deepStrictEqual(ev('{{ value_json.t * 9 / 5 + 32 }}', '', { t: 100 }), { ok: true, v: 212 });
  assert.deepStrictEqual(ev('{{ -value_json.t + 1 }}', '', { t: 2 }), { ok: true, v: -1 });
  assert.deepStrictEqual(ev('{{ value_json.x | float(0) }}', '', { x: 'n/a' }), { ok: true, v: 0 });
  assert.deepStrictEqual(ev('{{ 7 // 2 }}{{', ''), { ok: false, missing: false, reason: 'template not supported' });
  // missing attribute -> missing (uncertain), bad conversion -> error
  assert.strictEqual(ev('{{ value_json.nope }}', '', { a: 1 }).missing, true);
  assert.strictEqual(ev('{{ value_json.a | float }}', '', { a: 'abc' }).ok, false);
  assert.strictEqual(ev('{{ value_json.a / 0 }}', '', { a: 1 }).ok, false);
  assert.strictEqual(ev('{{ value_json.a }}', 'plain', undefined).reason, 'payload is not JSON');
  for (const bad of [
    '{% if value_json.x %}on{% endif %}',
    "{{ value_json.x if value_json.x else 'off' }}",
    '{{ states("sensor.x") }}',
    '{{ value_json.x | lower }}',
    "{{ ''.__class__.__mro__[1].__subclasses__() }}",
    '{{ value_json.x is defined }}',
    '{{ now() }}',
    'just text',
    '{{ value_json.__proto__ }}x{{ 1 }}'
  ]) {
    assert.strictEqual(tpl.compile(bad).supported, false, bad);
  }
  // __proto__ is read as an own property only
  assert.strictEqual(ev('{{ value_json.__proto__ }}', '', JSON.parse('{"a":1}')).missing, true);
  assert.strictEqual(tpl.compile('{{ ' + '('.repeat(50) + '1' + ')'.repeat(50) + ' }}').supported, false);
});

test('limits: depth check is iterative and bounded; source times need a zone', () => {
  let deep = {};
  for (let i = 0; i < 100_000; i++) deep = { a: deep };
  assert.strictEqual(limits.jsonDepth(deep), limits.LIMITS.maxJsonDepth + 1);
  assert.strictEqual(limits.jsonDepth({ a: [{ b: 1 }] }), 3);
  assert.strictEqual(limits.sourceTime('2026-11-25T10:00:00'), undefined); // local time, no zone
  assert.strictEqual(limits.sourceTime('2026-11-25T10:00:00Z'), Date.parse('2026-11-25T10:00:00Z'));
  assert.strictEqual(limits.sourceTime(1764064800), 1764064800000); // seconds
  assert.strictEqual(limits.sourceTime(5), undefined);
  assert.strictEqual(limits.base64ToHex('AQID'), '010203');
  assert.strictEqual(limits.capValue('x'.repeat(10_000)).length, limits.LIMITS.maxStringValue);
});

// ---- Zigbee2MQTT -------------------------------------------------------------------------

const LIGHT = {
  ieee_address: '0x0017880104e45521',
  friendly_name: 'hall/bulb',
  type: 'Router',
  definition: {
    model: '9290022166', vendor: 'Philips', description: 'Hue bulb',
    exposes: [
      { type: 'light', features: [
        { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' },
        { type: 'numeric', name: 'brightness', property: 'brightness', access: 7, value_min: 0, value_max: 254 },
        { type: 'composite', name: 'color_xy', property: 'color', access: 7, features: [{ type: 'numeric', name: 'x', property: 'x', access: 7 }, { type: 'numeric', name: 'y', property: 'y', access: 7 }] }
      ] },
      { type: 'enum', name: 'effect', property: 'effect', access: 2, values: ['blink'] },
      { type: 'enum', name: 'power_on_behavior', property: 'power_on_behavior', access: 7, values: ['off', 'on'] },
      { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1, unit: 'lqi', category: 'diagnostic' },
      { type: 'list', name: 'schedule', property: 'schedule', access: 3, item_type: { type: 'numeric' } }
    ]
  }
};

test('zigbee2mqtt: exposes walk (specific, composite, access bits, enums, ranges, lists)', () => {
  const tags = z2m.exposeTags(LIGHT.definition.exposes);
  assert.deepStrictEqual(tags.map((t) => t.key), ['state', 'brightness', 'color.x', 'color.y', 'power_on_behavior', 'linkquality', 'schedule']);
  const by = Object.fromEntries(tags.map((t) => [t.key, t]));
  assert.strictEqual(by.state.type, 'bool');
  assert.deepStrictEqual(by.brightness.range, { min: 0, max: 254 });
  assert.deepStrictEqual(by['color.x'].path, ['color', 'x']);
  assert.deepStrictEqual(by.power_on_behavior.enum, ['off', 'on']);
  assert.strictEqual(by.linkquality.diagnostic, true);
  assert.strictEqual(by.schedule.type, 'json');
  assert.ok(!by.effect, 'set-only property (access 2) is not a published state');
});

test('zigbee2mqtt: device list, state, renames keep identity, availability forms, groups, removal', () => {
  const { send, reg, tag, samples } = harness(z2m);
  // state before the device list (retained order is not guaranteed) is replayed
  send('zigbee2mqtt/hall/bulb', { state: 'ON', brightness: 120, color: { x: 0.3, y: 0.4 }, linkquality: 90, last_seen: '2026-11-25T10:00:00Z' });
  send('zigbee2mqtt/bridge/state', 'online'); // legacy string form
  send('zigbee2mqtt/bridge/devices', [{ ieee_address: '0x00124b0000000000', type: 'Coordinator', friendly_name: 'Coordinator' }, LIGHT], { retain: true });
  const id = 'z2m:0x0017880104e45521';
  const d = reg.get(id);
  assert.ok(d, 'device registered by IEEE address');
  assert.strictEqual(reg.devices.size, 1, 'coordinator is not a device');
  assert.deepStrictEqual([d.name, d.manufacturer, d.model], ['hall/bulb', 'Philips', '9290022166']);
  assert.strictEqual(tag(id, 'state').value, true);
  assert.strictEqual(tag(id, 'color.y').value, 0.4);
  assert.strictEqual(tag(id, 'brightness').t, Date.parse('2026-11-25T10:00:00Z'));
  assert.strictEqual(tag(id, 'power_on_behavior').q, limits.UNCERTAIN, 'missing attribute -> uncertain');
  assert.strictEqual(d.availability, 'online', 'bridge online, no own availability');
  // JSON availability
  send('zigbee2mqtt/hall/bulb/availability', { state: 'offline' });
  assert.strictEqual(reg.get(id).availability, 'offline');
  send('zigbee2mqtt/hall/bulb/availability', 'online');
  assert.strictEqual(reg.get(id).availability, 'online');
  // a /set topic is never read
  const before = samples.length;
  send('zigbee2mqtt/hall/bulb/set', { state: 'OFF' });
  send('zigbee2mqtt/hall/bulb/set/brightness', 3);
  assert.strictEqual(samples.length, before);
  // rename: same IEEE -> same device id; the new topic is read, the old one no longer
  send('zigbee2mqtt/bridge/devices', [{ ...LIGHT, friendly_name: 'kitchen/bulb' }]);
  assert.strictEqual(reg.get(id).name, 'kitchen/bulb');
  send('zigbee2mqtt/kitchen/bulb', { state: 'OFF', brightness: 10, color: { x: 0.1, y: 0.2 }, power_on_behavior: 'on' });
  assert.strictEqual(tag(id, 'state').value, false);
  send('zigbee2mqtt/hall/bulb', { state: 'ON', brightness: 99 });
  assert.strictEqual(tag(id, 'brightness').value, 10);
  // bridge offline makes every device offline
  send('zigbee2mqtt/bridge/state', { state: 'offline' });
  assert.strictEqual(reg.get(id).availability, 'offline');
  send('zigbee2mqtt/bridge/state', { state: 'online' });
  // groups
  send('zigbee2mqtt/bridge/groups', [{ id: 3, friendly_name: 'kitchen_lights', members: [{ ieee_address: LIGHT.ieee_address, endpoint: 11 }] }]);
  const g = reg.get('z2m:group:3');
  assert.deepStrictEqual([...g.tags.keys()].sort(), ['brightness', 'state']);
  send('zigbee2mqtt/kitchen_lights', { state: 'ON', brightness: 254 });
  assert.strictEqual(tag('z2m:group:3', 'brightness').value, 254);
  // device left the network
  send('zigbee2mqtt/bridge/devices', []);
  assert.strictEqual(reg.get(id), null);
});

test('zigbee2mqtt: custom base topic, unsupported device builds tags from what it publishes, detect()', () => {
  const { send, reg, tag } = harness(z2m, { baseTopic: 'home/zb' });
  send('home/zb/bridge/devices', [{ ieee_address: '0x01', friendly_name: 'odd', type: 'EndDevice', definition: null }]);
  send('home/zb/odd', { co2: 410, nested: { x: 1 }, last_seen: 1764064800000 });
  assert.strictEqual(tag('z2m:0x01', 'co2').value, 410);
  assert.ok(!reg.get('z2m:0x01').tags.has('nested'));
  assert.deepStrictEqual(z2m.detect('home/zb/bridge/devices'.split('/'), m('home/zb/bridge/devices', [], { retain: true })), { baseTopic: 'home/zb' });
  assert.strictEqual(z2m.detect('a/bridge/devices'.split('/'), m('a/bridge/devices', { not: 'a list' })), null);
  assert.throws(() => z2m.normalize({ baseTopic: 'a/#' }), /wildcards/);
});

// ---- Z-Wave JS UI ------------------------------------------------------------------------

test('zwavejs: layouts and payload forms, node status, nodeinfo, gateway state', () => {
  const { send, reg, tag } = harness(zw);
  send('zwave/_CLIENTS/ZWAVE_GATEWAY-main/status', { value: true, time: Date.now() });
  // valueid layout, entire value object: metadata from the gateway
  send('zwave/5/49/0/Air_temperature', { id: '5-49-0-Air temperature', nodeId: 5, commandClass: 49, commandClassName: 'Multilevel Sensor', endpoint: 0, property: 'Air temperature', type: 'number', readable: true, label: 'Air temperature', unit: '°C', min: -40, max: 85, value: 20.8, lastUpdate: 1764064800000 });
  const t = tag('zwave:5', '49-0-Air temperature');
  assert.deepStrictEqual([t.name, t.unit, t.type, t.value, t.t], ['Air temperature', '°C', 'float64', 20.8, 1764064800000]);
  assert.deepStrictEqual(t.range, { min: -40, max: 85 });
  send('zwave/5/113/0/Home_Security/Motion', { nodeId: 5, commandClass: 113, endpoint: 0, property: 'Home Security', propertyKey: 'Motion sensor status', type: 'number', readable: true, label: 'Motion', states: { 0: 'idle', 8: 'Motion detection' }, value: 8 });
  assert.deepStrictEqual(tag('zwave:5', '113-0-Home Security-Motion sensor status').enum, ['0 = idle', '8 = Motion detection']);
  send('zwave/5/nodeinfo', { id: 5, name: 'Multisensor', loc: 'Hall', manufacturer: 'Aeotec Ltd.', productLabel: 'ZW100' });
  assert.deepStrictEqual([reg.get('zwave:5').name, reg.get('zwave:5').manufacturer, reg.get('zwave:5').model], ['Multisensor', 'Aeotec Ltd.', 'ZW100']);
  send('zwave/5/status', { value: false, status: 'Dead', time: Date.now() });
  assert.strictEqual(reg.get('zwave:5').availability, 'offline');
  send('zwave/5/status', { value: true, status: 'Asleep' });
  assert.strictEqual(reg.get('zwave:5').availability, 'online');
  // named layout with a location level, time-value payload
  send('zwave/Kitchen/Door/notification/endpoint_0/Access_Control/Door_state', { time: 1764064800000, value: 23 });
  const named = reg.get('zwave:topic:Kitchen/Door');
  assert.ok(named);
  assert.strictEqual(named.tags.get('notification/endpoint_0/Access_Control/Door_state').value, 23);
  // just value; nodeID_ form gives a node id
  send('zwave/nodeID_7/37/0/currentValue', true);
  assert.strictEqual(tag('zwave:7', '37/0/currentValue').value, true);
  // writes and the gateway API are never read
  send('zwave/7/37/0/targetValue/set', true);
  assert.ok(!reg.get('zwave:7').tags.has('37/0/targetValue'));
  // gateway offline -> nodes offline
  send('zwave/_CLIENTS/ZWAVE_GATEWAY-main/status', false);
  assert.strictEqual(reg.get('zwave:7').availability, 'offline');
  assert.strictEqual(zw.ccIndex(['5', 'status']), -1);
  assert.deepStrictEqual(zw.detect('zwave/_CLIENTS/ZWAVE_GATEWAY-x/status'.split('/'), { retain: true }), { prefix: 'zwave' });
});

// ---- Home Assistant discovery ------------------------------------------------------------

test('homeassistant: abbreviations, ~ expansion, device grouping, templates, units, availability modes', () => {
  const { send, reg, tag } = harness(ha);
  // state before config: remembered and applied once the config arrives
  send('esp/climate', { temperature: 20.25, humidity: '55.5', mw: 1500 });
  send('homeassistant/sensor/esp/t/config', { '~': 'esp', name: 'Temperature', stat_t: '~/climate', val_tpl: '{{ value_json.temperature }}', unit_of_meas: '°C', dev_cla: 'temperature', stat_cla: 'measurement', uniq_id: 'esp_t', avty_t: '~/status', dev: { ids: ['esp01'], name: 'ESP climate', mf: 'Espressif', mdl: 'ESP32' } }, { retain: true });
  send('homeassistant/sensor/esp/h/config', { name: 'Humidity', state_topic: 'esp/climate', value_template: '{{ value_json.humidity | float }}', unit_of_measurement: '%', unique_id: 'esp_h', device: { identifiers: ['esp01'] } });
  send('homeassistant/sensor/esp/p/config', { name: 'Power', state_topic: 'esp/climate', value_template: '{{ (value_json.mw / 1000) | round(1) }}', unit_of_measurement: 'kW', unique_id: 'esp_p', device: { identifiers: ['esp01'] } });
  send('homeassistant/sensor/esp/odd/config', { name: 'Odd', state_topic: 'esp/climate', value_template: '{{ value_json.temperature | lower }}', unique_id: 'esp_odd', device: { identifiers: ['esp01'] } });
  const id = 'ha:esp01';
  const d = reg.get(id);
  assert.deepStrictEqual([d.name, d.manufacturer, d.model], ['ESP climate', 'Espressif', 'ESP32']);
  assert.strictEqual(d.tags.size, 4, 'entities with one device identifier group into one device');
  const t = tag(id, 'esp_t');
  assert.deepStrictEqual([t.name, t.unit, t.deviceClass, t.stateClass, t.type, t.topic, t.value], ['Temperature', '°C', 'temperature', 'measurement', 'float64', 'esp/climate', 20.25]);
  assert.strictEqual(tag(id, 'esp_h').value, 55.5);
  assert.strictEqual(tag(id, 'esp_p').value, 1.5);
  assert.match(tag(id, 'esp_odd').unsupported, /template not supported/);
  assert.match(tag(id, 'esp_odd').reason, /template not supported/);
  assert.ok(String(tag(id, 'esp_odd').value).includes('temperature'), 'raw payload still available');
  // availability (single topic, ~ expanded)
  send('esp/status', 'offline');
  assert.strictEqual(reg.get(id).availability, 'offline');
  send('esp/status', 'online');
  assert.strictEqual(reg.get(id).availability, 'online');
  // missing attribute -> uncertain
  send('esp/climate', { humidity: 50, mw: 1000 });
  assert.strictEqual(tag(id, 'esp_t').q, limits.UNCERTAIN);
  // removal by empty retained config; the last entity removes the device
  for (const e of ['t', 'h', 'p', 'odd']) send(`homeassistant/sensor/esp/${e}/config`, '');
  assert.strictEqual(reg.get(id), null);
});

test('homeassistant: binary_sensor payloads, availability list modes, attributes, state side of a switch', () => {
  const { send, reg, tag } = harness(ha);
  send('homeassistant/binary_sensor/door/config', { name: 'Door', stat_t: 'g/door', pl_on: '1', pl_off: '0', uniq_id: 'door1', json_attr_t: 'g/door/attr', avty: [{ t: 'g/a' }, { t: 'g/b', pl_avail: 'up', pl_not_avail: 'down' }], avty_mode: 'all' });
  const id = 'ha:entity:door1';
  send('g/door', '1');
  assert.strictEqual(tag(id, 'door1').value, true);
  assert.strictEqual(tag(id, 'door1').type, 'bool');
  send('g/door/attr', { battery: 90 });
  assert.deepStrictEqual(tag(id, 'door1#attributes').value, { battery: 90 });
  send('g/a', 'online');
  assert.strictEqual(reg.get(id).availability, 'unknown', 'mode all: one of two known');
  send('g/b', 'up');
  assert.strictEqual(reg.get(id).availability, 'online');
  send('g/b', 'down');
  assert.strictEqual(reg.get(id).availability, 'offline');
  // a switch: only its state side; the command topic is not a tag
  send('homeassistant/switch/h/config', { name: 'Heater', stat_t: 'g/heater', cmd_t: 'g/heater/set', uniq_id: 'heater' });
  send('g/heater', 'ON');
  const sw = reg.get('ha:entity:heater');
  assert.deepStrictEqual([...sw.tags.keys()], ['heater']);
  assert.strictEqual(tag('ha:entity:heater', 'heater').value, 'ON');
  // climate: current temperature topic and its template
  send('homeassistant/climate/tstat/config', { name: 'Thermostat', curr_temp_t: 'g/tstat', curr_temp_tpl: '{{ value_json.cur }}', mode_stat_t: 'g/tstat', mode_stat_tpl: '{{ value_json.mode }}', temp_cmd_t: 'g/tstat/set', uniq_id: 'tstat' });
  send('g/tstat', { cur: 19.5, mode: 'heat' });
  assert.strictEqual(tag('ha:entity:tstat', 'tstat#current_temperature').value, 19.5);
  assert.strictEqual(tag('ha:entity:tstat', 'tstat#mode').value, 'heat');
});

test('homeassistant: device-based discovery (cmps), component removal, prototype keys ignored', () => {
  const { send, reg, tag } = harness(ha);
  send('homeassistant/device/em01/config', { dev: { ids: 'em01', name: 'Meter', mf: 'Acme' }, o: { name: 'bridge' }, stat_t: 'acme/em01', cmps: { v: { p: 'sensor', name: 'Voltage', unit_of_meas: 'V', val_tpl: '{{ value_json.v }}', uniq_id: 'em01_v' }, e: { p: 'sensor', name: 'Energy', unit_of_meas: 'kWh', val_tpl: '{{ value_json.wh / 1000 }}', uniq_id: 'em01_e' } } });
  send('acme/em01', { v: 230.5, wh: 5000 });
  assert.strictEqual(tag('ha:em01', 'em01_v').value, 230.5);
  assert.strictEqual(tag('ha:em01', 'em01_e').value, 5);
  // a component reduced to { platform } is removed
  send('homeassistant/device/em01/config', { dev: { ids: 'em01', name: 'Meter' }, stat_t: 'acme/em01', cmps: { v: { p: 'sensor' }, e: { p: 'sensor', name: 'Energy', val_tpl: '{{ value_json.wh }}', uniq_id: 'em01_e' } } });
  assert.deepStrictEqual([...reg.get('ha:em01').tags.keys()], ['em01_e']);
  send('homeassistant/device/em01/config', '');
  assert.strictEqual(reg.get('ha:em01'), null);
  send('homeassistant/sensor/evil/x/config', '{"__proto__":{"polluted":true},"name":"x","stat_t":"evil/x","uniq_id":"evil"}');
  assert.strictEqual({}.polluted, undefined);
  assert.ok(reg.get('ha:entity:evil'));
  const c = ha.expandConfig({ '~': 'base/x', stat_t: '~/state', avty: [{ t: '~/avail' }], cmd_t: 'other/~' });
  assert.strictEqual(c.state_topic, 'base/x/state');
  assert.strictEqual(c.availability[0].topic, 'base/x/avail');
  assert.strictEqual(c.command_topic, 'other/base/x');
});

// ---- Tasmota -----------------------------------------------------------------------------

test('tasmota: discovery, LWT, nested SENSOR with units, STATE, stat POWER, missing leaf uncertain', () => {
  const { send, reg, tag } = harness(tasmota);
  send('tele/tasmota_ABCDEF/SENSOR', { Time: '2026-11-25T10:00:00', AM2301: { Temperature: 71.6, Humidity: 40 }, TempUnit: 'F' }); // before discovery
  send('tasmota/discovery/A4CF12ABCDEF/config', { dn: 'Workshop plug', md: 'Sonoff Pow R2', mac: 'A4CF12ABCDEF', t: 'tasmota_ABCDEF', sw: '13.4.0', onln: 'Online', ofln: 'Offline' }, { retain: true });
  const id = 'tasmota:A4CF12ABCDEF';
  assert.ok(reg.get(id), 'device moved to its MAC id');
  assert.strictEqual(reg.get('tasmota:topic:tasmota_ABCDEF'), null);
  assert.deepStrictEqual([reg.get(id).name, reg.get(id).model], ['Workshop plug', 'Sonoff Pow R2']);
  send('tele/tasmota_ABCDEF/LWT', 'Offline');
  assert.strictEqual(reg.get(id).availability, 'offline');
  send('tele/tasmota_ABCDEF/LWT', 'Online');
  send('tele/tasmota_ABCDEF/SENSOR', { Time: '2026-11-25T10:00:00', ENERGY: { Total: 12.3, Power: 45, Voltage: 230, Current: 0.2, Factor: 0.9 }, AM2301: { Temperature: 22.3, Humidity: 45.6 }, TempUnit: 'C' });
  assert.deepStrictEqual([tag(id, 'ENERGY.Total').unit, tag(id, 'ENERGY.Power').unit, tag(id, 'AM2301.Temperature').unit], ['kWh', 'W', '°C']);
  assert.strictEqual(tag(id, 'AM2301.Temperature').t, null, 'device-local Time is not a source timestamp');
  send('tele/tasmota_ABCDEF/SENSOR', { ENERGY: { Total: 12.4, Power: 46, Voltage: 230, Current: 0.2, Factor: 0.9 }, TempUnit: 'C' });
  assert.strictEqual(tag(id, 'AM2301.Humidity').q, limits.UNCERTAIN);
  send('tele/tasmota_ABCDEF/STATE', { UptimeSec: 3600, POWER: 'ON', Wifi: { RSSI: 80, Signal: -60 } });
  assert.strictEqual(tag(id, 'Wifi.Signal').unit, 'dBm');
  assert.strictEqual(tag(id, 'Wifi.Signal').diagnostic, true);
  send('stat/tasmota_ABCDEF/POWER', 'OFF');
  assert.strictEqual(tag(id, 'POWER').value, 'OFF');
  // commands are never read
  send('cmnd/tasmota_ABCDEF/POWER', 'ON');
  assert.strictEqual(tag(id, 'POWER').value, 'OFF');
  // custom FullTopic
  const t2 = harness(tasmota, { fullTopic: 'plant/%topic%/%prefix%/' });
  t2.send('plant/dev9/tele/SENSOR', { BME280: { Pressure: 1000, Temperature: 20 }, PressureUnit: 'hPa', TempUnit: 'C' });
  assert.strictEqual(t2.tag('tasmota:topic:dev9', 'BME280.Pressure').unit, 'hPa');
  assert.deepStrictEqual(tasmota.filters(tasmota.normalize({})), ['tele/+/#', 'stat/+/#', 'tasmota/discovery/#']);
});

// ---- Shelly ------------------------------------------------------------------------------

test('shelly: Gen1 scalar topics with units, online, announce; Gen2 status + NotifyStatus; commands ignored', () => {
  const { send, reg, tag } = harness(shelly);
  send('shellies/shellyplug-s-7AF1E2/announce', { id: 'shellyplug-s-7AF1E2', model: 'SHPLG-S', mac: 'C45BBE7AF1E2', fw_ver: '1.14.0' });
  send('shellies/shellyplug-s-7AF1E2/relay/0/power', 12.5);
  send('shellies/shellyplug-s-7AF1E2/relay/0/energy', 3456);
  send('shellies/shellyplug-s-7AF1E2/relay/0', 'on');
  send('shellies/shellyplug-s-7AF1E2/relay/0/command', 'off');
  send('shellies/shellyplug-s-7AF1E2/online', 'false');
  const g1 = 'shelly:shellyplug-s-7AF1E2';
  assert.deepStrictEqual([reg.get(g1).model, tag(g1, 'relay/0/power').unit, tag(g1, 'relay/0/energy').unit, tag(g1, 'relay/0').value], ['SHPLG-S', 'W', 'Wmin', 'on']);
  assert.strictEqual(reg.get(g1).availability, 'offline');
  assert.ok(!reg.get(g1).tags.has('relay/0/command'));
  // Gen2
  send('shellyplus1pm-a8032ab12345/status/switch:0', { id: 0, source: 'init', output: true, apower: 8.5, voltage: 230.1, aenergy: { total: 12.34, by_minute: [1, 2] }, temperature: { tC: 40.1, tF: 104.2 } });
  const g2 = 'shelly:shellyplus1pm-a8032ab12345';
  assert.deepStrictEqual([tag(g2, 'switch:0.apower').unit, tag(g2, 'switch:0.aenergy.total').unit, tag(g2, 'switch:0.temperature.tC').unit], ['W', 'Wh', '°C']);
  assert.ok(!reg.get(g2).tags.has('switch:0.aenergy.by_minute'));
  send('shellyplus1pm-a8032ab12345/events/rpc', { src: 'shellyplus1pm-a8032ab12345', method: 'NotifyStatus', params: { ts: 1764064800.25, 'switch:0': { id: 0, apower: 99 } } });
  assert.strictEqual(tag(g2, 'switch:0.apower').value, 99);
  assert.strictEqual(tag(g2, 'switch:0.apower').t, 1764064800250);
  assert.strictEqual(tag(g2, 'switch:0.voltage').value, 230.1, 'partial update keeps the rest');
  send('shellyplus1pm-a8032ab12345/online', 'false');
  assert.strictEqual(reg.get(g2).availability, 'offline');
  // an unrelated 2-level "online" topic does not invent a device
  send('printer/online', 'true');
  assert.strictEqual(reg.get('shelly:printer'), null);
  send('shellyplus1pm-a8032ab12345/rpc', { method: 'Switch.Set' });
  assert.strictEqual(reg.devices.size, 2);
});

// ---- LoRaWAN -----------------------------------------------------------------------------

test('chirpstack v4: decoded object tags, best-gateway RSSI/SNR, fCnt, status battery, raw hex fallback', () => {
  const { send, reg, tag } = harness(chirpstack);
  send('application/app1/device/0004a30b001c0530/event/up', {
    time: '2026-11-25T10:00:00Z', deviceInfo: { deviceName: 'freezer-3', devEui: '0004a30b001c0530', applicationName: 'cold', deviceProfileName: 'Elsys ERS' }, fCnt: 10, fPort: 5, data: 'AQID',
    object: { temperature: -18.5, battery: { voltage: 3.6 } }, rxInfo: [{ rssi: -97, snr: 4 }, { rssi: -83, snr: 9.5 }], txInfo: { frequency: 868100000 }
  });
  const id = 'chirpstack:0004a30b001c0530';
  assert.deepStrictEqual([reg.get(id).name, reg.get(id).model], ['freezer-3', 'Elsys ERS']);
  assert.strictEqual(tag(id, 'decoded.temperature').value, -18.5);
  assert.strictEqual(tag(id, 'decoded.battery.voltage').value, 3.6);
  assert.deepStrictEqual([tag(id, 'rssi').value, tag(id, 'snr').value, tag(id, 'fCnt').value, tag(id, 'gateways').value], [-83, 9.5, 10, 2]);
  assert.strictEqual(tag(id, 'rssi').diagnostic, true);
  assert.strictEqual(tag(id, 'decoded.temperature').t, Date.parse('2026-11-25T10:00:00Z'));
  assert.ok(!reg.get(id).tags.has('payloadHex'), 'decoded payload present: no raw tag');
  send('application/app1/device/0004a30b001c0530/event/status', { deviceInfo: { devEui: '0004a30b001c0530' }, batteryLevel: 87.5, margin: 12 });
  assert.strictEqual(tag(id, 'battery').value, 87.5);
  send('application/app1/device/a840414e01234567/event/up', { deviceInfo: { devEui: 'a840414e01234567', deviceName: 'pulse' }, data: 'AAECAwQ=', fCnt: 1 });
  assert.strictEqual(tag('chirpstack:a840414e01234567', 'payloadHex').value, '0001020304');
  // downlink topics never read
  send('application/app1/device/0004a30b001c0530/command/down', { devEui: '0004a30b001c0530', data: 'AQ==' });
  assert.strictEqual(reg.devices.size, 2);
});

test('the things stack v3: decoded_payload, rx_metadata, battery, tenant forms', () => {
  const { send, reg, tag } = harness(ttn);
  send('v3/cold@ttn/devices/eui-70b3d57ed0012345/up', {
    end_device_ids: { device_id: 'eui-70b3d57ed0012345', application_ids: { application_id: 'cold' }, dev_eui: '70B3D57ED0012345' }, received_at: '2026-11-25T10:00:01Z',
    uplink_message: { f_port: 1, f_cnt: 42, frm_payload: 'CGQB9A==', decoded_payload: { temperature_c: 4.2, door_open: false }, rx_metadata: [{ rssi: -71, snr: 8.25 }], settings: { frequency: '868500000' }, last_battery_percentage: { value: 92.1 } }
  });
  const id = 'ttn:70b3d57ed0012345';
  assert.strictEqual(tag(id, 'decoded.temperature_c').value, 4.2);
  assert.strictEqual(tag(id, 'decoded.door_open').value, false);
  assert.deepStrictEqual([tag(id, 'rssi').value, tag(id, 'fCnt').value, tag(id, 'battery').value, tag(id, 'frequency').value], [-71, 42, 92.1, 868500000]);
  send('v3/plainapp/devices/dev-1/up', { end_device_ids: { device_id: 'dev-1' }, uplink_message: { frm_payload: 'AQ==' } });
  assert.strictEqual(tag('ttn:plainapp%2Fdev-1', 'payloadHex').value, '01');
  send('v3/cold@ttn/devices/eui-70b3d57ed0012345/down/push', { downlinks: [] });
  assert.strictEqual(reg.devices.size, 2);
});

// ---- registry caps -------------------------------------------------------------------------

test('registry: device and tag caps refuse and count instead of growing without bound', () => {
  const reg = new IotRegistry('b1');
  for (let i = 0; i < limits.LIMITS.maxDevicesPerBroker + 5; i++) reg.upsertDevice({ id: `d${i}`, name: 'x', tags: [] });
  assert.strictEqual(reg.devices.size, limits.LIMITS.maxDevicesPerBroker);
  assert.strictEqual(reg.refused.devices, 5);
  const many = Array.from({ length: limits.LIMITS.maxTagsPerDevice + 10 }, (_, i) => ({ key: `t${i}` }));
  reg.upsertDevice({ id: 'd0', tags: many });
  assert.strictEqual(reg.get('d0').tags.size, limits.LIMITS.maxTagsPerDevice);
  assert.ok(reg.refused.tags >= 1);
  reg.upsertDevice({ id: 'd1', dynamicTags: true, tags: [] });
  for (let i = 0; i < limits.LIMITS.maxTagsPerDevice + 3; i++) reg.setValue('d1', `k${i}`, { v: i, q: 192 }, { name: `k${i}` });
  assert.strictEqual(reg.get('d1').tags.size, limits.LIMITS.maxTagsPerDevice);
});
