'use strict';

/**
 * BACnet tag encoding (ASHRAE 135 clause 20.2): the primitives the frame
 * encoder needs to BUILD read requests, and a complete decoder for every
 * application tag a device can send back.
 *
 * A tag's first octet: tag number (high nibble, 0xF = extended in the next
 * octet), class bit 0x08 (1 = context specific), length/value/type in the low
 * three bits (0-4 length, 5 = extended length, 6 = opening, 7 = closing; for an
 * APPLICATION boolean the low bits are the value itself).
 */

const APP = Object.freeze({
  NULL: 0, BOOLEAN: 1, UNSIGNED: 2, SIGNED: 3, REAL: 4, DOUBLE: 5, OCTET_STRING: 6,
  CHARACTER_STRING: 7, BIT_STRING: 8, ENUMERATED: 9, DATE: 10, TIME: 11, OBJECT_ID: 12,
});
const APP_NAMES = ['null', 'boolean', 'unsigned', 'signed', 'real', 'double', 'octet-string', 'character-string', 'bit-string', 'enumerated', 'date', 'time', 'object-identifier'];

const MAX_INSTANCE = 0x3fffff; // 22 bits
const WILDCARD_INSTANCE = 4194303;

class BacnetDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BacnetDecodeError';
  }
}

// ---- encoding (requests only need context tags, unsigned values and object ids) ----------------

function tagHeader(tagNumber, context, lvt) {
  if (tagNumber <= 14) return Buffer.from([(tagNumber << 4) | (context ? 0x08 : 0) | lvt]);
  return Buffer.from([0xf0 | (context ? 0x08 : 0) | lvt, tagNumber]);
}

function unsignedBytes(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`unsigned value out of range: ${value}`);
  if (value <= 0xff) return Buffer.from([value]);
  if (value <= 0xffff) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value);
    return b;
  }
  if (value <= 0xffffff) return Buffer.from([value >>> 16, (value >>> 8) & 0xff, value & 0xff]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

function withLength(tagNumber, context, content) {
  if (content.length <= 4) return Buffer.concat([tagHeader(tagNumber, context, content.length), content]);
  if (content.length < 254) return Buffer.concat([tagHeader(tagNumber, context, 5), Buffer.from([content.length]), content]);
  throw new RangeError('content too long for a request tag');
}

/** Context-tagged unsigned (property identifier, array index, Who-Is limits). */
function contextUnsigned(tagNumber, value) {
  return withLength(tagNumber, true, unsignedBytes(value));
}

function objectIdValue(type, instance) {
  if (!Number.isInteger(type) || type < 0 || type > 1023) throw new RangeError(`object type out of range: ${type}`);
  if (!Number.isInteger(instance) || instance < 0 || instance > MAX_INSTANCE) throw new RangeError(`object instance out of range: ${instance}`);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(((type << 22) | instance) >>> 0);
  return b;
}

function contextObjectId(tagNumber, type, instance) {
  return withLength(tagNumber, true, objectIdValue(type, instance));
}

const opening = (tagNumber) => tagHeader(tagNumber, true, 6);
const closing = (tagNumber) => tagHeader(tagNumber, true, 7);

// ---- decoding --------------------------------------------------------------------------------------

/**
 * Read one tag header at `off`.
 * @returns {{tagNumber:number, context:boolean, opening:boolean, closing:boolean, length:number, lvt:number, headerLength:number}}
 */
function readTag(buf, off) {
  if (off >= buf.length) throw new BacnetDecodeError('truncated: tag expected');
  const first = buf[off];
  let p = off + 1;
  let tagNumber = first >> 4;
  if (tagNumber === 0x0f) {
    if (p >= buf.length) throw new BacnetDecodeError('truncated extended tag number');
    tagNumber = buf[p++];
  }
  const context = (first & 0x08) !== 0;
  const lvt = first & 0x07;
  if (context && lvt === 6) return { tagNumber, context, opening: true, closing: false, length: 0, lvt, headerLength: p - off };
  if (context && lvt === 7) return { tagNumber, context, opening: false, closing: true, length: 0, lvt, headerLength: p - off };
  let length = lvt;
  if (!context && tagNumber === APP.BOOLEAN) length = 0; // value in lvt
  else if (lvt === 5) {
    if (p >= buf.length) throw new BacnetDecodeError('truncated extended length');
    const ext = buf[p++];
    if (ext < 254) length = ext;
    else if (ext === 254) {
      if (p + 2 > buf.length) throw new BacnetDecodeError('truncated 16-bit length');
      length = buf.readUInt16BE(p);
      p += 2;
    } else {
      if (p + 4 > buf.length) throw new BacnetDecodeError('truncated 32-bit length');
      length = buf.readUInt32BE(p);
      p += 4;
    }
  } else if (!context && (lvt === 6 || lvt === 7)) {
    throw new BacnetDecodeError(`application tag ${tagNumber} with opening/closing marker`);
  }
  if (p + length > buf.length) throw new BacnetDecodeError(`truncated: tag ${tagNumber} declares ${length} bytes, ${buf.length - p} left`);
  return { tagNumber, context, opening: false, closing: false, length, lvt, headerLength: p - off };
}

function readUnsigned(buf, off, len) {
  if (len < 1 || len > 8) throw new BacnetDecodeError(`unsigned of ${len} bytes`);
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(buf[off + i]);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function readSigned(buf, off, len) {
  if (len < 1 || len > 8) throw new BacnetDecodeError(`signed of ${len} bytes`);
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(buf[off + i]);
  const bits = BigInt(len * 8);
  if (v & (1n << (bits - 1n))) v -= 1n << bits;
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function decodeUcs2(bytes) {
  if (bytes.length % 2) throw new BacnetDecodeError('UCS-2 string with an odd byte count');
  const swapped = Buffer.from(bytes);
  swapped.swap16(); // UCS-2 in BACnet is big endian; Node's utf16le wants little endian
  return swapped.toString('utf16le');
}

function decodeUcs4(bytes) {
  if (bytes.length % 4) throw new BacnetDecodeError('UCS-4 string with a byte count not a multiple of 4');
  let s = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const cp = bytes.readUInt32BE(i);
    if (cp > 0x10ffff) throw new BacnetDecodeError('UCS-4 code point out of range');
    s += String.fromCodePoint(cp);
  }
  return s;
}

const CHARSETS = { 0: 'utf-8', 1: 'dbcs', 2: 'jis-x-0208', 3: 'ucs-4', 4: 'ucs-2', 5: 'iso-8859-1' };

/** Character string content: charset octet + bytes. */
function decodeCharacterString(bytes) {
  if (!bytes.length) throw new BacnetDecodeError('character string without a character set');
  const set = bytes[0];
  const body = bytes.subarray(1);
  switch (set) {
    case 0:
      return { value: body.toString('utf8'), charset: 'utf-8' };
    case 4:
      return { value: decodeUcs2(body), charset: 'ucs-2' };
    case 3:
      return { value: decodeUcs4(body), charset: 'ucs-4' };
    case 5:
      return { value: body.toString('latin1'), charset: 'iso-8859-1' };
    case 1: {
      // IBM/Microsoft DBCS: two octets of code page, then the text. Without the code page tables the
      // best honest reading is latin1 of the bytes; the charset is reported so the user can tell.
      return { value: body.subarray(2).toString('latin1'), charset: 'dbcs', codePage: body.length >= 2 ? body.readUInt16BE(0) : null };
    }
    default:
      return { value: body.toString('latin1'), charset: CHARSETS[set] || `charset-${set}` };
  }
}

function decodeBitString(bytes) {
  if (!bytes.length) return [];
  const unused = bytes[0];
  if (unused > 7) throw new BacnetDecodeError('bit string with more than 7 unused bits');
  const data = bytes.subarray(1);
  const count = data.length * 8 - (data.length ? unused : 0);
  const bits = [];
  for (let i = 0; i < count; i++) bits.push(((data[i >> 3] >> (7 - (i & 7))) & 1) === 1);
  return bits;
}

const two = (n) => String(n).padStart(2, '0');

/** BACnet Date: year-1900, month, day, day-of-week; 255 means unspecified ("any"), shown as *. */
function decodeDate(b) {
  if (b.length !== 4) throw new BacnetDecodeError('date must be 4 bytes');
  const year = b[0] === 255 ? '*' : String(1900 + b[0]);
  const month = b[1] === 255 ? '*' : b[1] === 13 ? 'odd' : b[1] === 14 ? 'even' : two(b[1]);
  const day = b[2] === 255 ? '*' : b[2] === 32 ? 'last' : b[2] === 33 ? 'odd' : b[2] === 34 ? 'even' : two(b[2]);
  return `${year}-${month}-${day}`;
}

function decodeTime(b) {
  if (b.length !== 4) throw new BacnetDecodeError('time must be 4 bytes');
  const f = (n) => (n === 255 ? '*' : two(n));
  return `${f(b[0])}:${f(b[1])}:${f(b[2])}.${f(b[3])}`;
}

function decodeObjectId(b) {
  if (b.length !== 4) throw new BacnetDecodeError('object identifier must be 4 bytes');
  const raw = b.readUInt32BE(0);
  return { type: raw >>> 22, instance: raw & MAX_INSTANCE };
}

/**
 * Decode the content of one APPLICATION tag.
 * @returns {{tag:string, value:any, charset?:string}}
 */
function decodeApplicationContent(tag, buf, off) {
  const { tagNumber, length, lvt } = tag;
  const b = buf.subarray(off, off + length);
  switch (tagNumber) {
    case APP.NULL:
      return { tag: 'null', value: null };
    case APP.BOOLEAN:
      if (lvt > 1) throw new BacnetDecodeError(`boolean with value ${lvt}`);
      return { tag: 'boolean', value: lvt === 1 };
    case APP.UNSIGNED:
      return { tag: 'unsigned', value: readUnsigned(b, 0, length) };
    case APP.SIGNED:
      return { tag: 'signed', value: readSigned(b, 0, length) };
    case APP.REAL:
      if (length !== 4) throw new BacnetDecodeError('real must be 4 bytes');
      return { tag: 'real', value: b.readFloatBE(0) };
    case APP.DOUBLE:
      if (length !== 8) throw new BacnetDecodeError('double must be 8 bytes');
      return { tag: 'double', value: b.readDoubleBE(0) };
    case APP.OCTET_STRING:
      return { tag: 'octet-string', value: b.toString('hex') };
    case APP.CHARACTER_STRING: {
      const s = decodeCharacterString(b);
      return { tag: 'character-string', value: s.value, charset: s.charset };
    }
    case APP.BIT_STRING:
      return { tag: 'bit-string', value: decodeBitString(b) };
    case APP.ENUMERATED:
      return { tag: 'enumerated', value: readUnsigned(b, 0, length) };
    case APP.DATE:
      return { tag: 'date', value: decodeDate(b) };
    case APP.TIME:
      return { tag: 'time', value: decodeTime(b) };
    case APP.OBJECT_ID:
      return { tag: 'object-identifier', value: decodeObjectId(b) };
    default:
      throw new BacnetDecodeError(`reserved application tag ${tagNumber}`);
  }
}

const MAX_NESTING = 32;

/**
 * Decode a sequence of tagged values from `start` until `end` (exclusive) or a closing tag
 * `stopAtClosing` at nesting depth 0. Context-tagged primitives (inside constructed values such as
 * BACnetDateTime choices or proprietary structures) are returned as { context, hex }; constructed
 * sections as { context, items }.
 * @returns {{items:Array, next:number}} next = offset of the closing tag (or end)
 */
function decodeValues(buf, start, end, stopAtClosing = null, depth = 0) {
  // Real BACnet values nest a handful of levels; a peer must not be able to make us recurse to the stack limit.
  if (depth > MAX_NESTING) throw new BacnetDecodeError(`value nested deeper than ${MAX_NESTING} levels`);
  const items = [];
  let p = start;
  while (p < end) {
    const t = readTag(buf, p);
    if (t.closing) {
      if (stopAtClosing !== null && t.tagNumber === stopAtClosing) return { items, next: p };
      throw new BacnetDecodeError(`unexpected closing tag ${t.tagNumber}`);
    }
    if (t.opening) {
      const inner = decodeValues(buf, p + t.headerLength, end, t.tagNumber, depth + 1);
      if (inner.next >= end) throw new BacnetDecodeError(`opening tag ${t.tagNumber} is never closed`);
      items.push({ context: t.tagNumber, items: inner.items });
      p = inner.next + readTag(buf, inner.next).headerLength;
      continue;
    }
    const contentAt = p + t.headerLength;
    if (t.context) items.push({ context: t.tagNumber, hex: buf.toString('hex', contentAt, contentAt + t.length) });
    else items.push(decodeApplicationContent(t, buf, contentAt));
    p = contentAt + t.length;
  }
  if (stopAtClosing !== null) return { items, next: end };
  return { items, next: p };
}

/** Skip over one complete element (primitive, or constructed with its closing tag). @returns next offset */
function skipElement(buf, off, depth = 0) {
  if (depth > MAX_NESTING) throw new BacnetDecodeError(`value nested deeper than ${MAX_NESTING} levels`);
  const t = readTag(buf, off);
  if (t.closing) throw new BacnetDecodeError(`unexpected closing tag ${t.tagNumber}`);
  if (!t.opening) return off + t.headerLength + t.length;
  let p = off + t.headerLength;
  for (;;) {
    const n = readTag(buf, p);
    if (n.closing && n.tagNumber === t.tagNumber) return p + n.headerLength;
    p = skipElement(buf, p, depth + 1);
  }
}

/** Expect a context primitive `tagNumber` at `off`; returns { value(unsigned), next } or null when absent. */
function readContextUnsigned(buf, off, tagNumber) {
  if (off >= buf.length) return null;
  const t = readTag(buf, off);
  if (!t.context || t.opening || t.closing || t.tagNumber !== tagNumber) return null;
  return { value: readUnsigned(buf, off + t.headerLength, t.length), next: off + t.headerLength + t.length };
}

function readContextObjectId(buf, off, tagNumber) {
  if (off >= buf.length) return null;
  const t = readTag(buf, off);
  if (!t.context || t.opening || t.closing || t.tagNumber !== tagNumber || t.length !== 4) return null;
  return { value: decodeObjectId(buf.subarray(off + t.headerLength, off + t.headerLength + 4)), next: off + t.headerLength + 4 };
}

function isOpening(buf, off, tagNumber) {
  if (off >= buf.length) return false;
  const t = readTag(buf, off);
  return t.opening && t.tagNumber === tagNumber;
}

function isClosing(buf, off, tagNumber) {
  if (off >= buf.length) return false;
  const t = readTag(buf, off);
  return t.closing && t.tagNumber === tagNumber;
}

/** Read the two application enumerations of a BACnet Error (class, code) at off. */
function readErrorPair(buf, off) {
  const a = readTag(buf, off);
  if (a.context || a.tagNumber !== APP.ENUMERATED) throw new BacnetDecodeError('error class must be an enumerated value');
  const errorClass = readUnsigned(buf, off + a.headerLength, a.length);
  const o2 = off + a.headerLength + a.length;
  const b = readTag(buf, o2);
  if (b.context || b.tagNumber !== APP.ENUMERATED) throw new BacnetDecodeError('error code must be an enumerated value');
  const errorCode = readUnsigned(buf, o2 + b.headerLength, b.length);
  return { errorClass, errorCode, next: o2 + b.headerLength + b.length };
}

module.exports = {
  APP,
  APP_NAMES,
  MAX_INSTANCE,
  WILDCARD_INSTANCE,
  BacnetDecodeError,
  tagHeader,
  contextUnsigned,
  contextObjectId,
  objectIdValue,
  unsignedBytes,
  opening,
  closing,
  readTag,
  readUnsigned,
  readSigned,
  decodeApplicationContent,
  decodeCharacterString,
  decodeBitString,
  decodeDate,
  decodeTime,
  decodeObjectId,
  decodeValues,
  skipElement,
  readContextUnsigned,
  readContextObjectId,
  isOpening,
  isClosing,
  readErrorPair,
};
