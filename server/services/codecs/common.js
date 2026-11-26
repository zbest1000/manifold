'use strict';

/**
 * Shared pieces of the payload decoders (CBOR, MessagePack, SenML, Avro,
 * Protobuf): the bounded decode state, the error type, and the conversions
 * that turn wire values into plain, JSON-safe values.
 *
 * Output rules, the same for every codec:
 *  - Integers inside the safe range (|n| <= 2^53 - 1) are numbers. Wider
 *    integers are decimal strings, never rounded floats: the repo-wide rule for
 *    64-bit values (OPC UA Int64, Sparkplug Int64, driver LINT). Schema codecs
 *    go one step further and always emit their 64-bit types (Protobuf int64
 *    family, Avro long) as decimal strings, so a field's JSON type never
 *    depends on the value.
 *  - NaN and the infinities, which JSON cannot carry, become the strings
 *    "NaN", "Infinity" and "-Infinity".
 *  - Byte strings become lowercase hex.
 *  - Objects are plain; a "__proto__" key becomes an own property instead of
 *    rewriting the prototype.
 *
 * Bounds: every decoder runs against a byte cap (checked by the caller), a
 * nesting-depth cap and an item budget, so the work per payload is linear in
 * its size and a hostile payload (a declared array of 2^32 elements in ten
 * bytes, a recursion bomb) fails fast with a CodecError instead of allocating
 * or recursing without end.
 */

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 256 * 1024, // payloads larger than this are not decoded
  maxDepth: 32, // nesting of arrays, maps, records, messages
  maxItems: 100_000 // data items per payload (scalars + containers)
});

class CodecError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'CodecError';
    this.offset = offset;
  }
}

/** Decode state shared by the hand-written decoders. */
function makeState(buf, limits = {}) {
  return {
    buf,
    pos: 0,
    depth: 0,
    items: 0,
    maxDepth: limits.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxItems: limits.maxItems ?? DEFAULT_LIMITS.maxItems
  };
}

/** Count `n` items against the budget (n may be a declared container length). */
function spend(st, n = 1) {
  st.items += n;
  if (st.items > st.maxItems) throw new CodecError(`more than ${st.maxItems} items`, st.pos);
}

function enter(st) {
  if (++st.depth > st.maxDepth) throw new CodecError(`nested deeper than ${st.maxDepth} levels`, st.pos);
}

function leave(st) {
  st.depth--;
}

function need(st, n) {
  if (n > st.buf.length - st.pos) throw new CodecError(`truncated: needs ${n} more byte(s), ${st.buf.length - st.pos} left`, st.pos);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** A BigInt as a number when exact, else its decimal string. */
function bigOut(b) {
  return b <= MAX_SAFE && b >= MIN_SAFE ? Number(b) : b.toString();
}

/** A float as a JSON-safe value. */
function floatOut(x) {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 'NaN';
  return x > 0 ? 'Infinity' : '-Infinity';
}

const hex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');

const utf8 = new TextDecoder('utf-8', { fatal: true });
function text(st, bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new CodecError('text string is not valid UTF-8', st.pos);
  }
}

/** obj[k] = v without letting "__proto__" replace the prototype. */
function setKey(obj, k, v) {
  if (k === '__proto__') Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
  else obj[k] = v;
}

/** A map key of any decoded type as an object key. */
function keyString(k) {
  if (typeof k === 'string') return k;
  if (typeof k === 'number' || typeof k === 'boolean' || k === null) return String(k);
  if (Buffer.isBuffer(k)) return k.toString('hex');
  return JSON.stringify(k);
}

/** m * 10^e as an exact decimal string (m: BigInt, e: integer, |e| bounded by the caller). */
function decimalString(m, e) {
  if (e >= 0) return (m * 10n ** BigInt(e)).toString();
  const neg = m < 0n;
  const digits = (neg ? -m : m).toString().padStart(-e + 1, '0');
  const cut = digits.length + e;
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/** Big-endian unsigned bytes as a BigInt. */
function bytesToBig(bytes) {
  let b = 0n;
  for (const x of bytes) b = (b << 8n) | BigInt(x);
  return b;
}

const MAX_DATE_MS = 8.64e15;

/**
 * ISO 8601 UTC string for a time given as whole seconds (BigInt or number) plus
 * nanoseconds, keeping sub-millisecond digits (3, 6 or 9 fraction digits).
 * Returns null when the time is outside what a Date can represent.
 */
function isoFromSeconds(sec, nanos = 0, { zulu = true } = {}) {
  const s = typeof sec === 'bigint' ? Number(sec) : sec;
  if (!Number.isFinite(s) || Math.abs(s * 1000) > MAX_DATE_MS) return null;
  const base = new Date(s * 1000).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  let frac = String(nanos).padStart(9, '0');
  while (frac.length > 3 && frac.endsWith('000')) frac = frac.slice(0, -3);
  return `${base}.${frac}${zulu ? 'Z' : ''}`;
}

module.exports = {
  DEFAULT_LIMITS,
  CodecError,
  makeState,
  spend,
  enter,
  leave,
  need,
  bigOut,
  floatOut,
  hex,
  text,
  setKey,
  keyString,
  decimalString,
  bytesToBig,
  isoFromSeconds
};
