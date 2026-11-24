const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { TagBindings, statusTopic } = require('../services/tagBindings');
const { OpcuaSource, normalizeType } = require('../services/tagSources/opcuaSource');
const { encodePayload } = require('../services/sparkplugEncoder');
const SparkplugDecoder = require('../services/sparkplugDecoder');
const SparkplugPublisher = require('../services/sparkplugPublisher');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const decoder = new SparkplugDecoder();

function fakeProfiles(data = {}) {
  return {
    data,
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null
  };
}

function fakeMqtt() {
  const m = new EventEmitter();
  m.published = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    m.published.push({ brokerId, topic, payload, opts });
  };
  return m;
}

function fakeOpcua() {
  const o = new EventEmitter();
  o.monitorCalls = [];
  o.failMonitor = 0;
  o.monitor = async (connectionId, nodeId, interval) => {
    o.monitorCalls.push({ connectionId, nodeId, interval });
    if (o.failMonitor > 0) {
      o.failMonitor--;
      throw new Error('session not ready');
    }
    return { status: 'monitoring' };
  };
  return o;
}

const NODE = 'ns=2;s=Motor.RPM';
const mkBinding = (over = {}) => ({
  id: 'b1',
  enabled: true,
  source: { type: 'opcua', connectionId: 'c1', tags: [{ address: NODE, name: 'rpm' }] },
  target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'uns/line1/{name}', format: 'envelope' },
  ...over
});
const val = (value, status = 'Good', dataType = 'Double') => ({
  connectionId: 'c1', nodeId: NODE, value, status, dataType, sourceTimestamp: new Date()
});

function setup(binding = mkBinding(), opts = {}) {
  const mqtt = fakeMqtt();
  const opcua = fakeOpcua();
  const profiles = fakeProfiles({ bindings: { [binding.id]: binding } });
  const tb = new TagBindings({ mqttManager: mqtt, opcuaManager: opcua, profiles, sparkplugPublisher: opts.spb || null, ...opts.tb });
  tb.start();
  return { tb, mqtt, opcua, profiles, binding };
}

const valueTopics = (mqtt) => mqtt.published.filter((p) => !p.topic.endsWith('/_status'));
const statusDocs = (mqtt) => mqtt.published.filter((p) => p.topic.endsWith('/_status'));

test('opcua adapter normalizes types and quality', () => {
  assert.strictEqual(normalizeType('Double'), 'float64');
  assert.strictEqual(normalizeType('Float'), 'float32');
  assert.strictEqual(normalizeType('Int16'), 'int16');
  assert.strictEqual(normalizeType('Boolean'), 'bool');
  assert.strictEqual(normalizeType('11'), 'float64');
  assert.strictEqual(normalizeType('ExtensionObject'), 'unknown');
  assert.strictEqual(normalizeType(null), 'unknown');

  const mgr = fakeOpcua();
  const src = new OpcuaSource(mgr);
  const seen = [];
  src.on('sample', (s) => seen.push(s));
  mgr.emit('value', val(1, 'UncertainSensorCal', 'UInt16'));
  assert.strictEqual(seen[0].sourceType, 'opcua');
  assert.strictEqual(seen[0].sourceId, 'c1');
  assert.strictEqual(seen[0].address, NODE);
  assert.strictEqual(seen[0].q, 64);
  assert.strictEqual(seen[0].type, 'uint16');
  assert.ok(seen[0].tRead > 0 && seen[0].tSource > 0);
});

test('monitors are re-synced when a source comes online (and retried on failure)', async () => {
  const { tb, opcua } = setup(mkBinding(), { tb: { retryMs: 20 } });
  await tick();
  assert.strictEqual(opcua.monitorCalls.length, 1);

  opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'lost' });
  opcua.emit('connection-state', { connectionId: 'c1', state: 'online', reason: 'reconnected' });
  await tick();
  assert.strictEqual(opcua.monitorCalls.length, 2, 'monitor re-requested after online');

  // unrelated source does not trigger a re-sync
  opcua.emit('connection-state', { connectionId: 'other', state: 'online' });
  await tick();
  assert.strictEqual(opcua.monitorCalls.length, 2);
  tb.stop();
});

test('failed monitor requests are retried on the slow timer; stop() clears it', async () => {
  const mqtt = fakeMqtt();
  const opcua = fakeOpcua();
  opcua.failMonitor = 2;
  const tb = new TagBindings({
    mqttManager: mqtt, opcuaManager: opcua, retryMs: 15,
    profiles: fakeProfiles({ bindings: { b1: mkBinding() } })
  });
  tb.start();
  await tick(120);
  assert.ok(opcua.monitorCalls.length >= 3, `retried (got ${opcua.monitorCalls.length})`);
  assert.strictEqual(opcua.failMonitor, 0);
  const n = opcua.monitorCalls.length;
  await tick(60);
  assert.strictEqual(opcua.monitorCalls.length, n, 'no more retries once successful');
  tb.stop();
  assert.strictEqual(tb.retryTimer, null);
  assert.strictEqual(tb.heartbeatTimer, null);
});

test('quality-only change publishes; unchanged value+quality is suppressed', async () => {
  const { tb, mqtt, opcua } = setup();
  opcua.emit('value', val(10));
  opcua.emit('value', val(10)); // suppressed
  opcua.emit('value', val(10, 'BadCommunicationError')); // Good -> Bad, same value
  opcua.emit('value', val(10, 'BadCommunicationError')); // suppressed
  await tick();
  assert.strictEqual(mqtt.published.length, 2);
  assert.deepStrictEqual(mqtt.published[1].payload.q, 0);
  assert.strictEqual(mqtt.published[1].payload.v, 10);
  assert.strictEqual(tb.getStatus().b1.suppressed, 2);
  tb.stop();
});

test('offline publishes Bad once for envelope; plain publishes no value; Good republished on recovery', async () => {
  const env = setup(mkBinding());
  env.opcua.emit('value', val(5));
  await tick();
  env.opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'lost' });
  env.opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'lost' });
  await tick();
  const vals = valueTopics(env.mqtt);
  assert.strictEqual(vals.length, 2, 'initial + exactly one Bad');
  assert.deepStrictEqual({ v: vals[1].payload.v, q: vals[1].payload.q }, { v: 5, q: 0 });
  assert.strictEqual(vals[1].topic, 'uns/line1/rpm');

  env.opcua.emit('connection-state', { connectionId: 'c1', state: 'online', reason: 'ok' });
  env.opcua.emit('value', val(5)); // unchanged value, but Good again
  await tick();
  const after = valueTopics(env.mqtt);
  assert.strictEqual(after.length, 3);
  assert.strictEqual(after[2].payload.q, 192);
  env.tb.stop();

  const plain = setup(mkBinding({ target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'uns/p/{name}', format: 'plain' } }));
  plain.opcua.emit('value', val(5));
  await tick();
  plain.opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'lost' });
  await tick();
  assert.strictEqual(valueTopics(plain.mqtt).length, 1, 'plain: no Bad value publish');
  assert.strictEqual(statusDocs(plain.mqtt).length, 1, 'plain: status document instead');
  plain.tb.stop();
});

test('structured values compare structurally', async () => {
  const { tb, mqtt, opcua } = setup();
  opcua.emit('value', val([1, 2, 3], 'Good', 'Int16'));
  opcua.emit('value', val([1, 2, 3], 'Good', 'Int16')); // new array, same content
  opcua.emit('value', val({ a: 1 }, 'Good', 'Int16'));
  opcua.emit('value', val({ a: 1 }, 'Good', 'Int16'));
  opcua.emit('value', val({ a: 2 }, 'Good', 'Int16'));
  await tick();
  assert.strictEqual(mqtt.published.length, 3);
  assert.strictEqual(tb.getStatus().b1.suppressed, 2);
  tb.stop();
});

test('status topic: retained online/offline docs, template rules, opt-out', async () => {
  assert.strictEqual(statusTopic('uns/a/{name}'), 'uns/a/_status');
  assert.strictEqual(statusTopic('uns/a/'), 'uns/a/_status');

  const { tb, mqtt, opcua } = setup();
  opcua.emit('connection-state', { connectionId: 'c1', state: 'online', reason: 'connected' });
  opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'lost' });
  await tick();
  const docs = statusDocs(mqtt);
  assert.strictEqual(docs.length, 2);
  assert.strictEqual(docs[0].topic, 'uns/line1/_status');
  assert.strictEqual(docs[0].opts.retain, true);
  assert.strictEqual(docs[0].payload.online, true);
  assert.strictEqual(docs[0].payload.reason, 'connected');
  assert.ok(docs[0].payload.since > 0);
  assert.strictEqual(docs[1].payload.online, false);
  assert.strictEqual(docs[1].payload.reason, 'lost');
  assert.strictEqual(tb.getStatus().b1.sourceState.state, 'offline');
  tb.stop();

  const off = setup(mkBinding({ target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'x/{name}', format: 'envelope', statusTopic: false } }));
  off.opcua.emit('connection-state', { connectionId: 'c1', state: 'online' });
  await tick();
  assert.strictEqual(statusDocs(off.mqtt).length, 0);
  off.tb.stop();
});

test('sparkplug encoder honours explicit types; default behaviour unchanged', () => {
  const metrics = [
    { name: 'i16', value: -5, type: 'int16' },
    { name: 'i32', value: 70000, type: 'int32' },
    { name: 'u16', value: 65535, type: 'uint16' },
    { name: 'f32', value: 1.5, type: 'float32' },
    { name: 'f64', value: 2.5, type: 'float64' },
    { name: 'b', value: true, type: 'bool' },
    { name: 's', value: 'hi', type: 'string' },
    { name: 'i64', value: 123456789012, type: 'int64' },
    { name: 'nul', value: null, type: 'int16' },
    { name: 'plain', value: 3 },
    { name: 'unk', value: 3, type: 'unknown' }
  ];
  const out = Object.fromEntries(decoder.decode(encodePayload({ metrics })).metrics.map((m) => [m.name, m]));
  assert.strictEqual(out.i16.datatypeName, 'Int16');
  assert.strictEqual(out.i32.datatypeName, 'Int32');
  assert.strictEqual(out.i32.value, 70000);
  assert.strictEqual(out.u16.datatypeName, 'UInt16');
  assert.strictEqual(out.u16.value, 65535);
  assert.strictEqual(out.f32.datatypeName, 'Float');
  assert.strictEqual(out.f64.datatypeName, 'Double');
  assert.strictEqual(out.b.datatypeName, 'Boolean');
  assert.strictEqual(out.s.datatypeName, 'String');
  assert.strictEqual(out.i64.datatypeName, 'Int64');
  assert.strictEqual(String(out.i64.value), '123456789012');
  assert.strictEqual(out.nul.datatypeName, 'Int16');
  assert.strictEqual(out.nul.isNull, true);
  assert.strictEqual(out.plain.datatypeName, 'Double');
  assert.strictEqual(out.unk.datatypeName, 'Double');
});

function fakeSession() {
  const sent = [];
  return {
    sent,
    s: {
      key: 'br G E', brokerId: 'br', group: 'G', edge: 'E', bdSeq: 1, seq: 0, online: true,
      devices: new Map(), stats: { published: 0, errors: 0, rebirths: 0, lastError: null },
      client: { publish: (topic, buf, o, cb) => { sent.push({ topic, metrics: decoder.decode(buf).metrics, seq: decoder.decode(buf).seq }); cb?.(); } }
    }
  };
}

test('sparkplug publisher: datatype stable BIRTH->DATA; DDEATH/DBIRTH on source state', () => {
  const pub = new SparkplugPublisher({ profiles: { brokers: () => [] } });
  const { s, sent } = fakeSession();
  pub.sessions.set(s.key, s);
  const base = { brokerId: 'br', group: 'G', edge: 'E', device: 'D' };
  pub.updateDevice({ ...base, metrics: [{ name: 'speed', value: 7, ts: 1, type: 'int16' }] });
  pub.updateDevice({ ...base, metrics: [{ name: 'speed', value: 8, ts: 2, type: 'int16' }] });
  pub.updateDevice({ ...base, metrics: [{ name: 'speed', value: 9, ts: 3 }] }); // no type later: still Int16
  assert.deepStrictEqual(sent.map((m) => m.topic.split('/')[2]), ['DBIRTH', 'DDATA', 'DDATA']);
  for (const m of sent) assert.strictEqual(m.metrics[0].datatypeName, 'Int16');

  assert.strictEqual(pub.setDeviceOnline({ ...base, online: false }), true);
  assert.strictEqual(sent[3].topic, 'spBv1.0/G/DDEATH/E/D');
  assert.strictEqual(pub.setDeviceOnline({ ...base, online: false }), false, 'DDEATH only once');
  assert.strictEqual(pub.setDeviceOnline({ ...base, online: true }), true);
  assert.strictEqual(sent[4].topic, 'spBv1.0/G/DBIRTH/E/D');
  assert.strictEqual(sent[4].metrics[0].datatypeName, 'Int16');
  assert.deepStrictEqual(sent.map((m) => Number(m.seq)), [0, 1, 2, 3, 4], 'seq increments across all messages');
  assert.strictEqual(pub.setDeviceOnline({ ...base, device: 'unknown', online: false }), false);
});

test('typed sample reaches sparkplug target; source-state drives DDEATH/DBIRTH', async () => {
  const calls = [];
  const spb = {
    updateDevice: (a) => calls.push({ kind: 'update', ...a }),
    setDeviceOnline: (a) => calls.push({ kind: 'online', ...a })
  };
  const b = mkBinding({ target: { mode: 'sparkplug', brokerId: 'br', group: 'G', edge: 'E', device: 'D' } });
  const { tb, opcua } = setup(b, { spb });
  opcua.emit('value', val(3, 'Good', 'Int16'));
  opcua.emit('connection-state', { connectionId: 'c1', state: 'offline', reason: 'x' });
  opcua.emit('connection-state', { connectionId: 'c1', state: 'online', reason: 'y' });
  await tick();
  assert.strictEqual(calls[0].metrics[0].type, 'int16');
  assert.deepStrictEqual(calls.slice(1).map((c) => c.online), [false, true]);
  tb.stop();
});

test('heartbeat republishes unchanged values', async () => {
  const b = mkBinding({ rbe: { heartbeatMs: 40 } });
  const { tb, mqtt, opcua } = setup(b, { tb: { heartbeatTickMs: 10 } });
  opcua.emit('value', val(1));
  opcua.emit('value', val(1));
  await tick(150);
  assert.ok(mqtt.published.length >= 3, `got ${mqtt.published.length}`);
  assert.ok(mqtt.published.every((p) => p.payload.v === 1 && p.payload.q === 192));
  tb.stop();

  const none = setup(mkBinding(), { tb: { heartbeatTickMs: 10 } });
  none.opcua.emit('value', val(1));
  await tick(80);
  assert.strictEqual(none.mqtt.published.length, 1, 'no heartbeat without rbe.heartbeatMs');
  none.tb.stop();
});

test('state is cleaned when a binding is deleted or edited; monitored set stays bounded', async () => {
  const { tb, mqtt, opcua, profiles } = setup();
  opcua.emit('value', val(1));
  await tick();
  assert.ok(tb.last.has('b1') && tb.status.has('b1'));
  assert.strictEqual(tb.monitored.size, 1);

  // edit: same id, different target -> state reset, republished as first value
  profiles.data.bindings.b1 = { ...profiles.data.bindings.b1, target: { ...profiles.data.bindings.b1.target, pathTemplate: 'uns/new/{name}' } };
  tb.reconcile();
  assert.ok(!tb.last.has('b1'));
  opcua.emit('value', val(1));
  await tick();
  assert.strictEqual(mqtt.published.at(-1).topic, 'uns/new/rpm');

  delete profiles.data.bindings.b1;
  tb.reconcile();
  assert.strictEqual(tb.last.size, 0);
  assert.strictEqual(tb.status.size, 0);
  assert.strictEqual(tb.sigs.size, 0);
  assert.strictEqual(tb.monitored.size, 0);
  tb.stop();
});

test('legacy opcua binding shape works unchanged, non-retained by default; custom sources can be registered', async () => {
  const { tb, mqtt, opcua } = setup(mkBinding({ target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'a/{name}', format: 'plain' } }));
  opcua.emit('value', val(42));
  await tick();
  assert.strictEqual(mqtt.published[0].payload, 42);
  assert.strictEqual(mqtt.published[0].opts.retain, false);
  tb.stop();

  // a fake device source through the generic registry (deviceId addressing)
  const mq = fakeMqtt();
  const dev = new EventEmitter();
  dev.mon = [];
  dev.ensureMonitored = async (id, addr, ms) => { dev.mon.push([id, addr, ms]); };
  const b = { id: 'm1', enabled: true,
    source: { type: 'modbus', deviceId: 'plc1', samplingInterval: 250, tags: [{ address: '40001', name: 'speed' }] },
    target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'm/{name}', format: 'envelope' } };
  const t2 = new TagBindings({ mqttManager: mq, opcuaManager: null, profiles: fakeProfiles({ bindings: { m1: b } }) });
  t2.registerSource('modbus', dev);
  t2.start();
  await tick();
  assert.deepStrictEqual(dev.mon, [['plc1', '40001', 250]]);
  dev.emit('sample', { sourceType: 'modbus', sourceId: 'plc1', address: '40001', v: 9, type: 'uint16', q: 192, tRead: Date.now() });
  await tick();
  assert.strictEqual(mq.published[0].topic, 'm/speed');
  assert.strictEqual(mq.published[0].payload.v, 9);
  t2.stop();
});

test('works when connection-state is never emitted (old behaviour)', async () => {
  const { tb, mqtt, opcua } = setup();
  await tick();
  opcua.emit('value', val(1));
  opcua.emit('value', val(2));
  await tick();
  assert.strictEqual(mqtt.published.length, 2);
  assert.strictEqual(opcua.monitorCalls.length, 1);
  assert.strictEqual(statusDocs(mqtt).length, 0);
  assert.strictEqual(tb.getStatus().b1.published, 2);
  tb.stop();
});
