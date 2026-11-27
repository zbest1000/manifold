'use strict';

/**
 * BACnet tag addresses:
 *
 *   <object-type>:<instance>[/<property>][[<index>]]
 *
 *   analog-input:3                 present-value of AI 3
 *   analog-value:7/units           a named property
 *   device:1234/object-list[0]     an array element (index 0 is the array length)
 *   multi-state-value:2/state-text[3]
 *   130:5/85                       proprietary object type 130, property 85 by number
 *   av:7, bi:2, msv:1 ...          the usual short forms of the common object types
 *
 * Object types and properties are the standard names in kebab case (clause 21) or numbers.
 */

const { OBJECT_TYPES, PROPERTIES } = require('./enums');
const { MAX_INSTANCE } = require('./encoding');

const PROP = Object.freeze({
  ACTIVE_TEXT: 4, APDU_TIMEOUT: 11, APPLICATION_SOFTWARE_VERSION: 12, DESCRIPTION: 28, EVENT_STATE: 36, FIRMWARE_REVISION: 44,
  INACTIVE_TEXT: 46, MAX_APDU_LENGTH_ACCEPTED: 62, MODEL_NAME: 70, NUMBER_OF_APDU_RETRIES: 73, NUMBER_OF_STATES: 74,
  OBJECT_IDENTIFIER: 75, OBJECT_LIST: 76, OBJECT_NAME: 77, OBJECT_TYPE: 79, OUT_OF_SERVICE: 81, PRESENT_VALUE: 85,
  PRIORITY_ARRAY: 87, PROTOCOL_VERSION: 98, RELIABILITY: 103, SEGMENTATION_SUPPORTED: 107, STATE_TEXT: 110,
  STATUS_FLAGS: 111, SYSTEM_STATUS: 112, UNITS: 117, VENDOR_IDENTIFIER: 120, VENDOR_NAME: 121, PROTOCOL_REVISION: 139,
  PROPERTY_LIST: 371,
});

const OBJ = Object.freeze({
  ANALOG_INPUT: 0, ANALOG_OUTPUT: 1, ANALOG_VALUE: 2, BINARY_INPUT: 3, BINARY_OUTPUT: 4, BINARY_VALUE: 5, DEVICE: 8,
  MULTI_STATE_INPUT: 13, MULTI_STATE_OUTPUT: 14, MULTI_STATE_VALUE: 19,
});

const SHORT = { ai: 0, ao: 1, av: 2, bi: 3, bo: 4, bv: 5, dev: 8, msi: 13, mso: 14, msv: 19 };

const TYPE_BY_NAME = new Map(Object.entries(OBJECT_TYPES).map(([n, name]) => [name, Number(n)]));
const PROP_BY_NAME = new Map(Object.entries(PROPERTIES).map(([n, name]) => [name, Number(n)]));
// Common spellings that differ from the generated kebab names.
for (const [alias, n] of [['pv', 85], ['present_value', 85], ['statusflags', 111], ['status-flag', 111], ['name', 77]]) PROP_BY_NAME.set(alias, n);

/** Object types whose present-value carries status-flags / reliability / out-of-service (clause 12). */
const POINT_TYPES = new Set([0, 1, 2, 3, 4, 5, 13, 14, 19]);
/** Object types with a standard present-value (offered as tags by browse). */
const PV_TYPES = new Set([...POINT_TYPES, 6, 7, 12, 17, 21, 22, 23, 24, 28, 30, 31, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 53, 54, 55, 63, 64]);
/** Present-value types that also carry status-flags (read with it for quality). */
const STATUS_TYPES = new Set([...POINT_TYPES, 12, 23, 24, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
const BINARY_TYPES = new Set([3, 4, 5]);
const ANALOG_TYPES = new Set([0, 1, 2]);
const MULTISTATE_TYPES = new Set([13, 14, 19]);

function objectTypeName(type) {
  return OBJECT_TYPES[type] || String(type);
}

function propertyName(prop) {
  return PROPERTIES[prop] || String(prop);
}

function parseObjectType(text) {
  const t = String(text).trim().toLowerCase().replace(/_/g, '-');
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n > 1023) throw new Error(`object type ${n} is out of range (0-1023)`);
    return n;
  }
  if (Object.hasOwn(SHORT, t)) return SHORT[t];
  if (TYPE_BY_NAME.has(t)) return TYPE_BY_NAME.get(t);
  throw new Error(`unknown object type "${text}" (use a name such as analog-input, or a number)`);
}

function parseProperty(text) {
  const t = String(text).trim().toLowerCase().replace(/_/g, '-');
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n > 4194303) throw new Error(`property ${n} is out of range`);
    return n;
  }
  if (PROP_BY_NAME.has(t)) return PROP_BY_NAME.get(t);
  throw new Error(`unknown property "${text}" (use a name such as present-value, or a number)`);
}

const ADDRESS_RE = /^([A-Za-z0-9_-]+):(\d+)(?:\/([A-Za-z0-9_-]+))?(?:\[(\d+)\])?$/;

/**
 * @param {string} address
 * @returns {{objectType:number, instance:number, property:number, index:(number|undefined), defaultProperty:boolean}}
 * @throws {Error} with a message for the user
 */
function parseAddress(address) {
  if (typeof address !== 'string' || !address.trim()) throw new Error('address is required, e.g. analog-input:3');
  const m = ADDRESS_RE.exec(address.trim());
  if (!m) throw new Error(`"${address}" is not a BACnet address; use object-type:instance[/property][[index]], e.g. analog-input:3 or device:1234/object-list[0]`);
  const objectType = parseObjectType(m[1]);
  const instance = Number(m[2]);
  if (instance > MAX_INSTANCE) throw new Error(`instance ${instance} is out of range (0-${MAX_INSTANCE})`);
  const property = m[3] === undefined ? PROP.PRESENT_VALUE : parseProperty(m[3]);
  let index;
  if (m[4] !== undefined) {
    index = Number(m[4]);
    if (index > 0xfffffffe) throw new Error('array index is out of range');
  }
  return { objectType, instance, property, index, defaultProperty: m[3] === undefined };
}

/** Canonical text form: analog-input:3, device:1234/object-list[0]. */
function formatAddress({ objectType, instance, property = PROP.PRESENT_VALUE, index }) {
  const base = `${objectTypeName(objectType)}:${instance}`;
  const prop = property === PROP.PRESENT_VALUE && index === undefined ? '' : `/${propertyName(property)}`;
  return `${base}${prop}${index !== undefined ? `[${index}]` : ''}`;
}

module.exports = {
  PROP,
  OBJ,
  POINT_TYPES,
  PV_TYPES,
  STATUS_TYPES,
  BINARY_TYPES,
  ANALOG_TYPES,
  MULTISTATE_TYPES,
  parseAddress,
  formatAddress,
  parseObjectType,
  parseProperty,
  objectTypeName,
  propertyName,
};
