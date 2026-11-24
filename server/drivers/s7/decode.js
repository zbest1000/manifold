'use strict';

/**
 * S7 value decoding. Every multi-byte S7 type is big-endian. 64-bit integers
 * (LINT, ULINT, LWORD, LTIME) are decoded as BigInt and returned as decimal
 * strings: the driver boundary carries them as text (design §4.1).
 *
 * Date/time values have no time zone on the PLC. They are returned as ISO
 * 8601 wall-clock text without an offset ("2026-11-24T10:20:30.123").
 */

class S7DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S7DecodeError';
  }
}

const STRING_DEFAULT = 254;
const WSTRING_MAX = 16382;

/**
 * Type table: fixed byte size and the normalized sample type (sparkplugEncoder
 * TYPE_MAP vocabulary). STRING/WSTRING sizes depend on `length`.
 */
const TYPES = Object.freeze({
  BOOL: { size: 1, sample: 'bool' },
  BYTE: { size: 1, sample: 'uint8' },
  WORD: { size: 2, sample: 'uint16' },
  DWORD: { size: 4, sample: 'uint32' },
  LWORD: { size: 8, sample: 'uint64' },
  SINT: { size: 1, sample: 'int8' },
  USINT: { size: 1, sample: 'uint8' },
  INT: { size: 2, sample: 'int16' },
  UINT: { size: 2, sample: 'uint16' },
  DINT: { size: 4, sample: 'int32' },
  UDINT: { size: 4, sample: 'uint32' },
  LINT: { size: 8, sample: 'int64' },
  ULINT: { size: 8, sample: 'uint64' },
  REAL: { size: 4, sample: 'float32' },
  LREAL: { size: 8, sample: 'float64' },
  CHAR: { size: 1, sample: 'string' },
  WCHAR: { size: 2, sample: 'string' },
  STRING: { size: null, sample: 'string' },
  WSTRING: { size: null, sample: 'string' },
  DATE: { size: 2, sample: 'datetime' }, // days since 1990-01-01
  TIME_OF_DAY: { size: 4, sample: 'uint32' }, // ms since midnight
  DATE_AND_TIME: { size: 8, sample: 'datetime' }, // BCD
  DTL: { size: 12, sample: 'datetime' },
  TIME: { size: 4, sample: 'int32' }, // signed ms
  LTIME: { size: 8, sample: 'int64' }, // signed ns
  S5TIME: { size: 2, sample: 'uint32' }, // ms
});

const ALIASES = Object.freeze({ DT: 'DATE_AND_TIME', TOD: 'TIME_OF_DAY', LTOD: null });

/** Canonical upper-case type name, or null when unknown. */
function normalizeType(type) {
  if (typeof type !== 'string') return null;
  const t = type.trim().toUpperCase();
  if (TYPES[t]) return t;
  return ALIASES[t] || null;
}

function stringLength(tagDef, max) {
  const len = tagDef.length === undefined || tagDef.length === null ? STRING_DEFAULT : tagDef.length;
  if (!Number.isInteger(len) || len < 1 || len > max) {
    throw new RangeError(`${tagDef.type} length must be an integer 1..${max} (characters), got ${tagDef.length}`);
  }
  return len;
}

/**
 * Bytes a tag occupies in PLC memory.
 * STRING[n] = n + 2 (max, actual), WSTRING[n] = 2n + 4 (u16 max, u16 actual).
 * @param {{type:string, length?:number}} tagDef length = max characters for strings
 * @returns {number}
 */
function byteLength(tagDef) {
  const t = normalizeType(tagDef.type);
  if (!t) throw new RangeError(`unknown S7 type "${tagDef.type}"`);
  if (t === 'STRING') return stringLength(tagDef, 254) + 2;
  if (t === 'WSTRING') return stringLength(tagDef, WSTRING_MAX) * 2 + 4;
  return TYPES[t].size;
}

function bcd(byte, what) {
  const hi = byte >> 4;
  const lo = byte & 0x0f;
  if (hi > 9 || lo > 9) throw new S7DecodeError(`${what}: byte 0x${byte.toString(16)} is not BCD`);
  return hi * 10 + lo;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function checkDate(y, mo, d, h, mi, s, what) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    throw new S7DecodeError(`${what}: ${y}-${mo}-${d} ${h}:${mi}:${s} is not a valid date/time`);
  }
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCDate() !== d) throw new S7DecodeError(`${what}: day ${d} does not exist in ${y}-${pad(mo)}`);
}

function utf16be(buf) {
  const swapped = Buffer.from(buf);
  swapped.swap16();
  return swapped.toString('utf16le');
}

function decodeS5Time(w) {
  const base = [10, 100, 1000, 10000][(w >> 12) & 0x3];
  // bits 14-15 are not relevant (Siemens S5TIME format) and are ignored
  const digits = bcd((w >> 8) & 0x0f, 'S5TIME') * 100 + bcd(w & 0xff, 'S5TIME');
  return digits * base;
}

/**
 * Decode one tag from the bytes it occupies.
 * @param {{type:string, length?:number}} tagDef
 * @param {Buffer} buf exactly byteLength(tagDef) bytes
 * @param {number} [bitOffset] 0..7, BOOL only
 * @returns {{v:number|string|boolean, type:string}} type is the normalized sample type
 * @throws {S7DecodeError|RangeError}
 */
function decode(tagDef, buf, bitOffset) {
  const t = normalizeType(tagDef.type);
  if (!t) throw new RangeError(`unknown S7 type "${tagDef.type}"`);
  const need = byteLength(tagDef);
  if (buf.length !== need) throw new RangeError(`${t} needs ${need} bytes, got ${buf.length}`);
  const type = TYPES[t].sample;
  const v = (value) => ({ v: value, type });

  switch (t) {
    case 'BOOL': {
      if (!Number.isInteger(bitOffset) || bitOffset < 0 || bitOffset > 7) throw new RangeError('BOOL needs a bit offset 0..7');
      return v(((buf[0] >> bitOffset) & 1) === 1);
    }
    case 'BYTE':
    case 'USINT':
      return v(buf.readUInt8(0));
    case 'SINT':
      return v(buf.readInt8(0));
    case 'WORD':
    case 'UINT':
      return v(buf.readUInt16BE(0));
    case 'INT':
      return v(buf.readInt16BE(0));
    case 'DWORD':
    case 'UDINT':
      return v(buf.readUInt32BE(0));
    case 'DINT':
      return v(buf.readInt32BE(0));
    case 'LINT':
      return v(buf.readBigInt64BE(0).toString());
    case 'ULINT':
    case 'LWORD':
      return v(buf.readBigUInt64BE(0).toString());
    case 'REAL':
      return v(buf.readFloatBE(0));
    case 'LREAL':
      return v(buf.readDoubleBE(0));
    case 'CHAR':
      return v(buf.toString('latin1'));
    case 'WCHAR':
      return v(utf16be(buf));
    case 'STRING': {
      // byte 0 = max length, byte 1 = actual length. Clamp the actual length to
      // the header max and to the configured length: a corrupt header must not
      // read past the variable.
      const max = need - 2;
      const actual = Math.min(buf[1], buf[0], max);
      return v(buf.subarray(2, 2 + actual).toString('latin1'));
    }
    case 'WSTRING': {
      const max = (need - 4) / 2;
      const actual = Math.min(buf.readUInt16BE(2), buf.readUInt16BE(0), max);
      return v(utf16be(buf.subarray(4, 4 + actual * 2)));
    }
    case 'DATE': {
      const days = buf.readUInt16BE(0);
      const d = new Date(Date.UTC(1990, 0, 1) + days * 86400000);
      return v(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }
    case 'TIME_OF_DAY': {
      const ms = buf.readUInt32BE(0);
      if (ms >= 86400000) throw new S7DecodeError(`TIME_OF_DAY ${ms} ms exceeds one day`);
      return v(ms);
    }
    case 'DATE_AND_TIME': {
      const yy = bcd(buf[0], 'DATE_AND_TIME year');
      const year = yy >= 90 ? 1900 + yy : 2000 + yy;
      const mo = bcd(buf[1], 'DATE_AND_TIME month');
      const d = bcd(buf[2], 'DATE_AND_TIME day');
      const h = bcd(buf[3], 'DATE_AND_TIME hour');
      const mi = bcd(buf[4], 'DATE_AND_TIME minute');
      const s = bcd(buf[5], 'DATE_AND_TIME second');
      const msHi = bcd(buf[6], 'DATE_AND_TIME milliseconds');
      const msLo = buf[7] >> 4;
      if (msLo > 9) throw new S7DecodeError('DATE_AND_TIME milliseconds: nibble is not BCD');
      checkDate(year, mo, d, h, mi, s, 'DATE_AND_TIME');
      // low nibble of byte 7 is the weekday (1 = Sunday); informational only
      return v(`${year}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(msHi * 10 + msLo, 3)}`);
    }
    case 'DTL': {
      const year = buf.readUInt16BE(0);
      const mo = buf[2];
      const d = buf[3];
      const h = buf[5];
      const mi = buf[6];
      const s = buf[7];
      const ns = buf.readUInt32BE(8);
      if (year < 1970 || year > 2554) throw new S7DecodeError(`DTL year ${year} outside 1970..2554`);
      if (ns > 999999999) throw new S7DecodeError(`DTL nanoseconds ${ns} out of range`);
      checkDate(year, mo, d, h, mi, s, 'DTL');
      const frac = ns % 1000000 === 0 ? pad(ns / 1000000, 3) : pad(ns, 9);
      return v(`${year}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${frac}`);
    }
    case 'TIME':
      return v(buf.readInt32BE(0));
    case 'LTIME':
      return v(buf.readBigInt64BE(0).toString());
    case 'S5TIME':
      return v(decodeS5Time(buf.readUInt16BE(0)));
    default:
      throw new RangeError(`unhandled type ${t}`);
  }
}

/**
 * Common interpretations of raw bytes for the commissioning probe. Each entry
 * decodes from the first byte; types that do not fit, or whose bytes are not
 * valid for the type (BCD dates, S5TIME), are omitted.
 * @param {Buffer} raw
 * @returns {Record<string, unknown>}
 */
function probeDecodings(raw) {
  const out = {};
  if (raw.length >= 1) {
    out.bits = Array.from({ length: 8 }, (_, i) => (raw[0] >> i) & 1).join('');
  }
  const candidates = ['BYTE', 'SINT', 'CHAR', 'WORD', 'INT', 'S5TIME', 'DATE', 'DWORD', 'DINT', 'REAL', 'TIME',
    'LINT', 'LREAL', 'DATE_AND_TIME', 'DTL'];
  for (const type of candidates) {
    const size = TYPES[type].size;
    if (raw.length < size) continue;
    try {
      out[type] = decode({ type }, raw.subarray(0, size)).v;
    } catch {
      /* not a valid encoding of this type */
    }
  }
  if (raw.length >= 3 && raw[1] <= raw[0] && raw[1] <= raw.length - 2) {
    out.STRING = raw.subarray(2, 2 + raw[1]).toString('latin1');
  }
  return out;
}

module.exports = { TYPES, S7DecodeError, normalizeType, byteLength, decode, probeDecodings, STRING_DEFAULT };
