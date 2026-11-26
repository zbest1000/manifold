'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ber = require('../drivers/snmp/ber');
const usm = require('../drivers/snmp/usm');
const msg = require('../drivers/snmp/message');
const oids = require('../drivers/snmp/oids');
const { decodeValue, toSample, octetsToString } = require('../drivers/snmp/decode');
const { planBatches, splitOids } = require('../drivers/snmp/planner');
const { RateTracker } = require('../drivers/snmp/rate');
const snmp = require('../drivers/snmp');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ── BER ──────────────────────────────────────────────────────────────────

test('BER: integers, unsigned values and OIDs encode to the X.690 bytes', () => {
  assert.equal(ber.encodeInteger(0).toString('hex'), '020100');
  assert.equal(ber.encodeInteger(127).toString('hex'), '02017f');
  assert.equal(ber.encodeInteger(128).toString('hex'), '02020080');
  assert.equal(ber.encodeInteger(-1).toString('hex'), '0201ff');
  assert.equal(ber.encodeInteger(-129).toString('hex'), '0202ff7f');
  assert.equal(ber.encodeUnsigned(ber.TAG.COUNTER32, 4294967295).toString('hex'), '410500ffffffff');
  assert.equal(ber.encodeUnsigned(ber.TAG.COUNTER64, 18446744073709551615n).toString('hex'), '460900ffffffffffffffff');
  assert.equal(ber.encodeOid('1.3.6.1.2.1.1.3.0').toString('hex'), '06082b06010201010300');
  assert.equal(ber.encodeOid('2.999.3').toString('hex'), '0603883703');
  // long-form length
  assert.equal(ber.encodeLength(200).toString('hex'), '81c8');
  assert.equal(ber.encodeLength(300).toString('hex'), '82012c');
});

test('BER: OIDs round-trip including large arcs; malformed OIDs are refused', () => {
  for (const o of ['1.3.6.1.2.1.1.1.0', '1.3.6.1.4.1.4294967295.7', '2.999.3', '0.39']) {
    const enc = ber.encodeOid(o);
    assert.equal(ber.decodeOid(enc, 2, enc.length), o);
  }
  assert.throws(() => ber.parseOid('1.3.x'), ber.BerError);
  assert.throws(() => ber.parseOid('3.1'), /first OID arc/);
  assert.throws(() => ber.parseOid('1.40'), /second OID arc/);
  assert.throws(() => ber.parseOid('1.3.4294967296'), /0\.\.4294967295/);
  assert.throws(() => ber.decodeOid(hex('2b8f'), 0, 2), /ends inside/);
  assert.throws(() => ber.decodeOid(hex('2b8001'), 0, 3), /leading 0x80/);
});

test('BER: the reader refuses truncated, indefinite and over-long lengths', () => {
  assert.throws(() => new ber.Reader(hex('3005020101')).read(), /truncated value/);
  assert.throws(() => new ber.Reader(hex('3080')).read(), /indefinite/);
  assert.throws(() => new ber.Reader(hex('3085ffffffffff')).read(), /length field too long/);
  assert.throws(() => new ber.Reader(hex('30')).read(), /truncated length/);
  assert.throws(() => new ber.Reader(hex('1f01')).read(), /multi-byte tags/);
  assert.throws(() => ber.decodeSigned(Buffer.alloc(0), 0, 0), /empty INTEGER/);
  assert.equal(ber.decodeSigned(hex('ff7f'), 0, 2), -129);
  assert.equal(typeof ber.decodeSigned(hex('7fffffffffffffff'), 0, 8), 'bigint');
  // Counter32 with the sign bit set and no leading zero (seen on real agents) is read unsigned
  assert.equal(ber.decodeUnsigned(hex('ffffffff'), 0, 4, 32), 4294967295n);
  assert.throws(() => ber.decodeUnsigned(hex('0100000000'), 0, 5, 32), /does not fit in 32 bits/);
});

// ── USM (RFC 3414 A.3, RFC 3826, RFC 7860) ────────────────────────────────

test('USM: password-to-key and localisation match the RFC 3414 A.3 vectors', () => {
  const engine = hex('000000000000000000000002');
  assert.equal(usm.passwordToKey('maplesyrup', 'md5').toString('hex'), '9faf3283884e92834ebc9847d8edd963');
  assert.equal(usm.localizedKey('maplesyrup', engine, 'md5').toString('hex'), '526f5eed9fcce26f8964c2930787d82b');
  assert.equal(usm.passwordToKey('maplesyrup', 'sha').toString('hex'), '9fb5cc0381497b3793528939ff788d5d79145211');
  assert.equal(usm.localizedKey('maplesyrup', engine, 'sha').toString('hex'), '6695febc9288e36282235fc7151f128497b38f3f');
});

test('USM: MAC lengths follow RFC 3414 / RFC 7860 and verification is exact', () => {
  const lens = { md5: 12, sha: 12, sha224: 16, sha256: 24, sha384: 32, sha512: 48 };
  for (const [p, n] of Object.entries(lens)) {
    const key = usm.localizedKey('authpass1', hex('8000000001020304'), p);
    const mac = usm.computeMac(p, key, Buffer.from('message'));
    assert.equal(mac.length, n, p);
    assert.ok(usm.verifyMac(p, key, Buffer.from('message'), mac));
    assert.ok(!usm.verifyMac(p, key, Buffer.from('messagf'), mac));
  }
});

test('USM: DES and AES round-trip; the IV depends on boots/time/salt; wrong keys do not decrypt', () => {
  const plain = ber.sequence(ber.encodeOctetString('ctx'), ber.encodeOctetString(''), msg.encodeRequestPdu(msg.PDU.GET, 7, ['1.3.6.1.2.1.1.3.0']));
  for (const p of ['des', 'aes']) {
    const key = usm.localizedKey('privpass1', hex('8000000001020304'), 'sha');
    const a = usm.encrypt(p, key, plain, { engineBoots: 3, engineTime: 1000, salt: 42 });
    const b = usm.encrypt(p, key, plain, { engineBoots: 3, engineTime: 1000, salt: 43 });
    assert.notDeepEqual(a.encrypted, b.encrypted, `${p}: different salts give different ciphertext`);
    assert.equal(a.privParams.length, 8);
    const back = usm.decrypt(p, key, a.encrypted, { engineBoots: 3, engineTime: 1000, privParams: a.privParams });
    assert.deepEqual(back.subarray(0, plain.length), plain);
    if (p === 'des') {
      assert.equal(a.encrypted.length % 8, 0);
      assert.equal(a.privParams.readUInt32BE(0), 3, 'DES salt starts with engineBoots (RFC 3414 8.1.1.1)');
    } else {
      assert.equal(a.encrypted.length, plain.length, 'CFB needs no padding');
    }
    const other = usm.localizedKey('otherpass', hex('8000000001020304'), 'sha');
    const wrong = usm.decrypt(p, other, a.encrypted, { engineBoots: 3, engineTime: 1000, privParams: a.privParams });
    assert.notDeepEqual(wrong.subarray(0, plain.length), plain);
  }
});

test('USM: single DES via 3DES-EDE with K1=K2=K3 equals the FIPS 81 DES-CBC test vector', () => {
  // FIPS PUB 81 Appendix C, CBC mode: key 0123456789abcdef, IV 1234567890abcdef,
  // plaintext "Now is the time for all " -> e5c7cdde872bf27c 43e934008c389c0f 683788499a7c05f6
  const key = Buffer.concat([hex('0123456789abcdef'), hex('1234567890abcdef')]); // key || preIV
  const salt = Buffer.alloc(8); // IV = preIV xor salt = preIV
  const out = usm.decrypt('des', key, hex('e5c7cdde872bf27c43e934008c389c0f683788499a7c05f6'), { engineBoots: 0, engineTime: 0, privParams: salt });
  assert.equal(out.toString('latin1'), 'Now is the time for all ');
});

// ── messages ─────────────────────────────────────────────────────────────

test('message: a v2c GetRequest is byte-for-byte what net-snmp sends', () => {
  const pdu = msg.encodeRequestPdu(msg.PDU.GET, 0x12345678, ['1.3.6.1.2.1.1.1.0']);
  const m = msg.encodeCommunityMessage(msg.VERSION.v2c, 'public', pdu);
  assert.equal(m.toString('hex'), '302902010104067075626c6963a01c020412345678020100020100300e300c06082b060102010101000500');
  const back = msg.decodeMessage(m);
  assert.equal(back.version, 1);
  assert.equal(back.community.toString(), 'public');
  assert.equal(back.pdu.type, msg.PDU.GET);
  assert.deepEqual(back.pdu.varbinds.map((v) => v.oid), ['1.3.6.1.2.1.1.1.0']);
});

test('message: only Get, GetNext and GetBulk can be encoded; a Set PDU cannot be produced', () => {
  for (const t of [0xa2, 0xa3, 0xa4, 0xa6, 0xa7, 0xa8, 0x30]) {
    assert.throws(() => msg.encodeRequestPdu(t, 1, ['1.3.6.1.2.1.1.1.0']), /only Get, GetNext and GetBulk/);
  }
  // Wrapping a hand-made PDU is refused too, for v1/v2c and v3.
  const setLike = ber.tlv(0xa3, Buffer.concat([ber.encodeInteger(1), ber.encodeInteger(0), ber.encodeInteger(0), ber.sequence()]));
  assert.throws(() => msg.encodeCommunityMessage(1, 'public', setLike), /only Get, GetNext and GetBulk/);
  assert.throws(() => msg.encodeV3Message({ msgId: 1, level: 'noAuthNoPriv', pdu: setLike }), /only Get, GetNext and GetBulk/);
  assert.equal(Object.values(msg.PDU).includes(0xa3), false, 'no SetRequest constant exists');
  // Every encoded varbind value is NULL.
  const bulk = msg.encodeRequestPdu(msg.PDU.GET_BULK, 9, ['1.3.6.1.2.1.1'], { nonRepeaters: 0, maxRepetitions: 5 });
  const parsed = msg.decodePdu(new ber.Reader(bulk));
  assert.equal(parsed.maxRepetitions, 5);
  assert.ok(parsed.varbinds.every((v) => v.tag === ber.TAG.NULL));
});

test('message: v3 messages carry USM parameters, a verifiable MAC and encrypted scoped PDUs', () => {
  const engineId = hex('80001f8880aabbccddeeff0011');
  for (const authProtocol of Object.keys(usm.AUTH)) {
    for (const privProtocol of ['des', 'aes']) {
      const authKey = usm.localizedKey('authpass1', engineId, authProtocol);
      const privKey = usm.localizedKey('privpass1', engineId, authProtocol);
      const pdu = msg.encodeRequestPdu(msg.PDU.GET, 77, ['1.3.6.1.2.1.1.5.0']);
      const m = msg.encodeV3Message({ msgId: 1234, msgMaxSize: 65507, level: 'authPriv', engineId, engineBoots: 5, engineTime: 500, user: 'op', auth: { protocol: authProtocol, key: authKey }, priv: { protocol: privProtocol, key: privKey, salt: 99n }, pdu });
      const d = msg.decodeMessage(m);
      assert.equal(d.v3.msgId, 1234);
      assert.equal(d.v3.flags, 0x07);
      assert.equal(d.v3.usm.authParams.length, usm.AUTH[authProtocol].macLength);
      assert.ok(usm.verifyMac(authProtocol, authKey, msg.zeroAuth(m, d.v3.usm), d.v3.usm.authParams), `${authProtocol} MAC verifies`);
      const plain = usm.decrypt(privProtocol, privKey, d.encrypted, { engineBoots: 5, engineTime: 500, privParams: d.v3.usm.privParams });
      const scoped = msg.decodeScopedPdu(plain);
      assert.equal(scoped.pdu.requestId, 77);
      assert.deepEqual(scoped.contextEngineId, engineId);
    }
  }
});

test('message: malformed and truncated datagrams throw instead of crashing', () => {
  const good = msg.encodeCommunityMessage(1, 'public', msg.encodeRequestPdu(msg.PDU.GET, 5, ['1.3.6.1.2.1.1.3.0']));
  for (let n = 0; n < good.length; n++) assert.throws(() => msg.decodeMessage(good.subarray(0, n)), `truncated at ${n}`);
  assert.throws(() => msg.decodeMessage(Buffer.concat([good, Buffer.from([0])])));
  assert.throws(() => msg.decodeMessage(hex('3003020102')), /unsupported SNMP version|end of data|expected/);
  const junk = Buffer.alloc(64);
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < junk.length; j++) junk[j] = Math.floor(Math.random() * 256);
    try {
      msg.decodeMessage(junk);
    } catch (err) {
      assert.ok(err instanceof ber.BerError || err instanceof msg.SnmpFrameError, `unexpected ${err.name}: ${err.message}`);
    }
  }
});

// ── values ───────────────────────────────────────────────────────────────

test('decode: every SMI type maps to a sample type and value', () => {
  const cases = [
    [ber.encodeInteger(-42), { v: -42, type: 'int32' }],
    [ber.encodeUnsigned(ber.TAG.COUNTER32, 4294967295), { v: 4294967295, type: 'uint32' }],
    [ber.encodeUnsigned(ber.TAG.GAUGE32, 7), { v: 7, type: 'uint32' }],
    [ber.encodeUnsigned(ber.TAG.TIMETICKS, 123456), { v: 123456, type: 'uint32' }],
    [ber.encodeUnsigned(ber.TAG.COUNTER64, 18446744073709551615n), { v: '18446744073709551615', type: 'uint64' }],
    [ber.encodeOctetString('Pump 1'), { v: 'Pump 1', type: 'string' }],
    [ber.encodeOctetString(Buffer.from([0, 0x1a, 0xff])), { v: '00:1a:ff', type: 'string' }],
    [ber.encodeOid('1.3.6.1.4.1.9'), { v: '1.3.6.1.4.1.9', type: 'string' }],
    [ber.tlv(ber.TAG.IP_ADDRESS, Buffer.from([10, 0, 0, 5])), { v: '10.0.0.5', type: 'string' }],
    [ber.tlv(ber.TAG.OPAQUE, hex('9f780441ac0000')), { v: 21.5, type: 'float32' }],
    [ber.tlv(ber.TAG.OPAQUE, hex('9f7908400921fb54442d18')), { v: Math.PI, type: 'float64' }],
    [ber.tlv(ber.TAG.OPAQUE, hex('010203')), { v: '01:02:03', type: 'string' }],
  ];
  for (const [tlv, want] of cases) {
    const t = new ber.Reader(tlv).read();
    const s = toSample(decodeValue(t.tag, tlv.subarray(t.start, t.end)));
    assert.equal(s.q, 192);
    assert.equal(s.v, want.v);
    assert.equal(s.type, want.type);
  }
  for (const [tag, reason] of [[0x80, 'noSuchObject'], [0x81, 'noSuchInstance'], [0x82, 'endOfMibView'], [0x05, 'null']]) {
    const s = toSample(decodeValue(tag, Buffer.alloc(0)));
    assert.equal(s.q, 0);
    assert.equal(s.qReason, reason);
  }
  assert.throws(() => decodeValue(0x40, Buffer.from([1, 2, 3])), /IpAddress must be 4 bytes/);
  assert.throws(() => decodeValue(0x99, Buffer.alloc(1)), /unknown value type/);
  // declared type is an expectation
  const mismatch = toSample(decodeValue(0x04, Buffer.from('x')), { type: 'Counter32' });
  assert.equal(mismatch.qReason, 'type-mismatch');
});

test('decode: octet strings are text when printable, hex otherwise, and the encoding hint wins', () => {
  assert.equal(octetsToString(Buffer.from('Température')), 'Température');
  assert.equal(octetsToString(Buffer.from('padded\0\0', 'latin1')), 'padded');
  assert.equal(octetsToString(Buffer.from([0x41, 0x01])), '41:01');
  assert.equal(octetsToString(Buffer.from([0xc3, 0x28])), 'c3:28', 'invalid UTF-8 is hex');
  assert.equal(octetsToString(Buffer.from('AB'), 'hex'), '41:42');
  assert.equal(octetsToString(Buffer.from([0x41, 0x01]), 'text'), 'A\u0001');
  assert.equal(octetsToString(Buffer.alloc(0)), '');
});

// ── addresses ────────────────────────────────────────────────────────────

test('addresses: numeric OIDs and well-known names resolve; columns need an index', () => {
  assert.deepEqual(oids.resolveAddress('1.3.6.1.2.1.1.3.0'), { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime.0', kind: 'TimeTicks' });
  assert.equal(oids.resolveAddress('.1.3.6.1.2.1.1.3.0').oid, '1.3.6.1.2.1.1.3.0');
  assert.equal(oids.resolveAddress('sysUpTime.0').oid, '1.3.6.1.2.1.1.3.0');
  assert.equal(oids.resolveAddress('sysname').oid, '1.3.6.1.2.1.1.5.0', 'case-insensitive, scalar gets .0');
  assert.equal(oids.resolveAddress('ifHCInOctets.3').oid, '1.3.6.1.2.1.31.1.1.1.6.3');
  assert.equal(oids.resolveAddress('ifInOctets.12').kind, 'Counter32');
  assert.equal(oids.resolveAddress('hrProcessorLoad.196608').oid, '1.3.6.1.2.1.25.3.3.1.2.196608');
  assert.throws(() => oids.resolveAddress('ifInOctets'), /table column: add the row index/);
  assert.throws(() => oids.resolveAddress('fooBar.0'), /unknown object name/);
  assert.throws(() => oids.resolveAddress('IF-MIB::ifInOctets.1'), /neither a numeric OID/);
  assert.equal(oids.nameOf('1.3.6.1.2.1.2.2.1.8.4').text, 'ifOperStatus.4');
  assert.equal(oids.compareOids('1.3.6.1.2', '1.3.6.1.10'), -1);
  assert.equal(oids.compareOids('1.3.6.1', '1.3.6.1.0'), -1);
  assert.ok(oids.isUnder('1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1'));
  assert.ok(!oids.isUnder('1.3.6.1.2.1.10', '1.3.6.1.2.1.1'));
});

test('validateTag: types, encodings and rate need sensible combinations', () => {
  assert.equal(snmp.validateTag({ key: 'a', address: 'ifInOctets.1', rate: true }).ok, true);
  assert.match(snmp.validateTag({ key: 'a', address: 'sysDescr.0', rate: true }).error, /rate needs a counter/);
  assert.match(snmp.validateTag({ key: 'a', address: '1.3.6.1.4.1.9.1.0', type: 'Gauge32', rate: true }).error, /rate needs a counter/);
  assert.match(snmp.validateTag({ key: 'a', address: '1.3.6.1.4.1.9.1.0', type: 'Float' }).error, /unknown type/);
  assert.match(snmp.validateTag({ key: 'a', address: 'sysDescr.0', encoding: 'base64' }).error, /encoding must be/);
  assert.equal(snmp.validateTag({ key: 'a', address: 'sysDescr.0', type: 'octetstring' }).normalized.type, 'OctetString');
  assert.match(snmp.validateTag({ key: 'a', address: '' }).error, /numeric OID or a known name/);
});

test('device config: v3 levels need their passwords; secrets never appear in error messages', () => {
  const base = { host: '127.0.0.1', tags: [] };
  assert.doesNotThrow(() => snmp.createDriver({ ...base, version: '2c', community: 'c0mmunity' }));
  assert.throws(() => snmp.createDriver({ ...base, version: '3' }), /securityName/);
  assert.throws(() => snmp.createDriver({ ...base, version: '3', securityName: 'u', securityLevel: 'authPriv', authPassword: 'short', privPassword: 'x' }), (err) => {
    assert.match(err.message, /authentication password must be at least 8/);
    assert.match(err.message, /privacy password must be at least 8/);
    assert.ok(!err.message.includes('short'));
    return true;
  });
  assert.throws(() => snmp.createDriver({ ...base, version: '3', securityName: 'u', securityLevel: 'authNoPriv', authProtocol: 'sha3', authPassword: 'longenough' }), /authProtocol must be/);
  assert.throws(() => snmp.createDriver({ ...base, version: '4' }), /version must be 1, 2c or 3/);
  assert.throws(() => snmp.createDriver({ ...base, options: { maxVarbinds: 0 } }), /maxVarbinds/);
  assert.doesNotThrow(() => snmp.createDriver({ ...base, version: 2 }), 'version 2 means 2c');
});

// ── planning ─────────────────────────────────────────────────────────────

test('planner: batches respect max varbinds, the estimated response size and dedupe OIDs', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ oid: `1.3.6.1.2.1.2.2.1.10.${i + 1}`, kind: 'Counter32' }));
  const b = planBatches([...items, items[3]], { maxVarbinds: 20, maxBytes: 65507, overheadBytes: 40 });
  assert.deepEqual(b.map((x) => x.length), [20, 20, 10]);
  assert.equal(new Set(b.flat()).size, 50);
  const strings = Array.from({ length: 30 }, (_, i) => ({ oid: `1.3.6.1.2.1.2.2.1.2.${i + 1}`, kind: 'OctetString' }));
  const small = planBatches(strings, { maxVarbinds: 100, maxBytes: 600, overheadBytes: 40 });
  assert.ok(small.length > 1 && small.every((x) => x.length < 30), 'response size splits the batch');
  const learned = new Map(strings.map((s) => [s.oid, 4]));
  assert.equal(planBatches(strings, { maxVarbinds: 100, maxBytes: 800, overheadBytes: 40, learned }).length, 1, 'learned sizes pack tighter');
  const withPrefix = planBatches(items.slice(0, 5), { maxVarbinds: 3, maxBytes: 65507, overheadBytes: 40, prefix: ['1.3.6.1.2.1.1.3.0'] });
  assert.ok(withPrefix.every((x) => x[0] === '1.3.6.1.2.1.1.3.0' && x.length <= 3));
  assert.deepEqual(splitOids(['p', 'a', 'b', 'c'], 1), [['p', 'a', 'b'], ['p', 'c']]);
  assert.equal(splitOids(['p', 'a'], 1), null);
});

// ── rates ────────────────────────────────────────────────────────────────

test('rate: per-second deltas, Counter32/64 wrap, agent restart and sysUpTime wrap', () => {
  const r = new RateTracker();
  assert.equal(r.update('k', 'Counter32', 1000, 10000, 0).qReason, 'rate-warmup');
  assert.equal(r.update('k', 'Counter32', 3000, 11000, 10000).v, 200); // 2000 in 10 s of agent time
  const wrap = r.update('k', 'Counter32', 704, 12000, 20000); // 3000 -> 2^32 wrap -> 704
  assert.equal(wrap.v, (4294967296 - 3000 + 704) / 10);
  assert.equal(r.update('k', 'Counter32', 50, 500, 30000).qReason, 'counter-reset', 'sysUpTime went back: restart');
  assert.equal(r.update('k', 'Counter32', 150, 1500, 40000).v, 10);

  const r64 = new RateTracker();
  r64.update('h', 'Counter64', 18446744073709551000n, 100, 0);
  assert.equal(r64.update('h', 'Counter64', 384n, 200, 1000).v, 1000, 'Counter64 wraps modulo 2^64');

  const ticks = new RateTracker();
  ticks.update('t', 'Counter32', 0, 4294967000, 0);
  const afterWrap = ticks.update('t', 'Counter32', 1000, 704, 10000); // sysUpTime wrapped after 10 s
  assert.equal(afterWrap.q, 192);
  assert.equal(afterWrap.v, 100);

  const noUp = new RateTracker();
  noUp.update('n', 'Counter32', 0, null, 0);
  assert.equal(noUp.update('n', 'Counter32', 500, null, 5000).v, 100, 'local clock fallback');
  assert.equal(new RateTracker().update('g', 'Gauge32', 1, 1, 1).qReason, 'rate-needs-counter');
});
