'use strict';

/**
 * S7 absolute addresses (classic S7comm; symbolic/optimized access is not
 * possible over this protocol).
 *
 * CANONICAL SYNTAX — Siemens absolute notation, English mnemonics:
 *
 *   DB<n>.DBX<byte>.<bit>   bit in a data block             DB10.DBX0.1
 *   DB<n>.DBB<byte>         byte-addressed start in a DB    DB10.DBB2
 *   DB<n>.DBW<byte>         2-byte value                    DB10.DBW4
 *   DB<n>.DBD<byte>         4-byte value                    DB10.DBD8
 *   M<byte>.<bit>  MB<byte>  MW<byte>  MD<byte>             merker / flags
 *   I<byte>.<bit>  IB  IW  ID                               process image inputs
 *   Q<byte>.<bit>  QB  QW  QD                               process image outputs
 *
 * Accepted on input as well: lower case, German mnemonics (E = I, A = Q:
 * `E0.0`, `EW2`, `A1.3`, `AB0`) and an explicit X on non-DB bits (`MX0.1`).
 *
 * The address names WHERE a value starts; the tag's `type` (a separate field,
 * never inferred) says how many bytes are read and how they are decoded. The
 * size letter only has to agree with the type: X ⇔ BOOL, W ⇒ a 2-byte type,
 * D ⇒ a 4-byte type, B = "starts at this byte" and is valid for any non-BOOL
 * type (use it for LREAL, LINT, STRING, DTL, …). `formatAddress` picks the
 * natural letter for the type.
 */

const { AREA, MAX_BYTE_OFFSET } = require('./frame');

const AREA_ALIASES = { I: 'I', E: 'I', Q: 'Q', A: 'Q', M: 'M' };

const HELP =
  'use Siemens absolute notation: DB10.DBX0.1, DB10.DBB2, DB10.DBW4, DB10.DBD8, M0.1, MB0, MW2, MD4, I0.0/E0.0, IW2, Q0.0/A0.0, QB1';

function fail(text, why) {
  throw new Error(`invalid S7 address "${text}": ${why}; ${HELP}`);
}

/**
 * @param {string} input
 * @returns {{area:'DB'|'M'|'I'|'Q', areaCode:number, db:number, byteOffset:number,
 *   bitOffset:number|null, size:'X'|'B'|'W'|'D'}} db is 0 outside the DB area
 * @throws {Error} explaining the accepted forms
 */
function parseAddress(input) {
  if (typeof input !== 'string') fail(String(input), 'address must be a string');
  const text = input.trim();
  const up = text.toUpperCase().replace(/\s+/g, '');

  let area;
  let db = 0;
  let size;
  let byteStr;
  let bitStr;

  const dbm = /^DB(\d+)\.DB([XBWD])(\d+)(?:\.(\d+))?$/.exec(up);
  if (dbm) {
    area = 'DB';
    db = Number(dbm[1]);
    [, , size, byteStr, bitStr] = dbm;
    if (!Number.isInteger(db) || db < 1 || db > 0xffff) fail(text, 'DB number must be 1..65535');
  } else {
    const m = /^([IEQAM])([XBWD])?(\d+)(?:\.(\d+))?$/.exec(up);
    if (!m) fail(text, 'unrecognised form');
    area = AREA_ALIASES[m[1]];
    size = m[2] || 'X';
    [, , , byteStr, bitStr] = m;
  }

  const byteOffset = Number(byteStr);
  if (!Number.isSafeInteger(byteOffset) || byteOffset > MAX_BYTE_OFFSET) {
    fail(text, `byte offset must be 0..${MAX_BYTE_OFFSET}`);
  }
  let bitOffset = null;
  if (size === 'X') {
    if (bitStr === undefined) fail(text, 'a bit address needs .<bit> (0..7)');
    bitOffset = Number(bitStr);
    if (bitOffset > 7) fail(text, 'bit must be 0..7');
  } else if (bitStr !== undefined) {
    fail(text, `a ${size} address has no bit part`);
  }
  return { area, areaCode: AREA[area], db, byteOffset, bitOffset, size };
}

/**
 * Canonical text for a parsed address.
 * @param {{area:string, db?:number, byteOffset:number, bitOffset?:number|null, size?:string}} a
 */
function formatAddress(a) {
  const size = a.size || (a.bitOffset !== null && a.bitOffset !== undefined ? 'X' : 'B');
  if (a.area === 'DB') {
    return size === 'X' ? `DB${a.db}.DBX${a.byteOffset}.${a.bitOffset}` : `DB${a.db}.DB${size}${a.byteOffset}`;
  }
  if (!['M', 'I', 'Q'].includes(a.area)) throw new Error(`unknown area ${a.area}`);
  return size === 'X' ? `${a.area}${a.byteOffset}.${a.bitOffset}` : `${a.area}${size}${a.byteOffset}`;
}

module.exports = { parseAddress, formatAddress, ADDRESS_HELP: HELP };
