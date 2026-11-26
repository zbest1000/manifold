'use strict';

/**
 * Read-only SNMP driver (v1, v2c, v3/USM) over UDP. EXPERIMENTAL until
 * verified on real agents — see NOTES.md.
 *
 * Contract: southbound-drivers.md section 4.1 as consumed by the polling
 * runtime (connect / plan / execute / bisect / browse / probe / close).
 * Only Get, GetNext and GetBulk are ever sent (message.js cannot encode
 * anything else).
 *
 * execute() handles the SNMP error statuses itself, because the runtime caches
 * its plan and an agent's answer is per varbind:
 *  - tooBig: the batch is split and the smaller size is remembered for every
 *    later request (a single varbind that is still too big is Bad `tooBig`);
 *  - an error-status with a valid error-index (v1 noSuchName, noAccess, ...):
 *    that varbind is Bad and the rest is asked again; the OID is then skipped
 *    (Bad without asking) and re-tried every minute;
 *  - an error-status without a usable error-index (genErr): the batch is halved
 *    until the failing varbind is isolated;
 *  - v2 exceptions (noSuchObject, noSuchInstance, endOfMibView) are Bad with the reason.
 * Timeouts, unreachable agents and unrecoverable v3 reports are fatal: the
 * runtime reconnects (which for v3 re-runs engine discovery).
 */

const { connectAddress } = require('../runtime/pinnedAddress');
const { SnmpSession } = require('./session');
const msg = require('./message');
const usm = require('./usm');
const oids = require('./oids');
const { TAG_TYPES, ENCODINGS, decodeValue, toSample, displayValue, Q_BAD } = require('./decode');
const { planBatches, splitOids, overhead } = require('./planner');
const { RateTracker } = require('./rate');

const protocol = 'snmp';
const { PDU } = msg;

const VERSIONS = ['1', '2c', '3'];
const DEFAULT_OPTIONS = { maxVarbinds: 20, maxMessageSize: 1400, retries: 1, maxRepetitions: 10, allowAnySource: false, browseMaxRows: 500 };
const DEFAULT_LIMITS = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };
const SKIP_RETRY_MS = 60000;
const BROWSE_HARD_MAX_ROWS = 2000;
const BROWSE_MAX_MS = 8000;
const MIN_PASSWORD = 8;

const LEVEL_OPTIONS = usm.SECURITY_LEVELS;
const AUTH_OPTIONS = Object.keys(usm.AUTH);
const PRIV_OPTIONS = Object.keys(usm.PRIV);

const isV3 = { version: ['3'] };
const isAuth = { version: ['3'], securityLevel: ['authNoPriv', 'authPriv'] };
const isPriv = { version: ['3'], securityLevel: ['authPriv'] };

function describe() {
  return {
    protocol,
    label: 'SNMP',
    browseNoun: 'agent', // walks the agent's MIB
    experimental: true,
    readOnly: true,
    defaultPort: 161,
    transport: 'udp',
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },
    deviceFields: [
      { key: 'version', label: 'SNMP version', type: 'select', default: '2c', options: VERSIONS.map((v) => ({ value: v, label: v === '1' ? 'v1' : v === '2c' ? 'v2c' : 'v3 (USM)' })), help: 'v2c for most devices; v3 when the device requires a user name and passwords.' },
      { key: 'community', label: 'Community', type: 'password', optional: true, showWhen: { version: ['1', '2c'] }, help: 'The read community. Blank means "public" on a new device; on an existing device blank keeps the stored community.' },
      { key: 'securityName', label: 'User name', type: 'string', showWhen: isV3, help: 'The SNMPv3 (USM) user configured on the agent.' },
      { key: 'securityLevel', label: 'Security level', type: 'select', default: 'authPriv', options: LEVEL_OPTIONS, showWhen: isV3, help: 'authPriv signs and encrypts; authNoPriv only signs; noAuthNoPriv does neither.' },
      { key: 'authProtocol', label: 'Authentication', type: 'select', default: 'sha', options: AUTH_OPTIONS.map((a) => ({ value: a, label: a === 'sha' ? 'SHA-1' : a.toUpperCase().replace('SHA', 'SHA-') })), showWhen: isAuth },
      { key: 'authPassword', label: 'Authentication password', type: 'password', optional: true, showWhen: isAuth, help: `At least ${MIN_PASSWORD} characters. On an existing device blank keeps the stored password.` },
      { key: 'privProtocol', label: 'Privacy', type: 'select', default: 'aes', options: PRIV_OPTIONS.map((p) => ({ value: p, label: p === 'aes' ? 'AES-128' : 'DES' })), showWhen: isPriv, help: 'AES-128 (CFB) unless the device only offers DES.' },
      { key: 'privPassword', label: 'Privacy password', type: 'password', optional: true, showWhen: isPriv, help: `At least ${MIN_PASSWORD} characters. On an existing device blank keeps the stored password.` },
      { key: 'contextName', label: 'Context name', type: 'string', optional: true, showWhen: isV3, advanced: true, help: 'Only for agents that serve several contexts (e.g. per-VLAN bridge MIBs). Usually blank.' },
    ],
    optionFields: [
      { key: 'maxVarbinds', label: 'Max OIDs per request', type: 'number', default: 20, min: 1, max: 100, help: 'Lowered automatically when the agent answers tooBig.' },
      { key: 'maxMessageSize', label: 'Max response size (bytes)', type: 'number', default: 1400, min: 484, max: 65507, help: 'Batches are sized so the answer fits. 1400 avoids IP fragmentation; a v3 agent\'s own limit is applied too.' },
      { key: 'retries', label: 'Retries', type: 'number', default: 1, min: 0, max: 5, help: 'UDP has no delivery guarantee: a request is resent this many times within the request deadline.' },
      { key: 'maxRepetitions', label: 'Browse rows per request', type: 'number', default: 10, min: 1, max: 100, help: 'GetBulk max-repetitions when browsing (v2c/v3).' },
      { key: 'allowAnySource', label: 'Accept answers from another address', type: 'boolean', default: false, help: 'Some multi-homed agents answer from a different interface address. Off: only answers from the device address and port are accepted.' },
    ],
    tagTypes: TAG_TYPES,
    tagTypeOptional: true,
    addressHelp: 'Numeric OID (1.3.6.1.2.1.1.3.0) or a known name with its instance: sysUpTime.0, sysName.0, ifInOctets.1, ifHCInOctets.1, ifOperStatus.1, hrProcessorLoad.196608, upsBatteryStatus.0.',
    prerequisites:
      'Enable an SNMP agent on the device with a read-only community (v1/v2c) or a v3 user, and allow this server\'s address in the agent\'s access list. Manifold only sends Get, GetNext and GetBulk.\n' +
      'Use a read-only community or a v3 user with a read-only view: a read-write community would let anything that learns it change the device, even though Manifold never sends Set.\n' +
      'v1 and v2c send the community in clear text on the network. Use v3 with authPriv where the network is not trusted.',
  };
}

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/**
 * @param {object} tag { key, address, type?, encoding?, rate?, pollGroup? }
 * @returns {{ok:true, normalized:object}|{ok:false, error:string}}
 */
function validateTag(tag) {
  const fail = (error) => ({ ok: false, error });
  if (!tag || typeof tag !== 'object') return fail('tag must be an object');
  if (typeof tag.key !== 'string' || !tag.key) return fail('key must be a non-empty string');
  let resolved;
  try {
    resolved = oids.resolveAddress(tag.address);
  } catch (err) {
    return fail(err.message);
  }
  let type;
  if (tag.type !== undefined && tag.type !== null && tag.type !== '') {
    type = TAG_TYPES.find((t) => t.toLowerCase() === String(tag.type).toLowerCase());
    if (!type) return fail(`unknown type "${tag.type}" (supported: ${TAG_TYPES.join(', ')}, or blank to accept what the agent returns)`);
  }
  if (tag.encoding !== undefined && tag.encoding !== null && tag.encoding !== '' && !ENCODINGS.includes(tag.encoding)) {
    return fail(`encoding must be one of ${ENCODINGS.join(', ')}`);
  }
  if (tag.rate !== undefined && tag.rate !== null && typeof tag.rate !== 'boolean') return fail('rate must be true or false');
  for (const f of ['scale', 'offset']) {
    if (tag[f] !== undefined && tag[f] !== null && tag[f] !== '' && !Number.isFinite(tag[f])) return fail(`${f} must be a finite number`);
  }
  if (tag.rate && type && type !== 'Counter32' && type !== 'Counter64') return fail(`rate needs a counter (Counter32 or Counter64), not ${type}`);
  if (tag.rate && !type && resolved.kind && resolved.kind !== 'Counter32' && resolved.kind !== 'Counter64') {
    return fail(`rate needs a counter; ${resolved.name.split('.')[0]} is ${resolved.kind}`);
  }
  const normalized = { key: tag.key, address: String(tag.address).trim(), oid: resolved.oid };
  if (resolved.name) normalized.name = resolved.name;
  if (type) normalized.type = type;
  if (tag.encoding) normalized.encoding = tag.encoding;
  if (tag.rate) normalized.rate = true;
  if (Number.isFinite(tag.scale)) normalized.scale = tag.scale;
  if (Number.isFinite(tag.offset)) normalized.valueOffset = tag.offset;
  if (tag.pollGroup !== undefined) normalized.pollGroup = tag.pollGroup;
  normalized.kind = type || resolved.kind || undefined;
  return { ok: true, normalized };
}

function hexBuffer(text, what, errors) {
  if (text === undefined || text === null || text === '') return null;
  const s = String(text).replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (!/^([0-9a-f]{2}){5,32}$/i.test(s)) {
    errors.push(`${what} must be 5-32 bytes of hex`);
    return null;
  }
  return Buffer.from(s, 'hex');
}

/** The credentials this device's settings use; the device manager drops any other stored one. */
function activeSecretFields(device) {
  const version = String((device && device.version) || '2c').toLowerCase().replace(/^v/, '');
  if (version !== '3') return ['community'];
  const level = device.securityLevel || 'authPriv';
  return level === 'authPriv' ? ['authPassword', 'privPassword'] : level === 'authNoPriv' ? ['authPassword'] : [];
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const errors = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...DEFAULT_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 161;
  const version = device.version === undefined || device.version === null || device.version === '' ? '2c' : String(device.version).toLowerCase().replace(/^v/, '').replace(/^2$/, '2c');
  if (typeof device.host !== 'string' || !device.host.trim()) errors.push('host must be a non-empty string');
  if (!isIntIn(port, 1, 65535)) errors.push('port must be an integer 1..65535');
  if (!VERSIONS.includes(version)) errors.push('version must be 1, 2c or 3');
  if (!isIntIn(options.maxVarbinds, 1, 100)) errors.push('options.maxVarbinds must be an integer 1..100');
  if (!isIntIn(options.maxMessageSize, 484, 65507)) errors.push('options.maxMessageSize must be an integer 484..65507');
  if (!isIntIn(options.retries, 0, 5)) errors.push('options.retries must be an integer 0..5');
  if (!isIntIn(options.maxRepetitions, 1, 100)) errors.push('options.maxRepetitions must be an integer 1..100');
  if (!isIntIn(options.browseMaxRows, 1, BROWSE_HARD_MAX_ROWS)) errors.push(`options.browseMaxRows must be an integer 1..${BROWSE_HARD_MAX_ROWS}`);
  if (typeof options.allowAnySource !== 'boolean') errors.push('options.allowAnySource must be true or false');
  for (const f of ['requestDeadlineMs', 'connectTimeoutMs']) if (!(limits[f] > 0)) errors.push(`limits.${f} must be a positive number`);

  let community = null;
  let v3 = null;
  if (version === '3') {
    const user = typeof device.securityName === 'string' ? device.securityName : '';
    const level = device.securityLevel || 'authPriv';
    const authProtocol = device.authProtocol || 'sha';
    const privProtocol = device.privProtocol || 'aes';
    if (!user || user.length > 32) errors.push('securityName (user name) is required for v3, at most 32 characters');
    if (!LEVEL_OPTIONS.includes(level)) errors.push(`securityLevel must be one of ${LEVEL_OPTIONS.join(', ')}`);
    if (level !== 'noAuthNoPriv') {
      if (!usm.AUTH[authProtocol]) errors.push(`authProtocol must be one of ${AUTH_OPTIONS.join(', ')}`);
      if (typeof device.authPassword !== 'string' || device.authPassword.length < MIN_PASSWORD) errors.push(`the authentication password must be at least ${MIN_PASSWORD} characters`);
    }
    if (level === 'authPriv') {
      if (!usm.PRIV[privProtocol]) errors.push(`privProtocol must be one of ${PRIV_OPTIONS.join(', ')}`);
      if (typeof device.privPassword !== 'string' || device.privPassword.length < MIN_PASSWORD) errors.push(`the privacy password must be at least ${MIN_PASSWORD} characters`);
    }
    if (device.contextName !== undefined && device.contextName !== null && (typeof device.contextName !== 'string' || device.contextName.length > 32)) {
      errors.push('contextName must be a string of at most 32 characters');
    }
    const contextEngineId = hexBuffer(device.contextEngineId, 'contextEngineId', errors);
    v3 = { user, level, authProtocol, authPassword: device.authPassword, privProtocol, privPassword: device.privPassword, contextName: device.contextName || '', contextEngineId };
  } else {
    community = device.community === undefined || device.community === null || device.community === '' ? 'public' : device.community;
    if (typeof community !== 'string' || Buffer.byteLength(community) > 255) errors.push('community must be a string of at most 255 bytes');
  }

  const tags = new Map();
  const details = errors.map((error) => ({ key: null, error }));
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
    const err = new Error(`invalid snmp device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  const host = device.host.trim();
  return { host, connectHost: connectAddress({ ...device, host }), port, version, community, v3, options, limits, tags };
}

const fatal = (res) => ({ ok: false, kind: res.kind === 'timeout' ? 'timeout' : 'transport', fatal: true, message: res.message });

/**
 * @param {object} device
 * @param {{createSocket?:Function, isAllowed?:Function}} [deps]
 */
function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  let session = null;
  let connected = false;
  let learnedMaxVarbinds = options.maxVarbinds;
  const learnedSizes = new Map(); // oid -> value content length
  const skip = new Map(); // oid -> { qReason, message, until }
  const rates = new RateTracker();

  const maxBytes = () => {
    const agent = session && session.agentMaxSize();
    return agent ? Math.min(options.maxMessageSize, agent) : options.maxMessageSize;
  };
  const overheadBytes = () =>
    overhead({ version: cfg.version, communityLength: cfg.community ? Buffer.byteLength(cfg.community) : 0, authLength: cfg.v3 && cfg.v3.level !== 'noAuthNoPriv' ? usm.AUTH[cfg.v3.authProtocol].macLength : 0 });

  function newSession() {
    return new SnmpSession(
      { version: cfg.version, community: cfg.community, v3: cfg.v3, address: cfg.connectHost, port: cfg.port, displayHost: cfg.host, allowAnySource: options.allowAnySource, msgMaxSize: 65507 },
      deps
    );
  }

  function keysByOid(keys) {
    const m = new Map();
    for (const k of keys) {
      const t = cfg.tags.get(k);
      if (!t) continue;
      if (!m.has(t.oid)) m.set(t.oid, []);
      m.get(t.oid).push(t);
    }
    return m;
  }

  /** Tags reading a prefix OID (sysUpTime when rate tags exist) ride only on the batch with `withPrefixTags`. */
  function toRequest(oidList, prefixCount, keys, withPrefixTags = true) {
    const want = new Set(withPrefixTags ? oidList : oidList.slice(prefixCount));
    const items = keys.filter((k) => want.has(cfg.tags.get(k).oid)).map((k) => ({ key: k }));
    return { id: `snmp:${oidList.join(',')}`, oids: oidList, prefixCount, items };
  }

  /** One Get with internal tooBig / error-index / genErr handling. Fills `answers` (oid -> varbind) and `errors` (oid -> {qReason,message}). */
  async function getInto(list, prefixCount, until, answers, errors, ctx) {
    if (!list.length) return null;
    // Respect the size learned from an earlier tooBig.
    if (list.length - prefixCount > Math.max(1, learnedMaxVarbinds - prefixCount) && list.length > 1) {
      const per = Math.max(1, learnedMaxVarbinds - prefixCount);
      const body = list.slice(prefixCount);
      for (let i = 0; i < body.length; i += per) {
        const r = await getInto([...list.slice(0, prefixCount), ...body.slice(i, i + per)], prefixCount, until, answers, errors, ctx);
        if (r) return r;
      }
      return null;
    }
    const left = until - Date.now();
    if (left <= 0) {
      for (const oid of list) if (!answers.has(oid) && !errors.has(oid)) errors.set(oid, { qReason: 'deadline', message: 'request deadline passed while splitting the batch' });
      return null;
    }
    const res = await session.request(PDU.GET, list, { deadlineMs: left, retries: options.retries });
    if (!res.ok) return fatal(res);
    const pdu = res.pdu;
    if (pdu.errorStatus === 0) {
      if (pdu.varbinds.length !== list.length) {
        return { ok: false, kind: 'framing', fatal: true, message: `the agent answered ${pdu.varbinds.length} varbinds for ${list.length} requested` };
      }
      ctx.largestOk = Math.max(ctx.largestOk, list.length);
      list.forEach((oid, i) => {
        const vb = pdu.varbinds[i];
        if (vb.oid !== oid) errors.set(oid, { qReason: 'oid-mismatch', message: `the agent answered ${vb.oid} for ${oid}` });
        else answers.set(oid, vb);
      });
      return null;
    }
    const status = msg.errorStatusName(pdu.errorStatus);
    if (pdu.errorStatus === 1) {
      // tooBig: halve; the largest batch that then fits is remembered (readKeys).
      ctx.tooBig = true;
      if (list.length - prefixCount <= 1) {
        if (prefixCount && list.length > 1) return getInto(list.slice(prefixCount), 0, until, answers, errors, ctx);
        const oid = list[list.length - 1];
        const reason = { qReason: 'tooBig', message: 'the value does not fit in one response from this agent' };
        errors.set(oid, reason);
        skip.set(oid, { ...reason, until: Date.now() + SKIP_RETRY_MS });
        return null;
      }
      const halves = splitOids(list, prefixCount);
      for (const h of halves) {
        const r = await getInto(h, prefixCount, until, answers, errors, ctx);
        if (r) return r;
      }
      return null;
    }
    const idx = pdu.errorIndex;
    if (idx >= 1 && idx <= list.length) {
      const bad = list[idx - 1];
      const reason = { qReason: status, message: `${status} for ${bad}${pdu.errorStatus === 2 ? ' (the agent does not have this object)' : ''}` };
      errors.set(bad, reason);
      if (idx - 1 >= prefixCount) skip.set(bad, { ...reason, until: Date.now() + SKIP_RETRY_MS });
      const rest = list.filter((_, i) => i !== idx - 1);
      return getInto(rest, idx - 1 < prefixCount ? prefixCount - 1 : prefixCount, until, answers, errors, ctx);
    }
    // No usable error-index (genErr and friends): isolate by halving.
    const halves = splitOids(list, prefixCount);
    if (!halves) {
      const oid = list[list.length - 1];
      errors.set(oid, { qReason: status, message: `${status} from the agent for ${oid}` });
      return null;
    }
    for (const h of halves) {
      const r = await getInto(h, prefixCount, until, answers, errors, ctx);
      if (r) return r;
    }
    return null;
  }

  /** scale/offset on numeric samples (UPS-MIB tenths, ENTITY-SENSOR precision, ...). */
  function scaled(tag, sample) {
    if (sample.q !== 192 || (tag.scale === undefined && tag.valueOffset === undefined)) return sample;
    const n = typeof sample.v === 'number' ? sample.v : typeof sample.v === 'string' && /^-?\d+$/.test(sample.v) && ['uint64', 'int64'].includes(sample.type) ? Number(sample.v) : null;
    if (n === null) return sample;
    return { ...sample, v: n * (tag.scale ?? 1) + (tag.valueOffset ?? 0), type: 'float64' };
  }

  function sampleFor(tag, vb, upTime, now) {
    return scaled(tag, rawSampleFor(tag, vb, upTime, now));
  }

  function rawSampleFor(tag, vb, upTime, now) {
    let decoded;
    try {
      decoded = decodeValue(vb.tag, vb.value);
    } catch (err) {
      return { key: tag.key, v: null, type: 'unknown', q: Q_BAD, qReason: 'decode' };
    }
    learnedSizes.set(tag.oid, vb.value.length);
    if (tag.rate) {
      if (decoded.exception) {
        const s = toSample(decoded, {});
        return { key: tag.key, v: null, type: 'float64', q: Q_BAD, qReason: s.qReason };
      }
      const r = rates.update(tag.key, decoded.type, decoded.value, upTime, now);
      return { key: tag.key, v: r.v, type: 'float64', q: r.q, ...(r.qReason ? { qReason: r.qReason } : {}) };
    }
    const s = toSample(decoded, tag);
    return { key: tag.key, v: s.v, type: s.type, q: s.q, ...(s.qReason ? { qReason: s.qReason } : {}) };
  }

  async function readKeys(oidList, prefixCount, keys, deadlineMs) {
    const until = Date.now() + deadlineMs;
    const now = Date.now();
    const answers = new Map();
    const errors = new Map();
    const ask = [];
    oidList.forEach((oid, i) => {
      const s = i >= prefixCount ? skip.get(oid) : null;
      if (s && s.until > now) errors.set(oid, s);
      else {
        if (s) skip.delete(oid);
        ask.push(oid);
      }
    });
    const askPrefix = Math.min(prefixCount, ask.filter((o) => oidList.indexOf(o) < prefixCount).length);
    const ctx = { tooBig: false, largestOk: 0 };
    const failed = ask.length > askPrefix ? await getInto(ask, askPrefix, until, answers, errors, ctx) : null;
    if (ctx.tooBig && ctx.largestOk > 0) learnedMaxVarbinds = Math.max(1, Math.min(learnedMaxVarbinds, ctx.largestOk));
    if (failed) return failed;
    let upTime = null;
    if (prefixCount) {
      const vb = answers.get(oids.SYS_UPTIME);
      if (vb && vb.tag === 0x43) upTime = Number(decodeValue(vb.tag, vb.value).value);
    }
    const byOid = keysByOid(keys);
    const results = [];
    for (const [oid, tags] of byOid) {
      for (const tag of tags) {
        const vb = answers.get(oid);
        if (vb) results.push(sampleFor(tag, vb, upTime, Date.now()));
        else {
          const e = errors.get(oid) || { qReason: 'no-answer' };
          results.push({ key: tag.key, v: null, type: tag.rate ? 'float64' : 'unknown', q: Q_BAD, qReason: e.qReason });
        }
      }
    }
    return { ok: true, results };
  }

  async function walk(root, after, { maxRows, maxMs }) {
    const started = Date.now();
    const rows = [];
    let cursor = after || root;
    let reps = options.maxRepetitions;
    let truncated = false;
    let note = null;
    const v1 = cfg.version === '1';
    for (;;) {
      if (rows.length >= maxRows || Date.now() - started > maxMs) {
        truncated = true;
        break;
      }
      const left = Math.min(limits.requestDeadlineMs, maxMs - (Date.now() - started));
      if (left <= 0) {
        truncated = true;
        break;
      }
      const res = v1
        ? await session.request(PDU.GET_NEXT, [cursor], { deadlineMs: left, retries: options.retries })
        : await session.request(PDU.GET_BULK, [cursor], { deadlineMs: left, retries: options.retries, nonRepeaters: 0, maxRepetitions: Math.min(reps, maxRows - rows.length) });
      if (!res.ok) {
        if (res.kind === 'timeout' && rows.length) {
          note = `stopped: ${res.message}`;
          truncated = true;
          break;
        }
        throw new Error(res.message);
      }
      const pdu = res.pdu;
      if (pdu.errorStatus === 1 && !v1 && reps > 1) {
        reps = Math.max(1, Math.floor(reps / 2));
        continue;
      }
      if (pdu.errorStatus === 2 && v1) break; // v1 end of MIB view
      if (pdu.errorStatus !== 0) throw new Error(`the agent answered ${msg.errorStatusName(pdu.errorStatus)} while walking ${root}`);
      if (!pdu.varbinds.length) break;
      let end = false;
      for (const vb of pdu.varbinds) {
        if (vb.tag === 0x82 || !oids.isUnder(vb.oid, root)) {
          end = true;
          break;
        }
        if (oids.compareOids(vb.oid, cursor) <= 0) {
          note = `stopped: the agent returned ${vb.oid}, which does not follow ${cursor} (agent bug)`;
          end = true;
          break;
        }
        rows.push(vb);
        cursor = vb.oid;
        if (rows.length >= maxRows) break;
      }
      if (end) break;
    }
    return { rows, truncated, last: cursor, note };
  }

  function browseNode(vb) {
    let decoded = null;
    try {
      decoded = decodeValue(vb.tag, vb.value);
    } catch {
      /* shown without a value */
    }
    const named = oids.nameOf(vb.oid);
    let value = decoded ? displayValue(decoded) : null;
    if (typeof value === 'string' && value.length > 80) value = `${value.slice(0, 77)}...`;
    const dataType = decoded && TAG_TYPES.includes(decoded.type) ? decoded.type : undefined;
    return {
      id: `oid:${vb.oid}`,
      name: named ? `${named.text}${value !== null && value !== undefined ? ` = ${value}` : ''}` : `${vb.oid}${value !== null && value !== undefined ? ` = ${value}` : ''}`,
      kind: 'tag',
      address: named ? named.text : vb.oid,
      meta: { oid: vb.oid, dataType, value, accessible: true },
    };
  }

  return {
    protocol,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (session) session.close();
      connected = false;
      session = newSession();
      await session.open();
      const until = Date.now() + limits.connectTimeoutMs;
      if (cfg.version === '3') {
        const d = await session.discover(limits.connectTimeoutMs, options.retries);
        if (!d.ok) {
          session.close();
          throw new Error(d.message);
        }
      }
      const ids = [oids.SYS_DESCR, oids.SYS_OBJECT_ID, oids.SYS_UPTIME, oids.SYS_NAME];
      let res = await session.request(PDU.GET, ids, { deadlineMs: Math.max(100, until - Date.now()), retries: options.retries });
      // v1 agents answer noSuchName for the whole PDU when one object is missing: retry with sysUpTime alone.
      if (res.ok && res.pdu.errorStatus !== 0) res = await session.request(PDU.GET, [oids.SYS_UPTIME], { deadlineMs: Math.max(100, until - Date.now()), retries: options.retries });
      if (!res.ok) {
        session.close();
        const hint = res.kind === 'timeout' && cfg.version !== '3' ? ' Check the community, the agent\'s access list (does it allow this server?) and that UDP port is not filtered: an agent drops requests with a wrong community silently.' : '';
        throw new Error(`${res.message}.${hint}`);
      }
      const info = { version: cfg.version === '3' ? `v3 ${cfg.v3.level}` : `v${cfg.version}` };
      if (res.pdu.errorStatus === 0) {
        for (const vb of res.pdu.varbinds) {
          let d;
          try {
            d = decodeValue(vb.tag, vb.value);
          } catch {
            continue;
          }
          if (d.exception) continue;
          const v = displayValue(d);
          if (vb.oid === oids.SYS_DESCR) info.sysDescr = String(v).slice(0, 200);
          if (vb.oid === oids.SYS_OBJECT_ID) info.sysObjectID = v;
          if (vb.oid === oids.SYS_NAME) info.sysName = String(v).slice(0, 100);
          if (vb.oid === oids.SYS_UPTIME) info.uptime = formatTicks(v);
        }
      }
      if (session.engine) {
        info.engineId = session.engine.id.toString('hex');
        info.engineBoots = session.engine.boots;
      }
      connected = true;
      return {
        ...info,
        limits: { maxVarbinds: options.maxVarbinds, maxMessageSize: maxBytes(), requestDeadlineMs: limits.requestDeadlineMs },
      };
    },

    isConnected() {
      return connected && !!session && session.isOpen();
    },

    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      for (const k of keys) if (!cfg.tags.has(k)) throw new Error(`unknown tag key "${k}"`);
      const prefix = keys.some((k) => cfg.tags.get(k).rate) ? [oids.SYS_UPTIME] : [];
      const items = [...keysByOid(keys).keys()].map((oid) => ({ oid, kind: keysByOid(keys).get(oid)[0].kind }));
      const batches = planBatches(items, { maxVarbinds: learnedMaxVarbinds, maxBytes: maxBytes(), overheadBytes: overheadBytes(), learned: learnedSizes, prefix });
      return batches.map((list, i) => toRequest(list, prefix.length && list[0] === prefix[0] ? prefix.length : 0, keys, i === 0));
    },

    async execute(request, deadlineMs) {
      if (!this.isConnected()) return { ok: false, kind: 'transport', fatal: true, message: 'not connected' };
      return readKeys(request.oids, request.prefixCount || 0, request.items.map((i) => i.key), deadlineMs ?? limits.requestDeadlineMs);
    },

    bisect(request) {
      const halves = splitOids(request.oids, request.prefixCount || 0);
      const keys = request.items.map((i) => i.key);
      const pc = request.prefixCount || 0;
      const prefixTagged = pc > 0 && request.items.some((i) => request.oids.slice(0, pc).includes(cfg.tags.get(i.key).oid));
      return halves && halves.map((h, i) => toRequest(h, pc, keys, prefixTagged && i === 0));
    },

    async probe({ address } = {}) {
      if (!this.isConnected()) throw new Error('not connected');
      const resolved = oids.resolveAddress(address);
      const res = await session.request(PDU.GET, [resolved.oid], { deadlineMs: limits.requestDeadlineMs, retries: options.retries });
      if (!res.ok) throw new Error(`probe failed: ${res.message}`);
      const pdu = res.pdu;
      if (pdu.errorStatus !== 0) throw new Error(`probe failed: ${msg.errorStatusName(pdu.errorStatus)} for ${resolved.oid}`);
      const vb = pdu.varbinds[0];
      if (!vb) throw new Error('probe failed: empty response');
      const decodings = {};
      let type = null;
      try {
        const d = decodeValue(vb.tag, vb.value);
        type = d.type;
        if (d.exception) decodings.exception = d.exception;
        else {
          decodings.value = displayValue(d);
          if (d.type === 'OctetString') {
            decodings.text = vb.value.toString('utf8');
            decodings.hex = vb.value.toString('hex');
          }
          if (d.type === 'TimeTicks') decodings.duration = formatTicks(d.value);
        }
      } catch (err) {
        decodings.valueError = err.message;
      }
      return { address: resolved.name || resolved.oid, oid: vb.oid, type, rawHex: vb.value.toString('hex'), decodings };
    },

    async browse(node) {
      if (!this.isConnected()) throw new Error('not connected');
      if (!node) {
        return oids.BROWSE_ROOTS.map((r) => ({ id: `walk:${r.oid}`, name: `${r.name} (${r.oid})`, kind: 'folder', address: r.oid, meta: { oid: r.oid, hasChildren: true } }));
      }
      const m = /^walk:([\d.]+)(?:@([\d.]+))?$/.exec(String(node));
      if (!m) throw new Error(`unknown browse node "${node}"; expand a folder or use walk:<oid>`);
      const root = oids.resolveAddress(m[1]).oid;
      const after = m[2] ? oids.resolveAddress(m[2]).oid : null;
      if (after && !oids.isUnder(after, root)) throw new Error('the continuation OID is outside the subtree');
      const maxMs = Math.min(BROWSE_MAX_MS, limits.requestDeadlineMs * 3);
      const r = await walk(root, after, { maxRows: Math.min(options.browseMaxRows, BROWSE_HARD_MAX_ROWS), maxMs });
      const out = r.rows.map(browseNode);
      if (r.truncated) {
        out.push({ id: `walk:${root}@${r.last}`, name: `More: continue after ${r.last}${r.note ? ` (${r.note})` : ''}`, kind: 'folder', address: `${root}@${r.last}`, meta: { hasChildren: true, continuation: true } });
      } else if (r.note) {
        out.push({ id: `note:${root}`, name: r.note, kind: 'folder', address: `note:${root}`, meta: { hasChildren: false } });
      }
      return out;
    },

    async close() {
      connected = false;
      const s = session;
      session = null;
      if (s) s.close();
    },

    /** Test hook: what the planner currently uses. */
    _state() {
      return { learnedMaxVarbinds, skipped: [...skip.keys()], session };
    },
  };
}

function formatTicks(ticks) {
  const t = Number(ticks);
  if (!Number.isFinite(t)) return String(ticks);
  const s = Math.floor(t / 100);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m ${s % 60}s`;
}

module.exports = { protocol, describe, activeSecretFields, validateTag, createDriver, normalizeDevice, DEFAULT_OPTIONS };
