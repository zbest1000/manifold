'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ModbusReadOnlyError,
  ModbusFramingError,
  encodeRequest,
  FrameParser,
  classifyException,
  matchResponse,
} = require('../drivers/modbus/frame');
const { parseAddress, formatAddress } = require('../drivers/modbus/address');
const { registerCount, decode, probeDecodings } = require('../drivers/modbus/decode');
const { planReads, bisect } = require('../drivers/modbus/planner');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

// ── frame: encoder ──────────────────────────────────────────────────────────

test('encodeRequest builds MBAP + PDU', () => {
  const buf = encodeRequest({ tid: 0x1234, unitId: 7, fc: 3, address: 0x0010, quantity: 2 });
  assert.deepEqual(buf, hex('1234 0000 0006 07 03 0010 0002'));
});

test('encodeRequest refuses every non-read function code and produces no bytes', () => {
  const forbidden = [0, 5, 6, 7, 8, 11, 12, 15, 16, 17, 20, 21, 22, 23, 24, 43, 0x81, 0x83, 255];
  for (const fc of forbidden) {
    let out;
    assert.throws(
      () => {
        out = encodeRequest({ tid: 1, unitId: 1, fc, address: 0, quantity: 1 });
      },
      ModbusReadOnlyError,
      `fc ${fc}`
    );
    assert.equal(out, undefined);
  }
  assert.throws(() => encodeRequest({ tid: 1, unitId: 1, fc: '3', address: 0, quantity: 1 }), ModbusReadOnlyError);
});

test('encodeRequest validates ranges', () => {
  const ok = { tid: 0, unitId: 0, fc: 3, address: 0, quantity: 125 };
  assert.doesNotThrow(() => encodeRequest(ok));
  assert.doesNotThrow(() => encodeRequest({ ...ok, tid: 65535, unitId: 255 }));
  assert.doesNotThrow(() => encodeRequest({ ...ok, fc: 1, quantity: 2000 }));
  assert.doesNotThrow(() => encodeRequest({ ...ok, address: 65535 - 124 }));
  for (const bad of [
    { quantity: 126 },
    { quantity: 0 },
    { fc: 1, quantity: 2001 },
    { fc: 2, quantity: 2001 },
    { fc: 4, quantity: 126 },
    { address: -1 },
    { address: 65536 },
    { address: 65535 - 123 },
    { fc: 1, address: 65000, quantity: 1000 },
    { unitId: 256 },
    { unitId: -1 },
    { tid: 65536 },
    { tid: 1.5 },
  ]) {
    assert.throws(() => encodeRequest({ ...ok, ...bad }), RangeError, JSON.stringify(bad));
  }
});

// ── frame: parser ───────────────────────────────────────────────────────────

const respA = hex('0001 0000 0007 01 03 04 0102 0304');
const respB = hex('0002 0000 0003 01 83 02');

test('FrameParser reassembles byte-by-byte input', () => {
  const p = new FrameParser();
  const out = [];
  for (const b of Buffer.concat([respA, respB])) out.push(...p.push(Buffer.from([b])));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { tid: 1, unitId: 1, fc: 3, data: hex('04 0102 0304') });
  assert.deepEqual(out[1], { tid: 2, unitId: 1, fc: 0x83, data: hex('02') });
});

test('FrameParser splits merged frames and handles a trailing partial', () => {
  const p = new FrameParser();
  const merged = Buffer.concat([respA, respB, respA.subarray(0, 5)]);
  assert.equal(p.push(merged).length, 2);
  assert.equal(p.push(respA.subarray(5)).length, 1);
});

test('FrameParser rejects bad protocol id and bad length, and stays failed', () => {
  assert.throws(() => new FrameParser().push(hex('0001 0001 0003 01 03 00')), ModbusFramingError);
  for (const len of ['0000', '0001', '00ff', '0100']) {
    assert.throws(() => new FrameParser().push(hex(`0001 0000 ${len}`)), ModbusFramingError, len);
  }
  const p = new FrameParser();
  assert.throws(() => p.push(hex('0001 0009 0003')), ModbusFramingError);
  assert.throws(() => p.push(respA), ModbusFramingError);
});

test('FrameParser accepts the length extremes 2 and 254', () => {
  const p = new FrameParser();
  assert.equal(p.push(hex('0001 0000 0002 01 03')).length, 1);
  const big = Buffer.concat([hex('0001 0000 00fe 01 03'), Buffer.alloc(252)]);
  assert.equal(p.push(big)[0].data.length, 252);
});

// ── frame: matchResponse ────────────────────────────────────────────────────

const req = { tid: 1, unitId: 1, fc: 3, quantity: 2 };

test('matchResponse returns data for a valid register response', () => {
  const r = matchResponse(req, { tid: 1, unitId: 1, fc: 3, data: hex('04 0102 0304') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, hex('0102 0304'));
});

test('matchResponse checks bit byte count as ceil(q/8)', () => {
  const bits = { tid: 9, unitId: 1, fc: 1, quantity: 9 };
  assert.equal(matchResponse(bits, { tid: 9, unitId: 1, fc: 1, data: hex('02 ff 01') }).ok, true);
  assert.equal(matchResponse(bits, { tid: 9, unitId: 1, fc: 1, data: hex('01 ff') }).kind, 'mismatch');
});

test('matchResponse reports exceptions with names', () => {
  const r = matchResponse(req, { tid: 1, unitId: 1, fc: 0x83, data: hex('02') });
  assert.deepEqual(r, { ok: false, kind: 'exception', code: 2, name: 'illegal data address' });
  assert.equal(matchResponse(req, { tid: 1, unitId: 1, fc: 0x83, data: hex('0b') }).name, 'gateway target device failed to respond');
  assert.match(matchResponse(req, { tid: 1, unitId: 1, fc: 0x83, data: hex('7f') }).name, /unknown/);
});

test('matchResponse flags every kind of mismatch', () => {
  const good = { tid: 1, unitId: 1, fc: 3, data: hex('04 0102 0304') };
  const cases = {
    'wrong tid': { ...good, tid: 2 },
    'wrong unit': { ...good, unitId: 2 },
    'wrong fc': { ...good, fc: 4 },
    'exception for another fc': { ...good, fc: 0x84, data: hex('02') },
    'byte count too small': { ...good, data: hex('02 0102') },
    'byte count lies': { ...good, data: hex('04 0102 03') },
    'payload longer than count': { ...good, data: hex('04 0102 0304 05') },
    'empty payload': { ...good, data: Buffer.alloc(0) },
    'exception with extra bytes': { ...good, fc: 0x83, data: hex('0202') },
  };
  for (const [name, adu] of Object.entries(cases)) {
    const r = matchResponse(req, adu);
    assert.equal(r.kind, 'mismatch', name);
    assert.equal(typeof r.reason, 'string');
  }
});

test('classifyException', () => {
  const expected = {
    1: 'permanent',
    2: 'permanent',
    3: 'permanent',
    4: 'retry',
    5: 'retry',
    6: 'retry',
    0x0a: 'gateway',
    0x0b: 'unit-down',
    0x42: 'permanent',
  };
  for (const [code, cls] of Object.entries(expected)) assert.equal(classifyException(Number(code)), cls, code);
});

// ── address ─────────────────────────────────────────────────────────────────

test('parseAddress explicit forms', () => {
  assert.deepEqual(parseAddress('holding:100'), { table: 'holding', offset: 100, fc: 3 });
  assert.deepEqual(parseAddress('input:0'), { table: 'input', offset: 0, fc: 4 });
  assert.deepEqual(parseAddress('coil:5'), { table: 'coil', offset: 5, fc: 1 });
  assert.deepEqual(parseAddress('Discrete:12'), { table: 'discrete', offset: 12, fc: 2 });
  assert.equal(parseAddress('holding:100', { base: 1 }).offset, 99);
  assert.throws(() => parseAddress('holding:0', { base: 1 }), /outside/);
  assert.throws(() => parseAddress('holding:65536'), /outside/);
  assert.throws(() => parseAddress('register:1'), /unknown table/);
});

test('parseAddress Modicon 5- and 6-digit', () => {
  assert.deepEqual(parseAddress('40001'), { table: 'holding', offset: 0, fc: 3 });
  assert.deepEqual(parseAddress('400001'), { table: 'holding', offset: 0, fc: 3 });
  assert.equal(parseAddress('49999').offset, 9998);
  assert.equal(parseAddress('465536').offset, 65535);
  assert.equal(parseAddress('30010').table, 'input');
  assert.equal(parseAddress('100001').table, 'discrete');
  assert.equal(parseAddress('00005').table, 'coil');
  assert.equal(parseAddress('000005').offset, 4);
  assert.equal(parseAddress('40001', { base: 1 }).offset, 0, 'base never alters Modicon');
});

test('parseAddress rejects ambiguous or invalid input', () => {
  for (const bad of ['100', '1', '4001', '1234567', '50001', '600001', '20001', '40000', '400000', '465537', '', 'abc', 'holding', 'holding:-1', '4000x1']) {
    assert.throws(() => parseAddress(bad), Error, bad);
  }
  assert.throws(() => parseAddress('100'), /ambiguous/);
});

test('formatAddress round-trips', () => {
  const a = parseAddress('400101');
  assert.equal(formatAddress(a), 'holding:100');
  assert.equal(formatAddress(a, { base: 1 }), 'holding:101');
  assert.deepEqual(parseAddress(formatAddress(a)), a);
});

// ── decode ──────────────────────────────────────────────────────────────────

const ORDERS = {
  ABCD: { byteOrder: 'big', wordOrder: 'big' },
  CDAB: { byteOrder: 'big', wordOrder: 'little' },
  BADC: { byteOrder: 'little', wordOrder: 'big' },
  DCBA: { byteOrder: 'little', wordOrder: 'little' },
};

test('float32 123456.0 under all four orders', () => {
  // IEEE 754: 123456.0 = 0x47F12000
  const wire = { ABCD: '47F1 2000', CDAB: '2000 47F1', BADC: 'F147 0020', DCBA: '0020 F147' };
  for (const [name, bytes] of Object.entries(wire)) {
    assert.equal(decode({ type: 'float32', ...ORDERS[name] }, hex(bytes)).v, 123456, name);
  }
});

test('int32 / uint32 under all four orders', () => {
  // 0x01020304 = 16909060 ; -2 = 0xFFFFFFFE
  const wire = { ABCD: '0102 0304', CDAB: '0304 0102', BADC: '0201 0403', DCBA: '0403 0201' };
  for (const [name, bytes] of Object.entries(wire)) {
    assert.equal(decode({ type: 'int32', ...ORDERS[name] }, hex(bytes)).v, 16909060, name);
    assert.equal(decode({ type: 'uint32', ...ORDERS[name] }, hex(bytes)).v, 16909060, name);
  }
  assert.equal(decode({ type: 'int32' }, hex('FFFF FFFE')).v, -2);
  assert.equal(decode({ type: 'uint32' }, hex('FFFF FFFE')).v, 4294967294);
  assert.equal(decode({ type: 'int32', wordOrder: 'little' }, hex('FFFE FFFF')).v, -2);
});

test('int16 / uint16 and byte order', () => {
  assert.equal(decode({ type: 'int16' }, hex('FF38')).v, -200);
  assert.equal(decode({ type: 'uint16' }, hex('FF38')).v, 65336);
  assert.equal(decode({ type: 'uint16', byteOrder: 'little' }, hex('3412')).v, 0x1234);
  assert.equal(decode({ type: 'int16', byteOrder: 'little', wordOrder: 'little' }, hex('38FF')).v, -200);
});

test('64-bit integers are BigInt under all four orders', () => {
  const be = '0102 0304 0506 0708';
  const wire = {
    ABCD: be,
    CDAB: '0708 0506 0304 0102',
    BADC: '0201 0403 0605 0807',
    DCBA: '0807 0605 0403 0201',
  };
  for (const [name, bytes] of Object.entries(wire)) {
    assert.equal(decode({ type: 'uint64', ...ORDERS[name] }, hex(bytes)).v, 0x0102030405060708n, name);
    assert.equal(decode({ type: 'int64', ...ORDERS[name] }, hex(bytes)).v, 0x0102030405060708n, name);
  }
  assert.equal(decode({ type: 'uint64' }, hex('FFFF FFFF FFFF FFFF')).v, 18446744073709551615n);
  assert.equal(decode({ type: 'int64' }, hex('FFFF FFFF FFFF FFFF')).v, -1n);
  assert.equal(decode({ type: 'int64', scale: 10, offset: 5 }, hex('0000 0000 0000 0002')).v, 2n, 'scale ignores BigInt');
});

test('float64 under all four orders', () => {
  // 1.5 = 0x3FF8000000000000
  const wire = {
    ABCD: '3FF8 0000 0000 0000',
    CDAB: '0000 0000 0000 3FF8',
    BADC: 'F83F 0000 0000 0000',
    DCBA: '0000 0000 0000 F83F',
  };
  for (const [name, bytes] of Object.entries(wire)) {
    assert.equal(decode({ type: 'float64', ...ORDERS[name] }, hex(bytes)).v, 1.5, name);
  }
});

test('bool from coil bit and from register bit', () => {
  assert.deepEqual(decode({ type: 'bool' }, hex('01')), { v: true, type: 'bool' });
  assert.equal(decode({ type: 'bool' }, hex('00')).v, false);
  assert.equal(decode({ type: 'bool', bit: 0 }, hex('0001')).v, true);
  assert.equal(decode({ type: 'bool', bit: 15 }, hex('8000')).v, true);
  assert.equal(decode({ type: 'bool', bit: 8 }, hex('0100')).v, true);
  assert.equal(decode({ type: 'bool', bit: 7 }, hex('0100')).v, false);
  assert.equal(decode({ type: 'bool', bit: 0, byteOrder: 'little' }, hex('0100')).v, true);
  assert.throws(() => decode({ type: 'bool', bit: 16 }, hex('0000')), RangeError);
});

test('string: length, padding and byte swap', () => {
  const tag = { type: 'string', length: 3 };
  assert.equal(registerCount(tag), 3);
  assert.equal(decode(tag, Buffer.from('ABCDE\0')).v, 'ABCDE');
  assert.equal(decode(tag, Buffer.from('AB  \0\0')).v, 'AB');
  assert.equal(decode({ type: 'string', length: 2, byteOrder: 'little' }, Buffer.from('BADC')).v, 'ABCD');
  assert.throws(() => registerCount({ type: 'string' }), /length/);
});

test('scale, offset and sentinels', () => {
  assert.equal(decode({ type: 'int16', scale: 0.1, offset: -5 }, hex('0064')).v, 5);
  assert.deepEqual(decode({ type: 'int16', sentinels: [-32768] }, hex('8000')), { v: null, type: 'int16', unavailable: true });
  assert.deepEqual(decode({ type: 'uint16', sentinels: [0xffff, 0x7fff], scale: 2 }, hex('7FFF')), {
    v: null,
    type: 'uint16',
    unavailable: true,
  });
  assert.equal(decode({ type: 'uint16', sentinels: [0xffff] }, hex('0001')).unavailable, undefined);
  assert.equal(decode({ type: 'uint64', sentinels: [-1] }, hex('FFFF FFFF FFFF FFFF')).unavailable, undefined);
  assert.equal(decode({ type: 'int64', sentinels: [-1] }, hex('FFFF FFFF FFFF FFFF')).unavailable, true);
});

test('registerCount and input validation', () => {
  const counts = { bool: 1, int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, int64: 4, uint64: 4, float64: 4 };
  for (const [type, n] of Object.entries(counts)) assert.equal(registerCount({ type }), n, type);
  assert.throws(() => registerCount({ type: 'decimal' }), /unknown type/);
  assert.throws(() => decode({ type: 'int32' }, hex('0102')), RangeError);
});

test('probeDecodings shows every order', () => {
  const p = probeDecodings(hex('47F1 2000'));
  assert.equal(p.ABCD.float32, 123456);
  assert.equal(p.ABCD.uint32, 0x47f12000);
  assert.equal(p.ABCD.uint16, 0x47f1);
  assert.equal(p.CDAB.uint32, 0x200047f1);
  assert.equal(p.BADC.uint16, 0xf147);
  assert.equal(p.DCBA.uint32, 0x0020f147);
  assert.deepEqual(Object.keys(probeDecodings(hex('0001'))).sort(), ['ABCD', 'BADC', 'CDAB', 'DCBA']);
  assert.equal(probeDecodings(hex('0001')).ABCD.int32, undefined);
});

// ── planner ─────────────────────────────────────────────────────────────────

const tag = (id, table, offset, count = 1) => ({ id, table, offset, count });

test('planReads coalesces adjacent and overlapping ranges per table', () => {
  const plan = planReads([tag('a', 'holding', 10, 2), tag('b', 'holding', 12), tag('c', 'holding', 11, 2), tag('d', 'input', 10)]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], {
    fc: 3,
    table: 'holding',
    address: 10,
    quantity: 3,
    items: [
      { id: 'a', start: 0, count: 2 },
      { id: 'c', start: 1, count: 2 },
      { id: 'b', start: 2, count: 1 },
    ],
  });
  assert.equal(plan[1].fc, 4);
});

test('planReads does not bridge gaps by default, bridges up to maxGap', () => {
  const tags = [tag('a', 'holding', 0), tag('b', 'holding', 2), tag('c', 'holding', 10)];
  assert.equal(planReads(tags).length, 3);
  assert.deepEqual(planReads(tags, { maxGap: 1 }).map((r) => r.quantity), [3, 1]);
  assert.equal(planReads(tags, { maxGap: 7 }).length, 1);
});

test('planReads never crosses an unmapped range', () => {
  const tags = [tag('a', 'holding', 0), tag('b', 'holding', 5)];
  const unmapped = [{ table: 'holding', from: 2, to: 2 }];
  assert.equal(planReads(tags, { maxGap: 10, unmapped }).length, 2);
  assert.equal(planReads(tags, { maxGap: 10, unmapped: [{ table: 'input', from: 2, to: 2 }] }).length, 1);
  assert.equal(planReads(tags, { maxGap: 10, unmapped: [{ table: 'holding', from: 5, to: 9 }] }).length, 1, 'range outside the gap');
});

test('planReads respects per-table maxima and rejects oversized tags', () => {
  const regs = Array.from({ length: 10 }, (_, i) => tag(`r${i}`, 'holding', i * 4, 4));
  assert.deepEqual(planReads(regs, { maxRegisters: 16 }).map((r) => r.quantity), [16, 16, 8]);
  const bits = Array.from({ length: 5 }, (_, i) => tag(`b${i}`, 'coil', i));
  assert.deepEqual(planReads(bits, { maxBits: 2 }).map((r) => r.quantity), [2, 2, 1]);
  assert.throws(() => planReads([tag('big', 'holding', 0, 126)]), /big.*cannot be read atomically/);
  assert.throws(() => planReads([tag('big', 'coil', 0, 2001)]), /cannot be read atomically/);
  assert.throws(() => planReads([tag('x', 'holding', 65535, 2)]), /invalid range/);
  assert.throws(() => planReads([tag('x', 'bogus', 0)]), /unknown table/);
});

/** mulberry32: small deterministic PRNG for the property test. */
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('planReads invariants hold for random inputs (fixed seed)', () => {
  const rnd = prng(0xc0ffee);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const tables = ['coil', 'discrete', 'holding', 'input'];

  for (let round = 0; round < 300; round++) {
    const limits = { maxRegisters: int(4, 125), maxBits: int(8, 2000), maxGap: int(0, 6), unmapped: [] };
    for (let i = 0; i < int(0, 6); i++) {
      const from = int(0, 300);
      limits.unmapped.push({ table: tables[int(0, 3)], from, to: from + int(0, 10) });
    }
    const tags = [];
    for (let i = 0; i < int(1, 40); i++) {
      const t = { id: `t${i}`, table: tables[int(0, 3)], offset: int(0, 300), count: int(1, 4) };
      const clash = limits.unmapped.some((u) => u.table === t.table && u.from < t.offset + t.count && u.to >= t.offset);
      if (!clash) tags.push(t);
    }
    const plan = planReads(tags, limits);

    const seen = new Map();
    for (const r of plan) {
      const max = r.table === 'coil' || r.table === 'discrete' ? limits.maxBits : limits.maxRegisters;
      assert.ok(r.quantity >= 1 && r.quantity <= max, 'within limits');
      assert.ok(r.address + r.quantity <= 65536);
      for (const u of limits.unmapped.filter((x) => x.table === r.table)) {
        assert.ok(u.to < r.address || u.from >= r.address + r.quantity, 'unmapped range crossed');
      }
      const covered = new Array(r.quantity).fill(false);
      for (const it of r.items) {
        seen.set(it.id, (seen.get(it.id) || 0) + 1);
        const src = tags.find((t) => t.id === it.id);
        assert.equal(src.table, r.table);
        assert.equal(r.address + it.start, src.offset);
        assert.equal(it.count, src.count);
        assert.ok(it.start + it.count <= r.quantity);
        for (let k = 0; k < it.count; k++) covered[it.start + k] = true;
      }
      let run = 0;
      for (const c of covered) {
        run = c ? 0 : run + 1;
        assert.ok(run <= limits.maxGap, 'gap wider than maxGap bridged');
      }
    }
    assert.equal(seen.size, tags.length);
    for (const n of seen.values()) assert.equal(n, 1, 'tag in exactly one request');
  }
});

test('bisect splits items and rebases halves', () => {
  const [req1] = planReads([tag('a', 'holding', 100), tag('b', 'holding', 101, 2), tag('c', 'holding', 103), tag('d', 'holding', 104)]);
  const [left, right] = bisect(req1);
  assert.deepEqual(left, {
    fc: 3,
    table: 'holding',
    address: 100,
    quantity: 3,
    items: [
      { id: 'a', start: 0, count: 1 },
      { id: 'b', start: 1, count: 2 },
    ],
  });
  assert.deepEqual(right, {
    fc: 3,
    table: 'holding',
    address: 103,
    quantity: 2,
    items: [
      { id: 'c', start: 0, count: 1 },
      { id: 'd', start: 1, count: 1 },
    ],
  });
  assert.equal(bisect(left).length, 2);
  assert.equal(bisect(bisect(left)[0]), null);
  const odd = planReads([tag('a', 'coil', 0), tag('b', 'coil', 1), tag('c', 'coil', 2)])[0];
  assert.deepEqual(bisect(odd).map((r) => r.items.length), [2, 1]);
});
