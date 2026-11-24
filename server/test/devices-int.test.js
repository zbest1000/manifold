const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { DeviceManager, DeviceValidationError } = require('../services/deviceManager');
const { TagBindings } = require('../services/tagBindings');
const { startSimulator } = require('./support/modbusSimulator');

// End to end: Modbus simulator <- driver in a real child host process <-
// supervisor <- DeviceManager -> TagBindings -> (fake) broker publish.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function memoryProfiles() {
  const data = { devices: {}, bindings: {} };
  return {
    data,
    rev: 0,
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null,
    upsertIn(c, id, obj) {
      data[c][id] = { ...obj, id };
      this.rev++;
      return data[c][id];
    },
    removeIn(c, id) {
      if (!data[c][id]) return false;
      delete data[c][id];
      this.rev++;
      return true;
    }
  };
}

function fakeBroker() {
  const m = new EventEmitter();
  m.published = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    m.published.push({ topic, payload, opts });
  };
  return m;
}

async function setup() {
  const sim = await startSimulator({ port: 0, units: { 1: { holding: {} } } });
  sim.setFloat32(1, 'holding', 100, 21.5);
  sim.setRegister(1, 'holding', 102, 7);
  const profiles = memoryProfiles();
  const mqtt = fakeBroker();
  const devices = new DeviceManager({
    profiles,
    guard: async () => {}, // the simulator listens on loopback
    supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } }
  });
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null });
  bindings.registerSource('device', devices);
  bindings.start();
  await devices.start();
  const device = {
    name: 'Meter 1',
    protocol: 'modbus-tcp',
    host: '127.0.0.1',
    port: sim.port,
    unitId: 1,
    limits: { requestDeadlineMs: 300, connectTimeoutMs: 500 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [
      { key: 'temp', address: 'holding:100', type: 'float32', pollGroup: 'fast', unit: 'degC', property: 'temperature' },
      { key: 'count', address: '40103', type: 'uint16', pollGroup: 'fast' }
    ]
  };
  const values = (topic) => mqtt.published.filter((p) => p.topic === topic).map((p) => p.payload);
  const cleanup = async () => {
    bindings.stop();
    await devices.stop();
    await sim.close();
  };
  return { sim, profiles, mqtt, devices, bindings, device, values, cleanup };
}

test('device tags flow through a binding into the UNS, and go Bad when the device is lost', async () => {
  const t = await setup();
  try {
    const saved = await t.devices.save(t.device);
    t.profiles.upsertIn('bindings', 'b1', {
      enabled: true,
      source: { type: 'device', deviceId: saved.id, tags: [{ address: 'temp', name: 'temperature' }, { address: 'count', name: 'count' }] },
      target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'acme/line1/meter/{name}', format: 'envelope' }
    });
    t.bindings.reconcile();

    await until(() => t.values('acme/line1/meter/temperature').length >= 1, 8000, 'first sample');
    const first = t.values('acme/line1/meter/temperature')[0];
    assert.ok(Math.abs(first.v - 21.5) < 1e-6);
    assert.strictEqual(first.q, 192);
    assert.strictEqual(t.values('acme/line1/meter/count')[0].v, 7);
    assert.strictEqual(t.devices.list()[0].status.state, 'online');
    assert.strictEqual(t.devices.getValues(saved.id).count.v, 7);

    // report by exception: an unchanged value is not republished every cycle
    await sleep(350);
    assert.strictEqual(t.values('acme/line1/meter/count').length, 1);

    // value change
    t.sim.setRegister(1, 'holding', 102, 8);
    await until(() => t.values('acme/line1/meter/count').some((p) => p.v === 8), 4000, 'changed value');

    // device lost: Bad quality once, status topic offline
    t.sim.faults.blackhole = true;
    await until(() => t.values('acme/line1/meter/count').some((p) => p.q === 0), 6000, 'bad quality');
    await until(() => t.values('acme/line1/meter/_status').some((s) => s.online === false), 4000, 'offline status');

    // recovery: Good again without operator action
    t.sim.faults.blackhole = false;
    await until(() => {
      const v = t.values('acme/line1/meter/count');
      return v.length && v[v.length - 1].q === 192;
    }, 8000, 'recovery');
    assert.strictEqual(t.sim.stats.writesReceived, 0);
  } finally {
    await t.cleanup();
  }
});

test('invalid devices are rejected with per-tag details and nothing is stored', async () => {
  const t = await setup();
  try {
    await assert.rejects(
      t.devices.save({ ...t.device, tags: [{ key: 'bad', address: '12345', type: 'uint16' }, { key: 'ok', address: 'holding:1', type: 'uint16' }] }),
      (error) => error instanceof DeviceValidationError && error.details.length === 1 && error.details[0].key === 'bad'
    );
    await assert.rejects(t.devices.save({ ...t.device, protocol: 'nope' }), DeviceValidationError);
    await assert.rejects(t.devices.save({ ...t.device, pollGroups: [{ id: 'x', intervalMs: 5 }] }), /at least/);
    assert.strictEqual(t.profiles.listIn('devices').length, 0);
    const res = t.devices.validateTags('modbus-tcp', {}, [{ key: 'a', address: '40001', type: 'uint16' }, { key: 'a', address: '40002', type: 'uint16' }]);
    assert.deepStrictEqual(res.map((r) => r.ok), [true, false]);
    assert.strictEqual(res[0].normalized.offset, 0);
  } finally {
    await t.cleanup();
  }
});

test('test connection and probe work against the simulator; the egress guard blocks by default', async () => {
  const t = await setup();
  try {
    const ok = await t.devices.test(t.device);
    assert.strictEqual(ok.ok, true);
    const bad = await t.devices.test({ ...t.device, port: 1 });
    assert.strictEqual(bad.ok, false);

    const saved = await t.devices.save(t.device);
    await until(() => t.devices.list()[0].status.state === 'online', 8000, 'online');
    const probe = await t.devices.probe(saved.id, { address: 'holding:100', count: 2 });
    assert.ok(Math.abs(probe.decodings.ABCD.float32 - 21.5) < 1e-6);

    // default guard: loopback is refused unless explicitly allowed
    const guarded = new DeviceManager({ profiles: memoryProfiles() });
    delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
    await assert.rejects(guarded.save(t.device));
    await guarded.stop();
  } finally {
    await t.cleanup();
  }
});

test('an S7 device flows through the same runtime, manager and binding path', async () => {
  const { createS7Simulator } = require('./support/s7Simulator');
  const db = Buffer.alloc(16);
  db.writeFloatBE(73.25, 0);
  db.writeInt16BE(-12, 4);
  db[6] = 0b00000010; // DBX6.1
  const plc = createS7Simulator({ maxPdu: 240, dbs: { 10: db } });
  await plc.start();
  const profiles = memoryProfiles();
  const mqtt = fakeBroker();
  const devices = new DeviceManager({ profiles, guard: async () => {}, supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } } });
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null });
  bindings.registerSource('device', devices);
  bindings.start();
  await devices.start();
  try {
    assert.ok(devices.protocols().some((p) => p.id === 's7'));
    const saved = await devices.save({
      name: 'Filler PLC',
      protocol: 's7',
      host: '127.0.0.1',
      port: plc.port,
      rack: 0,
      slot: 1,
      limits: { requestDeadlineMs: 300, connectTimeoutMs: 500 },
      pollGroups: [{ id: 'default', intervalMs: 100 }],
      tags: [
        { key: 'speed', address: 'DB10.DBD0', type: 'REAL' },
        { key: 'trim', address: 'DB10.DBW4', type: 'INT' },
        { key: 'running', address: 'DB10.DBX6.1', type: 'BOOL' }
      ]
    });
    profiles.upsertIn('bindings', 'b1', {
      enabled: true,
      source: { type: 'device', deviceId: saved.id, tags: ['speed', 'trim', 'running'].map((k) => ({ address: k, name: k })) },
      target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'acme/line1/filler/{name}', format: 'envelope' }
    });
    bindings.reconcile();
    const values = (name) => mqtt.published.filter((p) => p.topic === `acme/line1/filler/${name}`).map((p) => p.payload);
    await until(() => values('running').length >= 1, 8000, 'first S7 sample');
    assert.strictEqual(values('speed')[0].v, 73.25);
    assert.strictEqual(values('trim')[0].v, -12);
    assert.strictEqual(values('running')[0].v, true);
    assert.strictEqual(values('speed')[0].q, 192);

    await assert.rejects(
      devices.save({ name: 'x', protocol: 's7', host: '127.0.0.1', port: plc.port, rack: 0, slot: 1, tags: [{ key: 'bad', address: 'DB10.NOPE', type: 'INT' }] }),
      (error) => error instanceof DeviceValidationError && error.details[0].key === 'bad'
    );
    assert.strictEqual(plc.stats.writesReceived, 0);
    assert.strictEqual(plc.stats.controlReceived, 0);
  } finally {
    bindings.stop();
    await devices.stop();
    await plc.stop?.();
    await plc.close?.();
  }
});

test('an EtherNet/IP device reads, browses the controller, and never writes', async () => {
  const { EipSimulator } = require('./support/eipSimulator');
  const plc = await new EipSimulator().start();
  const profiles = memoryProfiles();
  const mqtt = fakeBroker();
  const devices = new DeviceManager({ profiles, guard: async () => {}, supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } } });
  const bindings = new TagBindings({ mqttManager: mqtt, profiles, sparkplugPublisher: null });
  bindings.registerSource('device', devices);
  bindings.start();
  await devices.start();
  try {
    const saved = await devices.save({
      name: 'Line PLC',
      protocol: 'ethernet-ip',
      host: '127.0.0.1',
      port: plc.port,
      slot: 0,
      limits: { requestDeadlineMs: 500, connectTimeoutMs: 1000 },
      pollGroups: [{ id: 'default', intervalMs: 100 }],
      tags: [
        { key: 'count', address: 'DintTag' },
        { key: 'ratio', address: 'RealTag' },
        { key: 'motorSpeed', address: 'Motor.Speed' },
        { key: 'local', address: 'Program:MainProgram.LocalDint' }
      ]
    });
    profiles.upsertIn('bindings', 'b1', {
      enabled: true,
      source: { type: 'device', deviceId: saved.id, tags: ['count', 'ratio', 'motorSpeed'].map((k) => ({ address: k, name: k })) },
      target: { mode: 'mqtt', brokerId: 'br', pathTemplate: 'acme/line1/plc/{name}', format: 'envelope' }
    });
    bindings.reconcile();
    const values = (name) => mqtt.published.filter((p) => p.topic === `acme/line1/plc/${name}`).map((p) => p.payload);
    await until(() => values('motorSpeed').length >= 1, 8000, 'first EtherNet/IP sample');
    assert.strictEqual(values('count')[0].v, 123456);
    assert.strictEqual(values('ratio')[0].v, 3.5);
    assert.strictEqual(values('motorSpeed')[0].v, 1450.5);
    assert.strictEqual(values('count')[0].q, 192);

    // controller browse goes through the host process
    const root = await devices.browse(saved.id);
    assert.ok(root.some((n) => n.id === 'controller'));
    const ctl = await devices.browse(saved.id, 'controller');
    assert.ok(ctl.some((n) => n.name === 'DintTag' && n.kind === 'tag'));

    // a non-browsable protocol says so instead of failing obscurely
    assert.throws(() => devices.browse('missing'), DeviceValidationError);
    assert.strictEqual(plc.stats.writesReceived, 0);
  } finally {
    bindings.stop();
    await devices.stop();
    await plc.stop?.();
    await plc.close?.();
  }
});
