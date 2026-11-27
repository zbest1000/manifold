'use strict';

/**
 * Varbind value -> sample. SNMP types map to the sample types the rest of
 * Manifold uses:
 *
 *   Integer32                              int32
 *   Counter32, Gauge32, TimeTicks          uint32
 *   Counter64                              uint64, value as a decimal string (as the
 *                                          other drivers publish 64-bit integers)
 *   OctetString                            string: text when printable UTF-8, else
 *                                          colon-separated hex (per-tag `encoding`)
 *   OID, IpAddress                         string
 *   Opaque float / double (net-snmp)       float32 / float64; other Opaque -> hex string
 *   noSuchObject, noSuchInstance,
 *   endOfMibView, NULL                     Bad quality with the reason
 */

const ber = require('./ber');

const { TAG, TYPE_NAME } = ber;

const Q_GOOD = 192;
const Q_BAD = 0;

/** Types a tag may declare (an expectation: a different answer from the agent is Bad). */
const TAG_TYPES = ['Integer32', 'Counter32', 'Gauge32', 'TimeTicks', 'Counter64', 'OctetString', 'OID', 'IpAddress', 'Opaque'];
const ENCODINGS = ['auto', 'text', 'hex'];

const SAMPLE_TYPE = {
  Integer32: 'int32',
  Counter32: 'uint32',
  Gauge32: 'uint32',
  UInteger32: 'uint32',
  TimeTicks: 'uint32',
  Counter64: 'uint64',
  OctetString: 'string',
  OID: 'string',
  IpAddress: 'string',
  NsapAddress: 'string',
  Opaque: 'string',
};

const EXCEPTION_TEXT = {
  noSuchObject: 'noSuchObject: the agent does not implement this object',
  noSuchInstance: 'noSuchInstance: the object exists but this instance (row index) does not',
  endOfMibView: 'endOfMibView: no object at or after this OID',
};

// Opaque-wrapped types (net-snmp ASN_OPAQUE_*): 0x9f then the inner tag.
const OPAQUE_INNER = { 0x76: 'counter64', 0x78: 'float', 0x79: 'double', 0x7a: 'int64', 0x7b: 'uint64' };

/**
 * Decode one varbind value.
 * @returns {{type:string, value?:*, exception?:string}} value: number | bigint | Buffer | string
 */
function decodeValue(tag, content) {
  const type = TYPE_NAME[tag] || `tag 0x${tag.toString(16)}`;
  switch (tag) {
    case TAG.INTEGER:
      return { type, value: ber.decodeSigned(content, 0, content.length) };
    case TAG.COUNTER32:
    case TAG.GAUGE32:
    case TAG.TIMETICKS:
    case TAG.UINTEGER32:
      return { type, value: Number(ber.decodeUnsigned(content, 0, content.length, 32)) };
    case TAG.COUNTER64:
      return { type, value: ber.decodeUnsigned(content, 0, content.length, 64) };
    case TAG.OCTET_STRING:
    case TAG.NSAP:
      return { type, value: Buffer.from(content) };
    case TAG.OID:
      return { type, value: ber.decodeOid(content, 0, content.length) };
    case TAG.IP_ADDRESS:
      if (content.length !== 4) throw new ber.BerError(`IpAddress must be 4 bytes, got ${content.length}`);
      return { type, value: Array.from(content).join('.') };
    case TAG.OPAQUE:
      return { type, value: decodeOpaque(content) };
    case TAG.NULL:
      return { type, exception: 'null' };
    case TAG.NO_SUCH_OBJECT:
    case TAG.NO_SUCH_INSTANCE:
    case TAG.END_OF_MIB_VIEW:
      return { type, exception: type };
    default:
      throw new ber.BerError(`unknown value type 0x${tag.toString(16)}`);
  }
}

/** Opaque: the common float/double/64-bit wrappings, else the raw bytes. */
function decodeOpaque(content) {
  if (content.length >= 3 && content[0] === 0x9f && OPAQUE_INNER[content[1]]) {
    const kind = OPAQUE_INNER[content[1]];
    const len = content[2];
    if (3 + len === content.length) {
      const body = content.subarray(3);
      if (kind === 'float' && len === 4) return { opaque: 'float', number: body.readFloatBE(0) };
      if (kind === 'double' && len === 8) return { opaque: 'double', number: body.readDoubleBE(0) };
      if (kind === 'int64' && len >= 1 && len <= 9) return { opaque: 'int64', big: BigInt(ber.decodeSigned(body, 0, len)) };
      if ((kind === 'uint64' || kind === 'counter64') && len >= 1 && len <= 9) return { opaque: kind, big: ber.decodeUnsigned(body, 0, len, 64) };
    }
  }
  return { opaque: 'raw', bytes: Buffer.from(content) };
}

const HEX = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(':');

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Printable text, or null. Trailing NULs (common in agent strings) are dropped first. */
function asText(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  const body = buf.subarray(0, end);
  let s;
  try {
    s = utf8.decode(body);
  } catch {
    return null;
  }
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return null;
  }
  return s;
}

function octetsToString(buf, encoding = 'auto') {
  if (encoding === 'hex') return HEX(buf);
  if (encoding === 'text') return buf.toString('utf8').replace(/\0+$/, '');
  const text = asText(buf);
  return text === null ? HEX(buf) : text;
}

function typesMatch(declared, actual) {
  if (!declared) return true;
  if (declared === actual) return true;
  const unsigned32 = ['Gauge32', 'UInteger32'];
  return unsigned32.includes(declared) && unsigned32.includes(actual);
}

/**
 * Sample fields { v, type, q, qReason? } for a decoded value and a tag spec
 * ({ type?: declared SNMP type, encoding? }).
 */
function toSample(decoded, spec = {}) {
  const sampleType = spec.type ? SAMPLE_TYPE[spec.type] || 'unknown' : SAMPLE_TYPE[decoded.type] || 'unknown';
  if (decoded.exception) {
    const reason = decoded.exception === 'null' ? 'null: the agent returned no value' : EXCEPTION_TEXT[decoded.exception];
    return { v: null, type: sampleType, q: Q_BAD, qReason: decoded.exception === 'null' ? 'null' : decoded.exception, message: reason };
  }
  if (!typesMatch(spec.type, decoded.type)) {
    return { v: null, type: sampleType, q: Q_BAD, qReason: 'type-mismatch', message: `expected ${spec.type}, the agent returned ${decoded.type}` };
  }
  const v = decoded.value;
  switch (decoded.type) {
    case 'Integer32':
      return { v: typeof v === 'bigint' ? v.toString() : v, type: typeof v === 'bigint' ? 'int64' : 'int32', q: Q_GOOD };
    case 'Counter64':
      return { v: v.toString(), type: 'uint64', q: Q_GOOD };
    case 'OctetString':
    case 'NsapAddress':
      return { v: octetsToString(v, spec.encoding), type: 'string', q: Q_GOOD };
    case 'Opaque':
      if (v.opaque === 'float') return { v: v.number, type: 'float32', q: Q_GOOD };
      if (v.opaque === 'double') return { v: v.number, type: 'float64', q: Q_GOOD };
      if (v.big !== undefined) return { v: v.big.toString(), type: v.opaque === 'int64' ? 'int64' : 'uint64', q: Q_GOOD };
      return { v: HEX(v.bytes), type: 'string', q: Q_GOOD };
    default:
      return { v, type: sampleType, q: Q_GOOD };
  }
}

/** Plain JSON-safe value for browse/probe output. */
function displayValue(decoded) {
  if (decoded.exception) return decoded.exception;
  const s = toSample(decoded, {});
  return s.v;
}

module.exports = { TAG_TYPES, ENCODINGS, SAMPLE_TYPE, Q_GOOD, Q_BAD, decodeValue, decodeOpaque, toSample, octetsToString, displayValue, typesMatch };
