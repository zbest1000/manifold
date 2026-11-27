'use strict';

// Discovery's one UDP mechanism serving several UDP kinds at once: BACnet/IP and CoAP on the same host.

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const DiscoveryService = require('../services/discovery');
const { BacnetSimulator } = require('./support/bacnetSimulator');
const { CoapSimulator } = require('./support/coapSimulator');

const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function sims() {
  const bacnet = await new BacnetSimulator({ deviceInstance: 777 }).start();
  const coap = await new CoapSimulator().start();
  cleanups.push(async () => {
    assert.equal(bacnet.stats.writesReceived, 0);
    assert.equal(bacnet.stats.broadcasts, 0);
    assert.equal(coap.stats.nonGetReceived, 0);
    await bacnet.stop();
    await coap.stop();
  });
  return { bacnet, coap };
}

async function silentUdp() {
  const s = dgram.createSocket('udp4');
  s.on('message', () => {});
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const close = () => new Promise((r) => s.close(r));
  cleanups.push(close);
  return s.address().port;
}

const base = { range: '127.0.0.1/32', mqttPorts: [], opcuaPorts: [], includeI3x: false };

/** Count the scan's OWN in-flight identifications (per host and overall) by wrapping identifyDevice. */
function instrument(d) {
  const inflight = { now: 0, max: 0, perHost: new Map(), maxPerHost: 0, kinds: [] };
  const orig = d.identifyDevice.bind(d);
  d.identifyDevice = async (kind, host, port, opts) => {
    inflight.kinds.push(kind);
    inflight.now++;
    inflight.max = Math.max(inflight.max, inflight.now);
    const h = (inflight.perHost.get(host) || 0) + 1;
    inflight.perHost.set(host, h);
    inflight.maxPerHost = Math.max(inflight.maxPerHost, h);
    try {
      return await orig(kind, host, port, opts);
    } finally {
      inflight.now--;
      inflight.perHost.set(host, inflight.perHost.get(host) - 1);
    }
  };
  return inflight;
}

test('plan: both UDP kinds on one host are separate jobs, each counted with its own wait', async () => {
  const d = new DiscoveryService({ emit() {} });
  const p = await d.plan({ ...base, bacnetPorts: [47808], coapPorts: [5683, 5684], timeoutMs: 400, identifyTimeoutMs: 900, perHost: 1, concurrency: 8 });
  assert.deepEqual(p.tcpPorts, []);
  assert.deepEqual(p.udpPorts, [47808, 5683, 5684]);
  assert.deepEqual(p.ports, [47808, 5683, 5684]);
  assert.deepEqual(
    p.jobs.map((j) => [j.kinds[0], j.port, j.udp]),
    [
      ['bacnet', 47808, true],
      ['coap', 5683, true],
      ['coap', 5684, true]
    ]
  );
  // perHost 1 on one host: one slot. BACnet's silent wait is the connect timeout, CoAP's the identify timeout.
  assert.equal(p.estimate.slots, 1);
  assert.equal(p.estimate.worstCaseMs, 400 + 2 * 900);
  // With TCP ports too: the TCP connects are counted at the connect timeout.
  const mixed = await d.plan({ ...base, modbusPorts: [502], bacnetPorts: [47808], coapPorts: [5683], timeoutMs: 400, identifyTimeoutMs: 900, perHost: 1 });
  assert.deepEqual(mixed.tcpPorts, [502]);
  assert.equal(mixed.estimate.worstCaseMs, 400 + 400 + 900);
  // The same port number for two UDP kinds: two jobs (each speaks its own protocol), one port listed.
  const shared = await d.plan({ ...base, bacnetPorts: [40000], coapPorts: [40000] });
  assert.deepEqual(shared.udpPorts, [40000]);
  assert.deepEqual(shared.jobs.map((j) => j.kinds[0]), ['bacnet', 'coap']);
  // includeDevices adds no UDP kind; include flags add the defaults
  const dev = await d.plan({ ...base, includeDevices: true });
  assert.deepEqual(dev.udpPorts, []);
  const inc = await d.plan({ ...base, includeBacnet: true, includeCoap: true });
  assert.deepEqual(inc.udpPorts, [47808, 5683]);
});

test('a scan finds a BACnet device and a CoAP device on the same host, within the per-host limit', async () => {
  const { bacnet, coap } = await sims();
  const silent = await silentUdp();
  const events = [];
  const d = new DiscoveryService({ emit: (n, p) => events.push([n, p]) });
  const inflight = instrument(d);
  const done = new Promise((r) => d.once('done', r));
  const t0 = Date.now();
  await d.startScan({ ...base, bacnetPorts: [bacnet.port, silent], coapPorts: [coap.port, silent], timeoutMs: 400, identifyTimeoutMs: 800, perHost: 2 });
  const scan = await done;
  const elapsed = Date.now() - t0;
  assert.equal(scan.status, 'complete');
  assert.equal(scan.completed, 4);
  assert.ok(inflight.maxPerHost <= 2, `at most perHost identifications at once on the host (saw ${inflight.maxPerHost})`);
  assert.ok(elapsed <= scan.estimate.worstCaseMs + 1500, `finished within the plan's worst case (${elapsed} ms vs ${scan.estimate.worstCaseMs} ms)`);
  const results = d.getLastResults().sort((a, b) => a.kind.localeCompare(b.kind));
  assert.deepEqual(
    results.map((r) => [r.kind, r.protocol, r.port]),
    [
      ['bacnet', 'bacnet-ip', bacnet.port],
      ['coap', 'coap', coap.port]
    ]
  );
  assert.equal(results[0].suggestedDevice.deviceInstance, 777);
  const started = events.find((e) => e[0] === 'discovery-started')[1];
  assert.deepEqual(started.udpPorts, [bacnet.port, silent, coap.port]);

  // Already added: matched on host, port AND transport.
  d.deps.known = () => ({
    devices: [
      { id: 'c', name: 'Sensor', protocol: 'coap', host: '127.0.0.1', port: coap.port },
      // a TCP device that happens to use the BACnet simulator's port number is a different endpoint
      { id: 'm', name: 'Meter', protocol: 'modbus-tcp', host: '127.0.0.1', port: bacnet.port }
    ]
  });
  const marked = Object.fromEntries(d.getLastResults().map((r) => [r.kind, r.known]));
  assert.deepEqual(marked.coap, { kind: 'device', id: 'c', name: 'Sensor' });
  assert.equal(marked.bacnet, null);
});

test('three UDP kinds on one host: BACnet/IP, CoAP and SNMP each answer their own probe', async () => {
  const { startSnmpSimulator } = require('./support/snmpSimulator');
  const { bacnet, coap } = await sims();
  const snmp = await startSnmpSimulator();
  cleanups.push(() => snmp.close());
  const d = new DiscoveryService({ emit() {} });
  const plan = await d.plan({ ...base, bacnetPorts: [bacnet.port], coapPorts: [coap.port], snmpPorts: [snmp.port], timeoutMs: 400, identifyTimeoutMs: 800, perHost: 1 });
  assert.deepEqual(plan.jobs.map((j) => j.kinds[0]), ['bacnet', 'coap', 'snmp']);
  assert.equal(plan.estimate.worstCaseMs, 400 + 800 + 800, 'SNMP waits its identify timeout like CoAP');
  const inflight = instrument(d);
  const done = new Promise((r) => d.once('done', r));
  const before = snmp.stats.received;
  await d.startScan({ ...base, bacnetPorts: [bacnet.port], coapPorts: [coap.port], snmpPorts: [snmp.port], timeoutMs: 400, identifyTimeoutMs: 800, perHost: 1 });
  await done;
  assert.equal(inflight.maxPerHost, 1);
  assert.deepEqual(d.getLastResults().map((r) => r.protocol).sort(), ['bacnet-ip', 'coap', 'snmp']);
  assert.equal(snmp.stats.received - before, 1, 'one SNMP datagram per address');
  assert.ok(snmp.stats.pduTypes.every((p) => p === 0xa0), 'only a GetRequest');
});

test('perHost 1 runs the UDP kinds of one host one at a time; concurrency spans hosts', async () => {
  const silent = await silentUdp();
  const d = new DiscoveryService({ emit() {} });
  const inflight = instrument(d);
  const done = new Promise((r) => d.once('done', r));
  await d.startScan({ ...base, bacnetPorts: [silent], coapPorts: [silent], timeoutMs: 200, identifyTimeoutMs: 500, perHost: 1 });
  await done;
  assert.equal(inflight.maxPerHost, 1);
  assert.deepEqual(inflight.kinds.sort(), ['bacnet', 'coap']);
});

test('stopping a scan ends every UDP kind at once', async () => {
  const silent = await silentUdp();
  const d = new DiscoveryService({ emit() {} });
  const done = new Promise((r) => d.once('done', r));
  await d.startScan({ ...base, bacnetPorts: [silent], coapPorts: [silent], timeoutMs: 10000, identifyTimeoutMs: 15000, perHost: 2 });
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  d.stopScan();
  const scan = await done;
  assert.equal(scan.status, 'cancelled');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(d.getLastResults().length, 0);
});
