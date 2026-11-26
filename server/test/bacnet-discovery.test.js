'use strict';

/**
 * Discovery: the opt-in BACnet/IP probe (unicast Who-Is + wildcard ReadProperty, then the device
 * object), through the real egress guard (loopback allowed only by MANIFOLD_ALLOW_LOOPBACK_DEVICES).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const DiscoveryService = require('../services/discovery');
const deviceIdentify = require('../services/deviceIdentify');
const { BacnetSimulator } = require('./support/bacnetSimulator');

const sims = [];
async function startSim(opts) {
  const sim = await new BacnetSimulator(opts).start();
  sims.push(sim);
  return sim;
}

after(async () => {
  for (const sim of sims) {
    assert.equal(sim.stats.writesReceived, 0, 'nothing but reads reached the device');
    assert.equal(sim.stats.broadcasts, 0, 'nothing was broadcast');
    await sim.stop();
  }
});

/** A UDP port that is bound but never answers. */
async function silentPort() {
  const s = dgram.createSocket('udp4');
  s.on('message', () => {});
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

function withLoopback(fn) {
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
      else process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
    });
}

test('identifyBacnet: unicast I-Am, then device name, vendor and model', async () => {
  const sim = await startSim({ deviceInstance: 260001, modelName: 'AHU-CTRL 9' });
  const r = await deviceIdentify.identifyBacnet('127.0.0.1', sim.port, { timeoutMs: 500 });
  assert.equal(r.protocol, 'bacnet-ip');
  assert.equal(r.method, 'who-is');
  assert.equal(r.identity.deviceInstance, 260001);
  assert.equal(r.identity.vendorId, 999);
  assert.equal(r.identity.vendorName, 'Manifold Test Vendor');
  assert.equal(r.identity.modelName, 'AHU-CTRL 9');
  assert.equal(r.identity.objectName, 'Sim AHU-1');
  assert.equal(r.identity.segmentation, 'no-segmentation');
  assert.equal(sim.stats.whoIs, 1);
});

test('identifyBacnet: a device that answers Who-Is only by broadcast is found by the wildcard read', async () => {
  const sim = await startSim({ iAmBroadcastOnly: true, rpm: false });
  const r = await deviceIdentify.identifyBacnet('127.0.0.1', sim.port, { timeoutMs: 500 });
  assert.equal(r.method, 'read-property');
  assert.equal(r.identity.deviceInstance, 1234);
  assert.equal(r.identity.modelName, 'SIM-BAC-1', 'ReadProperty fallback when RPM is rejected');
});

test('identifyBacnet: silence is null within the wait, and an abort ends it at once', async () => {
  const silent = await silentPort();
  try {
    let t = Date.now();
    assert.equal(await deviceIdentify.identifyBacnet('127.0.0.1', silent.port, { timeoutMs: 300 }), null);
    assert.ok(Date.now() - t < 1000);
    const ac = new AbortController();
    t = Date.now();
    const p = deviceIdentify.identifyBacnet('127.0.0.1', silent.port, { timeoutMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    assert.equal(await p, null);
    assert.ok(Date.now() - t < 1000, 'abort is immediate');
  } finally {
    await silent.close();
  }
});

test('plan: BACnet is opt-in by bacnetPorts only; includeDevices does not add it', async () => {
  await withLoopback(async () => {
    const d = new DiscoveryService({ emit() {} });
    const withDevices = await d.plan({ range: '127.0.0.1/32', includeDevices: true, includeI3x: false });
    assert.deepEqual(withDevices.kinds.bacnet, []);
    assert.ok(!withDevices.ports.includes(47808));
    const withBacnet = await d.plan({ range: '127.0.0.1/32', bacnetPorts: [47808], mqttPorts: [], opcuaPorts: [], includeI3x: false });
    assert.deepEqual(withBacnet.ports, [47808]);
    assert.equal(withBacnet.jobs[0].kinds[0], 'bacnet');
    assert.deepEqual(d.describe().ports.bacnet, [47808]);
  });
});

test('a scan finds the BACnet device, suggests it with its instance, and ignores a silent port', async () => {
  await withLoopback(async () => {
    const sim = await startSim({ deviceInstance: 4321 });
    const silent = await silentPort();
    const events = [];
    const d = new DiscoveryService({ emit: (n, p) => events.push([n, p]) });
    try {
      const done = new Promise((r) => d.once('done', r));
      await d.startScan({ range: '127.0.0.1/32', bacnetPorts: [sim.port, silent.port], mqttPorts: [], opcuaPorts: [], includeI3x: false, timeoutMs: 400 });
      const scan = await done;
      assert.equal(scan.status, 'complete');
      const results = d.getLastResults();
      assert.equal(results.length, 1);
      const r = results[0];
      assert.equal(r.kind, 'bacnet');
      assert.equal(r.protocol, 'bacnet-ip');
      assert.equal(r.port, sim.port);
      assert.equal(r.identity.deviceInstance, 4321);
      assert.deepEqual(r.suggestedDevice, { name: `SIM-BAC-1 127.0.0.1`, protocol: 'bacnet-ip', host: '127.0.0.1', port: sim.port, deviceInstance: 4321 });
      assert.equal(r.known, null);
      // known marker once the device exists
      d.deps.known = () => ({ devices: [{ id: 'x', name: 'AHU', host: '127.0.0.1', port: sim.port }] });
      assert.deepEqual(d.getLastResults()[0].known, { kind: 'device', id: 'x', name: 'AHU' });
    } finally {
      await silent.close();
    }
  });
});

test('without MANIFOLD_ALLOW_LOOPBACK_DEVICES a loopback BACnet scan is refused and sends nothing', async () => {
  const sim = await startSim();
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  try {
    const d = new DiscoveryService({ emit() {} });
    await assert.rejects(d.startScan({ range: '127.0.0.1/32', bacnetPorts: [sim.port], mqttPorts: [], opcuaPorts: [], includeI3x: false }), /loopback/);
    assert.equal(sim.stats.whoIs + sim.stats.requests, 0);
  } finally {
    if (prev !== undefined) process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
  }
});
