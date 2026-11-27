'use strict';

/**
 * CBOR decoder (RFC 8949), hand-written, decode only.
 *
 * Supported: all eight major types; definite and indefinite lengths for byte
 * strings, text strings, arrays and maps; half, single and double floats;
 * simple values; 64-bit arguments. Tags handled:
 *   0  date/time string      -> the string
 *   1  epoch time            -> ISO 8601 UTC string
 *   2  unsigned bignum       -> decimal string
 *   3  negative bignum       -> decimal string
 *   4  decimal fraction      -> exact decimal string
 *   37 UUID (16 bytes)       -> canonical UUID string
 *   55799 self-described CBOR -> the content
 * Any other tag decodes as { tag, value }.
 *
 * Rejected as not well-formed (RFC 8949 §3, Appendix F): reserved additional
 * information 28-30, indefinite length on major types 0, 1 and 6, a stray
 * "break", chunks of an indefinite string that are not definite strings of the
 * same major type, two-byte simple values below 32, trailing bytes after the
 * top-level item, and invalid UTF-8 in text strings.
 *
 * Output: see common.js (hex for bytes, decimal strings for integers outside
 * the safe range, "NaN"/"Infinity" for non-finite floats, keys as strings).
 * Map keys that are not text become strings (integers as decimal, byte strings
 * as hex, anything else as its JSON). Undefined (simple 23) becomes null;
 * other unassigned simple values become { simple: n }.
 */

const { CodecError, makeState, spend, enter, leave, need, bigOut, floatOut, hex, text, setKey, keyString, decimalString, bytesToBig, isoFromSeconds } = require('./common');

const BREAK = Symbol('break');

function half(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** The argument of an initial byte: a number, a BigInt (8-byte), or -1 for indefinite. */
function readArg(st, ai) {
  if (ai < 24) return ai;
  const { buf } = st;
  switch (ai) {
    case 24:
      need(st, 1);
      return buf[st.pos++];
    case 25: {
      need(st, 2);
      const v = buf.readUInt16BE(st.pos);
      st.pos += 2;
      return v;
    }
    case 26: {
      need(st, 4);
      const v = buf.readUInt32BE(st.pos);
      st.pos += 4;
      return v;
    }
    case 27: {
      need(st, 8);
      const v = buf.readBigUInt64BE(st.pos);
      st.pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case 31:
      return -1;
    default:
      throw new CodecError(`reserved additional information ${ai}`, st.pos - 1);
  }
}

/** A definite length as a safe number, refusing lengths the remaining bytes cannot hold. */
function lengthOf(st, arg, minBytesEach) {
  if (typeof arg === 'bigint' || arg * minBytesEach > st.buf.length - st.pos) {
    throw new CodecError(`declared length ${arg} exceeds the ${st.buf.length - st.pos} byte(s) left`, st.pos);
  }
  return arg;
}

/** Raw bytes of a byte or text string (major type `mt`), definite or indefinite. */
function readStringBytes(st, mt, arg) {
  if (arg !== -1) {
    const n = lengthOf(st, arg, 1);
    const out = st.buf.subarray(st.pos, st.pos + n);
    st.pos += n;
    return out;
  }
  const chunks = [];
  for (;;) {
    need(st, 1);
    const ib = st.buf[st.pos++];
    if (ib === 0xff) break;
    if (ib >> 5 !== mt) throw new CodecError('indefinite-length string chunk of another major type', st.pos - 1);
    const ca = readArg(st, ib & 0x1f);
    if (ca === -1) throw new CodecError('nested indefinite-length string chunk', st.pos - 1);
    spend(st);
    const n = lengthOf(st, ca, 1);
    chunks.push(st.buf.subarray(st.pos, st.pos + n));
    st.pos += n;
  }
  return Buffer.concat(chunks);
}

function item(st, opts) {
  need(st, 1);
  const start = st.pos;
  const ib = st.buf[st.pos++];
  const mt = ib >> 5;
  const ai = ib & 0x1f;
  spend(st);
  if (mt === 7) {
    switch (ai) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
      case 23:
        return null;
      case 24: {
        need(st, 1);
        const v = st.buf[st.pos++];
        if (v < 32) throw new CodecError(`two-byte simple value ${v} is not well-formed`, start);
        return { simple: v };
      }
      case 25: {
        need(st, 2);
        const v = half(st.buf.readUInt16BE(st.pos));
        st.pos += 2;
        return floatOut(v);
      }
      case 26: {
        need(st, 4);
        const v = st.buf.readFloatBE(st.pos);
        st.pos += 4;
        return floatOut(v);
      }
      case 27: {
        need(st, 8);
        const v = st.buf.readDoubleBE(st.pos);
        st.pos += 8;
        return floatOut(v);
      }
      case 31:
        return BREAK;
      default:
        if (ai < 20) return { simple: ai };
        throw new CodecError(`reserved additional information ${ai}`, start);
    }
  }
  const arg = readArg(st, ai);
  switch (mt) {
    case 0:
      if (arg === -1) throw new CodecError('indefinite length on an integer', start);
      return typeof arg === 'bigint' ? bigOut(arg) : arg;
    case 1:
      if (arg === -1) throw new CodecError('indefinite length on an integer', start);
      return typeof arg === 'bigint' ? bigOut(-1n - arg) : arg >= Number.MAX_SAFE_INTEGER ? bigOut(-1n - BigInt(arg)) : -1 - arg;
    case 2: {
      const bytes = readStringBytes(st, 2, arg);
      return opts.rawBytes ? Buffer.from(bytes) : hex(bytes);
    }
    case 3:
      return text(st, readStringBytes(st, 3, arg));
    case 4: {
      enter(st);
      const out = [];
      if (arg === -1) {
        for (;;) {
          const v = item(st, opts);
          if (v === BREAK) break;
          out.push(v);
        }
      } else {
        const n = lengthOf(st, arg, 1);
        for (let i = 0; i < n; i++) {
          const v = item(st, opts);
          if (v === BREAK) throw new CodecError('unexpected break', st.pos - 1);
          out.push(v);
        }
      }
      leave(st);
      return out;
    }
    case 5: {
      enter(st);
      const out = {};
      const n = arg === -1 ? Infinity : lengthOf(st, arg, 2);
      for (let i = 0; i < n; i++) {
        const k = item(st, opts);
        if (k === BREAK) {
          if (arg === -1) break;
          throw new CodecError('unexpected break', st.pos - 1);
        }
        const v = item(st, opts);
        if (v === BREAK) throw new CodecError('map key without a value', st.pos - 1);
        setKey(out, keyString(k), v);
      }
      leave(st);
      return out;
    }
    case 6:
      if (arg === -1) throw new CodecError('indefinite length on a tag', start);
      return tagged(st, arg, opts);
    default:
      throw new CodecError(`unknown major type ${mt}`, start);
  }
}

function nextIsBytes(st) {
  return st.pos < st.buf.length && st.buf[st.pos] >> 5 === 2;
}

/** Raw bytes of the next item, which must be a byte string. */
function rawBytesItem(st) {
  const ib = st.buf[st.pos++];
  spend(st);
  return readStringBytes(st, 2, readArg(st, ib & 0x1f));
}

function tagged(st, tag, opts) {
  enter(st);
  try {
    if ((tag === 2 || tag === 3) && nextIsBytes(st)) {
      const n = bytesToBig(rawBytesItem(st));
      return (tag === 2 ? n : -1n - n).toString();
    }
    if (tag === 37 && nextIsBytes(st)) {
      const b = rawBytesItem(st);
      if (b.length === 16) {
        const h = Buffer.from(b).toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      return { tag, value: hex(b) };
    }
    const value = item(st, opts);
    if (value === BREAK) throw new CodecError('unexpected break', st.pos - 1);
    if (tag === 55799) return value;
    if (tag === 1 && typeof value === 'number') {
      const whole = Math.floor(value);
      const iso = isoFromSeconds(whole, Math.round((value - whole) * 1e9) % 1e9);
      if (iso) return iso;
    }
    if (tag === 4 && Array.isArray(value) && value.length === 2 && Number.isInteger(value[0]) && Math.abs(value[0]) <= 1000) {
      const m = value[1];
      if (Number.isInteger(m) || (typeof m === 'string' && /^-?\d+$/.test(m))) return decimalString(BigInt(m), value[0]);
    }
    if (tag === 0 && typeof value === 'string') return value;
    return { tag: typeof tag === 'bigint' ? tag.toString() : tag, value };
  } finally {
    leave(st);
  }
}

/**
 * Decode one complete CBOR item from `buf`. Throws CodecError when the bytes
 * are not exactly one well-formed item. `opts.rawBytes` keeps byte strings as
 * Buffers (for SenML, which converts them itself).
 */
function decodeCbor(buf, limits = {}, opts = {}) {
  const st = makeState(buf, limits);
  const v = item(st, opts);
  if (v === BREAK) throw new CodecError('unexpected break', 0);
  if (st.pos !== buf.length) throw new CodecError(`${buf.length - st.pos} trailing byte(s) after the item`, st.pos);
  return v;
}

module.exports = { decodeCbor, half };
