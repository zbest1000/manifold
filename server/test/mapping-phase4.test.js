const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { TagBindings } = require('../services/tagBindings');
const model = require('../services/bindingModel');
const SparkplugPublisher = require('../services/sparkplugPublisher');
const SparkplugDecoder = require('../services/sparkplugDecoder');

// Mapping features (ARCHITECTURE.md, Bindings):
// metadata, _meta, retained cleanup, object-per-asset, assetPath, percent
// deadband, direct historian target, profile-level bindings.

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
  m.on_ = (topic) => m.all.filter((p) => p.topic === topic);
  m.values = (topic) => m.on_(topic).filter((p) => p.payload !== '').map((p) => p.payload);
  m.cleared = () => m.all.filter((p) => p.payload === '').map((p) => `${p.brokerId}|${p.topic}`);
  return m;
}

function fakeDeviceSource() {
  const s = new EventEmitter();
  s.ensureMonitored = async () => {};
  s.sample = (deviceId, key, v, extra = {}) =>
    s.emit('sample', { sourceType: 'device', sourceId: deviceId, address: key, v, type: 'float32', q: 192, tRead: Date.now(), ...extra });
  s.batchEnd = (deviceId) => s.emit('batch-end', { sourceType: 'device', sourceId: deviceId });
  s.state = (deviceId, state) => s.emit('source-state', { sourceType: 'device', sourceId: deviceId, state, reason: state });
  return s;
}

const METER = {
  id: 'dev1',
  name: 'Meter 1',
  protocol: 'modbus-tcp',
  host: '10.0.0.5',
  pollGroups: [{ id: 'default', intervalMs: 1000 }],
  tags: [
    { key: 'temp', address: 'holding:100', type: 'float32', unit: 'degC', property: 'temperature', description: 'Supply temp', range: { min: 0, max: 200 } },
    { key: 'count', address: '40103', type: 'uint16' },
    { key: 'raw', address: 'holding:5', type: 'uint16', property: '40005' }
  ]
};

function setup({ bindings = {}, devices = { dev1: METER }, outbox = null, spb = null, extra = {}, tb = {} } = {}) {
  const profiles = memoryProfiles({ devices: { ...devices }, bindings: { ...bindings }, ...extra });
  const mqtt = fakeBroker();
  const src = fakeDeviceSource();
  const t = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: spb, outbox, objectFlushMs: 30, ...tb });
  t.registerSource('device', src);
  t.start();
  return { profiles, mqtt, src, tb: t };
}

const deviceBinding = (target, over = {}) => ({
  id: 'b1',
  enabled: true,
  source: { type: 'device', deviceId: 'dev1', tags: ['temp', 'count'] },
  target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', ...target },
  ...over
});

test('item 1: property names, unit in envelope, explicit names still win', async () => {
  const b = deviceBinding({ assetPath: 'acme/dallas/meter1' });
  b.source.tags = ['temp', 'count', { address: 'raw', name: 'rawCount' }];
  const { mqtt, src, tb } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'temp', 21.5);
  src.sample('dev1', 'count', 7, { type: 'uint16' });
  src.sample('dev1', 'raw', 3, { type: 'uint16' });
  await tick();
  const temp = mqtt.values('acme/dallas/meter1/temperature')[0];
  assert.strictEqual(temp.v, 21.5);
  assert.strictEqual(temp.u, 'degC');
  assert.deepStrictEqual(Object.keys(mqtt.values('acme/dallas/meter1/count')[0]).sort(), ['q', 't', 'v'], 'no u without a unit');
  assert.strictEqual(mqtt.values('acme/dallas/meter1/rawCount')[0].v, 3, 'binding entry name wins over property');
  tb.stop();
});

test('item 1: sparkplug BIRTH carries engUnit/description/engLow/engHigh, datatype stable', async () => {
  const sent = [];
  const pub = new SparkplugPublisher({ profiles: { brokers: () => [] } });
  pub.sessions.set('br G E', {
    key: 'br G E', brokerId: 'br', group: 'G', edge: 'E', bdSeq: 1, seq: 0, online: true, devices: new Map(),
    stats: { published: 0, errors: 0, rebirths: 0, lastError: null },
    client: { publish: (topic, buf, o, cb) => { sent.push({ topic, metrics: decoder.decode(buf).metrics }); cb?.(); } }
  });
  const b = deviceBinding({ mode: 'sparkplug', group: 'G', edge: 'E', device: 'M1' });
  const { src, tb } = setup({ bindings: { b1: b }, spb: pub });
  src.sample('dev1', 'temp', 21.5);
  src.sample('dev1', 'temp', 22.5);
  await tick();
  assert.deepStrictEqual(sent.map((s) => s.topic.split('/')[2]), ['DBIRTH', 'DDATA']);
  const birth = sent[0].metrics[0];
  assert.strictEqual(birth.datatypeName, 'Float');
  assert.deepStrictEqual(birth.properties, { engUnit: 'degC', description: 'Supply temp', engLow: 0, engHigh: 200 });
  assert.deepStrictEqual(sent[1].metrics[0].properties, {}, 'DDATA carries no metadata');
  assert.strictEqual(sent[1].metrics[0].datatypeName, 'Float');
  tb.stop();
});

test('item 2: retained _meta at start, opt-out, republished on metadata change', async () => {
  const { mqtt, profiles, tb } = setup({ bindings: { b1: deviceBinding({ assetPath: 'acme/m1' }) } });
  await tick();
  const meta = mqtt.values('acme/m1/_meta');
  assert.strictEqual(meta.length, 1);
  assert.strictEqual(mqtt.on_('acme/m1/_meta')[0].opts.retain, true);
  assert.deepStrictEqual(meta[0].properties.temperature, {
    type: 'float32', unit: 'degC', description: 'Supply temp', range: { min: 0, max: 200 },
    source: { deviceId: 'dev1', address: 'temp' }
  });
  assert.deepStrictEqual(meta[0].properties.count, { type: 'uint16', source: { deviceId: 'dev1', address: 'count' } });
  assert.ok(meta[0].updatedAt > 0);

  tb.reconcile(); // nothing changed: no republish
  await tick();
  assert.strictEqual(mqtt.values('acme/m1/_meta').length, 1);

  profiles.upsertIn('devices', 'dev1', { ...METER, tags: METER.tags.map((t) => (t.key === 'count' ? { ...t, unit: 'pcs' } : t)) });
  tb.reconcile();
  await tick();
  assert.strictEqual(mqtt.values('acme/m1/_meta').length, 2);
  assert.strictEqual(mqtt.values('acme/m1/_meta')[1].properties.count.unit, 'pcs');
  tb.stop();

  const off = setup({ bindings: { b1: deviceBinding({ assetPath: 'acme/m1', metaTopic: false }) } });
  await tick();
  assert.strictEqual(off.mqtt.values('acme/m1/_meta').length, 0);
  off.tb.stop();
});

test('item 3: retained topics are cleared on path change, broker change, disable and delete', async () => {
  const b = deviceBinding({ assetPath: 'acme/old', retain: true });
  const { mqtt, profiles, src, tb } = setup({ bindings: { b1: b } });
  src.sample('dev1', 'temp', 1);
  src.state('dev1', 'online');
  await tick();

  // path change: old values, _status and _meta cleared; new _meta published
  profiles.upsertIn('bindings', 'b1', { ...b, target: { ...b.target, assetPath: 'acme/new' } });
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared().sort(), ['br|acme/old/_meta', 'br|acme/old/_status', 'br|acme/old/count', 'br|acme/old/temperature']);
  assert.strictEqual(mqtt.values('acme/new/_meta').length, 1);

  // retain switched off: value topics cleared, status/meta stay
  mqtt.all.length = 0;
  const cur = profiles.getIn('bindings', 'b1');
  profiles.upsertIn('bindings', 'b1', { ...cur, target: { ...cur.target, retain: false } });
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared().sort(), ['br|acme/new/count', 'br|acme/new/temperature']);

  // broker change: everything on the old broker cleared
  mqtt.all.length = 0;
  const cur2 = profiles.getIn('bindings', 'b1');
  profiles.upsertIn('bindings', 'b1', { ...cur2, target: { ...cur2.target, brokerId: 'br2' } });
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared().sort(), ['br|acme/new/_meta', 'br|acme/new/_status']);

  // disable, then delete
  mqtt.all.length = 0;
  profiles.upsertIn('bindings', 'b1', { ...profiles.getIn('bindings', 'b1'), enabled: false });
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared().sort(), ['br2|acme/new/_meta', 'br2|acme/new/_status']);
  mqtt.all.length = 0;
  profiles.removeIn('bindings', 'b1');
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared(), [], 'already cleared when disabled');
  assert.strictEqual(tb.retained.size, 0);
  tb.stop();
});

test('item 3: deterministic retained set derivation', () => {
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  const b = { id: 'x', ...deviceBinding({ pathTemplate: 'a/{name}', retain: true }) };
  assert.deepStrictEqual(model.retainedTopics(b, profiles).map((r) => r.topic).sort(), ['a/_meta', 'a/_status', 'a/count', 'a/temperature']);
  assert.deepStrictEqual(model.retainedTopics({ ...b, enabled: false }, profiles), []);
  const obj = { ...b, target: { ...b.target, layout: 'object-per-asset' } };
  assert.deepStrictEqual(model.retainedTopics(obj, profiles).map((r) => r.topic).sort(), ['a', 'a/_meta', 'a/_status']);
});

test('item 4: object-per-asset publishes one object per batch, RBE at object level, Bad on disconnect', async () => {
  const b = deviceBinding({ assetPath: 'acme/m1', layout: 'object-per-asset', format: 'plain' }, { rbe: { heartbeatMs: 1000 } });
  const { mqtt, src, tb } = setup({ bindings: { b1: b }, tb: { objectFlushMs: 5000 } });
  src.sample('dev1', 'temp', 21.5, { tRead: 1000 });
  src.sample('dev1', 'count', 7, { tRead: 1001, type: 'uint16' });
  src.batchEnd('dev1');
  await tick();
  let objs = mqtt.values('acme/m1').map((p) => JSON.parse(p));
  assert.strictEqual(objs.length, 1, 'one publish for the batch');
  assert.deepStrictEqual(objs[0], { t: 1001, values: { temperature: { v: 21.5, q: 192, u: 'degC' }, count: { v: 7, q: 192 } } });

  // unchanged batch: nothing; one member changed: whole object again
  src.sample('dev1', 'temp', 21.5);
  src.sample('dev1', 'count', 7, { type: 'uint16' });
  src.batchEnd('dev1');
  src.sample('dev1', 'count', 8, { type: 'uint16' });
  src.batchEnd('dev1');
  await tick();
  objs = mqtt.values('acme/m1').map((p) => JSON.parse(p));
  assert.strictEqual(objs.length, 2);
  assert.strictEqual(objs[1].values.count.v, 8);
  assert.strictEqual(objs[1].values.temperature.v, 21.5);

  src.state('dev1', 'offline');
  await tick();
  objs = mqtt.values('acme/m1').map((p) => JSON.parse(p));
  assert.strictEqual(objs.length, 3);
  assert.deepStrictEqual([objs[2].values.count.q, objs[2].values.temperature.q], [0, 0]);
  assert.strictEqual(mqtt.values('acme/m1/temperature').length, 0, 'no per-tag topics');
  tb.stop();
});

test('item 4: sources without batch-end flush on the short timer; heartbeat republishes the object', async () => {
  const b = deviceBinding({ pathTemplate: 'acme/m1/{name}', layout: 'object-per-asset' }, { rbe: { heartbeatMs: 1000 } });
  const { mqtt, src, tb } = setup({ bindings: { b1: b }, tb: { objectFlushMs: 20, heartbeatTickMs: 10 } });
  src.sample('dev1', 'temp', 1);
  src.sample('dev1', 'count', 2, { type: 'uint16' });
  await tick(60);
  assert.strictEqual(mqtt.values('acme/m1').length, 1, 'template minus {name} is the asset topic');
  tb.objects.get('b1').pubAt -= 2000; // pretend the heartbeat interval passed
  await tick(40);
  assert.strictEqual(mqtt.values('acme/m1').length, 2);
  tb.stop();
  assert.strictEqual(tb.objectTimer, null);
});

test('item 4: a binding that could exceed the object cap is rejected at save time with the numbers', () => {
  const tags = Array.from({ length: 400 }, (_, i) => ({ key: `s${i}`, address: `holding:${i}`, type: 'string' }));
  const profiles = memoryProfiles({ devices: { dev1: { ...METER, tags } } });
  const draft = { source: { type: 'device', deviceId: 'dev1', tags: 'all' }, target: { mode: 'mqtt', brokerId: 'br', assetPath: 'a/b', layout: 'object-per-asset' } };
  assert.throws(() => model.validateBinding(draft, { profiles }), (e) => /400 tags x up to \d+ bytes each/.test(e.message) && /65536-byte cap/.test(e.message));
  assert.ok(model.validateBinding({ ...draft, target: { ...draft.target, maxObjectBytes: 1048576 } }, { profiles }));
  assert.ok(model.validateBinding({ ...draft, target: { ...draft.target, layout: 'topic-per-tag' } }, { profiles }), 'topic-per-tag has no cap');
});

test('item 5: assetPath validation and legacy pathTemplate', () => {
  for (const bad of ['a//b', '/a', 'a/', 'a/+/b', 'a/#', '$SYS/x', 'a/{name}', '']) {
    assert.ok(model.validateAssetPath(bad), `rejects "${bad}"`);
  }
  assert.strictEqual(model.validateAssetPath('acme/dallas/packaging/line4/filler'), null);
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  const base = { source: { type: 'device', deviceId: 'dev1', tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'br' } };
  assert.throws(() => model.validateBinding({ ...base, target: { ...base.target, assetPath: 'a/+/b' } }, { profiles }), /wildcard/);
  const [u1] = model.expandUnits({ id: 'x', ...base, target: { ...base.target, assetPath: 'acme/m1' } }, profiles);
  assert.strictEqual(model.valueTopicOf(u1, 'temperature'), 'acme/m1/temperature');
  const [u2] = model.expandUnits({ id: 'x', ...base, target: { ...base.target, pathTemplate: 'legacy/{name}/pv' } }, profiles);
  assert.strictEqual(model.valueTopicOf(u2, 'temperature'), 'legacy/temperature/pv');
});

test('item 6: percent deadband uses the range when defined, else the last published value', async () => {
  const b = deviceBinding({ assetPath: 'acme/m1' }, { rbe: { deadband: { type: 'percent', value: 1 } } });
  const { mqtt, src, tb } = setup({ bindings: { b1: b } });
  // temp has range 0..200 -> band 2.0
  for (const v of [100, 101.5, 102.5, 103]) src.sample('dev1', 'temp', v);
  // count has no range -> 1 % of the last published value
  for (const v of [1000, 1009, 1011, 1015]) src.sample('dev1', 'count', v, { type: 'uint16' });
  src.sample('dev1', 'raw', 'x');
  await tick();
  assert.deepStrictEqual(mqtt.values('acme/m1/temperature').map((p) => p.v), [100, 102.5]);
  assert.deepStrictEqual(mqtt.values('acme/m1/count').map((p) => p.v), [1000, 1011]);
  tb.stop();

  assert.deepStrictEqual(model.deadbandOf({ target: { deadband: 0.5 } }), { type: 'absolute', value: 0.5 }, 'legacy numeric = absolute');
  assert.strictEqual(model.withinDeadband({ type: 'percent', value: 10 }, 'a', 'b'), false, 'non-numeric publishes on change');
  const profiles = memoryProfiles({ devices: { dev1: METER } });
  assert.throws(() => model.validateBinding({ ...deviceBinding({ assetPath: 'a' }), rbe: { deadband: { type: 'percent', value: 150 } } }, { profiles }), /0\.\.100/);
});

test('item 7: direct historian target enqueues published samples incl. Bad; InfluxDB is rejected', async () => {
  const enq = [];
  const outbox = { enqueue: (id, pts) => enq.push(...pts.map((p) => ({ id, ...p }))) };
  const b = deviceBinding({ assetPath: 'acme/m1', historian: { historianId: 'h1' } }, { rbe: { heartbeatMs: 1000 } });
  const { src, tb } = setup({ bindings: { b1: b }, extra: { historians: { h1: { id: 'h1', type: 'timebase' } } }, tb: { heartbeatTickMs: 10 } });
  tb.setOutbox(outbox);
  src.sample('dev1', 'temp', 5, { tRead: 1234 });
  src.sample('dev1', 'temp', 5, { tRead: 1300 }); // suppressed by RBE: not enqueued
  src.state('dev1', 'offline');
  for (const e of tb.last.get('b1').values()) e.pubAt -= 5000;
  await tick(40); // heartbeat repeats are not re-written
  assert.strictEqual(enq.length, 2);
  assert.deepStrictEqual(enq[0], { id: 'h1', tag: 'acme/m1/temperature', ts: 1234, value: 5, quality: 192 });
  assert.strictEqual(enq[1].quality, 0);
  tb.stop();

  const profiles = memoryProfiles({ devices: { dev1: METER }, historians: { i: { id: 'i', type: 'influxdb' }, t: { id: 't', type: 'timescaledb' } } });
  assert.throws(() => model.validateBinding(deviceBinding({ assetPath: 'a', historian: { historianId: 'i' } }), { profiles }), /InfluxDB/);
  assert.throws(() => model.validateBinding(deviceBinding({ assetPath: 'a', historian: { historianId: 'nope' } }), { profiles }), /existing historian/);
  assert.ok(model.validateBinding(deviceBinding({ assetPath: 'a', historian: { historianId: 't' } }), { profiles }));
});

test('item 8: one device-profile binding maps every instance, picks up new instances', async () => {
  const profile = {
    id: 'pm', name: 'Power meter', protocol: 'modbus-tcp', pollGroups: [{ id: 'default', intervalMs: 1000 }],
    params: [{ name: 'line' }],
    tags: [{ key: 'kw', address: 'holding:10', type: 'float32', property: 'activePower', unit: 'kW' }]
  };
  const inst = (id, name, line) => ({ id, name, protocol: 'modbus-tcp', host: '10.0.0.9', profileId: 'pm', params: { line }, tags: [], pollGroups: [] });
  const b = {
    id: 'pb', enabled: true,
    source: { type: 'device-profile', profileId: 'pm', tags: ['kw'] },
    target: { mode: 'mqtt', brokerId: 'br', format: 'envelope', assetPathTemplate: 'acme/{line}/{device}', assetPaths: { m3: 'acme/special/meter3' } }
  };
  const { mqtt, src, tb, profiles } = setup({
    bindings: { pb: b },
    devices: { m1: inst('m1', 'Meter 1', 'l1'), m2: inst('m2', 'Meter 2', 'l2') },
    extra: { deviceProfiles: { pm: profile } }
  });
  src.sample('m1', 'kw', 10);
  src.sample('m2', 'kw', 20);
  await tick();
  assert.strictEqual(mqtt.values('acme/l1/Meter_1/activePower')[0].u, 'kW');
  assert.strictEqual(mqtt.values('acme/l2/Meter_2/activePower')[0].v, 20);
  assert.strictEqual(mqtt.values('acme/l1/Meter_1/_meta')[0].properties.activePower.source.profileId, 'pm');

  profiles.upsertIn('devices', 'm3', inst('m3', 'Meter 3', 'l1'));
  tb.reconcile();
  src.sample('m3', 'kw', 30);
  await tick();
  assert.strictEqual(mqtt.values('acme/special/meter3/activePower')[0].v, 30, 'explicit map wins');

  src.state('m1', 'offline');
  await tick();
  assert.strictEqual(mqtt.values('acme/l1/Meter_1/activePower').at(-1).q, 0, 'Bad only for the lost instance');
  assert.strictEqual(mqtt.values('acme/l2/Meter_2/activePower').length, 1);

  // removing an instance clears its retained topics
  mqtt.all.length = 0;
  profiles.removeIn('devices', 'm2');
  tb.reconcile();
  await tick();
  assert.deepStrictEqual(mqtt.cleared().sort(), ['br|acme/l2/Meter_2/_meta', 'br|acme/l2/Meter_2/_status']);
  tb.stop();
});

test('item 9: save-time warnings for raw-address names and collisions', () => {
  const profiles = memoryProfiles({
    devices: { dev1: METER },
    bindings: { other: { id: 'other', name: 'Other', enabled: true, source: { type: 'device', deviceId: 'dev1', tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'br', assetPath: 'acme/m1' } } }
  });
  const b = { id: 'new', ...deviceBinding({ assetPath: 'acme/m1' }) };
  b.source.tags = ['temp', 'raw'];
  const w = model.bindingWarnings(b, profiles);
  assert.ok(w.some((x) => x.type === 'raw-address' && x.topic === 'acme/m1/40005'));
  assert.ok(w.some((x) => x.type === 'collision' && x.topic === 'acme/m1/temperature' && x.bindings[0].id === 'other'));
});
