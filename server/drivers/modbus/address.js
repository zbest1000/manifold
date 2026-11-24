'use strict';

/**
 * Modbus tag addresses. The table is never inferred from a bare number: it
 * comes from an explicit `table:offset` form or from a recognised Modicon
 * notation (5 digits `4xxxx`, 6 digits `4xxxxx`).
 */

const TABLES = {
  coil: { fc: 1, modicon: '0' },
  discrete: { fc: 2, modicon: '1' },
  input: { fc: 4, modicon: '3' },
  holding: { fc: 3, modicon: '4' },
};
const BY_MODICON = Object.fromEntries(Object.entries(TABLES).map(([t, d]) => [d.modicon, t]));

function build(table, offset, text) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) {
    throw new Error(`address "${text}" resolves to wire offset ${offset}, outside 0..65535`);
  }
  return { table, offset, fc: TABLES[table].fc };
}

/**
 * @param {string|number} input e.g. `holding:100`, `input:0`, `40001`, `400001`
 * @param {{base?: 0|1}} [opts] numbering of explicit `table:n` offsets (default 0 = wire)
 * @returns {{table:'coil'|'discrete'|'holding'|'input', offset:number, fc:number}}
 *   offset is the 0-based wire address
 * @throws {Error} with a message explaining the accepted forms
 */
function parseAddress(input, { base = 0 } = {}) {
  if (base !== 0 && base !== 1) throw new Error('base must be 0 or 1');
  const text = String(input).trim();

  const explicit = /^([a-z]+):(\d+)$/i.exec(text);
  if (explicit) {
    const table = explicit[1].toLowerCase();
    if (!TABLES[table]) throw new Error(`unknown table "${explicit[1]}": use coil, discrete, holding or input`);
    return build(table, Number(explicit[2]) - base, text);
  }

  if (/^\d{5,6}$/.test(text)) {
    const table = BY_MODICON[text[0]];
    if (!table) {
      throw new Error(`"${text}" is not Modicon: a ${text.length}-digit address must start with 0, 1, 3 or 4`);
    }
    return build(table, Number(text.slice(1)) - 1, text);
  }

  throw new Error(
    `cannot parse address "${text}": use "holding:100" (coil|discrete|holding|input) or Modicon 40001 / 400001; ` +
      'a bare number is ambiguous'
  );
}

/**
 * Canonical explicit form, e.g. `holding:100`.
 * @param {{table:string, offset:number}} addr
 * @param {{base?: 0|1}} [opts]
 * @returns {string}
 */
function formatAddress({ table, offset }, { base = 0 } = {}) {
  return `${table}:${offset + base}`;
}

module.exports = { TABLES, parseAddress, formatAddress };
