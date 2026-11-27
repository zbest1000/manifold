'use strict';

/**
 * Modbus TCP driver (read-only). Combines the pure core (address, decode,
 * planner, frame) with ModbusClient and implements the driver contract of
 * docs/design/driver-contract.md as consumed by the polling runtime.
 *
 * `execute()` never throws for device or transport problems; it returns
 *   { ok:true, results:[{key, v, type, q, qReason?}] }
 *   { ok:false, kind:'exception', code, name, classification, message }
 *   { ok:false, kind:'timeout'|'mismatch'|'framing'|'transport', fatal:true, message }
 * `fatal` means the connection is gone and the runtime must reconnect. The one
 * non-fatal transport result is a full client queue (`fatal:false`).
 * Unit ids behind one host:port share this driver's single socket.
 */

const { connectAddress } = require('../runtime/pinnedAddress');
const { ModbusClient } = require('./client');
const { parseAddress, TABLES } = require('./address');
const { decode, registerCount, probeDecodings } = require('./decode');
const { planReads, bisect: bisectRequest } = require('./planner');

const protocol = 'modbus-tcp';

const TYPES = ['bool', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64', 'string'];
const ORDER_VALUES = ['big', 'little'];
const DEFAULT_OPTIONS = { byteOrder: 'big', wordOrder: 'big', addressBase: 0, maxRegisters: 125, maxBits: 2000, maxGap: 0, unmapped: [] };
const DEFAULT_LIMITS = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };

/** @returns {object} static driver description for the UI and registry */
function describe() {
  return {
    protocol,
    label: 'Modbus TCP',
    browseNoun: 'device', // no tag list to browse; the noun keeps shared copy right
    readOnly: true,
    defaultPort: 502,
    defaultUnitId: 255,
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    tagTypes: [...TYPES],
    tables: Object.keys(TABLES),
    addressForms: ['holding:100', '40001', '400001'],
    capabilities: { browse: false, subscribe: false, maxInFlight: 1 },
    deviceFields: [
      { name: 'unitId', label: 'Unit ID', type: 'number', default: 255, help: '255 (or 0) for a direct TCP device; 1-247 selects a slave behind a TCP-to-RTU gateway. Some devices require a specific value.' },
    ],
    optionFields: [
      { name: 'byteOrder', label: 'Byte order', type: 'select', default: 'big', options: ['big', 'little'], help: 'Order of the two bytes inside each 16-bit register.' },
      { name: 'wordOrder', label: 'Word order', type: 'select', default: 'big', options: ['big', 'little'], help: 'Order of registers in 32/64-bit values. "little" is the common word-swapped (CDAB) layout. Use Probe to check.' },
      { name: 'addressBase', label: 'Address base', type: 'select', default: 0, options: [0, 1], help: '0 when the manual lists wire offsets; 1 when it counts registers from 1. Applies to table:offset addresses.' },
      { name: 'maxRegisters', label: 'Max registers per read', type: 'number', default: 125, help: 'Protocol maximum is 125; many devices accept fewer.' },
      { name: 'maxGap', label: 'Max gap to bridge', type: 'number', default: 0, help: 'Unused registers a block read may span. Keep 0 unless the device answers reads over unmapped registers.' },
    ],
    addressHelp: 'holding:100, input:0, coil:5, discrete:12, or Modicon notation 40001 / 400001',
    prerequisites: 'Modbus TCP has no authentication. Manifold only sends read requests (function codes 1-4); for a hard guarantee, restrict the network path as well.',
  };
}

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validate one tag definition against the device options.
 * @param {object} tagDef
 * @param {object} [deviceOptions]
 * @returns {{ok:true, normalized:object}|{ok:false, error:string}} normalized holds
 *   table, offset (0-based wire), count, fc, type, key and the decode options
 */
function validateTag(tagDef, deviceOptions = {}) {
  const fail = (error) => ({ ok: false, error });
  const opts = { ...DEFAULT_OPTIONS, ...deviceOptions };
  if (!tagDef || typeof tagDef !== 'object') return fail('tag must be an object');
  const { key, type } = tagDef;
  if (typeof key !== 'string' || !key) return fail('key must be a non-empty string');
  if (!TYPES.includes(type)) return fail(`unknown type "${type}" (supported: ${TYPES.join(', ')})`);
  let addr;
  try {
    addr = parseAddress(tagDef.address, { base: opts.addressBase });
  } catch (err) {
    return fail(err.message);
  }
  const bits = addr.table === 'coil' || addr.table === 'discrete';
  if (bits && type !== 'bool') return fail(`${addr.table} addresses hold single bits: use type bool, not ${type}`);
  if (tagDef.bit !== undefined) {
    if (type !== 'bool') return fail('bit is only valid for bool tags');
    if (bits) return fail(`bit selects a bit of a register; ${addr.table} is already a single bit`);
    if (!isIntIn(tagDef.bit, 0, 15)) return fail('bit must be an integer 0..15');
  }
  if (type === 'bool' && !bits && tagDef.bit === undefined) {
    return fail(`bool on a ${addr.table} register needs "bit" (0..15)`);
  }
  let count;
  try {
    count = registerCount(tagDef);
  } catch (err) {
    return fail(err.message);
  }
  const max = bits ? opts.maxBits : opts.maxRegisters;
  if (count > max) return fail(`tag spans ${count} units, more than the ${max} one request can read`);
  if (addr.offset + count > 0x10000) return fail(`range ${addr.offset}+${count} runs past wire address 65535`);
  for (const f of ['byteOrder', 'wordOrder']) {
    if (tagDef[f] !== undefined && !ORDER_VALUES.includes(tagDef[f])) return fail(`${f} must be "big" or "little"`);
  }
  for (const f of ['scale', 'offset']) {
    if (tagDef[f] !== undefined && !Number.isFinite(tagDef[f])) return fail(`${f} must be a finite number`);
  }
  if (tagDef.sentinels !== undefined && !(Array.isArray(tagDef.sentinels) && tagDef.sentinels.every(Number.isFinite))) {
    return fail('sentinels must be an array of numbers');
  }
  if (tagDef.unitId !== undefined && !isIntIn(tagDef.unitId, 0, 255)) return fail('unitId must be an integer 0..255');
  return {
    ok: true,
    normalized: {
      key, type, table: addr.table, offset: addr.offset, count, fc: addr.fc,
      bit: tagDef.bit, length: tagDef.length,
      byteOrder: tagDef.byteOrder ?? opts.byteOrder, wordOrder: tagDef.wordOrder ?? opts.wordOrder,
      scale: tagDef.scale, valueOffset: tagDef.offset, sentinels: tagDef.sentinels,
      unitId: tagDef.unitId, pollGroup: tagDef.pollGroup,
    },
  };
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const errors = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...DEFAULT_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 502;
  const unitId = device.unitId ?? 255;
  if (typeof device.host !== 'string' || !device.host.trim()) errors.push('host must be a non-empty string');
  if (!isIntIn(port, 1, 65535)) errors.push('port must be an integer 1..65535');
  if (!isIntIn(unitId, 0, 255)) errors.push('unitId must be an integer 0..255');
  if (![0, 1].includes(options.addressBase)) errors.push('options.addressBase must be 0 or 1');
  if (!isIntIn(options.maxRegisters, 1, 125)) errors.push('options.maxRegisters must be an integer 1..125');
  if (!isIntIn(options.maxBits, 1, 2000)) errors.push('options.maxBits must be an integer 1..2000');
  if (!isIntIn(options.maxGap, 0, 0xffff)) errors.push('options.maxGap must be a non-negative integer');
  for (const f of ['byteOrder', 'wordOrder']) {
    if (!ORDER_VALUES.includes(options[f])) errors.push(`options.${f} must be "big" or "little"`);
  }
  if (!Array.isArray(options.unmapped) || !options.unmapped.every((u) => u && TABLES[u.table] && isIntIn(u.from, 0, 0xffff) && isIntIn(u.to, u.from, 0xffff))) {
    errors.push('options.unmapped must be [{table, from, to}] with inclusive 0-based wire offsets');
  }
  for (const f of ['requestDeadlineMs', 'connectTimeoutMs']) {
    if (!(limits[f] > 0)) errors.push(`limits.${f} must be a positive number`);
  }
  if (!(limits.interRequestDelayMs >= 0)) errors.push('limits.interRequestDelayMs must be >= 0');
  const tags = new Map();
  const details = errors.map((error) => ({ key: null, error }));
  if (!Array.isArray(device.tags ?? [])) details.push({ key: null, error: 'tags must be an array' });
  else {
    for (const t of device.tags || []) {
      const r = validateTag(t, options);
      if (!r.ok) details.push({ key: t && t.key !== undefined ? t.key : null, error: r.error });
      else if (tags.has(r.normalized.key)) details.push({ key: r.normalized.key, error: 'duplicate tag key' });
      else tags.set(r.normalized.key, r.normalized);
    }
  }
  if (details.length) {
    const err = new Error(`invalid modbus device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  const host = device.host.trim();
  return { host, connectHost: connectAddress({ ...device, host }), port, unitId, options, limits, tags };
}

function mapFatal(res) {
  return { ok: false, kind: res.kind, fatal: res.kind !== 'queue-full', message: res.message };
}

/**
 * @param {object} device device config (see module doc / design 4.4)
 * @param {{socketFactory?:Function}} [deps]
 * @returns {object} driver (contract in design 4.1; EXACT shape used by the runtime)
 * @throws {Error} with `details:[{key,error}]` when the config or any tag is invalid
 */
function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  let client = null;
  let lastDone = 0;

  const unitOf = (tag) => tag.unitId ?? cfg.unitId;

  function toRequest(unitId, r) {
    const items = r.items.map((i) => ({ key: i.id, start: i.start, count: i.count }));
    return {
      id: `${unitId}:${r.fc}:${r.address}:${r.quantity}:${items.map((i) => i.key).join('|')}`,
      unitId, fc: r.fc, table: r.table, address: r.address, quantity: r.quantity, items,
    };
  }

  function decodeItem(req, data, item) {
    const tag = cfg.tags.get(item.key);
    const spec = { ...tag, offset: tag.valueOffset };
    let words;
    if (req.fc <= 2) words = Buffer.from([(data[item.start >> 3] >> (item.start & 7)) & 1]);
    else words = data.subarray(item.start * 2, (item.start + item.count) * 2);
    try {
      const d = decode(spec, words);
      if (d.unavailable) return { key: item.key, v: null, type: tag.type, q: 0, qReason: 'unavailable' };
      return { key: item.key, v: typeof d.v === 'bigint' ? d.v.toString() : d.v, type: tag.type, q: 192 };
    } catch (err) {
      return { key: item.key, v: null, type: tag.type, q: 0, qReason: 'decode' };
    }
  }

  async function pace() {
    const wait = limits.interRequestDelayMs - (Date.now() - lastDone);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async function read(unitId, fc, address, quantity, deadlineMs) {
    if (!client || !client.isConnected()) return { ok: false, kind: 'transport', message: 'not connected' };
    await pace();
    const res = await client.request({ unitId, fc, address, quantity }, deadlineMs);
    lastDone = Date.now();
    return res;
  }

  return {
    protocol,
    capabilities: { browse: false, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (client) await client.close().catch(() => {});
      client = new ModbusClient({
        host: cfg.connectHost, displayHost: cfg.host, port: cfg.port, connectTimeoutMs: limits.connectTimeoutMs, socketFactory: deps.socketFactory,
      });
      await client.connect();
      return {
        limits: {
          maxRegisters: options.maxRegisters, maxBits: options.maxBits, maxGap: options.maxGap,
          requestDeadlineMs: limits.requestDeadlineMs, interRequestDelayMs: limits.interRequestDelayMs,
        },
      };
    },

    isConnected() {
      return !!client && client.isConnected();
    },

    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      const byUnit = new Map();
      for (const k of keys) {
        const tag = cfg.tags.get(k);
        if (!tag) throw new Error(`unknown tag key "${k}"`);
        const u = unitOf(tag);
        if (!byUnit.has(u)) byUnit.set(u, []);
        byUnit.get(u).push({ id: tag.key, table: tag.table, offset: tag.offset, count: tag.count });
      }
      const out = [];
      for (const [unitId, tags] of [...byUnit].sort((a, b) => a[0] - b[0])) {
        for (const r of planReads(tags, options)) out.push(toRequest(unitId, r));
      }
      return out;
    },

    async execute(request, deadlineMs) {
      const deadline = deadlineMs ?? limits.requestDeadlineMs;
      const res = await read(request.unitId, request.fc, request.address, request.quantity, deadline);
      if (res.ok) return { ok: true, results: request.items.map((i) => decodeItem(request, res.data, i)) };
      if (res.kind === 'exception') {
        return {
          ok: false, kind: 'exception', code: res.code, name: res.name, classification: res.classification,
          message: `Modbus exception 0x${res.code.toString(16).padStart(2, '0')} (${res.name}) from unit ${request.unitId} ` +
            `fc ${request.fc} @${request.address}+${request.quantity}`,
        };
      }
      return mapFatal(res);
    },

    bisect(request) {
      const halves = bisectRequest({
        fc: request.fc, table: request.table, address: request.address, quantity: request.quantity,
        items: request.items.map((i) => ({ id: i.key, start: i.start, count: i.count })),
      });
      return halves && halves.map((h) => toRequest(request.unitId, h));
    },

    async probe({ address, count = 2, unitId } = {}) {
      const addr = parseAddress(address, { base: options.addressBase });
      const max = addr.fc <= 2 ? options.maxBits : options.maxRegisters;
      if (!isIntIn(count, 1, max)) throw new RangeError(`count must be an integer 1..${max}`);
      const res = await read(unitId ?? cfg.unitId, addr.fc, addr.offset, count, limits.requestDeadlineMs);
      if (!res.ok) {
        const err = new Error(`probe failed: ${res.kind}${res.name ? ` (${res.name})` : ''}${res.message ? `: ${res.message}` : ''}`);
        err.result = res;
        throw err;
      }
      const base = { address: { table: addr.table, offset: addr.offset }, rawHex: res.data.toString('hex') };
      if (addr.fc <= 2) {
        const bits = Array.from({ length: count }, (_, i) => (res.data[i >> 3] >> (i & 7)) & 1);
        return { ...base, words: bits, decodings: {} };
      }
      const words = Array.from({ length: count }, (_, i) => res.data.readUInt16BE(i * 2));
      return { ...base, words, decodings: probeDecodings(res.data) };
    },

    async close() {
      const c = client;
      client = null;
      if (c) await c.close();
    },
  };
}

module.exports = { protocol, describe, validateTag, createDriver };
