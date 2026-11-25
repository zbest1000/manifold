'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const eip = require('../drivers/eip');
const frame = require('../drivers/eip/frame');
const cip = require('../drivers/eip/cip');
const { EipClient } = require('../drivers/eip/client');
const { EipSimulator } = require('./support/eipSimulator');

const sims = [];
const drivers = [];

async function startSim(opts) {
  const sim = await new EipSimulator(opts).start();
  sims.push(sim);
  return sim;
}

function makeDriver(sim, tags, extra = {}) {
  const d = eip.createDriver(
    {
      id: 'plc1',
      name: 'PLC 1',
      protocol: 'ethernet-ip',
      host: '127.0.0.1',
      port: sim.port,
      slot: 0,
      options: extra.options || {},
      limits: { requestDeadlineMs: 1000, connectTimeoutMs: 1000, ...(extra.limits || {}) },
      tags: tags.map((t) => (typeof t === 'string' ? { key: t, address: t } : t)),
    },
    extra.deps || {}
  );
  drivers.push(d);
  return d;
}

async function readAll(d, keys) {
  const out = {};
  for (const req of d.plan(keys)) {
    const res = await d.execute(req, 1000);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const r of res.results) out[r.key] = r;
  }
  return out;
}

test.after(async () => {
  for (const d of drivers) await d.close();
  // The driver must never have sent a write service to any simulator.
  for (const sim of sims) assert.equal(sim.stats.writesReceived, 0, 'writesReceived');
  for (const sim of sims) await sim.stop();
});

const ATOMICS = {
  BoolTag: [true, 'bool'],
  SintTag: [-5, 'int8'],
  IntTag: [-1234, 'int16'],
  DintTag: [123456, 'int32'],
  LintTag: ['-9007199254740993', 'int64'],
  UsintTag: [200, 'uint8'],
  UintTag: [60000, 'uint16'],
  UdintTag: [4000000000, 'uint32'],
  UlintTag: ['18446744073709551615', 'uint64'],
  RealTag: [3.5, 'float32'],
  LrealTag: [2.718281828459045, 'float64'],
  StrTag: ['Hello Logix', 'string'],
};

test('connect reports identity and the Large Forward Open size', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag']);
  const info = await d.connect();
  assert.equal(d.isConnected(), true);
  assert.deepEqual(info.limits, { connectionSize: 4002 });
  assert.equal(info.identity.productName, '1756-L83E/B SIM');
  assert.equal(info.identity.revision, '33.11');
  assert.equal(sim.stats.largeForwardOpens, 1);
  assert.equal(sim.stats.forwardOpens, 1);
  await d.close();
});

test('end-to-end read of every atomic type and STRING', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, Object.keys(ATOMICS));
  await d.connect();
  const got = await readAll(d);
  for (const [k, [v, type]] of Object.entries(ATOMICS)) {
    assert.deepEqual({ v: got[k].v, type: got[k].type, q: got[k].q }, { v, type, q: 192 }, k);
  }
});

test('arrays, bit-of-word, BOOL arrays, UDTs and program-scope tags', async () => {
  const sim = await startSim();
  const tags = [
    'DintArr[3]',
    'DintArr',
    'Matrix[1,2]',
    'Matrix[2,3]',
    'StatusWord.5',
    'StatusWord.4',
    'BoolArr[0]',
    'BoolArr[1]',
    'BoolArr[31]',
    'BoolArr[33]',
    'BoolArr',
    'Motor',
    'Motor.Speed',
    'Motor.Running',
    'Motor.Fault',
    'Motor.Name',
    'Motors[2]',
    'Motors[2].Fault',
    'Motors[1].Speed',
    'Program:MainProgram.LocalDint',
    'Program:MainProgram.LocalReal',
    { key: 'typed', address: 'Motor.Count', type: 'DINT' },
  ];
  const d = makeDriver(sim, tags);
  await d.connect();
  const g = await readAll(d);
  assert.equal(g['DintArr[3]'].v, 30);
  assert.deepEqual(g.DintArr.v, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(g['Matrix[1,2]'].v, 12);
  assert.equal(g['Matrix[2,3]'].v, 23);
  assert.equal(g['StatusWord.5'].v, true);
  assert.equal(g['StatusWord.4'].v, false);
  assert.deepEqual(['BoolArr[0]', 'BoolArr[1]', 'BoolArr[31]', 'BoolArr[33]'].map((k) => g[k].v), [true, false, true, true]);
  assert.equal(g.BoolArr.v.length, 64);
  assert.equal(g.BoolArr.v.filter(Boolean).length, 4);
  assert.deepEqual(g.Motor.v, { Running: true, Fault: false, Speed: 1450.5, Count: 42, Name: 'Pump-1', Code: -7 });
  assert.equal(g.Motor.type, 'struct');
  assert.equal(g['Motor.Speed'].v, 1450.5);
  assert.equal(g['Motor.Running'].v, true);
  assert.equal(g['Motor.Fault'].v, false);
  assert.equal(g['Motor.Name'].v, 'Pump-1');
  assert.deepEqual(g['Motors[2]'].v, { Running: true, Fault: true, Speed: 200, Count: 2, Name: 'M2', Code: 2 });
  assert.equal(g['Motors[2].Fault'].v, true);
  assert.equal(g['Motors[1].Speed'].v, 100);
  assert.equal(g['Program:MainProgram.LocalDint'].v, 77);
  assert.equal(g['Program:MainProgram.LocalReal'].v, 1.25);
  assert.equal(g.typed.v, 42);
  for (const r of Object.values(g)) assert.equal(r.q, 192, r.key);
});

test('unresolvable tags are Bad with a reason, not errors', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, [
    'Nope',
    'Secret',
    'DintArr[99]',
    'DintTag[1]',
    'Motor.Nope',
    'Program:Nope.X',
    'DintArr.Speed',
    'RealTag.3',
    { key: 'wrongType', address: 'DintTag', type: 'REAL' },
    'DintTag',
  ]);
  await d.connect();
  const g = await readAll(d);
  assert.equal(g.DintTag.q, 192);
  for (const k of ['Nope', 'Secret', 'DintArr[99]', 'DintTag[1]', 'Motor.Nope', 'Program:Nope.X', 'DintArr.Speed', 'RealTag.3', 'wrongType']) {
    assert.equal(g[k].q, 0, k);
    assert.ok(g[k].qReason, k);
    assert.ok(g[k].message, k);
  }
  assert.equal(g.Secret.qReason, 'device-exception');
  assert.match(g.Secret.message, /External Access None/);
  assert.equal(g.wrongType.qReason, 'decode');
});

test('Large Forward Open rejected -> falls back to 504 and remembers it', async () => {
  const sim = await startSim({ rejectLarge: true });
  const d = makeDriver(sim, ['DintTag', 'BigArr', 'Motor']);
  const info = await d.connect();
  assert.equal(info.limits.connectionSize, 504);
  assert.equal(sim.stats.largeRejected, 1);
  assert.equal(sim.stats.forwardOpens, 2);
  const g = await readAll(d);
  assert.equal(g.DintTag.v, 123456);
  assert.equal(g.BigArr.v.length, 2000);
  assert.equal(g.BigArr.v[1999], 1999 * 3);
  assert.equal(g.Motor.v.Name, 'Pump-1');
  await d.close();
  await d.connect();
  assert.equal(sim.stats.largeForwardOpens, 1, 'second connect goes straight to the small Forward Open');
  assert.equal(sim.stats.forwardOpens, 3);
});

test('connectionSize option 504 skips the Large Forward Open', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag'], { options: { connectionSize: '504' } });
  const info = await d.connect();
  assert.equal(info.limits.connectionSize, 504);
  assert.equal(sim.stats.largeForwardOpens, 0);
});

test('batching: one Multiple Service Packet for many tags; packing off sends one request per tag', async () => {
  const keys = Object.keys(ATOMICS);
  const sim = await startSim();
  const d = makeDriver(sim, keys);
  await d.connect();
  sim.resetStats();
  const plan = d.plan();
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'multi');
  await readAll(d);
  assert.equal(sim.stats.services[0x0a], 1);
  assert.equal(sim.stats.innerServices[0x4c], keys.length);
  assert.equal(sim.stats.dataRequests, 1);

  const sim2 = await startSim();
  const d2 = makeDriver(sim2, keys, { options: { packing: false } });
  await d2.connect();
  sim2.resetStats();
  await readAll(d2);
  assert.equal(sim2.stats.services[0x0a] || 0, 0);
  assert.equal(sim2.stats.services[0x4c], keys.length);
});

test('small connection: planner splits packets so every reply fits 504 bytes', async () => {
  const sim = await startSim({ rejectLarge: true });
  const keys = ['Motor', 'Motors[0]', 'Motors[1]', 'Motors[2]', 'StrTag', 'DintArr', 'Matrix[0,0]', 'LrealTag'];
  const d = makeDriver(sim, keys);
  await d.connect();
  const plan = d.plan();
  assert.ok(plan.length > 1);
  const g = await readAll(d);
  for (const k of keys) assert.equal(g[k].q, 192, k);
});

test('one bad item in a batch leaves its siblings good; caches are re-resolved', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag', 'RealTag', 'IntTag']);
  await d.connect();
  // The tag disappears from the controller after resolution (e.g. a download).
  sim.db.controller = sim.db.controller.filter((t) => t.name !== 'RealTag');
  const [req] = d.plan();
  assert.equal(req.kind, 'multi');
  const res = await d.execute(req, 1000);
  assert.equal(res.ok, true);
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  assert.equal(by.DintTag.q, 192);
  assert.equal(by.IntTag.q, 192);
  assert.equal(by.RealTag.q, 0);
  assert.equal(by.RealTag.qReason, 'layout');
  assert.match(by.RealTag.message, /path destination unknown/);
  // Next cycle: symbols are re-read; RealTag is Bad (not found), siblings still good.
  sim.resetStats();
  const g = await readAll(d);
  assert.equal(g.DintTag.v, 123456);
  assert.equal(g.IntTag.v, -1234);
  assert.equal(g.RealTag.q, 0);
  assert.match(g.RealTag.message, /not found/);
  assert.ok(sim.stats.services[0x55] >= 1, 'symbol list re-read after the path error');
});

test('layout drift: a changed structure handle makes the tag Bad until re-resolved', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['Motor', 'DintTag']);
  await d.connect();
  sim.templates.get(0x0101).handle = 0x1234;
  let g = await readAll(d);
  assert.equal(g.Motor.q, 0);
  assert.equal(g.Motor.qReason, 'layout');
  assert.equal(g.DintTag.q, 192);
  g = await readAll(d);
  assert.equal(g.Motor.q, 192);
  assert.equal(g.Motor.v.Count, 42);
});

test('fragmented read of a value larger than the connection size', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['BigArr', 'DintTag']);
  await d.connect();
  const plan = d.plan();
  const frag = plan.find((r) => r.kind === 'fragmented');
  assert.deepEqual(frag.items, [{ key: 'BigArr' }]);
  sim.resetStats();
  const res = await d.execute(frag, 2000);
  assert.equal(res.ok, true);
  const v = res.results[0].v;
  assert.equal(v.length, 2000);
  assert.ok(v.every((x, i) => x === i * 3));
  assert.ok(sim.stats.services[0x52] >= 2, 'more than one fragment');
});

test('browse: scopes, types, members, External Access', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, []);
  await d.connect();
  const root = await d.browse();
  assert.deepEqual(root.map((n) => n.id), ['controller', 'program:MainProgram', 'types']);
  for (const n of root) assert.equal(n.kind, 'folder');

  const ctl = await d.browse('controller');
  const names = ctl.map((n) => n.name);
  assert.ok(names.includes('DintTag') && names.includes('Motor') && names.includes('BoolArr'));
  assert.ok(!names.includes('__SystemThing'));
  assert.ok(!names.some((n) => n.includes(':')));
  for (const n of ctl) {
    assert.deepEqual(Object.keys(n).sort(), ['address', 'id', 'kind', 'meta', 'name']);
    assert.equal(n.kind, 'tag');
  }
  const secret = ctl.find((n) => n.name === 'Secret');
  assert.equal(secret.meta.accessible, false);
  assert.equal(secret.meta.externalAccess, 'None');
  assert.equal(ctl.find((n) => n.name === 'ReadOnlyTag').meta.externalAccess, 'Read Only');
  const motor = ctl.find((n) => n.name === 'Motor');
  assert.equal(motor.meta.dataType, 'MotorType');
  assert.equal(motor.meta.hasChildren, true);
  assert.deepEqual(ctl.find((n) => n.name === 'Matrix').meta.dims, [3, 4]);
  assert.equal(ctl.find((n) => n.name === 'StrTag').meta.dataType, 'STRING');

  const prog = await d.browse('program:MainProgram');
  assert.deepEqual(prog.map((n) => n.address), ['Program:MainProgram.LocalDint', 'Program:MainProgram.LocalReal']);

  const members = await d.browse(motor.id);
  assert.deepEqual(members.map((n) => n.name), ['Running', 'Fault', 'Speed', 'Count', 'Name', 'Code']);
  assert.equal(members.find((n) => n.name === 'Running').address, 'Motor.Running');
  assert.equal(members.find((n) => n.name === 'Fault').meta.bit, 1);
  assert.equal(members.find((n) => n.name === 'Speed').meta.offset, 4);

  const types = await d.browse('types');
  assert.deepEqual(types.map((n) => n.name).sort(), ['MotorType', 'STRING']);
  const typeMembers = await d.browse(types.find((n) => n.name === 'MotorType').id);
  assert.equal(typeMembers.length, 6);
  await assert.rejects(d.browse('bogus'), /unknown browse node/);
});

test('browse on pre-v18 firmware falls back to no External Access attribute', async () => {
  const sim = await startSim({ externalAccessAttr: false });
  const d = makeDriver(sim, ['DintTag']);
  await d.connect();
  const ctl = await d.browse('controller');
  assert.equal(ctl.find((n) => n.name === 'DintTag').meta.externalAccess, 'unknown');
  assert.equal((await readAll(d)).DintTag.v, 123456);
});

test('probe returns raw bytes and candidate decodings', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, []);
  await d.connect();
  const p = await d.probe({ address: 'RealTag' });
  assert.equal(p.address, 'RealTag');
  assert.equal(p.rawHex, '00006040');
  assert.equal(p.type, 'REAL');
  assert.equal(p.decodings.REAL, 3.5);
  assert.equal(p.decodings.value, 3.5);
  const s = await d.probe({ address: 'Motor' });
  assert.equal(s.type, 'MotorType');
  assert.equal(s.rawHex.length, 208);
  assert.equal(s.decodings.value.Speed, 1450.5);
  await assert.rejects(d.probe({ address: 'Nope' }), /not found/);
});

test('timeout destroys the socket; reconnect recovers', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag']);
  await d.connect();
  const [req] = d.plan();
  sim.faults.blackhole = true;
  const t0 = Date.now();
  const res = await d.execute(req, 150);
  assert.deepEqual({ ok: res.ok, kind: res.kind, fatal: res.fatal }, { ok: false, kind: 'timeout', fatal: true });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(d.isConnected(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sim.sockets.size, 0, 'socket destroyed, not reused');
  sim.faults.blackhole = false;
  await d.connect();
  const ok = await d.execute(d.plan()[0], 1000);
  assert.equal(ok.results[0].v, 123456);
});

test('a late reply is never matched to a later request', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag', 'IntTag'], { options: { packing: false } });
  await d.connect();
  const [reqDint, reqInt] = d.plan();
  sim.faults.lateReply = 300; // DintTag's reply arrives after its deadline
  const r1 = await d.execute(reqDint, 100);
  assert.equal(r1.kind, 'timeout');
  await d.connect();
  const r2 = await d.execute(reqInt, 1000);
  assert.equal(r2.ok, true);
  assert.equal(r2.results[0].key, 'IntTag');
  assert.equal(r2.results[0].v, -1234);
  await new Promise((r) => setTimeout(r, 350)); // the late reply lands on the dead socket
  const r3 = await d.execute(reqInt, 1000);
  assert.equal(r3.results[0].v, -1234);
});

test('wrong sequence count -> mismatch, socket destroyed', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag']);
  await d.connect();
  sim.faults.wrongSequence = true;
  const res = await d.execute(d.plan()[0], 1000);
  assert.deepEqual({ ok: res.ok, kind: res.kind, fatal: res.fatal }, { ok: false, kind: 'mismatch', fatal: true });
  assert.match(res.message, /sequence/);
  assert.equal(d.isConnected(), false);
});

test('wrong sender context on an unconnected reply -> mismatch', async () => {
  const sim = await startSim();
  const client = new EipClient({ host: '127.0.0.1', port: sim.port, route: cip.slotRoute(0), connectTimeoutMs: 1000 });
  await client.open({ preferredSize: 504, deadlineMs: 1000 });
  sim.faults.wrongContext = true;
  await assert.rejects(client.requestUnconnected(frame.getAttributeAll(1, 1), 1000), (err) => err.kind === 'mismatch' && /context/.test(err.message));
  assert.equal(client.isOpen, false);
  await client.close();
});

test('truncated frame -> framing error; dropped connection -> transport error', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag']);
  await d.connect();
  sim.faults.truncate = true;
  const r1 = await d.execute(d.plan()[0], 1000);
  assert.deepEqual({ kind: r1.kind, fatal: r1.fatal }, { kind: 'framing', fatal: true });
  await d.connect();
  sim.faults.dropConnection = true;
  const r2 = await d.execute(d.plan()[0], 1000);
  assert.deepEqual({ kind: r2.kind, fatal: r2.fatal }, { kind: 'transport', fatal: true });
  assert.equal(d.isConnected(), false);
});

test('refused connections make connect() throw, never crash', async () => {
  const sim = await startSim();
  sim.faults.refuseConnections = true;
  const d = makeDriver(sim, ['DintTag']);
  await assert.rejects(d.connect(), /connect to 127\.0\.0\.1/);
  assert.equal(d.isConnected(), false);
  const closedPort = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const d2 = eip.createDriver({ id: 'x', name: 'x', protocol: 'ethernet-ip', host: '127.0.0.1', port: closedPort, limits: { connectTimeoutMs: 500 }, tags: [] });
  drivers.push(d2);
  await assert.rejects(d2.connect(), /ECONNREFUSED/);
  sim.faults.refuseConnections = false;
  await d.connect();
  assert.equal(d.isConnected(), true);
});

test('close() sends Forward Close, UnRegisterSession, then FIN', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag']);
  await d.connect();
  assert.equal(sim.stats.openConnections, 1);
  await d.close();
  assert.equal(sim.stats.forwardCloses, 1);
  assert.equal(sim.stats.unregisterSessions, 1);
  assert.equal(sim.stats.openConnections, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sim.sockets.size, 0);
  assert.equal(d.isConnected(), false);
  await d.close(); // idempotent
});

test('read-only end to end: a write request never reaches the socket', async () => {
  const sim = await startSim();
  const seen = [];
  const d = makeDriver(sim, ['DintTag'], { deps: { onFrame: (b) => seen.push(b) } });
  await d.connect();
  const before = seen.length;
  const write = { service: 0x4d, path: cip.symbolic('DintTag'), data: Buffer.from('c400010000000000', 'hex') };
  await assert.rejects(d.client.request(write, 500), frame.EipReadOnlyError);
  await assert.rejects(d.client.request(frame.multipleServicePacket([frame.readTag(cip.symbolic('DintTag')), write]), 500), frame.EipReadOnlyError);
  await assert.rejects(d.client.requestUnconnected({ service: 0x05, path: Buffer.from('20012401', 'hex') }, 500), frame.EipReadOnlyError);
  assert.equal(seen.length, before, 'no frame was produced');
  assert.equal(d.isConnected(), true, 'the connection is still usable');
  assert.equal((await readAll(d)).DintTag.v, 123456);
  for (const b of seen) assert.doesNotThrow(() => frame.inspectOutgoingFrame(b));
  assert.equal(sim.stats.writesReceived, 0);
});

test('control: the simulator does count writes sent by a raw client', async () => {
  const sim = await startSim();
  const sock = net.createConnection({ host: '127.0.0.1', port: sim.port });
  await new Promise((r) => sock.once('connect', r));
  const reply = () => new Promise((r) => sock.once('data', r));
  const reg = Buffer.alloc(28);
  reg.writeUInt16LE(0x65, 0);
  reg.writeUInt16LE(4, 2);
  reg.writeUInt16LE(1, 24);
  sock.write(reg);
  const session = (await reply()).readUInt32LE(4);
  // Hand-built SendRRData carrying Write Tag (test code, not the driver).
  const cipMsg = Buffer.concat([Buffer.from([0x4d, 0x05]), cip.symbolic('DintTag'), Buffer.from('c4000100' + '07000000', 'hex')]);
  const body = Buffer.alloc(16);
  body.writeUInt16LE(2, 6);
  body.writeUInt16LE(0xb2, 12);
  body.writeUInt16LE(cipMsg.length, 14);
  const hdr = Buffer.alloc(24);
  hdr.writeUInt16LE(0x6f, 0);
  hdr.writeUInt16LE(body.length + cipMsg.length, 2);
  hdr.writeUInt32LE(session, 4);
  sock.write(Buffer.concat([hdr, body, cipMsg]));
  await reply();
  assert.equal(sim.stats.writesReceived, 1);
  sock.destroy();
  sim.stats.writesReceived = 0; // reset so the suite-level "driver never wrote" check stays meaningful
});

test('concurrent browse and execute are serialised over one socket', async () => {
  const sim = await startSim();
  const d = makeDriver(sim, ['DintTag', 'RealTag']);
  await d.connect();
  const [res, nodes, res2] = await Promise.all([d.execute(d.plan()[0], 1000), d.browse('controller'), d.execute(d.plan()[0], 1000)]);
  assert.equal(res.ok, true);
  assert.equal(res2.ok, true);
  assert.ok(nodes.length > 5);
  assert.equal(sim.stats.tcpConnections, 1);
});
