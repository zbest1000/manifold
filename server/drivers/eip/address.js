'use strict';

/**
 * Logix tag addresses and their CIP symbolic paths.
 *
 *   Tag                 controller-scope tag
 *   Program:Main.Tag    program-scope tag
 *   Motor.Speed         UDT member (any depth)
 *   Arr[3]  Arr[1,2]    array element (1..3 dimensions)
 *   Word.5              bit of an integer (a trailing all-digit segment)
 *
 * Path encoding (1756-PM020 "IOI" / ODVA C-1.4.5): one ANSI extended symbolic
 * segment (0x91) per name — the program prefix `Program:Main` is a single
 * segment — and one logical member segment (0x28/0x29/0x2A) per array index.
 * Bit numbers are not encoded: the containing integer is read and the bit
 * extracted client-side.
 */

const cip = require('./cip');

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME = 40; // Logix tag/member name limit

function checkName(name, text) {
  if (!NAME.test(name)) throw new Error(`"${name}" in "${text}" is not a valid Logix name (letters, digits, _; not starting with a digit)`);
  if (name.length > MAX_NAME) throw new Error(`"${name}" in "${text}" is longer than ${MAX_NAME} characters`);
}

/**
 * @param {string} input
 * @returns {{program:string|null, segments:{name:string, indices?:number[]}[], bit:number|null}}
 * @throws {Error} explaining what is wrong
 */
function parseAddress(input) {
  if (typeof input !== 'string') throw new Error('address must be a string');
  const text = input.trim();
  if (!text) throw new Error('address is empty');
  let rest = text;
  let program = null;
  const pm = /^program:([^.\s]+)\.(.+)$/i.exec(text);
  if (pm) {
    checkName(pm[1], text);
    program = pm[1];
    rest = pm[2];
  } else if (/^program:/i.test(text)) {
    throw new Error(`"${text}": a program-scope address is Program:<program>.<tag>`);
  }

  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of rest) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth < 0) throw new Error(`unbalanced "]" in "${text}"`);
    if (ch === '.' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (depth !== 0) throw new Error(`unbalanced "[" in "${text}"`);
  parts.push(cur);

  let bit = null;
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    bit = Number(parts.pop());
    if (bit > 63) throw new Error(`bit ${bit} in "${text}" is out of range 0..63`);
  }
  const segments = parts.map((p) => {
    const m = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(p.trim());
    if (!m) throw new Error(`cannot parse "${p}" in "${text}"`);
    checkName(m[1], text);
    if (m[2] === undefined) return { name: m[1] };
    const indices = m[2].split(',').map((s) => s.trim());
    if (indices.length < 1 || indices.length > 3 || indices.some((s) => !/^\d+$/.test(s))) {
      throw new Error(`array index "[${m[2]}]" in "${text}" must be 1 to 3 non-negative integers`);
    }
    return { name: m[1], indices: indices.map(Number) };
  });
  if (segments.some((s) => !s.name)) throw new Error(`empty name in "${text}"`);
  return { program, segments, bit };
}

/** Canonical text form of a parsed address. */
function formatAddress({ program, segments, bit }) {
  const body = segments.map((s) => (s.indices ? `${s.name}[${s.indices.join(',')}]` : s.name)).join('.');
  return `${program ? `Program:${program}.` : ''}${body}${bit !== null && bit !== undefined ? `.${bit}` : ''}`;
}

/**
 * Encode a parsed address as a CIP request path (EPATH).
 * @param {ReturnType<typeof parseAddress>} addr
 * @param {{elementOverride?:number[]}} [opts] replace the indices of the LAST
 *   segment (used for BOOL arrays, where element n lives in DWORD n>>5)
 * @returns {Buffer}
 */
function encodePath(addr, opts = {}) {
  const segs = [];
  if (addr.program) segs.push(cip.symbolic(`Program:${addr.program}`));
  addr.segments.forEach((s, i) => {
    segs.push(cip.symbolic(s.name));
    const indices = i === addr.segments.length - 1 && opts.elementOverride ? opts.elementOverride : s.indices;
    if (indices) for (const idx of indices) segs.push(cip.element(idx));
  });
  return Buffer.concat(segs);
}

module.exports = { parseAddress, formatAddress, encodePath };
