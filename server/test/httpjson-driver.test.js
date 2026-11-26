'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createDriver, validateTag, describe: describeDriver, protocol, coerce, toTimestamp } = require('../drivers/httpjson');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { startHttpJsonSimulator } = require('./support/httpJsonSimulator');
const { CERT, FINGERPRINT256 } = require('./support/tlsFixture');

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const DEADLINE = 400;
const sims = [];
const drivers = [];

const METER = {
  device: { name: 'meter-1', online: true, mode: 'auto' },
  power: { total: 12.5, voltage: '230.4', phases: [{ id: 'L1', w: 4.1 }, { id: 'L2', w: 4.2 }] },
  status: { code: 'OK', ts: '2025-03-04T05:06:07.250Z', epoch: 1741064767 },
  items: [{ id: 'main', kwh: 100 }, { id: 'aux', kwh: 7 }]
};

async function setup({ tls = false, device = {}, docs = { '/meter': METER } } = {}) {
  const sim = await startHttpJsonSimulator({ tls, docs });
  sims.push(sim);
  const drv = createDriver({
    id: 'd1', name: 'dev', protocol, host: '127.0.0.1', port: sim.port, scheme: tls ? 'https' : 'http',
    limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 500 }, tags: [], ...device
  });
  drivers.push(drv);
  return { sim, drv };
}

const T = (key, address, type = 'number', extra = {}) => ({ key, address, type, ...extra });

async function readAll(drv) {
  const out = {};
  for (const r of drv.plan()) {
    const res = await drv.execute(r, DEADLINE);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const x of res.results) out[x.key] = x;
  }
  return out;
}

test.after(async () => {
  await Promise.all(drivers.map((d) => d.close().catch(() => {})));
  await Promise.all(sims.map((s) => s.close()));
});

test('describe: read-only, experimental, browsable; secret fields are declared', () => {
  const d = describeDriver();
  assert.equal(protocol, 'http-json');
  assert.equal(d.readOnly, true);
  assert.equal(d.experimental, true);
  assert.equal(d.capabilities.browse, true);
  assert.deepEqual(d.tagTypes, ['number', 'bool', 'string']);
  assert.deepEqual(d.secretFields.sort(), ['authHeaderSecret', 'authPassword', 'authToken']);
  for (const f of d.secretFields) assert.equal(d.deviceFields.find((x) => x.name === f).type, 'password');
});

test('validateTag: address forms, explicit path/selector, optional rules, and every refusal', () => {
  const ok = validateTag(T('a', '/api/status?unit=1#$.power.total'));
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.path, '/api/status?unit=1');
  assert.equal(ok.normalized.selector, '$.power.total');
  assert.equal(ok.normalized.steps, undefined, 'compiled steps stay internal');
  assert.equal(validateTag({ key: 'b', type: 'string', path: '/x', selector: '$.a' }).ok, true);
  assert.equal(validateTag(T('c', '/x#$.a', 'number', { timestampSelector: '$.ts', qualitySelector: '$.state', qualityEquals: 'OK', okStatus: [200, 404] })).ok, true);
  const refuse = [
    [T('', '/x#$.a'), /key/],
    [T('k', '/x#$.a', 'int16'), /unknown type/],
    [T('k', '/x'), /selector after/],
    [T('k', 'x#$.a'), /start with "\/"/],
    [T('k', '//evil.example/x#$.a'), /"\/\/"/],
    [T('k', '/a b#$.a'), /spaces/],
    [T('k', '/a/../b#$.a'), /"\.\."/],
    [T('k', '/x#$..a'), /recursive/],
    [T('k', '/x#$.a[?(@.k>1)]'), /selector/],
    [T('k', '/x#$.a', 'number', { timestampSelector: 'ts' }), /timestampSelector/],
    [T('k', '/x#$.a', 'number', { qualitySelector: '$.s' }), /qualityEquals/],
    [T('k', '/x#$.a', 'number', { qualityEquals: 1 }), /needs a qualitySelector/],
    [T('k', '/x#$.a', 'number', { okStatus: [] }), /okStatus/],
    [T('k', '/x#$.a', 'number', { okStatus: [99] }), /okStatus/],
    [null, /object/]
  ];
  for (const [tag, re] of refuse) {
    const r = validateTag(tag);
    assert.equal(r.ok, false, JSON.stringify(tag));
    assert.match(r.error, re);
  }
});

test('createDriver rejects bad device config with per-field details', () => {
  const bad = (over, re) =>
    assert.throws(() => createDriver({ host: '127.0.0.1', port: 80, tags: [], ...over }), (e) => re.test(e.message) && Array.isArray(e.details));
  bad({ scheme: 'ftp' }, /scheme/);
  bad({ authType: 'basic' }, /authUsername/);
  bad({ authType: 'basic', authUsername: 'a:b' }, /authUsername/);
  bad({ authType: 'bearer' }, /authToken/);
  bad({ authType: 'header', authHeaderName: 'bad name', authHeaderSecret: 'x' }, /authHeaderName/);
  bad({ authType: 'header', authHeaderName: 'Host', authHeaderSecret: 'x' }, /controls/);
  bad({ authType: 'bearer', authToken: 'a\r\nX-Evil: 1' }, /control characters/);
  bad({ scheme: 'https', tlsFingerprint256: 'abc' }, /fingerprint/);
  bad({ scheme: 'https', tlsCa: 'not a pem' }, /PEM/);
  bad({ path: '/a b' }, /path:/);
  bad({ options: { maxResponseBytes: 10 } }, /maxResponseBytes/);
  bad({ options: { testPath: 'x' } }, /testPath/);
  bad({ tags: [T('a', '/x#$.a'), T('a', '/x#$.b')] }, /duplicate/);
  bad({ tags: [T('a', '/x#nope')] }, /selector/);
  bad({ host: '' }, /host/);
});

test('TLS settings left over from https are ignored on plain http (the form hides them), never applied', async () => {
  const { drv } = await setup({ device: { tlsInsecure: true, tlsFingerprint256: 'AA'.repeat(32), tags: [T('t', '/meter#$.power.total')] } });
  await drv.connect();
  assert.equal((await readAll(drv)).t.v, 12.5);
});

test('happy path: types, scale-free values, one request per distinct path, shared by every tag', async () => {
  const { sim, drv } = await setup({
    docs: { '/meter': METER, '/other': { n: 1 } },
    device: {
      tags: [
        T('total', '/meter#$.power.total'),
        T('voltage', '/meter#$.power.voltage'), // numeric string -> number
        T('l2', '/meter#$.power.phases[?(@.id=="L2")].w'),
        T('aux', '/meter#$.items[?(@.id=="aux")].kwh'),
        T('online', '/meter#$.device.online', 'bool'),
        T('name', '/meter#$.device.name', 'string'),
        T('codeAsText', '/meter#$.power.total', 'string'),
        T('n', '/other#$.n')
      ]
    }
  });
  await drv.connect();
  sim.clearRequests();
  const r = await readAll(drv);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r).map(([k, x]) => [k, [x.v, x.q]])),
    { total: [12.5, 192], voltage: [230.4, 192], l2: [4.2, 192], aux: [7, 192], online: [true, 192], name: ['meter-1', 192], codeAsText: ['12.5', 192], n: [1, 192] }
  );
  const gets = sim.requests.map((q) => q.url);
  assert.deepEqual(gets.sort(), ['/meter', '/other']);
  assert.equal(drv.plan().length, 2);
  assert.deepEqual(drv.plan().map((q) => q.items.length).sort(), [1, 7]);
});

test('every request is a GET without a body; a non-GET never leaves the client', async () => {
  const { sim, drv } = await setup({ device: { tags: [T('t', '/meter#$.power.total')] } });
  await drv.connect();
  await readAll(drv);
  await drv.browse('/meter');
  await drv.probe({ address: '/meter#$.power.total' });
  assert.ok(sim.requests.length >= 4);
  for (const q of sim.requests) {
    assert.equal(q.method, 'GET');
    assert.equal(q.bodyBytes, 0);
    assert.equal(q.headers['transfer-encoding'], undefined);
  }
  // The driver and its client expose no way to choose another method.
  assert.equal(drv.write, undefined);
  assert.equal(drv.put, undefined);
  const src = require('node:fs').readFileSync(require.resolve('../drivers/common/httpClient.js'), 'utf8');
  const calls = src.match(/method:\s*'[A-Z]+'/g);
  assert.deepEqual(calls, ["method: 'GET'"]);
});

test('coercion rules', () => {
  assert.deepEqual(coerce('12', 'number'), { ok: true, v: 12 });
  assert.deepEqual(coerce(' -1.5e2 ', 'number'), { ok: true, v: -150 });
  assert.deepEqual(coerce(true, 'number'), { ok: true, v: 1 });
  for (const v of ['', 'abc', '0x10', '1,5', 'NaN', 'Infinity', {}, [], null]) assert.equal(coerce(v, 'number').ok, false, String(v));
  assert.deepEqual(coerce(1, 'bool'), { ok: true, v: true });
  assert.deepEqual(coerce('Off', 'bool'), { ok: true, v: false });
  assert.deepEqual(coerce('yes', 'bool'), { ok: true, v: true });
  for (const v of [2, 'maybe', {}, null]) assert.equal(coerce(v, 'bool').ok, false, String(v));
  assert.deepEqual(coerce(5, 'string'), { ok: true, v: '5' });
  assert.deepEqual(coerce({ a: 1 }, 'string'), { ok: true, v: '{"a":1}' });
  assert.equal(coerce(null, 'string').ok, false);
  assert.equal(toTimestamp('2025-03-04T05:06:07.250Z'), Date.parse('2025-03-04T05:06:07.250Z'));
  assert.equal(toTimestamp(1741064767), 1741064767000);
  assert.equal(toTimestamp(1741064767123), 1741064767123);
  assert.equal(toTimestamp('1741064767'), 1741064767000);
  for (const v of ['garbage', 5, -1, null, {}, '']) assert.equal(toTimestamp(v), undefined, String(v));
});

test('source timestamp from a selector; a bad timestamp keeps the value Good', async () => {
  const { drv } = await setup({
    device: {
      tags: [
        T('iso', '/meter#$.power.total', 'number', { timestampSelector: '$.status.ts' }),
        T('epoch', '/meter#$.power.total', 'number', { timestampSelector: '$.status.epoch' }),
        T('junk', '/meter#$.power.total', 'number', { timestampSelector: '$.status.code' }),
        T('missing', '/meter#$.power.total', 'number', { timestampSelector: '$.nope' })
      ]
    }
  });
  await drv.connect();
  const r = await readAll(drv);
  assert.equal(r.iso.tSource, Date.parse('2025-03-04T05:06:07.250Z'));
  assert.equal(r.epoch.tSource, 1741064767000);
  for (const k of ['junk', 'missing']) {
    assert.equal(r[k].tSource, undefined);
    assert.equal(r[k].q, 192);
  }
});

test('Bad quality reasons: type, no match, null, quality rule, not JSON, empty, BOM-prefixed JSON is fine', async () => {
  const { sim, drv } = await setup({
    docs: { '/meter': { ...METER, state: 'FAULT', nul: null } },
    device: {
      tags: [
        T('text', '/meter#$.device.name'), // number from text
        T('gone', '/meter#$.power.nope.x'),
        T('nul', '/meter#$.nul'),
        T('ruled', '/meter#$.power.total', 'number', { qualitySelector: '$.state', qualityEquals: 'OK' }),
        T('ruledMissing', '/meter#$.power.total', 'number', { qualitySelector: '$.nostate', qualityEquals: 'OK' }),
        T('html', '/page#$.a'),
        T('empty', '/empty#$.a'),
        T('bom', '/bom#$.a')
      ]
    }
  });
  sim.setRaw('/page', '<html>Login</html>', { headers: { 'content-type': 'text/html' } });
  sim.setRaw('/empty', '');
  sim.setRaw('/bom', '﻿{"a": 5}');
  await drv.connect();
  const r = await readAll(drv);
  assert.match(r.text.qReason, /^type-mismatch/);
  assert.match(r.gone.qReason, /^selector-no-match \(stopped at \$\.power\)/);
  assert.equal(r.nul.qReason, 'null-value');
  assert.match(r.ruled.qReason, /^quality-rule .*"FAULT"/);
  assert.match(r.ruledMissing.qReason, /^quality-rule \(field missing\)/);
  assert.equal(r.html.qReason, 'not-json');
  assert.equal(r.empty.qReason, 'not-json');
  assert.deepEqual([r.bom.v, r.bom.q], [5, 192]);
  for (const k of ['text', 'gone', 'nul', 'ruled', 'ruledMissing', 'html', 'empty']) {
    assert.equal(r[k].q, 0, k);
    assert.equal(r[k].v, null, k);
  }
  assert.equal(drv.isConnected(), true, 'bad data never takes the device offline');
});

test('HTTP status: non-2xx is Bad "http-<status>" with the device still online; okStatus widens it', async () => {
  const { sim, drv } = await setup({
    device: { tags: [T('a', '/s500#$.v'), T('b', '/s404#$.v'), T('c', '/s404#$.v', 'number', { okStatus: [404] }), T('d', '/missing#$.v')] }
  });
  sim.setStatus('/s500', 500, '{"v":1}');
  sim.setStatus('/s404', 404, '{"v":2}');
  await drv.connect();
  const r = await readAll(drv);
  assert.equal(r.a.qReason, 'http-500');
  assert.equal(r.b.qReason, 'http-404');
  assert.deepEqual([r.c.v, r.c.q], [2, 192]);
  assert.equal(r.d.qReason, 'http-404');
  assert.equal(drv.isConnected(), true);
});

test('size cap: a chunked body and a declared length both abort and go Bad "too-large"', async () => {
  const { sim, drv } = await setup({
    device: { options: { maxResponseBytes: 4096 }, tags: [T('a', '/big#$.pad', 'string'), T('b', '/declared#$.pad', 'string'), T('ok', '/meter#$.power.total')] }
  });
  sim.setOversize('/big', 5 * 1024 * 1024);
  sim.setOversizeDeclared('/declared', 10 * 1024 * 1024);
  await drv.connect();
  const started = Date.now();
  const r = await readAll(drv);
  assert.equal(r.a.qReason, 'too-large');
  assert.equal(r.b.qReason, 'too-large');
  assert.equal(r.ok.v, 12.5, 'other paths are unaffected');
  assert.ok(Date.now() - started < 1500, 'aborted early instead of reading everything');
});

test('timeouts: Bad "timeout" first, offline (fatal) after three in a row, reset by any answer', async () => {
  const { sim, drv } = await setup({ device: { limits: { requestDeadlineMs: 80, connectTimeoutMs: 500 }, tags: [T('s', '/slow#$.v'), T('ok', '/meter#$.power.total')] } });
  sim.setJson('/slow', { v: 1 });
  sim.setDelay('/slow', 400);
  await drv.connect();
  const [slow] = drv.plan(['s']);
  const [fast] = drv.plan(['ok']);
  for (let i = 0; i < 2; i++) {
    const res = await drv.execute(slow, 80);
    assert.equal(res.ok, true);
    assert.equal(res.results[0].qReason, 'timeout');
  }
  assert.equal((await drv.execute(fast, 300)).ok, true); // an answer resets the count
  assert.equal((await drv.execute(slow, 80)).results[0].qReason, 'timeout');
  assert.equal((await drv.execute(slow, 80)).results[0].qReason, 'timeout');
  const third = await drv.execute(slow, 80);
  assert.deepEqual([third.ok, third.fatal, third.kind], [false, true, 'timeout']);
});

test('connection refused and dropped connections are fatal transport errors', async () => {
  const { sim, drv } = await setup({ device: { tags: [T('t', '/meter#$.power.total')] } });
  await drv.connect();
  sim.dropNext('/meter');
  const dropped = await drv.execute(drv.plan()[0], DEADLINE);
  assert.deepEqual([dropped.ok, dropped.fatal, dropped.kind], [false, true, 'transport']);
  await sim.stopListening();
  const refused = await drv.execute(drv.plan()[0], DEADLINE);
  assert.deepEqual([refused.ok, refused.fatal, refused.kind], [false, true, 'transport']);
  assert.match(refused.message, /ECONNREFUSED|ECONNRESET/);
  await assert.rejects(drv.connect(), /ECONNREFUSED/);
  await sim.startListening();
  await drv.connect();
  assert.equal((await drv.execute(drv.plan()[0], DEADLINE)).ok, true);
});

test('redirects: same host followed (still GET), another host or port refused and never contacted', async () => {
  const { sim, drv } = await setup({ device: { tags: [T('same', '/old#$.power.total'), T('away', '/away#$.v'), T('port', '/otherport#$.v'), T('loop', '/loop#$.v')] } });
  sim.setRedirect('/old', '/meter', 301);
  sim.setRedirect('/away', 'http://203.0.113.9/steal');
  sim.setRedirect('/otherport', `http://127.0.0.1:${sim.port + 1}/x`);
  sim.setRedirect('/loop', '/loop', 307);
  await drv.connect();
  sim.clearRequests();
  const r = await readAll(drv);
  assert.deepEqual([r.same.v, r.same.q], [12.5, 192]);
  assert.match(r.away.qReason, /^redirect-refused .*another host/);
  assert.match(r.port.qReason, /^redirect-refused/);
  assert.match(r.loop.qReason, /too many redirects/);
  assert.ok(sim.requests.every((q) => q.method === 'GET'));
  assert.ok(sim.requests.every((q) => !q.url.includes('steal')));
});

test('a redirect never carries credentials to another host (and is not followed at all)', async () => {
  const other = await startHttpJsonSimulator({});
  sims.push(other);
  const { sim, drv } = await setup({ device: { authType: 'bearer', authToken: 'S3CRET', tags: [T('away', '/away#$.v')] } });
  sim.requireHeader('authorization', 'Bearer S3CRET');
  sim.setRedirect('/away', `${other.url}/capture`);
  await drv.connect();
  const r = await readAll(drv);
  assert.match(r.away.qReason, /redirect-refused/);
  assert.equal(other.requests.length, 0);
});

test('ETag: If-None-Match is sent, 304 serves the cached document, a changed ETag refreshes it', async () => {
  const { sim, drv } = await setup({ docs: {}, device: { tags: [T('t', '/e#$.v'), T('u', '/e#$.w', 'string')] } });
  sim.setJson('/e', { v: 1, w: 'a' }, { etag: true });
  await drv.connect();
  sim.clearRequests();
  let r = await readAll(drv);
  assert.equal(r.t.v, 1);
  assert.equal(r.u.v, 'a');
  assert.equal(sim.requests[0].headers['if-none-match'], undefined);
  r = await readAll(drv);
  assert.ok(sim.requests[1].headers['if-none-match']);
  assert.equal(sim.notModifiedCount('/e'), 1);
  assert.deepEqual([r.t.v, r.t.q], [1, 192]);
  sim.setJson('/e', { v: 2, w: 'b' }, { etag: true });
  r = await readAll(drv);
  assert.deepEqual([r.t.v, r.t.q], [2, 192]);
  assert.equal(sim.notModifiedCount('/e'), 1);
});

test('authentication: basic, bearer and custom header reach the device; a 401 fails connect with the status', async () => {
  const cases = [
    [{ authType: 'basic', authUsername: 'user', authPassword: 'p@ss:word' }, 'authorization', `Basic ${Buffer.from('user:p@ss:word').toString('base64')}`],
    [{ authType: 'bearer', authToken: 'tok123' }, 'authorization', 'Bearer tok123'],
    [{ authType: 'header', authHeaderName: 'X-Api-Key', authHeaderSecret: 'k-9' }, 'x-api-key', 'k-9']
  ];
  for (const [dev, header, value] of cases) {
    const { sim, drv } = await setup({ device: { ...dev, tags: [T('t', '/meter#$.power.total')] } });
    sim.requireHeader(header, value);
    await drv.connect();
    assert.equal((await readAll(drv)).t.v, 12.5, dev.authType);
    // no credentials -> 401 -> the device is reported unreachable with a useful message
    const { sim: s2, drv: d2 } = await setup({ device: { tags: [] } });
    s2.requireHeader(header, value);
    await assert.rejects(d2.connect(), /401.*credentials/);
  }
});

test('requests carry no Accept-Encoding other than identity and a plain user agent; compressed answers are Bad', async () => {
  const { sim, drv } = await setup({ device: { tags: [T('z', '/gz#$.v')] } });
  sim.setEncoding('/gz', 'gzip');
  await drv.connect();
  const r = await readAll(drv);
  assert.match(r.z.qReason, /unsupported-encoding/);
  assert.equal(sim.requests.at(-1).headers['accept-encoding'], 'identity');
  assert.match(sim.requests.at(-1).headers['user-agent'], /^manifold-http-json/);
});

test('base path is prefixed; keep-alive reuses one connection, and can be turned off', async () => {
  const { sim, drv } = await setup({ docs: { '/api/v1/meter': METER }, device: { path: 'api/v1/', tags: [T('t', '/meter#$.power.total')] } });
  await drv.connect();
  sim.clearRequests();
  for (let i = 0; i < 5; i++) assert.equal((await readAll(drv)).t.v, 12.5);
  assert.ok(sim.requests.every((q) => q.url === '/api/v1/meter'));
  assert.equal(sim.opened, 1, 'one socket for all polls');
  const off = await setup({ device: { options: { keepAlive: false }, tags: [T('t', '/meter#$.power.total')] } });
  await off.drv.connect();
  for (let i = 0; i < 3; i++) await readAll(off.drv);
  assert.ok(off.sim.requests.every((q) => q.headers.connection === 'close'));
  assert.equal(off.sim.opened, off.sim.requests.length, 'a new connection per request');
});

test('test connection: any answer is reachable (404 included) with a note, 401/403 are not, nothing listening fails', async () => {
  const { drv } = await setup({ docs: {} });
  const info = await drv.connect();
  assert.equal(info.status, 404);
  assert.match(info.note, /reachable/);
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const dead = createDriver({ host: '127.0.0.1', port: free, limits: { connectTimeoutMs: 300 }, tags: [] });
  await assert.rejects(dead.connect(), /ECONNREFUSED/);
  const good = await setup({ docs: { '/health': { ok: 1 } }, device: { options: { testPath: '/health' } } });
  assert.equal((await good.drv.connect()).status, 200);
});

test('large tag sets plan to one request per path regardless of the number of tags', async () => {
  const tags = [];
  const doc = {};
  for (let i = 0; i < 600; i++) {
    doc[`k${i}`] = i;
    tags.push(T(`t${i}`, `/big${i % 3}#$.k${i}`));
  }
  const { sim, drv } = await setup({ docs: { '/big0': doc, '/big1': doc, '/big2': doc }, device: { tags } });
  await drv.connect();
  assert.equal(drv.plan().length, 3);
  sim.clearRequests();
  const r = await readAll(drv);
  assert.equal(sim.requests.length, 3);
  assert.equal(r.t599.v, 599);
  assert.equal(Object.values(r).filter((x) => x.q === 192).length, 600);
  assert.throws(() => drv.plan(['nope']), /unknown tag key/);
});

test('browse: root lists paths, a path lists leaf selectors with types and samples; errors are explicit', async () => {
  const { sim, drv } = await setup({ device: { tags: [T('t', '/meter#$.power.total')] } });
  await drv.connect();
  const roots = await drv.browse();
  assert.deepEqual(roots.map((n) => [n.id, n.kind]).sort(), [['/', 'folder'], ['/meter', 'folder']]);
  const leaves = await drv.browse('/meter');
  const by = Object.fromEntries(leaves.map((n) => [n.name, n]));
  assert.equal(by['$.power.total'].address, '/meter#$.power.total');
  assert.deepEqual([by['$.power.total'].meta.dataType, by['$.power.total'].meta.sample], ['number', 12.5]);
  assert.equal(by['$.device.online'].meta.dataType, 'bool');
  assert.equal(by['$.device.name'].meta.dataType, 'string');
  // every offered address is a valid tag address
  for (const n of leaves) assert.equal(validateTag({ key: 'k', type: n.meta.dataType || 'string', address: n.address }).ok, true, n.address);
  sim.setRaw('/html', '<b>x</b>');
  await assert.rejects(drv.browse('/html'), /did not return JSON/);
  await assert.rejects(drv.browse('/nothing'), /HTTP 404/);
  await assert.rejects(drv.browse('//evil/x'), /"\/\/"/);
});

test('probe: a path lists leaves, a selector returns the value, errors name the cause', async () => {
  const { drv, sim } = await setup({ device: { tags: [] } });
  await drv.connect();
  const all = await drv.probe({ address: '/meter' });
  assert.equal(all.decodings['$.power.total'], 12.5);
  assert.equal(all.status, 200);
  const one = await drv.probe({ address: '/meter#$.items[?(@.id=="aux")].kwh' });
  assert.equal(one.decodings.value, 7);
  await assert.rejects(drv.probe({ address: '/meter#$.nope' }), /matched nothing \(stopped at \$\)/);
  sim.setRaw('/html', '<b>x</b>');
  await assert.rejects(drv.probe({ address: '/html' }), /not JSON.*<b>x<\/b>/);
  await assert.rejects(drv.probe({ address: 'meter' }), /address must be a path/);
});

test('TLS: verified by default (self-signed refused), CA, pinned fingerprint and explicit opt-out all work', async () => {
  const tags = [T('t', '/meter#$.power.total')];
  const strict = await setup({ tls: true, device: { tags } });
  await assert.rejects(strict.drv.connect(), /TLS|certificate|SELF_SIGNED/i);

  const withCa = await setup({ tls: true, device: { tags, tlsCa: CERT } });
  await withCa.drv.connect();
  assert.equal((await readAll(withCa.drv)).t.v, 12.5);

  // a CA pasted into a single-line field (newlines replaced by spaces) still works
  const flat = await setup({ tls: true, device: { tags, tlsCa: CERT.replace(/\n/g, ' ') } });
  await flat.drv.connect();

  const pinned = await setup({ tls: true, device: { tags, tlsFingerprint256: FINGERPRINT256.toLowerCase().replace(/:/g, '') } });
  await pinned.drv.connect();
  assert.equal((await readAll(pinned.drv)).t.v, 12.5);

  const wrongPin = await setup({ tls: true, device: { tags, tlsFingerprint256: 'AA'.repeat(32) } });
  await assert.rejects(wrongPin.drv.connect(), /fingerprint/);

  const insecure = await setup({ tls: true, device: { tags, tlsInsecure: true } });
  await insecure.drv.connect();
  assert.equal((await readAll(insecure.drv)).t.v, 12.5);
});

test('address pinning: the pinned address is connected to, with the configured host name in Host', async () => {
  const sim = await startHttpJsonSimulator({ docs: { '/meter': METER } });
  sims.push(sim);
  const drv = createDriver({
    id: 'd', host: 'plc.example.test', port: sim.port, pinned: { addresses: ['127.0.0.1'] },
    limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 500 }, tags: [T('t', '/meter#$.power.total')]
  });
  drivers.push(drv);
  await drv.connect(); // plc.example.test does not resolve anywhere: only the pin can work
  assert.equal((await readAll(drv)).t.v, 12.5);
  assert.equal(sim.requests.at(-1).headers.host, `plc.example.test:${sim.port}`);
});

test('secrets never appear in connect errors or Bad reasons', async () => {
  const { sim, drv } = await setup({ device: { authType: 'bearer', authToken: 'TOPSECRET-TOKEN', tags: [T('t', '/x#$.v')] } });
  sim.requireHeader('authorization', 'Bearer other');
  let msg = '';
  try {
    await drv.connect();
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg && !msg.includes('TOPSECRET'));
});

test('DeviceRuntime integration: goes online, publishes Good values, Bad on a bad status without going offline, offline when the device vanishes', async () => {
  const { sim, drv } = await setup({
    device: { tags: [T('t', '/meter#$.power.total'), T('bad', '/s500#$.v')], pollGroups: [{ id: 'default', intervalMs: 30 }] }
  });
  sim.setStatus('/s500', 500, '{}');
  const batches = [];
  const states = [];
  const rt = new DeviceRuntime({
    device: { id: 'd1', limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 500 }, pollGroups: [{ id: 'default', intervalMs: 30 }], tags: [{ key: 't', type: 'number' }, { key: 'bad', type: 'number' }] },
    driver: drv,
    onSamples: (b) => batches.push(b),
    onState: (s) => states.push(s.state),
    backoff: { initialMs: 20, maxMs: 40 }
  });
  rt.start();
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting');
  };
  await until(() => batches.some((b) => b.samples.some((s) => s.key === 't' && s.q === 192)));
  const last = batches.at(-1).samples;
  assert.equal(last.find((s) => s.key === 'bad').qReason, 'http-500');
  assert.equal(states.at(-1), 'online');
  await sim.stopListening();
  await until(() => states.at(-1) === 'offline');
  await sim.startListening();
  await until(() => states.at(-1) === 'online');
  await rt.stop();
});
