const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const protobuf = require('protobufjs');

const { decodeCbor, half } = require('../services/codecs/cbor');
const { decodeMsgpack } = require('../services/codecs/msgpack');
const { resolveSenml, fromCborLabels, packTime } = require('../services/codecs/senml');
const { compileAvro: compileAvroText, decodeAvro, fingerprint64 } = require('../services/codecs/avro');
// Schemas are JSON: a bare JS string here means a primitive name, so encode it as JSON text.
const compileAvro = (s) => compileAvroText(typeof s === 'string' && !/^\s*[[{"]/.test(s) ? JSON.stringify(s) : s);
const { compileProtobuf, decodeProtobuf } = require('../services/codecs/protobuf');
const { CodecError, decimalString, isoFromSeconds } = require('../services/codecs/common');
const { PayloadCodecs, autodetect, testDecode, compileCodec } = require('../services/codecs');
const { payloadBytes } = require('../routes/codecs');
const ProfileStore = require('../services/profileStore');
const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');

const H = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const cbor = (s) => decodeCbor(H(s));
const mp = (s) => decodeMsgpack(H(s));

// ---- CBOR: RFC 8949 Appendix A ----------------------------------------------------

test('CBOR: RFC 8949 Appendix A integers, including 64-bit and bignums as strings', () => {
  const vectors = [
    ['00', 0], ['01', 1], ['0a', 10], ['17', 23], ['1818', 24], ['1819', 25], ['1864', 100], ['1903e8', 1000],
    ['1a000f4240', 1000000], ['1b000000e8d4a51000', 1000000000000],
    ['1bffffffffffffffff', '18446744073709551615'], ['c249010000000000000000', '18446744073709551616'],
    ['3bffffffffffffffff', '-18446744073709551616'], ['c349010000000000000000', '-18446744073709551617'],
    ['20', -1], ['29', -10], ['3863', -100], ['3903e7', -1000],
    ['1b001fffffffffffff', Number.MAX_SAFE_INTEGER], ['1b0020000000000000', '9007199254740992'],
    ['3b001ffffffffffffe', -Number.MAX_SAFE_INTEGER], ['3b001fffffffffffff', '-9007199254740992']
  ];
  for (const [hex, want] of vectors) assert.deepStrictEqual(cbor(hex), want, hex);
});

test('CBOR: RFC 8949 Appendix A floats (half, single, double) and simple values', () => {
  const vectors = [
    ['f90000', 0], ['f98000', -0], ['f93c00', 1], ['fb3ff199999999999a', 1.1], ['f93e00', 1.5], ['f97bff', 65504],
    ['fa47c35000', 100000], ['fa7f7fffff', 3.4028234663852886e38], ['fb7e37e43c8800759c', 1e300],
    ['f90001', 5.960464477539063e-8], ['f90400', 0.00006103515625], ['f9c400', -4], ['fbc010666666666666', -4.1],
    ['f97c00', 'Infinity'], ['f97e00', 'NaN'], ['f9fc00', '-Infinity'], ['fa7f800000', 'Infinity'], ['fa7fc00000', 'NaN'],
    ['faff800000', '-Infinity'], ['fb7ff0000000000000', 'Infinity'], ['fb7ff8000000000000', 'NaN'], ['fbfff0000000000000', '-Infinity'],
    ['f4', false], ['f5', true], ['f6', null], ['f7', null], ['f0', { simple: 16 }], ['f8ff', { simple: 255 }]
  ];
  for (const [hex, want] of vectors) assert.deepStrictEqual(cbor(hex), want, hex);
  assert.strictEqual(half(0x3555), 0.333251953125);
});

test('CBOR: RFC 8949 Appendix A tags, strings, arrays, maps and indefinite lengths', () => {
  const vectors = [
    ['c074323031332d30332d32315432303a30343a30305a', '2013-03-21T20:04:00Z'],
    ['c11a514b67b0', '2013-03-21T20:04:00.000Z'],
    ['c1fb41d452d9ec200000', '2013-03-21T20:04:00.500Z'],
    ['d74401020304', { tag: 23, value: '01020304' }],
    ['d818456449455446', { tag: 24, value: '6449455446' }],
    ['d82076687474703a2f2f7777772e6578616d706c652e636f6d', { tag: 32, value: 'http://www.example.com' }],
    ['40', ''], ['4401020304', '01020304'],
    ['60', ''], ['6161', 'a'], ['6449455446', 'IETF'], ['62225c', '"\\'], ['62c3bc', 'ü'], ['63e6b0b4', '水'], ['64f0908591', '𐅑'],
    ['80', []], ['83010203', [1, 2, 3]], ['8301820203820405', [1, [2, 3], [4, 5]]],
    ['98190102030405060708090a0b0c0d0e0f101112131415161718181819', Array.from({ length: 25 }, (_, i) => i + 1)],
    ['a0', {}], ['a201020304', { 1: 2, 3: 4 }], ['a26161016162820203', { a: 1, b: [2, 3] }], ['826161a161626163', ['a', { b: 'c' }]],
    ['a56161614161626142616361436164614461656145', { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }],
    ['5f42010243030405ff', '0102030405'], ['7f657374726561646d696e67ff', 'streaming'],
    ['9fff', []], ['9f018202039f0405ffff', [1, [2, 3], [4, 5]]], ['9f01820203820405ff', [1, [2, 3], [4, 5]]],
    ['83018202039f0405ff', [1, [2, 3], [4, 5]]], ['83019f0203ff820405', [1, [2, 3], [4, 5]]],
    ['9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff', Array.from({ length: 25 }, (_, i) => i + 1)],
    ['bf61610161629f0203ffff', { a: 1, b: [2, 3] }], ['826161bf61626163ff', ['a', { b: 'c' }]], ['bf6346756ef563416d7421ff', { Fun: true, Amt: -2 }]
  ];
  for (const [hex, want] of vectors) assert.deepStrictEqual(cbor(hex), want, hex);
  // decimal fraction (RFC 8949 §3.4.4: 273.15) and bignum mantissa, UUID, self-describe
  assert.strictEqual(cbor('c48221196ab3'), '273.15');
  assert.strictEqual(cbor('c48222c249010000000000000000'), '18446744073709551.616');
  assert.strictEqual(cbor('d82550 f81d4fae7dec11d0a76500a0c91e6bf6'), 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  assert.deepStrictEqual(cbor('d9d9f7 a16174 01'), { t: 1 });
});

test('CBOR: not-well-formed inputs are refused (RFC 8949 Appendix F)', () => {
  const bad = [
    '18', '19 01', '1a 0102', '1b 01020304050607', '38', '58', '78', '98', '9a 01ff00', 'b8', 'd8', 'f8', 'f9 00', 'fa 0000', 'fb 000000',
    '41', '61', '82 00', '9a ffffffff 00', 'a1 00', 'a2 0102 03', '5f 41', '7f 61', '9f', '9f 01 02', 'bf', 'bf 01 02 03', '5f 00 ff', '7f 41 00 ff', '5f 5f 4100 ff ff',
    '1c', '1d', '1e', '3c', '5c', '7c', '9c', 'bc', 'dc', 'fc', 'fd', 'fe', '1f', '3f', 'df', 'ff', '81 ff', 'a1 ff',
    'f8 00', 'f8 1f', 'bf 00 ff', '62 c328', '00 00'
  ];
  for (const hex of bad) assert.throws(() => cbor(hex), CodecError, hex);
});

test('CBOR: hostile lengths and nesting fail fast, never allocate or recurse without end', () => {
  const t0 = Date.now();
  assert.throws(() => cbor('9b ffffffffffffffff'), /exceeds/);
  assert.throws(() => cbor('5b 0000000100000000 00'), /exceeds/);
  assert.throws(() => decodeCbor(Buffer.alloc(5000, 0x81)), /nested deeper/);
  assert.throws(() => decodeCbor(Buffer.concat([Buffer.alloc(100, 0x9f), Buffer.alloc(100, 0xff)])), /nested deeper/);
  assert.throws(() => decodeCbor(Buffer.concat([Buffer.from([0x9f]), Buffer.alloc(200_001, 0x00), Buffer.from([0xff])])), /items/);
  assert.throws(() => decodeCbor(Buffer.concat([Buffer.from([0xc6]), Buffer.alloc(100, 0xc6), Buffer.from([0x01])])), /nested deeper/);
  assert.ok(Date.now() - t0 < 2000);
  // __proto__ as a key stays data
  const o = cbor('a1 69 5f5f70726f746f5f5f a0'.replace(/ /g, ''));
  assert.strictEqual(Object.getPrototypeOf(o), Object.prototype);
  assert.ok(Object.hasOwn(o, '__proto__'));
});

// ---- MessagePack ------------------------------------------------------------------

test('MessagePack: every format family', () => {
  const vectors = [
    ['00', 0], ['7f', 127], ['ff', -1], ['e0', -32], ['cc ff', 255], ['cd ffff', 65535], ['ce ffffffff', 4294967295],
    ['cf 001fffffffffffff', Number.MAX_SAFE_INTEGER], ['cf ffffffffffffffff', '18446744073709551615'], ['cf 0020000000000000', '9007199254740992'],
    ['d0 80', -128], ['d1 8000', -32768], ['d2 80000000', -2147483648], ['d3 8000000000000000', '-9223372036854775808'], ['d3 ffffffffffffffff', -1],
    ['c0', null], ['c2', false], ['c3', true], ['ca 3fc00000', 1.5], ['cb 3ff199999999999a', 1.1], ['ca 7fc00000', 'NaN'], ['cb fff0000000000000', '-Infinity'],
    ['a0', ''], ['a3 616263', 'abc'], ['d9 03 616263', 'abc'], ['da 0003 616263', 'abc'], ['db 00000003 616263', 'abc'], ['a2 c3bc', 'ü'],
    ['c4 03 010203', '010203'], ['c5 0001 ff', 'ff'], ['c6 00000000', ''],
    ['90', []], ['93 010203', [1, 2, 3]], ['dc 0002 01 02', [1, 2]], ['dd 00000001 c0', [null]],
    ['80', {}], ['82 a7 636f6d70616374 c3 a6 736368656d61 00', { compact: true, schema: 0 }], ['de 0001 01 02', { 1: 2 }], ['df 00000001 a161 a162', { a: 'b' }],
    ['d4 05 aa', { ext: 5, hex: 'aa' }], ['d5 01 aabb', { ext: 1, hex: 'aabb' }], ['d8 7f ' + '00'.repeat(16), { ext: 127, hex: '00'.repeat(16) }],
    ['c7 03 02 010203', { ext: 2, hex: '010203' }], ['c8 0001 80 ff', { ext: -128, hex: 'ff' }], ['c9 00000000 10', { ext: 16, hex: '' }]
  ];
  for (const [hex, want] of vectors) assert.deepStrictEqual(mp(hex), want, hex);
});

test('MessagePack: timestamp extension -1 in its 32, 64 and 96-bit layouts', () => {
  assert.strictEqual(mp('d6 ff 00000000'), '1970-01-01T00:00:00.000Z');
  assert.strictEqual(mp('d6 ff 5a4a55e0'), '2018-01-01T15:38:08.000Z');
  // 64-bit: nsec (30 bits) << 34 | sec (34 bits); 1 ns past the epoch + 1 s
  const t64 = Buffer.alloc(8);
  t64.writeBigUInt64BE((1n << 34n) | 1n);
  assert.strictEqual(decodeMsgpack(Buffer.concat([H('d7ff'), t64])), '1970-01-01T00:00:01.000000001Z');
  const t64b = Buffer.alloc(8);
  t64b.writeBigUInt64BE((500_000_000n << 34n) | 0x3ffffffffn); // max 34-bit seconds
  assert.strictEqual(decodeMsgpack(Buffer.concat([H('d7ff'), t64b])), '2514-05-30T01:53:03.500Z');
  // 96-bit: nsec u32 + sec i64 (negative: before the epoch)
  assert.strictEqual(mp('c7 0c ff 00000000 ffffffffffffffff'), '1969-12-31T23:59:59.000Z');
  assert.strictEqual(mp('c7 0c ff 000f4240 0000000000000000'), '1970-01-01T00:00:00.001Z');
  assert.deepStrictEqual(mp('c7 0c ff 00000000 7fffffffffffffff'), { ext: -1, seconds: '9223372036854775807', nanoseconds: 0 });
  assert.throws(() => mp('c7 0c ff 3b9aca00 0000000000000000'), /nanoseconds/);
  assert.throws(() => mp('d4 ff 00'), /timestamp extension of 1 bytes/);
});

test('MessagePack: malformed and hostile inputs are refused quickly', () => {
  const bad = ['c1', '', 'cc', 'cd 00', 'a3 6162', 'd9', '92 01', '81 01', 'c4 05 00', 'dc 0002 01', 'dd ffffffff', 'df ffffffff', 'a2 c328', '01 02', 'd7 ff 00', 'c7 05 01 00'];
  for (const hex of bad) assert.throws(() => mp(hex), CodecError, hex);
  assert.throws(() => decodeMsgpack(Buffer.alloc(5000, 0x91)), /nested deeper/);
  assert.throws(() => decodeMsgpack(Buffer.concat([H('dd 00030000'), Buffer.alloc(0x30000, 0xc0)]), { maxItems: 1000 }), /items/);
});

// ---- SenML ------------------------------------------------------------------------

test('SenML JSON: RFC 8428 §5.1.2 base name and units resolve', () => {
  const now = 1_700_000_000_000;
  const pack = [
    { bn: 'urn:dev:ow:10e2073a01080063:', n: 'voltage', u: 'V', v: 120.1 },
    { n: 'current', u: 'A', v: 1.2 }
  ];
  assert.deepStrictEqual(resolveSenml(pack, { now }), [
    { n: 'urn:dev:ow:10e2073a01080063:voltage', u: 'V', v: 120.1, t: now / 1000 },
    { n: 'urn:dev:ow:10e2073a01080063:current', u: 'A', v: 1.2, t: now / 1000 }
  ]);
});

test('SenML JSON: RFC 8428 §5.1.3 base time, relative times, base unit and value kinds', () => {
  const pack = [
    { bn: 'urn:dev:ow:10e2073a01080063:', bt: 1.276020076001e9, bu: 'A', bver: 5, n: 'voltage', u: 'V', v: 120.1 },
    { n: 'current', t: -5, v: 1.2 },
    { n: 'current', t: -4, v: 1.3 },
    { n: 'current', t: -3, v: 1.4 }
  ];
  const r = resolveSenml(pack);
  assert.strictEqual(r.length, 4);
  assert.deepStrictEqual(r[1], { n: 'urn:dev:ow:10e2073a01080063:current', u: 'A', v: 1.2, t: 1.276020076001e9 - 5 });
  assert.strictEqual(r[0].u, 'V');
  assert.strictEqual(packTime(r), undefined, 'several times: no single source time');
  // base value / base sum, string, boolean and data values, update time
  const r2 = resolveSenml([{ bn: 'dev/', bv: 10, bs: 100, bt: 1.6e9 }, { n: 'a', v: 1, s: 5 }, { n: 'b', vs: 'on' }, { n: 'c', vb: true, ut: 60 }, { n: 'd', vd: 'AQID' }]);
  assert.deepStrictEqual(r2, [
    { n: 'dev/a', v: 11, s: 105, t: 1.6e9 },
    { n: 'dev/b', vs: 'on', t: 1.6e9 },
    { n: 'dev/c', vb: true, t: 1.6e9, ut: 60 },
    { n: 'dev/d', vd: 'AQID', t: 1.6e9 }
  ]);
  assert.strictEqual(packTime(r2), 1.6e12);
});

test('SenML: invalid packs are refused with a reason', () => {
  const cases = [
    [{ n: 'a', v: 1 }, /array/],
    [[1], /not an object/],
    [[{ n: 'a', v: '1' }], /"v" must be a finite number/],
    [[{ n: 'a', v: 1, vs: 'x' }], /more than one value/],
    [[{ n: 'a' }], /no value and no sum/],
    [[{ v: 1 }], /name "" is empty/],
    [[{ n: 'bad name', v: 1 }], /characters SenML does not allow/],
    [[{ n: 'a', v: 1, foo_: 1 }], /must-understand/],
    [[{ bver: 11, n: 'a', v: 1 }], /newer than supported/]
  ];
  for (const [pack, re] of cases) assert.throws(() => resolveSenml(pack), re);
  assert.deepStrictEqual(resolveSenml([{ n: 'a', v: 1, t: 1.6e9, extra: 'kept out' }]), [{ n: 'a', v: 1, t: 1.6e9 }]);
});

test('SenML CBOR: integer labels (RFC 8428 §6) resolve like JSON, vd bytes become base64url', () => {
  // [{-2: "urn:dev:ow:10e2073a01080063:", 0: "voltage", 1: "V", 2: 120.1}, {0: "current", 1: "A", 2: 1.2}]
  const bn = Buffer.from('urn:dev:ow:10e2073a01080063:');
  const buf = Buffer.concat([
    H('82 a4 21 78'), Buffer.from([bn.length]), bn,
    H('00 67'), Buffer.from('voltage'), H('01 61 56 02 fb 405e066666666666'),
    H('a3 00 67'), Buffer.from('current'), H('01 61 41 02 fb 3ff3333333333333')
  ]);
  const { decode } = compileCodec({ codec: 'senml-cbor' });
  const { value } = decode(buf, {});
  assert.deepStrictEqual(value.map((r) => [r.n, r.u, r.v]), [
    ['urn:dev:ow:10e2073a01080063:voltage', 'V', 120.1],
    ['urn:dev:ow:10e2073a01080063:current', 'A', 1.2]
  ]);
  // vd (label 8) as a byte string, bt (label -3)
  const vd = decode(H('81 a3 00 61 78 08 43 010203 22 1a 5f5e1000'), {}).value;
  assert.deepStrictEqual(vd, [{ n: 'x', vd: 'AQID', t: 1600000000 }]);
  assert.deepStrictEqual(fromCborLabels([{ 0: 'a', 2: 1 }]), [{ n: 'a', v: 1 }]);
});

// ---- Avro -------------------------------------------------------------------------

test('Avro: CRC-64-AVRO fingerprints match the specification test values', () => {
  const want = {
    null: 7195948357588979594n, boolean: -6970731678124411036n, int: 8247732601305521295n, long: -3434872931120570953n,
    float: 5583340709985441680n, double: -8181574048448539266n, bytes: 5746618253357095269n, string: -8142146995180207161n
  };
  for (const [t, fp] of Object.entries(want)) {
    assert.strictEqual(BigInt.asIntN(64, fingerprint64(Buffer.from(JSON.stringify(t)))), fp, t);
    assert.strictEqual(BigInt.asIntN(64, compileAvro({ type: t, doc: 'stripped' }).fingerprint), fp, `${t} in object form`);
  }
});

test('Avro: Parsing Canonical Form strips, orders and qualifies names', () => {
  const c = compileAvro({
    doc: 'x', fields: [{ name: 'a', type: { type: 'long', logicalType: 'timestamp-millis' }, default: 0 }, { name: 'self', type: ['null', 'Rec'] }, { name: 'e', type: { type: 'enum', name: 'E', symbols: ['A', 'B'], aliases: ['F'] } }],
    namespace: 'org.x', name: 'Rec', type: 'record'
  });
  assert.strictEqual(
    c.canonical,
    '{"name":"org.x.Rec","type":"record","fields":[{"name":"a","type":"long"},{"name":"self","type":["null","org.x.Rec"]},{"name":"e","type":{"name":"org.x.E","type":"enum","symbols":["A","B"]}}]}'
  );
});

test('Avro: specification binary encoding examples', () => {
  const dec = (schema, hex) => decodeAvro(compileAvro(schema), H(hex));
  // zig-zag ints and longs (spec table); long is always a decimal string
  for (const [hex, n] of [['00', 0], ['01', -1], ['02', 1], ['03', -2], ['04', 2], ['7f', -64], ['8001', 64]]) {
    assert.strictEqual(dec('int', hex), n);
    assert.strictEqual(dec('long', hex), String(n));
  }
  assert.strictEqual(dec('long', 'ffffffffffffffffff01'), '-9223372036854775808');
  assert.strictEqual(dec('long', 'feffffffffffffffff01'), '9223372036854775807');
  assert.strictEqual(dec('string', '06666f6f'), 'foo');
  assert.deepStrictEqual(dec({ type: 'record', name: 'test', fields: [{ name: 'a', type: 'long' }, { name: 'b', type: 'string' }] }, '36 06 666f6f'), { a: '27', b: 'foo' });
  assert.deepStrictEqual(dec({ type: 'array', items: 'long' }, '04 06 36 00'), ['3', '27']);
  assert.deepStrictEqual(dec({ type: 'array', items: 'int' }, '03 04 06 36 00'), [3, 27], 'negative block count with a byte size');
  assert.strictEqual(dec(['null', 'string'], '00'), null);
  assert.strictEqual(dec(['null', 'string'], '02 02 61'), 'a');
  assert.deepStrictEqual(dec({ type: 'map', values: 'int' }, '04 02 61 02 02 62 04 00'), { a: 1, b: 2 });
  assert.strictEqual(dec('boolean', '01'), true);
  assert.strictEqual(dec('float', '0000c03f'), 1.5);
  assert.strictEqual(dec('double', '000000000000f87f'), 'NaN');
  assert.strictEqual(dec('bytes', '06 010203'), '010203');
  assert.strictEqual(dec('null', ''), null);
  assert.strictEqual(dec({ type: 'enum', name: 'E', symbols: ['A', 'B', 'C'] }, '04'), 'C');
  assert.strictEqual(dec({ type: 'fixed', name: 'F', size: 2 }, 'abcd'), 'abcd');
});

test('Avro: logical types decode to readable values', () => {
  const dec = (schema, hex) => decodeAvro(compileAvro(schema), H(hex));
  assert.strictEqual(dec({ type: 'bytes', logicalType: 'decimal', precision: 5, scale: 2 }, '04 3039'), '123.45');
  assert.strictEqual(dec({ type: 'bytes', logicalType: 'decimal', precision: 5, scale: 2 }, '04 cfc7'), '-123.45');
  assert.strictEqual(dec({ type: 'fixed', name: 'D', size: 4, logicalType: 'decimal', precision: 9, scale: 3 }, '00000001'), '0.001');
  assert.strictEqual(dec({ type: 'int', logicalType: 'date' }, 'b6b302'), '2023-11-14'); // 19675 days
  assert.strictEqual(dec({ type: 'int', logicalType: 'time-millis' }, '80b89929'), '12:00:00.000'); // 43,200,000 ms
  assert.strictEqual(dec({ type: 'long', logicalType: 'timestamp-millis' }, '80a0abfef962'), '2023-11-14T22:13:20.000Z');
  assert.strictEqual(dec({ type: 'long', logicalType: 'timestamp-micros' }, '02'), '1970-01-01T00:00:00.000001Z');
  assert.strictEqual(dec({ type: 'long', logicalType: 'timestamp-millis' }, '01'), '1969-12-31T23:59:59.999Z');
  assert.strictEqual(dec({ type: 'long', logicalType: 'local-timestamp-millis' }, '00'), '1970-01-01T00:00:00.000');
  assert.strictEqual(dec({ type: 'long', logicalType: 'time-micros' }, '02'), '00:00:00.000001');
  assert.strictEqual(dec({ type: 'string', logicalType: 'uuid' }, '48 ' + Buffer.from('f81d4fae-7dec-11d0-a765-00a0c91e6bf6').toString('hex')), 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  assert.deepStrictEqual(dec({ type: 'fixed', name: 'Dur', size: 12, logicalType: 'duration' }, '01000000 02000000 e8030000'), { months: 1, days: 2, milliseconds: 1000 });
  // An invalid logical type is ignored: the underlying type decodes.
  assert.strictEqual(dec({ type: 'bytes', logicalType: 'decimal', precision: 2, scale: 3 }, '02 01'), '01');
  assert.strictEqual(dec({ type: 'string', logicalType: 'date' }, '02 61'), 'a');
});

test('Avro: named types, namespaces, recursion and single-object encoding', () => {
  const schema = {
    type: 'record', name: 'Node', namespace: 'plant',
    fields: [{ name: 'name', type: 'string' }, { name: 'kids', type: { type: 'array', items: 'Node' } }, { name: 'state', type: { type: 'enum', name: 'State', symbols: ['OFF', 'ON'] } }, { name: 'again', type: ['null', 'plant.State'] }]
  };
  const c = compileAvro(JSON.stringify(schema));
  // {name: "a", kids: [{name: "b", kids: [], state: ON, again: null}], state: OFF, again: ON}
  const datum = H('02 61  02  02 62 00 02 00  00  00  02 02');
  const want = { name: 'a', kids: [{ name: 'b', kids: [], state: 'ON', again: null }], state: 'OFF', again: 'ON' };
  assert.deepStrictEqual(decodeAvro(c, datum), want);
  const fp = Buffer.alloc(8);
  fp.writeBigUInt64LE(c.fingerprint);
  assert.deepStrictEqual(decodeAvro(c, Buffer.concat([H('c301'), fp, datum])), want, 'single-object header stripped');
  const other = Buffer.alloc(8, 0x11);
  assert.throws(() => decodeAvro(c, Buffer.concat([H('c301'), other, datum])), /fingerprint/);
});

test('Avro: schema errors name the problem', () => {
  const cases = [
    ['{', /not valid JSON/],
    [{ type: 'record', name: 'R' }, /needs a "fields" array/],
    [{ type: 'record', name: 'R', fields: [{ name: 'a', type: 'Missing' }] }, /unknown type "Missing"/],
    [{ type: 'enum', name: 'E', symbols: ['A', 'A'] }, /repeats the symbol/],
    [{ type: 'fixed', name: 'F', size: -1 }, /non-negative integer "size"/],
    [['null', 'null'], /two branches of type "null"/],
    [['null', ['int']], /may not directly contain another union/],
    [{ type: 'record', name: '1bad', fields: [] }, /not a valid Avro name/],
    [{ type: 'array' }, /needs "items"/],
    [{ type: 'mystery' }, /unknown type "mystery"/],
    [[{ type: 'record', name: 'A', fields: [] }, { type: 'record', name: 'A', fields: [] }], /defined twice/]
  ];
  for (const [schema, re] of cases) assert.throws(() => compileAvro(schema), re, JSON.stringify(schema));
});

test('Avro: malformed data and hostile counts fail fast', () => {
  const c = compileAvro({ type: 'array', items: 'null' });
  const t0 = Date.now();
  assert.throws(() => decodeAvro(c, H('feffffff0f')), /item budget|items/); // 2^31 nulls in 5 bytes
  assert.throws(() => decodeAvro(compileAvro('string'), H('7f')), CodecError);
  assert.throws(() => decodeAvro(compileAvro('string'), H('0a 6162')), /exceeds/);
  assert.throws(() => decodeAvro(compileAvro('int'), H('ffffffffff01')), CodecError);
  assert.throws(() => decodeAvro(compileAvro('long'), H('ffffffffffffffffffff01')), /longer than 10/);
  assert.throws(() => decodeAvro(compileAvro('boolean'), H('02')), /not 0 or 1/);
  assert.throws(() => decodeAvro(compileAvro({ type: 'enum', name: 'E', symbols: ['A'] }), H('02')), /out of range/);
  assert.throws(() => decodeAvro(compileAvro(['null', 'int']), H('04')), /branch 2 out of range/);
  assert.throws(() => decodeAvro(compileAvro('int'), H('02 00')), /trailing/);
  const rec = compileAvro({ type: 'record', name: 'L', fields: [{ name: 'next', type: ['null', 'L'] }] });
  assert.throws(() => decodeAvro(rec, Buffer.alloc(200, 0x02)), /nested deeper|truncated/);
  assert.ok(Date.now() - t0 < 2000);
});

// ---- Protobuf ---------------------------------------------------------------------

test('Protobuf: encoding guide examples decode through reflection', () => {
  const schema = `syntax = "proto3";
    message Test1 { int32 a = 1; }
    message Test2 { string b = 2; }
    message Test3 { Test1 c = 3; }
    message Test4 { repeated int32 d = 4; }`;
  const dec = (type, hex) => decodeProtobuf(compileProtobuf(schema, type), H(hex));
  assert.deepStrictEqual(dec('Test1', '08 96 01'), { a: 150 });
  assert.deepStrictEqual(dec('Test2', '12 07 74657374696e67'), { b: 'testing' });
  assert.deepStrictEqual(dec('Test3', '1a 03 08 96 01'), { c: { a: 150 } });
  assert.deepStrictEqual(dec('Test4', '22 06 03 8e02 9ea705'), { d: [3, 270, 86942] }, 'packed');
  assert.deepStrictEqual(dec('Test4', '20 03 20 8e02'), { d: [3, 270] }, 'unpacked');
  assert.deepStrictEqual(dec('Test1', ''), { a: 0 }, 'defaults');
  assert.deepStrictEqual(dec('Test3', ''), { c: null });
  assert.deepStrictEqual(dec('Test1', '08 96 01 50 01 62 02 abcd'), { a: 150 }, 'unknown fields skipped');
});

test('Protobuf: every scalar type, enums, maps, oneofs and well-known types against protobufjs as the encoder', () => {
  const schema = `syntax = "proto3";
    package plant.v1;
    import "google/protobuf/timestamp.proto";
    import "google/protobuf/wrappers.proto";
    import "google/protobuf/struct.proto";
    enum Mode { MODE_UNSPECIFIED = 0; AUTO = 1; MANUAL = 2; }
    message Reading {
      double d = 1; float f = 2; int32 i32 = 3; int64 i64 = 4; uint32 u32 = 5; uint64 u64 = 6;
      sint32 s32 = 7; sint64 s64 = 8; fixed32 fx32 = 9; fixed64 fx64 = 10; sfixed32 sf32 = 11; sfixed64 sf64 = 12;
      bool ok = 13; string name = 14; bytes raw = 15; Mode mode = 16;
      map<string, double> extra = 17; repeated string tags = 18;
      oneof source { string device = 19; int32 channel = 20; }
      google.protobuf.Timestamp at = 21; google.protobuf.DoubleValue setpoint = 22; google.protobuf.Struct meta = 23;
    }`;
  const compiled = compileProtobuf(schema, 'plant.v1.Reading');
  assert.strictEqual(compiled.messageType, 'plant.v1.Reading');
  // protobufjs encodes (test fixture only); the decoder under test never calls Type.decode.
  const root = protobuf.parse(schema, { keepCase: true }).root;
  for (const f of ['timestamp', 'wrappers', 'struct']) root.addJSON(protobuf.common.get(`google/protobuf/${f}.proto`).nested);
  const R = root.lookupType('plant.v1.Reading');
  const bytes = R.encode(
    R.fromObject({
      d: 21.5, f: 1.5, i32: -5, i64: '-9007199254740993', u32: 4294967295, u64: '18446744073709551615', s32: -64, s64: '-2', fx32: 7, fx64: '9007199254740993',
      sf32: -7, sf64: '-1', ok: true, name: 'pump-1', raw: Buffer.from([1, 2, 255]), mode: 'MANUAL', extra: { a: 1.25 }, tags: ['x', 'y'], channel: 3,
      at: { seconds: 1700000000, nanos: 500000000 }, setpoint: { value: 42 }, meta: { fields: { site: { stringValue: 'north' }, n: { numberValue: 2 }, on: { boolValue: true }, list: { listValue: { values: [{ numberValue: 1 }, { nullValue: 0 }] } } } }
    })
  ).finish();
  assert.deepStrictEqual(decodeProtobuf(compiled, Buffer.from(bytes)), {
    d: 21.5, f: 1.5, i32: -5, i64: '-9007199254740993', u32: 4294967295, u64: '18446744073709551615', s32: -64, s64: '-2', fx32: 7, fx64: '9007199254740993',
    sf32: -7, sf64: '-1', ok: true, name: 'pump-1', raw: '0102ff', mode: 'MANUAL', extra: { a: 1.25 }, tags: ['x', 'y'], channel: 3,
    at: '2023-11-14T22:13:20.500Z', setpoint: 42, meta: { site: 'north', n: 2, on: true, list: [1, null] }
  });
  // 64-bit types are strings even when small; absent fields carry defaults; the unset oneof member is omitted
  const small = decodeProtobuf(compiled, Buffer.from(R.encode(R.fromObject({ i64: 5 })).finish()));
  assert.strictEqual(small.i64, '5');
  assert.strictEqual(small.u64, '0');
  assert.strictEqual(small.mode, 'MODE_UNSPECIFIED');
  assert.strictEqual(small.at, null);
  assert.ok(!('device' in small) && !('channel' in small));
});

test('Protobuf: never generates code from the schema (reflection only)', () => {
  const orig = protobuf.util.codegen;
  let called = 0;
  protobuf.util.codegen = function (...args) {
    called++;
    return orig.apply(this, args);
  };
  try {
    const compiled = compileProtobuf('syntax="proto3"; message M { int32 a = 1; repeated string b = 2; map<string,int64> c = 3; }');
    decodeProtobuf(compiled, H('08 01 12 01 78 1a 05 0a 01 6b 10 02'));
    assert.strictEqual(called, 0);
  } finally {
    protobuf.util.codegen = orig;
  }
});

test('Protobuf: schema errors are reported clearly', () => {
  assert.throws(() => compileProtobuf('message M { int32 a = 1 }'), /does not parse.*line/i);
  assert.throws(() => compileProtobuf('syntax="proto3"; message A {} message B {}'), /defines 2 messages; choose the message type \(A, B\)/);
  assert.throws(() => compileProtobuf('syntax="proto3"; message A {}', 'Nope'), /"Nope" is not in the schema/);
  assert.throws(() => compileProtobuf('syntax="proto3"; import "other.proto"; message A {}'), /import "other.proto" is not available/);
  assert.throws(() => compileProtobuf('syntax="proto3"; message A { Missing m = 1; }'), /does not resolve/);
  assert.throws(() => compileProtobuf('   '), /empty/);
  assert.strictEqual(compileProtobuf('syntax="proto3"; package p; message A {}', 'A').messageType, 'p.A', 'short name inside the package');
});

test('Protobuf: malformed payloads and wrong wire types fail with a CodecError', () => {
  const c = compileProtobuf('syntax="proto3"; message M { int32 a = 1; string s = 2; M child = 3; }');
  const bad = ['08', '08 ff', '12 05 6162', '00 01', '0a 01 00', '1a 05 08', '0f', '12 01 ff', '0c', '08 ffffffffffffffffffff01'];
  for (const hex of bad) assert.throws(() => decodeProtobuf(c, H(hex)), CodecError, hex);
  // deep nesting stops at the depth cap
  let buf = Buffer.alloc(0);
  for (let i = 0; i < 100; i++) buf = Buffer.concat([Buffer.from([0x1a]), encodeLen(buf.length), buf]);
  assert.throws(() => decodeProtobuf(c, buf), /nested deeper/);
});

function encodeLen(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

// ---- fuzz-ish: random and mutated inputs never escape as anything but a CodecError ----

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('fuzz: random, truncated and bit-flipped inputs only ever throw CodecError, in bounded time', () => {
  const rand = rng(0xc0dec);
  const avro = compileAvro({
    type: 'record', name: 'R', fields: [
      { name: 'a', type: 'long' }, { name: 'b', type: ['null', 'string', { type: 'array', items: 'double' }] },
      { name: 'm', type: { type: 'map', values: { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 } } }, { name: 'r', type: ['null', 'R'] }
    ]
  });
  const proto = compileProtobuf('syntax="proto3"; message M { int64 a = 1; string s = 2; repeated double d = 3; map<string, M> kids = 4; bytes b = 5; }');
  const decoders = {
    cbor: (b) => decodeCbor(b),
    msgpack: (b) => decodeMsgpack(b),
    avro: (b) => decodeAvro(avro, b),
    protobuf: (b) => decodeProtobuf(proto, b),
    senml: (b) => resolveSenml(fromCborLabels(decodeCbor(b, {}, { rawBytes: true })))
  };
  const seeds = [
    H('a26161016162820203'), H('bf6346756ef563416d7421ff'), H('82 a7 636f6d70616374 c3 a6 736368656d61 00'),
    H('c7 0c ff 000f4240 0000000000000000'), H('36 02 06 666f6f 02 02 61 00 00'), H('08 96 01 12 03 616263 1a 08 0000000000000040')
  ];
  const t0 = Date.now();
  let runs = 0;
  const check = (name, fn, buf) => {
    runs++;
    try {
      const v = fn(buf);
      JSON.stringify(v); // output is always JSON-safe
    } catch (error) {
      if (!(error instanceof CodecError)) assert.fail(`${name} threw ${error.name}: ${error.message} for ${buf.toString('hex')}`);
    }
  };
  for (let i = 0; i < 3000; i++) {
    const len = Math.floor(rand() * 64);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rand() * 256);
    for (const [name, fn] of Object.entries(decoders)) check(name, fn, buf);
  }
  for (const seed of seeds) {
    for (let cut = 0; cut <= seed.length; cut++) for (const [name, fn] of Object.entries(decoders)) check(name, fn, seed.subarray(0, cut));
    for (let i = 0; i < 300; i++) {
      const m = Buffer.from(seed);
      m[Math.floor(rand() * m.length)] ^= 1 << Math.floor(rand() * 8);
      for (const [name, fn] of Object.entries(decoders)) check(name, fn, m);
    }
  }
  assert.ok(runs > 15000);
  assert.ok(Date.now() - t0 < 15000, `fuzz took ${Date.now() - t0} ms`);
});

// ---- auto-detection ---------------------------------------------------------------

test('auto-detection is conservative: text and JSON are never decoded, ambiguous binary stays binary', () => {
  assert.strictEqual(autodetect(Buffer.from('{"a":1}')), null);
  assert.strictEqual(autodetect(Buffer.from('21.5')), null);
  assert.strictEqual(autodetect(Buffer.from('hello world')), null);
  assert.strictEqual(autodetect(Buffer.from('température élevée')), null, 'UTF-8 text with multibyte chars');
  assert.deepStrictEqual(autodetect(H('a26474656d70fb4035800000000000 6372706d1905dc')), { codec: 'cbor', value: { temp: 21.5, rpm: 1500 } });
  assert.deepStrictEqual(autodetect(H('82 a4 74656d70 cb4035800000000000 a3 72706d cd05dc')), { codec: 'msgpack', value: { temp: 21.5, rpm: 1500 } });
  assert.deepStrictEqual(autodetect(H('d9d9f7 a1 6161 01')), { codec: 'cbor', value: { a: 1 } }, 'self-describe tag');
  assert.strictEqual(autodetect(H('0102ff')), null, 'scalar CBOR with trailing bytes');
  assert.strictEqual(autodetect(H('fa47c35000')), null, 'a lone scalar is not enough');
  assert.strictEqual(autodetect(H('08 96 01')), null, 'protobuf without a schema stays binary');
  assert.strictEqual(autodetect(H('84 1805 1805 1805 1805')), null, 'decodes as both formats: ambiguous');
  // random binary is overwhelmingly left alone
  const rand = rng(7);
  let decoded = 0;
  for (let i = 0; i < 2000; i++) {
    const buf = Buffer.alloc(8 + Math.floor(rand() * 40));
    for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(rand() * 256);
    if (autodetect(buf)) decoded++;
  }
  assert.ok(decoded < 10, `${decoded} random buffers auto-decoded`);
  assert.strictEqual(autodetect(Buffer.alloc(300 * 1024, 0x80), { maxBytes: 256 * 1024, maxDepth: 32, maxItems: 100000 }), null, 'over the size cap');
});

// ---- registry + ingest ------------------------------------------------------------

const tmpStore = () => new ProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-codecs-')));

function managerWithCodecs(store, opts) {
  const m = new MqttManager({ emit() {} });
  m.codecs = new PayloadCodecs({ profiles: store, ...opts });
  return m;
}
const row = (topic, buffer, slot) => ({ topic, buffer, qos: 0, retain: false, ts: Date.now(), count: 1, slot });

test('ingest: a binding decodes, the most specific filter wins, failures fall through and are counted', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 'pb', { name: 'pumps', filter: 'plant/+/pump', codec: 'protobuf', schemaText: 'syntax="proto3"; message P { int32 rpm = 1; }', enabled: true });
  store.upsertIn('codecs', 'all', { name: 'everything', filter: 'plant/#', codec: 'cbor', enabled: true });
  store.upsertIn('codecs', 'off', { name: 'disabled', filter: 'plant/a/pump', codec: 'msgpack', enabled: false });
  const m = managerWithCodecs(store);
  const pump = m.buildMessage('b1', row('plant/a/pump', H('08 96 01')));
  assert.deepStrictEqual(pump.payload, { rpm: 150 });
  assert.strictEqual(pump.payloadFormat, 'decoded');
  assert.deepStrictEqual(pump.codec, { name: 'protobuf', bindingId: 'pb', binding: 'pumps' });
  assert.strictEqual(pump.type, 'json');
  const other = m.buildMessage('b1', row('plant/a/temp', H('a1 6176 fb4035800000000000')));
  assert.deepStrictEqual(other.payload, { v: 21.5 });
  assert.strictEqual(other.codec.bindingId, 'all');
  // a failure keeps the payload as it was (JSON here) and reports the codec error
  const bad = m.buildMessage('b1', row('plant/a/temp', Buffer.from('{"v":1}')));
  assert.deepStrictEqual(bad.payload, { v: 1 });
  assert.strictEqual(bad.payloadFormat, 'json');
  assert.strictEqual(bad.codecError.bindingId, 'all');
  assert.match(bad.codecError.error, /trailing|truncated/);
  const counters = m.codecs.getCounters();
  assert.strictEqual(counters.pb.decoded, 1);
  assert.strictEqual(counters.all.decoded, 1);
  assert.strictEqual(counters.all.failed, 1);
  // read path does not count
  m.buildMessage('b1', row('plant/a/pump', H('08 96 01')), { count: false });
  assert.strictEqual(m.codecs.getCounters().pb.decoded, 1);
});

test('ingest: a TVQ envelope inside a decoded payload sets source time and quality', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 'c', { filter: 'x/#', codec: 'msgpack' });
  const m = managerWithCodecs(store);
  const msg = m.buildMessage('b1', row('x/y', H('83 a1 76 cb4035800000000000 a1 74 cf 0000018bcfe56800 a1 71 cc c0')));
  assert.strictEqual(msg.sourceTimestamp, 1700000000000);
  assert.strictEqual(msg.quality, 192);
});

test('ingest: SenML packs carry their single source time', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 's', { filter: 'senml/#', codec: 'senml-json' });
  const m = managerWithCodecs(store);
  const msg = m.buildMessage('b1', row('senml/dev1', Buffer.from(JSON.stringify([{ bn: 'dev1/', bt: 1.7e9, n: 'temp', u: 'Cel', v: 21.5 }]))));
  assert.deepStrictEqual(msg.payload, [{ n: 'dev1/temp', u: 'Cel', v: 21.5, t: 1.7e9 }]);
  assert.strictEqual(msg.sourceTimestamp, 1.7e12);
});

test('ingest: auto-detects unbound CBOR / MessagePack, leaves JSON, text, Sparkplug and "raw" filters alone', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 'r', { filter: 'opaque/#', codec: 'raw' });
  const m = managerWithCodecs(store);
  const c = m.buildMessage('b1', row('dev/1', H('a1 6474656d70 f94d80')));
  assert.deepStrictEqual(c.payload, { temp: 22 });
  assert.deepStrictEqual(c.codec, { name: 'cbor', auto: true });
  const j = m.buildMessage('b1', row('dev/2', Buffer.from('{"temp":22}')));
  assert.strictEqual(j.payloadFormat, 'json');
  assert.strictEqual(j.codec, undefined);
  const raw = m.buildMessage('b1', row('opaque/1', H('a1 6474656d70 f94d80')));
  assert.strictEqual(raw.payloadFormat, 'binary');
  assert.strictEqual(raw.payload, H('a1 6474656d70 f94d80').toString('base64'));
  assert.strictEqual(raw.codec, undefined);
  const junk = m.buildMessage('b1', row('dev/3', H('ff fe 00 01 9c')));
  assert.strictEqual(junk.payloadFormat, 'binary', 'undecodable binary stays exactly as before');
  assert.strictEqual(junk.payload, H('fffe00019c').toString('base64'));
  const spark = m.buildMessage('b1', row('spBv1.0/G/DDATA/E/D', H('a1 6474656d70 f94d80')));
  assert.strictEqual(spark.codec, undefined);
  assert.strictEqual(spark.type, 'sparkplug');
  assert.deepStrictEqual(m.codecs.getStatus().auto, { cbor: 1, msgpack: 0, skippedLarge: 0 });
  // auto-detection can be turned off
  const off = managerWithCodecs(tmpStore(), { autodetect: false });
  assert.strictEqual(off.buildMessage('b1', row('dev/1', H('a1 6474656d70 f94d80'))).payloadFormat, 'binary');
});

test('ingest: oversized payloads are not decoded; a broken stored schema disables only its binding', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 'big', { filter: 'big/#', codec: 'cbor' });
  store.upsertIn('codecs', 'broken', { filter: 'b/#', codec: 'avro', schemaText: '{"type":"record"}' });
  store.upsertIn('codecs', 'ok', { filter: 'ok/#', codec: 'avro', schemaText: '"int"' });
  const m = managerWithCodecs(store, { limits: { maxBytes: 64, maxDepth: 32, maxItems: 1000 } });
  const big = m.buildMessage('b1', row('big/1', Buffer.concat([H('5840'), Buffer.alloc(64)])));
  assert.match(big.codecError.error, /larger than the 64-byte decode limit/);
  assert.strictEqual(m.buildMessage('b1', row('ok/1', H('04'))).payload, 2);
  assert.strictEqual(m.buildMessage('b1', row('b/1', H('04'))).codec, undefined);
  assert.match(m.codecs.getCounters().broken.compileError, /name/);
});

test('ingest: getTopics re-decodes after a binding change and reports the codec', () => {
  const store = tmpStore();
  const m = managerWithCodecs(store);
  m.connections.set('b1', { id: 'b1', metrics: {} });
  m.stores.set('b1', new TopicStore());
  m.rowCache.set('b1', new Map());
  m.topicMeta.set('b1', []);
  m.stores.get('b1').ingest('dev/p', H('08 96 01'), 0, false);
  assert.strictEqual(m.getTopics('b1').topics[0].lastPayloadFormat, 'binary');
  store.upsertIn('codecs', 'pb', { filter: 'dev/+', codec: 'protobuf', schemaText: 'syntax="proto3"; message P { int32 rpm = 1; }' });
  const t = m.getTopics('b1').topics[0];
  assert.deepStrictEqual(t.payload, { rpm: 150 });
  assert.strictEqual(t.codec.name, 'protobuf');
  assert.strictEqual(m.codecs.getCounters().pb.decoded, 0, 'read path leaves counters alone');
});

test('ingest: a decode is bounded and a bad payload never throws out of buildMessage', () => {
  const store = tmpStore();
  store.upsertIn('codecs', 'c', { filter: '#', codec: 'cbor' });
  const m = managerWithCodecs(store);
  const t0 = Date.now();
  for (const buf of [Buffer.alloc(200_000, 0x81), H('9b ffffffffffffffff'), Buffer.alloc(250_000, 0x9f)]) {
    const msg = m.buildMessage('b1', row('x', buf));
    assert.ok(msg.codecError, 'error recorded');
  }
  assert.ok(Date.now() - t0 < 2000);
});

// ---- test box helpers -------------------------------------------------------------

test('test decode and payload parsing for the Codecs test box', () => {
  assert.deepStrictEqual(payloadBytes('0x08 0x96:01', 'hex'), H('089601'));
  assert.deepStrictEqual(payloadBytes('CJYB', 'base64'), H('089601'));
  assert.deepStrictEqual(payloadBytes('-_8', 'base64'), H('fbff'));
  assert.throws(() => payloadBytes('0g', 'hex'), /not valid hex/);
  assert.throws(() => payloadBytes('abc', 'hex'), /odd number/);
  const ok = testDecode({ codec: 'protobuf', schemaText: 'syntax="proto3"; message P { int32 rpm = 1; }' }, H('089601'));
  assert.deepStrictEqual(ok, { ok: true, bytes: 3, codec: 'protobuf', value: { rpm: 150 } });
  assert.match(testDecode({ codec: 'protobuf', schemaText: 'message {' }, H('00')).error, /does not parse/);
  assert.strictEqual(testDecode({ codec: 'protobuf', schemaText: 'message {' }, H('00')).schemaError, true);
  assert.deepStrictEqual(testDecode({ codec: 'auto' }, H('a1616101')), { ok: true, bytes: 4, codec: 'cbor', value: { a: 1 } });
  assert.match(testDecode({ codec: 'auto' }, Buffer.from('{"a":1}')).error, /valid UTF-8 text/);
  assert.match(testDecode({ codec: 'avro', schemaText: 'x'.repeat(200 * 1024) }, H('00')).error, /larger than 128 KiB/);
});

test('helpers: decimal strings and ISO times', () => {
  assert.strictEqual(decimalString(12345n, -2), '123.45');
  assert.strictEqual(decimalString(-5n, -3), '-0.005');
  assert.strictEqual(decimalString(7n, 2), '700');
  assert.strictEqual(isoFromSeconds(0, 0), '1970-01-01T00:00:00.000Z');
  assert.strictEqual(isoFromSeconds(0, 123000), '1970-01-01T00:00:00.000123Z');
  assert.strictEqual(isoFromSeconds(1e20, 0), null);
});
