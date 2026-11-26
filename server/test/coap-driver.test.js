'use strict';

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const coap = require('../drivers/coap');
const { CoapSimulator } = require('./support/coapSimulator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sims = [];
const drivers = [];
async function startSim(opts) {
  const sim = await new CoapSimulator(opts).start();
  sims.push(sim);
  return sim;
}
const tagList = (tags) => tags.map((t) => (typeof t === 'string' ? { key: t.replace(/[^A-Za-z0-9]/g, '_'), address: t } : t));
function makeDriver(sim, tags, extra = {}) {
  const d = coap.createDriver(
    { id: 'c1', name: 'Sensor', protocol: 'coap', host: '127.0.0.1', port: sim.port, options: { ackTimeoutMs: 50, ...(extra.options || {}) }, limits: { requestDeadlineMs: 1500, connectTimeoutMs: 1000, ...(extra.limits || {}) }, tags: tagList(tags) },
    { clientOptions: { ackRandomFactor: 1, observeGraceMs: 20, reregisterBackoffMs: [30], ...(extra.clientOptions || {}) }, ...(extra.deps || {}) }
  );
  drivers.push(d);
  return d;
}
async function readAll(d, keys) {
  const out = {};
  for (const req of d.plan(keys)) {
    const res = await d.execute(req, 1500);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const r of res.results) out[r.key] = r;
  }
  return out;
}

test.after(async () => {
  for (const d of drivers) await d.close();
  for (const s of sims) assert.equal(s.stats.nonGetReceived, 0, 'the driver sent a request that was not a GET');
  for (const s of sims) await s.stop();
});

// ---- descriptor, validation ----------------------------------------------------------------------

test('describe: a read-only experimental driver with browse and no subscribe', () => {
  const d = coap.describe();
  assert.equal(d.protocol, 'coap');
  assert.equal(d.readOnly, true);
  assert.equal(d.experimental, true);
  assert.equal(d.defaultPort, 5683);
  assert.deepEqual(d.capabilities, { browse: true, subscribe: false, maxInFlight: 1 });
  assert.match(d.prerequisites, /DTLS/);
  assert.match(d.prerequisites, /GET/);
  assert.ok(d.optionFields.every((f) => f.name && f.label && f.type));
});

test('validateTag: addresses, types, selectors, observe', () => {
  const ok = (t) => coap.validateTag({ key: 'k', ...t });
  const r = ok({ address: 'observe:/s/t?u=c#a.b[0]', type: 'float64', scale: 0.1, offset: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(
    { a: r.normalized.address, p: r.normalized.path, q: r.normalized.query, s: r.normalized.selector, o: r.normalized.observe, t: r.normalized.type },
    { a: 'observe:/s/t?u=c#a.b[0]', p: '/s/t', q: ['u=c'], s: 'a.b[0]', o: true, t: 'number' }
  );
  assert.equal(ok({ address: '/x', observe: true }).normalized.address, 'observe:/x');
  assert.equal(ok({ address: '/x' }).normalized.observe, false);
  assert.equal(ok({ address: '/x', type: 'boolean' }).normalized.type, 'bool');
  assert.equal(ok({ address: '/x', accept: 'application/cbor' }).normalized.accept, 60);
  assert.equal(ok({ address: '/x', accept: 112 }).normalized.accept, 112);
  for (const [tag, re] of [
    [{ address: '' }, /address is required/],
    [{ address: 'x' }, /start with "\/"/],
    [{ address: 'coaps://h/x' }, /DTLS/],
    [{ address: '/x', type: 'DINT' }, /unknown type/],
    [{ address: '/x', observe: 'yes' }, /true or false/],
    [{ address: '/x', scale: 'a' }, /scale must be/],
    [{ address: '/x', type: 'string', scale: 2 }, /only applies to number/],
    [{ address: '/x', accept: 'text/html' }, /accept must be/],
    [{ address: '/x#' }, /empty/]
  ]) {
    const r2 = ok(tag);
    assert.equal(r2.ok, false, JSON.stringify(tag));
    assert.match(r2.error, re);
  }
  assert.equal(coap.validateTag({ address: '/x' }).ok, false);
  assert.equal(coap.validateTag(null).ok, false);
});

test('createDriver: invalid configuration is refused with details', () => {
  const bad = (device, re) => assert.throws(() => coap.createDriver({ host: '127.0.0.1', ...device }), re);
  bad({ port: 0 }, /port must be an integer/);
  bad({ port: 5684 }, /DTLS/);
  bad({ options: { blockSize: 100 } }, /blockSize/);
  bad({ options: { nstart: 0 } }, /nstart/);
  bad({ options: { maxRetransmit: 9 } }, /maxRetransmit/);
  bad({ options: { connectCheck: 'maybe' } }, /connectCheck/);
  bad({ options: { accept: 'text/html' } }, /accept/);
  bad({ limits: { requestDeadlineMs: 0 } }, /requestDeadlineMs/);
  bad({ tags: [{ key: 'a', address: '/x' }, { key: 'a', address: '/y' }] }, /duplicate tag key/);
  bad({ tags: [{ key: 'a', address: 'nope' }] }, /a: address must start/);
  assert.throws(() => coap.createDriver({ host: 'coaps://dev.example/x' }), /DTLS/);
  assert.throws(() => coap.createDriver({ host: 'coap://dev.example' }), /host name or IP address only/);
  assert.throws(() => coap.createDriver({ host: '' }), /host must be/);
  try {
    coap.createDriver({ host: 'coaps://x' });
  } catch (e) {
    assert.ok(Array.isArray(e.details));
  }
  assert.match(coap.checkHost('coaps://x:5684/'), /not supported/);
  assert.equal(coap.checkHost('sensor.local'), null);
});

// ---- connect ------------------------------------------------------------------------------------------

test('connect pings the device and reports the round trip', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/temp']);
  const info = await d.connect();
  assert.equal(d.isConnected(), true);
  assert.equal(typeof info.rttMs, 'number');
  assert.equal(info.limits.blockSize, 1024);
  assert.equal(sim.stats.pings, 1);
  await d.close();
  assert.equal(d.isConnected(), false);
});

test('connect: a device that ignores the ping fails with advice; connectCheck none skips it', async () => {
  const sim = await startSim();
  sim.faults.pingSilent = true;
  const d = makeDriver(sim, ['/temp'], { limits: { connectTimeoutMs: 400 }, options: { ackTimeoutMs: 60 } });
  await assert.rejects(d.connect(), /no answer to a CoAP ping.*set "Check on connect" to none/);
  assert.equal(d.isConnected(), false);
  const d2 = makeDriver(sim, ['/temp'], { options: { connectCheck: 'none' } });
  await d2.connect();
  assert.equal(d2.isConnected(), true);
  assert.equal(sim.stats.pings >= 1, true);
  assert.equal((await readAll(d2))._temp.v, 21.5);
});

test('connect to a dead address fails or goes offline fast (ICMP unreachable)', async () => {
  const sim = await startSim();
  const port = sim.port;
  await sim.stop();
  sims.splice(sims.indexOf(sim), 1);
  const d = coap.createDriver({ host: '127.0.0.1', port, options: { ackTimeoutMs: 2000 }, limits: { connectTimeoutMs: 2000, requestDeadlineMs: 2000 }, tags: [] });
  const started = Date.now();
  await assert.rejects(d.connect());
  assert.ok(Date.now() - started < 1500);
  await d.close();
});

// ---- address pinning and the egress guard ---------------------------------------------------------------

test('the socket opens to the pinned address, never to a name', async () => {
  const sim = await startSim();
  const d = coap.createDriver({ host: 'sensor.invalid', port: sim.port, pinned: { addresses: ['127.0.0.1'] }, options: { ackTimeoutMs: 50 }, tags: tagList(['/temp']) });
  drivers.push(d);
  await d.connect();
  assert.equal((await readAll(d))._temp.v, 21.5);
  // without a pin a hostname is refused: this module never resolves anything
  const d2 = coap.createDriver({ host: 'localhost', port: sim.port, tags: [] });
  await assert.rejects(d2.connect(), /needs an IP address.*not resolved/);
});

test('the egress guard applies to the UDP destination', async () => {
  const sim = await startSim();
  const prev = process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  delete process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES;
  try {
    const d = coap.createDriver({ host: '127.0.0.1', port: sim.port, tags: [] });
    await assert.rejects(d.connect(), (e) => e.code === 'EGRESS_BLOCKED');
    for (const host of ['169.254.169.254', '224.0.0.1', '255.255.255.255', '0.0.0.0', '192.168.1.5', '10.0.0.7', '::1', 'ff02::1']) {
      const x = coap.createDriver({ host, port: 5683, tags: [] });
      await assert.rejects(x.connect(), (e) => e.code === 'EGRESS_BLOCKED', host);
    }
  } finally {
    process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = prev;
  }
  assert.equal(sim.stats.received, 0);
});

// ---- values -----------------------------------------------------------------------------------------------

test('every value shape: text, JSON, CBOR, SenML, octet-stream', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [
    { key: 'text', address: '/temp' },
    { key: 'textBool', address: '/flag' },
    { key: 'textStr', address: '/name' },
    { key: 'jNum', address: '/json#temperature' },
    { key: 'jInt', address: '/json#humidity', type: 'number' },
    { key: 'jBool', address: '/json#ok' },
    { key: 'jStr', address: '/json#label' },
    { key: 'jNested', address: '/json#nested.list[2].v' },
    { key: 'jQuoted', address: '/json#["a.b"]' },
    { key: 'jObj', address: '/json#nested' },
    { key: 'jNull', address: '/json#nothing' },
    { key: 'jMissing', address: '/json#nope' },
    { key: 'cNum', address: '/cbor#temperature' },
    { key: 'cHalf', address: '/cbor#half' },
    { key: 'cSingle', address: '/cbor#single' },
    { key: 'cInt', address: '/cbor#count' },
    { key: 'cNeg', address: '/cbor#neg' },
    { key: 'cBool', address: '/cbor#ok' },
    { key: 'cStr', address: '/cbor#label' },
    { key: 'cTag', address: '/cbor#when' },
    { key: 'cList', address: '/cbor#list[1]' },
    { key: 'sTemp', address: '/senml#urn:dev:ow:10e2073a01080063:temp' },
    { key: 'sHum', address: '/senml#urn:dev:ow:10e2073a01080063:hum' },
    { key: 'sDoor', address: '/senml#urn:dev:ow:10e2073a01080063:door' },
    { key: 'sLabel', address: '/senml#urn:dev:ow:10e2073a01080063:label' },
    { key: 'sRaw', address: '/senml#urn:dev:ow:10e2073a01080063:raw' },
    { key: 'sNone', address: '/senml' },
    { key: 'scTemp', address: '/senml-cbor#urn:dev:ow:10e2073a01080063:temp' },
    { key: 'scDoor', address: '/senml-cbor#urn:dev:ow:10e2073a01080063:door' },
    { key: 'oct', address: '/octet' },
    { key: 'octSel', address: '/octet#x' }
  ]);
  await d.connect();
  const r = await readAll(d);
  const good = (key, v, type) => {
    assert.equal(r[key].q, 192, `${key}: ${JSON.stringify(r[key])}`);
    assert.deepEqual([r[key].v, r[key].type], [v, type], key);
  };
  good('text', 21.5, 'float64');
  good('textBool', true, 'bool');
  good('textStr', 'sensor-1', 'string');
  good('jNum', 21.5, 'float64');
  good('jInt', 40, 'float64');
  good('jBool', true, 'bool');
  good('jStr', 'lab', 'string');
  good('jNested', 3, 'float64');
  good('jQuoted', 7, 'float64');
  good('jObj', '{"list":[1,2,{"v":3}]}', 'string');
  good('cNum', 21.5, 'float64');
  good('cHalf', 10, 'float64'); // 0x4900 is 10.0
  good('cSingle', 1.5, 'float64');
  good('cInt', 42, 'float64');
  good('cNeg', -7, 'float64');
  good('cBool', true, 'bool');
  good('cStr', 'cb', 'string');
  good('cTag', 1700000000, 'float64');
  good('cList', 2, 'float64');
  good('sTemp', 21.5, 'float64');
  good('sHum', 40, 'float64');
  good('sDoor', true, 'bool');
  good('sLabel', 'lab-3', 'string');
  good('sRaw', '010203', 'string');
  good('scTemp', 21.5, 'float64');
  good('scDoor', true, 'bool');
  good('oct', 'deadbeef', 'string');
  for (const key of ['jNull', 'jMissing', 'sNone', 'octSel']) {
    assert.equal(r[key].q, 0, key);
    assert.equal(r[key].v, null, key);
    assert.match(r[key].qReason, /^decode: /, key);
  }
  assert.match(r.jMissing.qReason, /no member "nope"/);
  assert.match(r.sNone.qReason, /add a selector/);
  assert.match(r.jNull.qReason, /null/);
});

test('type coercion and scale/offset', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [
    { key: 'scaled', address: '/json#humidity', type: 'number', scale: 0.5, offset: 1 },
    { key: 'asBool', address: '/json#humidity', type: 'bool' },
    { key: 'asStr', address: '/json#temperature', type: 'string' },
    { key: 'strAsNum', address: '/json#label', type: 'number' },
    { key: 'txtAsBool', address: '/flag', type: 'bool' },
    { key: 'objAsNum', address: '/json#nested', type: 'number' }
  ]);
  await d.connect();
  const r = await readAll(d);
  assert.equal(r.scaled.v, 21);
  assert.equal(r.asBool.v, true);
  assert.equal(r.asStr.v, '21.5');
  assert.equal(r.strAsNum.q, 0);
  assert.match(r.strAsNum.qReason, /cannot read "lab" as a number/);
  assert.equal(r.txtAsBool.v, true);
  assert.equal(r.objAsNum.q, 0);
  assert.match(r.objAsNum.qReason, /an object, not a number/);
});

test('response codes: 4.xx and 5.xx are Bad with the code name; the device stays online', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/missing', '/forbidden', '/temp']);
  await d.connect();
  const r = await readAll(d);
  assert.deepEqual([r._missing.q, r._missing.qReason, r._missing.v], [0, '4.04 Not Found', null]);
  assert.deepEqual([r._forbidden.q, r._forbidden.qReason], [0, '4.03 Forbidden']);
  assert.equal(r._temp.q, 192);
  assert.equal(d.isConnected(), true);
});

test('5.03 Service Unavailable: Max-Age is honoured, the device is not asked again before it passes', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/unavail']);
  await d.connect();
  const [req] = d.plan();
  const first = await d.execute(req, 1500);
  assert.match(first.results[0].qReason, /^5\.03 Service Unavailable \(retry in 1 s\)$/);
  const before = sim.requests.filter((q) => q.path === '/unavail').length;
  const second = await d.execute(req, 1500);
  assert.match(second.results[0].qReason, /^5\.03/);
  assert.equal(sim.requests.filter((q) => q.path === '/unavail').length, before);
  await sleep(1100);
  await d.execute(req, 1500);
  assert.equal(sim.requests.filter((q) => q.path === '/unavail').length, before + 1);
});

test('a malformed body is Bad with the reason, not a crash', async () => {
  const sim = await startSim({ resources: { '/badjson': { cf: 50, body: '{oops' }, '/badcbor': { cf: 60, body: Buffer.from([0x1a, 0, 0]) }, '/badutf': { cf: 0, body: Buffer.from([0xff, 0xfe]) }, '/badsenml': { cf: 110, body: '[1,2]' } } });
  const d = makeDriver(sim, [{ key: 'j', address: '/badjson#a' }, { key: 'c', address: '/badcbor#a' }, { key: 'u', address: '/badutf' }, { key: 's', address: '/badsenml#a' }]);
  await d.connect();
  const r = await readAll(d);
  for (const k of ['j', 'c', 'u', 's']) {
    assert.equal(r[k].q, 0, k);
    assert.match(r[k].qReason, /^decode: /, k);
  }
});

test('a response that is too large is Bad, and the driver keeps working', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/big', '/temp'], { options: { maxResponseBytes: 2048, blockSize: 256 } });
  await d.connect();
  const r = await readAll(d);
  assert.equal(r._big.q, 0);
  assert.match(r._big.qReason, /toolarge/);
  assert.equal(r._temp.q, 192);
});

test('block-wise reads work through the driver', async () => {
  const sim = await startSim({ maxSzx: 3 });
  const d = makeDriver(sim, [{ key: 'last', address: '/bigjson#last' }, { key: 'item', address: '/bigjson#items[299].v' }]);
  await d.connect();
  const r = await readAll(d);
  assert.equal(r.last.v, 'end');
  assert.equal(r.item.v, 598);
  assert.equal(sim.requests.filter((q) => q.path === '/bigjson').length > 5, true);
  // both tags share one resource, so one transfer served them both
  assert.equal(sim.requests.filter((q) => q.path === '/bigjson' && q.block2.num === 0).length, 1);
});

test('the Accept option is sent when configured', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/json'], { options: { accept: 'application/cbor' } });
  await d.connect();
  await readAll(d);
  assert.equal(sim.requests.at(-1).accept, 60);
  const d2 = makeDriver(sim, [{ key: 'a', address: '/temp', accept: 'text/plain' }]);
  await d2.connect();
  await readAll(d2);
  assert.equal(sim.requests.at(-1).accept, 0);
});

// ---- timeouts, resets and the runtime contract ----------------------------------------------------------------------

test('no answer at all is a fatal timeout (the runtime reconnects); a Reset is not', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/temp'], { options: { ackTimeoutMs: 50, maxRetransmit: 1 } });
  await d.connect();
  const [req] = d.plan();
  sim.faults.resetNext = 1;
  const reset = await d.execute(req, 1500);
  assert.equal(reset.ok, true);
  assert.deepEqual([reset.results[0].q, reset.results[0].qReason], [0, 'reset by device']);
  sim.faults.silent = true;
  const res = await d.execute(req, 600);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'timeout');
  assert.equal(res.fatal, true);
  sim.faults.silent = false;
  assert.equal((await d.execute(req, 600)).results[0].v, 21.5); // UDP: the next request just works
});

test('execute before connect and after close is a fatal transport result', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/temp']);
  const [req] = d.plan();
  assert.deepEqual(await d.execute(req, 100), { ok: false, kind: 'transport', fatal: true, message: 'not connected' });
  await d.connect();
  await d.close();
  assert.equal((await d.execute(req, 100)).fatal, true);
  await d.close();
});

test('plan: one request per resource, grouped by observe and accept; no bisect', () => {
  const sim = { port: 1 };
  const d = makeDriver(sim, [
    { key: 'a', address: '/json#temperature' },
    { key: 'b', address: '/json#humidity' },
    { key: 'c', address: '/json?x=1#temperature' },
    { key: 'd', address: 'observe:/json#temperature' },
    { key: 'e', address: '/json#ok', accept: 'application/cbor' }
  ]);
  const plan = d.plan();
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((p) => p.items.map((i) => i.key)), [['a', 'b'], ['c'], ['d'], ['e']]);
  assert.equal(plan[1].query[0], 'x=1');
  assert.equal(plan[2].observe, true);
  assert.equal(d.bisect(plan[0]), null);
  assert.throws(() => d.plan(['zz']), /unknown tag key/);
});

test('a large tag set is planned and read as one request per resource', async () => {
  const resources = {};
  const tags = [];
  for (let r = 0; r < 50; r++) {
    resources[`/dev/${r}`] = { cf: 50, body: JSON.stringify(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, r * 100 + i]))) };
    for (let i = 0; i < 10; i++) tags.push({ key: `t_${r}_${i}`, address: `/dev/${r}#f${i}` });
  }
  const s2 = await startSim({ resources });
  const d = makeDriver(s2, tags);
  await d.connect();
  const plan = d.plan();
  assert.equal(plan.length, 50);
  const r = await readAll(d);
  assert.equal(Object.keys(r).length, 500);
  assert.equal(r.t_7_3.v, 703);
  assert.equal(r.t_49_9.v, 4909);
  assert.equal(s2.requests.filter((q) => q.path.startsWith('/dev/')).length, 50);
});

test('interRequestDelayMs paces requests', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['/temp', '/name'], { limits: { interRequestDelayMs: 120 } });
  await d.connect();
  const t0 = Date.now();
  await readAll(d);
  assert.ok(Date.now() - t0 >= 110);
});

// ---- observe through the driver --------------------------------------------------------------------------------

test('observe tags: registered once, then served from notifications without further requests', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs' }]);
  await d.connect();
  const [req] = d.plan();
  assert.equal((await d.execute(req, 1500)).results[0].v, 1);
  assert.equal(sim.stats.registrations, 1);
  const gets = sim.requests.length;
  for (let i = 0; i < 3; i++) assert.equal((await d.execute(req, 1500)).results[0].v, 1);
  assert.equal(sim.requests.length, gets); // nothing was sent: the value comes from the observation
  sim.notify('/obs', { body: '2' });
  await until(async () => (await d.execute(req, 1500)).results[0].v === 2, 1500, 'notified value');
  assert.equal(sim.requests.length, gets);
  await d.close();
  assert.equal(sim.stats.deregistrations, 1); // GET Observe=1 on stop
});

test('observe tags: a value past its Max-Age is Uncertain (stale) until the device confirms it', async () => {
  const sim = await startSim({ resources: { '/obs': { cf: 0, body: '9', observable: true, maxAge: 1 } } });
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs' }], { clientOptions: { observeGraceMs: 600 } });
  await d.connect();
  const [req] = d.plan();
  assert.equal((await d.execute(req, 1500)).results[0].q, 192);
  await sleep(1150);
  const stale = (await d.execute(req, 1500)).results[0];
  assert.deepEqual([stale.q, stale.qReason, stale.v], [64, 'stale', 9]);
  sim.notify('/obs', { body: '10' }); // a notification freshens it again
  await until(async () => (await d.execute(req, 1500)).results[0].q === 192, 1500, 'fresh again');
});

test('observe tags: notifications that arrive out of order do not roll the value back', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs' }]);
  await d.connect();
  const [req] = d.plan();
  await d.execute(req, 1500);
  sim.notify('/obs', { body: '30', seq: 30 });
  await until(async () => (await d.execute(req, 1500)).results[0].v === 30);
  sim.notify('/obs', { body: '20', seq: 20 });
  await sleep(60);
  assert.equal((await d.execute(req, 1500)).results[0].v, 30);
});

test('observe tags: a device that ignores Observe is polled instead', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs-ignore' }]);
  await d.connect();
  const [req] = d.plan();
  assert.equal((await d.execute(req, 1500)).results[0].v, 5);
  sim.setResource('/obs-ignore', { cf: 0, body: '6', observable: false });
  assert.equal((await d.execute(req, 1500)).results[0].v, 6); // a fresh GET, no stale cache
  const regs = sim.requests.filter((q) => q.path === '/obs-ignore' && q.observe === 0).length;
  assert.equal(regs, 1); // registered once, then plain GETs
});

test('observe tags: re-registration after a Reset and after Max-Age keeps values flowing', async () => {
  const sim = await startSim({ resources: { '/obs': { cf: 0, body: 'x', observable: true, maxAge: 1 } } });
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs', type: 'string' }], { clientOptions: { observeGraceMs: 20, reregisterBackoffMs: [30] } });
  await d.connect();
  const [req] = d.plan();
  await d.execute(req, 1500);
  sim.faults.resetNext = 1;
  await until(() => sim.stats.registrations >= 2, 5000, 'registered again after the Reset and Max-Age');
  sim.notify('/obs', { body: 'y' });
  await until(async () => (await d.execute(req, 1500)).results[0].v === 'y', 1500, 'value after re-registration');
});

test('observe and poll tags on the same resource do not interfere', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [{ key: 'p', address: '/obs' }, { key: 'o', address: 'observe:/obs' }]);
  await d.connect();
  const r = await readAll(d);
  assert.equal(r.p.v, 1);
  assert.equal(r.o.v, 1);
  assert.equal(d.plan().length, 2);
});

// ---- browse and probe --------------------------------------------------------------------------------------------

test('browse: /.well-known/core lists resources with their attributes', async () => {
  const sim = await startSim({ resources: { '/s/temp': { cf: 0, body: '1', observable: true, rt: 'temperature-c' } } });
  const d = makeDriver(sim, []);
  await d.connect();
  const nodes = await d.browse();
  const byAddr = Object.fromEntries(nodes.map((n) => [n.address, n]));
  assert.ok(byAddr['/temp']);
  assert.equal(byAddr['/.well-known/core'], undefined);
  assert.equal(byAddr['/s/temp'].meta.observable, true);
  assert.equal(byAddr['/s/temp'].meta.rt, 'temperature-c');
  assert.equal(byAddr['/json'].meta.hasChildren, true);
  assert.equal(byAddr['/temp'].meta.hasChildren, false);
  assert.equal(byAddr['/senml'].meta.contentFormats, 'application/senml+json');
  assert.ok(nodes.every((n) => n.kind === 'tag' && n.id.startsWith('res:')));
});

test('browse: a structured resource expands into its values, SenML units become metadata', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, []);
  await d.connect();
  const senml = await d.browse('res:/senml');
  const temp = senml.find((n) => n.name.endsWith(':temp'));
  assert.equal(temp.address, '/senml#urn:dev:ow:10e2073a01080063:temp');
  assert.deepEqual([temp.meta.dataType, temp.meta.value, temp.meta.unit], ['number', 21.5, 'Cel']);
  assert.equal(senml.find((n) => n.name.endsWith(':hum')).meta.unit, '%RH');
  assert.equal(senml.find((n) => n.name.endsWith(':door')).meta.dataType, 'bool');
  const cb = await d.browse('res:/senml-cbor');
  assert.equal(cb.length, 4);
  const json = await d.browse('res:/json');
  assert.ok(json.some((n) => n.address === '/json#nested.list[2].v'));
  assert.ok(json.some((n) => n.address === '/json#["a.b"]'));
  await assert.rejects(d.browse('bogus'), /unknown browse node/);
  await assert.rejects(d.browse('res:/missing'), /4\.04 Not Found/);
  // an address from browse is a valid tag address that reads back the same value
  const tag = coap.validateTag({ key: 'x', address: temp.address });
  assert.equal(tag.ok, true);
});

test('browse: a device without /.well-known/core says so', async () => {
  const sim = await startSim();
  sim.resources['/.well-known/core'] = { cf: 40, body: 'x', code: 0x84 };
  const d = makeDriver(sim, []);
  await d.connect();
  await assert.rejects(d.browse(), /does not publish a resource list/);
});

test('probe: shows the response and every way to read it', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, []);
  await d.connect();
  const p = await d.probe({ address: '/senml#urn:dev:ow:10e2073a01080063:temp' });
  assert.equal(p.type, 'application/senml+json');
  assert.equal(p.decodings['response code'], '2.05 Content');
  assert.equal(p.decodings.value, 21.5);
  assert.equal(p.decodings.unit, 'Cel');
  assert.match(p.decodings['senml urn:dev:ow:10e2073a01080063:temp'], /^21\.5 Cel$/);
  assert.ok(p.rawHex.startsWith('5b7b'));
  const t = await d.probe({ address: '/temp' });
  assert.equal(t.decodings.value, 21.5);
  const big = await d.probe({ address: '/big' });
  assert.match(big.decodings.size, /3000 bytes in 3 blocks/);
  const err = await d.probe({ address: '/missing' });
  assert.equal(err.decodings['response code'], '4.04 Not Found');
  await assert.rejects(d.probe({ address: 'nope' }), /start with/);
  await assert.rejects(d.probe({ address: 'coaps://x/y' }), /DTLS/);
});

// ---- read-only ---------------------------------------------------------------------------------------------

test('whatever the driver does, no request other than GET reaches the device', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [{ key: 'o', address: 'observe:/obs' }, { key: 'b', address: '/big' }, { key: 's', address: '/sep' }, '/missing']);
  await d.connect();
  await readAll(d);
  await d.browse();
  await d.browse('res:/json');
  await d.probe({ address: '/temp' });
  await d.close();
  assert.ok(sim.stats.gets > 5);
  assert.equal(sim.stats.nonGetReceived, 0);
  assert.ok(sim.requests.every((q) => q.method === 1));
  // no write-shaped surface on the driver
  for (const name of ['write', 'put', 'post', 'delete', 'patch', 'fetch', 'send', 'set']) assert.equal(typeof d[name], 'undefined', name);
});
