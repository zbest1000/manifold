'use strict';

/**
 * CBOR decoder (RFC 8949), decode only.
 *
 * Output mapping
 *   unsigned / negative integers  number when exactly representable, else a decimal string
 *   byte strings                  lowercase hex string
 *   text strings                  string (invalid UTF-8 is an error)
 *   arrays                        Array
 *   maps                          null-prototype object, keys stringified (integer keys "-2", "0", ...)
 *   tags                          transparent, except 2/3 (bignum -> number or decimal string),
 *                                 4 (decimal fraction) and 5 (bigfloat) which become numbers
 *   false / true / null           boolean / boolean / null
 *   undefined                     null
 *   other simple values           the simple value number
 *   half / single / double floats number (NaN and the infinities included)
 *
 * Defensive limits: nesting depth, total item count, and every declared length
 * must fit in the bytes that are actually present (no allocation driven by a
 * claimed size). Indefinite-length strings, arrays and maps are supported.
 */

class CborError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 32;
const MAX_ITEMS = 100000;
const MAX_BIGNUM_BYTES = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function half(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function bigToValue(big) {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

class Reader {
  constructor(buf, maxDepth, maxItems) {
    this.buf = buf;
    this.p = 0;
    this.maxDepth = maxDepth;
    this.items = 0;
    this.maxItems = maxItems;
  }

  need(n) {
    if (this.p + n > this.buf.length) throw new CborError('truncated item');
  }

  /** Argument for additional info `ai`: { n: number|bigint, big: boolean } or { indefinite: true }. */
  argument(ai) {
    if (ai < 24) return { n: ai };
    if (ai === 24) {
      this.need(1);
      return { n: this.buf[this.p++] };
    }
    if (ai === 25) {
      this.need(2);
      const n = this.buf.readUInt16BE(this.p);
      this.p += 2;
      return { n };
    }
    if (ai === 26) {
      this.need(4);
      const n = this.buf.readUInt32BE(this.p);
      this.p += 4;
      return { n };
    }
    if (ai === 27) {
      this.need(8);
      const big = this.buf.readBigUInt64BE(this.p);
      this.p += 8;
      return { n: big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big };
    }
    if (ai === 31) return { indefinite: true };
    throw new CborError(`reserved additional information ${ai}`);
  }

  length(arg) {
    if (typeof arg.n !== 'number') throw new CborError('length too large');
    return arg.n;
  }

  item(depth) {
    if (depth > this.maxDepth) throw new CborError('nesting too deep');
    if (++this.items > this.maxItems) throw new CborError('too many items');
    this.need(1);
    const ib = this.buf[this.p++];
    const major = ib >> 5;
    const ai = ib & 31;
    if (major === 7) return this.simple(ai);
    const arg = this.argument(ai);
    switch (major) {
      case 0:
        if (arg.indefinite) throw new CborError('indefinite-length integer');
        return typeof arg.n === 'bigint' ? bigToValue(arg.n) : arg.n;
      case 1:
        if (arg.indefinite) throw new CborError('indefinite-length integer');
        return bigToValue(-1n - BigInt(arg.n));
      case 2:
      case 3: {
        const chunks = [];
        if (arg.indefinite) {
          for (;;) {
            this.need(1);
            if (this.buf[this.p] === 0xff) {
              this.p++;
              break;
            }
            const ib2 = this.buf[this.p++];
            if (ib2 >> 5 !== major) throw new CborError('indefinite string chunk of the wrong type');
            const a2 = this.argument(ib2 & 31);
            if (a2.indefinite) throw new CborError('nested indefinite string');
            const len = this.length(a2);
            this.need(len);
            chunks.push(this.buf.subarray(this.p, this.p + len));
            this.p += len;
          }
        } else {
          const len = this.length(arg);
          this.need(len);
          chunks.push(this.buf.subarray(this.p, this.p + len));
          this.p += len;
        }
        const all = Buffer.concat(chunks);
        if (major === 2) return all.toString('hex');
        try {
          return utf8.decode(all);
        } catch {
          throw new CborError('text string is not valid UTF-8');
        }
      }
      case 4: {
        const out = [];
        if (arg.indefinite) {
          for (;;) {
            this.need(1);
            if (this.buf[this.p] === 0xff) {
              this.p++;
              break;
            }
            out.push(this.item(depth + 1));
          }
        } else {
          const len = this.length(arg);
          if (len > this.buf.length - this.p) throw new CborError('array longer than the remaining data');
          for (let i = 0; i < len; i++) out.push(this.item(depth + 1));
        }
        return out;
      }
      case 5: {
        const out = Object.create(null);
        const put = () => {
          const k = this.item(depth + 1);
          if (k !== null && typeof k === 'object') throw new CborError('map key is not a scalar');
          out[String(k)] = this.item(depth + 1);
        };
        if (arg.indefinite) {
          for (;;) {
            this.need(1);
            if (this.buf[this.p] === 0xff) {
              this.p++;
              break;
            }
            put();
          }
        } else {
          const len = this.length(arg);
          if (len * 2 > this.buf.length - this.p) throw new CborError('map larger than the remaining data');
          for (let i = 0; i < len; i++) put();
        }
        return out;
      }
      case 6: {
        if (arg.indefinite) throw new CborError('indefinite-length tag');
        const tag = Number(arg.n);
        if ((tag === 2 || tag === 3) && (this.p >= this.buf.length || this.buf[this.p] >> 5 !== 2)) throw new CborError('bignum content is not a byte string');
        const inner = this.item(depth + 1);
        return this.tagged(tag, inner);
      }
      default:
        throw new CborError('unreachable major type');
    }
  }

  tagged(tag, v) {
    if (tag === 2 || tag === 3) {
      if (typeof v !== 'string') throw new CborError('bignum content is not a byte string');
      // Decimal conversion of a huge bignum is quadratic: a 1 MiB one blocks the driver for seconds.
      if (v.length > MAX_BIGNUM_BYTES * 2) throw new CborError(`bignum longer than ${MAX_BIGNUM_BYTES} bytes`);
      const big = v === '' ? 0n : BigInt(`0x${v}`);
      return bigToValue(tag === 2 ? big : -1n - big);
    }
    if (tag === 4 || tag === 5) {
      if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number') throw new CborError('malformed decimal fraction');
      const m = Number(v[1]);
      return tag === 4 ? m * 10 ** v[0] : m * 2 ** v[0];
    }
    return v;
  }

  simple(ai) {
    if (ai < 20) return ai;
    if (ai === 20) return false;
    if (ai === 21) return true;
    if (ai === 22) return null;
    if (ai === 23) return null; // undefined
    if (ai === 24) {
      this.need(1);
      const v = this.buf[this.p++];
      if (v < 32) throw new CborError('simple value below 32 in the two-byte form');
      return v;
    }
    if (ai === 25) {
      this.need(2);
      const h = this.buf.readUInt16BE(this.p);
      this.p += 2;
      return half(h);
    }
    if (ai === 26) {
      this.need(4);
      const f = this.buf.readFloatBE(this.p);
      this.p += 4;
      return f;
    }
    if (ai === 27) {
      this.need(8);
      const f = this.buf.readDoubleBE(this.p);
      this.p += 8;
      return f;
    }
    if (ai === 31) throw new CborError('unexpected break');
    throw new CborError(`reserved simple value ${ai}`);
  }
}

/**
 * Decode exactly one CBOR data item; trailing bytes are an error.
 * @param {Buffer} buf
 * @param {{maxDepth?:number, maxItems?:number}} [opts]
 */
function decode(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const r = new Reader(buf, opts.maxDepth || MAX_DEPTH, opts.maxItems || MAX_ITEMS);
  const v = r.item(0);
  if (r.p !== buf.length) throw new CborError(`${buf.length - r.p} trailing byte(s) after the data item`);
  return v;
}

module.exports = { decode, CborError, half };
