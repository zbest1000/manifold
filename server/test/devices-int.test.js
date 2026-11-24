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
