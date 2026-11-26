'use strict';

// End to end: CoAP simulator <- driver in a real child host process <- supervisor <- DeviceManager.

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceManager, DeviceValidationError } = require('../services/deviceManager');
const { CoapSimulator } = require('./support/coapSimulator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
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

async function setup() {
  const sim = await new CoapSimulator().start();
  const devices = new DeviceManager({ profiles: memoryProfiles(), guard: async () => {}, supervisorOptions: { backoff: { initialMs: 50, maxMs: 200 } } });
  await devices.start();
  const device = {
    name: 'Sensor 1',
    protocol: 'coap',
    host: '127.0.0.1',
    port: sim.port,
    options: { ackTimeoutMs: 100, maxRetransmit: 2, observeGraceMs: 50 },
    limits: { requestDeadlineMs: 700, connectTimeoutMs: 800 },
    pollGroups: [{ id: 'fast', intervalMs: 100 }],
    tags: [
      { key: 'temp', address: '/json#temperature', pollGroup: 'fast', unit: 'Cel' },
      { key: 'door', address: '/senml#urn:dev:ow:10e2073a01080063:door', pollGroup: 'fast' },
      { key: 'live', address: 'observe:/obs', pollGroup: 'fast' },
      { key: 'half', address: '/cbor#half', type: 'number', pollGroup: 'fast' }
    ]
  };
  return {
    sim,
    devices,
    device,
    cleanup: async () => {
      await devices.stop();
      assert.equal(sim.stats.nonGetReceived, 0, 'the driver sent a request that was not a GET');
      await sim.stop();
    }
  };
}

test('the descriptor is served with the other protocols, experimental and read-only', async () => {
  const t = await setup();
  try {
    const p = t.devices.protocols().find((x) => x.id === 'coap');
    assert.ok(p);
    assert.equal(p.experimental, true);
    assert.equal(p.readOnly, true);
    assert.equal(p.defaultPort, 5683);
    assert.equal(p.capabilities.browse, true);
    assert.deepEqual(p.tagTypes, ['number', 'bool', 'string']);
    assert.equal(p.tagTypeOptional, true);
    assert.ok(p.optionFields.some((f) => f.name === 'connectCheck'));
  } finally {
    await t.cleanup();
  }
});

test('values flow into the device manager; observe notifications arrive; the device is lost and found again', async () => {
  const t = await setup();
  try {
    const saved = await t.devices.save(t.device);
    await until(() => t.devices.list()[0].status.state === 'online', 8000, 'online');
    await until(() => Object.keys(t.devices.getValues(saved.id)).length === 4, 8000, 'all four tags');
    const v = () => t.devices.getValues(saved.id);
    assert.equal(v().temp.v, 21.5);
    assert.equal(v().temp.q, 192);
    assert.equal(v().door.v, true);
    assert.equal(v().live.v, 1);
    assert.equal(v().half.v, 10);

    t.sim.notify('/obs', { body: '2' });
    await until(() => v().live.v === 2, 4000, 'notification');
    // the observed tag is served from the notification: after registration the device is not asked again
    const obsGets = t.sim.requests.filter((q) => q.path === '/obs').length;
    await sleep(400);
    assert.equal(t.sim.requests.filter((q) => q.path === '/obs').length, obsGets);

    // a Not Found resource is Bad with its code name while the rest keeps flowing
    t.sim.setResource('/json', null);
    await until(() => v().temp.q === 0 && v().temp.qReason === '4.04 Not Found', 4000, 'Bad with the code name');
    assert.equal(v().door.q, 192);
    t.sim.resources['/json'] = { cf: 50, body: '{"temperature": 22.5}' };
    await until(() => v().temp.v === 22.5 && v().temp.q === 192, 4000, 'back to Good');

    // dead device: nothing answers, so the device goes offline with the reason
    t.sim.faults.silent = true;
    await until(() => t.devices.list()[0].status.state === 'offline', 8000, 'offline');
    await until(() => /timeout: no response/.test(t.devices.list()[0].status.lastError || t.devices.list()[0].status.reason || ''), 6000, 'the reason');
    await until(() => Object.values(v()).every((s) => s.q === 0), 4000, 'every tag Bad');
    t.sim.faults.silent = false;
    await until(() => t.devices.list()[0].status.state === 'online' && v().temp.q === 192, 12000, 'recovered');
  } finally {
    await t.cleanup();
  }
});

test('test connection, probe and browse go through the manager', async () => {
  const t = await setup();
  try {
    const ok = await t.devices.test(t.device);
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.info.rttMs, 'number');

    const dead = new CoapSimulator();
    await dead.start();
    const port = dead.port;
    await dead.stop();
    const bad = await t.devices.test({ ...t.device, port });
    assert.equal(bad.ok, false);

    const saved = await t.devices.save(t.device);
    await until(() => t.devices.list()[0].status.state === 'online', 8000, 'online');
    const probe = await t.devices.probe(saved.id, { address: '/senml#urn:dev:ow:10e2073a01080063:temp' });
    assert.equal(probe.decodings.value, 21.5);
    assert.equal(probe.decodings.unit, 'Cel');
    const nodes = await t.devices.browse(saved.id);
    assert.ok(nodes.some((n) => n.address === '/senml'));
    const kids = await t.devices.browse(saved.id, 'res:/senml');
    assert.ok(kids.some((n) => n.meta.unit === 'Cel'));
  } finally {
    await t.cleanup();
  }
});

test('coaps:// and the DTLS port are refused with a clear message; bad tags are reported per tag', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.devices.save({ ...t.device, host: 'coaps://sensor.example' }), (e) => e instanceof DeviceValidationError && /DTLS/.test(e.message));
    await assert.rejects(t.devices.save({ ...t.device, port: 5684 }), /DTLS/);
    await assert.rejects(
      t.devices.save({ ...t.device, tags: [{ key: 'a', address: 'coaps://h/x' }, { key: 'b', address: '/ok' }, { key: 'c', address: '/x', type: 'DINT' }] }),
      (e) => e instanceof DeviceValidationError && e.details.length === 2 && /DTLS/.test(e.details[0].error)
    );
    assert.equal(t.devices.list().length, 0);
  } finally {
    await t.cleanup();
  }
});
