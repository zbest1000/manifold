'use strict';

/**
 * The real TagBindings engine fed by the real OpcuaManager from a REAL OPC UA
 * server (support/opcuaTestServer.js): envelope values with quality and source
 * timestamps, Good -> Bad on a status change, Bad on connection loss, Good
 * again after recovery, typed Sparkplug metrics from OPC UA types, server
 * metadata (EUInformation / EURange) through the source adapter. Then the
 * HTTP surface the UI uses for OPC UA: connections, browse, the tags browse
 * route for type=opcua and UNS mounts of an OPC UA address space.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { useTempDataDir, until, FAST, makeIo } = require('./support/opcuaTestKit');

useTempDataDir('manifold-bindings-opcua-real-');
const { startOpcuaTestServer } = require('./support/opcuaTestServer');
const OpcuaManager = require('../services/opcuaManager');
const { TagBindings } = require('../services/tagBindings');
const { OpcuaSource } = require('../services/tagSources/opcuaSource');

let srv;
before(async () => {
  srv = await startOpcuaTestServer({ largeCount: 20 });
});
after(async () => {
  await srv.close();
});

function profilesWith(bindings) {
  const profiles = {
    data: { bindings: Object.fromEntries(bindings.map((b) => [b.id, b])) },
    listIn: (c) => Object.values(profiles.data[c] || {}),
    getIn: (c, id) => (profiles.data[c] || {})[id] || null
  };
  return profiles;
}

function fakeMqtt() {
  const mqtt = new EventEmitter();
  mqtt.published = [];
  mqtt.publish = async (brokerId, topic, payload, opts) => {
    mqtt.published.push({ topic, payload, opts });
  };
  mqtt.on = () => mqtt; // no broker messages in these tests
  return mqtt;
}

test('envelope binding: values, quality and source time from the server; Bad on status and on outage; Good after recovery', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  const { io } = makeIo();
  const mgr = new OpcuaManager(io, FAST);
  const binding = {
    id: 'b1',
    enabled: true,
    source: {
      type: 'opcua',
      connectionId: 'c1',
      samplingInterval: 0,
      tags: [
        { address: own.nodeId('Quality.Value'), name: 'level' },
        { address: own.nodeId('Scalars.Int64'), name: 'counter' }
      ]
    },
    target: { mode: 'mqtt', brokerId: 'br', assetPath: 'acme/line1/tank', format: 'envelope' }
  };
  const mqtt = fakeMqtt();
  const tb = new TagBindings({ mqttManager: mqtt, opcuaManager: mgr, profiles: profilesWith([binding]), sparkplugPublisher: null, retryMs: 200 });
  const on = (topic) => mqtt.published.filter((p) => p.topic === topic).map((p) => p.payload);
  const level = () => on('acme/line1/tank/level');
  try {
    tb.start();
    await mgr.connect({ id: 'c1', endpointUrl: own.endpointUrl }, { supervise: true });

    const t0 = new Date('2026-03-04T05:06:07.000Z');
    own.set('Quality.Value', 12.5, { sourceTimestamp: t0 });
    await until(() => level().some((p) => p.v === 12.5), 10_000, 'first value');
    const first = level().find((p) => p.v === 12.5);
    assert.strictEqual(first.q, 192);
    assert.strictEqual(first.t, t0.getTime(), 'the source timestamp travels, not the arrival time');
    await until(() => on('acme/line1/tank/counter').length > 0, 5000, 'Int64 value');
    assert.strictEqual(on('acme/line1/tank/counter')[0].v, '9223372036854775807', 'Int64 travels as an exact decimal string');
    await until(() => on('acme/line1/tank/_status').some((s) => s.online === true), 5000, 'online status');
    await until(() => on('acme/line1/tank/_meta').length > 0, 5000, '_meta document');
    assert.deepStrictEqual(on('acme/line1/tank/_meta').at(-1).properties.level.source, { connectionId: 'c1', address: own.nodeId('Quality.Value') });

    // status change with the value unchanged -> one Bad publish with the same value
    const t1 = new Date('2026-03-04T05:06:08.000Z');
    own.setStatus('Quality.Value', 'BadSensorFailure', { sourceTimestamp: t1 });
    await until(() => level().some((p) => p.q === 0), 5000, 'Bad quality');
    const bad = level().find((p) => p.q === 0);
    assert.strictEqual(bad.v, 12.5);
    assert.strictEqual(bad.t, t1.getTime());
    own.setStatus('Quality.Value', 'UncertainLastUsableValue');
    await until(() => level().some((p) => p.q === 64), 5000, 'Uncertain quality');
    own.set('Quality.Value', 13);
    await until(() => level().some((p) => p.v === 13 && p.q === 192), 5000, 'Good again');

    // outage: every tag of the binding gets exactly one Bad, the status document goes offline
    const mark = level().length;
    await own.stop();
    await until(() => level().slice(mark).some((p) => p.q === 0), 10_000, 'Bad on connection loss');
    await until(() => on('acme/line1/tank/_status').at(-1).online === false, 5000, 'offline status');
    assert.strictEqual(level().slice(mark).filter((p) => p.q === 0).length, 1);
    assert.strictEqual(level().slice(mark).find((p) => p.q === 0).v, 13, 'the last value is kept, marked Bad');

    // recovery: monitors come back on the new session and the value publishes Good again
    await own.start();
    await until(() => level().slice(mark).some((p) => p.q === 192), 15_000, 'Good after recovery');
    await until(() => on('acme/line1/tank/_status').at(-1).online === true, 5000, 'online status again');
    own.set('Quality.Value', 14);
    await until(() => level().some((p) => p.v === 14 && p.q === 192), 5000, 'values flowing after recovery');
    assert.strictEqual(own.monitoredItemCount(), 2, 'no duplicate monitored items after recovery');
  } finally {
    tb.stop();
    await mgr.shutdown();
    await own.close();
  }
});

test('sparkplug binding: OPC UA built-in types become typed metrics; arrays and structures travel untyped', async () => {
  const { io } = makeIo();
  const mgr = new OpcuaManager(io, FAST);
  const names = ['Boolean', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Float', 'Double', 'String', 'DateTime'];
  const binding = {
    id: 'sp1',
    enabled: true,
    source: {
      type: 'opcua',
      connectionId: 'c2',
      samplingInterval: 0,
      tags: [...names.map((n) => ({ address: srv.nodeId(`Scalars.${n}`), name: n })), { address: srv.nodeId('Arrays.DoubleArray'), name: 'arr' }, { address: srv.nodeId('Structs.Range'), name: 'range' }]
    },
    target: { mode: 'sparkplug', brokerId: 'br', group: 'G', edge: 'E', device: 'D' }
  };
  const metrics = new Map();
  const spb = {
    updateDevice: ({ metrics: ms }) => {
      for (const m of ms) metrics.set(m.name, m);
    },
    setDeviceOnline: () => {}
  };
  const tb = new TagBindings({ mqttManager: fakeMqtt(), opcuaManager: mgr, profiles: profilesWith([binding]), sparkplugPublisher: spb, retryMs: 200 });
  try {
    tb.start();
    await mgr.connect({ id: 'c2', endpointUrl: srv.endpointUrl });
    await until(() => metrics.size === names.length + 2, 10_000, 'every metric');
    const expected = {
      Boolean: ['bool', true],
      SByte: ['int8', -8],
      Byte: ['uint8', 200],
      Int16: ['int16', -1234],
      UInt16: ['uint16', 54321],
      Int32: ['int32', -123456789],
      UInt32: ['uint32', 3000000000],
      Int64: ['int64', '9223372036854775807'],
      UInt64: ['uint64', '18446744073709551614'],
      Float: ['float32', 1.5],
      String: ['string', 'hello'],
      DateTime: ['datetime', '2026-01-02T03:04:05.000Z']
    };
    for (const [name, [type, value]] of Object.entries(expected)) {
      assert.strictEqual(metrics.get(name).type, type, `${name} type`);
      assert.deepStrictEqual(metrics.get(name).value, value, `${name} value`);
    }
    assert.strictEqual(metrics.get('Double').type, 'float64');
    assert.ok(Math.abs(metrics.get('Double').value - 3.14159) < 1e-9);
    assert.strictEqual(metrics.get('arr').type, undefined, 'an array is not a float64 scalar');
    assert.deepStrictEqual(metrics.get('arr').value, [1.5, 2.5, 3.5]);
    assert.strictEqual(metrics.get('range').type, undefined);
    assert.deepStrictEqual({ low: metrics.get('range').value.low, high: metrics.get('range').value.high }, { low: -10, high: 90 });
  } finally {
    tb.stop();
    await mgr.shutdown();
  }
});

test('the OPC UA page stopping a node a binding maps keeps the binding flowing (monitor owners)', async () => {
  const own = await startOpcuaTestServer({ largeCount: 1 });
  const { io } = makeIo();
  const mgr = new OpcuaManager(io, FAST);
  const node = own.nodeId('Scalars.Double');
  const binding = {
    id: 'own1',
    enabled: true,
    source: { type: 'opcua', connectionId: 'c4', samplingInterval: 0, tags: [{ address: node, name: 'speed' }] },
    target: { mode: 'mqtt', brokerId: 'br', assetPath: 'acme/own', format: 'envelope' }
  };
  const mqtt = fakeMqtt();
  const tb = new TagBindings({ mqttManager: mqtt, opcuaManager: mgr, profiles: profilesWith([binding]), sparkplugPublisher: null, retryMs: 200 });
  const speed = () => mqtt.published.filter((p) => p.topic === 'acme/own/speed').map((p) => p.payload.v);
  try {
    tb.start();
    await mgr.connect({ id: 'c4', endpointUrl: own.endpointUrl });
    await until(() => own.monitoredItemCount() === 1, 5000, 'binding monitor');
    // the page monitors the same node, then stops it again
    assert.strictEqual((await mgr.monitor('c4', node, 0)).status, 'already-monitored');
    assert.deepStrictEqual(mgr.getConnections()[0].monitorOwners[node].sort(), ['bindings', 'user']);
    const stop = await mgr.unmonitor('c4', node);
    assert.deepStrictEqual(stop, { connectionId: 'c4', nodeId: node, status: 'still-monitored', owners: ['bindings'] });
    assert.strictEqual(own.monitoredItemCount(), 1, 'the item stays on the server');
    own.set('Scalars.Double', 77.5);
    await until(() => speed().includes(77.5), 5000, 'binding still receives values');
  } finally {
    tb.stop();
    await mgr.shutdown();
    await own.close();
  }
});

test('source adapter: describe() supplies unit, range, type and description from the server', async () => {
  const { io } = makeIo();
  const mgr = new OpcuaManager(io, FAST);
  const source = new OpcuaSource(mgr);
  try {
    await mgr.connect({ id: 'c3', endpointUrl: srv.endpointUrl });
    const temp = await source.describe('c3', srv.nodeId('Analog.Temperature'));
    assert.strictEqual(temp.type, 'float64');
    assert.strictEqual(temp.unit, '°C');
    assert.deepStrictEqual(temp.range, { low: 0, high: 150 });
    const plain = await source.describe('c3', srv.nodeId('Scalars.Int16'));
    assert.deepStrictEqual(plain, { type: 'int16', unit: null, range: null, description: null });
  } finally {
    source.close();
    await mgr.shutdown();
  }
});

// ---------------------------------------------------------------------------
// HTTP: the routes the OPC UA page, the Tags page and UNS mounts use
// ---------------------------------------------------------------------------

test('HTTP: connect, browse, tags browse for type=opcua, UNS mount of the connection, delete', async () => {
  process.env.PORT = '0';
  process.env.MANIFOLD_NO_RESTORE = '1';
  const app = require('../index');
  const server = app.server;
  const services = app.app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const bad = await call('POST', '/api/opcua/connections', { endpointUrl: 'http://nope' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /opc\.tcp:\/\/host:4840/);

    const created = await call('POST', '/api/opcua/connections', { id: 'h1', name: 'Test server', endpointUrl: srv.endpointUrl });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));

    const sources = await call('GET', '/api/tags/sources');
    assert.ok(sources.body.sources.some((s) => s.type === 'opcua' && s.id === 'h1' && s.label === 'Test server'));

    const top = await call('GET', `/api/tags/browse?type=opcua&id=h1&node=${encodeURIComponent('ns=0;i=85')}`);
    assert.strictEqual(top.status, 200);
    const manifold = top.body.children.find((c) => c.name === 'Manifold');
    assert.ok(manifold, 'Objects/Manifold is listed');
    assert.strictEqual(manifold.kind, 'folder');
    const scalars = await call('GET', `/api/tags/browse?type=opcua&id=h1&node=${encodeURIComponent(srv.nodeId('Scalars'))}`);
    const dbl = scalars.body.children.find((c) => c.name === 'Double');
    assert.deepStrictEqual({ kind: dbl.kind, address: dbl.address }, { kind: 'tag', address: srv.nodeId('Scalars.Double') });
    const large = await call('GET', `/api/tags/browse?type=opcua&id=h1&node=${encodeURIComponent(srv.nodeId('Large'))}`);
    assert.strictEqual(large.body.children.length, 20);

    const read = await call('GET', `/api/opcua/connections/h1/read?nodeId=${encodeURIComponent(srv.nodeId('Analog.Temperature'))}`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.engineeringUnits.displayName, '°C');
    const unknown = await call('GET', `/api/opcua/connections/h1/browse?nodeId=${encodeURIComponent('ns=1;s=Nope')}`);
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.body.error, /does not exist/);

    // UNS mount of the OPC UA address space (the UNS page browses it through /api/opcua)
    const mount = await call('POST', '/api/uns/mounts', { type: 'opcua', connectionId: 'h1', label: 'Line PLC', nodeId: srv.nodeId('Manifold') });
    assert.strictEqual(mount.status, 201);
    const mounts = await call('GET', '/api/uns/mounts');
    const m = mounts.body.mounts.find((x) => x.id === mount.body.id);
    assert.strictEqual(m.connectionId, 'h1');
    const under = await call('GET', `/api/opcua/connections/${m.connectionId}/browse?nodeId=${encodeURIComponent(m.nodeId)}`);
    assert.deepStrictEqual(
      under.body.references.map((r) => r.browseName.replace(/^\d+:/, '')).sort(),
      ['Analog', 'Arrays', 'Deep', 'Large', 'Quality', 'Scalars', 'Slow', 'Structs']
    );
    assert.strictEqual((await call('DELETE', `/api/uns/mounts/${m.id}`)).status, 200);

    assert.strictEqual((await call('DELETE', '/api/opcua/connections/h1')).status, 200);
    assert.strictEqual(srv.sessionCount(), 0);
  } finally {
    await services.opcuaManager.shutdown();
    services.mqttManager?.shutdown();
    services.history?.stop();
    services.alerts?.stop();
    services.pipelines?.stop();
    services.recorder?.stop();
    services.replayer?.stop();
    services.contracts?.stop();
    services.models?.stop();
    server.close();
  }
});
