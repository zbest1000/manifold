'use strict';

/**
 * Register decoding. Wire registers are big-endian 16-bit words. `byteOrder`
 * ('big'|'little') describes the byte order within a word and `wordOrder`
 * between words, which covers the four layouts:
 *   ABCD = big/big, CDAB = word order little, BADC = byte order little, DCBA = both little.
 */

// Registers per numeric type; bool and string are handled separately.
const WIDTH = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, int64: 4, uint64: 4, float64: 4 };

const READERS = {
  int16: (b) => b.readInt16BE(0),
  uint16: (b) => b.readUInt16BE(0),
  int32: (b) => b.readInt32BE(0),
  uint32: (b) => b.readUInt32BE(0),
  float32: (b) => b.readFloatBE(0),
  int64: (b) => b.readBigInt64BE(0),
  uint64: (b) => b.readBigUInt64BE(0),
  float64: (b) => b.readDoubleBE(0),
};

/**
 * Number of wire units a tag occupies: registers, or 1 for a bool.
 * @param {{type:string, length?:number}} tag
 * @returns {number}
 */
function registerCount(tag) {
  if (tag.type === 'bool') return 1;
  if (tag.type === 'string') {
    if (!Number.isInteger(tag.length) || tag.length < 1) {
      throw new Error('string tag needs a positive integer length (registers)');
    }
    return tag.length;
  }
  if (!WIDTH[tag.type]) throw new Error(`unknown type "${tag.type}"`);
  return WIDTH[tag.type];
}

/** Reorder wire bytes into canonical big-endian (ABCD) for the given orders. */
function canonical(words, byteOrder = 'big', wordOrder = 'big') {
  const out = Buffer.from(words);
  if (byteOrder === 'little') {
    for (let i = 0; i + 1 < out.length; i += 2) out.writeUInt16BE(out.readUInt16LE(i), i);
  }
  if (wordOrder === 'little') {
    const reversed = Buffer.alloc(out.length);
    for (let i = 0; i < out.length; i += 2) out.copy(reversed, out.length - 2 - i, i, i + 2);
    return reversed;
  }
  return out;
}

function isSentinel(raw, sentinels) {
  return sentinels.some((s) => (typeof raw === 'bigint' ? Number.isInteger(s) && BigInt(s) === raw : s === raw));
}

/**
 * Decode raw wire bytes for one tag.
 *
 * A `bool` with `bit` (0..15) reads that bit of one register; a `bool`
 * without `bit` (coil/discrete) is the least significant bit of the first byte.
 *
 * @param {{type:string, bit?:number, length?:number, byteOrder?:string, wordOrder?:string,
 *   scale?:number, offset?:number, sentinels?:number[]}} tag
 * @param {Buffer} words registerCount(tag) registers, 2 bytes each (1 byte for a coil bool)
 * @returns {{v:number|bigint|string|boolean|null, type:string, unavailable?:true}}
 */
function decode(tag, words) {
  const { type } = tag;
  const coil = type === 'bool' && tag.bit === undefined;
  const need = coil ? 1 : registerCount(tag) * 2;
  if (words.length !== need) throw new RangeError(`${type} needs ${need} bytes, got ${words.length}`);

  if (type === 'bool') {
    if (coil) return { v: (words[0] & 1) === 1, type };
    if (!Number.isInteger(tag.bit) || tag.bit < 0 || tag.bit > 15) throw new RangeError('bit must be 0..15');
    return { v: ((canonical(words, tag.byteOrder).readUInt16BE(0) >> tag.bit) & 1) === 1, type };
  }

  if (type === 'string') {
    const bytes = tag.byteOrder === 'little' ? canonical(words, 'little') : words;
    return { v: bytes.toString('latin1').replace(/[\0 ]+$/, ''), type };
  }

  const raw = READERS[type](canonical(words, tag.byteOrder, tag.wordOrder));
  if (isSentinel(raw, tag.sentinels || [])) return { v: null, type, unavailable: true };
  if (typeof raw === 'bigint') return { v: raw, type };
  return { v: raw * (tag.scale ?? 1) + (tag.offset ?? 0), type };
}

const ORDERS = {
  ABCD: { byteOrder: 'big', wordOrder: 'big' },
  CDAB: { byteOrder: 'big', wordOrder: 'little' },
  BADC: { byteOrder: 'little', wordOrder: 'big' },
  DCBA: { byteOrder: 'little', wordOrder: 'little' },
};

/**
 * Show the same raw registers under all four byte/word orders for the
 * commissioning UI. int16/uint16 use the first register; 32-bit values need
 * at least two registers and are omitted otherwise.
 * @param {Buffer} words raw registers (even byte length, at least 2)
 * @returns {Record<'ABCD'|'CDAB'|'BADC'|'DCBA', Record<string, number>>}
 */
function probeDecodings(words) {
  const out = {};
  for (const [name, orders] of Object.entries(ORDERS)) {
    const row = {};
    for (const type of ['int16', 'uint16', 'int32', 'uint32', 'float32']) {
      const bytes = WIDTH[type] * 2;
      if (words.length >= bytes) row[type] = decode({ type, ...orders }, words.subarray(0, bytes)).v;
    }
    out[name] = row;
  }
  return out;
}

module.exports = { registerCount, decode, probeDecodings };
