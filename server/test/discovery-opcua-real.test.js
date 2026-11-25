'use strict';

/**
 * Network discovery (services/discovery.js, owned elsewhere) against the REAL
 * OPC UA test server. The egress guard blocks loopback scan targets, so the
 * scan runs over an allowed address and the TCP probe is pointed at the local
 * test server; everything after the probe is the real scan code.
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

async function scan(ports) {
  const events = [];
  const disc = new DiscoveryService({ emit: (n, p) => events.push([n, p]) });
  const probe = disc.probePort.bind(disc);
  disc.probePort = (host, port) => probe('127.0.0.1', port);
  const prev = process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
  process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS = '1';
  try {
    await disc.startScan({ range: '10.20.30.40/32', opcuaPorts: ports, mqttPorts: [], includeI3x: false });
    const end = Date.now() + 10_000;
    while (!events.some(([n]) => n === 'discovery-complete') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  } finally {
    if (prev === undefined) delete process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;
    else process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS = prev;
  }
  const done = events.find(([n]) => n === 'discovery-complete');
  assert.ok(done, 'scan completes');
  return done[1].results;
}

test('a scan reports the OPC UA test server as an OPC UA candidate with a connectable endpoint URL', async () => {
  const results = await scan([srv.port]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'opcua');
  assert.strictEqual(results[0].endpointUrl, `opc.tcp://10.20.30.40:${srv.port}`);
});

// Defect report (discovery.js is another engineer's file): the OPC UA branch
// of startScan() trusts an open port and never speaks OPC UA, so the result
// is never verified and carries no identity, and any TCP listener on an OPC
// UA port is reported as an OPC UA server. Fix described in the report.
test('a scan verifies OPC UA with a GetEndpoints handshake and drops listeners that do not speak it', { todo: 'discovery.js: OPC UA candidates are not verified (open port only)' }, async () => {
  const results = await scan([srv.port, plain.address().port]);
  assert.strictEqual(results.length, 1, 'the plain TCP listener is not an OPC UA server');
  assert.strictEqual(results[0].verified, true);
  assert.strictEqual(results[0].applicationUri, 'urn:manifold:test-server');
});
