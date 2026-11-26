'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDriver, validateTag, describe: describeDriver, protocol } = require('../drivers/mtconnect');
const { DeviceRuntime } = require('../drivers/runtime/deviceRuntime');
const { startMtconnectSimulator, defaultDevices } = require('./support/mtconnectSimulator');

process.env.MANIFOLD_ALLOW_LOOPBACK_DEVICES = '1';

const DEADLINE = 600;
const sims = [];
const drivers = [];

const T = (key, address, type = 'number', extra = {}) => ({ key, address, type, ...extra });
const DEFAULT_TAGS = [
  T('x', 'Xact'), T('rpm', 'Sspeed'), T('exec', 'exec', 'string'), T('line', 'line'), T('sys', 'sys_cond', 'string'), T('avail', 'avail', 'string')
];

async function setup({ sim: simOpts = {}, device = {}, tags = DEFAULT_TAGS } = {}) {
  const sim = await startMtconnectSimulator(simOpts);
  sims.push(sim);
  const drv = createDriver({
    id: 'm1', name: 'agent', protocol, host: '127.0.0.1', port: sim.port,
    limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 1500 }, tags, ...device
  });
  drivers.push(drv);
  return { sim, drv };
}

async function poll(drv) {
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

test('describe: read-only, experimental, browsable, no streaming option', () => {
  const d = describeDriver();
  assert.equal(protocol, 'mtconnect');
  assert.equal(d.readOnly, true);
  assert.equal(d.experimental, true);
  assert.equal(d.defaultPort, 5000);
  assert.equal(d.capabilities.browse, true);
  assert.equal([...d.deviceFields, ...d.optionFields].some((f) => /interval|stream/i.test(f.name)), false);
});

test('validateTag: data item ids, device qualifier, condition field, refusals', () => {
  const a = validateTag(T('a', 'Xact'));
  assert.deepEqual([a.ok, a.normalized.dataItemId, a.normalized.device], [true, 'Xact', undefined]);
  const b = validateTag(T('b', 'mill-1/Xact', 'number'));
  assert.deepEqual([b.normalized.device, b.normalized.dataItemId], ['mill-1', 'Xact']);
  assert.equal(validateTag(T('c', 'sys', 'string', { field: 'nativeCode' })).ok, true);
  const refuse = [
    [T('', 'Xact'), /key/], [T('k', 'Xact', 'int16'), /unknown type/], [T('k', ''), /address/], [T('k', 'a/b/c'), /address/], [T('k', '/x'), /address/],
    [T('k', 'a b'), /spaces/], [T('k', 'a?x=1'), /spaces/], [T('k', 'Xact', 'number', { field: 'bogus' }), /field must be/], [null, /object/]
  ];
  for (const [tag, re] of refuse) {
    const r = validateTag(tag);
    assert.equal(r.ok, false, JSON.stringify(tag));
    assert.match(r.error, re);
  }
});

test('createDriver rejects bad config with details', () => {
  const bad = (over, re) => assert.throws(() => createDriver({ host: '127.0.0.1', tags: [], ...over }), (e) => re.test(e.message) && Array.isArray(e.details));
  bad({ scheme: 'gopher' }, /scheme/);
  bad({ options: { sampleCount: 0 } }, /sampleCount/);
  bad({ options: { device: 'a/b' } }, /options.device/);
  bad({ options: { maxResponseBytes: 5 } }, /maxResponseBytes/);
  bad({ tags: [T('a', 'x'), T('a', 'y')] }, /duplicate/);
  bad({ tags: [T('a', '')] }, /address/);
  bad({ authType: 'bearer' }, /authToken/);
});

test('connect: /probe then /current; reports the agent, devices, item count and the cursor', async () => {
  const { sim, drv } = await setup();
  sim.setValue('Xact', 3.25);
  sim.clearRequests();
  const info = await drv.connect();
  assert.deepEqual(sim.requests.map((r) => r.url), ['/probe', '/current']);
  assert.deepEqual(info.devices, ['mill-1']);
  assert.equal(info.dataItems, 13);
  assert.equal(info.instanceId, String(sim.instanceId));
  assert.equal(info.nextSequence, String(sim.nextSequence));
  assert.equal(info.bufferSize, 100);
  assert.equal(drv.isConnected(), true);
});

test('only GET /probe, /current and /sample are ever sent; never a body, never another method', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.setValue('Xact', 1);
  await poll(drv);
  await drv.browse();
  await drv.probe({ address: 'Xact' });
  for (const r of sim.requests) {
    assert.equal(r.method, 'GET');
    assert.equal(r.bodyBytes, 0);
    assert.match(r.url, /^\/(probe|current|sample\?from=\d+&count=\d+)$/);
    assert.ok(!r.url.includes('interval'), 'no multipart streaming');
  }
});

test('values: UNAVAILABLE is Bad, then SAMPLE numeric, EVENT string, source timestamp from the observation', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  let r = await poll(drv);
  for (const k of ['x', 'rpm', 'exec', 'avail']) assert.deepEqual([r[k].q, r[k].v, r[k].qReason], [0, null, 'unavailable'], k);
  assert.equal(r.sys.qReason, 'unavailable');
  const ts = '2024-06-01T12:34:56.789Z';
  sim.setValue('Xact', 12.5, { ts });
  sim.setValue('exec', 'ACTIVE');
  sim.setValue('line', 42);
  sim.setValue('avail', 'AVAILABLE');
  r = await poll(drv);
  assert.deepEqual([r.x.v, r.x.q, r.x.type, r.x.tSource], [12.5, 192, 'number', Date.parse(ts)]);
  assert.deepEqual([r.exec.v, r.exec.q, r.exec.type], ['ACTIVE', 192, 'string']);
  assert.equal(r.line.v, 42);
  assert.equal(r.avail.v, 'AVAILABLE');
  assert.equal(r.rpm.qReason, 'unavailable', 'untouched items stay unavailable');
  sim.setUnavailable('Xact');
  r = await poll(drv);
  assert.deepEqual([r.x.q, r.x.v, r.x.qReason], [0, null, 'unavailable']);
  sim.setValue('Xact', 'abc');
  const s = await poll(drv);
  assert.match(s.x.qReason, /^not-numeric/);
});

test('follows the stream without gaps: every change between two polls is applied, from the right sequence', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.clearRequests();
  for (let i = 1; i <= 5; i++) sim.setValue('line', i);
  sim.setCondition('sys_cond', 'fault', { nativeCode: 'E1', text: 'boom' });
  sim.setCondition('sys_cond', 'normal', { nativeCode: 'E1' });
  const before = sim.nextSequence;
  const r = await poll(drv);
  assert.equal(r.line.v, 5);
  assert.equal(r.sys.v, 'normal', 'a fault that came and went between polls ends up normal');
  assert.equal(sim.sampleHits.length, 1);
  assert.equal(sim.sampleHits[0].from, String(before - 7n));
  assert.equal(drv.streamState().nextSequence, String(sim.nextSequence));
  // nothing new: the next poll asks from nextSequence and gets nothing
  sim.clearRequests();
  await poll(drv);
  assert.equal(sim.sampleHits[0].from, String(sim.nextSequence));
});

test('paging: more observations than `count` are fetched in several /sample requests of one poll', async () => {
  const { sim, drv } = await setup({ device: { options: { sampleCount: 4 } } });
  await drv.connect();
  sim.clearRequests();
  for (let i = 1; i <= 11; i++) sim.setValue('line', i);
  const r = await poll(drv);
  assert.equal(r.line.v, 11);
  assert.equal(sim.sampleHits.length, 3);
  assert.ok(sim.sampleHits.every((h) => h.count === 4));
  assert.equal(drv.streamState().resyncs, 1, 'only the connect-time snapshot');
});

test('agent restart: a changed instanceId re-reads /probe and /current and starts from the new sequences', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.setValue('Xact', 9);
  assert.equal((await poll(drv)).x.v, 9);
  sim.restart({ startAt: 1n });
  sim.setValue('Xact', 1.5);
  sim.clearRequests();
  const r = await poll(drv);
  assert.deepEqual(sim.requests.map((q) => q.url.split('?')[0]).sort(), ['/current', '/probe', '/sample']);
  assert.equal(r.x.v, 1.5, 'the new agent value, not the old one');
  assert.equal(drv.streamState().restarts, 1);
  assert.equal(drv.streamState().instanceId, String(sim.instanceId));
  // and it keeps following from there
  sim.setValue('Xact', 2.5);
  assert.equal((await poll(drv)).x.v, 2.5);
  // a restart that also resets to a LOWER sequence than our cursor with the SAME instanceId is a gap too
  sim.restart({ newInstance: sim.instanceId, startAt: 1n });
  sim.setValue('Xact', 7);
  assert.equal((await poll(drv)).x.v, 7);
  assert.equal(drv.streamState().gaps >= 1, true);
});

test('buffer overflow: OUT_OF_RANGE (HTTP 404 or 400) resynchronises from /current; values are current, none stale', async () => {
  for (const status of [404, 400]) {
    const { sim, drv } = await setup({ sim: { bufferSize: 20, outOfRangeStatus: status } });
    await drv.connect();
    sim.setValue('Xact', 1);
    await poll(drv);
    sim.setValue('Xact', 2);
    sim.setValue('exec', 'READY');
    sim.overflow(60);
    sim.setValue('Xact', 3);
    sim.clearRequests();
    const r = await poll(drv);
    assert.equal(sim.sampleHits.length, 1);
    assert.ok(sim.requests.some((q) => q.url === '/current'));
    assert.equal(r.x.v, 3, `status ${status}`);
    assert.equal(r.exec.v, 'READY');
    assert.equal(drv.streamState().gaps, 1);
    sim.setValue('Xact', 4);
    assert.equal((await poll(drv)).x.v, 4);
  }
});

test('conditions: several active at once, native code and text, severity order, cleared per code or all at once', async () => {
  const tags = [
    T('state', 'sys_cond', 'string'), T('level', 'sys_cond', 'number'), T('active', 'sys_cond', 'bool'), T('code', 'sys_cond', 'string', { field: 'nativeCode' }),
    T('text', 'sys_cond', 'string', { field: 'text' }), T('sev', 'sys_cond', 'number', { field: 'severity' }), T('qual', 'sys_cond', 'string', { field: 'qualifier' }),
    T('ctype', 'sys_cond', 'string', { field: 'type' }), T('badField', 'Xact', 'number', { field: 'text' })
  ];
  const { sim, drv } = await setup({ tags });
  await drv.connect();
  sim.setCondition('sys_cond', 'normal');
  let r = await poll(drv);
  assert.deepEqual([r.state.v, r.level.v, r.active.v], ['normal', 0, false]);
  assert.equal(r.code.v, '');
  sim.setCondition('sys_cond', 'warning', { nativeCode: 'W1', text: 'filter low', severity: '2' });
  r = await poll(drv);
  assert.deepEqual([r.state.v, r.level.v, r.active.v, r.code.v, r.text.v, r.sev.v], ['warning', 1, true, 'W1', 'filter low', 2]);
  sim.setCondition('sys_cond', 'fault', { nativeCode: 'F9', text: 'over temp', severity: '9', qualifier: 'HIGH' });
  r = await poll(drv);
  assert.deepEqual([r.state.v, r.level.v, r.code.v, r.text.v, r.sev.v, r.qual.v, r.ctype.v], ['fault', 2, 'F9', 'over temp', 9, 'HIGH', 'SYSTEM']);
  sim.setCondition('sys_cond', 'normal', { nativeCode: 'F9' });
  r = await poll(drv);
  assert.deepEqual([r.state.v, r.code.v], ['warning', 'W1']);
  sim.setCondition('sys_cond', 'normal');
  r = await poll(drv);
  assert.deepEqual([r.state.v, r.code.v], ['normal', '']);
  sim.setCondition('sys_cond', 'unavailable');
  sim.setValue('Xact', 1);
  r = await poll(drv);
  assert.deepEqual([r.state.q, r.state.qReason], [0, 'unavailable']);
  assert.match(r.badField.qReason, /applies to conditions only/);
  // a /current snapshot after a resync restores multiple active conditions
  sim.setCondition('sys_cond', 'warning', { nativeCode: 'W2', text: 'a' });
  sim.setCondition('sys_cond', 'fault', { nativeCode: 'F2', text: 'b' });
  sim.overflow(10);
  sim.restart({ newInstance: sim.instanceId + 1 });
  sim.setCondition('sys_cond', 'warning', { nativeCode: 'WX', text: 'x' });
  sim.setCondition('sys_cond', 'fault', { nativeCode: 'FX', text: 'y' });
  r = await poll(drv);
  assert.deepEqual([r.state.v, r.code.v], ['fault', 'FX']);
});

test('time series and data set items are reported as unsupported, with their representation', async () => {
  const { sim, drv } = await setup({ tags: [T('vib', 'vib', 'string'), T('vars', 'vars', 'string'), T('x', 'Xact')] });
  await drv.connect();
  sim.setValue('vib', '1 2 3 4');
  sim.setValue('vars', 'a=1 b=2');
  sim.setValue('Xact', 1);
  const r = await poll(drv);
  assert.equal(r.vib.qReason, 'unsupported-representation (TIME_SERIES)');
  assert.equal(r.vars.qReason, 'unsupported-representation (DATA_SET)');
  assert.equal(r.x.v, 1);
});

test('document variants: default namespace, prefixed namespace, no namespace, versions 1.3 / 1.7 / 2.2', async () => {
  for (const [version, namespaces] of [['1.3', 'default'], ['1.7', 'prefixed'], ['2.2', 'default'], ['2.2', 'prefixed'], ['1.3', 'none']]) {
    const { sim, drv } = await setup({ sim: { version, namespaces } });
    await drv.connect();
    sim.setValue('Xact', 4.5);
    sim.setValue('exec', 'ACTIVE');
    sim.setCondition('sys_cond', 'fault', { nativeCode: 'E', text: 't' });
    const r = await poll(drv);
    assert.deepEqual([r.x.v, r.exec.v, r.sys.v], [4.5, 'ACTIVE', 'fault'], `${version} ${namespaces}`);
  }
});

test('one device of several: options.device uses /<device>/ paths, and a device/id address checks the device', async () => {
  const second = defaultDevices()[0];
  second.id = 'dev2';
  second.name = 'lathe-2';
  second.uuid = 'L02';
  const renamed = JSON.parse(JSON.stringify(second).replace(/"id":"(\w+)"/g, (_m, id) => `"id":"${id === 'dev2' ? id : `${id}_2`}"`));
  const { sim, drv } = await setup({ sim: { devices: [defaultDevices()[0], renamed] }, tags: [T('a', 'mill-1/Xact'), T('b', 'lathe-2/Xact_2'), T('wrong', 'lathe-2/Xact'), T('byUuid', 'M01-UUID/Xact')] });
  await drv.connect();
  sim.setValue('Xact', 1);
  sim.setValue('Xact_2', 2);
  const r = await poll(drv);
  assert.deepEqual([r.a.v, r.b.v, r.byUuid.v], [1, 2, 1]);
  assert.match(r.wrong.qReason, /belongs to device mill-1, not lathe-2/);

  const one = await setup({ sim: { devices: [defaultDevices()[0], renamed] }, device: { options: { device: 'lathe-2' } }, tags: [T('b', 'Xact_2')] });
  await one.drv.connect();
  one.sim.setValue('Xact_2', 5);
  one.sim.clearRequests();
  assert.equal((await poll(one.drv)).b.v, 5);
  assert.ok(one.sim.requests.every((q) => q.url.startsWith('/lathe-2/')));
  const missing = await setup({ device: { options: { device: 'nope' } } });
  await assert.rejects(missing.drv.connect(), /NO_DEVICE|Could not find/);
});

test('unknown data item ids are Bad with a reason, other tags unaffected', async () => {
  const { sim, drv } = await setup({ tags: [T('ok', 'Xact'), T('nope', 'Zzz')] });
  await drv.connect();
  sim.setValue('Xact', 1);
  const r = await poll(drv);
  assert.equal(r.ok.v, 1);
  assert.match(r.nope.qReason, /unknown-data-item.*Zzz is not in the agent's \/probe/);
});

test('agent and network faults: Bad with a reason, device stays up, the cursor never skips unread data', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.setValue('Xact', 1);
  sim.setValue('Xact', 2);
  sim.setValue('Xact', 3);
  const cursorBefore = drv.streamState().nextSequence;
  const cases = [
    [{ type: 'garbage' }, /agent-error \(malformed XML/],
    [{ type: 'truncate', fraction: 0.6 }, /agent-error \(malformed XML.*incomplete|agent-error \(malformed XML/],
    [{ type: 'status', status: 503 }, /agent-error \(HTTP 503/],
    [{ type: 'status', status: 500, body: '<MTConnectError><Header instanceId="1"/><Errors><Error errorCode="INTERNAL_ERROR">oops</Error></Errors></MTConnectError>' }, /INTERNAL_ERROR: oops/]
  ];
  for (const [f, re] of cases) {
    sim.fault('sample', f);
    const r = await poll(drv);
    assert.match(r.x.qReason, re, JSON.stringify(f));
    assert.equal(r.x.q, 0);
    assert.equal(drv.streamState().nextSequence, cursorBefore, 'the cursor did not move');
    assert.equal(drv.isConnected(), true);
  }
  sim.clearFaults();
  assert.equal((await poll(drv)).x.v, 3, 'nothing was lost: the range is read after the fault clears');
});

test('size cap and redirects: oversized answers abort (Bad too-large); a redirect to another host is refused', async () => {
  const { sim, drv } = await setup({ device: { options: { maxResponseBytes: 8192 } } });
  await drv.connect();
  sim.fault('sample', { type: 'oversize', bytes: 5 * 1024 * 1024 });
  let r = await poll(drv);
  assert.match(r.x.qReason, /^too-large/);
  sim.fault('sample', { type: 'redirect', location: 'http://203.0.113.5/sample' });
  r = await poll(drv);
  assert.match(r.x.qReason, /^redirect-refused/);
  sim.clearFaults();
  sim.setValue('Xact', 8);
  assert.equal((await poll(drv)).x.v, 8);
});

test('timeouts: Bad first, offline after three in a row; dropped and refused connections are fatal', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.fault('sample', { type: 'delay', delayMs: 800 });
  const [req] = drv.plan();
  for (let i = 0; i < 2; i++) assert.equal((await drv.execute(req, 100)).results[0].qReason, 'timeout');
  const third = await drv.execute(req, 100);
  assert.deepEqual([third.ok, third.fatal, third.kind], [false, true, 'timeout']);
  sim.clearFaults();
  await drv.connect();
  sim.fault('sample', { type: 'drop' });
  const dropped = await drv.execute(req, DEADLINE);
  assert.deepEqual([dropped.ok, dropped.fatal, dropped.kind], [false, true, 'transport']);
  sim.clearFaults();
  await sim.stopListening();
  await assert.rejects(drv.connect(), /ECONNREFUSED/);
  await sim.startListening();
  await drv.connect();
  assert.equal((await drv.execute(req, DEADLINE)).ok, true);
});

test('connect fails with the agent\'s reason for a bad /probe or /current', async () => {
  const a = await setup();
  a.sim.fault('probe', { type: 'garbage' });
  await assert.rejects(a.drv.connect(), /malformed XML from \/probe/);
  const b = await setup();
  b.sim.fault('current', { type: 'status', status: 500 });
  await assert.rejects(b.drv.connect(), /HTTP 500 from \/current/);
  assert.equal(b.drv.isConnected(), false);
  const c = await setup();
  c.sim.fault('probe', { type: 'status', status: 200, body: '<html>captive portal</html>' });
  await assert.rejects(c.drv.connect(), /did not return MTConnectDevices|not an MTConnect document|HTTP 200/);
});

test('browse: devices, components and data items with units, types and unsupported items disabled', async () => {
  const { drv } = await setup();
  await drv.connect();
  const roots = await drv.browse();
  assert.deepEqual(roots.map((n) => [n.name, n.kind]), [['mill-1', 'folder']]);
  const level1 = await drv.browse(roots[0].id);
  assert.deepEqual(level1.map((n) => n.name).sort(), ['Axes', 'avail (AVAILABILITY)', 'controller'].sort());
  const axes = level1.find((n) => n.name === 'Axes');
  const x = await drv.browse(axes.id);
  const xAxis = await drv.browse(x[0].id);
  const xact = xAxis.find((n) => n.address === 'Xact');
  assert.deepEqual([xact.kind, xact.meta.dataType, xact.meta.unit, xact.meta.category, xact.meta.accessible], ['tag', 'number', 'mm', 'SAMPLE', true]);
  assert.match(xact.name, /Xposition \(POSITION\.ACTUAL\)/);
  const ctl = await drv.browse(level1.find((n) => n.name === 'controller').id);
  const path = await drv.browse(ctl.find((n) => n.kind === 'folder').id);
  const byAddr = Object.fromEntries(path.map((n) => [n.address, n]));
  assert.equal(byAddr.Sspeed.meta.unit, 'rev/min');
  assert.equal(byAddr.exec.meta.dataType, 'string');
  assert.deepEqual([byAddr.vars.meta.accessible, byAddr.vars.meta.reason], [false, 'DATA_SET data items are not supported']);
  assert.equal(byAddr.vib.meta.accessible, false);
  assert.equal(byAddr.logic_cond.meta.dataType, 'string');
  await assert.rejects(drv.browse('nonsense'), /unknown node/);
  for (const n of [xact, byAddr.exec, byAddr.Sspeed]) assert.equal(validateTag({ key: 'k', type: n.meta.dataType, address: n.address }).ok, true);
});

test('browse addresses carry the device name when the agent serves several devices', async () => {
  const other = JSON.parse(JSON.stringify(defaultDevices()[0]).replace(/"id":"(\w+)"/g, (_m, id) => `"id":"${id}_b"`).replace('mill-1', 'lathe-2').replace('M01-UUID', 'L02'));
  const { drv } = await setup({ sim: { devices: [defaultDevices()[0], other] } });
  await drv.connect();
  const roots = await drv.browse();
  assert.equal(roots.length, 2);
  const kids = await drv.browse(roots[1].id);
  assert.equal(kids.find((n) => n.kind === 'tag').address.startsWith('lathe-2/'), true);
});

test('probe: one data item, its model entry and latest observation', async () => {
  const { sim, drv } = await setup();
  await drv.connect();
  sim.setValue('Xact', 7.5, { ts: '2024-06-01T00:00:00.000Z' });
  const p = await drv.probe({ address: 'Xact' });
  assert.equal(p.decodings.value, '7.5');
  assert.equal(p.decodings.units, 'MILLIMETER');
  assert.equal(p.decodings.timestamp, '2024-06-01T00:00:00.000Z');
  assert.equal(p.decodings['component path'], 'mill-1 / Axes / X');
  sim.setCondition('sys_cond', 'fault', { nativeCode: 'F1', text: 'hot' });
  const c = await drv.probe({ address: 'sys_cond' });
  assert.deepEqual([c.decodings['condition state'], c.decodings['native code'], c.decodings.text], ['fault', 'F1', 'hot']);
  await assert.rejects(drv.probe({ address: 'nope' }), /not in the agent's \/probe/);
  await assert.rejects(drv.probe({ address: 'a b' }), /spaces/);
});

test('large tag sets: one request cycle regardless of the number of tags', async () => {
  const tags = [];
  for (let i = 0; i < 2000; i++) tags.push(T(`t${i}`, i % 2 ? 'Xact' : 'exec', i % 2 ? 'number' : 'string'));
  const { sim, drv } = await setup({ tags });
  await drv.connect();
  sim.setValue('Xact', 1);
  sim.clearRequests();
  assert.equal(drv.plan().length, 1);
  const r = await poll(drv);
  assert.equal(sim.requests.length, 1);
  assert.equal(Object.keys(r).length, 2000);
  assert.equal(r.t1.v, 1);
  assert.deepEqual(drv.plan([]), []);
  assert.throws(() => drv.plan(['nope']), /unknown tag key/);
});

test('DeviceRuntime integration: online, live values, agent restart is invisible apart from the values, offline when the agent vanishes', async () => {
  const { sim, drv } = await setup();
  const batches = [];
  const states = [];
  const rt = new DeviceRuntime({
    device: { id: 'm1', limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 1500 }, pollGroups: [{ id: 'default', intervalMs: 30 }], tags: DEFAULT_TAGS.map((t) => ({ key: t.key, type: t.type })) },
    driver: drv,
    onSamples: (b) => batches.push(b),
    onState: (s) => states.push(s.state),
    backoff: { initialMs: 20, maxMs: 40 }
  });
  const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting');
  };
  const lastOf = (key) => [...batches].reverse().flatMap((b) => b.samples).find((s) => s.key === key);
  rt.start();
  sim.setValue('Xact', 11);
  await until(() => lastOf('x') && lastOf('x').v === 11);
  assert.equal(lastOf('x').q, 192);
  assert.equal(states.at(-1), 'online');
  sim.restart();
  sim.setValue('Xact', 22);
  await until(() => lastOf('x').v === 22);
  assert.equal(states.filter((s) => s === 'offline').length, 1, 'only the initial connecting state; the restart never took it offline');
  await sim.stopListening();
  await until(() => states.at(-1) === 'offline');
  await sim.startListening();
  await until(() => states.at(-1) === 'online');
  await rt.stop();
});
