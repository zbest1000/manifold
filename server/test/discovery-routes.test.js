'use strict';

// The discovery REST surface on the real app: a real scan of local simulators started
// over HTTP (loopback is allowed by MANIFOLD_ALLOW_LOOPBACK_DEVICES=1, set below before the
// app loads), results fetched the way a reloaded page fetches them, and the server-side
// `known` marker once a device has been added from a result.

process.env.PORT = '0';
process.env.MANIFOLD_NO_RESTORE = '1';
process.env.MANIFOLD_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'manifold-disc-routes-'));
process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
delete process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startDiscoveryLab, fake } = require('./support/discoveryLab');

let baseUrl;
let server;
let services;
let lab;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const app = require('../index');
  server = app.server;
  services = app.app.locals.services;
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  lab = await startDiscoveryLab({ withWs: false });
});

after(async () => {
  await lab?.close();
  await services?.devices?.stop?.();
  services?.mqttManager?.shutdown();
  for (const k of ['history', 'alerts', 'pipelines', 'recorder', 'replayer', 'contracts', 'models']) services?.[k]?.stop?.();
  server?.close();
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
async function waitIdle() {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', '/api/system/discovery/results');
    if (!body.scanning) return body;
    await sleep(50);
  }
  throw new Error('scan did not finish');
}

test('GET /discovery/defaults: subnet hint, defaults, bounds and what the guard allows', async () => {
  const { status, body } = await call('GET', '/api/system/discovery/defaults');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.defaults, { concurrency: 32, perHost: 2, timeoutMs: 1200, identifyTimeoutMs: 3000 });
  assert.deepStrictEqual(body.policy, { loopback: true, private: false });
  assert.deepStrictEqual(body.ports.modbus, [502]);
  assert.strictEqual(body.limits.maxHosts, 1024);
  assert.ok(body.localSubnet === null || /^\d+\.\d+\.\d+\.0\/24$/.test(body.localSubnet));
});

test('POST /discovery/plan: refusal names the flag; accepted ranges report probes and ETA', async () => {
  let r = await call('POST', '/api/system/discovery/plan', { range: '192.168.1.0/24' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'RANGE_REFUSED');
  assert.strictEqual(r.body.flag, 'MANIFOLD_ALLOW_PRIVATE_TARGETS');
  assert.match(r.body.error, /MANIFOLD_ALLOW_PRIVATE_TARGETS=1/);

  r = await call('POST', '/api/system/discovery/plan', { range: '192.0.2.0/24' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.flag, undefined);
  assert.match(r.body.error, /No setting allows this range/);

  r = await call('POST', '/api/system/discovery/plan', { range: '127.0.0.1/32', includeDevices: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.hosts, r.body.totalProbes], [1, 7]); // 1883 8883 4840 50000 502 102 44818; i3X ports are not probed on loopback
  assert.ok(r.body.notes.some((n) => /i3X is not probed on loopback/.test(n)));
  assert.ok(r.body.estimate.worstCaseMs > 0);

  r = await call('POST', '/api/system/discovery/plan', { range: '10.0.0.0/16' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'RANGE_TOO_LARGE');

  r = await call('POST', '/api/system/discovery/plan', { range: '127.0.0.1', concurrency: 'lots' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /concurrency/);
});

test('a scan started over HTTP finds the simulators; the results survive a reload; a second start is a 409', async () => {
  const start = await call('POST', '/api/system/discovery/start', {
    range: '127.0.0.1/32',
    includeI3x: false,
    mqttPorts: [lab.mqttPort],
    opcuaPorts: [lab.opcua.port],
    modbusPorts: [lab.modbus.port, lab.tarpit.port],
    s7Ports: [lab.s7.port],
    eipPorts: [lab.eip.port],
    identifyTimeoutMs: 1500
  });
  assert.strictEqual(start.status, 202);
  assert.strictEqual(start.body.totalProbes, 6);
  const again = await call('POST', '/api/system/discovery/start', { range: '127.0.0.1/32', modbusPorts: [lab.tarpit.port] });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.code, 'SCAN_RUNNING');
  assert.match(again.body.error, /already running/);

  const state = await waitIdle();
  assert.strictEqual(state.scan.status, 'complete');
  assert.strictEqual(state.scan.range, '127.0.0.1/32');
  const kinds = state.results.map((x) => x.kind).sort();
  assert.deepStrictEqual(kinds, ['ethernet-ip', 'modbus', 'mqtt', 'opcua', 's7']);
  // every result answered its protocol; the UA-TCP fake answers the Hello but not GetEndpoints
  assert.ok(state.results.every((x) => (x.kind === 'opcua' ? x.verified === false && x.method === 'ua-hello' : x.verified === true) && x.known === null));
  assert.deepStrictEqual(lab.writes(), { modbus: 0, s7: 0, eip: 0 });

  // "reload": a fresh GET returns the same results; the socket snapshot path uses the same getter
  const reloaded = await call('GET', '/api/system/discovery/results');
  assert.strictEqual(reloaded.body.results.length, 5);
  assert.strictEqual(services.discovery.getLastResults().length, 5);

  // Refusal without the flag: same engine, flag off
  const d = services.discovery;
  delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  try {
    const refused = await call('POST', '/api/system/discovery/start', { range: '127.0.0.1/32' });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.flag, 'MANIFOLD_ALLOW_LOOPBACK_DEVICES');
    assert.strictEqual(d.isScanning(), false);
    // the last results are untouched by a refused start
    assert.strictEqual((await call('GET', '/api/system/discovery/results')).body.results.length, 5);
  } finally {
    process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';
  }
});

test('adding a discovered device marks it known on the next read and the next scan', async () => {
  const modbus = (await call('GET', '/api/system/discovery/results')).body.results.find((x) => x.kind === 'modbus');
  assert.ok(modbus);
  assert.strictEqual(modbus.known, null);
  const created = await call('POST', '/api/devices', { ...modbus.suggestedDevice, tags: [{ key: 'reg', address: 'holding:0', type: 'uint16' }] });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));

  const read = (await call('GET', '/api/system/discovery/results')).body.results.find((x) => x.kind === 'modbus');
  assert.deepStrictEqual([read.known.kind, read.known.id], ['device', created.body.id]);

  await call('POST', '/api/system/discovery/start', { range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [lab.modbus.port] });
  const state = await waitIdle();
  assert.strictEqual(state.results.length, 1);
  assert.strictEqual(state.results[0].known.id, created.body.id);
  await call('DELETE', `/api/devices/${created.body.id}`);
});

test('stop over HTTP ends a scan at once', async () => {
  const tar = await fake(() => {});
  try {
    await call('POST', '/api/system/discovery/start', { range: '127.0.0.1/32', includeI3x: false, mqttPorts: [], opcuaPorts: [], modbusPorts: [tar.port], identifyTimeoutMs: 15000 });
    await sleep(200);
    const t0 = Date.now();
    assert.deepStrictEqual((await call('POST', '/api/system/discovery/stop')).body, { status: 'stopping' });
    const state = (await call('GET', '/api/system/discovery/results')).body;
    assert.strictEqual(state.scanning, false);
    assert.strictEqual(state.scan.status, 'cancelled');
    for (let i = 0; i < 20 && tar.open > 0; i++) await sleep(50);
    assert.strictEqual(tar.open, 0);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepStrictEqual((await call('POST', '/api/system/discovery/stop')).body, { status: 'idle' });
  } finally {
    await tar.close();
  }
});

test('POST /discovery/plan?soft=1 reports a refusal as 200 { refused } (the page asks on every edit)', async () => {
  const r = await call('POST', '/api/system/discovery/plan?soft=1', { range: '192.168.1.0/24' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.refused.code, 'RANGE_REFUSED');
  assert.strictEqual(r.body.refused.flag, 'MANIFOLD_ALLOW_PRIVATE_TARGETS');
  const ok = await call('POST', '/api/system/discovery/plan?soft=1', { range: '127.0.0.1/32' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.refused, undefined);
});
