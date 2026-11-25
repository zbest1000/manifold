'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const s7 = require('../drivers/s7');
const { createS7Simulator } = require('./support/s7Simulator');

// ── outgoing-frame spy: every S7 PDU any socket in this process sends ──────
// The simulator only ever sends ack-data (ROSCTR 3) and userdata responses
// (method 0x12); anything with ROSCTR 1 or a userdata request comes from the
// driver and must be on the read-only allowlist.
const forbiddenFrames = [];
let driverJobs = 0;
const origWrite = net.Socket.prototype.write;
net.Socket.prototype.write = function spy(chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk.length >= 17 && chunk[0] === 3 && chunk[5] === 0xf0 && chunk[7] === 0x32) {
    const rosctr = chunk[8];
    const param = chunk.subarray(17);
    if (rosctr === 1) {
      driverJobs++;
      if (param[0] !== 0xf0 && param[0] !== 0x04) forbiddenFrames.push(chunk.toString('hex'));
    } else if (rosctr === 7 && param[4] === 0x11) {
      driverJobs++;
      if (param[5] !== 0x44 || param[6] !== 0x01) forbiddenFrames.push(chunk.toString('hex'));
    } else if (rosctr !== 3 && rosctr !== 7) {
      forbiddenFrames.push(chunk.toString('hex'));
    }
  }
  return origWrite.call(this, chunk, ...rest);
};

const sims = [];
async function startSim(opts) {
  const sim = createS7Simulator(opts);
  await sim.start();
  sims.push(sim);
  return sim;
}
const drivers = [];
function makeDriver(sim, overrides = {}) {
  const d = s7.createDriver({
    id: 'plc1',
    name: 'Test PLC',
    protocol: 's7',
    host: '127.0.0.1',
    port: sim.port,
    rack: 0,
    slot: 1,
    options: {},
    limits: { requestDeadlineMs: 500, connectTimeoutMs: 1000 },
    tags: [],
    ...overrides,
  });
  drivers.push(d);
  return d;
}
async function readAll(driver, deadline) {
  const out = {};
  for (const r of driver.plan()) {
    const res = await driver.execute(r, deadline);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const x of res.results) {
      assert.equal(out[x.key], undefined, `${x.key} reported twice`);
      out[x.key] = x;
    }
  }
  return out;
}
const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test.after(async () => {
  for (const d of drivers) await d.close().catch(() => {});
  const writes = sims.reduce((s, x) => s + x.stats.writesReceived, 0);
  const control = sims.reduce((s, x) => s + x.stats.controlReceived, 0);
  const other = sims.reduce((s, x) => s + x.stats.otherJobs + x.stats.otherUserdata, 0);
  const oversize = sims.reduce((s, x) => s + x.stats.oversizeRequests + x.stats.oversizeResponses, 0);
  for (const s of sims) await s.stop();
  net.Socket.prototype.write = origWrite;
  assert.equal(writes, 0, 'writesReceived');
  assert.equal(control, 0, 'controlReceived');
  assert.equal(other, 0, 'no other jobs or userdata');
  assert.equal(oversize, 0, 'no request or response exceeded the negotiated PDU');
  assert.deepEqual(forbiddenFrames, []);
  assert.ok(driverJobs > 50, `spy saw driver traffic (${driverJobs})`);
});

// ── fixture: every type, written with independent BE encoders ──────────────

const DT_BCD = Buffer.from('2611241020305671', 'hex'); // 2026-11-24 10:20:30.567, Tuesday
const DAYS_2026_11_24 = (Date.UTC(2026, 10, 24) - Date.UTC(1990, 0, 1)) / 86400000;
const LONG_TEXT = 'S7 long string '.repeat(17).slice(0, 254);
const HUGE_WTEXT = 'Ünïcødé ✓ '.repeat(100).slice(0, 1000);

function buildDb() {
  const b = Buffer.alloc(2600);
  b[0] = 0b10100101;
  b[1] = 0xab;
  b.writeUInt16BE(0x1234, 2);
  b.writeUInt32BE(0xdeadbeef, 4);
  b.writeBigUInt64BE(256n, 8);
  b.writeInt8(-5, 16);
  b.writeUInt8(250, 17);
  b.writeInt16BE(-1234, 18);
  b.writeUInt16BE(60000, 20);
  b.writeInt32BE(-123456, 22);
  b.writeUInt32BE(4000000000, 26);
  b.writeBigInt64BE(-9007199254740993n, 30);
  b.writeBigUInt64BE(18446744073709551615n, 38);
  b.writeFloatBE(1.5, 46);
  b.writeDoubleBE(Math.E, 50);
  b.write('Z', 58, 'latin1');
  b.writeUInt16BE(0x03a9, 60); // Ω
  b[62] = 20;
  b[63] = 8;
  b.write('Manifold', 64, 'latin1');
  b.writeUInt16BE(10, 84);
  b.writeUInt16BE(5, 86);
  Buffer.from('Grüße', 'utf16le').swap16().copy(b, 88);
  b.writeUInt16BE(DAYS_2026_11_24, 108);
  b.writeUInt32BE(37230500, 110); // 10:20:30.500
  DT_BCD.copy(b, 114);
  b.writeUInt16BE(2026, 122);
  b[124] = 11;
  b[125] = 24;
  b[126] = 3;
  b[127] = 10;
  b[128] = 20;
  b[129] = 30;
  b.writeUInt32BE(5000000, 130);
  b.writeInt32BE(-1000, 134);
  b.writeBigInt64BE(50000000000n, 138);
  b.writeUInt16BE(0x1234, 146);
  b[200] = 254;
  b[201] = 254;
  b.write(LONG_TEXT, 202, 'latin1');
  b.writeUInt16BE(1000, 500);
  b.writeUInt16BE(1000, 502);
  Buffer.from(HUGE_WTEXT, 'utf16le').swap16().copy(b, 504);
  return b;
}

const TYPE_TAGS = [
  ['x0', 'DB10.DBX0.0', 'BOOL', true, 'bool'],
  ['x1', 'DB10.DBX0.1', 'BOOL', false, 'bool'],
  ['x7', 'DB10.DBX0.7', 'BOOL', true, 'bool'],
  ['byte', 'DB10.DBB1', 'BYTE', 0xab, 'uint8'],
  ['word', 'DB10.DBW2', 'WORD', 0x1234, 'uint16'],
  ['dword', 'DB10.DBD4', 'DWORD', 0xdeadbeef, 'uint32'],
  ['lword', 'DB10.DBB8', 'LWORD', '256', 'uint64'],
  ['sint', 'DB10.DBB16', 'SINT', -5, 'int8'],
  ['usint', 'DB10.DBB17', 'USINT', 250, 'uint8'],
  ['int', 'DB10.DBW18', 'INT', -1234, 'int16'],
  ['uint', 'DB10.DBW20', 'UINT', 60000, 'uint16'],
  ['dint', 'DB10.DBD22', 'DINT', -123456, 'int32'],
  ['udint', 'DB10.DBD26', 'UDINT', 4000000000, 'uint32'],
  ['lint', 'DB10.DBB30', 'LINT', '-9007199254740993', 'int64'],
  ['ulint', 'DB10.DBB38', 'ULINT', '18446744073709551615', 'uint64'],
  ['real', 'DB10.DBD46', 'REAL', 1.5, 'float32'],
  ['lreal', 'DB10.DBB50', 'LREAL', Math.E, 'float64'],
  ['char', 'DB10.DBB58', 'CHAR', 'Z', 'string'],
  ['wchar', 'DB10.DBW60', 'WCHAR', 'Ω', 'string'],
  ['string', 'DB10.DBB62', 'STRING', 'Manifold', 'string', 20],
  ['wstring', 'DB10.DBB84', 'WSTRING', 'Grüße', 'string', 10],
  ['date', 'DB10.DBW108', 'DATE', '2026-11-24', 'datetime'],
  ['tod', 'DB10.DBD110', 'TIME_OF_DAY', 37230500, 'uint32'],
  ['dt', 'DB10.DBB114', 'DATE_AND_TIME', '2026-11-24T10:20:30.567', 'datetime'],
  ['dtl', 'DB10.DBB122', 'DTL', '2026-11-24T10:20:30.005', 'datetime'],
  ['time', 'DB10.DBD134', 'TIME', -1000, 'int32'],
  ['ltime', 'DB10.DBB138', 'LTIME', '50000000000', 'int64'],
  ['s5time', 'DB10.DBW146', 'S5TIME', 23400, 'uint32'],
  ['longString', 'DB10.DBB200', 'STRING', LONG_TEXT, 'string', 254],
  ['hugeWstring', 'DB10.DBB500', 'WSTRING', HUGE_WTEXT, 'string', 1000],
  ['m0.1', 'M0.1', 'BOOL', true, 'bool'],
  ['mw2', 'MW2', 'INT', -2, 'int16'],
  ['md4', 'MD4', 'REAL', -0.25, 'float32'],
  ['i0.3', 'E0.3', 'BOOL', true, 'bool'],
  ['iw2', 'IW2', 'WORD', 0xbeef, 'uint16'],
  ['q1.0', 'A1.0', 'BOOL', true, 'bool'],
  ['qd4', 'QD4', 'DINT', 7, 'int32'],
];

function typeSimOptions(maxPdu) {
  const M = Buffer.alloc(64);
  M[0] = 0b10;
  M.writeInt16BE(-2, 2);
  M.writeFloatBE(-0.25, 4);
  const I = Buffer.alloc(16);
  I[0] = 0b1000;
  I.writeUInt16BE(0xbeef, 2);
  const Q = Buffer.alloc(16);
  Q[1] = 1;
  Q.writeInt32BE(7, 4);
  return { maxPdu, dbs: { 10: buildDb() }, M, I, Q };
}
const typeTags = () => TYPE_TAGS.map(([key, address, type, , , length]) => ({ key, address, type, ...(length ? { length } : {}) }));

// ── end-to-end ─────────────────────────────────────────────────────────────

for (const pdu of [240, 480, 960]) {
  test(`reads every type from DB, M, I and Q at negotiated PDU ${pdu}`, async () => {
    const sim = await startSim(typeSimOptions(pdu));
    const d = makeDriver(sim, { tags: typeTags() });
    assert.deepEqual(d.tagErrors, []);
    const info = await d.connect();
    assert.deepEqual(info.limits, { pduSize: pdu, maxAmq: 1 });
    assert.equal(info.identity.cpuState, 'RUN');
    assert.equal(info.identity.orderCode, '6ES7 516-3AN02-0AB0');
    assert.equal(info.identity.firmware, 'V2.9.4');
    assert.equal(info.identity.moduleTypeName, 'CPU 1516-3 PN/DP');
    assert.equal(d.isConnected(), true);
    const plan = d.plan();
    // the 2004-byte WSTRING never fits one PDU; the 256-byte STRING only fits from 480 up
    const multi = plan.filter((r) => r.jobs.length > 1).map((r) => r.items[0].key).sort();
    assert.deepEqual(multi, pdu === 240 ? ['hugeWstring', 'longString'] : ['hugeWstring']);
    const got = await readAll(d);
    for (const [key, , , v, type] of TYPE_TAGS) {
      assert.deepEqual(got[key], { key, v, type, q: 192 }, key);
    }
    assert.equal(sim.stats.lastRemoteTsap, 0x0101);
    await d.close();
  });
}

test('requested PDU is negotiated down, never up', async () => {
  const sim = await startSim({ maxPdu: 960, dbs: { 1: Buffer.alloc(10) } });
  const d = makeDriver(sim, { options: { pduSize: 480 } });
  assert.equal((await d.connect()).limits.pduSize, 480);
  await d.close();
});

test('plan is stable for an unchanged tag set; subsets plan only their keys', async () => {
  const sim = await startSim(typeSimOptions(480));
  const d = makeDriver(sim, { tags: typeTags() });
  assert.deepEqual(d.plan().map((r) => r.id), d.plan().map((r) => r.id));
  assert.ok(d.plan().every((r) => r.pduSize === 240), 'before connect plans for the safe 240');
  await d.connect();
  const a = d.plan();
  assert.deepEqual(d.plan(), a);
  const sub = d.plan(['int', 'mw2', 'nope']);
  assert.deepEqual(sub.flatMap((r) => r.items.map((i) => i.key)).sort(), ['int', 'mw2']);
  for (const r of a) for (const it of r.items) assert.ok(Array.isArray(it.parts) && typeof it.key === 'string');
  await d.close();
});

test('a bad item return code leaves its siblings good, with operator language', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, {
    tags: [
      { key: 'good1', address: 'DB10.DBW18', type: 'INT' },
      { key: 'noDb', address: 'DB99.DBW0', type: 'INT' },
      { key: 'beyond', address: 'DB10.DBD4000', type: 'REAL' },
      { key: 'mBeyond', address: 'MW1000', type: 'INT' },
      { key: 'good2', address: 'MW2', type: 'INT' },
    ],
  });
  await d.connect();
  const plan = d.plan();
  assert.equal(plan.length, 1, 'all five in one request');
  const res = await d.execute(plan[0]);
  assert.equal(res.ok, true);
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  assert.deepEqual(by.good1, { key: 'good1', v: -1234, type: 'int16', q: 192 });
  assert.deepEqual(by.good2, { key: 'good2', v: -2, type: 'int16', q: 192 });
  assert.equal(by.noDb.q, 0);
  assert.equal(by.noDb.qReason, 'device-exception');
  assert.equal(by.noDb.message, 'DB does not exist');
  assert.equal(by.beyond.message, 'DB shorter than the requested range');
  assert.equal(by.beyond.v, null);
  assert.match(by.mBeyond.message, /end of the M area/);
  // bisect isolates halves that still work
  const halves = d.bisect(plan[0]);
  assert.equal(halves.length, 2);
  for (const h of halves) assert.equal((await d.execute(h)).ok, true);
  await d.close();
});

test('an undecodable value is bad with qReason decode, siblings stay good', async () => {
  const db = Buffer.alloc(32);
  db.write('ffffffffffffffff', 0, 'hex'); // not BCD
  db.writeInt16BE(5, 10);
  const sim = await startSim({ dbs: { 3: db } });
  const d = makeDriver(sim, {
    tags: [
      { key: 'dt', address: 'DB3.DBB0', type: 'DATE_AND_TIME' },
      { key: 'i', address: 'DB3.DBW10', type: 'INT' },
    ],
  });
  await d.connect();
  const [res] = await Promise.all(d.plan().map((r) => d.execute(r)));
  const by = Object.fromEntries(res.results.map((r) => [r.key, r]));
  assert.equal(by.dt.q, 0);
  assert.equal(by.dt.qReason, 'decode');
  assert.equal(by.i.v, 5);
  await d.close();
});

test('whole-request S7 error is an exception result with operator text', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.faults.headerError = [0x81, 0x04];
  const res = await d.execute(d.plan()[0]);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'exception');
  assert.equal(res.code, 0x8104);
  assert.equal(res.classification, 'permanent');
  assert.match(res.message, /PUT\/GET not permitted, optimized block access enabled, or protection level too high/);
  assert.equal(d.isConnected(), true, 'an exception does not drop the connection');
  sim.faults.headerError = [0x83, 0x04];
  assert.equal((await d.execute(d.plan()[0])).classification, 'retry');
  sim.faults.headerError = null;
  assert.equal((await d.execute(d.plan()[0])).ok, true);
  await d.close();
});

test('timeout destroys the socket; reconnect works', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.faults.blackhole = true;
  const t0 = Date.now();
  const res = await d.execute(d.plan()[0], 150);
  assert.deepEqual({ ok: res.ok, kind: res.kind, fatal: res.fatal }, { ok: false, kind: 'timeout', fatal: true });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(d.isConnected(), false);
  await waitFor(() => sim.openConnections === 0);
  const again = await d.execute(d.plan()[0]);
  assert.deepEqual({ ok: again.ok, kind: again.kind }, { ok: false, kind: 'transport' });
  sim.faults.blackhole = false;
  await d.connect();
  assert.equal((await readAll(d)).i.v, -1234);
  assert.equal(sim.stats.connections, 2);
  await d.close();
});

test('a late reply is never matched to a later request', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.faults.lateReply = 300;
  const res = await d.execute(d.plan()[0], 100);
  assert.equal(res.kind, 'timeout');
  sim.faults.lateReply = 0;
  sim.memory.dbs.get(10).writeInt16BE(4321, 18);
  await d.connect();
  assert.equal((await readAll(d)).i.v, 4321);
  await new Promise((r) => setTimeout(r, 350)); // the stale reply (-1234) is due now, on the dead socket
  const after = await readAll(d);
  assert.deepEqual(after.i, { key: 'i', v: 4321, type: 'int16', q: 192 });
  assert.equal(d.isConnected(), true);
  await d.close();
});

test('wrong PDU reference → mismatch, socket destroyed', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.faults.wrongPduRef = true;
  const res = await d.execute(d.plan()[0]);
  assert.deepEqual({ ok: res.ok, kind: res.kind, fatal: res.fatal }, { ok: false, kind: 'mismatch', fatal: true });
  assert.equal(d.isConnected(), false);
  await waitFor(() => sim.openConnections === 0);
  sim.faults.wrongPduRef = false;
  await d.connect();
  assert.equal((await readAll(d)).i.v, -1234);
  await d.close();
});

test('truncated/inconsistent frame → framing; dropped connection → transport', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.faults.truncate = true;
  let res = await d.execute(d.plan()[0]);
  assert.deepEqual({ kind: res.kind, fatal: res.fatal }, { kind: 'framing', fatal: true });
  assert.equal(d.isConnected(), false);
  sim.faults.truncate = false;
  await d.connect();
  sim.faults.dropConnection = true;
  res = await d.execute(d.plan()[0]);
  assert.deepEqual({ kind: res.kind, fatal: res.fatal }, { kind: 'transport', fatal: true });
  sim.faults.dropConnection = false;
  await d.connect();
  assert.equal((await readAll(d)).i.v, -1234);
  await d.close();
});

test('PLC restart (all connections dropped) is reported, then recovers', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  await d.connect();
  sim.dropAll();
  await waitFor(() => !d.isConnected());
  const res = await d.execute(d.plan()[0]);
  assert.equal(res.kind, 'transport');
  await d.connect();
  assert.equal((await readAll(d)).i.v, -1234);
  await d.close();
});

test('connect failures throw: refused, COTP rejected, closed port, silent peer', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim);
  sim.faults.refuseConnections = true;
  await assert.rejects(d.connect(), /closed|reset|socket/i);
  assert.equal(d.isConnected(), false);
  sim.faults.refuseConnections = false;
  sim.faults.rejectCotp = true;
  await assert.rejects(d.connect(), /rack\/slot/);
  sim.faults.rejectCotp = false;
  await d.connect();
  assert.equal(d.isConnected(), true);
  await d.close();

  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const d2 = makeDriver({ port: closedPort });
  await assert.rejects(d2.connect(), /ECONNREFUSED|socket error/);

  const held = new Set();
  const silent = net.createServer((s) => {
    held.add(s);
    s.on('error', () => {});
  });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const d3 = makeDriver({ port: silent.address().port }, { limits: { connectTimeoutMs: 200 } });
  const t0 = Date.now();
  await assert.rejects(d3.connect(), /COTP connect timed out/);
  assert.ok(Date.now() - t0 < 1500);
  for (const s of held) s.destroy();
  await new Promise((r) => silent.close(r));
});

test('a CPU that ignores SZL reads still connects (without identity)', async () => {
  const sim = await startSim(typeSimOptions(240));
  sim.faults.szlBlackhole = true;
  const d = makeDriver(sim, {
    tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }],
    limits: { requestDeadlineMs: 150, connectTimeoutMs: 1000 },
  });
  const info = await d.connect();
  assert.equal(info.identity, undefined);
  assert.equal(info.limits.pduSize, 240);
  assert.equal((await readAll(d)).i.v, -1234);
  const szlBefore = sim.stats.szlReads;
  await d.connect(); // remembered: no SZL attempt the second time
  assert.equal(sim.stats.szlReads, szlBefore);
  await d.close();
});

test('execute before connect and after close reports transport, never throws', async () => {
  const sim = await startSim(typeSimOptions(240));
  const d = makeDriver(sim, { tags: [{ key: 'i', address: 'DB10.DBW18', type: 'INT' }] });
  const res = await d.execute(d.plan()[0]);
  assert.deepEqual({ ok: res.ok, kind: res.kind, fatal: res.fatal }, { ok: false, kind: 'transport', fatal: true });
  await d.connect();
  await d.close();
  assert.equal(d.isConnected(), false);
  assert.equal((await d.execute(d.plan()[0])).kind, 'transport');
});

test('probe returns raw bytes and candidate decodings', async () => {
  const sim = await startSim(typeSimOptions(480));
  const d = makeDriver(sim);
  await d.connect();
  const p = await d.probe({ address: 'db10.dbd46' });
  assert.equal(p.address, 'DB10.DBD46');
  assert.equal(p.rawHex, '3fc00000');
  assert.equal(p.decodings.REAL, 1.5);
  const b = await d.probe({ address: 'DB10.DBX0.2' });
  assert.equal(b.decodings.BOOL, true);
  const s = await d.probe({ address: 'DB10.DBB62', length: 22 });
  assert.equal(s.decodings.STRING, 'Manifold');
  await assert.rejects(d.probe({ address: 'DB99.DBB0' }), /DB does not exist/);
  await assert.rejects(d.probe({ address: 'DB10.DBB0', length: 5000 }), RangeError);
  await assert.rejects(d.probe({ address: 'DB10,REAL8' }), /Siemens absolute notation/);
  await d.close();
});

test('concurrent executes are serialized (one job in flight)', async () => {
  const sim = await startSim(typeSimOptions(240));
  sim.faults.delayMs = 20;
  const d = makeDriver(sim, { tags: typeTags() });
  await d.connect();
  const results = await Promise.all(d.plan().map((r) => d.execute(r)));
  assert.ok(results.every((r) => r.ok));
  await d.close();
});

// ── describe / validateTag / config ────────────────────────────────────────

test('describe() advertises fields, presets and PUT/GET warning', () => {
  const desc = s7.describe();
  assert.equal(s7.protocol, 's7');
  assert.equal(desc.label, 'Siemens S7');
  assert.equal(desc.defaultPort, 102);
  const presets = desc.deviceFields.find((f) => f.name === 'presets').presets;
  assert.deepEqual(presets.map((p) => [p.rack, p.slot]), [[0, 2], [0, 1]]);
  assert.ok(desc.deviceFields.some((f) => f.name === 'remoteTsap' && f.optional));
  assert.ok(desc.deviceFields.some((f) => f.name === 'localTsap' && f.optional));
  assert.equal(desc.optionFields.find((f) => f.name === 'pduSize').default, 960);
  assert.equal(desc.optionFields.find((f) => f.name === 'maxGap').default, 8);
  assert.match(desc.prerequisites, /Optimized block access" OFF/);
  assert.match(desc.prerequisites, /Permit access with PUT\/GET/);
  assert.match(desc.prerequisites, /readable AND WRITABLE/);
  assert.match(desc.prerequisites, /OPC UA/);
  assert.ok(desc.tagTypes.some((t) => t.name === 'WSTRING' && t.needsLength));
  assert.match(desc.addressHelp, /DB10\.DBX0\.1/);
});

test('validateTag checks type/address agreement and normalizes', () => {
  const ok = s7.validateTag({ key: 'a', address: 'e0.1', type: 'bool' });
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.address, 'I0.1');
  assert.equal(s7.validateTag({ key: 'b', address: 'DB1.DBB4', type: 'REAL' }).normalized.address, 'DB1.DBD4');
  assert.equal(s7.validateTag({ key: 'c', address: 'DB1.DBB4', type: 'LREAL' }).normalized.length, 8);
  assert.equal(s7.validateTag({ key: 'd', address: 'DB1.DBB0', type: 'STRING', length: 30 }).normalized.length, 32);
  for (const [tag, re] of [
    [{ key: 'x', address: 'DB1.DBB0', type: 'BOOL' }, /bit address/],
    [{ key: 'x', address: 'DB1.DBX0.0', type: 'INT' }, /cannot use a bit address/],
    [{ key: 'x', address: 'DB1.DBW0', type: 'REAL' }, /W address holds 2 bytes/],
    [{ key: 'x', address: 'DB1.DBD0', type: 'INT' }, /D address holds 4 bytes/],
    [{ key: 'x', address: 'DB1.DBD0', type: 'STRING' }, /D address/],
    [{ key: 'x', address: 'DB1.DBB0', type: 'FLOAT' }, /unknown type/],
    [{ key: 'x', address: 'DB1.DBB0', type: 'STRING', length: 300 }, /length/],
    [{ key: 'x', address: 'T0', type: 'INT' }, /invalid S7 address/],
    [{ address: 'DB1.DBB0', type: 'BYTE' }, /key/],
  ]) {
    const r = s7.validateTag(tag);
    assert.equal(r.ok, false, JSON.stringify(tag));
    assert.match(r.error, re);
  }
});

test('createDriver: TSAP handling, invalid tags reported, rack/slot required', async () => {
  const sim = await startSim({ maxPdu: 240, dbs: { 1: Buffer.alloc(4) } });
  const d = makeDriver(sim, {
    rack: undefined,
    slot: undefined,
    remoteTsap: '03.01',
    tags: [
      { key: 'ok', address: 'DB1.DBW0', type: 'INT' },
      { key: 'bad', address: 'nope', type: 'INT' },
      { key: 'ok', address: 'DB1.DBW2', type: 'INT' },
    ],
  });
  assert.deepEqual(d.tagErrors.map((e) => e.key), ['bad', 'ok']);
  await d.connect();
  assert.equal(sim.stats.lastRemoteTsap, 0x0301);
  assert.equal(d.plan().length, 1);
  await d.close();
  assert.equal(s7.parseTsap('0x4d57'), 0x4d57);
  assert.equal(s7.parseTsap(0x0102), 0x0102);
  assert.throws(() => s7.parseTsap('zz'), /not a TSAP/);
  assert.throws(() => s7.createDriver({ host: 'h', tags: [] }), /rack and slot/);
  assert.throws(() => s7.createDriver({ host: 'h', rack: 0, slot: 2, options: { pduSize: 8 } }), RangeError);
  assert.equal(s7.createDriver({ host: 'h', rack: 0, slot: 2 }).capabilities.maxInFlight, 1);
});

// ── positive control: the simulator does count writes and control jobs ─────

test('simulator counts Write Var and PLC stop (positive control, raw socket)', async () => {
  const sim = createS7Simulator({ dbs: { 1: Buffer.alloc(4) } });
  const port = await sim.start();
  const sock = net.createConnection({ host: '127.0.0.1', port });
  sock.on('error', () => {});
  const frames = [];
  let buf = Buffer.alloc(0);
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= buf.readUInt16BE(2)) {
      frames.push(buf.subarray(0, buf.readUInt16BE(2)));
      buf = buf.subarray(buf.readUInt16BE(2));
    }
  });
  await new Promise((r) => sock.once('connect', r));
  const send = async (h, n) => {
    origWrite.call(sock, Buffer.from(h.replace(/\s/g, ''), 'hex'));
    await waitFor(() => frames.length >= n);
  };
  await send('0300 0016 11 e0 0000 0001 00 c0010a c1020100 c2020101', 1);
  await send('0300 0019 02f080 3201 0000 0001 0008 0000 f000 0001 0001 00f0', 2);
  // Write Var: DB1.DBB0, 1 byte = 0x5a
  await send('0300 0024 02f080 3201 0000 0002 000e 0005 0501 120a10 02 0001 0001 84 000000 0004 0008 5a', 3);
  // PLC stop (0x29)
  await send('0300 0021 02f080 3201 0000 0003 0010 0000 29 0000000000 09 505f50524f4752414d', 4);
  assert.equal(sim.stats.writesReceived, 1);
  assert.equal(sim.stats.controlReceived, 1);
  assert.equal(sim.memory.dbs.get(1)[0], 0x5a);
  sock.destroy();
  await sim.stop();
});
