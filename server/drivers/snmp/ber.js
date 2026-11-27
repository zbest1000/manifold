'use strict';

/**
 * Minimal BER (X.690) for SNMP: definite lengths only, the universal types
 * SNMP uses (INTEGER, OCTET STRING, NULL, OBJECT IDENTIFIER, SEQUENCE), the
 * SMIv2 application types and the three v2 varbind exceptions.
 *
 * Decoding is defensive: every length is checked against the enclosing
 * buffer, indefinite lengths and over-long length fields are refused, and a
 * malformed frame throws BerError (never a RangeError from Buffer).
 */

const TAG = Object.freeze({
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  // SMIv2 application types (RFC 2578 / RFC 3416)
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  OPAQUE: 0x44,
  NSAP: 0x45,
  COUNTER64: 0x46,
  UINTEGER32: 0x47,
  // v2 exceptions (context-specific, primitive, empty)
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
});

const TYPE_NAME = Object.freeze({
  [TAG.INTEGER]: 'Integer32',
  [TAG.OCTET_STRING]: 'OctetString',
  [TAG.NULL]: 'Null',
  [TAG.OID]: 'OID',
  [TAG.IP_ADDRESS]: 'IpAddress',
  [TAG.COUNTER32]: 'Counter32',
  [TAG.GAUGE32]: 'Gauge32',
  [TAG.TIMETICKS]: 'TimeTicks',
  [TAG.OPAQUE]: 'Opaque',
  [TAG.NSAP]: 'NsapAddress',
  [TAG.COUNTER64]: 'Counter64',
  [TAG.UINTEGER32]: 'UInteger32',
  [TAG.NO_SUCH_OBJECT]: 'noSuchObject',
  [TAG.NO_SUCH_INSTANCE]: 'noSuchInstance',
  [TAG.END_OF_MIB_VIEW]: 'endOfMibView',
});

class BerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BerError';
  }
}

// ── encoding ─────────────────────────────────────────────────────────────

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

/** Two's-complement minimal encoding of a signed integer (number or bigint). */
function encodeIntegerContent(value) {
  let v = BigInt(value);
  const bytes = [];
  for (;;) {
    const b = Number(v & 0xffn);
    bytes.unshift(b);
    v >>= 8n;
    if ((v === 0n && (b & 0x80) === 0) || (v === -1n && (b & 0x80) !== 0)) break;
  }
  return Buffer.from(bytes);
}

/** Unsigned minimal encoding (Counter32/Gauge32/TimeTicks/Counter64): a leading 0 when the top bit is set. */
function encodeUnsignedContent(value) {
  let v = BigInt(value);
  if (v < 0n) throw new BerError('unsigned value must not be negative');
  const bytes = [];
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

function encodeInteger(value) {
  return tlv(TAG.INTEGER, encodeIntegerContent(value));
}

function encodeUnsigned(tag, value) {
  return tlv(tag, encodeUnsignedContent(value));
}

function encodeOctetString(value) {
  return tlv(TAG.OCTET_STRING, Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
}

function encodeNull() {
  return Buffer.from([TAG.NULL, 0]);
}

/** Parse "1.3.6.1.2.1.1.3.0" (optional leading dot) into arcs; throws BerError. */
function parseOid(text) {
  const s = String(text).trim().replace(/^\./, '');
  if (!/^\d+(\.\d+)+$/.test(s)) throw new BerError(`"${text}" is not a numeric OID (expected e.g. 1.3.6.1.2.1.1.3.0)`);
  const arcs = s.split('.').map(Number);
  if (arcs.length > 128) throw new BerError('OID has more than 128 sub-identifiers');
  if (arcs[0] > 2) throw new BerError('the first OID arc must be 0, 1 or 2');
  if (arcs[0] < 2 && arcs[1] > 39) throw new BerError('the second OID arc must be 0..39 under 0 and 1');
  for (const a of arcs) if (!Number.isSafeInteger(a) || a > 0xffffffff) throw new BerError('OID arcs must be 0..4294967295');
  return arcs;
}

function encodeOidContent(arcs) {
  const out = [];
  const push = (n) => {
    const tmp = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) {
      tmp.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...tmp);
  };
  push(arcs[0] * 40 + arcs[1]);
  for (let i = 2; i < arcs.length; i++) push(arcs[i]);
  return Buffer.from(out);
}

function encodeOid(oid) {
  const arcs = Array.isArray(oid) ? oid : parseOid(oid);
  return tlv(TAG.OID, encodeOidContent(arcs));
}

function sequence(...parts) {
  return tlv(TAG.SEQUENCE, Buffer.concat(parts.flat()));
}

// ── decoding ─────────────────────────────────────────────────────────────

/** Sequential reader over one buffer region. */
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get remaining() {
    return this.end - this.pos;
  }

  /** Next TLV header without consuming it. */
  peekTag() {
    if (this.pos >= this.end) throw new BerError('unexpected end of data');
    return this.buf[this.pos];
  }

  /** Read one TLV: { tag, start (of content), end, length, raw (whole TLV) }. */
  read() {
    if (this.pos >= this.end) throw new BerError('unexpected end of data');
    const tlvStart = this.pos;
    const tag = this.buf[this.pos++];
    if ((tag & 0x1f) === 0x1f) throw new BerError(`multi-byte tags are not used by SNMP (tag 0x${tag.toString(16)})`);
    if (this.pos >= this.end) throw new BerError('truncated length');
    let len = this.buf[this.pos++];
    if (len === 0x80) throw new BerError('indefinite length is not allowed');
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n > 4) throw new BerError('length field too long');
      if (this.pos + n > this.end) throw new BerError('truncated length');
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + this.buf[this.pos++];
    }
    const start = this.pos;
    if (start + len > this.end) throw new BerError(`truncated value (need ${len} bytes, ${this.end - start} left)`);
    this.pos = start + len;
    return { tag, start, end: start + len, length: len, raw: this.buf.subarray(tlvStart, start + len), tlvStart };
  }

  expect(tag, what) {
    const t = this.read();
    if (t.tag !== tag) throw new BerError(`expected ${what} (0x${tag.toString(16)}), got tag 0x${t.tag.toString(16)}`);
    return t;
  }

  /** Reader over the content of the next constructed TLV of `tag`. */
  sub(tag, what) {
    const t = this.expect(tag, what);
    return new Reader(this.buf, t.start, t.end);
  }

  integer(what = 'INTEGER') {
    const t = this.expect(TAG.INTEGER, what);
    return decodeSigned(this.buf, t.start, t.end);
  }

  octets(what = 'OCTET STRING') {
    const t = this.expect(TAG.OCTET_STRING, what);
    return this.buf.subarray(t.start, t.end);
  }

  oid(what = 'OBJECT IDENTIFIER') {
    const t = this.expect(TAG.OID, what);
    return decodeOid(this.buf, t.start, t.end);
  }
}

/** Signed INTEGER content as a number (bigint when outside the safe range). */
function decodeSigned(buf, start, end) {
  const len = end - start;
  if (len === 0) throw new BerError('empty INTEGER');
  if (len > 9) throw new BerError('INTEGER longer than 9 bytes');
  let v = BigInt.asIntN(8, BigInt(buf[start]));
  for (let i = start + 1; i < end; i++) v = (v << 8n) | BigInt(buf[i]);
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

/** Unsigned content as bigint. Leading 0x00 is tolerated, extra bytes beyond `bits` are an error. */
function decodeUnsigned(buf, start, end, bits) {
  const len = end - start;
  if (len === 0) throw new BerError('empty unsigned value');
  if (len > bits / 8 + 1) throw new BerError(`unsigned value longer than ${bits / 8 + 1} bytes`);
  let v = 0n;
  for (let i = start; i < end; i++) v = (v << 8n) | BigInt(buf[i]);
  // Some agents send Counter32/Gauge32 with the sign bit set and no leading zero; the
  // bytes are still the unsigned value, so they are read as such. Wider values are refused.
  if (v >> BigInt(bits) !== 0n) throw new BerError(`value does not fit in ${bits} bits`);
  return v;
}

function decodeOid(buf, start, end) {
  if (end <= start) throw new BerError('empty OBJECT IDENTIFIER');
  const arcs = [];
  let v = 0;
  let inArc = false;
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (!inArc && b === 0x80) throw new BerError('OID sub-identifier has a leading 0x80');
    v = v * 128 + (b & 0x7f);
    if (v > 0xffffffff * 128) throw new BerError('OID sub-identifier too large');
    inArc = true;
    if ((b & 0x80) === 0) {
      if (arcs.length === 0) {
        if (v < 40) arcs.push(0, v);
        else if (v < 80) arcs.push(1, v - 40);
        else arcs.push(2, v - 80);
      } else {
        if (v > 0xffffffff) throw new BerError('OID sub-identifier above 4294967295');
        arcs.push(v);
      }
      v = 0;
      inArc = false;
    }
  }
  if (inArc) throw new BerError('OID ends inside a sub-identifier');
  return arcs.join('.');
}

module.exports = {
  TAG,
  TYPE_NAME,
  BerError,
  Reader,
  tlv,
  sequence,
  encodeLength,
  encodeInteger,
  encodeIntegerContent,
  encodeUnsigned,
  encodeUnsignedContent,
  encodeOctetString,
  encodeNull,
  encodeOid,
  encodeOidContent,
  parseOid,
  decodeSigned,
  decodeUnsigned,
  decodeOid,
};
