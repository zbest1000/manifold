'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createDriver, validateTag, describe: describeDriver, protocol } = require('../drivers/modbus');
const { ModbusClient } = require('../drivers/modbus/client');
const { ModbusReadOnlyError } = require('../drivers/modbus/frame');
const { startSimulator } = require('./support/modbusSimulator');

const DEADLINE = 60;
const sims = [];
const drivers = [];
const clients = [];

async function setup(units, { device = {}, faults } = {}) {
  const sim = await startSimulator({ units, faults });
  sims.push(sim);
  const drv = createDriver({
    id: 'd1', name: 'dev', protocol: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1,
    limits: { requestDeadlineMs: DEADLINE, connectTimeoutMs: 200 },
    tags: [], ...device,
  });
  drivers.push(drv);
  return { sim, drv };
}

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
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await Promise.all(drivers.map((d) => d.close().catch(() => {})));
  await Promise.all(sims.map((s) => s.close()));
});

test('describe and static metadata', () => {
  assert.equal(protocol, 'modbus-tcp');
  const d = describeDriver();
  assert.equal(d.defaultPort, 502);
  assert.ok(d.tagTypes.includes('float32'));
});

test('reads every type and byte/word order end to end', async () => {
  const orders = { byteOrder: 'little', wordOrder: 'little' };
  const { sim, drv } = await setup(
    { 1: { holding: {}, input: { 0: 500 }, coils: { 5: 1 }, discrete: { 1: 1 } } },
    {
      device: {
        tags: [
          { key: 'u16', address: 'holding:0', type: 'uint16' },
          { key: 'i16', address: 'holding:1', type: 'int16' },
          { key: 'i32', address: 'holding:2', type: 'int32' },
          { key: 'f32cdab', address: 'holding:4', type: 'float32', wordOrder: 'little' },
          { key: 'u32badc', address: 'holding:6', type: 'uint32', byteOrder: 'little' },
          { key: 'i64', address: 'holding:8', type: 'int64' },
          { key: 'u64', address: 'holding:12', type: 'uint64' },
          { key: 'f64', address: 'holding:16', type: 'float64' },
          { key: 'str', address: 'holding:20', type: 'string', length: 3 },
          { key: 'bit', address: 'holding:23', type: 'bool', bit: 3 },
          { key: 'scaled', address: 'holding:24', type: 'uint16', scale: 0.1, offset: 5 },
          { key: 'dcba', address: 'holding:25', type: 'float32', ...orders },
          { key: 'coil', address: 'coil:5', type: 'bool' },
          { key: 'disc', address: 'discrete:1', type: 'bool' },
          { key: 'off', address: 'discrete:0', type: 'bool' },
          { key: 'inp', address: 'input:0', type: 'uint16' },
          { key: 'modicon', address: '40001', type: 'uint16' },
        ],
      },
    }
  );
  sim.setRegister(1, 'holding', 0, 1234);
  sim.setRegister(1, 'holding', 1, 0xfffe);
  sim.setInt32(1, 'holding', 2, -70000);
  sim.setFloat32(1, 'holding', 4, 3.5, { wordOrder: 'little' });
  sim.setUInt32(1, 'holding', 6, 0xdeadbeef, { byteOrder: 'little' });
  sim.setInt64(1, 'holding', 8, -5000000000n);
  sim.setUInt64(1, 'holding', 12, 18446744073709551615n);
  sim.setFloat64(1, 'holding', 16, Math.PI);
  sim.setString(1, 'holding', 20, 'HELLO', 3);
  sim.setRegister(1, 'holding', 23, 0b1000);
  sim.setRegister(1, 'holding', 24, 100);
  sim.setFloat32(1, 'holding', 25, -1.25, orders);

  await drv.connect();
  assert.equal(drv.isConnected(), true);
  const r = await readAll(drv);
  assert.equal(r.u16.v, 1234);
  assert.equal(r.i16.v, -2);
  assert.equal(r.i32.v, -70000);
  assert.equal(r.f32cdab.v, 3.5);
  assert.equal(r.u32badc.v, 0xdeadbeef);
  assert.equal(r.i64.v, '-5000000000');
  assert.equal(r.u64.v, '18446744073709551615');
  assert.equal(r.f64.v, Math.PI);
  assert.equal(r.str.v, 'HELLO');
  assert.equal(r.bit.v, true);
  assert.ok(Math.abs(r.scaled.v - 15) < 1e-9);
  assert.equal(r.dcba.v, -1.25);
  assert.equal(r.coil.v, true);
  assert.equal(r.disc.v, true);
  assert.equal(r.off.v, false);
  assert.equal(r.inp.v, 500);
  assert.equal(r.modicon.v, 1234);
  for (const x of Object.values(r)) assert.equal(x.q, 192);
  assert.equal(r.u64.type, 'uint64');
});

test('contiguous tags coalesce into one request per table', async () => {
  const { sim, drv } = await setup(
    { 1: { holding: { 0: 1, 1: 2, 2: 3, 3: 4 }, input: { 0: 9 } } },
    {
      device: {
        tags: [
          { key: 'a', address: 'holding:0', type: 'uint16' },
          { key: 'b', address: 'holding:1', type: 'uint16' },
          { key: 'c', address: 'holding:2', type: 'uint32' },
          { key: 'd', address: 'input:0', type: 'uint16' },
        ],
      },
    }
  );
  await drv.connect();
  const plan = drv.plan();
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.id), drv.plan().map((p) => p.id), 'plan ids are stable');
  assert.equal(drv.plan(['a']).length, 1);
  const r = await readAll(drv);
  assert.equal(r.b.v, 2);
  assert.equal(r.c.v, (3 << 16) | 4);
  assert.equal(sim.stats.byFc[3], 1);
  assert.equal(sim.stats.byFc[4], 1);
  assert.equal(sim.stats.requests, 2);
});

test('exception 02 over an unmapped register: bisect isolates the bad tag', async () => {
  const { drv } = await setup(
    { 1: { holding: { 8: 80, 9: 90, 11: 110 }, unmapped: [{ table: 'holding', from: 10, to: 10 }] } },
    {
      device: {
        tags: [8, 9, 10, 11].map((n) => ({ key: `t${n}`, address: `holding:${n}`, type: 'uint16' })),
      },
    }
  );
  await drv.connect();
  const plan = drv.plan();
  assert.equal(plan.length, 1);
  const res = await drv.execute(plan[0], DEADLINE);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'exception');
  assert.equal(res.code, 2);
  assert.equal(res.classification, 'permanent');
  assert.ok(drv.isConnected(), 'an exception does not drop the connection');

  const good = {};
  const bad = [];
  const queue = [plan[0]];
  while (queue.length) {
    const req = queue.shift();
    const out = await drv.execute(req, DEADLINE);
    if (out.ok) out.results.forEach((x) => (good[x.key] = x.v));
    else {
      const halves = drv.bisect(req);
      if (halves) queue.push(...halves);
      else bad.push(req.items[0].key);
    }
  }
  assert.deepEqual(bad, ['t10']);
  assert.deepEqual(good, { t8: 80, t9: 90, t11: 110 });
});

test('timeout destroys the socket; a later connect() + read works', async () => {
  const { sim, drv } = await setup({ 1: { holding: { 0: 42 } } }, {
    device: { tags: [{ key: 'a', address: 'holding:0', type: 'uint16' }] },
  });
  await drv.connect();
  sim.faults.blackhole = true;
  const res = await drv.execute(drv.plan()[0], 30);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'timeout');
  assert.equal(res.fatal, true);
  assert.equal(drv.isConnected(), false);
  const after = await drv.execute(drv.plan()[0], 30);
  assert.equal(after.kind, 'transport');
  sim.faults.blackhole = false;
  await drv.connect();
  const ok = await drv.execute(drv.plan()[0], DEADLINE);
  assert.equal(ok.results[0].v, 42);
  assert.equal(sim.stats.connections, 2);
});

test('late reply after a timeout is never matched to the next request', async () => {
  const { sim, drv } = await setup({ 1: { holding: { 0: 111, 1: 222 } } }, {
    device: {
      tags: [
        { key: 'A', address: 'holding:0', type: 'uint16' },
        { key: 'B', address: 'holding:1', type: 'uint16' },
      ],
    },
  });
  await drv.connect();
  const [reqA, reqB] = [drv.plan(['A'])[0], drv.plan(['B'])[0]];
  sim.faults.lateReply = { delayMs: 120, count: 1 };
  const a = await drv.execute(reqA, 30);
  assert.equal(a.kind, 'timeout');
  await drv.connect();
  const b = await drv.execute(reqB, DEADLINE);
  assert.equal(b.ok, true);
  assert.equal(b.results[0].v, 222);
  await new Promise((r) => setTimeout(r, 150)); // the late answer to A is written to the dead socket
  const b2 = await drv.execute(reqB, DEADLINE);
  assert.equal(b2.results[0].v, 222);
  assert.equal(sim.stats.connections, 2);
});

test('wrong transaction id: mismatch, socket destroyed', async () => {
  const { sim, drv } = await setup({ 1: { holding: { 0: 1 } } }, {
    device: { tags: [{ key: 'a', address: 'holding:0', type: 'uint16' }] },
  });
  await drv.connect();
  sim.faults.wrongTid = true;
  const res = await drv.execute(drv.plan()[0], DEADLINE);
  assert.equal(res.kind, 'mismatch');
  assert.equal(res.fatal, true);
  assert.equal(drv.isConnected(), false);
});

test('wrong echoed unit id is a mismatch', async () => {
  const { sim, drv } = await setup({ 1: { holding: { 0: 1 } } }, {
    device: { tags: [{ key: 'a', address: 'holding:0', type: 'uint16' }] },
  });
  await drv.connect();
  sim.faults.echoUnitId = 9;
  const res = await drv.execute(drv.plan()[0], DEADLINE);
  assert.equal(res.kind, 'mismatch');
});

test('truncated frame and dropped connection give transport errors, no uncaught exception', async () => {
  const { sim, drv } = await setup({ 1: { holding: { 0: 1 } } }, {
    device: { tags: [{ key: 'a', address: 'holding:0', type: 'uint16' }] },
  });
  for (const fault of [{ truncate: true }, { dropConnection: true }]) {
    await drv.connect();
    sim.faults = { ...fault };
    const res = await drv.execute(drv.plan()[0], DEADLINE);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'transport', JSON.stringify(fault));
    assert.equal(res.fatal, true);
    assert.equal(drv.isConnected(), false);
  }
  // A partial frame on a socket that stays open ends in a timeout instead.
  await drv.connect();
  sim.faults = { truncate: { bytes: 9, close: false } };
  const res = await drv.execute(drv.plan()[0], 30);
  assert.equal(res.kind, 'timeout');
});

test('framing error (bad protocol id) destroys the socket', async () => {
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', () => s.write(Buffer.from('0001ffff0003010300', 'hex')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new ModbusClient({ host: '127.0.0.1', port: server.address().port, connectTimeoutMs: 200 });
  clients.push(c);
  await c.connect();
  const res = await c.request({ unitId: 1, fc: 3, address: 0, quantity: 1 }, DEADLINE);
  assert.equal(res.kind, 'framing');
  assert.equal(c.isConnected(), false);
  await new Promise((r) => server.close(r));
});

test('client keeps one request in flight and answers concurrent calls in order', async () => {
  const sim = await startSimulator({ units: { 1: { holding: { 0: 10, 1: 11, 2: 12, 3: 13, 4: 14 } } }, faults: { delayMs: 10 } });
  sims.push(sim);
  let writes = 0;
  let responses = 0;
  let maxOutstanding = 0;
  const c = new ModbusClient({
    host: '127.0.0.1', port: sim.port, connectTimeoutMs: 200,
    socketFactory: ({ host, port }) => {
      const s = net.createConnection({ host, port });
      const write = s.write.bind(s);
      s.write = (...a) => {
        maxOutstanding = Math.max(maxOutstanding, ++writes - responses);
        return write(...a);
      };
      s.on('data', () => responses++);
      return s;
    },
  });
  clients.push(c);
  await c.connect();
  const done = [];
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map((a) => c.request({ unitId: 1, fc: 3, address: a, quantity: 1 }, 200).then((r) => (done.push(a), r)))
  );
  assert.deepEqual(done, [0, 1, 2, 3, 4]);
  assert.deepEqual(results.map((r) => r.data.readUInt16BE(0)), [10, 11, 12, 13, 14]);
  assert.equal(maxOutstanding, 1, 'a request is only written once the previous one was answered');
});

test('client queue is bounded; a failure fails everything queued with transport', async () => {
  const sim = await startSimulator({ units: { 1: { holding: {} } }, faults: { blackhole: true } });
  sims.push(sim);
  const c = new ModbusClient({ host: '127.0.0.1', port: sim.port, connectTimeoutMs: 200, maxQueue: 2 });
  clients.push(c);
  await c.connect();
  const req = (a) => c.request({ unitId: 1, fc: 3, address: a, quantity: 1 }, 40);
  const ps = [req(0), req(1), req(2), req(3)];
  assert.equal((await ps[3]).kind, 'queue-full');
  assert.equal((await ps[0]).kind, 'timeout');
  assert.equal((await ps[1]).kind, 'transport');
  assert.equal((await ps[2]).kind, 'transport');
  assert.equal(c.isConnected(), false);
});

test('client refuses write function codes and sends nothing', async () => {
  const sim = await startSimulator({ units: { 1: { holding: {} } } });
  sims.push(sim);
  const c = new ModbusClient({ host: '127.0.0.1', port: sim.port, connectTimeoutMs: 200 });
  clients.push(c);
  await c.connect();
  for (const fc of [5, 6, 15, 16, 22, 23]) {
    await assert.rejects(c.request({ unitId: 1, fc, address: 0, quantity: 1 }, DEADLINE), ModbusReadOnlyError);
  }
  assert.equal(sim.stats.requests, 0);
});

test('connection refused: connect rejects quickly; connect timeout also rejects', async () => {
  const { sim, drv } = await setup({ 1: { holding: {} } });
  await sim.stopListening();
  const t0 = Date.now();
  await assert.rejects(drv.connect());
  assert.ok(Date.now() - t0 < 200);
  assert.equal(drv.isConnected(), false);

  const c = new ModbusClient({ host: '127.0.0.1', port: 1, connectTimeoutMs: 40, socketFactory: () => new net.Socket() });
  const t1 = Date.now();
  await assert.rejects(c.connect(), /timed out/);
  assert.ok(Date.now() - t1 < 150);
});

test('sentinel value is reported as null with bad quality', async () => {
  const { drv } = await setup({ 1: { holding: { 0: 0x7fff, 1: 5 } } }, {
    device: {
      tags: [
        { key: 's', address: 'holding:0', type: 'int16', sentinels: [32767] },
        { key: 'n', address: 'holding:1', type: 'int16', sentinels: [32767] },
      ],
    },
  });
  await drv.connect();
  const r = await readAll(drv);
  assert.deepEqual(r.s, { key: 's', v: null, type: 'int16', q: 0, qReason: 'unavailable' });
  assert.equal(r.n.v, 5);
  assert.equal(r.n.q, 192);
});

test('per-tag unit ids: unit 2 answering 0B is unit-down while unit 1 keeps working', async () => {
  const { sim, drv } = await setup(
    { 1: { holding: { 0: 7 } }, 2: { holding: { 0: 8 } } },
    {
      device: {
        tags: [
          { key: 'u1', address: 'holding:0', type: 'uint16' },
          { key: 'u2', address: 'holding:0', type: 'uint16', unitId: 2 },
        ],
      },
    }
  );
  await drv.connect();
  const plan = drv.plan();
  assert.equal(plan.length, 2, 'different units are never merged');
  assert.deepEqual(plan.map((p) => p.unitId).sort(), [1, 2]);
  const r = await readAll(drv);
  assert.equal(r.u1.v, 7);
  assert.equal(r.u2.v, 8);

  sim.setUnitFault(2, 'exception', { code: 0x0b });
  const req1 = plan.find((p) => p.unitId === 1);
  const req2 = plan.find((p) => p.unitId === 2);
  const down = await drv.execute(req2, DEADLINE);
  assert.equal(down.ok, false);
  assert.equal(down.kind, 'exception');
  assert.equal(down.code, 0x0b);
  assert.equal(down.classification, 'unit-down');
  assert.equal(drv.isConnected(), true);
  assert.equal((await drv.execute(req1, DEADLINE)).results[0].v, 7);
  assert.equal(sim.stats.connections, 1, 'both units share one socket');
});

test('probe returns raw bytes and all decodings', async () => {
  const { sim, drv } = await setup({ 1: { holding: {}, coils: { 0: 1, 2: 1 } } });
  sim.setFloat32(1, 'holding', 100, 1.5);
  await drv.connect();
  const p = await drv.probe({ address: 'holding:100', count: 2 });
  assert.deepEqual(p.address, { table: 'holding', offset: 100 });
  assert.equal(p.rawHex, '3fc00000');
  assert.deepEqual(p.words, [0x3fc0, 0]);
  assert.equal(p.decodings.ABCD.float32, 1.5);
  const bits = await drv.probe({ address: 'coil:0', count: 3 });
  assert.deepEqual(bits.words, [1, 0, 1]);
  sim.faults.exception = { code: 2 };
  await assert.rejects(drv.probe({ address: 'holding:100' }), /illegal data address/);
});

test('validateTag and createDriver report every invalid tag', () => {
  const ok = validateTag({ key: 'a', address: '400101', type: 'float32' }, {});
  assert.equal(ok.ok, true);
  assert.deepEqual(
    { t: ok.normalized.table, o: ok.normalized.offset, c: ok.normalized.count, fc: ok.normalized.fc },
    { t: 'holding', o: 100, c: 2, fc: 3 }
  );
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'uint16' }, { addressBase: 1 }).normalized.offset, 0);
  assert.equal(validateTag({ key: 'a', address: '123', type: 'uint16' }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'coil:1', type: 'uint16' }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'bool' }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'string' }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'string', length: 200 }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'bool', bit: 16 }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'uint16', unitId: 300 }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'uint16', wordOrder: 'mid' }).ok, false);
  assert.equal(validateTag({ key: 'a', address: 'holding:1', type: 'uint17' }).ok, false);

  assert.throws(
    () =>
      createDriver({
        host: '127.0.0.1',
        tags: [
          { key: 'good', address: 'holding:1', type: 'uint16' },
          { key: 'bad1', address: 'nope', type: 'uint16' },
          { key: 'bad2', address: 'holding:2', type: 'wat' },
          { key: 'good', address: 'holding:3', type: 'uint16' },
        ],
      }),
    (err) => {
      assert.deepEqual(err.details.map((d) => d.key), ['bad1', 'bad2', 'good']);
      return true;
    }
  );
  assert.throws(() => createDriver({ host: '', tags: [] }), (e) => e.details.length === 1);
});

test('the simulator counts writes, and the driver never sent any', async () => {
  const sim = await startSimulator({ units: { 1: { holding: {} } } });
  sims.push(sim);
  // Prove the counter works with a hand-built write (fc 6) over a raw socket.
  await new Promise((resolve) => {
    const s = net.createConnection({ port: sim.port, host: '127.0.0.1' }, () => {
      s.write(Buffer.from('000100000006010600010002', 'hex'));
    });
    s.on('data', () => {
      s.destroy();
      resolve();
    });
  });
  assert.equal(sim.stats.writesReceived, 1);
  assert.equal(sim.stats.byFc[6], 1);
});

test('no write function code reached any simulator used by the driver tests', () => {
  const driverSims = sims.slice(0, -1); // the last one is the counter self-check above
  assert.ok(driverSims.length > 5);
  for (const s of driverSims) assert.equal(s.stats.writesReceived, 0);
});
