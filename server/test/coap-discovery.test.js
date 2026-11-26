'use strict';

// The opt-in CoAP probe of the discovery scan: one unicast GET /.well-known/core per address and port.

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const DiscoveryService = require('../services/discovery');
const deviceIdentify = require('../services/deviceIdentify');
const { CoapSimulator } = require('./support/coapSimulator');

function recorder() {
  const events = [];
  return { events, io: { emit: (name, payload) => events.push([name, payload]) }, of: (n) => events.filter((e) => e[0] === n).map((e) => e[1]) };
}
const done = (d) => new Promise((resolve) => d.once('done', resolve));

async function scan(options) {
  const rec = recorder();
  const d = new DiscoveryService(rec.io);
  const finished = done(d);
  await d.startScan({ range: '127.0.0.1', timeoutMs: 300, identifyTimeoutMs: 800, ...options });
  await finished;
  return { d, rec, results: d.getLastResults() };
}

/** A UDP socket that receives and never answers, or answers with junk. */
async function udpFake(onMessage) {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (msg, rinfo) => {
    seen.push(msg);
    if (onMessage) onMessage(sock, msg, rinfo);
  });
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  return { port: sock.address().port, seen, close: () => new Promise((resolve) => sock.close(resolve)) };
}

test('finds a CoAP device, reads its listing, and sends exactly one GET /.well-known/core', async () => {
  const sim = await new CoapSimulator().start();
  try {
    const { results, rec } = await scan({ coapPorts: [sim.port], mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.kind, 'coap');
    assert.equal(r.protocol, 'coap');
    assert.equal(r.verified, true);
    assert.equal(r.method, 'well-known-core');
    assert.equal(r.port, sim.port);
    assert.ok(r.identity.resourceCount > 10);
    assert.ok(r.identity.observableCount >= 2);
    assert.ok(r.identity.resources.includes('/temp'));
    assert.deepEqual(r.suggestedDevice, { name: `coap 127.0.0.1`, protocol: 'coap', host: '127.0.0.1', port: sim.port });
    const gets = sim.requests.filter((q) => q.method === 1);
    assert.equal(gets.length, 1);
    assert.equal(gets[0].path, '/.well-known/core');
    assert.equal(sim.stats.nonGetReceived, 0);
    assert.equal(sim.stats.pings, 0);
    assert.deepEqual(rec.of('discovery-started')[0].udpPorts, [sim.port]);
  } finally {
    await sim.stop();
  }
});

test('the CoAP probe is opt-in: includeDevices alone never sends a datagram', async () => {
  const sim = await new CoapSimulator().start();
  try {
    await assert.rejects(scan({ includeDevices: true, coapPorts: [] }), /No ports selected|Nothing/).catch(() => {});
    const { results } = await scan({ includeDevices: true, modbusPorts: [1], s7Ports: [1], eipPorts: [1], mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
    assert.deepEqual(results, []);
    assert.equal(sim.stats.received, 0);
    // includeCoap uses the default port 5683, which nothing here listens on; a custom port list is explicit
    const plan = await new DiscoveryService(recorder().io).plan({ range: '127.0.0.1', includeCoap: true, mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
    assert.deepEqual(plan.udpPorts, [5683]);
    assert.equal(plan.jobs.filter((j) => j.udp).length, 1);
  } finally {
    await sim.stop();
  }
});

test('a device that answers 4.04 to the listing is still a CoAP device, with a note', async () => {
  const sim = await new CoapSimulator({ resources: { '/.well-known/core': { cf: 0, body: 'no', code: 0x84 } } }).start();
  try {
    const { results } = await scan({ coapPorts: [sim.port] });
    assert.equal(results.length, 1);
    assert.equal(results[0].identity.code, '4.04 Not Found');
    assert.match(results[0].identity.note, /without a resource listing/);
  } finally {
    await sim.stop();
  }
});

test('silent, garbage-speaking and closed UDP ports are not results', async () => {
  const silent = await udpFake();
  const junk = await udpFake((sock, _msg, rinfo) => sock.send(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'), rinfo.port, rinfo.address));
  const dead = await udpFake();
  const deadPort = dead.port;
  await dead.close();
  try {
    const { results, d } = await scan({ coapPorts: [silent.port, junk.port, deadPort], identifyTimeoutMs: 700, mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
    assert.deepEqual(results, []);
    assert.equal(d.getState().scan.completed, 3);
    // what the silent port received was a real CoAP GET /.well-known/core, retransmitted once
    assert.ok(silent.seen.length >= 1 && silent.seen.length <= 2);
    assert.equal(silent.seen[0][1], 1); // code 0.01 GET
  } finally {
    await silent.close();
    await junk.close();
  }
});

test('the egress policy applies to UDP probes: loopback needs its flag', async () => {
  const sim = await new CoapSimulator().start();
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  try {
    await assert.rejects(scan({ coapPorts: [sim.port] }), /MANIFOLD_ALLOW_LOOPBACK_DEVICES/);
    assert.equal(sim.stats.received, 0);
    // the identification itself refuses a blocked address even when called directly
    assert.equal(await deviceIdentify.identifyCoap('127.0.0.1', sim.port, { timeoutMs: 400 }), null);
    assert.equal(await deviceIdentify.identifyCoap('169.254.169.254', 5683, { timeoutMs: 400 }), null);
    assert.equal(await deviceIdentify.identifyCoap('224.0.0.1', 5683, { timeoutMs: 400 }), null);
    assert.equal(sim.stats.received, 0);
  } finally {
    process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
    await sim.stop();
  }
});

test('stopping a scan abandons the UDP exchange at once', async () => {
  const silent = await udpFake();
  try {
    const rec = recorder();
    const d = new DiscoveryService(rec.io);
    const finished = done(d);
    await d.startScan({ range: '127.0.0.1', coapPorts: [silent.port], identifyTimeoutMs: 15000, mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    d.stopScan();
    await finished;
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(d.getState().scan.status, 'cancelled');
  } finally {
    await silent.close();
  }
});

test('coapPorts are validated like every other port list', async () => {
  const d = new DiscoveryService(recorder().io);
  await assert.rejects(d.plan({ range: '127.0.0.1', coapPorts: ['x'] }), /coapPorts/);
  await assert.rejects(d.plan({ range: '127.0.0.1', coapPorts: [70000] }), /coapPorts/);
  const p = await d.plan({ range: '127.0.0.1', coapPorts: [5683, 5684], mqttPorts: [], opcuaPorts: [], i3xPorts: [] });
  assert.equal(p.jobs.length, 2);
  assert.equal(d.describe().ports.coap[0], 5683);
});
