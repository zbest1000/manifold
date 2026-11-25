'use strict';

/**
 * OpcuaManager against a REAL OPC UA server (node-opcua, see support/opcuaTestServer.js):
 * security modes and identities, the trust flow in both directions, discovery,
 * browse with continuation points, read and monitor of every built-in type,
 * quality and timestamps, sampling intervals, 500 items, and the failure paths
 * a fake cannot reproduce (server restart, session closed by the server,
 * subscription deleted by the server, long outage, edit while monitoring).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { useTempDataDir, until, FAST, makeIo } = require('./support/opcuaTestKit');

useTempDataDir();
const { startOpcuaTestServer } = require('./support/opcuaTestServer');
const OpcuaManager = require('../services/opcuaManager');

let srv;
const managers = [];

function manager(extra = {}) {
  const { io, emitted } = makeIo();
  const mgr = new OpcuaManager(io, { ...FAST, ...extra });
  const states = [];
  mgr.on('connection-state', (s) => states.push(`${s.state}:${s.reason}`));
  const values = [];
  mgr.on('value', (e) => values.push(e));
  managers.push(mgr);
  return { mgr, emitted, states, values };
}

before(async () => {
  srv = await startOpcuaTestServer();
});

after(async () => {
  for (const m of managers) await m.shutdown();
  await srv.close();
});

const N = (name) => srv.nodeId(name);
const lastValue = (values, nodeId) => [...values].reverse().find((v) => v.nodeId === nodeId);

// ---------------------------------------------------------------------------
// connect / security / identity
// ---------------------------------------------------------------------------

test('security None: anonymous and user name sessions; wrong password and unknown policy fail with actionable errors', async () => {
  const { mgr } = manager();
  const anon = await mgr.connect({ id: 'anon', endpointUrl: srv.endpointUrl });
  assert.strictEqual(anon.status, 'connected');
  const user = await mgr.connect({ id: 'user', endpointUrl: srv.endpointUrl, username: 'operator', password: 'secret' });
  assert.strictEqual(user.status, 'connected');

  await assert.rejects(
    mgr.connect({ id: 'bad', endpointUrl: srv.endpointUrl, username: 'operator', password: 'wrong' }),
    (e) => /rejected the user name or password for "operator"/.test(e.message) && /BadUserAccessDenied/.test(e.message)
  );
  await assert.rejects(
    mgr.connect({ id: 'pol', endpointUrl: srv.endpointUrl, securityMode: 'Sign', securityPolicy: 'Basic128Rsa15' }),
    /no endpoint with security mode Sign and policy Basic128Rsa15 — use Discover/
  );
  assert.deepStrictEqual(mgr.getConnections().map((c) => c.id).sort(), ['anon', 'user']); // failures keep nothing
  assert.strictEqual(srv.sessionCount(), 2); // and leave no session on the server
  await mgr.shutdown();
  await until(() => srv.sessionCount() === 0, 5000, 'sessions closed on the server');
});

test('endpoint URLs are validated before anything is sent; refused and unknown hosts fail fast and clearly', async () => {
  const { mgr } = manager();
  await assert.rejects(mgr.connect({ endpointUrl: 'http://plc:4840' }), /must look like opc\.tcp:\/\/host:4840.*BadTcpEndpointUrlInvalid/);
  await assert.rejects(mgr.discoverEndpoints('plc:4840'), /must look like opc\.tcp/);
  const t0 = Date.now();
  await assert.rejects(mgr.connect({ endpointUrl: 'opc.tcp://127.0.0.1:1' }), /connection refused by 127\.0\.0\.1:1 \(ECONNREFUSED\)/);
  assert.ok(Date.now() - t0 < 2500, `refused connect took ${Date.now() - t0} ms (node-opcua retries must be off)`);
  assert.strictEqual(mgr.getConnections().length, 0);
});

test('endpoint discovery lists every mode/policy, user token types and the server certificate', async () => {
  const { mgr } = manager();
  const eps = await mgr.discoverEndpoints(srv.endpointUrl);
  const combos = eps.map((e) => `${e.securityMode}/${e.securityPolicy}`);
  for (const c of ['None/None', 'Sign/Basic256Sha256', 'SignAndEncrypt/Basic256Sha256', 'SignAndEncrypt/Aes128_Sha256_RsaOaep']) {
    assert.ok(combos.includes(c), `missing ${c} in ${combos}`);
  }
  assert.ok(eps[0].securityLevel >= eps[eps.length - 1].securityLevel, 'sorted strongest first');
  const secure = eps.find((e) => e.securityMode === 'SignAndEncrypt');
  assert.match(secure.serverCertificate.thumbprint, /^[0-9a-f]{40}$/);
  assert.ok(secure.userIdentityTokens.includes('Anonymous') && secure.userIdentityTokens.includes('UserName'));
});

test('secure modes: untrusted server certificate -> clear error -> trust via the PKI API -> Sign and SignAndEncrypt with both identities', async () => {
  const own = await startOpcuaTestServer({ largeCount: 1 });
  try {
    const { mgr } = manager();
    const cfg = { endpointUrl: own.endpointUrl, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256' };
    await assert.rejects(mgr.connect({ id: 's1', ...cfg }), (e) => /certificate is not trusted by Manifold/.test(e.message) && /BadCertificateUntrusted/.test(e.message));
    assert.strictEqual(mgr.getConnections().length, 0);

    const trust = await mgr.listTrust();
    const discovered = (await mgr.discoverEndpoints(own.endpointUrl)).find((e) => e.serverCertificate).serverCertificate;
    const rejected = trust.rejected.find((c) => c.thumbprint === discovered.thumbprint);
    assert.ok(rejected, 'the refused server certificate is listed under rejected');
    await mgr.trustCertificate(rejected.thumbprint);
    const after1 = await mgr.listTrust();
    assert.ok(after1.trusted.some((c) => c.thumbprint === rejected.thumbprint));
    assert.ok(!after1.rejected.some((c) => c.thumbprint === rejected.thumbprint));

    for (const mode of ['Sign', 'SignAndEncrypt']) {
      for (const policy of ['Basic256Sha256', 'Aes128_Sha256_RsaOaep']) {
        const id = `${mode}-${policy}`;
        const res = await mgr.connect({ id, endpointUrl: own.endpointUrl, securityMode: mode, securityPolicy: policy });
        assert.strictEqual(res.status, 'connected', id);
        const rd = await mgr.read(id, own.nodeId('Scalars.Double'));
        assert.strictEqual(rd.value, 3.14159);
      }
    }
    await mgr.connect({ id: 'user-sae', ...cfg, username: 'operator', password: 'secret' });
    await assert.rejects(mgr.connect({ id: 'bad-sae', ...cfg, username: 'operator', password: 'nope' }), /rejected the user name or password/);

    // the private key of the application certificate is owner-only
    const fs = require('fs');
    const path = require('path');
    const pki = (await mgr.getApplicationCertificate()).pkiFolder;
    assert.strictEqual(fs.statSync(path.join(pki, 'own', 'private')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(pki, 'own', 'private', 'private_key.pem')).mode & 0o777, 0o600);
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('trustServer trusts exactly the server certificate it is shown, without a global accept-all window', async () => {
  const own = await startOpcuaTestServer({ largeCount: 1 });
  try {
    const { mgr } = manager();
    const res = await mgr.connect({ endpointUrl: own.endpointUrl, securityMode: 'Sign', securityPolicy: 'Basic256Sha256', trustServer: true });
    assert.strictEqual(res.status, 'connected');
    const thumb = (await mgr.discoverEndpoints(own.endpointUrl)).find((e) => e.serverCertificate).serverCertificate.thumbprint;
    assert.ok((await mgr.listTrust()).trusted.some((c) => c.thumbprint === thumb));
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('the server does not trust our client certificate: the error says what to do; trusting it on the server lets the next attempt in', async () => {
  const own = await startOpcuaTestServer({ largeCount: 1, trustClients: false });
  try {
    const { mgr } = manager();
    const cfg = { id: 'c', endpointUrl: own.endpointUrl, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', trustServer: true };
    await assert.rejects(mgr.connect(cfg), /does not trust Manifold's client certificate.*Certificates and trust/);
    // supervised (a saved connection): keeps retrying, and succeeds once the server admin trusts us
    const res = await mgr.connect(cfg, { supervise: true });
    assert.strictEqual(res.status, 'reconnecting');
    assert.match(mgr.getConnections()[0].lastError, /does not trust Manifold's client certificate/);
    assert.ok(own.rejectedClientCertificates().length >= 1);
    await own.trustRejectedClients();
    await until(() => mgr.getConnections()[0].status === 'connected', 10_000, 'connected after the server trusted us');
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

// ---------------------------------------------------------------------------
// browse / read
// ---------------------------------------------------------------------------

test('browse: root, a deep path, a 300-node folder across continuation points, unknown node', async () => {
  const { mgr } = manager({ browsePageSize: 50 });
  await mgr.connect({ id: 'b', endpointUrl: srv.endpointUrl });
  const root = await mgr.browse('b');
  assert.deepStrictEqual(root.references.map((r) => r.browseName).sort(), ['Objects', 'Types', 'Views']);

  let nodeId = N('Deep');
  for (let i = 1; i <= 8; i++) {
    const res = await mgr.browse('b', nodeId);
    const next = res.references.find((r) => r.browseName === `1:L${i}`);
    assert.ok(next, `L${i} under ${nodeId}`);
    nodeId = next.nodeId;
  }
  const leaf = (await mgr.browse('b', nodeId)).references.find((r) => r.browseName === '1:Leaf');
  assert.strictEqual(leaf.nodeClass, 'Variable');
  assert.strictEqual(leaf.nodeId, N(srv.deepLeaf()));

  const large = await mgr.browse('b', N('Large'));
  assert.strictEqual(large.references.length, 300); // 6 pages of 50, nothing lost
  assert.strictEqual(new Set(large.references.map((r) => r.nodeId)).size, 300);
  assert.ok(!large.truncated);

  const { mgr: capped } = manager({ browsePageSize: 50, maxBrowseReferences: 120 });
  await capped.connect({ id: 'c', endpointUrl: srv.endpointUrl });
  const cut = await capped.browse('c', N('Large'));
  assert.strictEqual(cut.truncated, true);
  assert.ok(cut.references.length >= 120 && cut.references.length <= 150);

  await assert.rejects(mgr.browse('b', 'ns=1;s=Does.Not.Exist'), /does not exist on the server.*BadNodeIdUnknown/);
  await mgr.shutdown();
  await capped.shutdown();
});

test('read: every scalar type, arrays, structures (standard and server-defined), engineering units and range', async () => {
  const { mgr } = manager();
  await mgr.connect({ id: 'r', endpointUrl: srv.endpointUrl });
  const expect = {
    Boolean: true, SByte: -8, Byte: 200, Int16: -1234, UInt16: 54321, Int32: -123456789, UInt32: 3000000000,
    Int64: '9223372036854775807', UInt64: '18446744073709551614', Float: 1.5, Double: 3.14159, String: 'hello',
    DateTime: '2026-01-02T03:04:05.000Z'
  };
  for (const [name, value] of Object.entries(expect)) {
    const rd = await mgr.read('r', N(`Scalars.${name}`));
    assert.deepStrictEqual(rd.value, value, name);
    assert.strictEqual(rd.dataType, name, `dataType name of ${name}`);
    assert.match(rd.valueStatus, /^Good/);
  }
  assert.deepStrictEqual((await mgr.read('r', N('Arrays.DoubleArray'))).value, [1.5, 2.5, 3.5]);
  assert.deepStrictEqual((await mgr.read('r', N('Arrays.Int32Array'))).value, [1, -2, 3]);
  assert.deepStrictEqual((await mgr.read('r', N('Arrays.StringArray'))).value, ['a', 'b', 'c']);
  const range = await mgr.read('r', N('Structs.Range'));
  assert.deepStrictEqual(range.value, { low: -10, high: 90 });
  assert.strictEqual(range.dataType, 'Range');
  const custom = await mgr.read('r', N('Structs.Custom'));
  assert.deepStrictEqual(custom.value, { running: true, speed: 1450.5, label: 'P-101' });
  assert.strictEqual(custom.dataType, 'PumpStatus');

  const temp = await mgr.read('r', N('Analog.Temperature'));
  assert.strictEqual(temp.engineeringUnits.displayName, '°C');
  assert.deepStrictEqual(temp.euRange, { low: 0, high: 150 });
  const meta = await mgr.describeNode('r', N('Analog.Pressure'));
  assert.strictEqual(meta.type, 'Double');
  assert.ok(meta.unit && meta.unit.length > 0);
  assert.deepStrictEqual(meta.range, { low: 0, high: 1000 });

  await assert.rejects(mgr.read('r', 'ns=1;s=Nope'), /does not exist on the server/);
  await mgr.shutdown();
});

test('a slow read times out with a clear message instead of hanging', async () => {
  const { mgr } = manager({ operationTimeoutMs: 300 });
  await mgr.connect({ id: 's', endpointUrl: srv.endpointUrl });
  srv.setSlowMs(1500);
  try {
    await assert.rejects(mgr.read('s', N('Slow.Value')), /did not answer the read within 0 s|timed out/);
  } finally {
    srv.setSlowMs(0);
  }
  assert.strictEqual((await mgr.read('s', N('Slow.Value'))).value, 42);
  await mgr.shutdown();
});

// ---------------------------------------------------------------------------
// monitor
// ---------------------------------------------------------------------------

test('monitor: value, type, quality and source timestamp for every type; status changes with an unchanged value', async () => {
  const { mgr, values } = manager();
  await mgr.connect({ id: 'm', endpointUrl: srv.endpointUrl });
  const names = [...srv.scalarTypes.map((n) => `Scalars.${n}`), 'Arrays.DoubleArray', 'Arrays.StringArray', 'Structs.Range', 'Structs.Custom', 'Quality.Value'];
  const results = await Promise.all(names.map((n) => mgr.monitor('m', N(n), 50)));
  assert.ok(results.every((r) => r.status === 'monitoring'));
  assert.strictEqual(srv.subscriptionCount(), 1); // one subscription for all of them
  await until(() => names.every((n) => lastValue(values, N(n))), 5000, 'initial values');

  const ts = new Date('2026-03-04T05:06:07.000Z');
  const updates = {
    'Scalars.Boolean': [false, false, 'Boolean'],
    'Scalars.SByte': [-128, -128, 'SByte'],
    'Scalars.Byte': [255, 255, 'Byte'],
    'Scalars.Int16': [-32768, -32768, 'Int16'],
    'Scalars.UInt16': [65535, 65535, 'UInt16'],
    'Scalars.Int32': [-2147483648, -2147483648, 'Int32'],
    'Scalars.UInt32': [4294967295, 4294967295, 'UInt32'],
    'Scalars.Int64': [[0xffffffff, 0xfffffffe], '-2', 'Int64'],
    'Scalars.UInt64': [[0x00000001, 0x00000000], '4294967296', 'UInt64'],
    'Scalars.Float': [-0.25, -0.25, 'Float'],
    'Scalars.Double': [1e-9, 1e-9, 'Double'],
    'Scalars.String': ['wörld ✓', 'wörld ✓', 'String'],
    'Scalars.DateTime': [new Date('2030-12-31T23:59:59.000Z'), '2030-12-31T23:59:59.000Z', 'DateTime'],
    'Arrays.DoubleArray': [[9, 8.5], [9, 8.5], 'Double'],
    'Arrays.StringArray': [['x'], ['x'], 'String'],
    'Structs.Range': [{ low: 1, high: 2 }, { low: 1, high: 2 }, 'ExtensionObject'],
    'Structs.Custom': [{ running: false, speed: 0, label: 'P-102' }, { running: false, speed: 0, label: 'P-102' }, 'ExtensionObject']
  };
  for (const [name, [raw]] of Object.entries(updates)) srv.set(name, raw, { sourceTimestamp: ts });
  for (const [name, [, plain, dataType]] of Object.entries(updates)) {
    const v = await until(() => {
      const last = lastValue(values, N(name));
      return last && JSON.stringify(last.value) === JSON.stringify(plain) ? last : null;
    }, 5000, `update of ${name}`);
    assert.strictEqual(v.dataType, dataType, name);
    assert.strictEqual(v.statusCode, 0, name);
    assert.match(v.status, /^Good/);
    assert.strictEqual(new Date(v.sourceTimestamp).toISOString(), ts.toISOString(), name);
    assert.ok(v.serverTimestamp instanceof Date);
    assert.strictEqual(v.arrayType, name.startsWith('Arrays.') ? 'Array' : 'Scalar');
  }

  // status code changes alone (same value) are delivered, with the controlled timestamp
  const before = values.length;
  srv.set('Quality.Value', 5, { sourceTimestamp: new Date('2026-01-01T00:00:00Z') });
  await until(() => lastValue(values, N('Quality.Value'))?.value === 5, 5000, 'Good 5');
  for (const [status, severity] of [['UncertainLastUsableValue', 1], ['BadSensorFailure', 2], ['Good', 0]]) {
    const t = new Date(Date.now() - 1000);
    srv.setStatus('Quality.Value', status, { sourceTimestamp: t });
    const v = await until(() => {
      const last = lastValue(values, N('Quality.Value'));
      return last && last.status.startsWith(status) ? last : null;
    }, 5000, `status ${status}`);
    assert.strictEqual(v.value, 5);
    assert.strictEqual(v.statusCode >>> 30, severity);
    assert.strictEqual(new Date(v.sourceTimestamp).getTime(), t.getTime());
  }
  assert.ok(values.length > before);
  await mgr.shutdown();
});

test('sampling interval is requested and honoured; revised interval is reported', async () => {
  const { mgr, emitted, values } = manager();
  await mgr.connect({ id: 'si', endpointUrl: srv.endpointUrl });
  await mgr.monitor('si', N('Large.Item001'), 400);
  const started = emitted.find(([n, p]) => n === 'opcua-monitor-started' && p.nodeId === N('Large.Item001'));
  assert.strictEqual(started[1].samplingInterval, 400);
  let i = 0;
  const ticker = setInterval(() => srv.set('Large.Item001', ++i), 20);
  try {
    await until(() => values.filter((v) => v.nodeId === N('Large.Item001')).length >= 6, 10_000, '6 samples');
  } finally {
    clearInterval(ticker);
  }
  const samples = values.filter((v) => v.nodeId === N('Large.Item001'));
  const changesWritten = i;
  // ~20 writes per sample at 20 ms writes / 400 ms sampling: the server samples, it does not forward every write
  assert.ok(samples.length * 4 < changesWritten, `${samples.length} samples for ${changesWritten} writes`);
  await mgr.shutdown();
});

test('500 monitored items: created in a few batched calls, every one delivers, unmonitor removes items on the server', async () => {
  const big = await startOpcuaTestServer({ largeCount: 500 });
  try {
    const { mgr, values } = manager();
    await mgr.connect({ id: 'big', endpointUrl: big.endpointUrl });
    const nodeIds = Array.from({ length: 500 }, (_, i) => big.nodeId(`Large.Item${String(i).padStart(3, '0')}`));
    const t0 = Date.now();
    const res = await Promise.all(nodeIds.map((n) => mgr.monitor('big', n, 100)));
    const createMs = Date.now() - t0;
    assert.ok(res.every((r) => r.status === 'monitoring'));
    assert.strictEqual(big.monitoredItemCount(), 500);
    assert.strictEqual(big.subscriptionCount(), 1);
    await until(() => new Set(values.map((v) => v.nodeId)).size === 500, 10_000, 'initial value of every item');

    // all 500 change at once: no publish starvation, every new value arrives
    for (let i = 0; i < 500; i++) big.set(`Large.Item${String(i).padStart(3, '0')}`, 10_000 + i);
    await until(() => nodeIds.every((n, i) => lastValue(values, n)?.value === 10_000 + i), 10_000, 'all 500 updates');

    for (const n of nodeIds.slice(0, 100)) await mgr.unmonitor('big', n);
    assert.strictEqual(big.monitoredItemCount(), 400);
    assert.strictEqual(mgr.getConnections()[0].monitoredCount, 400);
    assert.ok(createMs < 5000, `creating 500 items took ${createMs} ms`);
    await mgr.shutdown();
  } finally {
    await big.close();
  }
});

test('monitoring an unknown node fails clearly and is not kept', async () => {
  const { mgr } = manager();
  await mgr.connect({ id: 'u', endpointUrl: srv.endpointUrl });
  await assert.rejects(mgr.monitor('u', 'ns=1;s=Missing'), /does not exist on the server.*BadNodeIdUnknown/);
  const ok = await mgr.monitor('u', N('Scalars.Int32'));
  assert.strictEqual(ok.status, 'monitoring');
  assert.deepStrictEqual(mgr.getConnections()[0].monitoredNodes, [N('Scalars.Int32')]);
  await mgr.shutdown();
});

// ---------------------------------------------------------------------------
// failure and recovery
// ---------------------------------------------------------------------------

/** Write distinct values until `count` of them were seen after the mark; returns the events after the mark. */
async function flowing(server, values, name, nodeId, from, count = 5) {
  const mark = values.length;
  let next = from;
  await until(
    () => {
      if (server.running) server.set(name, next++);
      return values.slice(mark).filter((v) => v.nodeId === nodeId && v.value >= from).length >= count;
    },
    15_000,
    `values flowing on ${name}`
  );
  return values.slice(mark).filter((v) => v.nodeId === nodeId);
}

function assertNoDuplicates(events) {
  const seen = new Map();
  for (const e of events) seen.set(e.value, (seen.get(e.value) || 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1);
  assert.deepStrictEqual(dups, [], 'no value delivered twice');
}

test('server restart: offline -> supervised reconnect -> monitors recovered once, values flowing, no duplicates', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  try {
    const { mgr, states, values } = manager();
    await mgr.connect({ id: 'rs', endpointUrl: own.endpointUrl });
    await mgr.monitor('rs', own.nodeId('Scalars.Double'), 0);
    await mgr.monitor('rs', own.nodeId('Scalars.Int32'), 0);
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 100);

    await own.restart();
    await until(() => states.filter((s) => s.startsWith('online')).length === 2, 10_000, 'online again');
    assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['online', 'offline', 'online']);
    const after = await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 1000, 10);
    assertNoDuplicates(after.filter((v) => v.value >= 1000));
    assert.strictEqual(own.sessionCount(), 1);
    assert.strictEqual(own.subscriptionCount(), 1);
    assert.strictEqual(own.monitoredItemCount(), 2);
    const conn = mgr.getConnections()[0];
    assert.strictEqual(conn.status, 'connected');
    assert.strictEqual(conn.monitoredCount, 2);
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('session closed by the server (as on a session timeout): detected while the TCP link stays up, recovered', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  try {
    const { mgr, values, states } = manager();
    await mgr.connect({ id: 'sc', endpointUrl: own.endpointUrl });
    await mgr.monitor('sc', own.nodeId('Scalars.Double'), 0);
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 100);
    assert.strictEqual(own.closeSessions({ deleteSubscriptions: true }), 1);
    const after = await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 1000, 5);
    assertNoDuplicates(after.filter((v) => v.value >= 1000));
    await until(() => own.subscriptionCount() === 1 && own.monitoredItemCount() === 1, 5000, 'exactly one subscription and item');
    // node-opcua's own session repair is off: the supervisor alone rebuilt it, and says why
    assert.match(states.find((s) => s.startsWith('offline')), /server closed the session.*\[BadSessionIdInvalid\]/);
    assert.strictEqual(own.sessionCount(), 1);
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('subscription deleted by the server: the silent subscription is noticed and rebuilt on the same session', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  try {
    const { mgr, values, states } = manager();
    await mgr.connect({ id: 'sd', endpointUrl: own.endpointUrl });
    await mgr.monitor('sd', own.nodeId('Scalars.Double'), 0);
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 100);
    assert.strictEqual(own.deleteSubscriptions(), 1);
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 1000, 5);
    assert.strictEqual(own.subscriptionCount(), 1);
    assert.strictEqual(own.monitoredItemCount(), 1);
    assert.match(mgr.getConnections()[0].lastError, /subscription went silent; subscription rebuilt/);
    assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['online']); // the session never went away
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('long outage: retries back off (growing delays), then recover when the server returns; disconnect during backoff stops retries', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  try {
    const { mgr, emitted, values } = manager({ backoff: { initialMs: 40, maxMs: 320 } });
    await mgr.connect({ id: 'lo', endpointUrl: own.endpointUrl });
    await mgr.monitor('lo', own.nodeId('Scalars.Double'), 0);
    await own.stop();
    await until(() => emitted.filter(([n, p]) => n === 'opcua-connection-attempt' && p.connectionId === 'lo').length >= 6, 10_000, '5 retries');
    const attempts = emitted.filter(([n]) => n === 'opcua-connection-attempt').length;
    const conn = mgr.getConnections()[0];
    assert.strictEqual(conn.status, 'reconnecting');
    assert.match(conn.lastError, /ECONNREFUSED/);
    assert.ok(conn.nextRetryAt instanceof Date);
    // backoff: the delay doubled up to the cap (random() = 1 -> exact ceilings 40, 80, 160, 320, 320...)
    assert.strictEqual(mgr.connections.get('lo').attempt >= 5, true);

    await own.start();
    await until(() => mgr.getConnections()[0].status === 'connected', 10_000, 'recovered');
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 500, 3);
    assert.ok(emitted.filter(([n]) => n === 'opcua-connection-attempt').length > attempts);

    // stop again, then the user removes the connection while it is backing off
    await own.stop();
    await until(() => mgr.getConnections()[0].status === 'reconnecting', 5000, 'reconnecting');
    await mgr.disconnect('lo');
    const n = emitted.filter(([e]) => e === 'opcua-connection-attempt').length;
    await new Promise((r) => setTimeout(r, 700)); // longer than the max backoff: proves no retry fires
    assert.strictEqual(emitted.filter(([e]) => e === 'opcua-connection-attempt').length, n);
    assert.strictEqual(mgr.getConnections().length, 0);
  } finally {
    await own.close();
  }
});

test('edit in place while monitoring keeps the monitored nodes; a failing edit restores the previous connection', async () => {
  const { mgr, values, states } = manager();
  await mgr.connect({ id: 'ed', name: 'before', endpointUrl: srv.endpointUrl });
  await mgr.monitor('ed', N('Scalars.Int16'), 0);
  await mgr.monitor('ed', N('Scalars.UInt16'), 0);
  const res = await mgr.updateConnection('ed', { name: 'after', endpointUrl: srv.endpointUrl, username: 'operator', password: 'secret' });
  assert.strictEqual(res.status, 'connected');
  const conn = mgr.getConnections()[0];
  assert.strictEqual(conn.name, 'after');
  assert.strictEqual(conn.username, 'operator');
  assert.deepStrictEqual(conn.monitoredNodes.sort(), [N('Scalars.Int16'), N('Scalars.UInt16')].sort());
  const mark = values.length;
  srv.set('Scalars.Int16', 4242);
  await until(() => values.slice(mark).some((v) => v.nodeId === N('Scalars.Int16') && v.value === 4242), 5000, 'value after edit');
  assert.deepStrictEqual(states.map((s) => s.split(':')[0]), ['online', 'offline', 'online']);

  await assert.rejects(mgr.updateConnection('ed', { name: 'broken', endpointUrl: srv.endpointUrl, username: 'operator', password: 'bad' }), /rejected the user name or password/);
  await until(() => mgr.getConnections()[0]?.status === 'connected', 10_000, 'previous settings restored');
  const restored = mgr.getConnections()[0];
  assert.strictEqual(restored.name, 'after');
  assert.strictEqual(restored.monitoredCount, 2);
  await mgr.shutdown();
});

test('monitor while reconnecting is recorded and created on the next session; unmonitor works without a session', async () => {
  const own = await startOpcuaTestServer({ largeCount: 5 });
  try {
    const { mgr, values } = manager();
    await mgr.connect({ id: 'pr', endpointUrl: own.endpointUrl });
    await own.stop();
    await until(() => mgr.getConnections()[0].status === 'reconnecting', 5000, 'reconnecting');
    assert.strictEqual((await mgr.monitor('pr', own.nodeId('Scalars.Double'), 0)).status, 'pending');
    assert.strictEqual((await mgr.monitor('pr', own.nodeId('Scalars.Int32'), 0)).status, 'pending');
    await mgr.unmonitor('pr', own.nodeId('Scalars.Int32'));
    await own.start();
    await flowing(own, values, 'Scalars.Double', own.nodeId('Scalars.Double'), 10, 3);
    assert.strictEqual(own.monitoredItemCount(), 1);
    await mgr.shutdown();
  } finally {
    await own.close();
  }
});

test('session limit reached: BadTooManySessions is explained and nothing is left behind', async () => {
  const own = await startOpcuaTestServer({ largeCount: 1, maxSessions: 1 });
  try {
    const a = manager();
    const b = manager();
    await a.mgr.connect({ id: 'ts1', endpointUrl: own.endpointUrl });
    await assert.rejects(b.mgr.connect({ id: 'ts2', endpointUrl: own.endpointUrl }), (error) => {
      assert.match(error.message, /session limit.*\[BadTooManySessions\]/);
      return true;
    });
    assert.strictEqual(b.mgr.getConnections().length, 0);
    assert.strictEqual(own.sessionCount(), 1);
    await a.mgr.shutdown();
    await b.mgr.shutdown();
  } finally {
    await own.close();
  }
});
