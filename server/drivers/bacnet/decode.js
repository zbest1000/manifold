'use strict';

/**
 * Decoded BACnet property values -> samples ({ v, type }) and quality.
 */

const { PROP, BINARY_TYPES, objectTypeName } = require('./address');
const { RELIABILITY } = require('./enums');
const { BacnetDecodeError } = require('./encoding');

const Q_GOOD = 192;
const Q_UNCERTAIN = 64;
const Q_BAD = 0;

const TAG_TYPES = ['float32', 'float64', 'int32', 'uint32', 'int64', 'uint64', 'bool', 'string', 'struct'];

function statusFlags(bits) {
  return { inAlarm: Boolean(bits[0]), fault: Boolean(bits[1]), overridden: Boolean(bits[2]), outOfService: Boolean(bits[3]) };
}

/** One decoded application item -> a JSON-safe value. */
function plain(item) {
  if (item.items) return { context: item.context, items: item.items.map(plain) };
  if (item.hex !== undefined) return { context: item.context, hex: item.hex };
  if (item.tag === 'object-identifier') return `${objectTypeName(item.value.type)}:${item.value.instance}`;
  if (typeof item.value === 'bigint') return item.value.toString();
  return item.value;
}

function intType(tag, value) {
  const big = typeof value === 'bigint' || Math.abs(value) > 0xffffffff;
  if (tag === 'signed') return big || value < -0x80000000 || value > 0x7fffffff ? 'int64' : 'int32';
  return big ? 'uint64' : 'uint32';
}

/**
 * Natural sample for a property value.
 * @param {Array} items decoded items (encoding.decodeValues)
 * @param {{objectType:number, property:number}} ctx
 * @returns {{v:any, type:string}}
 */
function naturalValue(items, { objectType, property }) {
  if (!items.length) return { v: null, type: 'struct' };
  if (items.length > 1 || items[0].items || items[0].hex !== undefined) {
    return { v: items.map(plain), type: 'struct' };
  }
  const it = items[0];
  switch (it.tag) {
    case 'null':
      return { v: null, type: 'struct' };
    case 'boolean':
      return { v: it.value, type: 'bool' };
    case 'unsigned':
    case 'signed':
      return { v: typeof it.value === 'bigint' ? it.value.toString() : it.value, type: intType(it.tag, it.value) };
    case 'real':
      return { v: it.value, type: 'float32' };
    case 'double':
      return { v: it.value, type: 'float64' };
    case 'enumerated':
      // Binary objects: present-value / relinquish-default are BACnetBinaryPV (0 inactive, 1 active).
      if (BINARY_TYPES.has(objectType) && (property === PROP.PRESENT_VALUE || property === 104)) return { v: it.value === 1, type: 'bool' };
      return { v: typeof it.value === 'bigint' ? it.value.toString() : it.value, type: 'uint32' };
    case 'bit-string':
      if (property === PROP.STATUS_FLAGS) return { v: statusFlags(it.value), type: 'struct' };
      return { v: it.value, type: 'struct' };
    case 'character-string':
    case 'octet-string':
    case 'date':
    case 'time':
    case 'object-identifier':
      return { v: plain(it), type: 'string' };
    default:
      return { v: plain(it), type: 'struct' };
  }
}

/** Apply a user-declared tag type to the natural value. @throws {BacnetDecodeError} */
function castValue(natural, type) {
  if (!type || type === natural.type) return natural;
  const { v } = natural;
  if (v === null) return { v: null, type };
  switch (type) {
    case 'string':
      return { v: typeof v === 'object' ? JSON.stringify(v) : String(v), type };
    case 'struct':
      return { v, type };
    case 'bool':
      if (typeof v === 'boolean') return { v, type };
      if (typeof v === 'number') return { v: v !== 0, type };
      throw new BacnetDecodeError(`cannot read a ${natural.type} value as bool`);
    case 'int64':
    case 'uint64':
      if (typeof v === 'number' && Number.isInteger(v)) return { v, type };
      if (typeof v === 'string' && /^-?\d+$/.test(v)) return { v, type };
      if (typeof v === 'boolean') return { v: v ? 1 : 0, type };
      throw new BacnetDecodeError(`cannot read a ${natural.type} value as ${type}`);
    default: {
      // float32, float64, int32, uint32
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (Number.isNaN(n) && !(typeof v === 'number')) throw new BacnetDecodeError(`cannot read a ${natural.type} value as ${type}`);
      if ((type === 'int32' || type === 'uint32') && Number.isFinite(n)) return { v: Math.trunc(n), type };
      return { v: n, type };
    }
  }
}

/**
 * Quality from the status properties read with present-value.
 * @param {{statusFlags?:boolean[], reliability?:number, outOfService?:boolean}} s
 * @returns {{q:number, qReason?:string}}
 */
function qualityOf(s) {
  if (s.reliability !== undefined && s.reliability !== 0) {
    return { q: Q_BAD, qReason: `reliability: ${RELIABILITY[s.reliability] || s.reliability}` };
  }
  const flags = s.statusFlags ? statusFlags(s.statusFlags) : null;
  if (flags && flags.fault) return { q: Q_BAD, qReason: 'fault' };
  if (s.outOfService === true || (flags && flags.outOfService)) return { q: Q_UNCERTAIN, qReason: 'out-of-service' };
  return { q: Q_GOOD };
}

module.exports = { TAG_TYPES, Q_GOOD, Q_UNCERTAIN, Q_BAD, naturalValue, castValue, qualityOf, statusFlags, plain };
