'use strict';

/**
 * Siemens S7 (classic S7comm over ISO-on-TCP, port 102) — READ-ONLY driver.
 * Implements the southbound driver contract (docs/design/southbound-drivers.md §4.1, §5.2).
 */

const {
  FUNC,
  AREA_NAME,
  S7ReadOnlyError,
  remoteTsapFor,
  parseReadVarResponse,
  parseSzlResponse,
  explainItemCode,
  explainHeaderError,
  S7MismatchError,
} = require('./frame');
const { parseAddress, formatAddress, ADDRESS_HELP } = require('./address');
const { TYPES, normalizeType, byteLength, decode, probeDecodings, S7DecodeError } = require('./decode');
const { planReads, bisect, limitsFor } = require('./planner');
const { S7Client, S7ExceptionError, errorKind } = require('./client');

const protocol = 's7';
const DEFAULT_PDU = 960;
const PLAN_PDU_BEFORE_CONNECT = 240; // smallest size real CPUs negotiate; always safe
const DEFAULT_MAX_GAP = 8;

const PREREQUISITES = [
  'The CPU must allow classic S7comm (PUT/GET) access. In TIA Portal:',
  '1. Use global data blocks; instance DBs of optimized FBs cannot be read.',
  '2. In each DB to be read: Properties → Attributes → "Optimized block access" OFF, then compile and download.',
  '3. CPU properties → Protection & Security → Connection mechanisms → "Permit access with PUT/GET communication from remote partner" ON.',
  '4. The protection level must not block HMI/read access.',
  'Warning: enabling PUT/GET makes the DB areas readable AND WRITABLE by anything that can reach the CPU on that network — S7comm has no authentication. This driver never writes, but other clients could. Restrict the path with a firewall rule or a read-only network segment.',
  "Where the CPU's OPC UA server is licensed (S7-1500, S7-1200 FW ≥ 4.4), it is the better route: it supports optimized blocks, symbolic access and authentication. Manifold already speaks OPC UA.",
].join('\n');

function describe() {
  return {
    protocol,
    label: 'Siemens S7',
    defaultPort: 102,
    readOnly: true,
    experimental: true, // verified against the in-process simulator only; see NOTES.md
    capabilities: { browse: false, subscribe: false, maxInFlight: 1 },
    deviceFields: [
      { name: 'rack', label: 'Rack', type: 'integer', min: 0, max: 7, default: 0 },
      { name: 'slot', label: 'Slot', type: 'integer', min: 0, max: 31, default: 1 },
      {
        name: 'presets',
        type: 'presets',
        presets: [
          { label: 'S7-300 / S7-400', rack: 0, slot: 2 },
          { label: 'S7-1200 / S7-1500', rack: 0, slot: 1 },
        ],
      },
      { name: 'localTsap', label: 'Local TSAP (advanced)', type: 'tsap', optional: true, placeholder: '01.00', help: 'Overrides the default 0x0100.' },
      {
        name: 'remoteTsap',
        label: 'Remote TSAP (advanced)',
        type: 'tsap',
        optional: true,
        placeholder: '01.02',
        help: 'Overrides rack/slot, e.g. for LOGO! or drives. Hex, as "01.02" or "0x0102".',
      },
    ],
    optionFields: [
      {
        name: 'maxGap',
        label: 'Max gap (bytes)',
        type: 'integer',
        min: 0,
        max: 256,
        default: DEFAULT_MAX_GAP,
        help: 'Unused bytes that may be read to merge neighbouring tags in one DB into a single block.',
      },
      {
        name: 'pduSize',
        label: 'PDU size request',
        type: 'integer',
        min: 240,
        max: 960,
        default: DEFAULT_PDU,
        help: 'Requested; the CPU negotiates down (S7-300 typically 240, S7-400 480, S7-1500 960).',
      },
    ],
    tagTypes: Object.keys(TYPES).map((name) => ({
      name,
      sampleType: TYPES[name].sample,
      bytes: TYPES[name].size,
      ...(TYPES[name].size === null ? { needsLength: true, lengthHelp: 'maximum characters (default 254)' } : {}),
    })),
    addressHelp: `${ADDRESS_HELP}. The address is where the value starts; the type sets its size. BOOL needs a bit address (DB1.DBX0.3); other types use DBB/DBW/DBD (any type may use DBB). STRING/WSTRING take "length" = declared maximum characters.`,
    prerequisites: PREREQUISITES,
  };
}

/**
 * Validate and normalize one tag definition.
 * @param {{key:string, address:string, type:string, length?:number, pollGroup?:string}} tagDef
 * @returns {{ok:true, normalized:object} | {ok:false, error:string}}
 */
function validateTag(tagDef, options = {}) {
  void options;
  try {
    if (!tagDef || typeof tagDef !== 'object') throw new Error('tag definition must be an object');
    if (typeof tagDef.key !== 'string' || !tagDef.key) throw new Error('tag needs a non-empty string key');
    const type = normalizeType(tagDef.type);
    if (!type) throw new Error(`unknown type "${tagDef.type}"; use one of ${Object.keys(TYPES).join(', ')}`);
    const a = parseAddress(tagDef.address);
    const fixed = TYPES[type].size;
    if (type === 'BOOL' && a.size !== 'X') throw new Error(`BOOL needs a bit address such as DB1.DBX0.3 or M0.1, got "${tagDef.address}"`);
    if (type !== 'BOOL' && a.size === 'X') throw new Error(`${type} cannot use a bit address; use the byte form (e.g. DB1.DBB${a.byteOffset})`);
    if (a.size === 'W' && fixed !== 2) throw new Error(`a W address holds 2 bytes but ${type} is ${fixed || 'variable'}; use DBB/MB…`);
    if (a.size === 'D' && fixed !== 4) throw new Error(`a D address holds 4 bytes but ${type} is ${fixed || 'variable'}; use DBB/MB…`);
    const length = byteLength({ type, length: tagDef.length });
    if (a.byteOffset + length - 1 > 0x1fffff) throw new Error('value extends beyond the addressable range');
    const size = type === 'BOOL' ? 'X' : fixed === 2 ? 'W' : fixed === 4 ? 'D' : 'B';
    const normalized = {
      key: tagDef.key,
      address: formatAddress({ ...a, size }),
      area: a.area,
      areaCode: a.areaCode,
      db: a.db,
      byteOffset: a.byteOffset,
      bitOffset: a.bitOffset,
      type,
      sampleType: TYPES[type].sample,
      length,
      ...(type === 'STRING' || type === 'WSTRING' ? { chars: tagDef.length ?? 254 } : {}),
      ...(tagDef.pollGroup !== undefined ? { pollGroup: tagDef.pollGroup } : {}),
    };
    return { ok: true, normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Parse a TSAP given as a number, "0x0102", "0102" or Siemens "01.02". */
function parseTsap(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Number.isInteger(value) && value >= 0 && value <= 0xffff) return value;
  const s = String(value).trim();
  let m = /^([0-9a-f]{1,2})\.([0-9a-f]{1,2})$/i.exec(s);
  if (m) return (parseInt(m[1], 16) << 8) | parseInt(m[2], 16);
  m = /^(?:0x)?([0-9a-f]{1,4})$/i.exec(s);
  if (m) return parseInt(m[1], 16);
  throw new Error(`${name} "${value}" is not a TSAP (use hex such as 01.02 or 0x0102)`);
}

function trimText(buf) {
  return buf.toString('latin1').replace(/[\0\s]+$/g, '').replace(/^\s+/, '');
}

const CPU_STATES = { 0x08: 'RUN', 0x04: 'STOP', 0x03: 'STOP', 0x02: 'STOP', 0x01: 'STOP', 0x05: 'STARTUP', 0x06: 'STARTUP', 0x07: 'STARTUP', 0x0a: 'HOLD' };

/**
 * @param {object} device see module docs / contract
 * @param {{createClient?:(opts:object)=>S7Client}} [deps]
 */
function createDriver(device, deps = {}) {
  if (!device || typeof device !== 'object') throw new Error('device config required');
  if (!device.host) throw new Error('device.host is required');
  const options = device.options || {};
  const limits = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, ...(device.limits || {}) };
  const maxGap = options.maxGap ?? DEFAULT_MAX_GAP;
  const requestedPdu = options.pduSize ?? DEFAULT_PDU;
  limitsFor(requestedPdu); // validates
  const localTsap = parseTsap(device.localTsap, 'localTsap') ?? 0x0100;
  let remoteTsap = parseTsap(device.remoteTsap, 'remoteTsap');
  if (remoteTsap === undefined) {
    if (device.rack === undefined || device.slot === undefined) {
      throw new Error('S7 device needs rack and slot (S7-300/400: 0/2, S7-1200/1500: 0/1) or a remoteTsap');
    }
    remoteTsap = remoteTsapFor(Number(device.rack), Number(device.slot));
  }
  const createClient = deps.createClient || ((o) => new S7Client(o));

  const tags = new Map();
  const tagErrors = [];
  for (const t of device.tags || []) {
    const r = validateTag(t, options);
    if (!r.ok) tagErrors.push({ key: t && t.key, error: r.error });
    else if (tags.has(r.normalized.key)) tagErrors.push({ key: r.normalized.key, error: 'duplicate key' });
    else tags.set(r.normalized.key, r.normalized);
  }

  let client = null;
  let negotiated = null;
  let identityUnsupported = options.readIdentity === false;

  const planPdu = () => (negotiated ? negotiated.pduSize : Math.min(PLAN_PDU_BEFORE_CONNECT, requestedPdu));

  async function readSzl(szlId, szlIndex) {
    const pdu = await client.request({ type: 'userdata', group: 0x4, subfunction: 0x01, szlId, szlIndex }, Math.min(limits.requestDeadlineMs, 2000));
    return parseSzlResponse(pdu);
  }

  async function readIdentity() {
    const identity = {};
    const text = async (field, idx) => {
      try {
        const r = await readSzl(0x011c, idx);
        if (r.records[0] && r.records[0].length >= 4) {
          const v = trimText(r.records[0].subarray(2, 34));
          if (v) identity[field] = v;
        }
      } catch (err) {
        if (!client.isConnected()) throw err; // non-fatal SZL errors are skipped
      }
    };
    await text('systemName', 0x0001);
    await text('moduleName', 0x0002);
    await text('serialNumber', 0x0005);
    await text('moduleTypeName', 0x0007);
    try {
      const r = await readSzl(0x0111, 0x0001);
      if (r.records[0] && r.records[0].length >= 22) identity.orderCode = trimText(r.records[0].subarray(2, 22));
    } catch (err) {
      if (!client.isConnected()) throw err;
    }
    try {
      const r = await readSzl(0x0111, 0x0007);
      const rec = r.records[0];
      if (rec && rec.length >= 28) identity.firmware = `V${rec[25]}.${rec[26]}.${rec[27]}`;
    } catch (err) {
      if (!client.isConnected()) throw err;
    }
    try {
      const r = await readSzl(0x0424, 0x0000);
      const rec = r.records[0];
      if (rec && rec.length >= 4) identity.cpuState = CPU_STATES[rec[3] & 0x0f] || 'UNKNOWN';
    } catch (err) {
      if (!client.isConnected()) throw err;
    }
    return identity;
  }

  async function openClient() {
    if (client) await client.close().catch(() => {});
    negotiated = null;
    client = createClient({
      host: device.host,
      port: device.port || 102,
      localTsap,
      remoteTsap,
      pduSize: requestedPdu,
      maxAmq: 1,
      connectTimeoutMs: limits.connectTimeoutMs,
    });
    const neg = await client.connect();
    negotiated = neg;
    return neg;
  }

  const driver = {
    protocol,
    capabilities: { browse: false, subscribe: false, maxInFlight: 1 },
    tagErrors,

    async connect() {
      let neg = await openClient();
      let identity;
      if (!identityUnsupported) {
        try {
          identity = await readIdentity();
        } catch {
          // The CPU dropped or ignored SZL reads (socket now destroyed): reconnect without them.
          identityUnsupported = true;
          neg = await openClient();
        }
      }
      return {
        ...(identity && Object.keys(identity).length ? { identity } : {}),
        limits: { pduSize: neg.pduSize, maxAmq: neg.maxAmqCalled },
      };
    },

    isConnected() {
      return Boolean(client && client.isConnected());
    },

    plan(tagKeys) {
      const list = Array.isArray(tagKeys) ? tagKeys.map((k) => tags.get(k)).filter(Boolean) : [...tags.values()];
      return planReads(list, { pduSize: planPdu(), maxGap });
    },

    async execute(request, deadlineMs = limits.requestDeadlineMs) {
      try {
        if (!client || !client.isConnected()) return { ok: false, kind: 'transport', fatal: true, message: 'not connected' };
        if (request.pduSize > negotiated.pduSize) {
          return {
            ok: false,
            kind: 'exception',
            code: 'PLAN_STALE',
            name: 'plan exceeds negotiated PDU',
            classification: 'retry',
            message: `request was planned for PDU ${request.pduSize} but the CPU negotiated ${negotiated.pduSize}; re-plan`,
          };
        }
        const wireResults = [];
        for (const job of request.jobs) {
          let pdu;
          try {
            pdu = await client.request({ type: 'job', func: FUNC.READ_VAR, items: job.items, maxPdu: negotiated.pduSize }, deadlineMs);
          } catch (err) {
            if (err instanceof RangeError || err instanceof S7ReadOnlyError) {
              return { ok: false, kind: 'exception', code: 'INVALID_REQUEST', name: err.name, classification: 'permanent', message: err.message };
            }
            return { ok: false, kind: errorKind(err), fatal: true, message: err.message };
          }
          if (pdu.errorClass || pdu.errorCode) {
            const info = explainHeaderError(pdu.errorClass, pdu.errorCode);
            return { ok: false, kind: 'exception', ...info };
          }
          try {
            wireResults.push(parseReadVarResponse(pdu, job.items));
          } catch (err) {
            client.destroy(err); // a response that does not fit its request: never trust this socket again
            return { ok: false, kind: err instanceof S7MismatchError ? 'mismatch' : 'framing', fatal: true, message: err.message };
          }
        }
        const results = request.items.map((item) => {
          const type = item.sampleType || (TYPES[item.type] && TYPES[item.type].sample);
          const chunks = [];
          for (const p of item.parts) {
            const r = wireResults[p.job][p.wire];
            if (!r.ok) {
              return {
                key: item.key,
                v: null,
                type,
                q: 0,
                qReason: 'device-exception',
                code: r.code,
                message: explainItemCode(r.code, item.area || AREA_NAME[item.areaCode]),
              };
            }
            chunks.push(r.data.subarray(p.offset, p.offset + p.length));
          }
          const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          try {
            const d = decode({ type: item.type, length: item.chars }, bytes, item.bitOffset ?? undefined);
            return { key: item.key, v: d.v, type: d.type, q: 192 };
          } catch (err) {
            return { key: item.key, v: null, type, q: 0, qReason: 'decode', message: err.message };
          }
        });
        return { ok: true, results };
      } catch (err) {
        if (client) client.destroy(err);
        return { ok: false, kind: 'transport', fatal: true, message: `unexpected driver error: ${err.message}` };
      }
    },

    bisect(request) {
      return bisect(request);
    },

    async probe({ address, length } = {}) {
      const a = parseAddress(address);
      if (!client || !client.isConnected()) throw new Error('not connected');
      const max = limitsFor(negotiated.pduSize).maxBlock;
      const def = { X: 1, B: 16, W: 2, D: 4 }[a.size];
      const n = length ?? def;
      if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`probe length must be 1..${max} at the negotiated PDU`);
      const item = { area: a.areaCode, db: a.db, start: a.byteOffset, length: n };
      const pdu = await client.request({ type: 'job', func: FUNC.READ_VAR, items: [item], maxPdu: negotiated.pduSize }, limits.requestDeadlineMs);
      if (pdu.errorClass || pdu.errorCode) throw new S7ExceptionError(explainHeaderError(pdu.errorClass, pdu.errorCode));
      const [r] = parseReadVarResponse(pdu, [item]);
      if (!r.ok) {
        const err = new Error(explainItemCode(r.code, a.area));
        err.code = r.code;
        throw err;
      }
      const decodings = probeDecodings(r.data);
      if (a.size === 'X') decodings.BOOL = ((r.data[0] >> a.bitOffset) & 1) === 1;
      return { address: formatAddress(a), rawHex: r.data.toString('hex'), decodings };
    },

    async close() {
      const c = client;
      if (c) await c.close();
    },
  };
  return driver;
}

module.exports = { protocol, describe, validateTag, createDriver, parseTsap, S7DecodeError };
