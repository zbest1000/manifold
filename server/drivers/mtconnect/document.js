'use strict';

/**
 * MTConnect documents on top of ./xml.js: the header, the probe (devices, components, data
 * items), streams (observations) and error documents. Written against the public MTConnect
 * Standard, Part 1 (devices), Part 2 (streams) and Part 4 (protocol) for versions 1.3 to 2.x.
 */

const { parseXml, walk, child, XmlError } = require('./xml');

const UINT_RE = /^\d{1,20}$/;

/** A sequence number as BigInt (agents use 64-bit counters), or null when it is not one. */
function seq(v) {
  return typeof v === 'string' && UINT_RE.test(v.trim()) ? BigInt(v.trim()) : null;
}

function parseHeader(root) {
  const h = child(root, 'Header');
  if (!h) return null;
  const a = h.attrs;
  return {
    instanceId: a.instanceId ?? null,
    version: a.version || null,
    sender: a.sender || null,
    creationTime: a.creationTime || null,
    bufferSize: a.bufferSize !== undefined ? Number(a.bufferSize) : null,
    firstSequence: seq(a.firstSequence),
    lastSequence: seq(a.lastSequence),
    nextSequence: seq(a.nextSequence)
  };
}

/**
 * Parse an agent response body.
 * @param {string|Buffer} body
 * @returns {{kind:'streams'|'devices'|'error'|'assets'|'other', header:object|null, root:object, errors?:Array<{code:string,message:string}>}}
 * @throws {XmlError}
 */
function parseDocument(body) {
  const root = parseXml(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  const header = parseHeader(root);
  const name = root.name;
  if (name === 'MTConnectError') {
    const errors = [];
    walk(root, (n) => {
      if (n.name === 'Error') errors.push({ code: n.attrs.errorCode || 'UNKNOWN', message: n.text.trim() });
    });
    return { kind: 'error', header, root, errors };
  }
  if (name === 'MTConnectStreams') return { kind: 'streams', header, root };
  if (name === 'MTConnectDevices') return { kind: 'devices', header, root };
  if (name === 'MTConnectAssets') return { kind: 'assets', header, root };
  return { kind: 'other', header, root };
}

// ---- probe ------------------------------------------------------------------

const UNIT_SYMBOLS = {
  CELSIUS: '°C', FAHRENHEIT: '°F', KELVIN: 'K', MILLIMETER: 'mm', CENTIMETER: 'cm', METER: 'm', INCH: 'in', 'MILLIMETER/SECOND': 'mm/s', 'MILLIMETER/MINUTE': 'mm/min',
  'MILLIMETER/SECOND^2': 'mm/s²', PERCENT: '%', 'REVOLUTION/MINUTE': 'rev/min', 'REVOLUTION/SECOND': 'rev/s', AMPERE: 'A', VOLT: 'V', WATT: 'W', KILOWATT: 'kW', 'KILOWATT_HOUR': 'kWh',
  WATT_SECOND: 'Ws', HERTZ: 'Hz', SECOND: 's', MINUTE: 'min', HOUR: 'h', DEGREE: '°', 'DEGREE/SECOND': '°/s', PASCAL: 'Pa', BAR: 'bar', NEWTON: 'N', 'NEWTON_METER': 'N·m',
  GRAM: 'g', KILOGRAM: 'kg', LITER: 'L', COUNT: 'count', DECIBEL: 'dB', 'PH': 'pH', OHM: 'Ω', 'MILLIMETER_3D': 'mm', 'MILLIMETER/REVOLUTION': 'mm/rev', 'COUNT/SECOND': 'count/s'
};

function unitSymbol(units) {
  if (!units) return '';
  return Object.prototype.hasOwnProperty.call(UNIT_SYMBOLS, units) ? UNIT_SYMBOLS[units] : String(units).toLowerCase();
}

const WRAPPERS = new Set(['Components', 'DataItems', 'Compositions', 'References', 'Configuration']);

/**
 * The model from a /probe answer: devices with a component tree, and every data item flat.
 * @returns {{devices:Array<{name:string, uuid:string|null, id:string|null, tree:object, items:Map<string,object>}>, items:Map<string,object>}}
 */
function parseProbe(root) {
  const devices = [];
  const all = new Map();
  const devicesNode = child(root, 'Devices');
  const deviceNodes = devicesNode ? devicesNode.children.filter((c) => c.name === 'Device') : root.children.filter((c) => c.name === 'Device');
  for (const d of deviceNodes) {
    const device = { name: d.attrs.name || d.attrs.id || '', uuid: d.attrs.uuid || null, id: d.attrs.id || null, items: new Map(), tree: null };
    const visit = (node, path) => {
      const here = { id: `c:${device.name}:${node.attrs.id || path.join('/')}`, name: node.attrs.name || node.attrs.id || node.name, kind: node.name, folders: [], items: [] };
      for (const c of node.children) {
        if (c.name === 'DataItems') {
          for (const di of c.children) {
            if (di.name !== 'DataItem' || !di.attrs.id) continue;
            const item = {
              id: di.attrs.id, name: di.attrs.name || '', type: di.attrs.type || '', subType: di.attrs.subType || '', category: (di.attrs.category || '').toUpperCase(),
              units: di.attrs.units || '', nativeUnits: di.attrs.nativeUnits || '', unit: unitSymbol(di.attrs.units), representation: (di.attrs.representation || 'VALUE').toUpperCase(),
              statistic: di.attrs.statistic || '', device: device.name, deviceUuid: device.uuid, path: path.join(' / ')
            };
            device.items.set(item.id, item);
            all.set(item.id, item);
            here.items.push(item);
          }
        } else if (c.name === 'Components') {
          for (const comp of c.children) here.folders.push(visit(comp, [...path, comp.attrs.name || comp.attrs.id || comp.name]));
        } else if (!WRAPPERS.has(c.name) && c.name !== 'Description') {
          // tolerate agents that put components directly under a component
          if (c.attrs.id || c.children.length) here.folders.push(visit(c, [...path, c.attrs.name || c.attrs.id || c.name]));
        }
      }
      return here;
    };
    device.tree = visit(d, [device.name || d.attrs.id || 'Device']);
    devices.push(device);
  }
  return { devices, items: all };
}

// ---- streams ----------------------------------------------------------------

const CONTAINERS = { Samples: 'sample', Events: 'event', Condition: 'condition' };
const CONDITION_LEVELS = new Set(['normal', 'warning', 'fault', 'unavailable']);

function parseTime(v) {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Observations from a /current or /sample answer, in document order.
 * @returns {Array<{id:string, kind:'sample'|'event'|'condition', element:string, device:string, deviceUuid:string|null, component:string,
 *   timestamp:number|undefined, sequence:bigint|null, value:string, level?:string, nativeCode?:string, nativeSeverity?:string, qualifier?:string,
 *   conditionType?:string, representation?:string, entries:boolean}>}
 */
function parseObservations(root) {
  const out = [];
  walk(root, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (!parent || !Object.prototype.hasOwnProperty.call(CONTAINERS, parent.name)) return true;
    if (!ancestors.some((a) => a.name === 'ComponentStream' || a.name === 'DeviceStream' || a.name === 'Streams')) return true;
    const id = node.attrs.dataItemId;
    if (!id) return false;
    const stream = [...ancestors].reverse().find((a) => a.name === 'DeviceStream');
    const comp = [...ancestors].reverse().find((a) => a.name === 'ComponentStream');
    const kind = CONTAINERS[parent.name];
    const obs = {
      id,
      kind,
      element: node.name,
      device: stream ? stream.attrs.name || '' : '',
      deviceUuid: stream ? stream.attrs.uuid || null : null,
      component: comp ? comp.attrs.name || comp.attrs.component || '' : '',
      timestamp: parseTime(node.attrs.timestamp),
      sequence: seq(node.attrs.sequence),
      value: node.text.trim(),
      entries: node.children.length > 0,
      representation: node.attrs.sampleCount !== undefined ? 'TIME_SERIES' : undefined
    };
    if (kind === 'condition') {
      obs.level = node.name.toLowerCase();
      obs.nativeCode = node.attrs.nativeCode || '';
      obs.nativeSeverity = node.attrs.nativeSeverity || '';
      obs.qualifier = node.attrs.qualifier || '';
      obs.conditionType = node.attrs.type || '';
      if (!CONDITION_LEVELS.has(obs.level)) obs.level = 'unavailable';
    }
    if (node.children.some((c) => c.name === 'Entry' || c.name === 'Cell')) obs.representation = node.children.some((c) => c.name === 'Cell') ? 'TABLE' : 'DATA_SET';
    out.push(obs);
    return false;
  });
  return out;
}

module.exports = { parseDocument, parseProbe, parseObservations, parseHeader, unitSymbol, seq, XmlError };
