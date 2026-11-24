'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const frame = require('../drivers/s7/frame');
const {
  AREA,
  S7ReadOnlyError,
  S7FramingError,
  S7MismatchError,
  remoteTsapFor,
  encodeConnectRequest,
  encodeS7Frame,
  TpktParser,
  parseS7Pdu,
  parseSetupCommResponse,
  parseReadVarResponse,
  parseSzlResponse,
  explainItemCode,
  explainHeaderError,
  readRequestSize,
} = frame;
const { parseAddress, formatAddress } = require('../drivers/s7/address');
const { byteLength, decode, probeDecodings, normalizeType, S7DecodeError } = require('../drivers/s7/decode');
const { planReads, bisect, limitsFor } = require('../drivers/s7/planner');

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

// ── frame: connect + encoder golden vectors ────────────────────────────────

test('remote TSAP from rack/slot follows (type << 8) | rack*0x20 + slot', () => {
  assert.equal(remoteTsapFor(0, 2), 0x0102);
  assert.equal(remoteTsapFor(0, 1), 0x0101);
  assert.equal(remoteTsapFor(1, 3), 0x0123);
  assert.equal(remoteTsapFor(0, 2, 'op'), 0x0202);
  assert.throws(() => remoteTsapFor(8, 0), RangeError);
  assert.throws(() => remoteTsapFor(0, 32), RangeError);
  assert.throws(() => remoteTsapFor(0, 1, 'x'), RangeError);
});

test('COTP connection request golden vector (rack 0 slot 2)', () => {
  assert.deepEqual(
    encodeConnectRequest({ localTsap: 0x0100, remoteTsap: 0x0102 }),
    hex('0300 0016 11 e0 0000 0001 00 c0010a c1020100 c2020102')
  );
});

test('setup communication golden vector', () => {
  assert.deepEqual(
    encodeS7Frame({ type: 'job', func: 0xf0, pduRef: 0x0400, pduSize: 480, maxAmqCalling: 1, maxAmqCalled: 1 }),
    hex('0300 0019 02f080 3201 0000 0400 0008 0000 f000 0001 0001 01e0')
  );
});

test('Read Var golden vector: two items, DB and M', () => {
  const buf = encodeS7Frame({
    type: 'job',
    func: 0x04,
    pduRef: 1,
    items: [
      { area: AREA.DB, db: 1, start: 0, length: 4 },
      { area: AREA.M, db: 0, start: 10, length: 2 },
    ],
  });
  assert.deepEqual(
    buf,
    hex(
      '0300 002b 02f080 3201 0000 0001 001a 0000 0402' +
        '120a10 02 0004 0001 84 000000' +
        '120a10 02 0002 0000 83 000050'
    )
  );
  assert.equal(buf.length - 7, readRequestSize(2));
});

test('SZL read golden vector', () => {
  assert.deepEqual(
    encodeS7Frame({ type: 'userdata', group: 4, subfunction: 1, pduRef: 5, szlId: 0x0424, szlIndex: 0 }),
    hex('0300 0021 02f080 3207 0000 0005 0008 0008 0001120411440100 ff09 0004 0424 0000')
  );
});

test('encoder validates fields of allowed jobs', () => {
  const ok = { type: 'job', func: 4, pduRef: 1, items: [{ area: AREA.DB, db: 1, start: 0, length: 1 }] };
  assert.doesNotThrow(() => encodeS7Frame(ok));
  const bad = [
    { items: [] },
    { items: new Array(21).fill({ area: AREA.DB, db: 1, start: 0, length: 1 }) },
    { items: [{ area: 0x99, db: 1, start: 0, length: 1 }] },
    { items: [{ area: AREA.DB, db: 0, start: 0, length: 1 }] },
    { items: [{ area: AREA.M, db: 3, start: 0, length: 1 }] },
    { items: [{ area: AREA.DB, db: 1, start: 0x200000, length: 1 }] },
    { items: [{ area: AREA.DB, db: 1, start: 0, length: 0 }] },
    { pduRef: 0x10000 },
    { maxPdu: 20 },
  ];
  for (const b of bad) assert.throws(() => encodeS7Frame({ ...ok, ...b }), RangeError, JSON.stringify(b).slice(0, 60));
});

test('every non-read S7 service is refused before any bytes exist', () => {
  const forbidden = [
    { type: 'job', func: 0x05, pduRef: 1, items: [{ area: AREA.DB, db: 1, start: 0, length: 1 }], data: [1] }, // Write Var
    { type: 'job', func: 0x28, pduRef: 1 }, // PLC control (start, compress, copy RAM→ROM …)
    { type: 'job', func: 0x29, pduRef: 1 }, // PLC stop
    ...[0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f].map((func) => ({ type: 'job', func, pduRef: 1 })), // download / upload
    ...[0x00, 0x01, 0x03, 0x06, 0xf1, 0xff, -1, '0x04', '4', null, undefined].map((func) => ({ type: 'job', func, pduRef: 1 })),
    { type: 'userdata', group: 0x1, subfunction: 0x01, pduRef: 1 }, // programmer commands (force, …)
    { type: 'userdata', group: 0x4, subfunction: 0x02, pduRef: 1 }, // message service
    { type: 'userdata', group: 0x7, subfunction: 0x04, pduRef: 1 }, // set clock
    { type: 'userdata', group: 0x3, subfunction: 0x01, pduRef: 1 }, // block functions
    { type: 'userdata', group: 0x5, subfunction: 0x01, pduRef: 1 }, // security
    { type: 'ack', func: 0x04, pduRef: 1 },
    { type: 'ack_data', func: 0x04, pduRef: 1 },
    { type: 'JOB', func: 0x04, pduRef: 1 },
    { func: 0x04, pduRef: 1 },
    null,
    undefined,
    'readVar',
  ];
  // Spy on Buffer allocation: a refused job must not allocate any frame bytes.
  const orig = { alloc: Buffer.alloc, from: Buffer.from, concat: Buffer.concat };
  let allocations = 0;
  Buffer.alloc = (...a) => (allocations++, orig.alloc(...a));
  Buffer.from = (...a) => (allocations++, orig.from(...a));
  Buffer.concat = (...a) => (allocations++, orig.concat(...a));
  try {
    for (const job of forbidden) {
      let out;
      assert.throws(
        () => {
          out = encodeS7Frame(job);
        },
        S7ReadOnlyError,
        JSON.stringify(job)
      );
      assert.equal(out, undefined);
    }
  } finally {
    Object.assign(Buffer, orig);
  }
  assert.equal(allocations, 0);
});

test('read-only error names the refused service', () => {
  assert.throws(() => encodeS7Frame({ type: 'job', func: 0x05, pduRef: 1 }), /job function 0x05 is refused: this driver is read-only/);
  assert.throws(() => encodeS7Frame({ type: 'userdata', group: 7, subfunction: 4, pduRef: 1 }), /userdata group 0x07 subfunction 0x04/);
});

// ── frame: streaming parser ────────────────────────────────────────────────

const CC = hex('0300 0016 11 d0 0001 0001 00 c0010a c1020100 c2020102');
const SETUP_ACK = hex('0300 001b 02f080 3203 0000 0001 0008 0000 0000 f000 0001 0001 00f0');

test('parser handles CC + DT delivered byte by byte, then merged', () => {
  const stream = Buffer.concat([CC, SETUP_ACK, CC]);
  const p = new TpktParser();
  const got = [];
  for (const b of stream) got.push(...p.push(Buffer.from([b])));
  assert.equal(got.length, 3);
  assert.equal(got[0].type, 'CC');
  assert.deepEqual(got[0].params, { tpduSize: 1024, srcTsap: 0x0100, dstTsap: 0x0102 });
  assert.equal(got[1].type, 'DT');
  const pdu = parseS7Pdu(got[1].data);
  assert.equal(pdu.rosctr, 3);
  assert.equal(pdu.pduRef, 1);
  assert.deepEqual(parseSetupCommResponse(pdu), { maxAmqCalling: 1, maxAmqCalled: 1, pduSize: 240 });

  const p2 = new TpktParser();
  assert.equal(p2.push(Buffer.concat([stream, stream])).length, 6);
});

test('parser splits at every possible boundary', () => {
  const stream = Buffer.concat([CC, SETUP_ACK]);
  for (let cut = 1; cut < stream.length; cut++) {
    const p = new TpktParser();
    const got = [...p.push(stream.subarray(0, cut)), ...p.push(stream.subarray(cut))];
    assert.equal(got.length, 2, `cut ${cut}`);
  }
});

test('parser reassembles COTP DT fragments (EOT clear)', () => {
  const s7 = SETUP_ACK.subarray(7);
  const frag1 = Buffer.concat([hex('0300'), Buffer.from([0, 7 + 5]), hex('02f000'), s7.subarray(0, 5)]);
  const rest = s7.subarray(5);
  const frag2 = Buffer.concat([hex('0300'), Buffer.from([0, 7 + rest.length]), hex('02f080'), rest]);
  const p = new TpktParser();
  assert.deepEqual(p.push(frag1), []);
  const [m] = p.push(frag2);
  assert.deepEqual(m.data, s7);
});

test('parser reports DR / ER as messages', () => {
  const p = new TpktParser();
  const [m] = p.push(hex('0300 000b 06 80 0001 0001 00'));
  assert.equal(m.type, 'DR');
});

test('fatal framing errors poison the parser', () => {
  const cases = [
    hex('0400 0016'), // TPKT version 4
    hex('0300 0005 00'), // length too short
    hex('0300 0007 09 f080'), // LI larger than the TPDU
    hex('0300 0008 03 f08000'), // DT with LI 3
    hex('0300 0007 02 1080'), // unknown COTP type
  ];
  for (const bad of cases) {
    const p = new TpktParser();
    assert.throws(() => p.push(bad), S7FramingError, bad.toString('hex'));
    assert.throws(() => p.push(CC), S7FramingError, 'poisoned');
  }
  const p = new TpktParser({ maxPduBytes: 8 });
  assert.throws(() => p.push(SETUP_ACK), /exceeds 8 bytes/);
});

test('parseS7Pdu rejects bad protocol id, ROSCTR and inconsistent lengths', () => {
  const good = SETUP_ACK.subarray(7);
  assert.doesNotThrow(() => parseS7Pdu(good));
  const badId = Buffer.from(good);
  badId[0] = 0x72; // S7CommPlus
  assert.throws(() => parseS7Pdu(badId), S7FramingError);
  const badRosctr = Buffer.from(good);
  badRosctr[1] = 9;
  assert.throws(() => parseS7Pdu(badRosctr), S7FramingError);
  assert.throws(() => parseS7Pdu(good.subarray(0, good.length - 1)), /disagree/);
  assert.throws(() => parseS7Pdu(good.subarray(0, 5)), S7FramingError);
});

// ── frame: Read Var response ───────────────────────────────────────────────

function readAck(ref, count, data) {
  const h = Buffer.alloc(14);
  h[0] = 0x32;
  h[1] = 3;
  h.writeUInt16BE(ref, 4);
  h.writeUInt16BE(2, 6);
  h.writeUInt16BE(data.length, 8);
  h[12] = 4;
  h[13] = count;
  return parseS7Pdu(Buffer.concat([h, data]));
}

test('Read Var response: fill byte after odd items, per-item return codes', () => {
  const data = hex(
    'ff04 0018 aabbcc 00' + // 3 bytes (24 bits) + fill
      '0a00 0000' + // object does not exist
      '0500 0000' + // out of range
      'ff04 0010 1122' + // 2 bytes
      'ff09 0001 77' // octet string, length in bytes, last item: no fill
  );
  const items = [{ length: 3 }, { length: 4 }, { length: 2 }, { length: 2 }, { length: 1 }];
  const out = parseReadVarResponse(readAck(1, 5, data), items);
  assert.deepEqual(out[0], { ok: true, data: hex('aabbcc') });
  assert.deepEqual(out[1], { ok: false, code: 0x0a, name: 'object does not exist' });
  assert.equal(out[2].code, 0x05);
  assert.deepEqual(out[3].data, hex('1122'));
  assert.deepEqual(out[4].data, hex('77'));
});

test('Read Var response mismatches are detected', () => {
  const one = hex('ff04 0010 1122');
  assert.throws(() => parseReadVarResponse(readAck(1, 2, one), [{ length: 2 }]), S7MismatchError); // count
  assert.throws(() => parseReadVarResponse(readAck(1, 1, one), [{ length: 4 }]), /returned 2 bytes, requested 4/);
  assert.throws(() => parseReadVarResponse(readAck(1, 1, hex('ff04 0020 1122')), [{ length: 4 }]), /overruns/);
  assert.throws(() => parseReadVarResponse(readAck(1, 1, Buffer.concat([one, hex('00')])), [{ length: 2 }]), /trailing/);
  assert.throws(() => parseReadVarResponse(readAck(1, 2, one), [{ length: 2 }, { length: 2 }]), /truncated/);
  const setup = parseS7Pdu(SETUP_ACK.subarray(7));
  assert.throws(() => parseReadVarResponse(setup, [{ length: 2 }]), S7MismatchError);
});

test('item return codes and header errors read as operator language', () => {
  assert.equal(explainItemCode(0x05, 'DB'), 'DB shorter than the requested range');
  assert.equal(explainItemCode(0x0a, 'DB'), 'DB does not exist');
  assert.match(explainItemCode(0x03, 'DB'), /PUT\/GET not permitted, optimized block access enabled, or protection level too high/);
  assert.match(explainItemCode(0x05, 'M'), /end of the M area/);
  const e = explainHeaderError(0x81, 0x04);
  assert.equal(e.code, 0x8104);
  assert.equal(e.classification, 'permanent');
  assert.match(e.message, /PUT\/GET not permitted/);
  assert.equal(explainHeaderError(0x83, 0x04).classification, 'retry');
  assert.match(explainHeaderError(0x85, 0x00).message, /PDU/);
});

test('SZL response parsing', () => {
  const rec = Buffer.alloc(20);
  rec[3] = 0x08;
  const body = Buffer.concat([hex('0424 0000 0014 0001'), rec]);
  const data = Buffer.concat([hex('ff09'), Buffer.from([0, body.length]), body]);
  const param = hex('000112081284010100000000');
  const h = Buffer.alloc(10);
  h[0] = 0x32;
  h[1] = 7;
  h.writeUInt16BE(9, 4);
  h.writeUInt16BE(param.length, 6);
  h.writeUInt16BE(data.length, 8);
  const r = parseSzlResponse(parseS7Pdu(Buffer.concat([h, param, data])));
  assert.equal(r.szlId, 0x0424);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0][3], 8);
  assert.equal(r.more, false);

  const errParam = hex('00011208128401010000d401');
  const errData = hex('0a000000');
  h.writeUInt16BE(errData.length, 8);
  assert.throws(() => parseSzlResponse(parseS7Pdu(Buffer.concat([h, errParam, errData]))), (e) => e.code === 0xd401);
});

// ── address ────────────────────────────────────────────────────────────────

test('parseAddress: DB forms', () => {
  assert.deepEqual(parseAddress('DB10.DBX0.1'), { area: 'DB', areaCode: 0x84, db: 10, byteOffset: 0, bitOffset: 1, size: 'X' });
  assert.deepEqual(parseAddress('db10.dbb2'), { area: 'DB', areaCode: 0x84, db: 10, byteOffset: 2, bitOffset: null, size: 'B' });
  assert.equal(parseAddress('DB10.DBW4').size, 'W');
  assert.equal(parseAddress(' DB65535.DBD8 ').db, 65535);
});

test('parseAddress: M, I/E, Q/A forms', () => {
  assert.deepEqual(parseAddress('M0.1'), { area: 'M', areaCode: 0x83, db: 0, byteOffset: 0, bitOffset: 1, size: 'X' });
  assert.equal(parseAddress('MX3.7').bitOffset, 7);
  assert.deepEqual(parseAddress('MB0'), { area: 'M', areaCode: 0x83, db: 0, byteOffset: 0, bitOffset: null, size: 'B' });
  assert.equal(parseAddress('MW2').size, 'W');
  assert.equal(parseAddress('MD4').size, 'D');
  assert.equal(parseAddress('I0.0').area, 'I');
  assert.equal(parseAddress('E1.2').area, 'I');
  assert.equal(parseAddress('EW2').areaCode, 0x81);
  assert.equal(parseAddress('IB3').byteOffset, 3);
  assert.equal(parseAddress('Q0.0').area, 'Q');
  assert.equal(parseAddress('A1.3').area, 'Q');
  assert.equal(parseAddress('AB0').areaCode, 0x82);
  assert.equal(parseAddress('QD4').size, 'D');
});

test('parseAddress rejects malformed input with guidance', () => {
  for (const bad of ['', 'DB0.DBX0.0', 'DB65536.DBB0', 'DB1.DBX0', 'DB1.DBX0.8', 'DB1.DBB0.1', 'M0', 'MW2.1', 'T0', 'C1',
    'DB1.DBB2097152', 'DB1,REAL8', '40001', 'Z0.0', 12]) {
    assert.throws(() => parseAddress(bad), /invalid S7 address.*Siemens absolute notation/, String(bad));
  }
});

test('formatAddress round-trips to canonical English form', () => {
  for (const [input, canon] of [
    ['db10.dbx0.1', 'DB10.DBX0.1'],
    ['DB10.DBB2', 'DB10.DBB2'],
    ['DB1.DBW4', 'DB1.DBW4'],
    ['DB1.DBD8', 'DB1.DBD8'],
    ['MX0.1', 'M0.1'],
    ['mw2', 'MW2'],
    ['E0.0', 'I0.0'],
    ['EW2', 'IW2'],
    ['A1.3', 'Q1.3'],
    ['AD4', 'QD4'],
  ]) {
    assert.equal(formatAddress(parseAddress(input)), canon);
  }
});

// ── decode golden vectors ──────────────────────────────────────────────────

const VECTORS = [
  ['BYTE', '7f', 127, 'uint8'],
  ['USINT', 'ff', 255, 'uint8'],
  ['SINT', 'ff', -1, 'int8'],
  ['WORD', '1234', 0x1234, 'uint16'],
  ['UINT', 'fffe', 65534, 'uint16'],
  ['INT', 'fffe', -2, 'int16'],
  ['INT', '8000', -32768, 'int16'],
  ['DWORD', 'deadbeef', 0xdeadbeef, 'uint32'],
  ['UDINT', 'ffffffff', 4294967295, 'uint32'],
  ['DINT', 'ffffff85', -123, 'int32'],
  ['LINT', '8000000000000000', '-9223372036854775808', 'int64'],
  ['LINT', '00000000075bcd15', '123456789', 'int64'],
  ['ULINT', 'ffffffffffffffff', '18446744073709551615', 'uint64'],
  ['LWORD', '0000000000000100', '256', 'uint64'],
  ['REAL', '40490fdb', Math.fround(Math.PI), 'float32'],
  ['REAL', 'c1200000', -10, 'float32'],
  ['LREAL', '400921fb54442d18', Math.PI, 'float64'],
  ['CHAR', '41', 'A', 'string'],
  ['WCHAR', '00e9', 'é', 'string'],
  ['DATE', '0000', '1990-01-01', 'datetime'],
  ['DATE', '2a30', '2019-07-28', 'datetime'], // 10800 days
  ['TIME_OF_DAY', '0036ee80', 3600000, 'uint32'],
  ['DATE_AND_TIME', '2611241020305671', '2026-11-24T10:20:30.567', 'datetime'],
  ['DATE_AND_TIME', '9912312359599990', '1999-12-31T23:59:59.999', 'datetime'],
  ['DTL', '07ea 0b 18 03 0a 14 1e 075bcd15', '2026-11-24T10:20:30.123456789', 'datetime'],
  ['DTL', '07ea 0b 18 03 0a 14 1e 0754d4c0', '2026-11-24T10:20:30.123', 'datetime'],
  ['TIME', 'fffffc18', -1000, 'int32'],
  ['TIME', '05265c00', 86400000, 'int32'],
  ['LTIME', '0000000ba43b7400', '50000000000', 'int64'],
  ['S5TIME', '0000', 0, 'uint32'],
  ['S5TIME', '1234', 23400, 'uint32'], // base 100 ms × 234
  ['S5TIME', '3999', 9990000, 'uint32'], // base 10 s × 999
];

test('decode golden vectors for every type', () => {
  for (const [type, h, v, sample] of VECTORS) {
    const got = decode({ type }, hex(h));
    assert.deepEqual(got, { v, type: sample }, `${type} ${h}`);
  }
});

test('decode BOOL by bit offset', () => {
  for (let bit = 0; bit < 8; bit++) {
    assert.deepEqual(decode({ type: 'BOOL' }, Buffer.from([1 << bit]), bit), { v: true, type: 'bool' });
    assert.equal(decode({ type: 'bool' }, Buffer.from([~(1 << bit) & 0xff]), bit).v, false);
  }
  assert.throws(() => decode({ type: 'BOOL' }, Buffer.from([1])), RangeError);
});

test('STRING clamps the actual length to the header max and configured length', () => {
  assert.deepEqual(decode({ type: 'STRING', length: 10 }, hex('0a05 48656c6c6f 0000000000')), { v: 'Hello', type: 'string' });
  // actual (0xff) > max: clamp to header max 4
  assert.equal(decode({ type: 'STRING', length: 6 }, hex('04ff 616263646566')).v, 'abcd');
  // header max (0xfe) larger than configured length 3: clamp to 3
  assert.equal(decode({ type: 'STRING', length: 3 }, hex('fefe 78797a')).v, 'xyz');
  assert.equal(decode({ type: 'STRING', length: 2 }, hex('0200 4142')).v, '');
  assert.equal(decode({ type: 'STRING', length: 1 }, hex('0101 e9')).v, 'é'); // latin1
});

test('WSTRING: 4-byte header, UTF-16BE, clamped', () => {
  assert.equal(decode({ type: 'WSTRING', length: 4 }, hex('0004 0002 00480069 00000000')).v, 'Hi');
  assert.equal(decode({ type: 'WSTRING', length: 2 }, hex('0002 ffff 4e2d 6587')).v, '中文');
  assert.equal(decode({ type: 'WSTRING', length: 1 }, hex('0001 0001 d83d')).v.length, 1); // lone surrogate stays one unit
});

test('invalid encodings throw S7DecodeError', () => {
  assert.throws(() => decode({ type: 'DATE_AND_TIME' }, hex('26aa241020300000')), S7DecodeError); // month not BCD
  assert.throws(() => decode({ type: 'DATE_AND_TIME' }, hex('2613241020300000')), S7DecodeError); // month 13
  assert.throws(() => decode({ type: 'DATE_AND_TIME' }, hex('2302301020300000')), /does not exist/); // 30 Feb
  assert.throws(() => decode({ type: 'DTL' }, hex('07ea 0d 18 03 0a 14 1e 00000000')), S7DecodeError);
  assert.throws(() => decode({ type: 'DTL' }, hex('07ea 0b 18 03 0a 14 1e 3b9aca00')), /nanoseconds/);
  assert.throws(() => decode({ type: 'S5TIME' }, hex('00fa')), S7DecodeError);
  assert.throws(() => decode({ type: 'TIME_OF_DAY' }, hex('05265c00')), S7DecodeError);
  assert.throws(() => decode({ type: 'INT' }, hex('00')), RangeError);
  assert.throws(() => decode({ type: 'NOPE' }, hex('00')), RangeError);
});

test('byteLength per type', () => {
  const expect = { BOOL: 1, BYTE: 1, WORD: 2, DWORD: 4, LWORD: 8, SINT: 1, USINT: 1, INT: 2, UINT: 2, DINT: 4, UDINT: 4,
    LINT: 8, ULINT: 8, REAL: 4, LREAL: 8, CHAR: 1, WCHAR: 2, DATE: 2, TIME_OF_DAY: 4, DATE_AND_TIME: 8, DTL: 12,
    TIME: 4, LTIME: 8, S5TIME: 2 };
  for (const [type, n] of Object.entries(expect)) assert.equal(byteLength({ type }), n, type);
  assert.equal(byteLength({ type: 'STRING' }), 256);
  assert.equal(byteLength({ type: 'STRING', length: 20 }), 22);
  assert.equal(byteLength({ type: 'WSTRING', length: 10 }), 24);
  assert.equal(byteLength({ type: 'dt' }), 8);
  assert.equal(normalizeType('tod'), 'TIME_OF_DAY');
  assert.throws(() => byteLength({ type: 'STRING', length: 255 }), RangeError);
  assert.throws(() => byteLength({ type: 'STRING', length: 0 }), RangeError);
  assert.throws(() => byteLength({ type: 'X' }), RangeError);
});

test('probeDecodings shows common interpretations and skips invalid ones', () => {
  const d = probeDecodings(hex('40490fdb'));
  assert.equal(d.REAL, Math.fround(Math.PI));
  assert.equal(d.WORD, 0x4049);
  assert.equal(d.bits, '00000010');
  assert.equal(d.LREAL, undefined);
  assert.equal(d.S5TIME, 490); // bits 14-15 are ignored, 0x049 BCD × 10 ms
  assert.equal(probeDecodings(hex('00fa')).S5TIME, undefined); // 0xfa is not BCD
  assert.equal(probeDecodings(hex('0403 616263')).STRING, 'abc');
});

// ── planner ────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPACES = [
  { areaCode: AREA.DB, db: 1 },
  { areaCode: AREA.DB, db: 2 },
  { areaCode: AREA.DB, db: 300 },
  { areaCode: AREA.M, db: 0 },
  { areaCode: AREA.I, db: 0 },
  { areaCode: AREA.Q, db: 0 },
];
const LENGTHS = [1, 1, 2, 2, 4, 4, 8, 12, 22, 256, 3, 5];

function randomTags(rnd, n) {
  const tags = [];
  for (let i = 0; i < n; i++) {
    const s = SPACES[Math.floor(rnd() * SPACES.length)];
    let length = LENGTHS[Math.floor(rnd() * LENGTHS.length)];
    if (rnd() < 0.03) length = 300 + Math.floor(rnd() * 1800); // larger than any PDU
    tags.push({ key: `t${i}`, ...s, byteOffset: Math.floor(rnd() * (rnd() < 0.5 ? 64 : 3000)), length });
  }
  return tags;
}

const evenUp = (n) => n + (n % 2);

function checkPlan(tags, requests, pduSize) {
  const lim = limitsFor(pduSize);
  const byKey = new Map(tags.map((t) => [t.key, t]));
  const seen = new Map();
  for (const r of requests) {
    assert.equal(r.pduSize, pduSize);
    for (const job of r.jobs) {
      assert.ok(job.items.length >= 1 && job.items.length <= 20, 'item count');
      assert.ok(job.items.length <= lim.maxItems);
      assert.ok(readRequestSize(job.items.length) <= pduSize, 'request fits PDU');
      const resp = 14 + job.items.reduce((s, w) => s + 4 + evenUp(w.length), 0);
      assert.ok(resp <= pduSize, `response ${resp} fits PDU ${pduSize}`);
      // the real encoder agrees
      const encoded = encodeS7Frame({ type: 'job', func: 4, pduRef: 1, items: job.items, maxPdu: pduSize });
      assert.ok(encoded.length - 7 <= pduSize);
    }
    for (const it of r.items) {
      seen.set(it.key, (seen.get(it.key) || 0) + 1);
      const tag = byKey.get(it.key);
      let pos = tag.byteOffset;
      for (const p of it.parts) {
        const w = r.jobs[p.job].items[p.wire];
        assert.equal(w.area, tag.areaCode, 'no cross-area merge');
        assert.equal(w.db, tag.db, 'no cross-DB merge');
        assert.equal(w.start + p.offset, pos, 'parts are contiguous');
        assert.ok(p.offset >= 0 && p.offset + p.length <= w.length, 'part inside wire item');
        pos += p.length;
      }
      assert.equal(pos, tag.byteOffset + tag.length, 'parts cover the tag');
    }
  }
  for (const t of tags) assert.equal(seen.get(t.key), 1, `${t.key} covered exactly once`);
}

test('planner property test: random tag sets at PDU 240/480/960 (fixed seed)', () => {
  const rnd = mulberry32(0x5eed57);
  for (const pduSize of [240, 480, 960]) {
    for (let iter = 0; iter < 150; iter++) {
      const tags = randomTags(rnd, 1 + Math.floor(rnd() * 120));
      const maxGap = [0, 8, 32][iter % 3];
      const requests = planReads(tags, { pduSize, maxGap });
      checkPlan(tags, requests, pduSize);
      // deterministic regardless of input order
      const shuffled = [...tags].sort(() => rnd() - 0.5);
      assert.deepEqual(
        planReads(shuffled, { pduSize, maxGap }).map((r) => r.id),
        requests.map((r) => r.id)
      );
      // bisect halves keep every invariant and partition the items
      for (const r of requests) {
        const halves = bisect(r);
        if (r.items.length < 2 || r.jobs.length > 1) {
          assert.equal(halves, null);
          continue;
        }
        const keys = halves.flatMap((h) => h.items.map((i) => i.key));
        assert.deepEqual(keys, r.items.map((i) => i.key));
        const subset = tags.filter((t) => keys.includes(t.key));
        checkPlan(subset, halves, pduSize);
        assert.ok(halves.every((h) => h.jobs[0].items.length <= r.jobs[0].items.length));
      }
    }
  }
});

test('planner limits: 19 items at PDU 240, 20 above; block size pdu - 18', () => {
  assert.deepEqual(limitsFor(240), { pduSize: 240, maxItems: 19, maxBlock: 222 });
  assert.deepEqual(limitsFor(480), { pduSize: 480, maxItems: 20, maxBlock: 462 });
  assert.deepEqual(limitsFor(960), { pduSize: 960, maxItems: 20, maxBlock: 942 });
  // 40 scattered one-byte tags in 40 DBs → 19 + 19 + 2 at 240, 20 + 20 at 960
  const tags = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, areaCode: AREA.DB, db: i + 1, byteOffset: 0, length: 1 }));
  assert.deepEqual(planReads(tags, { pduSize: 240 }).map((r) => r.jobs[0].items.length), [19, 19, 2]);
  assert.deepEqual(planReads(tags, { pduSize: 960 }).map((r) => r.jobs[0].items.length), [20, 20]);
});

test('planner merges within maxGap and never across DBs', () => {
  const t = (key, db, byteOffset, length) => ({ key, areaCode: AREA.DB, db, byteOffset, length });
  let r = planReads([t('a', 1, 0, 2), t('b', 1, 10, 2)], { pduSize: 240, maxGap: 8 });
  assert.deepEqual(r[0].jobs[0].items, [{ area: AREA.DB, db: 1, start: 0, length: 12 }]);
  r = planReads([t('a', 1, 0, 2), t('b', 1, 11, 2)], { pduSize: 240, maxGap: 8 });
  assert.equal(r[0].jobs[0].items.length, 2);
  r = planReads([t('a', 1, 0, 2), t('b', 2, 2, 2)], { pduSize: 240, maxGap: 100 });
  assert.equal(r[0].jobs[0].items.length, 2);
  // overlapping tags share bytes
  r = planReads([t('a', 1, 0, 4), t('b', 1, 2, 2), t('c', 1, 0, 1)], { pduSize: 240 });
  assert.deepEqual(r[0].jobs[0].items, [{ area: AREA.DB, db: 1, start: 0, length: 4 }]);
  assert.deepEqual(r[0].items.map((i) => [i.key, i.parts[0].offset]), [['a', 0], ['c', 0], ['b', 2]]);
});

test('planner splits a tag larger than the PDU into sequential jobs', () => {
  const r = planReads([{ key: 'big', areaCode: AREA.DB, db: 5, byteOffset: 100, length: 500 }], { pduSize: 240 });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].jobs.map((j) => j.items[0]), [
    { area: AREA.DB, db: 5, start: 100, length: 222 },
    { area: AREA.DB, db: 5, start: 322, length: 222 },
    { area: AREA.DB, db: 5, start: 544, length: 56 },
  ]);
  assert.equal(bisect(r[0]), null);
});

test('planner rejects invalid input', () => {
  const ok = { key: 'a', areaCode: AREA.DB, db: 1, byteOffset: 0, length: 1 };
  assert.throws(() => planReads([ok, ok], { pduSize: 240 }), /duplicate/);
  assert.throws(() => planReads([{ ...ok, length: 0 }], { pduSize: 240 }), /length/);
  assert.throws(() => planReads([ok], { pduSize: 10 }), RangeError);
  assert.throws(() => planReads([ok], { pduSize: 240, maxGap: -1 }), RangeError);
  assert.deepEqual(planReads([], { pduSize: 240 }), []);
});
