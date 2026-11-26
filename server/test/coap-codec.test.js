'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const msg = require('../drivers/coap/message');
const cbor = require('../drivers/coap/cbor');
const senml = require('../drivers/coap/senml');
const linkformat = require('../drivers/coap/linkformat');
const selector = require('../drivers/coap/selector');
const { parseAddress, formatAddress } = require('../drivers/coap/address');
const value = require('../drivers/coap/value');

const H = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ---- message codec ------------------------------------------------------------------

test('encodeGet produces the RFC 7252 wire format', () => {
  // GET /temp, CON, mid 0x1234, token a1b2: 42 01 1234 a1b2 | Uri-Path "temp" (11 -> delta 11, len 4) = b4 74656d70
  const buf = msg.encodeGet({ mid: 0x1234, token: H('a1b2'), path: ['temp'] });
  assert.equal(buf.toString('hex'), '4201' + '1234' + 'a1b2' + 'b4' + '74656d70');
  const d = msg.decode(buf);
  assert.equal(d.type, msg.TYPE.CON);
  assert.equal(d.code, msg.GET);
  assert.equal(d.mid, 0x1234);
  assert.deepEqual(d.options.map((o) => [o.num, o.value.toString()]), [[11, 'temp']]);
});

test('options are delta-encoded in number order with extended deltas and lengths', () => {
  const long = 'x'.repeat(20); // length 20 needs the 1-byte extension
  const buf = msg.encodeGet({ mid: 1, token: H('01'), observe: 0, path: ['a', long], query: ['k=v'], accept: 60, block2: { num: 2, szx: 6 } });
  const d = msg.decode(buf);
  assert.deepEqual(d.options.map((o) => o.num), [6, 11, 11, 15, 17, 23]);
  assert.equal(d.options[2].value.toString(), long);
  const b = msg.decodeBlock(msg.option(d, msg.OPT.BLOCK2));
  assert.deepEqual(b, { num: 2, more: false, szx: 6, size: 1024 });
  // Size2 (28) after Block2 (23) needs a delta of 5; Proxy-Scheme (39) from 28 needs 11; a 300 byte value needs the 2-byte length
  const raw = msg.encode({ type: 0, code: 69, mid: 9, token: Buffer.alloc(0), options: [{ num: 60, value: Buffer.alloc(300, 1) }] });
  const r = msg.decode(raw);
  assert.equal(r.options[0].num, 60);
  assert.equal(r.options[0].value.length, 300);
});

test('observe values encode in the fewest bytes', () => {
  assert.equal(msg.encodeUint(0).length, 0);
  assert.equal(msg.encodeUint(255).toString('hex'), 'ff');
  assert.equal(msg.encodeUint(256).toString('hex'), '0100');
  assert.equal(msg.decodeUint(H('010203')), 66051);
});

test('responses decode with payload, token and options', () => {
  const buf = H('6445abcd' + '01020304' + 'c100' + 'ff' + Buffer.from('21.5').toString('hex'));
  // 0x64: ver 1, type ACK(2), tkl 4 ; need exactly 4 token bytes
  const d = msg.decode(buf);
  assert.equal(d.type, msg.TYPE.ACK);
  assert.equal(msg.codeString(d.code), '2.05');
  assert.equal(d.payload.toString(), '21.5');
  assert.equal(msg.optionUint(d, msg.OPT.CONTENT_FORMAT), 0);
});

test('code names', () => {
  assert.equal(msg.codeLabel(0x84), '4.04 Not Found');
  assert.equal(msg.codeLabel(0xa3), '5.03 Service Unavailable');
  assert.equal(msg.codeLabel(0x45), '2.05 Content');
  assert.equal(msg.codeLabel(0x9f), '4.31');
});

test('malformed datagrams are rejected', () => {
  const bad = {
    'shorter than header': '4001',
    'wrong version': '8001 0001',
    'token length 9': '4901 0001 0102030405060708 09',
    'token longer than datagram': '4401 0001 0102',
    'empty message with a token': '6200 0001 0102',
    'empty message with content': '6000 0001 ff',
    'reserved option delta 15': '4001 0001 f1 00',
    'reserved option length 15': '4001 0001 1f',
    'option value past end': '4001 0001 b5 7465',
    'truncated extended delta': '4001 0001 d0',
    'payload marker with no payload': '4001 0001 ff',
    'version 0 with options': '0001 0001'
  };
  for (const [name, hex] of Object.entries(bad)) {
    assert.throws(() => msg.decode(H(hex)), msg.CoapFormatError, name);
  }
});

test('only GET and the empty message can be encoded or sent', () => {
  // No method parameter exists: whatever a caller passes, the code is GET.
  const buf = msg.encodeGet({ mid: 1, token: H('01'), path: ['x'], code: 3, method: 'PUT' });
  assert.equal(buf[1], msg.GET);
  assert.equal(msg.encodeEmpty(msg.TYPE.ACK, 1)[1], 0);
  assert.equal(msg.encodePing(1)[1], 0);
  assert.doesNotThrow(() => msg.assertReadOnlyDatagram(buf));
  assert.doesNotThrow(() => msg.assertReadOnlyDatagram(msg.encodeEmpty(msg.TYPE.RST, 1)));
  // POST 0.02, PUT 0.03, DELETE 0.04, FETCH 0.05, PATCH 0.06, iPATCH 0.07 and any response code
  for (const c of [2, 3, 4, 5, 6, 7, 0x45, 0x84, 0xa3]) {
    const raw = Buffer.from([0x41, c, 0, 1, 1]);
    assert.throws(() => msg.assertReadOnlyDatagram(raw), msg.CoapReadOnlyError, `code ${c}`);
  }
  assert.throws(() => msg.assertReadOnlyDatagram(Buffer.from('hello')), msg.CoapReadOnlyError);
  const exported = Object.keys(msg);
  for (const name of ['encodePut', 'encodePost', 'encodeDelete', 'encodeFetch', 'encodePatch', 'encodeRequest']) {
    assert.ok(!exported.includes(name), name);
  }
});

test('block options: encode, decode, szx 7 is reserved', () => {
  assert.equal(msg.encodeBlock(0, false, 6).toString('hex'), '06');
  assert.equal(msg.encodeBlock(1, true, 2).toString('hex'), '1a');
  assert.deepEqual(msg.decodeBlock(H('1a')), { num: 1, more: true, szx: 2, size: 64 });
  assert.deepEqual(msg.decodeBlock(H('')), { num: 0, more: false, szx: 0, size: 16 });
  assert.throws(() => msg.decodeBlock(H('07')), msg.CoapFormatError);
  assert.throws(() => msg.decodeBlock(H('01020304')), msg.CoapFormatError);
  assert.equal(msg.szxForSize(512), 5);
  assert.throws(() => msg.szxForSize(100), RangeError);
});

test('observe freshness follows RFC 7641 section 3.4', () => {
  const f = msg.observeIsFresh;
  assert.equal(f(undefined, 0, 5, 0), true);
  assert.equal(f(10, 1000, 11, 1001), true);
  assert.equal(f(10, 1000, 9, 1001), false); // reordered
  assert.equal(f(10, 1000, 10, 1001), false); // duplicate
  assert.equal(f(0xfffffe, 1000, 1, 1001), true); // wrapped around 2^24
  assert.equal(f(1, 1000, 0xfffffe, 1001), false); // an old pre-wrap value after the wrap
  assert.equal(f(100, 1000, 3, 1000 + 129000), true); // 128 s escape hatch
  assert.equal(f(100, 1000, 3, 1000 + 120000), false);
});

// ---- CBOR (vectors from RFC 8949 appendix A) -----------------------------------------------

test('cbor: RFC 8949 appendix A examples', () => {
  const cases = [
    ['00', 0], ['01', 1], ['0a', 10], ['17', 23], ['1818', 24], ['1819', 25], ['1864', 100], ['1903e8', 1000], ['1a000f4240', 1000000],
    ['1b000000e8d4a51000', 1000000000000], ['1bffffffffffffffff', '18446744073709551615'], ['c249010000000000000000', '18446744073709551616'],
    ['3bffffffffffffffff', '-18446744073709551616'], ['c349010000000000000000', '-18446744073709551617'],
    ['20', -1], ['29', -10], ['3863', -100], ['3903e7', -1000],
    ['f90000', 0], ['f98000', -0], ['f93c00', 1], ['f93e00', 1.5], ['f97bff', 65504], ['f90001', 5.960464477539063e-8], ['f90400', 6.103515625e-5], ['f9c400', -4],
    ['fa47c35000', 100000], ['fa7f7fffff', 3.4028234663852886e38], ['fb3ff199999999999a', 1.1], ['fb7e37e43c8800759c', 1e300], ['fbc010666666666666', -4.1],
    ['f97c00', Infinity], ['f9fc00', -Infinity], ['fa7f800000', Infinity], ['fb7ff0000000000000', Infinity],
    ['f4', false], ['f5', true], ['f6', null], ['f7', null], ['f0', 16], ['f8ff', 255],
    ['c11a514b67b0', 1363896240], ['c1fb41d452d9ec200000', 1363896240.5], ['d74401020304', '01020304'],
    ['40', ''], ['4401020304', '01020304'], ['60', ''], ['6161', 'a'], ['6449455446', 'IETF'], ['62225c', '"\\'], ['62c3bc', 'ü'], ['63e6b0b4', '水'], ['64f0908591', '𐅑'],
    ['80', []], ['83010203', [1, 2, 3]], ['8301820203820405', [1, [2, 3], [4, 5]]],
    ['5f42010243030405ff', '0102030405'], ['7f657374726561646d696e67ff', 'streaming'], ['9fff', []], ['9f018202039f0405ffff', [1, [2, 3], [4, 5]]], ['83018202039f0405ff', [1, [2, 3], [4, 5]]]
  ];
  assert.deepEqual({ ...cbor.decode(H('bf61610161629f0203ffff')) }, { a: 1, b: [2, 3] });
  for (const [hex, want] of cases) {
    const got = cbor.decode(H(hex));
    assert.deepEqual(got, want, hex);
    if (Object.is(want, -0)) assert.ok(Object.is(got, -0));
  }
  assert.ok(Number.isNaN(cbor.decode(H('f97e00'))));
  assert.ok(Number.isNaN(cbor.decode(H('fa7fc00000'))));
  // maps use string keys; integer keys are stringified
  assert.deepEqual({ ...cbor.decode(H('a201020304')) }, { 1: 2, 3: 4 });
  assert.deepEqual({ ...cbor.decode(H('a26161016162820203')) }, { a: 1, b: [2, 3] });
  assert.equal(Object.getPrototypeOf(cbor.decode(H('a0'))), null);
  // decimal fraction 273.15 as [-2, 27315] and a bigfloat
  assert.equal(cbor.decode(H('c482211a00006ab3')), 27315 * 10 ** -2);
  assert.equal(cbor.decode(H('c5822003')), 3 * 2 ** -1);
});

test('cbor: malformed and hostile input is an error, not a hang or a crash', () => {
  const bad = {
    truncated: '1a0000',
    'trailing data': '0000',
    'lone break': 'ff',
    'break inside definite array': '82 01 ff',
    'two-byte simple below 32': 'f810',
    'reserved additional info': '1c',
    'invalid utf8': '62c328',
    'array longer than the data': '9b00000000ffffffff',
    'map longer than the data': 'bb0000000000ffffff',
    'string longer than the data': '5a000fffff00',
    '64-bit length': '5bffffffffffffffff',
    'indefinite string with wrong chunk': '5f6161ff',
    'nested indefinite string': '5f5f4101ffff',
    'map key is a map': 'a1a0 01'.replace(' ', ''),
    'bignum with a text body': 'c26161',
    'malformed decimal fraction': 'c401',
    'reserved simple': 'fc',
    empty: ''
  };
  for (const [name, hex] of Object.entries(bad)) {
    assert.throws(() => cbor.decode(H(hex)), cbor.CborError, name);
  }
  // nesting bomb: 100000 nested arrays
  assert.throws(() => cbor.decode(Buffer.alloc(100000, 0x81)), cbor.CborError);
  // item bomb: more items than allowed
  assert.throws(() => cbor.decode(Buffer.concat([Buffer.from([0x9a, 0x00, 0x20, 0x00, 0x00]), Buffer.alloc(0x200000, 0x01)]), { maxItems: 1000 }), cbor.CborError);
  // bignum bomb: one 1 MiB bignum would cost seconds of decimal conversion (quadratic) in the driver
  const n = 1 << 20;
  const big = Buffer.alloc(n + 6, 0xff);
  big[0] = 0xc2;
  big[1] = 0x5a;
  big.writeUInt32BE(n, 2);
  const t0 = Date.now();
  assert.throws(() => cbor.decode(big), cbor.CborError);
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0} ms`);
  // ordinary bignums still decode
  assert.equal(cbor.decode(H('c249010000000000000000')), '18446744073709551616');
});

// ---- SenML ---------------------------------------------------------------------------------

test('senml: base name, base unit, base time and base value resolve (RFC 8428 examples)', () => {
  const recs = senml.parsePack([
    { bn: 'urn:dev:ow:10e2073a0108006:', bt: 1276020076.001, bu: 'A', bver: 5, n: 'voltage', u: 'V', v: 120.1 },
    { n: 'current', t: -5, v: 1.2 },
    { n: 'current', t: -4, v: 1.3 },
    { n: 'current', t: 0, v: 1.4 }
  ]);
  assert.equal(recs.length, 4);
  assert.equal(recs[0].name, 'urn:dev:ow:10e2073a0108006:voltage');
  assert.equal(recs[0].unit, 'V');
  assert.equal(recs[1].unit, 'A'); // base unit
  assert.equal(recs[1].time, 1276020076.001 - 5);
  assert.equal(recs[1].relative, false);
  assert.equal(senml.selectRecord(recs, 'urn:dev:ow:10e2073a0108006:current').value, 1.4); // latest of a series
  // base value is added to v
  const bv = senml.parsePack([{ bn: 'x/', bv: 10, n: 'a', v: 1 }, { n: 'b', v: 2 }]);
  assert.deepEqual(bv.map((r) => [r.name, r.value]), [['x/a', 11], ['x/b', 12]]);
  // value types, base-only records, relative time
  const mixed = senml.parsePack([{ bn: 'dev:' }, { n: 'on', vb: true }, { n: 'mode', vs: 'auto' }, { n: 'blob', vd: 'AQID', t: 5 }, { n: 'sum', s: 7 }]);
  assert.deepEqual(mixed.map((r) => [r.name, r.kind]), [['dev:on', 'bool'], ['dev:mode', 'string'], ['dev:blob', 'data'], ['dev:sum', null]]);
  assert.equal(mixed[2].value, '010203');
  assert.equal(mixed[2].relative, true);
  assert.equal(mixed[3].sum, 7);
  assert.throws(() => senml.selectRecord(mixed, 'dev:nope'), /no SenML record named "dev:nope"/);
  assert.throws(() => senml.selectRecord(mixed), /add a selector/);
  assert.equal(senml.selectRecord(senml.parsePack([{ n: 'only', v: 3 }])).value, 3);
});

test('senml: invalid packs are refused', () => {
  const bad = [
    ['not an array', { n: 'a', v: 1 }],
    ['empty', []],
    ['record not an object', [1]],
    ['must-understand field', [{ n: 'a', v: 1, 'x_': 1 }]],
    ['two value fields', [{ n: 'a', v: 1, vs: 'x' }]],
    ['v not a number', [{ n: 'a', v: '1' }]],
    ['bver too new', [{ bver: 11, n: 'a', v: 1 }]],
    ['n not a string', [{ n: 1, v: 1 }]],
    ['vb not a boolean', [{ n: 'a', vb: 1 }]]
  ];
  for (const [name, pack] of bad) assert.throws(() => senml.parsePack(pack), senml.SenmlError, name);
  // unknown optional fields are ignored
  assert.equal(senml.parsePack([{ n: 'a', v: 1, extra: 5 }]).length, 1);
});

test('senml: the CBOR form uses integer labels', () => {
  const { cbor: enc } = require('./support/coapSimulator');
  const pack = enc([
    new Map([[-2, 'dev:'], [-4, 'Cel'], [-3, 1700000000], [0, 't'], [2, 1.5]]),
    new Map([[0, 'on'], [4, true]]),
    new Map([[0, 'blob'], [8, Buffer.from([9, 8])]]),
    new Map([[0, 'must'], [2, 1], ['foo_', 1]])
  ].slice(0, 3));
  const recs = senml.parsePack(cbor.decode(pack), { cbor: true });
  assert.deepEqual(recs.map((r) => [r.name, r.kind, r.value, r.unit]), [['dev:t', 'number', 1.5, 'Cel'], ['dev:on', 'bool', true, 'Cel'], ['dev:blob', 'data', '0908', 'Cel']]);
  assert.equal(recs[0].time, 1700000000);
  const bad = enc([new Map([[0, 'must'], [2, 1], ['foo_', 1]])]);
  assert.throws(() => senml.parsePack(cbor.decode(bad), { cbor: true }), /must-understand/);
});

// ---- link format ---------------------------------------------------------------------------------

test('link-format: attributes, quoted lists, commas and semicolons inside quotes', () => {
  const { links, skipped } = linkformat.parse(
    '</sensors/temp>;rt="temperature-c";if="sensor";ct=0;obs,</a/b?x=1>;ct="0 50";sz=1200;title="A, B; C",</.well-known/core>,<coap://host:5683/abs>;ct=42,bogus,<rel>'
  );
  assert.equal(skipped, 2);
  assert.equal(links.length, 4);
  assert.deepEqual(links[0], { uri: '/sensors/temp', path: '/sensors/temp', query: '', attrs: { rt: 'temperature-c', if: 'sensor', ct: '0', obs: true }, rt: ['temperature-c'], if: ['sensor'], ct: [0], obs: true });
  assert.equal(links[1].path, '/a/b');
  assert.equal(links[1].query, 'x=1');
  assert.deepEqual(links[1].ct, [0, 50]);
  assert.equal(links[1].sz, 1200);
  assert.equal(links[1].title, 'A, B; C');
  assert.equal(links[2].path, '/.well-known/core');
  assert.equal(links[3].path, '/abs');
  assert.equal(links[0].obs, true);
  assert.equal(links[1].obs, false);
  assert.deepEqual(linkformat.parse('').links, []);
});

test('link-format: an enormous listing is capped', () => {
  const text = Array.from({ length: linkformat.MAX_LINKS + 50 }, (_, i) => `</r${i}>`).join(',');
  const r = linkformat.parse(text);
  assert.equal(r.links.length, linkformat.MAX_LINKS);
  assert.equal(r.skipped, 50);
});

// ---- selector ------------------------------------------------------------------------------------

test('selector: members, indexes, quoted keys', () => {
  const doc = JSON.parse('{"a":{"b":[10,{"c":"x"}]},"a.b":1,"k y":2,"list":[[1,2],[3]]}');
  const at = (s) => selector.apply(doc, selector.parse(s));
  assert.equal(at('a.b[0]'), 10);
  assert.equal(at('a.b[1].c'), 'x');
  assert.equal(at('["a.b"]'), 1);
  assert.equal(at('["k y"]'), 2);
  assert.equal(at('list[0][1]'), 2);
  assert.deepEqual(at('list[1]'), [3]);
  assert.throws(() => at('a.zz'), /no member "zz" under a/);
  assert.throws(() => at('a.b[5]'), /no element \[5\] under a\.b \(length 2\)/);
  assert.throws(() => at('a[0]'), /no element/);
  assert.throws(() => at('list.x'), /no member/);
});

test('selector: syntax errors and prototype access are refused', () => {
  for (const bad of ['.a', 'a.', 'a..b', 'a.[0]', 'a[', 'a[-1]', 'a[x]', 'a["x', 'a["x"', '__proto__', 'a.constructor', 'a.prototype.b', '["__proto__"]', 'a b', 'a\u0001', 'a[1000000000000]', 'a?']) {
    assert.throws(() => selector.parse(bad), selector.SelectorError, JSON.stringify(bad));
  }
  assert.throws(() => selector.parse('a.'.repeat(20) + 'b'), /more than 16 steps/);
  assert.throws(() => selector.parse('x'.repeat(300)), /longer than/);
  // inherited properties are never read
  assert.throws(() => selector.apply({}, [{ key: 'toString' }]), /no member/);
  assert.throws(() => selector.apply(JSON.parse('{"__proto__":{"x":1}}'), selector.parse('x')), /no member/);
  assert.equal(selector.isPath('a.b'), true);
  assert.equal(selector.isPath('urn:dev/x'), false);
});

test('selector: leaves for browsing', () => {
  const l = selector.leaves({ t: 1, n: { x: [true, 'a'] }, 'a b': 2 });
  assert.deepEqual(l.map((x) => x.selector), ['t', 'n.x[0]', 'n.x[1]', '["a b"]']);
});

// ---- address ------------------------------------------------------------------------------------

test('address: path, query, selector and observe prefix', () => {
  const a = parseAddress('observe:/sensors/temp%20x/v?unit=c&x=%26#temperature.value');
  assert.equal(a.observe, true);
  assert.deepEqual(a.segments, ['sensors', 'temp x', 'v']);
  assert.deepEqual(a.query, ['unit=c', 'x=&']);
  assert.equal(a.selector, 'temperature.value');
  assert.equal(formatAddress(a), 'observe:/sensors/temp%20x/v?unit=c&x=%26#temperature.value');
  assert.deepEqual(parseAddress('/').segments, []);
  assert.deepEqual(parseAddress('/a/').segments, ['a', '']);
  assert.equal(parseAddress('/senml#urn:dev:ow:10e2/temp').selector, 'urn:dev:ow:10e2/temp');
  assert.equal(parseAddress('  /x ').uri, '/x');
});

test('address: coaps is refused with an explanation, other forms with a hint', () => {
  assert.throws(() => parseAddress('coaps://host/x'), /DTLS/);
  assert.throws(() => parseAddress('coap://host/x'), /path only/);
  for (const bad of ['', '   ', 'temp', '/a/../b', '/a/./b', '/a%zz', '/a#', '/a\u0001b', `/${'x'.repeat(300)}`, '/' + 'a/'.repeat(40)]) {
    assert.throws(() => parseAddress(bad), undefined, JSON.stringify(bad.slice(0, 20)));
  }
});

// ---- bodies and coercion -------------------------------------------------------------------------------

test('parseBody by content format, with detection when there is none', () => {
  assert.equal(value.parseBody(Buffer.from('21.5'), 0).text, '21.5');
  assert.equal(value.parseBody(Buffer.from('{"a":1}'), 50).doc.a, 1);
  assert.equal(value.parseBody(Buffer.from('﻿{"a":1}'), 50).doc.a, 1);
  assert.equal(value.parseBody(H('a1616101'), 60).doc.a, 1);
  assert.equal(value.parseBody(H('deadbeef'), 42).hex, 'deadbeef');
  assert.equal(value.parseBody(H('01'), 999).format, 'octet');
  assert.equal(value.parseBody(Buffer.from('hello'), undefined).format, 'text');
  assert.equal(value.parseBody(H('ff00fe'), undefined).format, 'octet');
  assert.equal(value.parseBody(Buffer.alloc(0), undefined).text, '');
  assert.equal(value.parseBody(Buffer.from('[{"n":"a","v":1}]'), 110).records[0].value, 1);
  assert.throws(() => value.parseBody(Buffer.from('{bad'), 50), value.ValueError);
  assert.throws(() => value.parseBody(H('ff'), 0), /not valid UTF-8/);
  assert.throws(() => value.parseBody(H('1a00'), 60), /application\/cbor/);
  assert.throws(() => value.parseBody(Buffer.from('[1]'), 110), /record 0 is not an object/);
});

test('coerce: number, bool, string and natural types', () => {
  const c = (v, type, adj, text) => value.coerce({ value: v, text }, type, adj);
  assert.deepEqual(c('21.5', 'number', undefined, true), { v: 21.5, type: 'float64' });
  assert.deepEqual(c(true, 'number'), { v: 1, type: 'float64' });
  assert.deepEqual(c(10, 'number', { scale: 0.1, offset: 1 }), { v: 2, type: 'float64' });
  assert.deepEqual(c('1e3', 'number'), { v: 1000, type: 'float64' });
  assert.deepEqual(c(1, 'bool'), { v: true, type: 'bool' });
  assert.deepEqual(c(0, 'bool'), { v: false, type: 'bool' });
  assert.deepEqual(c('OFF', 'bool'), { v: false, type: 'bool' });
  assert.deepEqual(c('yes', 'bool'), { v: true, type: 'bool' });
  assert.deepEqual(c(5, 'string'), { v: '5', type: 'string' });
  assert.deepEqual(c({ a: 1 }, 'string'), { v: '{"a":1}', type: 'string' });
  assert.deepEqual(c([1, 2], undefined), { v: '[1,2]', type: 'string' });
  assert.deepEqual(c('42', undefined, undefined, true), { v: 42, type: 'float64' });
  assert.deepEqual(c('true', undefined, undefined, true), { v: true, type: 'bool' });
  assert.deepEqual(c('42', undefined, undefined, false), { v: '42', type: 'string' }); // a JSON string stays a string
  assert.deepEqual(c('abc', undefined, undefined, true), { v: 'abc', type: 'string' });
  for (const [v, type] of [['abc', 'number'], ['', 'number'], [NaN, 'number'], [Infinity, 'number'], [null, 'number'], ['maybe', 'bool'], [{ a: 1 }, 'number'], [[1], 'bool'], [1e308, 'number']]) {
    assert.throws(() => c(v, type, v === 1e308 ? { scale: 10 } : undefined), value.ValueError, `${v} as ${type}`);
  }
  assert.equal(value.normalizeType('float64'), 'number');
  assert.equal(value.normalizeType('Boolean'), 'bool');
  assert.equal(value.normalizeType(''), undefined);
  assert.equal(value.normalizeType('wat'), undefined);
});
