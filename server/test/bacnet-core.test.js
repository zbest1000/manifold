'use strict';

/**
 * BACnet/IP pure core: tag encoding/decoding, framing, the read-only allowlist, addresses,
 * planning, value decoding and quality. Golden vectors are written out by hand from clause 20
 * (and checked against the independent simulator encoder where noted).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const enc = require('../drivers/bacnet/encoding');
const frame = require('../drivers/bacnet/frame');
const address = require('../drivers/bacnet/address');
const planner = require('../drivers/bacnet/planner');
const decode = require('../drivers/bacnet/decode');
const errors = require('../drivers/bacnet/errors');
const { unitInfo } = require('../drivers/bacnet/units');
const bacnet = require('../drivers/bacnet');
const { encodeValue } = require('./support/bacnetSimulator');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ---- application tags ------------------------------------------------------------------------

test('every application tag decodes (golden vectors)', () => {
  const cases = [
    ['00', 'null', null],
    ['10', 'boolean', false],
    ['11', 'boolean', true],
    ['21 05', 'unsigned', 5],
    ['22 01 00', 'unsigned', 256],
    ['24 ff ff ff ff', 'unsigned', 4294967295],
    ['25 05 01 00 00 00 00', 'unsigned', 4294967296],
    ['31 ff', 'signed', -1],
    ['32 fb 2e', 'signed', -1234],
    ['34 80 00 00 00', 'signed', -2147483648],
    ['44 41 ac 00 00', 'real', 21.5],
    ['55 08 40 09 21 fb 54 44 2d 18', 'double', Math.PI],
    ['63 de ad be', 'octet-string', 'deadbe'],
    ['75 05 00 48 65 6c 6c', 'character-string', 'Hell'],
    ['83 05 a0 00', 'bit-string', [true, false, true]], // 5 unused bits of 16 -> 11 bits; first 3 shown below
    ['91 02', 'enumerated', 2],
    ['a4 7e 0c 19 05', 'date', '2026-12-25'],
    ['b4 07 1e 00 00', 'time', '07:30:00.00'],
    ['c4 00 00 00 03', 'object-identifier', { type: 0, instance: 3 }],
    ['c4 02 00 04 d2', 'object-identifier', { type: 8, instance: 1234 }],
  ];
  for (const [h, tag, value] of cases) {
    const buf = hex(h);
    const { items } = enc.decodeValues(buf, 0, buf.length);
    assert.equal(items.length, 1, h);
    assert.equal(items[0].tag, tag, h);
    if (tag === 'bit-string') assert.deepEqual(items[0].value.slice(0, 3), value, h);
    else if (tag === 'real') assert.equal(items[0].value, value);
    else assert.deepEqual(items[0].value, value, h);
  }
});

test('character sets: UTF-8, UCS-2 (big endian), ISO 8859-1, UCS-4, DBCS reported', () => {
  const utf8 = enc.decodeCharacterString(Buffer.concat([Buffer.from([0]), Buffer.from('Grüße ✓', 'utf8')]));
  assert.deepEqual(utf8, { value: 'Grüße ✓', charset: 'utf-8' });
  const ucs2 = Buffer.from('Grüße', 'utf16le');
  ucs2.swap16();
  assert.deepEqual(enc.decodeCharacterString(Buffer.concat([Buffer.from([4]), ucs2])), { value: 'Grüße', charset: 'ucs-2' });
  assert.deepEqual(enc.decodeCharacterString(Buffer.concat([Buffer.from([5]), Buffer.from('Café', 'latin1')])), { value: 'Café', charset: 'iso-8859-1' });
  assert.equal(enc.decodeCharacterString(hex('03 0001f600')).value, '😀');
  assert.equal(enc.decodeCharacterString(hex('01 03b5 41 42')).charset, 'dbcs');
  assert.throws(() => enc.decodeCharacterString(hex('04 00')), /odd/);
  assert.throws(() => enc.decodeCharacterString(Buffer.alloc(0)), /character set/);
});

test('unspecified date and time fields read as *', () => {
  assert.equal(enc.decodeDate(hex('ff ff ff ff')), '*-*-*');
  assert.equal(enc.decodeDate(hex('7e 0d 20 ff')), '2026-odd-last');
  assert.equal(enc.decodeTime(hex('0c ff ff ff')), '12:*:*.*');
});

test('extended length and extended tag numbers', () => {
  const long = 'x'.repeat(300);
  const buf = encodeValue({ t: 'str', v: long });
  const { items } = enc.decodeValues(buf, 0, buf.length);
  assert.equal(items[0].value, long);
  const t = enc.readTag(hex('f9 20 05'), 0); // context, extended tag number 32, length 1
  assert.equal(t.tagNumber, 32);
  assert.equal(t.context, true);
  assert.equal(enc.contextUnsigned(1, 85).toString('hex'), '1955');
  assert.equal(enc.contextUnsigned(1, 371).toString('hex'), '1a0173');
});

test('constructed values: nested opening/closing, context primitives kept as hex', () => {
  const buf = hex('0e 21 01 1c 00 00 00 05 0f 44 3f 80 00 00');
  const { items } = enc.decodeValues(buf, 0, buf.length);
  assert.deepEqual(items[0], { context: 0, items: [{ tag: 'unsigned', value: 1 }, { context: 1, hex: '00000005' }] });
  assert.equal(items[1].value, 1);
});

test('malformed and truncated tags are errors, not garbage values', () => {
  const bad = ['44 41 ac', '25', '75 09 00 41', '0e 21 01', '1f', 'd1 00', '42 00 00', '1e'];
  for (const h of bad) {
    const buf = hex(h);
    assert.throws(() => enc.decodeValues(buf, 0, buf.length), enc.BacnetDecodeError, h);
  }
});

test('simulator value encoder and driver decoder agree for every value type', () => {
  const specs = [
    [{ t: 'null' }, null],
    [{ t: 'bool', v: true }, true],
    [{ t: 'uint', v: 70000 }, 70000],
    [{ t: 'signed', v: -40000 }, -40000],
    [{ t: 'real', v: -2.5 }, -2.5],
    [{ t: 'double', v: 1e300 }, 1e300],
    [{ t: 'octet', v: '0102' }, '0102'],
    [{ t: 'str', v: 'ÄÖÜ', charset: 'ucs2' }, 'ÄÖÜ'],
    [{ t: 'bits', v: [false, true, false, true] }, [false, true, false, true]],
    [{ t: 'enum', v: 3 }, 3],
    [{ t: 'date', year: 2000, month: 1, day: 2 }, '2000-01-02'],
    [{ t: 'time', h: 23, m: 59, s: 58, hs: 99 }, '23:59:58.99'],
    [{ t: 'oid', type: 19, inst: 4194302 }, { type: 19, instance: 4194302 }],
  ];
  for (const [spec, want] of specs) {
    const buf = encodeValue(spec);
    const { items } = enc.decodeValues(buf, 0, buf.length);
    assert.deepEqual(items[0].value, want, spec.t);
  }
});

// ---- framing and the read-only allowlist -----------------------------------------------------

test('ReadProperty request bytes (BVLC + NPDU + APDU)', () => {
  const p = frame.readPropertyPacket(1, { objectType: 0, instance: 3, property: 85 });
  assert.equal(p.toString('hex'), '810a0011' + '0104' + '0005010c' + '0c000000031955');
  assert.equal(p[0], 0x81);
  assert.equal(p[1], 0x0a, 'Original-Unicast-NPDU only');
  assert.equal(p.readUInt16BE(2), p.length);
  assert.deepEqual([...p.subarray(4, 6)], [0x01, 0x04], 'NPDU version 1, expecting reply');
  assert.deepEqual([...p.subarray(6, 10)], [0x00, 0x05, 0x01, 0x0c], 'confirmed, unsegmented, max APDU 1476, invoke 1, readProperty');
  assert.equal(p.subarray(10).toString('hex'), '0c000000031955');
});

test('ReadProperty with array index, routed NPDU with DNET/DADR and hop count', () => {
  const p = frame.readPropertyPacket(9, { objectType: 8, instance: 1234, property: 76, index: 0 }, { route: { network: 5, mac: Buffer.from([12]) } });
  assert.deepEqual([...p.subarray(4, 12)], [0x01, 0x24, 0x00, 0x05, 0x01, 0x0c, 0xff, 0x00], 'control: DNET + expecting reply; DNET 5, DLEN 1, DADR 12, hop 255');
  assert.ok(p.toString('hex').endsWith('0c020004d2194c2900'));
});

test('ReadPropertyMultiple request encodes object specs and array indexes', () => {
  const apdu = frame.confirmedApdu({ invokeId: 7, service: 14, params: frame.encodeReadPropertyMultipleParams([{ objectType: 0, instance: 1, refs: [{ property: 85 }, { property: 111 }] }, { objectType: 8, instance: 1234, refs: [{ property: 76, index: 3 }] }]) });
  assert.equal(apdu.toString('hex'), '0005070e' + '0c00000001' + '1e' + '0955' + '096f' + '1f' + '0c020004d2' + '1e' + '094c' + '1903' + '1f');
});

test('Who-Is: unicast only, with and without limits', () => {
  assert.equal(frame.whoIsPacket().toString('hex'), '810a000801001008');
  assert.equal(frame.whoIsPacket({ low: 1234, high: 1234 }).subarray(6).toString('hex'), '1008' + '0a04d2' + '1a04d2');
  assert.throws(() => frame.whoIsPacket({ low: 5, high: 4 }), RangeError);
});

test('read-only allowlist: every non-read confirmed service, unconfirmed service and APDU type is refused', () => {
  for (let service = 0; service < 64; service++) {
    const apdu = frame.confirmedApdu({ invokeId: 1, service, params: Buffer.alloc(0) });
    if (service === 12 || service === 14) {
      assert.doesNotThrow(() => frame.encodePacket(apdu));
      continue;
    }
    assert.throws(() => frame.encodePacket(apdu), frame.BacnetReadOnlyError, `confirmed service ${service}`);
  }
  for (let service = 0; service < 16; service++) {
    const apdu = frame.unconfirmedApdu({ service, params: Buffer.alloc(0) });
    if (service === 8) continue;
    assert.throws(() => frame.encodePacket(apdu), frame.BacnetReadOnlyError, `unconfirmed service ${service}`);
  }
  for (const first of [0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]) {
    assert.throws(() => frame.encodePacket(Buffer.from([first, 1, 2, 3])), frame.BacnetReadOnlyError);
  }
  // A segmented confirmed request (even of a read service) is never sent.
  assert.throws(() => frame.encodePacket(Buffer.from([0x08, 0x05, 1, 12])), frame.BacnetReadOnlyError);
  // There is no encoder for a write service at all.
  for (const name of Object.keys(frame)) assert.doesNotMatch(name, /write|subscribe|reinit|communicationControl|create|delete/i);
});

test('received frames: BVLC length, forwarded NPDU, routed source, network reject, BVLC result', () => {
  assert.throws(() => frame.decodePacket(hex('81 0a 00 09 01 00 30')), frame.BacnetFramingError);
  assert.throws(() => frame.decodePacket(hex('82 0a 00 04')), /not BACnet/);
  const fwd = frame.decodePacket(hex('81 04 00 0e c0 a8 01 05 ba c0 01 00 10 08'));
  assert.equal(fwd.forwardedFrom, '192.168.1.5:47808');
  const routed = frame.decodePacket(hex('81 0a 00 0d 01 08 00 05 01 0c 30 07 0c'));
  assert.equal(routed.npdu.snet, 5);
  assert.deepEqual([...routed.npdu.sadr], [12]);
  const rej = frame.decodePacket(hex('81 0a 00 0a 01 80 03 01 00 09'));
  assert.equal(rej.networkMessage.type, 3);
  assert.equal(rej.networkMessage.network, 9);
  assert.match(rej.networkMessage.reasonText, /cannot reach/);
  assert.equal(frame.decodePacket(hex('81 00 00 06 00 30')).bvlcResult, 0x30);
});

test('APDU decoding: Error (plain and wrapped), Reject, Abort, segmented ComplexACK', () => {
  const e = frame.decodeApdu(hex('50 07 0c 91 02 91 20'));
  assert.deepEqual([e.type, e.invokeId, e.errorClass, e.errorCode], ['error', 7, 2, 32]);
  const wrapped = frame.decodeApdu(hex('50 07 0e 0e 91 01 91 1f 0f'));
  assert.deepEqual([wrapped.errorClass, wrapped.errorCode], [1, 31]);
  assert.deepEqual(frame.decodeApdu(hex('60 03 09')), { type: 'reject', invokeId: 3, reason: 9, body: Buffer.alloc(0) });
  const ab = frame.decodeApdu(hex('71 03 04'));
  assert.equal(ab.server, true);
  assert.equal(ab.reason, 4);
  const seg = frame.decodeApdu(hex('3c 05 00 01 0e 00'));
  assert.equal(seg.segmented, true);
  assert.throws(() => frame.decodeApdu(hex('50 07 0c 91')), frame.BacnetFramingError);
  assert.throws(() => frame.decodeApdu(hex('30 01')), frame.BacnetFramingError);
});

test('ReadPropertyMultiple-ACK with values and per-property errors', () => {
  const body = hex('0c00000001 1e 2955 4e 4441ac0000 4f 296f 4e 820400 4f 2967 5e 9102 9120 5f 1f');
  const r = frame.parseReadPropertyMultipleAck(body);
  assert.equal(r.length, 1);
  assert.equal(r[0].results[0].values[0].value, 21.5);
  assert.deepEqual(r[0].results[1].values[0].value, [false, false, false, false]);
  assert.deepEqual(r[0].results[2].error, { errorClass: 2, errorCode: 32 });
  assert.throws(() => frame.parseReadPropertyMultipleAck(hex('0c00000001 1e 2955 4e 4441ac0000')), frame.BacnetFramingError);
});

test('I-Am parse', () => {
  const iam = frame.parseIAm(hex('c4020004d2 2201e0 9103 2203e7'));
  assert.deepEqual(iam, { objectType: 8, instance: 1234, maxApdu: 480, segmentation: 3, vendorId: 999 });
  assert.throws(() => frame.parseIAm(hex('c4020004d2')), frame.BacnetFramingError);
});

// ---- addresses -------------------------------------------------------------------------------

test('addresses: names, numbers, short forms, properties and indexes', () => {
  const a = address.parseAddress('analog-input:3');
  assert.deepEqual([a.objectType, a.instance, a.property, a.index], [0, 3, 85, undefined]);
  assert.equal(address.parseAddress('analog-value:7/units').property, 117);
  const ol = address.parseAddress('device:1234/object-list[0]');
  assert.deepEqual([ol.objectType, ol.property, ol.index], [8, 76, 0]);
  assert.equal(address.parseAddress('130:5/85').objectType, 130);
  assert.equal(address.parseAddress('MSV:1').objectType, 19);
  assert.equal(address.parseAddress('analog_input:1/present_value').property, 85);
  assert.equal(address.formatAddress(address.parseAddress('av:7')), 'analog-value:7');
  assert.equal(address.formatAddress(address.parseAddress('device:1/76[2]')), 'device:1/object-list[2]');
  for (const bad of ['', 'analog-input', 'foo:1', 'analog-input:4194304', 'analog-input:1/bogus', 'analog-input:1[x]', '1024:1', 'ai:1/units/x']) {
    assert.throws(() => address.parseAddress(bad), Error, bad);
  }
});

test('validateTag and device config', () => {
  assert.equal(bacnet.validateTag({ key: 'k', address: 'ai:1', type: 'float32' }).ok, true);
  assert.equal(bacnet.validateTag({ key: 'k', address: 'ai:1' }).normalized.type, undefined);
  assert.match(bacnet.validateTag({ key: 'k', address: 'ai:1', type: 'REAL' }).error, /unknown type/);
  assert.throws(() => bacnet.createDriver({ host: '10.0.0.1', deviceInstance: 4194303 }), /deviceInstance/);
  assert.throws(() => bacnet.createDriver({ host: '10.0.0.1', network: 5 }), /mac is required/);
  assert.throws(() => bacnet.createDriver({ host: '10.0.0.1', mac: '12' }), /network is required/);
  assert.throws(() => bacnet.createDriver({ host: '10.0.0.1', options: { readMultiple: 'maybe' } }), /readMultiple/);
  assert.deepEqual([...bacnet.parseMac('12')], [12]);
  assert.deepEqual([...bacnet.parseMac('10.0.0.5:47809')], [10, 0, 0, 5, 0xba, 0xc1]);
  assert.deepEqual([...bacnet.parseMac('10.0.0.5')], [10, 0, 0, 5, 0xba, 0xc0]);
  assert.deepEqual([...bacnet.parseMac('0a:1b')], [0x0a, 0x1b]);
  assert.throws(() => bacnet.parseMac('300'), /0-255/);
  assert.throws(() => bacnet.parseMac('zz'), /not a MAC/);
  const d = bacnet.describe();
  assert.equal(d.protocol, 'bacnet-ip');
  assert.equal(d.experimental, true);
  assert.equal(d.defaultPort, 47808);
});

// ---- planning --------------------------------------------------------------------------------

function items(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({ key: `k${i}`, objectType: i % 3, instance: i, property: 85, withStatus: true, ...extra }));
}

test('planner: every item exactly once, requests and estimated replies within the APDU', () => {
  for (const maxApdu of [50, 128, 206, 480, 1024, 1476]) {
    for (const n of [1, 7, 100, 2000]) {
      const plan = planner.planRpm(items(n), { maxApdu, maxProperties: 500 });
      const seen = plan.flatMap((r) => r.items.map((i) => i.key)).sort();
      assert.deepEqual(seen, items(n).map((i) => i.key).sort());
      for (const r of plan) {
        if (r.items.length === 1) continue; // a lone item is sent even when its estimate is large
        const req = frame.confirmedApdu({ invokeId: 1, service: 14, params: frame.encodeReadPropertyMultipleParams(planner.rpmSpecs(r.items)) });
        assert.ok(req.length <= maxApdu, `request ${req.length} > ${maxApdu}`);
        const est = r.items.reduce((a, i) => a + planner.itemCost(i).rep + 7, 3);
        assert.ok(est <= maxApdu, `reply estimate ${est} > ${maxApdu}`);
      }
    }
  }
});

test('planner: maxProperties caps a request; same-object items share one spec', () => {
  const plan = planner.planRpm(items(40), { maxApdu: 1476, maxProperties: 8 });
  assert.ok(plan.every((r) => r.items.reduce((a, i) => a + planner.refsOf(i).length, 0) <= 8));
  const specs = planner.rpmSpecs([
    { key: 'a', objectType: 0, instance: 1, property: 85, withStatus: false },
    { key: 'b', objectType: 0, instance: 1, property: 117, withStatus: false },
  ]);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0].refs.map((r) => r.property), [85, 117]);
});

test('planner: bisect isolates the failing items, else halves', () => {
  const req = { id: 'x', kind: 'rpm', items: items(5) };
  const parts = planner.bisect(req, new Set(['k3']));
  assert.deepEqual(parts.map((p) => p.items.map((i) => i.key)), [['k0', 'k1', 'k2', 'k4'], ['k3']]);
  assert.deepEqual(planner.bisect(req).map((p) => p.items.length), [3, 2]);
  assert.equal(planner.bisect({ kind: 'rpm', items: items(1) }), null);
});

// ---- values and quality ----------------------------------------------------------------------

test('natural values: binary present-value is bool, status-flags a struct, arrays a struct', () => {
  const v = (h, ctx) => decode.naturalValue(enc.decodeValues(hex(h), 0, hex(h).length).items, ctx);
  assert.deepEqual(v('91 01', { objectType: 3, property: 85 }), { v: true, type: 'bool' });
  assert.deepEqual(v('91 01', { objectType: 19, property: 85 }), { v: 1, type: 'uint32' });
  assert.deepEqual(v('82 04 50', { objectType: 0, property: 111 }), { v: { inAlarm: false, fault: true, overridden: false, outOfService: true }, type: 'struct' });
  assert.deepEqual(v('00 44 3f800000', { objectType: 1, property: 87 }), { v: [null, 1], type: 'struct' });
  assert.deepEqual(v('c4 00000003', { objectType: 8, property: 76 }), { v: 'analog-input:3', type: 'string' });
  assert.deepEqual(v('25 05 0100000000', { objectType: 48, property: 85 }), { v: 4294967296, type: 'uint64' });
});

test('declared types cast the natural value; impossible casts are decode errors', () => {
  assert.deepEqual(decode.castValue({ v: 21.7, type: 'float32' }, 'int32'), { v: 21, type: 'int32' });
  assert.deepEqual(decode.castValue({ v: true, type: 'bool' }, 'uint32'), { v: 1, type: 'uint32' });
  assert.deepEqual(decode.castValue({ v: 2, type: 'uint32' }, 'string'), { v: '2', type: 'string' });
  assert.throws(() => decode.castValue({ v: 'abc', type: 'string' }, 'float32'), enc.BacnetDecodeError);
  assert.throws(() => decode.castValue({ v: 'abc', type: 'string' }, 'bool'), enc.BacnetDecodeError);
});

test('quality from status-flags, reliability and out-of-service', () => {
  assert.deepEqual(decode.qualityOf({ statusFlags: [false, false, false, false], reliability: 0, outOfService: false }), { q: 192 });
  assert.deepEqual(decode.qualityOf({ statusFlags: [false, true, false, false] }), { q: 0, qReason: 'fault' });
  assert.deepEqual(decode.qualityOf({ reliability: 2 }), { q: 0, qReason: 'reliability: over-range' });
  assert.deepEqual(decode.qualityOf({ statusFlags: [false, false, false, true] }), { q: 64, qReason: 'out-of-service' });
  assert.deepEqual(decode.qualityOf({ outOfService: true }), { q: 64, qReason: 'out-of-service' });
  assert.deepEqual(decode.qualityOf({ statusFlags: [true, false, true, false] }), { q: 192 }, 'in-alarm and overridden values are real values');
});

test('engineering units -> unit text by standard name', () => {
  assert.deepEqual(unitInfo(62), { code: 62, name: 'degrees-celsius', text: '°C' });
  assert.equal(unitInfo(98).text, '%');
  assert.equal(unitInfo(95).text, '');
  assert.equal(unitInfo(54).text, 'kPa');
  assert.equal(unitInfo(19).text, 'kWh');
  assert.equal(unitInfo(4000).name, 'proprietary-unit-4000');
});

test('error classification', () => {
  assert.equal(errors.classifyError(1, 31), 'permanent');
  assert.equal(errors.classifyError(2, 32), 'permanent');
  assert.equal(errors.classifyError(0, 3), 'transient');
  assert.equal(errors.classifyError(5, 45), 'unsupported-service');
  assert.equal(errors.isUnsupportedService({ kind: 'reject', reason: 9 }), true);
  assert.equal(errors.isTooBig({ kind: 'abort', reason: 4 }), true);
  assert.match(errors.resultText({ kind: 'abort', reason: 4, server: true }), /cannot segment/);
  assert.match(errors.resultText({ kind: 'error', errorClass: 1, errorCode: 31 }), /object \/ unknown-object/);
  assert.equal(errors.codeOf({ kind: 'reject', reason: 9 }), 'reject/unrecognized-service');
});

test('a value nested deeper than 32 levels is refused instead of recursing to the stack limit', () => {
  const enc = require('../drivers/bacnet/encoding');
  const depth = 200;
  const body = Buffer.concat([Buffer.alloc(depth, 0x0e), Buffer.alloc(depth, 0x0f)]); // opening tag 0 x200, closing tag 0 x200
  assert.throws(() => enc.decodeValues(body, 0, body.length), /nested deeper than 32/);
  const ok = Buffer.concat([Buffer.alloc(8, 0x0e), Buffer.alloc(8, 0x0f)]);
  assert.doesNotThrow(() => enc.decodeValues(ok, 0, ok.length));
});
