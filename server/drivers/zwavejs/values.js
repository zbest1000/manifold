'use strict';

/**
 * Z-Wave value ids, command class names and value conversion for the zwave-js driver.
 *
 * Tag address = value id: node/commandClass/endpoint/property[/propertyKey]
 *   5/49/0/Air temperature           Multilevel Sensor, endpoint 0
 *   5/0x25/1/currentValue            Binary Switch, endpoint 1
 *   12/112/0/3/255                   Configuration parameter 3, partial (bitmask) key 255
 *   7/113/0/Home Security/Motion sensor status
 * Command classes may be given by id (decimal or 0x hex) or by name ("Multilevel Sensor").
 * A property or key made of digits only is a number; any other text is a string. A "/" or "%"
 * inside a property name is written percent-encoded (%2F, %25).
 */

const CC = {
  0x20: 'Basic', 0x25: 'Binary Switch', 0x26: 'Multilevel Switch', 0x27: 'All Switch', 0x2b: 'Scene Activation',
  0x30: 'Binary Sensor', 0x31: 'Multilevel Sensor', 0x32: 'Meter', 0x33: 'Color Switch', 0x35: 'Pulse Meter',
  0x36: 'Basic Tariff Information', 0x37: 'HRV Status', 0x38: 'Thermostat Heating', 0x39: 'HRV Control',
  0x40: 'Thermostat Mode', 0x42: 'Thermostat Operating State', 0x43: 'Thermostat Setpoint', 0x44: 'Thermostat Fan Mode',
  0x45: 'Thermostat Fan State', 0x47: 'Thermostat Setback', 0x4c: 'Door Lock Logging', 0x4e: 'Schedule Entry Lock',
  0x50: 'Basic Window Covering', 0x5a: 'Device Reset Locally', 0x5b: 'Central Scene', 0x5e: 'Z-Wave Plus Info',
  0x62: 'Door Lock', 0x63: 'User Code', 0x66: 'Barrier Operator', 0x69: 'Mailbox', 0x6a: 'Window Covering',
  0x6c: 'Supervision', 0x70: 'Configuration', 0x71: 'Notification', 0x72: 'Manufacturer Specific', 0x73: 'Powerlevel',
  0x75: 'Protection', 0x76: 'Lock', 0x77: 'Node Naming and Location', 0x79: 'Sound Switch', 0x7a: 'Firmware Update Meta Data',
  0x80: 'Battery', 0x81: 'Clock', 0x84: 'Wake Up', 0x85: 'Association', 0x86: 'Version', 0x87: 'Indicator',
  0x8b: 'Time Parameters', 0x8e: 'Multi Channel Association', 0x8f: 'Multi Command', 0x90: 'Energy Production',
  0x98: 'Security', 0x9b: 'Association Command Configuration', 0x9c: 'Alarm Sensor', 0x9f: 'Security 2',
  0xa0: 'IR Repeater', 0xa1: 'Authentication', 0xa2: 'Humidity Control Setpoint', 0xa3: 'Humidity Control Mode',
  0xa4: 'Humidity Control Operating State', 0x60: 'Multi Channel', 0x59: 'Association Group Information',
  0x55: 'Transport Service', 0x22: 'Application Status', 0x9a: 'IP Configuration', 0x7b: 'Grouping Name', 0x91: 'Manufacturer Proprietary',
};
const CC_BY_NAME = new Map(Object.entries(CC).map(([id, name]) => [name.toLowerCase(), Number(id)]));

const ccName = (id) => CC[id] || `Command class ${id}`;
const hex2 = (n) => `0x${Number(n).toString(16).padStart(2, '0')}`;

function encodeSegment(v) {
  return typeof v === 'number' ? String(v) : String(v).replace(/%/g, '%25').replace(/\//g, '%2F');
}
function decodeSegment(s) {
  if (/^\d+$/.test(s)) return Number(s);
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The address of a value id (as reported by the server). */
function formatValueId(nodeId, v) {
  const parts = [nodeId, v.commandClass, v.endpoint || 0, encodeSegment(v.property)];
  if (v.propertyKey !== undefined && v.propertyKey !== null) parts.push(encodeSegment(v.propertyKey));
  return parts.join('/');
}

/** Internal key of a value id on a node (address without the node). */
function valueKey(v) {
  return formatValueId(0, v).replace(/^0\//, '');
}

const ADDRESS_HELP =
  'node/commandClass/endpoint/property[/propertyKey], e.g. 5/49/0/Air temperature or 5/Binary Switch/1/currentValue. ' +
  'Command classes by id (49, 0x31) or name; "/" inside a property is written %2F.';

/** @returns {{nodeId, commandClass, endpoint, property, propertyKey?, address, valueId, vkey}} */
function parseValueId(address) {
  if (typeof address !== 'string' || !address.trim()) throw new Error(`address is required (${ADDRESS_HELP})`);
  const parts = address.trim().split('/');
  if (parts.length < 4 || parts.length > 5) throw new Error(`"${address}" is not node/commandClass/endpoint/property[/propertyKey]`);
  const nodeId = /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN;
  if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 4000) throw new Error(`node id "${parts[0]}" must be 1-4000`);
  let commandClass;
  if (/^0x[0-9a-f]+$/i.test(parts[1])) commandClass = parseInt(parts[1].slice(2), 16);
  else if (/^\d+$/.test(parts[1])) commandClass = Number(parts[1]);
  else commandClass = CC_BY_NAME.get(parts[1].trim().toLowerCase());
  if (!Number.isInteger(commandClass) || commandClass < 0 || commandClass > 0xffff) throw new Error(`unknown command class "${parts[1]}"; use its id`);
  if (!/^\d+$/.test(parts[2]) || Number(parts[2]) > 127) throw new Error(`endpoint "${parts[2]}" must be 0-127`);
  const endpoint = Number(parts[2]);
  if (!parts[3]) throw new Error('property is empty');
  const property = decodeSegment(parts[3]);
  const valueId = { commandClass, endpoint, property };
  if (parts.length === 5) {
    if (!parts[4]) throw new Error('propertyKey is empty');
    valueId.propertyKey = decodeSegment(parts[4]);
  }
  const addr = formatValueId(nodeId, valueId);
  return { nodeId, ...valueId, valueId, address: addr, vkey: valueKey(valueId) };
}

const round = (v) => Math.round(v * 1e9) / 1e9;

/**
 * Convert a value with its metadata to a sample value.
 * @returns {{ok:true, v, type} | {ok:false, reason}}
 */
function convertValue(meta, value) {
  if (value === undefined || value === null) return { ok: false, reason: 'no value' };
  const t = (meta && meta.type) || typeof value;
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { ok: true, v: Buffer.from(value.data).toString('hex'), type: 'string' };
  }
  if (t === 'number' && typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, reason: 'not a number' };
    return { ok: true, v: value, type: meta && meta.states ? 'int64' : 'float64' };
  }
  if (t === 'boolean' && typeof value === 'boolean') return { ok: true, v: value, type: 'bool' };
  if (t === 'string' && typeof value === 'string') return { ok: true, v: value, type: 'string' };
  if (t === 'duration' && value && typeof value === 'object') {
    if (value.unit === 'seconds') return { ok: true, v: value.value, type: 'float64' };
    if (value.unit === 'minutes') return { ok: true, v: round(value.value * 60), type: 'float64' };
    return { ok: false, reason: `duration "${value.unit}"` };
  }
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, v: value, type: 'float64' } : { ok: false, reason: 'not a number' };
  if (typeof value === 'boolean') return { ok: true, v: value, type: 'bool' };
  if (typeof value === 'string') return { ok: true, v: value, type: 'string' };
  return { ok: true, v: JSON.stringify(value), type: 'json' };
}

/** Tag type ('number'|'bool'|'string'|'json') a metadata type maps to. */
function tagTypeOf(meta) {
  const t = meta && meta.type;
  if (t === 'number' || t === 'duration') return 'number';
  if (t === 'boolean') return 'bool';
  if (t === 'string') return 'string';
  return 'json';
}

module.exports = { CC, ccName, hex2, parseValueId, formatValueId, valueKey, convertValue, tagTypeOf, ADDRESS_HELP };
