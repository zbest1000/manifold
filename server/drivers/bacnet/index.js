'use strict';

/**
 * BACnet/IP driver (read-only): describe / validateTag / createDriver, the contract of
 * docs/design/southbound-drivers.md section 4.1 as consumed by drivers/runtime/deviceRuntime.js.
 *
 * Services sent: Who-Is (unicast to the configured device only), ReadProperty and
 * ReadPropertyMultiple. Nothing else can be encoded (see ./frame.js). Pitfalls handled and what
 * is not supported: ./NOTES.md.
 *
 * `execute()` never throws for device or transport problems; it returns
 *   { ok:true, results:[{key, v, type, q, qReason?}] }
 *   { ok:false, kind:'exception', code, classification:'permanent'|'transient', message }
 *   { ok:false, kind:'timeout'|'transport'|'unreachable'|'framing', fatal:true, message }
 */

const { connectAddress } = require('../runtime/pinnedAddress');
const net = require('node:net');
const frame = require('./frame');
const enc = require('./encoding');
const errors = require('./errors');
const { BacnetClient, macText } = require('./client');
const { parseAddress, formatAddress, PROP, OBJ, PV_TYPES, STATUS_TYPES, ANALOG_TYPES, objectTypeName, propertyName } = require('./address');
const { TAG_TYPES, naturalValue, castValue, qualityOf, plain, Q_BAD } = require('./decode');
const { planRpm, planRp, rpmSpecs, refsOf, bisect: bisectRequest, STATUS_PROPS } = require('./planner');
const { unitInfo } = require('./units');
const { SEGMENTATION } = require('./enums');

const protocol = 'bacnet-ip';

const DEFAULT_OPTIONS = {
  readMultiple: 'auto',
  readStatus: true,
  apduTimeoutMs: 1500,
  apduRetries: 2,
  maxApdu: 'auto',
  maxProperties: 32,
  maxOutstanding: 1,
};
const DEFAULT_LIMITS = { requestDeadlineMs: 6000, connectTimeoutMs: 8000, interRequestDelayMs: 0 };
const MAX_APDU_CHOICES = ['auto', '1476', '1024', '480', '206', '128', '50'];
const BROWSE_PAGE = 100;
const BROWSE_MAX_OBJECTS = 10000;
const UNIT_TYPES = new Set([...ANALOG_TYPES, 23, 45, 46, 48]); // + accumulator, integer/large-analog/positive-integer value

function describe() {
  return {
    protocol,
    label: 'BACnet/IP',
    browseNoun: 'device', // the device's object list
    experimental: true,
    readOnly: true,
    defaultPort: 47808,
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    tagTypes: [...TAG_TYPES],
    tagTypeOptional: true,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },
    addressForms: ['analog-input:3', 'analog-value:7/units', 'device:1234/object-list[0]'],
    deviceFields: [
      {
        name: 'deviceInstance',
        label: 'Device instance',
        type: 'number',
        optional: true,
        min: 0,
        max: 4194302,
        help: 'The device object instance (0-4194302). Leave empty to learn it from the device. Required when several BACnet devices share this IP address.',
      },
      {
        name: 'network',
        label: 'Network number',
        type: 'number',
        optional: true,
        advanced: true,
        min: 1,
        max: 65534,
        help: 'Only for a device behind a BACnet router (for example MS/TP): its network number. The host is then the router.',
      },
      {
        name: 'mac',
        label: 'MAC address',
        type: 'string',
        optional: true,
        advanced: true,
        help: 'With a network number: the device address on that network. MS/TP: 0-127. Remote BACnet/IP: 10.0.0.5:47808. Other: hex bytes such as 0a:1b.',
      },
    ],
    optionFields: [
      { name: 'readMultiple', label: 'ReadPropertyMultiple', type: 'select', default: 'auto', options: ['auto', 'on', 'off'], help: 'auto tests the device at connect and falls back to ReadProperty when it rejects ReadPropertyMultiple.' },
      { name: 'readStatus', label: 'Read status with values', type: 'boolean', default: true, help: 'Read status-flags, reliability and out-of-service with each present-value and set the tag quality from them.' },
      { name: 'apduTimeoutMs', label: 'APDU timeout (ms)', type: 'number', default: 1500, help: 'Wait for one answer before a retry. Devices behind MS/TP routers may need 3000 or more.' },
      { name: 'apduRetries', label: 'Retries', type: 'number', default: 2, help: 'Re-sends of an unanswered request, within the request deadline.' },
      { name: 'maxApdu', label: 'Max APDU (bytes)', type: 'select', default: 'auto', options: MAX_APDU_CHOICES, advanced: true, help: 'auto uses what the device reports. Lower it for a device that misreports its buffer size.' },
      { name: 'maxProperties', label: 'Max properties per request', type: 'number', default: 32, advanced: true, help: 'Cap on properties in one ReadPropertyMultiple, for devices that fail large requests.' },
      { name: 'maxOutstanding', label: 'Requests in flight', type: 'number', default: 1, advanced: true, help: 'Confirmed requests sent before an answer arrives (browse and ReadProperty fallback). Keep 1 for MS/TP devices.' },
    ],
    addressHelp: 'object-type:instance[/property][[index]], e.g. analog-input:3, binary-value:2, analog-value:7/units, device:1234/object-list[0]',
    prerequisites:
      'BACnet has no authentication. Manifold sends only Who-Is (to this device, never broadcast), ReadProperty and ReadPropertyMultiple; it never writes, commands or subscribes. ' +
      'UDP port 47808 must be reachable both ways. Devices that answer Who-Is only by broadcast are still read: the driver falls back to reading the device object.',
  };
}

const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** MAC text -> Buffer. "12" (MS/TP), "10.0.0.5:47808" (B/IP, 6 bytes), "0a:1b:2c" (hex). */
function parseMac(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('mac is required with a network number');
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    if (n > 255) throw new Error('a one-byte MAC must be 0-255');
    return Buffer.from([n]);
  }
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/.exec(t);
  if (ip) {
    const octets = ip.slice(1, 5).map(Number);
    const port = ip[5] === undefined ? 47808 : Number(ip[5]);
    if (octets.some((o) => o > 255) || port < 1 || port > 65535) throw new Error(`"${t}" is not an IPv4 address and port`);
    const b = Buffer.alloc(6);
    octets.forEach((o, i) => (b[i] = o));
    b.writeUInt16BE(port, 4);
    return b;
  }
  const hex = t.replace(/[:\-\s]/g, '');
  if (/^([0-9a-f]{2}){1,18}$/i.test(hex)) return Buffer.from(hex, 'hex');
  throw new Error(`"${t}" is not a MAC address (MS/TP 0-127, 10.0.0.5:47808, or hex bytes such as 0a:1b)`);
}

/**
 * @returns {{ok:true, normalized:object}|{ok:false, error:string}}
 */
function validateTag(tagDef) {
  const fail = (error) => ({ ok: false, error });
  if (!tagDef || typeof tagDef !== 'object') return fail('tag must be an object');
  const { key, type } = tagDef;
  if (typeof key !== 'string' || !key) return fail('key must be a non-empty string');
  if (type !== undefined && type !== null && type !== '' && !TAG_TYPES.includes(type)) {
    return fail(`unknown type "${type}" (supported: ${TAG_TYPES.join(', ')}; leave empty to use the type the device sends)`);
  }
  let a;
  try {
    a = parseAddress(tagDef.address);
  } catch (err) {
    return fail(err.message);
  }
  return {
    ok: true,
    normalized: {
      key,
      type: type || undefined,
      address: formatAddress(a),
      objectType: a.objectType,
      objectTypeName: objectTypeName(a.objectType),
      instance: a.instance,
      property: a.property,
      propertyName: propertyName(a.property),
      index: a.index,
      pollGroup: tagDef.pollGroup,
    },
  };
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const errs = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...DEFAULT_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 47808;
  if (typeof device.host !== 'string' || !device.host.trim()) errs.push('host must be a non-empty string');
  if (!isIntIn(port, 1, 65535)) errs.push('port must be an integer 1..65535');
  const deviceInstance = device.deviceInstance === undefined || device.deviceInstance === null || device.deviceInstance === '' ? undefined : device.deviceInstance;
  if (deviceInstance !== undefined && !isIntIn(deviceInstance, 0, 4194302)) errs.push('deviceInstance must be an integer 0..4194302');
  let route = null;
  const hasNet = device.network !== undefined && device.network !== null && device.network !== '';
  const hasMac = device.mac !== undefined && device.mac !== null && device.mac !== '';
  if (hasNet || hasMac) {
    if (!hasNet) errs.push('network is required with a MAC address');
    else if (!isIntIn(device.network, 1, 65534)) errs.push('network must be an integer 1..65534');
    else {
      try {
        route = { network: device.network, mac: parseMac(device.mac) };
      } catch (err) {
        errs.push(err.message);
      }
    }
  }
  if (!['auto', 'on', 'off'].includes(options.readMultiple)) errs.push('options.readMultiple must be auto, on or off');
  if (typeof options.readStatus !== 'boolean') errs.push('options.readStatus must be true or false');
  if (!isIntIn(options.apduTimeoutMs, 100, 60000)) errs.push('options.apduTimeoutMs must be an integer 100..60000');
  if (!isIntIn(options.apduRetries, 0, 10)) errs.push('options.apduRetries must be an integer 0..10');
  if (!MAX_APDU_CHOICES.includes(String(options.maxApdu))) errs.push(`options.maxApdu must be one of ${MAX_APDU_CHOICES.join(', ')}`);
  if (!isIntIn(options.maxProperties, 1, 500)) errs.push('options.maxProperties must be an integer 1..500');
  if (!isIntIn(options.maxOutstanding, 1, 16)) errs.push('options.maxOutstanding must be an integer 1..16');
  for (const f of ['requestDeadlineMs', 'connectTimeoutMs']) if (!(limits[f] > 0)) errs.push(`limits.${f} must be a positive number`);
  const details = errs.map((error) => ({ key: null, error }));
  const tags = new Map();
  if (!Array.isArray(device.tags ?? [])) details.push({ key: null, error: 'tags must be an array' });
  else {
    for (const t of device.tags || []) {
      const r = validateTag(t);
      if (!r.ok) details.push({ key: t && t.key !== undefined ? t.key : null, error: r.error });
      else if (tags.has(r.normalized.key)) details.push({ key: r.normalized.key, error: 'duplicate tag key' });
      else tags.set(r.normalized.key, r.normalized);
    }
  }
  if (details.length) {
    const err = new Error(`invalid BACnet device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  const host = device.host.trim();
  return { host, connectHost: connectAddress({ ...device, host }), port, deviceInstance, route, options, limits, tags };
}

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

const FATAL_KINDS = new Set(['timeout', 'transport', 'unreachable', 'queue-full', 'invalid']);

function fatal(res) {
  return { ok: false, kind: res.kind === 'queue-full' || res.kind === 'invalid' ? 'transport' : res.kind, fatal: true, message: res.message || res.kind };
}

function exception(res, classification, message) {
  return { ok: false, kind: 'exception', code: errors.codeOf(res), classification, message };
}

function firstValue(items) {
  return items && items.length === 1 && !items[0].items && items[0].hex === undefined ? items[0] : null;
}

/**
 * @param {object} device device config
 * @param {{socketFactory?:Function, onSend?:Function}} [deps]
 */
function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  let client = null;
  let session = null; // { instance, maxApdu, segmentation, rpm, identity }
  let objectList = null; // browse cache
  const failedKeys = new WeakMap(); // request -> Set(keys) whose own error failed it

  const where = () => `${cfg.host}:${cfg.port}${cfg.route ? ` (network ${cfg.route.network}, MAC ${macText(cfg.route.mac)})` : ''}`;

  function confirmed(build, service, deadlineAt, label) {
    if (!client || !client.isOpen()) return Promise.resolve({ ok: false, kind: 'transport', message: 'not connected' });
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.resolve({ ok: false, kind: 'timeout', message: `${label}: request deadline passed` });
    return client.request(build, { service, apduTimeoutMs: options.apduTimeoutMs, retries: options.apduRetries, deadlineMs: remaining, label });
  }

  function readProperty(ref, deadlineAt) {
    const route = cfg.route;
    return confirmed((id) => frame.readPropertyPacket(id, ref, { route }), frame.SERVICE.READ_PROPERTY, deadlineAt, `ReadProperty ${formatAddress(ref)}`).then((res) => {
      if (!res.ok) return res;
      try {
        return { ok: true, ack: frame.parseReadPropertyAck(res.apdu.body) };
      } catch (err) {
        return { ok: false, kind: 'framing', message: err.message };
      }
    });
  }

  function readMultiple(specs, deadlineAt) {
    const route = cfg.route;
    const n = specs.reduce((a, s) => a + s.refs.length, 0);
    return confirmed((id) => frame.readPropertyMultiplePacket(id, specs, { route }), frame.SERVICE.READ_PROPERTY_MULTIPLE, deadlineAt, `ReadPropertyMultiple (${n} properties)`).then((res) => {
      if (!res.ok) return res;
      try {
        return { ok: true, acks: frame.parseReadPropertyMultipleAck(res.apdu.body) };
      } catch (err) {
        return { ok: false, kind: 'framing', message: err.message };
      }
    });
  }

  function effectiveMaxApdu() {
    const ours = frame.OUR_MAX_APDU;
    const dev = session && session.maxApdu ? session.maxApdu : 480;
    const forced = options.maxApdu === 'auto' ? Infinity : Number(options.maxApdu);
    return Math.max(50, Math.min(ours, dev, forced));
  }

  /** Index RPM results by object/property/index; duplicates come back in request order. */
  function indexAcks(acks) {
    const map = new Map();
    for (const a of acks) {
      for (const r of a.results) {
        const k = `${a.objectType}:${a.instance}:${r.property}:${r.index ?? ''}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      }
    }
    return (item, property, index) => {
      const list = map.get(`${item.objectType}:${item.instance}:${property}:${index ?? ''}`);
      return list && list.length ? (list.length > 1 ? list.shift() : list[0]) : null;
    };
  }

  function sample(item, valueItems, status) {
    const tag = cfg.tags.get(item.key) || item;
    let v;
    try {
      v = castValue(naturalValue(valueItems, item), tag.type);
    } catch (err) {
      return { key: item.key, v: null, type: tag.type || 'unknown', q: Q_BAD, qReason: 'decode' };
    }
    const q = status ? qualityOf(status) : { q: 192 };
    const s = { key: item.key, v: v.v, type: v.type, q: q.q };
    if (q.qReason) s.qReason = q.qReason;
    return s;
  }

  function statusFrom(get) {
    const st = {};
    const sf = get(PROP.STATUS_FLAGS);
    const fv = sf && firstValue(sf);
    if (fv && fv.tag === 'bit-string') st.statusFlags = fv.value;
    const rel = get(PROP.RELIABILITY);
    const rv = rel && firstValue(rel);
    if (rv && rv.tag === 'enumerated') st.reliability = Number(rv.value);
    const oos = get(PROP.OUT_OF_SERVICE);
    const ov = oos && firstValue(oos);
    if (ov && ov.tag === 'boolean') st.outOfService = ov.value;
    return st;
  }

  /** Results of one RPM reply for the request's items. */
  function resultsFromRpm(request, acks) {
    const find = indexAcks(acks);
    const results = [];
    const failed = new Map(); // key -> error result
    for (const item of request.items) {
      const r = find(item, item.property, item.index);
      if (!r) {
        results.push({ key: item.key, v: null, type: item.type || 'unknown', q: Q_BAD, qReason: 'missing-in-reply' });
        continue;
      }
      if (r.error) {
        const cls = errors.classifyError(r.error.errorClass, r.error.errorCode);
        if (cls === 'permanent') failed.set(item.key, { kind: 'error', ...r.error });
        results.push({ key: item.key, v: null, type: item.type || 'unknown', q: Q_BAD, qReason: `device-exception: ${errors.errorCodeName(r.error.errorCode)}` });
        continue;
      }
      let status = null;
      if (item.withStatus) {
        status = statusFrom((p) => {
          const x = find(item, p, undefined);
          return x && !x.error ? x.values : null;
        });
      }
      results.push(sample(item, r.values, status));
    }
    return { results, failed };
  }

  /** Read the request's items one ReadProperty at a time (devices without RPM, or as a fallback). */
  async function executeRp(request, deadlineAt) {
    const results = [];
    const failed = new Map();
    const outcomes = await mapLimit(request.items, options.maxOutstanding, async (item) => {
      const res = await readProperty({ objectType: item.objectType, instance: item.instance, property: item.property, index: item.index }, deadlineAt);
      if (!res.ok) return { item, res };
      let status = null;
      if (item.withStatus) {
        const sf = await readProperty({ objectType: item.objectType, instance: item.instance, property: PROP.STATUS_FLAGS }, deadlineAt);
        if (!sf.ok && FATAL_KINDS.has(sf.kind)) return { item, res: sf };
        status = statusFrom((p) => (p === PROP.STATUS_FLAGS && sf.ok ? sf.ack.values : null));
      }
      return { item, value: res.ack.values, status };
    });
    for (const o of outcomes) {
      if (o.res) {
        if (FATAL_KINDS.has(o.res.kind) || o.res.kind === 'framing') return fatal(o.res);
        if (o.res.kind === 'error' && errors.classifyError(o.res.errorClass, o.res.errorCode) === 'permanent') failed.set(o.item.key, o.res);
        else if (errors.isTooBig(o.res) || o.res.kind === 'segmented') {
          failed.set(o.item.key, { ...o.res, message: `${formatAddress(o.item)}: the value does not fit in one APDU and this client does not accept segmented replies; read it by array index` });
        }
        results.push({ key: o.item.key, v: null, type: o.item.type || 'unknown', q: Q_BAD, qReason: `device-exception: ${errors.codeOf(o.res)}` });
        continue;
      }
      results.push(sample(o.item, o.value, o.status));
    }
    return finishWithFailures(request, results, failed);
  }

  function finishWithFailures(request, results, failed) {
    if (!failed.size) return { ok: true, results };
    const [key, res] = failed.entries().next().value;
    failedKeys.set(request, new Set(failed.keys()));
    const msg = res.message || `${formatAddress(request.items.find((i) => i.key === key))}: ${errors.resultText(res)}`;
    return exception(res, 'permanent', msg);
  }

  async function executeRpm(request, deadlineAt) {
    const res = await readMultiple(rpmSpecs(request.items), deadlineAt);
    if (res.ok) {
      const { results, failed } = resultsFromRpm(request, res.acks);
      return finishWithFailures(request, results, failed);
    }
    if (FATAL_KINDS.has(res.kind) || res.kind === 'framing') return fatal(res);
    if (errors.isUnsupportedService(res) && options.readMultiple !== 'on') {
      session.rpm = false;
      session.rpmReason = errors.resultText(res);
      return executeRp(request, deadlineAt);
    }
    if (errors.isTooBig(res) || res.kind === 'segmented') {
      if (request.items.length > 1) return exception(res, 'permanent', `ReadPropertyMultiple reply too large, splitting: ${errors.resultText(res)}`);
      return executeRp(request, deadlineAt);
    }
    if (res.kind === 'error') {
      // Some devices answer the WHOLE RPM with one Error when a single object is unknown: split to find it.
      const cls = errors.classifyError(res.errorClass, res.errorCode);
      const msg = request.items.length === 1 ? `${formatAddress(request.items[0])}: ${errors.resultText(res)}` : `ReadPropertyMultiple failed: ${errors.resultText(res)}`;
      return exception(res, cls === 'permanent' ? 'permanent' : 'transient', msg);
    }
    // reject / abort for other reasons: transient for this cycle
    return exception(res, request.items.length > 1 ? 'permanent' : 'transient', errors.resultText(res));
  }

  /** Read device-object properties with RPM (or RP), tolerating per-property errors. */
  async function readDeviceProps(instance, props, deadlineAt, useRpm) {
    const out = {};
    if (useRpm) {
      const res = await readMultiple([{ objectType: OBJ.DEVICE, instance, refs: props.map((property) => ({ property })) }], deadlineAt);
      if (res.ok) {
        let unknown = null;
        for (const a of res.acks) {
          for (const r of a.results) {
            if (!r.error) out[r.property] = r.values;
            else if (r.error.errorClass === 1 && r.error.errorCode === 31) unknown = r.error;
          }
        }
        if (unknown && !Object.keys(out).length) return { ok: false, kind: 'error', ...unknown };
        return { ok: true, values: out, rpm: true };
      }
      if (FATAL_KINDS.has(res.kind) || res.kind === 'framing') return res;
      if (options.readMultiple === 'on' && !(res.kind === 'error' && errors.classifyError(res.errorClass, res.errorCode) === 'permanent')) {
        return { ok: true, values: out, rpm: true, rpmNote: errors.resultText(res) };
      }
      if (res.kind === 'error' && errors.classifyError(res.errorClass, res.errorCode) === 'permanent' && res.errorClass === 1) return res; // unknown object: wrong instance
      // Not supported (or unusable): read one by one.
      const viaRp = await readDeviceProps(instance, props, deadlineAt, false);
      if (viaRp.ok) viaRp.rpmNote = errors.resultText(res);
      return viaRp;
    }
    for (const property of props) {
      const r = await readProperty({ objectType: OBJ.DEVICE, instance, property }, deadlineAt);
      if (r.ok) out[property] = r.ack.values;
      else if (FATAL_KINDS.has(r.kind) || r.kind === 'framing') return r;
      else if (r.kind === 'error' && r.errorClass === 1 && Object.keys(out).length === 0) return r;
    }
    return { ok: true, values: out, rpm: false };
  }

  const str = (items) => {
    const f = firstValue(items);
    return f && (f.tag === 'character-string' || f.tag === 'octet-string') ? String(f.value) : undefined;
  };
  const num = (items) => {
    const f = firstValue(items);
    return f && (f.tag === 'unsigned' || f.tag === 'enumerated') ? Number(f.value) : undefined;
  };

  async function connectOnce() {
    const deadlineAt = Date.now() + limits.connectTimeoutMs;
    if (!net.isIP(cfg.connectHost)) throw new Error(`cannot resolve ${cfg.host}: BACnet/IP needs an IP address (the server pins hostnames before the driver starts)`);
    client = new BacnetClient({ host: cfg.connectHost, displayHost: cfg.host, port: cfg.port, route: cfg.route, maxOutstanding: options.maxOutstanding, socketFactory: deps.socketFactory, onSend: deps.onSend });
    await client.open();
    objectList = null;
    // 1. Unicast Who-Is (never broadcast). A unicast I-Am gives instance, max APDU and segmentation.
    const iam = await client.whoIs({ instance: cfg.deviceInstance, waitMs: Math.min(options.apduTimeoutMs, 1500, Math.max(100, deadlineAt - Date.now())) });
    let instance = cfg.deviceInstance ?? (iam ? iam.instance : undefined);
    let learnedBy = iam ? 'i-am' : cfg.deviceInstance !== undefined ? 'configured' : null;
    // 2. No instance yet: the wildcard device instance 4194303 addresses "the device you are".
    if (instance === undefined) {
      const r = await readProperty({ objectType: OBJ.DEVICE, instance: enc.WILDCARD_INSTANCE, property: PROP.OBJECT_IDENTIFIER }, deadlineAt);
      const f = r.ok ? firstValue(r.ack.values) : null;
      if (!f || f.tag !== 'object-identifier') {
        const why = r.ok ? 'an unexpected value' : errors.resultText(r);
        throw new Error(`${where()} did not answer Who-Is and ReadProperty(device ${enc.WILDCARD_INSTANCE}, object-identifier) gave ${why}. Enter the device instance.`);
      }
      instance = f.value.instance;
      learnedBy = 'wildcard-read';
    }
    // 3. Identity and limits from the device object; this also tells whether RPM works.
    const props = [PROP.OBJECT_NAME, PROP.VENDOR_NAME, PROP.VENDOR_IDENTIFIER, PROP.MODEL_NAME, PROP.FIRMWARE_REVISION, PROP.APPLICATION_SOFTWARE_VERSION, PROP.PROTOCOL_REVISION, PROP.MAX_APDU_LENGTH_ACCEPTED, PROP.SEGMENTATION_SUPPORTED];
    const dev = await readDeviceProps(instance, props, deadlineAt, options.readMultiple !== 'off');
    if (!dev.ok) {
      if (dev.kind === 'error' && dev.errorClass === 1) throw new Error(`${where()}: device ${instance} does not exist there (${errors.resultText(dev)}). Check the device instance.`);
      throw new Error(`${where()}: device ${instance} did not answer: ${errors.resultText(dev)}`);
    }
    const v = dev.values;
    const maxApdu = iam ? iam.maxApdu : num(v[PROP.MAX_APDU_LENGTH_ACCEPTED]);
    const segmentation = iam ? iam.segmentation : num(v[PROP.SEGMENTATION_SUPPORTED]);
    session = {
      instance,
      maxApdu: maxApdu && maxApdu >= 50 ? maxApdu : 480,
      segmentation,
      rpm: options.readMultiple === 'on' ? true : options.readMultiple === 'off' ? false : dev.rpm,
      rpmReason: dev.rpmNote || null,
    };
    const identity = {
      deviceInstance: instance,
      learnedBy,
      objectName: str(v[PROP.OBJECT_NAME]),
      vendorName: str(v[PROP.VENDOR_NAME]),
      vendorId: iam ? iam.vendorId : num(v[PROP.VENDOR_IDENTIFIER]),
      modelName: str(v[PROP.MODEL_NAME]),
      firmwareRevision: str(v[PROP.FIRMWARE_REVISION]),
      applicationSoftwareVersion: str(v[PROP.APPLICATION_SOFTWARE_VERSION]),
      protocolRevision: num(v[PROP.PROTOCOL_REVISION]),
      segmentation: segmentation !== undefined ? SEGMENTATION[segmentation] || segmentation : undefined,
    };
    for (const k of Object.keys(identity)) if (identity[k] === undefined) delete identity[k];
    session.identity = identity;
    return {
      identity,
      limits: {
        maxApdu: effectiveMaxApdu(),
        deviceMaxApdu: session.maxApdu,
        readMultiple: session.rpm,
        ...(session.rpmReason ? { readMultipleNote: session.rpmReason } : {}),
        apduTimeoutMs: options.apduTimeoutMs,
        apduRetries: options.apduRetries,
        requestDeadlineMs: limits.requestDeadlineMs,
      },
    };
  }

  function itemFor(tag) {
    return {
      key: tag.key,
      type: tag.type,
      objectType: tag.objectType,
      instance: tag.instance,
      property: tag.property,
      index: tag.index,
      withStatus: options.readStatus && tag.property === PROP.PRESENT_VALUE && tag.index === undefined && STATUS_TYPES.has(tag.objectType),
    };
  }

  // ---- browse ----------------------------------------------------------------------------------

  async function readObjectList(deadlineAt) {
    if (objectList) return objectList;
    const inst = session.instance;
    const lenRes = await readProperty({ objectType: OBJ.DEVICE, instance: inst, property: PROP.OBJECT_LIST, index: 0 }, deadlineAt);
    if (!lenRes.ok) throw new Error(`object-list length: ${errors.resultText(lenRes)}`);
    const lv = firstValue(lenRes.ack.values);
    if (!lv || lv.tag !== 'unsigned') throw new Error('object-list[0] is not an unsigned count');
    const count = Math.min(Number(lv.value), BROWSE_MAX_OBJECTS);
    const ids = [];
    const take = (items) => {
      for (const it of items) if (it.tag === 'object-identifier') ids.push(it.value);
    };
    // Read by array index: the whole list rarely fits in one unsegmented APDU.
    const perRequest = Math.max(1, Math.min(options.maxProperties, Math.floor((effectiveMaxApdu() - 20) / 12)));
    if (session.rpm) {
      const batches = [];
      for (let i = 1; i <= count; i += perRequest) batches.push(Array.from({ length: Math.min(perRequest, count - i + 1) }, (_, k) => i + k));
      const results = await mapLimit(batches, options.maxOutstanding, async (indexes) => {
        const r = await readMultiple([{ objectType: OBJ.DEVICE, instance: inst, refs: indexes.map((index) => ({ property: PROP.OBJECT_LIST, index })) }], deadlineAt);
        if (!r.ok) throw new Error(`object-list: ${errors.resultText(r)}`);
        return r.acks.flatMap((a) => a.results.filter((x) => !x.error).flatMap((x) => x.values));
      });
      for (const items of results) take(items);
    } else {
      const indexes = Array.from({ length: count }, (_, k) => k + 1);
      const results = await mapLimit(indexes, options.maxOutstanding, async (index) => {
        const r = await readProperty({ objectType: OBJ.DEVICE, instance: inst, property: PROP.OBJECT_LIST, index }, deadlineAt);
        if (!r.ok) {
          if (FATAL_KINDS.has(r.kind)) throw new Error(`object-list[${index}]: ${errors.resultText(r)}`);
          return [];
        }
        return r.ack.values;
      });
      for (const items of results) take(items);
    }
    objectList = { count: Number(lv.value), ids };
    return objectList;
  }

  async function describeObjects(ids, deadlineAt) {
    const propsFor = (id) => [PROP.OBJECT_NAME, PROP.DESCRIPTION, ...(UNIT_TYPES.has(id.type) ? [PROP.UNITS] : [])];
    const info = new Map(ids.map((id) => [`${id.type}:${id.instance}`, {}]));
    const store = (type, instance, property, values) => {
      const rec = info.get(`${type}:${instance}`);
      if (!rec) return;
      if (property === PROP.OBJECT_NAME) rec.objectName = str(values);
      else if (property === PROP.DESCRIPTION) rec.description = str(values);
      else if (property === PROP.UNITS) {
        const u = num(values);
        if (u !== undefined) rec.unit = unitInfo(u);
      }
    };
    if (session.rpm) {
      const perRequest = Math.max(1, Math.floor(options.maxProperties / 3));
      const budgetObjects = Math.max(1, Math.floor((effectiveMaxApdu() - 20) / 220));
      const step = Math.min(perRequest, budgetObjects);
      const batches = [];
      for (let i = 0; i < ids.length; i += step) batches.push(ids.slice(i, i + step));
      await mapLimit(batches, options.maxOutstanding, async (batch) => {
        const r = await readMultiple(batch.map((id) => ({ objectType: id.type, instance: id.instance, refs: propsFor(id).map((property) => ({ property })) })), deadlineAt);
        if (r.ok) {
          for (const a of r.acks) for (const x of a.results) if (!x.error) store(a.objectType, a.instance, x.property, x.values);
          return;
        }
        if (FATAL_KINDS.has(r.kind)) throw new Error(errors.resultText(r));
        // Too big or refused: fall back to one object at a time with ReadProperty.
        for (const id of batch) {
          for (const property of propsFor(id)) {
            const one = await readProperty({ objectType: id.type, instance: id.instance, property }, deadlineAt);
            if (one.ok) store(id.type, id.instance, property, one.ack.values);
            else if (FATAL_KINDS.has(one.kind)) throw new Error(errors.resultText(one));
          }
        }
      });
    } else {
      await mapLimit(ids, options.maxOutstanding, async (id) => {
        for (const property of propsFor(id)) {
          const one = await readProperty({ objectType: id.type, instance: id.instance, property }, deadlineAt);
          if (one.ok) store(id.type, id.instance, property, one.ack.values);
          else if (FATAL_KINDS.has(one.kind)) throw new Error(errors.resultText(one));
        }
      });
    }
    return info;
  }

  function objectNode(id, rec) {
    const address = formatAddress({ objectType: id.type, instance: id.instance, property: PROP.PRESENT_VALUE });
    const hasPv = PV_TYPES.has(id.type);
    const meta = { objectType: objectTypeName(id.type), instance: id.instance };
    if (rec.objectName) meta.objectName = rec.objectName;
    if (rec.description) meta.description = rec.description;
    if (rec.unit) {
      meta.unit = rec.unit.text;
      meta.unitName = rec.unit.name;
      meta.unitCode = rec.unit.code;
    }
    // Objects without a standard present-value (device, schedule, trend-log ...) are offered as their object-name.
    const tagAddress = hasPv ? address : `${address}/object-name`;
    return { id: `obj:${id.type}:${id.instance}`, name: rec.objectName ? `${rec.objectName} (${address})` : address, kind: 'tag', address: tagAddress, meta };
  }

  return {
    protocol,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (client) client.close();
      session = null;
      try {
        return await connectOnce();
      } catch (err) {
        if (client) client.close();
        throw err;
      }
    },

    isConnected() {
      return !!client && client.isOpen() && !!session;
    },

    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      const items = keys.map((k) => {
        const tag = cfg.tags.get(k);
        if (!tag) throw new Error(`unknown tag key "${k}"`);
        return itemFor(tag);
      });
      if (session && session.rpm === false) return planRp(items);
      return planRpm(items, { maxApdu: effectiveMaxApdu(), maxProperties: options.maxProperties });
    },

    async execute(request, deadlineMs) {
      const deadlineAt = Date.now() + (deadlineMs ?? limits.requestDeadlineMs);
      if (!session) return { ok: false, kind: 'transport', fatal: true, message: 'not connected' };
      if (request.kind === 'rpm' && session.rpm !== false) return executeRpm(request, deadlineAt);
      return executeRp(request, deadlineAt);
    },

    bisect(request) {
      const failed = failedKeys.get(request) || null;
      return bisectRequest(request, failed);
    },

    async browse(node) {
      if (!session) throw new Error('not connected');
      const deadlineAt = Date.now() + Math.max(limits.requestDeadlineMs * 4, 20000);
      const list = await readObjectList(deadlineAt);
      const byType = new Map();
      for (const id of list.ids) {
        if (!byType.has(id.type)) byType.set(id.type, []);
        byType.get(id.type).push(id);
      }
      if (!node) {
        const truncated = list.count > list.ids.length;
        return [...byType.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([type, ids]) => ({
            id: `type:${type}`,
            name: `${objectTypeName(type)} (${ids.length})`,
            kind: 'folder',
            address: '',
            meta: { objectType: objectTypeName(type), count: ids.length, ...(truncated ? { note: `object-list has ${list.count} entries; the first ${list.ids.length} are listed` } : {}) },
          }));
      }
      const m = /^type:(\d+)(?::(\d+))?$/.exec(String(node));
      if (!m) throw new Error(`unknown browse node "${node}"`);
      const ids = (byType.get(Number(m[1])) || []).slice().sort((a, b) => a.instance - b.instance);
      if (m[2] === undefined && ids.length > BROWSE_PAGE) {
        const pages = [];
        for (let i = 0; i < ids.length; i += BROWSE_PAGE) {
          const part = ids.slice(i, i + BROWSE_PAGE);
          pages.push({ id: `type:${m[1]}:${i}`, name: `${objectTypeName(Number(m[1]))} ${part[0].instance}-${part[part.length - 1].instance}`, kind: 'folder', address: '', meta: { count: part.length } });
        }
        return pages;
      }
      const start = m[2] === undefined ? 0 : Number(m[2]);
      const page = ids.slice(start, start + BROWSE_PAGE);
      const info = await describeObjects(page, deadlineAt);
      return page.map((id) => objectNode(id, info.get(`${id.type}:${id.instance}`) || {}));
    },

    async probe({ address } = {}) {
      if (!session) throw new Error('not connected');
      const a = parseAddress(address);
      const deadlineAt = Date.now() + limits.requestDeadlineMs;
      const res = await readProperty({ objectType: a.objectType, instance: a.instance, property: a.property, index: a.index }, deadlineAt);
      if (!res.ok) {
        const err = new Error(`probe ${formatAddress(a)} failed: ${errors.resultText(res)}`);
        err.result = { kind: res.kind, code: errors.codeOf(res) };
        throw err;
      }
      const natural = naturalValue(res.ack.values, a);
      const decodings = {
        value: natural.v,
        applicationTags: res.ack.values.map((i) => i.tag || (i.items ? `context ${i.context} (constructed)` : `context ${i.context}`)).join(', '),
      };
      const charset = res.ack.values.find((i) => i.charset);
      if (charset) decodings.characterSet = charset.charset;
      if (a.property === PROP.PRESENT_VALUE && STATUS_TYPES.has(a.objectType)) {
        for (const property of [...STATUS_PROPS, ...(UNIT_TYPES.has(a.objectType) ? [PROP.UNITS] : []), PROP.OBJECT_NAME]) {
          const r = await readProperty({ objectType: a.objectType, instance: a.instance, property }, deadlineAt);
          if (!r.ok) continue;
          const name = propertyName(property);
          if (property === PROP.UNITS) {
            const u = num(r.ack.values);
            if (u !== undefined) decodings.units = `${unitInfo(u).text || '(none)'} (${unitInfo(u).name})`;
          } else decodings[name] = naturalValue(r.ack.values, { objectType: a.objectType, property }).v;
        }
      }
      return { address: formatAddress(a), type: natural.type, rawHex: res.ack.raw.toString('hex'), decodings };
    },

    /** Diagnostics (tests and status). */
    session() {
      return session ? { ...session } : null;
    },

    clientStats() {
      return client ? { ...client.stats } : null;
    },

    async close() {
      const c = client;
      client = null;
      session = null;
      objectList = null;
      if (c) c.close();
    },
  };
}

module.exports = { protocol, describe, validateTag, createDriver, parseMac, normalizeDevice, refsOf, plain };
