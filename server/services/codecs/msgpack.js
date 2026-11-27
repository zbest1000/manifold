'use strict';

/**
 * MessagePack decoder (msgpack spec, 2017 revision), hand-written, decode only.
 *
 * Every format family: positive/negative fixint, uint8-64, int8-64, nil,
 * booleans, float32/64, fixstr/str8-32, bin8-32, fixarray/array16/32,
 * fixmap/map16/32, fixext1-16 and ext8-32. The byte 0xc1 ("never used") is an
 * error.
 *
 * Extensions: the timestamp extension (type -1) in all three layouts
 * (32-bit seconds; 64-bit with 30-bit nanoseconds and 34-bit seconds; 96-bit
 * with 32-bit nanoseconds and signed 64-bit seconds) becomes an ISO 8601 UTC
 * string with up to nanosecond digits; nanoseconds above 999,999,999 are an
 * error. Any other extension becomes { ext: type, hex }.
 *
 * Output: see common.js. str payloads must be valid UTF-8 (the "raw" bytes of
 * pre-2013 msgpack that are not UTF-8 are rejected rather than mangled);
 * non-string map keys become strings.
 */

const { CodecError, makeState, spend, enter, leave, need, bigOut, floatOut, hex, text, setKey, keyString, isoFromSeconds } = require('./common');

function lengthOk(st, n, minBytesEach) {
  if (n * minBytesEach > st.buf.length - st.pos) {
    throw new CodecError(`declared length ${n} exceeds the ${st.buf.length - st.pos} byte(s) left`, st.pos);
  }
  return n;
}

function take(st, n) {
  need(st, n);
  const out = st.buf.subarray(st.pos, st.pos + n);
  st.pos += n;
  return out;
}

function u8(st) {
  need(st, 1);
  return st.buf[st.pos++];
}
function u16(st) {
  need(st, 2);
  const v = st.buf.readUInt16BE(st.pos);
  st.pos += 2;
  return v;
}
function u32(st) {
  need(st, 4);
  const v = st.buf.readUInt32BE(st.pos);
  st.pos += 4;
  return v;
}

function timestamp(st, data) {
  let sec;
  let nsec;
  if (data.length === 4) {
    sec = data.readUInt32BE(0);
    nsec = 0;
  } else if (data.length === 8) {
    const hi = data.readUInt32BE(0);
    const lo = data.readUInt32BE(4);
    nsec = hi >>> 2;
    sec = (hi & 0x3) * 2 ** 32 + lo;
  } else if (data.length === 12) {
    nsec = data.readUInt32BE(0);
    sec = data.readBigInt64BE(4);
  } else {
    throw new CodecError(`timestamp extension of ${data.length} bytes (expected 4, 8 or 12)`, st.pos);
  }
  if (nsec > 999_999_999) throw new CodecError(`timestamp nanoseconds ${nsec} out of range`, st.pos);
  const iso = isoFromSeconds(sec, nsec);
  if (iso) return iso;
  return { ext: -1, seconds: typeof sec === 'bigint' ? bigOut(sec) : sec, nanoseconds: nsec };
}

function ext(st, len) {
  need(st, 1);
  const type = st.buf.readInt8(st.pos++);
  const data = take(st, len);
  if (type === -1) return timestamp(st, data);
  return { ext: type, hex: hex(data) };
}

function array(st, n, opts) {
  lengthOk(st, n, 1);
  enter(st);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = item(st, opts);
  leave(st);
  return out;
}

function map(st, n, opts) {
  lengthOk(st, n, 2);
  enter(st);
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = item(st, opts);
    setKey(out, keyString(k), item(st, opts));
  }
  leave(st);
  return out;
}

function str(st, n) {
  return text(st, take(st, n));
}

function item(st, opts) {
  const b = u8(st);
  spend(st);
  if (b <= 0x7f) return b;
  if (b >= 0xe0) return b - 0x100;
  if (b <= 0x8f) return map(st, b & 0x0f, opts);
  if (b <= 0x9f) return array(st, b & 0x0f, opts);
  if (b <= 0xbf) return str(st, b & 0x1f);
  switch (b) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return hex(take(st, u8(st)));
    case 0xc5:
      return hex(take(st, u16(st)));
    case 0xc6:
      return hex(take(st, u32(st)));
    case 0xc7:
      return ext(st, u8(st));
    case 0xc8:
      return ext(st, u16(st));
    case 0xc9:
      return ext(st, u32(st));
    case 0xca: {
      need(st, 4);
      const v = st.buf.readFloatBE(st.pos);
      st.pos += 4;
      return floatOut(v);
    }
    case 0xcb: {
      need(st, 8);
      const v = st.buf.readDoubleBE(st.pos);
      st.pos += 8;
      return floatOut(v);
    }
    case 0xcc:
      return u8(st);
    case 0xcd:
      return u16(st);
    case 0xce:
      return u32(st);
    case 0xcf: {
      need(st, 8);
      const v = st.buf.readBigUInt64BE(st.pos);
      st.pos += 8;
      return bigOut(v);
    }
    case 0xd0:
      need(st, 1);
      return st.buf.readInt8(st.pos++);
    case 0xd1: {
      need(st, 2);
      const v = st.buf.readInt16BE(st.pos);
      st.pos += 2;
      return v;
    }
    case 0xd2: {
      need(st, 4);
      const v = st.buf.readInt32BE(st.pos);
      st.pos += 4;
      return v;
    }
    case 0xd3: {
      need(st, 8);
      const v = st.buf.readBigInt64BE(st.pos);
      st.pos += 8;
      return bigOut(v);
    }
    case 0xd4:
      return ext(st, 1);
    case 0xd5:
      return ext(st, 2);
    case 0xd6:
      return ext(st, 4);
    case 0xd7:
      return ext(st, 8);
    case 0xd8:
      return ext(st, 16);
    case 0xd9:
      return str(st, u8(st));
    case 0xda:
      return str(st, u16(st));
    case 0xdb:
      return str(st, u32(st));
    case 0xdc:
      return array(st, u16(st), opts);
    case 0xdd:
      return array(st, u32(st), opts);
    case 0xde:
      return map(st, u16(st), opts);
    case 0xdf:
      return map(st, u32(st), opts);
    default:
      throw new CodecError(`format byte 0x${b.toString(16)} is never used`, st.pos - 1);
  }
}

/** Decode one complete MessagePack object from `buf`; trailing bytes are an error. */
function decodeMsgpack(buf, limits = {}, opts = {}) {
  const st = makeState(buf, limits);
  const v = item(st, opts);
  if (st.pos !== buf.length) throw new CodecError(`${buf.length - st.pos} trailing byte(s) after the object`, st.pos);
  return v;
}

module.exports = { decodeMsgpack };
