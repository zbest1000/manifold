const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { TagBindings } = require('../services/tagBindings');
const model = require('../services/bindingModel');
const cx = require('../services/bindingContext');
const SparkplugPublisher = require('../services/sparkplugPublisher');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const legacy = require('./support/mappingLegacyScenarios');
const FIXTURE = require('./fixtures/mapping-legacy.json');

// Choosing what to map (per-tag entries, selection rules, fields, metaFields)
// and adding context (overrides, transforms, states, limits, asset context,
// contextMode, Sparkplug BIRTH properties). docs/wiki/Mapping-to-the-UNS.md.

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const decoder = new SparkplugDecoder();

function memoryProfiles(data = {}) {
  const d = { devices: {}, bindings: {}, deviceProfiles: {}, historians: {}, ...data };
  return {
    data: d,
    rev: 0,
    listIn: (c) => Object.values(d[c] || {}),
    getIn: (c, id) => (d[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      d[c][id] = { ...obj, id };
      this.rev++;
      return d[c][id];
    },
    removeIn(c, id) {
      if (!d[c][id]) return false;
      delete d[c][id];
      this.rev++;
      return true;
    }
  };
}

function fakeBroker() {
  const m = new EventEmitter();
  m.all = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    m.all.push({ brokerId, topic, payload, opts });
  };
  m.values = (topic) => m.all.filter((p) => p.topic === topic && p.payload !== '').map((p) => (typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload));
  m.cleared = () => m.all.filter((p) => p.payload === '').map((p) => p.topic);
  return m;
}

function fakeDeviceSource() {
  const s = new EventEmitter();
  s.monitored = [];
  s.ensureMonitored = async (id, key) => {
    s.monitored.push(`${id}:${key}`);
  };
  s.sample = (deviceId, key, v, extra = {}) =>
    s.emit('sample', { sourceType: 'device', sourceId: deviceId, address: key, v, type: 'float32', q: 192, tRead: 1000, ...extra });
  s.batchEnd = (deviceId) => s.emit('batch-end', { sourceType: 'device', sourceId: deviceId });
  s.state = (deviceId, state) => s.emit('source-state', { sourceType: 'device', sourceId: deviceId, state, reason: state });
  return s;
}

const METER = {
  id: 'dev1',
  name: 'Meter 1',
  protocol: 'modbus-tcp',
  host: '10.0.0.5',
  pollGroups: [{ id: 'default', intervalMs: 1000 }, { id: 'slow', intervalMs: 5000 }],
  tags: [
    { key: 'temp', address: 'holding:100', type: 'float32', unit: 'degC', property: 'temperature', description: 'Supply temp', range: { min: 0, max: 200 } },
    { key: 'count', address: '40103', type: 'uint16' },
    { key: 'state', address: 'holding:7', type: 'uint16', property: 'runState', states: { 0: 'Stopped', 1: 'Running' }, pollGroup: 'slow' },
    {
      key: 'press', address: 'holding:8', type: 'int16', property: 'pressure', unit: 'bar', displayName: 'Line pressure',
      limits: { lo: 1, hi: 9 }, context: { measurementType: 'pressure', pid: 'PT-101' }
    }
  ]
};

function setup({ bindings = {}, devices = { dev1: METER }, spb = null, extra = {}, tb = {} } = {}) {
  const profiles = memoryProfiles({ devices: { ...devices }, bindings: { ...bindings }, ...extra });
  const mqtt = fakeBroker();
  const src = fakeDeviceSource();
  const t = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: spb, objectFlushMs: 10, ...tb });
  t.registerSource('device', src);
  t.start();
  return { profiles, mqtt, src, tb: t };
}

const binding = (source, target, over = {}) => ({
  id: 'b1',
  enabled: true,
  source: { type: 'device', deviceId: 'dev1', ...source },
  target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPath: 'acme/m1', ...target },
  ...over
});

// ---- backward compatibility ----------------------------------------------------------

test('legacy bindings: topics, payloads, options, _meta and Sparkplug metrics are byte-for-byte unchanged', async () => {
  const now = await legacy.runAll();
  const pick = (got, ref) => {
    if (Array.isArray(ref)) return ref.map((x, i) => pick(got?.[i], x));
    if (ref && typeof ref === 'object') return Object.fromEntries(Object.keys(ref).map((k) => [k, pick(got?.[k], ref[k])]));
    return got;
  };
  for (const [name, want] of Object.entries(FIXTURE)) {
    const got = JSON.parse(JSON.stringify(now[name]));
    for (const f of ['publishes', 'sparkplug', 'retained', 'dataTopics', 'metaDocs', 'warnings']) {
      assert.deepStrictEqual(got[f], want[f], `${name}.${f}`);
    }
    // The preview gained keys (additive); every key it had keeps its value.
    assert.deepStrictEqual(pick(got.preview, want.preview), want.preview, `${name}.preview`);
  }
});

// ---- A1 per-tag entries ---------------------------------------------------------------

test('A1: a disabled entry is kept but not monitored, published, counted, listed in _meta or retained', async () => {
  const b = binding({ tags: ['temp', { address: 'count', name: 'pieces', enabled: true }] }, { retain: true });
  const { mqtt, src, tb, profiles } = setup({ bindings: { b1: b } });
  await tick();
  src.sample('dev1', 'count', 5, { type: 'uint16' });
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/pieces').map((p) => p.v), [5]);

  // switch it off: retained value topic cleared like a rename, _meta republished without it
  mqtt.all.length = 0;
  src.monitored.length = 0;
  profiles.upsertIn('bindings', 'b1', { ...b, source: { ...b.source, tags: ['temp', { address: 'count', name: 'pieces', enabled: false }] } });
  tb.reconcile();
  await tb.syncMonitors();
  await tick();
  assert.deepStrictEqual(mqtt.cleared(), ['acme/m1/pieces']);
  assert.deepStrictEqual(Object.keys(mqtt.values('acme/m1/_meta')[0].properties), ['temperature']);
  src.sample('dev1', 'count', 6, { type: 'uint16' });
  await tick();
  assert.strictEqual(mqtt.values('acme/m1/pieces').length, 0, 'not published');
  assert.ok(!tb.monitored.has('device dev1 count'), 'not monitored');
  const prev = model.previewBinding({ ...profiles.getIn('bindings', 'b1') }, profiles);
  assert.strictEqual(prev.totalTags, 1, 'not counted');
  assert.deepStrictEqual(prev.selection.rows.find((r) => r.key === 'count'), { unitId: 'b1', key: 'count', property: null, matched: false, rule: 'disabled' });
  tb.stop();

  // a disabled entry may name a tag the device no longer has: saved, with a warning
  const draft = binding({ tags: ['temp', { address: 'gone', enabled: false }] });
  assert.ok(model.validateBinding(draft, { profiles }));
  assert.ok(model.bindingWarnings({ ...draft, id: 'x' }, profiles).some((w) => w.type === 'disabled-missing' && w.tag === 'gone'));
  assert.throws(() => model.validateBinding(binding({ tags: ['temp', { address: 'gone' }] }), { profiles }), /device has no tag\(s\): gone/);
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', enabled: 'no' }] }), { profiles }), /tag "temp"\.enabled must be a boolean/);
});

// ---- A2 selection rules --------------------------------------------------------------

test('A2: select rules (include, filters, exclude) on tags "all"; preview reports the rule; new tags are picked up', async () => {
  const b = binding({ tags: 'all', select: { include: ['*e*'], exclude: ['run*'], types: ['float32', 'int16', 'UINT16'] }, overrides: { press: { name: 'linePressure' } } });
  const { mqtt, src, tb, profiles } = setup({ bindings: { b1: b } });
  await tick();
  // temp (key) matches, count has no "e" -> include, state matches include via key but property runState is excluded, press matches
  const prev = model.previewBinding(b, profiles);
  const rows = Object.fromEntries(prev.selection.rows.map((r) => [r.key, r]));
  assert.deepStrictEqual(rows.count, { unitId: 'b1', key: 'count', property: null, matched: false, rule: 'include' });
  assert.deepStrictEqual(rows.state, { unitId: 'b1', key: 'state', property: 'runState', matched: false, rule: 'exclude', pattern: 'run*' });
  assert.strictEqual(rows.temp.matched, true);
  assert.deepStrictEqual(prev.tags.map((t) => t.name), ['temperature', 'linePressure'], 'overrides apply to rule-selected tags');
  assert.deepStrictEqual([prev.selection.matched, prev.selection.excluded], [2, 2]);

  src.sample('dev1', 'press', 4, { type: 'int16' });
  await tick();
  assert.strictEqual(mqtt.values('acme/m1/linePressure')[0].v, 4);

  // a tag added to the device later is picked up when it matches
  profiles.upsertIn('devices', 'dev1', { ...METER, tags: [...METER.tags, { key: 'level', address: 'holding:9', type: 'float32', property: 'tankLevel' }, { key: 'zz', address: 'holding:10', type: 'bool' }] });
  tb.reconcile();
  await tb.syncMonitors();
  src.sample('dev1', 'level', 77);
  src.sample('dev1', 'zz', true, { type: 'bool' });
  await tick();
  assert.strictEqual(mqtt.values('acme/m1/tankLevel')[0].v, 77);
  assert.strictEqual(mqtt.values('acme/m1/zz').length, 0, 'bool type is filtered out');
  assert.ok(tb.monitored.has('device dev1 level'));
  tb.stop();

  // pollGroups / withProperty, and enabled:false in overrides deselects a matched tag
  const sel = (select, overrides) => model.expandUnits({ id: 'x', ...binding({ tags: 'all', select, overrides }) }, profiles)[0].tags.map((t) => t.address);
  assert.deepStrictEqual(sel({ pollGroups: ['slow'] }), ['state']);
  assert.deepStrictEqual(sel({ withProperty: false }), ['count', 'zz']);
  assert.deepStrictEqual(sel({ withProperty: true }, { level: { enabled: false } }), ['temp', 'state', 'press']);
  assert.deepStrictEqual(sel({ include: ['TEMP?RATURE'] }), ['temp'], 'case-insensitive glob on the property');

  assert.throws(() => model.validateBinding(binding({ tags: ['temp'], select: { include: ['t*'] } }), { profiles }), /source\.select applies only to .* tags: "all"/);
  assert.throws(() => model.validateBinding(binding({ tags: 'all', select: { incl: ['t*'] } }), { profiles }), /source\.select\.incl is not a selection rule/);
  assert.throws(() => model.validateBinding(binding({ tags: 'all', overrides: { temp: { colour: 'red' } } }), { profiles }), /source\.overrides\["temp"\]\.colour is not an override/);
  assert.ok(model.bindingWarnings({ id: 'x', ...binding({ tags: 'all', overrides: { nope: { name: 'x' } } }) }, profiles).some((w) => w.type === 'unknown-override'));
  assert.ok(model.bindingWarnings({ id: 'x', ...binding({ tags: 'all', select: { include: ['nothing'] } }) }, profiles).some((w) => w.type === 'no-tags'));
});

// ---- A3 fields ---------------------------------------------------------------------

test('A3: target.fields chooses and orders envelope fields and object members; v required; dropping q warns', async () => {
  const b = binding({ tags: ['temp', 'count'] }, { fields: ['name', 'v', 'u', 'src'] });
  const { mqtt, src, tb, profiles } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'temp', 21.5);
  await tick();
  const p = mqtt.all.find((x) => x.topic === 'acme/m1/temperature').payload;
  assert.strictEqual(JSON.stringify(p), '{"name":"temperature","v":21.5,"u":"degC","src":"temp"}');
  tb.stop();
  const w = model.bindingWarnings({ ...b }, profiles);
  assert.ok(w.some((x) => x.type === 'no-quality' && /dead value from a live one/.test(x.message)));
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { fields: ['t', 'q'] }), { profiles }), /must include "v"/);
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { fields: ['v', 'x'] }), { profiles }), /unknown field\(s\) "x"/);
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { fields: ['v', 'v'] }), { profiles }), /twice/);
  assert.ok(model.bindingWarnings({ ...binding({ tags: ['temp'] }, { fields: ['v', 'q'], format: 'plain' }) }, profiles).some((x) => x.type === 'fields-ignored'));

  const o = setup({ bindings: { b1: binding({ tags: ['temp', 'count'] }, { layout: 'object-per-asset', fields: ['v', 't', 'q'] }) } });
  o.src.sample('dev1', 'temp', 1, { tRead: 5 });
  o.src.sample('dev1', 'count', 2, { tRead: 6, type: 'uint16' });
  o.src.batchEnd('dev1');
  await tick();
  assert.deepStrictEqual(o.mqtt.values('acme/m1')[0], { t: 6, values: { temperature: { v: 1, t: 5, q: 192 }, count: { v: 2, t: 6, q: 192 } } });
  o.tb.stop();
});

// ---- B1 overrides and transforms --------------------------------------------------------

test('B1: mapping overrides win over the device (name, displayName, description, unit, range); preview reports origins', () => {
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  const b = { id: 'x', ...binding({ tags: [{ address: 'temp', unit: 'K', displayName: 'Supply', range: { min: 250, max: 400 } }, 'press'], overrides: { press: { description: 'Header pressure' } } }) };
  const prev = model.previewBinding(b, profiles);
  const temp = prev.tags.find((t) => t.address === 'temp');
  assert.deepStrictEqual(temp.metadata, { name: 'temperature', type: 'float32', unit: 'K', description: 'Supply temp', range: { min: 250, max: 400 }, displayName: 'Supply', deadband: null });
  assert.strictEqual(temp.origins.unit, 'mapping');
  assert.strictEqual(temp.origins.description, 'device');
  assert.strictEqual(temp.origins.name, 'device');
  assert.strictEqual(temp.origins.precision, 'default');
  const press = prev.tags.find((t) => t.address === 'press');
  assert.strictEqual(press.metadata.description, 'Header pressure');
  assert.strictEqual(press.origins.description, 'mapping');
  assert.strictEqual(press.origins.displayName, 'device');
  assert.strictEqual(press.origins.limits, 'device');
  assert.deepStrictEqual(press.contextOrigins, { measurementType: 'device', pid: 'device' });
  const meta = prev.meta[0].payload.properties;
  assert.strictEqual(meta.temperature.unit, 'K');
  assert.deepStrictEqual(meta.pressure.limits, { lo: 1, hi: 9 });
  assert.strictEqual(meta.pressure.displayName, 'Line pressure');
});

test('B1: order is read -> scale/offset -> cast -> deadband -> publish; precision is for publishing only', async () => {
  // raw counts 0..4000 -> 0..100 % via scale 0.025, cast to integer, deadband 2 on the integer value, precision on a second tag
  const b = binding(
    { tags: [{ address: 'count', name: 'level', scale: 0.025, offset: 0, dataType: 'integer', deadband: 2, unit: '%' }, { address: 'temp', precision: 1, scale: 1.8, offset: 32, unit: 'degF' }] },
    {},
    { rbe: { deadband: { type: 'absolute', value: 100 } } }
  );
  const { mqtt, src, tb } = setup({ bindings: { b1: b } });
  for (const raw of [1000, 1050, 1100, 1180]) src.sample('dev1', 'count', raw, { type: 'uint16' });
  // 25, 26.25->26 (in band 2 of 25), 27.5->28 (out of band), 29.5->30 (out of band from 28)
  for (const raw of [20, 20.01, 20.04]) src.sample('dev1', 'temp', raw);
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/level').map((p) => p.v), [25, 28, 30]);
  assert.deepStrictEqual(mqtt.values('acme/m1/level')[0], { v: 25, t: 1000, q: 192, u: '%' });
  // temp: binding deadband 100 would suppress all changes; it has no per-tag band so it inherits 100 -> only the first
  assert.deepStrictEqual(mqtt.values('acme/m1/temperature').map((p) => p.v), [68]);
  tb.stop();

  // precision: change detection on the unrounded value (68.018 -> 68.0 twice)
  const c = setup({ bindings: { b1: binding({ tags: [{ address: 'temp', precision: 1, scale: 1.8, offset: 32, deadband: 0 }] }, {}, { rbe: { deadband: { type: 'absolute', value: 100 } } }) } });
  for (const raw of [20, 20.01, 20.2]) c.src.sample('dev1', 'temp', raw);
  await tick();
  assert.deepStrictEqual(c.mqtt.values('acme/m1/temperature').map((p) => p.v), [68, 68, 68.4], 'deadband 0 disables the binding band for this tag');
  c.tb.stop();
});

test('B1: a failed cast publishes Bad quality with a reason, never a wrong value; plain payloads skip it', async () => {
  const b = binding({ tags: [{ address: 'count', dataType: 'number' }, { address: 'temp', dataType: 'boolean' }] });
  const { mqtt, src, tb } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'count', 'n/a', { type: 'string' });
  src.sample('dev1', 'count', '12.5', { type: 'string' });
  src.sample('dev1', 'temp', 'maybe');
  src.sample('dev1', 'temp', 'ON');
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/count'), [
    { v: null, t: 1000, q: 0, reason: 'cannot cast "n/a" to number' },
    { v: 12.5, t: 1000, q: 192 }
  ]);
  assert.deepStrictEqual(mqtt.values('acme/m1/temperature').map((p) => [p.v, p.q]), [[null, 0], [true, 192]]);
  tb.stop();

  const p = setup({ bindings: { b1: binding({ tags: [{ address: 'count', scale: 2 }] }, { format: 'plain' }) } });
  p.src.sample('dev1', 'count', 'oops', { type: 'string' });
  p.src.sample('dev1', 'count', 4, { type: 'uint16' });
  await tick();
  assert.deepStrictEqual(p.mqtt.values('acme/m1/count'), [8]);
  assert.match(p.tb.getStatus().b1.lastError, /scale\/offset needs a numeric value, got "oops"/);
  p.tb.stop();

  const out = {};
  assert.deepStrictEqual(cx.applyTransform({ linear: false, dataType: 'integer' }, -2.5, 192, out), { v: -3, q: 192, r: undefined }, 'half away from zero');
  assert.strictEqual(cx.applyTransform({ linear: false, dataType: 'string' }, { a: 1 }, 192, out).v, '{"a":1}');
  assert.strictEqual(cx.applyTransform({ linear: false, dataType: 'boolean' }, 0, 192, out).v, false);
  assert.strictEqual(cx.applyTransform({ linear: true, scale: 2, offset: 1, dataType: null }, null, 0, out).v, null, 'null passes through');
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', scale: 0 }] }), { profiles }), /tag "temp"\.scale must be a non-zero finite number/);
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', dataType: 'float' }] }), { profiles }), /tag "temp"\.dataType must be one of number, integer, boolean, string/);
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', precision: 11 }] }), { profiles }), /precision must be an integer 0\.\.10/);
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', limits: { lo: 5, hi: 1 } }] }), { profiles }), /ordered lolo <= lo <= hi <= hihi \(lo 5 > hi 1\)/);
});

test('B1: states in label-field (default) and replace modes; device-level states are used', async () => {
  const b = binding({ tags: ['state', { address: 'count', name: 'mode', states: { 1: 'Auto', 2: 'Manual' }, statesMode: 'replace' }] });
  const { mqtt, src, tb } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'state', 1, { type: 'uint16' });
  src.sample('dev1', 'state', 5, { type: 'uint16' });
  src.sample('dev1', 'count', 2, { type: 'uint16' });
  src.sample('dev1', 'count', 3, { type: 'uint16' });
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/runState'), [{ v: 1, label: 'Running', t: 1000, q: 192 }, { v: 5, t: 1000, q: 192 }]);
  assert.deepStrictEqual(mqtt.values('acme/m1/mode').map((p) => p.v), ['Manual', 3], 'unmapped raw values publish as is');
  const meta = mqtt.values('acme/m1/_meta')[0].properties;
  assert.deepStrictEqual([meta.runState.states, meta.runState.statesMode], [{ 0: 'Stopped', 1: 'Running' }, 'label-field']);
  tb.stop();
});

// ---- B2/B3 context ------------------------------------------------------------------

const PROFILE = {
  id: 'pm',
  name: 'Power meter',
  protocol: 'modbus-tcp',
  pollGroups: [{ id: 'default', intervalMs: 1000 }],
  params: [{ name: 'line' }, { name: 'serial' }],
  tags: [
    { key: 'kw', address: 'holding:10', type: 'float32', property: 'activePower', unit: 'kW', context: { measurementType: 'power' } },
    { key: 'pf', address: 'holding:12', type: 'float32', property: 'powerFactor' }
  ]
};
const inst = (id, name, line, serial) => ({ id, name, protocol: 'modbus-tcp', host: `10.0.0.${id.slice(1)}`, profileId: 'pm', params: { line, serial }, tags: [], pollGroups: [] });

test('B2/B3: asset context placeholders resolve per profile instance; contexts merge into _meta (mapping wins)', async () => {
  const b = {
    id: 'pb',
    enabled: true,
    source: { type: 'device-profile', profileId: 'pm', tags: [{ address: 'kw', context: { criticality: 'high', measurementType: 'activePower' } }, 'pf'] },
    target: {
      mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPathTemplate: 'acme/{line}/{device}',
      context: { site: 'dallas', line: '{param:line}', serialNumber: '{param:serial}', equipmentId: '{deviceId}', source: '{protocol}://{host}', asset: '{device}' }
    }
  };
  const { mqtt, src, tb } = setup({ bindings: { pb: b }, devices: { m1: inst('m1', 'Meter 1', 'l1', 'SN-1'), m2: inst('m2', 'Meter 2', 'l2', 'SN-2') }, extra: { deviceProfiles: { pm: PROFILE } } });
  await tick();
  const m1 = mqtt.values('acme/l1/Meter_1/_meta')[0];
  const m2 = mqtt.values('acme/l2/Meter_2/_meta')[0];
  assert.deepStrictEqual(Object.keys(m1), ['context', 'properties', 'updatedAt']);
  assert.deepStrictEqual(m1.context, { site: 'dallas', line: 'l1', serialNumber: 'SN-1', equipmentId: 'm1', source: 'modbus-tcp://10.0.0.1', asset: 'Meter 1' });
  assert.deepStrictEqual(m2.context.serialNumber, 'SN-2');
  assert.deepStrictEqual(m1.properties.activePower.context, { measurementType: 'activePower', criticality: 'high' }, 'device context merged, mapping wins key by key');
  assert.strictEqual(m1.properties.powerFactor.context, undefined);
  src.sample('m1', 'kw', 3);
  await tick();
  assert.strictEqual(mqtt.values('acme/l1/Meter_1/activePower')[0].ctx, undefined, 'contextMode meta keeps context out of payloads');
  tb.stop();

  const profiles = memoryProfiles({ devices: { m1: inst('m1', 'Meter 1', 'l1', 'SN-1') }, deviceProfiles: { pm: PROFILE } });
  assert.throws(
    () => model.validateBinding({ ...b, target: { ...b.target, context: { tag: '{param:nope}' } } }, { profiles }),
    (e) => /target\.context\.tag uses unknown placeholder \{param:nope\}/.test(e.message) && /\{param:line\}, \{param:serial\}/.test(e.message)
  );
  const dev = memoryProfiles({ devices: { dev1: METER } });
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { context: { a: '{param:line}' } }), { profiles: dev }), /target\.context\.a uses unknown placeholder \{param:line\} \(allowed for a device source: \{device\}, \{deviceId\}, \{protocol\}, \{host\}\)/);
});

test('B3: contextMode payload adds ctx to envelopes and object members within the size cap; none and metaFields', async () => {
  const b = binding({ tags: ['press', 'temp'] }, { contextMode: 'payload', context: { site: 'dallas', asset: '{device}' } });
  const { mqtt, src, tb, profiles } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'press', 4, { type: 'int16' });
  src.sample('dev1', 'temp', 20);
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/pressure')[0], { v: 4, t: 1000, q: 192, u: 'bar', ctx: { site: 'dallas', asset: 'Meter 1', measurementType: 'pressure', pid: 'PT-101' } });
  assert.deepStrictEqual(mqtt.values('acme/m1/temperature')[0].ctx, { site: 'dallas', asset: 'Meter 1' });
  tb.stop();

  const o = setup({ bindings: { b1: binding({ tags: ['press'] }, { layout: 'object-per-asset', contextMode: 'payload', context: { site: 'dallas' } }) } });
  o.src.sample('dev1', 'press', 4, { type: 'int16' });
  o.src.batchEnd('dev1');
  await tick();
  assert.deepStrictEqual(o.mqtt.values('acme/m1')[0].values.pressure, { v: 4, q: 192, u: 'bar', ctx: { site: 'dallas', measurementType: 'pressure', pid: 'PT-101' } });
  o.tb.stop();

  // payload context cap: rejected with the numbers
  const big = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, 'x'.repeat(200)]));
  assert.throws(
    () => model.validateBinding(binding({ tags: ['temp'] }, { contextMode: 'payload', context: big }), { profiles }),
    (e) => /tag "temp": payload context \(ctx\) is \d+ bytes, over the 1024-byte cap/.test(e.message)
  );
  assert.ok(model.validateBinding(binding({ tags: ['temp'] }, { context: big }), { profiles }), 'the same context is fine in _meta');
  // ...and it counts toward maxObjectBytes
  const objPlain = model.objectEstimate(model.expandUnits({ id: 'x', ...binding({ tags: ['press'] }, { layout: 'object-per-asset' }) }, profiles)[0]).total;
  const objCtx = model.objectEstimate(model.expandUnits({ id: 'x', ...binding({ tags: ['press'] }, { layout: 'object-per-asset', contextMode: 'payload' }) }, profiles)[0]).total;
  assert.ok(objCtx > objPlain + 40, `${objCtx} > ${objPlain}`);

  // none: no context anywhere; ctx in fields conflicts
  const n = model.expandUnits({ id: 'x', ...binding({ tags: ['press'] }, { contextMode: 'none', context: { site: 'd' } }) }, profiles)[0];
  assert.deepStrictEqual(model.metaDoc(n), { properties: { pressure: { type: 'int16', unit: 'bar', displayName: 'Line pressure', limits: { lo: 1, hi: 9 }, source: { deviceId: 'dev1', address: 'press' } } } });
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { contextMode: 'none', fields: ['v', 'ctx'] }), { profiles }), /"ctx" but target\.contextMode is "none"/);

  // metaFields: keep source addresses out of the broker
  const m = model.expandUnits({ id: 'x', ...binding({ tags: ['temp'] }, { metaFields: ['unit', 'context'], context: { site: 'd' } }) }, profiles)[0];
  assert.deepStrictEqual(model.metaDoc(m), { context: { site: 'd' }, properties: { temperature: { unit: 'degC' } } });
  assert.throws(() => model.validateBinding(binding({ tags: ['temp'] }, { metaFields: ['address'] }), { profiles }), /metaFields has unknown field\(s\) "address"/);
});

test('B4: context keys, counts and sizes are validated with the numbers; credential-like keys warn', () => {
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  const v = (context) => () => model.validateBinding(binding({ tags: ['temp'] }, { context }), { profiles });
  assert.throws(v({ 'bad key': 1 }), /target\.context key "bad key" is invalid: 1-64 characters of A-Z a-z 0-9 _ \. -, starting with a letter/);
  assert.throws(v(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]))), /target\.context has 33 keys; at most 32 are allowed/);
  assert.throws(v({ a: 'x'.repeat(257) }), /target\.context\.a is 257 characters; at most 256 are allowed/);
  assert.throws(v({ a: { nested: true } }), /target\.context\.a must be a string, a finite number or a boolean/);
  assert.throws(v(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'y'.repeat(250)]))), /target\.context is \d+ bytes as JSON; at most 4096 bytes are allowed/);
  assert.throws(() => model.validateBinding(binding({ tags: [{ address: 'temp', context: { '1x': 1 } }] }), { profiles }), /tag "temp"\.context key "1x" is invalid/);
  const w = model.bindingWarnings({ id: 'x', ...binding({ tags: [{ address: 'temp', context: { apiToken: 'abc' } }] }, { context: { password: 'p' } }) }, profiles);
  assert.deepStrictEqual(w.filter((x) => x.type === 'credential-like-context').map((x) => x.key), ['password', 'apiToken']);
});

test('B5: device-level context, displayName, states and limits flow into _meta; invalid device context is reported, not used', () => {
  const dev = { ...METER, tags: [...METER.tags, { key: 'odd', address: 'holding:20', type: 'uint16', context: { ok: 1, 'no good': 2 } }] };
  const profiles = memoryProfiles({ devices: { dev1: dev } });
  const b = { id: 'x', ...binding({ tags: ['press', 'odd'] }) };
  const doc = model.metaDoc(model.expandUnits(b, profiles)[0]);
  assert.deepStrictEqual(doc.properties.pressure, {
    type: 'int16', unit: 'bar', displayName: 'Line pressure', limits: { lo: 1, hi: 9 }, context: { measurementType: 'pressure', pid: 'PT-101' }, source: { deviceId: 'dev1', address: 'press' }
  });
  assert.deepStrictEqual(doc.properties.odd.context, { ok: 1 });
  assert.ok(model.bindingWarnings(b, profiles).some((w) => w.type === 'device-context' && /"no good"|no good/.test(w.message)));
});

// ---- Sparkplug ----------------------------------------------------------------------

function spbHarness() {
  const sent = [];
  const pub = new SparkplugPublisher({ profiles: { brokers: () => [] } });
  pub.sessions.set('br G E', {
    key: 'br G E', brokerId: 'br', group: 'G', edge: 'E', bdSeq: 1, seq: 0, online: true, devices: new Map(),
    stats: { published: 0, errors: 0, rebirths: 0, lastError: null },
    client: { publish: (topic, buf, o, cb) => { const p = decoder.decode(buf); sent.push({ topic, seq: p.seq, metrics: p.metrics }); cb?.(); } }
  });
  return { pub, sent };
}

test('B3 Sparkplug: BIRTH carries displayName, limits and context as metric properties; metadata edits re-BIRTH', async () => {
  const { pub, sent } = spbHarness();
  const b = binding({ tags: [{ address: 'press', unit: 'psi', limits: { lolo: 0, hihi: 12 }, context: { owner: 'ops', engUnit: 'ignored' } }, { address: 'state', statesMode: 'replace' }] }, { mode: 'sparkplug', group: 'G', edge: 'E', device: 'M1', context: { site: 'dallas', line: 4 } });
  delete b.target.format;
  delete b.target.assetPath;
  const { src, tb, profiles } = setup({ bindings: { b1: b }, spb: pub });
  src.sample('dev1', 'press', 4, { type: 'int16' });
  src.sample('dev1', 'state', 1, { type: 'uint16' });
  await tick();
  const births = sent.filter((s) => s.topic.includes('DBIRTH'));
  const press = births[0].metrics.find((m) => m.name === 'pressure');
  assert.deepStrictEqual(press.properties, {
    engUnit: 'psi', displayName: 'Line pressure', limitLoLo: 0, limitHiHi: 12, site: 'dallas', line: '4', measurementType: 'pressure', pid: 'PT-101', owner: 'ops'
  });
  const state = births.at(-1).metrics.find((m) => m.name === 'runState');
  assert.deepStrictEqual([state.value, state.datatypeName], ['Running', 'String'], 'replace mode publishes the label as a String metric');
  assert.ok(model.bindingWarnings(b, profiles).some((w) => w.type === 'sparkplug-context-collision' && w.key === 'engUnit'));

  // a device-tag metadata edit with NO value change: reconcile re-BIRTHs with the new properties, seq continues
  const before = sent.length;
  const lastSeq = sent.at(-1).seq;
  profiles.upsertIn('devices', 'dev1', { ...METER, tags: METER.tags.map((t) => (t.key === 'press' ? { ...t, displayName: 'Header pressure' } : t)) });
  tb.reconcile();
  await tick();
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent.at(-1).topic, /DBIRTH\/E\/M1$/);
  assert.strictEqual(Number(sent.at(-1).seq), (Number(lastSeq) + 1) % 256);
  assert.strictEqual(sent.at(-1).metrics.find((m) => m.name === 'pressure').properties.displayName, 'Header pressure');
  tb.reconcile(); // unchanged: nothing
  await tick();
  assert.strictEqual(sent.length, before + 1);
  tb.stop();
  assert.strictEqual(pub.refreshMetadata({ brokerId: 'br', group: 'G', edge: 'E', device: 'nope', properties: {} }), false);
});

// ---- preview, schema helpers, suggest -----------------------------------------------

test('preview: example payload applies fields/transform/context to the latest value; sizes; object members', () => {
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  const b = { id: 'x', ...binding({ tags: [{ address: 'count', name: 'level', scale: 0.5, precision: 0 }, 'state'] }, { fields: ['v', 'q'], contextMode: 'payload', context: { site: 'd' } }) };
  const latest = (unit, address) => ({ count: { v: 9, q: 192, t: 5 }, state: { v: 0, q: 192, t: 5 } })[address];
  const prev = model.previewBinding(b, profiles, { latest });
  assert.deepStrictEqual(prev.tags.map((t) => t.payload), [{ v: 5, q: 192, ctx: { site: 'd' } }, { v: 0, label: 'Stopped', q: 192, ctx: { site: 'd' } }]);
  assert.deepStrictEqual(prev.fields, { envelope: ['v', 'q', 'ctx'], member: null });
  assert.strictEqual(prev.contextMode, 'payload');
  assert.deepStrictEqual(prev.contexts, [{ unitId: 'b1', context: { site: 'd' } }]);
  assert.ok(prev.sizes.worstCasePayloadBytes >= prev.tags[0].bytes);
  assert.strictEqual(prev.sizes.exampleBytes, prev.tags[0].bytes + prev.tags[1].bytes);
  assert.ok(prev.tags.every((t) => t.worstCaseBytes >= t.bytes));
  assert.ok(prev.tags[0].warnings.length === 0);

  const obj = model.previewBinding({ ...b, target: { ...b.target, layout: 'object-per-asset' } }, profiles, { latest });
  assert.deepStrictEqual(obj.tags, []);
  assert.deepStrictEqual(obj.members.map((m) => [m.member, m.payload.v]), [['level', 5], ['runState', 0]]);
  assert.strictEqual(obj.objects[0].payload.values.runState.label, 'Stopped');
  assert.strictEqual(obj.sizes.worstCasePayloadBytes, obj.objects[0].worstCaseBytes);

  // per-tag warnings: a raw-address name shows on its own tag
  const raw = model.previewBinding({ id: 'x', ...binding({ tags: [{ address: 'count', name: '40001' }] }) }, profiles);
  assert.strictEqual(raw.tags[0].warnings[0].type, 'raw-address');
});

test('suggest: names from property, else a cleaned key; raw addresses get none; context from the device', () => {
  const dev = {
    ...METER,
    protocol: 's7',
    tags: [
      { key: 'temp', property: 'temperature' },
      { key: 'Motor_Speed' },
      { key: 'DB10.DBD4' },
      { key: 'holding_tank_level' },
      { key: 'Program:Main.Conveyor_Run' },
      { key: 'MW10' },
      { key: 'motorSpeed' }
    ]
  };
  const profiles = memoryProfiles({ devices: { dev1: dev } });
  const r = model.suggestMapping({ type: 'device', deviceId: 'dev1' }, profiles);
  assert.deepStrictEqual(r.tags.map((t) => [t.address, t.suggestedName, t.basis]), [
    ['temp', 'temperature', 'property'],
    ['Motor_Speed', 'motorSpeed', 'key'],
    ['DB10.DBD4', null, 'none'],
    ['holding_tank_level', 'tankLevel', 'key'],
    ['Program:Main.Conveyor_Run', null, 'none'], // Logix program scope counts as a raw address (unsLint)
    ['MW10', null, 'none'],
    ['motorSpeed', 'motorSpeed', 'key']
  ]);
  assert.strictEqual(r.tags[6].duplicateOf, 'Motor_Speed');
  assert.strictEqual(r.tags[2].rawAddress, true);
  assert.deepStrictEqual(r.context, { suggested: { deviceName: '{device}', protocol: '{protocol}' }, resolved: { deviceName: 'Meter 1', protocol: 's7' } });
  assert.deepStrictEqual(r.entries[0], { address: 'temp', name: 'temperature' });
  assert.strictEqual(cx.suggestName({ key: 'ns=2;s=Line1.Motor.RPM' }).name, 'rpm');
  assert.throws(() => model.suggestMapping({ type: 'sparkplug' }, profiles), /suggest supports/);
});

test('hot path: units carry a compiled publish plan; legacy tags carry nothing extra', () => {
  const { tb } = setup({ bindings: { b1: binding({ tags: ['temp', { address: 'count', scale: 2 }] }, { fields: ['v', 'q'] }) } });
  const unit = tb.index().units.get('b1');
  assert.deepStrictEqual(unit.envFields, ['v', 'q']);
  assert.deepStrictEqual(Object.keys(unit.tagByName.get('temperature')).sort(), ['address', 'meta', 'name']);
  assert.deepStrictEqual(unit.tagByName.get('count').plan, { linear: true, scale: 2, offset: 0, dataType: null });
  tb.stop();
});
