'use strict';

/**
 * Network discovery (services/discovery.js) against the REAL
 * OPC UA test server. The egress guard blocks loopback scan targets, so the
 * scan runs with MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 (what the flag is for); every step,
 * probe, Hello and GetEndpoints, is the real scan code against the real server.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { useTempDataDir } = require('./support/opcuaTestKit');

useTempDataDir('manifold-discovery-opcua-');
const { startOpcuaTestServer } = require('./support/opcuaTestServer');
const DiscoveryService = require('../services/discovery');

let srv;
let plain;
before(async () => {
  srv = await startOpcuaTestServer({ largeCount: 1 });
  plain = net.createServer((sock) => {
    sock.on('error', () => {}); // the probe resets the connection
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
});
after(async () => {
  await srv.close();
  await new Promise((r) => plain.close(r));
});

async function scan(ports, { onEvent, identifyTimeoutMs } = {}) {
  const events = [];
  const disc = new DiscoveryService({ emit: (n, p) => { events.push([n, p]); onEvent?.(n, p, disc); } });
  // Loopback scans are what the flag is for (local simulators): the whole scan, probe AND
  // identification, runs against the real test server with nothing stubbed.
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
  const started = Date.now();
  try {
    await disc.startScan({ range: '127.0.0.1/32', opcuaPorts: ports, mqttPorts: [], includeI3x: false, ...(identifyTimeoutMs ? { identifyTimeoutMs } : {}) });
    const end = Date.now() + 15_000;
    while (!events.some(([n]) => n === 'discovery-complete') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  } finally {
    if (prev === undefined) delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
    else process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
  }
  const done = events.find(([n]) => n === 'discovery-complete');
  assert.ok(done, 'scan completes');
  return { results: done[1].results, status: done[1].status, elapsedMs: Date.now() - started };
}

async function noSessionsLeft() {
  const end = Date.now() + 5000;
  while (srv.sessionCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return srv.sessionCount();
}

test('a scan verifies OPC UA with a real GetEndpoints and reports identity and the security offered', async () => {
  const { results } = await scan([srv.port]);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.kind, 'opcua');
  assert.strictEqual(r.endpointUrl, `opc.tcp://127.0.0.1:${srv.port}`);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.method, 'ua-getendpoints');
  assert.strictEqual(r.applicationUri, 'urn:manifold:test-server');
  assert.strictEqual(r.applicationName, 'Manifold OPC UA test server');
  assert.deepStrictEqual(r.identity.securityModes, ['None', 'Sign', 'SignAndEncrypt']);
  assert.ok(r.identity.securityPolicies.includes('Basic256Sha256'), r.identity.securityPolicies.join());
  assert.ok(r.identity.userTokens.includes('Anonymous') && r.identity.userTokens.includes('UserName'));
  assert.strictEqual(await noSessionsLeft(), 0, 'GetEndpoints opens no session');
});

test('a listener that does not speak OPC UA is not a result', async () => {
  const { results } = await scan([srv.port, plain.address().port]);
  assert.strictEqual(results.length, 1, 'the plain TCP listener is not an OPC UA server');
  assert.strictEqual(results[0].port, srv.port);
  assert.strictEqual(results[0].verified, true);
});

test('a UA-TCP listener that answers the Hello but not GetEndpoints is reported unverified, within the timeout', async () => {
  const { opcuaServer } = require('./support/discoveryLab');
  const fake = await opcuaServer('127.0.0.1');
  try {
    const { results, elapsedMs } = await scan([fake.port], { identifyTimeoutMs: 800 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].verified, false);
    assert.strictEqual(results[0].method, 'ua-hello');
    assert.match(results[0].note, /Answered the OPC UA Hello, but/);
    assert.ok(elapsedMs < 5000, `bounded (${elapsedMs} ms)`);
    const end = Date.now() + 3000;
    while (fake.open > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fake.open, 0, 'no socket left open');
  } finally {
    await fake.close();
  }
});

test('cancelling a scan while GetEndpoints is waiting ends it at once and closes the socket', async () => {
  const { opcuaServer } = require('./support/discoveryLab');
  const fake = await opcuaServer('127.0.0.1'); // answers the Hello, never the OpenSecureChannel
  try {
    const { status, results, elapsedMs } = await scan([fake.port], {
      identifyTimeoutMs: 10_000,
      onEvent: (n, p, disc) => {
        if (n === 'discovery-started') setTimeout(() => disc.stopScan(), 400);
      }
    });
    assert.strictEqual(status, 'cancelled');
    assert.strictEqual(results.length, 0);
    assert.ok(elapsedMs < 2000, `cancel is immediate (${elapsedMs} ms)`);
    const end = Date.now() + 3000;
    while (fake.open > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fake.open, 0, 'no socket left open');
  } finally {
    await fake.close();
  }
});

test('cancelling a scan against the real server leaves no session', async () => {
  const { status } = await scan([srv.port], {
    onEvent: (n, p, disc) => {
      if (n === 'discovery-started') setTimeout(() => disc.stopScan(), 5);
    }
  });
  assert.strictEqual(status, 'cancelled');
  assert.strictEqual(await noSessionsLeft(), 0);
});
