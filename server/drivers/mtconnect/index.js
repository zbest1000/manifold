'use strict';

/**
 * MTConnect driver (read-only, HTTP GET). Follows an agent's stream without gaps:
 *
 *   connect      GET /probe   the device model (browse, units, representations)
 *                GET /current the first snapshot, plus instanceId and nextSequence
 *   each poll    GET /sample?from=<nextSequence>&count=N, repeated while the agent has more
 *   resync       an instanceId change (agent restarted), an OUT_OF_RANGE error, a first
 *                sequence beyond our cursor or a sequence that went backwards: GET /current
 *                again (and /probe after a restart) and carry on from its nextSequence
 *
 * No multipart streaming (`interval=`): this driver polls. See NOTES.md.
 *
 * `execute()` returns Bad quality with a reason for anything the agent says (an error document, a
 * malformed answer, UNAVAILABLE); only a lost connection is a fatal transport error.
 */

const { activeSecretFields, HttpClient, HttpError, normalizeConnection, checkRequestPath, DEFAULT_MAX_BYTES } = require('../common/httpClient');
const { urlFields } = require('../common/urlTarget');
const { parseDocument, parseProbe, parseObservations, XmlError } = require('./document');
const { assertAllowedDeviceTarget } = require('../../services/egressGuard');

const protocol = 'mtconnect';

const TYPES = ['number', 'bool', 'string'];
const FIELDS = ['state', 'nativeCode', 'text', 'severity', 'qualifier', 'type'];
const DEFAULT_OPTIONS = { device: '', sampleCount: 1000, maxResponseBytes: 8 * DEFAULT_MAX_BYTES, keepAlive: true };
const DEFAULT_LIMITS = { requestDeadlineMs: 5000, connectTimeoutMs: 8000, interRequestDelayMs: 0 };
const MAX_PAGES = 20;
const TIMEOUTS_BEFORE_OFFLINE = 3;
const ACCEPT = 'application/xml, text/xml;q=0.9, */*;q=0.1';
const SEVERITY = { normal: 0, warning: 1, fault: 2 };

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** An agent-side failure that is not a transport problem: reported as Bad quality, device stays online. */
class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || null;
  }
}

// The URL parts (scheme, path, TLS) with the names every URL driver shares; see common/urlTarget.js.
const URL_FIELDS = urlFields({ schemes: ['http', 'https'], secure: 'https', schemeHelp: 'Agents usually listen on plain http, port 5000.', path: { optional: true, placeholder: '/mtc', help: 'Prefix in front of /probe, /current and /sample, for an agent behind a reverse proxy.' } });

function describe() {
  return {
    protocol,
    label: 'MTConnect',
    readOnly: true,
    experimental: true,
    browseNoun: 'agent',
    defaultPort: 5000,
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    tagTypes: [...TYPES],
    addressForms: ['Xact', 'mill-1/Sspeed'],
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },
    secretFields: ['authPassword', 'authToken', 'authHeaderSecret'],
    deviceFields: [
      URL_FIELDS.scheme,
      URL_FIELDS.path,
      { name: 'authType', label: 'Authentication', type: 'select', default: 'none', options: ['none', 'basic', 'bearer', 'header'], help: 'Most agents have none; use it for an agent behind an authenticating proxy.' },
      { name: 'authUsername', showWhen: { authType: ['basic'] }, label: 'User name', type: 'string', optional: true, help: 'Basic authentication.' },
      { name: 'authPassword', showWhen: { authType: ['basic'] }, label: 'Password', type: 'password', optional: true, help: 'Basic authentication. Leave blank when editing to keep the stored value.' },
      { name: 'authToken', showWhen: { authType: ['bearer'] }, label: 'Bearer token', type: 'password', optional: true, help: 'Leave blank when editing to keep the stored value.' },
      { name: 'authHeaderName', showWhen: { authType: ['header'] }, label: 'Header name', type: 'string', optional: true, placeholder: 'X-Api-Key', help: 'Custom header authentication.' },
      { name: 'authHeaderSecret', showWhen: { authType: ['header'] }, label: 'Header value', type: 'password', optional: true, help: 'Leave blank when editing to keep the stored value.' },
      ...URL_FIELDS.tls
    ],
    optionFields: [
      { name: 'device', label: 'Device (name or uuid)', type: 'string', optional: true, placeholder: 'all devices', help: 'Read one device (/<device>/current) instead of every device the agent serves.' },
      { name: 'sampleCount', label: 'Observations per /sample request', type: 'number', default: 1000, help: 'The agent returns at most this many observations per request; Manifold repeats the request while more are waiting.' },
      { name: 'maxResponseBytes', label: 'Max response size (bytes)', type: 'number', default: DEFAULT_OPTIONS.maxResponseBytes, help: 'Applies to /probe, /current and /sample answers.' },
      { name: 'keepAlive', label: 'Keep connections open', type: 'boolean', default: true, help: 'Reuse one TCP connection between polls.' }
    ],
    addressHelp: 'A data item id from the agent, for example Xact, or device/dataItemId when two devices share ids. Use "Import from device" to pick from /probe.',
    prerequisites:
      'Manifold only sends GET requests to /probe, /current and /sample, and polls /sample; it does not use the streaming (interval) form.\n' +
      'Conditions read as normal, warning or fault; a tag of type number reads them as 0, 1 and 2. Time series and data set items are not supported and read Bad.'
  };
}

// ---- tags -------------------------------------------------------------------

function validateTag(tagDef) {
  const fail = (error) => ({ ok: false, error });
  if (!tagDef || typeof tagDef !== 'object') return fail('tag must be an object');
  const { key, type, address } = tagDef;
  if (typeof key !== 'string' || !key) return fail('key must be a non-empty string');
  if (!TYPES.includes(type)) return fail(`unknown type "${type}" (supported: ${TYPES.join(', ')})`);
  if (typeof address !== 'string' || !address.trim()) return fail('address must be a data item id, or device/dataItemId');
  const parts = address.trim().split('/');
  if (parts.length > 2 || parts.some((p) => !p)) return fail('address must be a data item id, or device/dataItemId');
  if (parts.some((p) => /[\s?#&=\\]/.test(p))) return fail('address must not contain spaces or ? # & = \\');
  const [device, id] = parts.length === 2 ? parts : [undefined, parts[0]];
  if (tagDef.field !== undefined && !FIELDS.includes(tagDef.field)) return fail(`field must be one of ${FIELDS.join(', ')} (conditions only)`);
  return { ok: true, normalized: { key, type, address: address.trim(), device, dataItemId: id, field: tagDef.field, pollGroup: tagDef.pollGroup } };
}

// ---- values -----------------------------------------------------------------

const NUMERIC_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const bad = (tag, qReason) => ({ key: tag.key, v: null, type: tag.type, q: 0, qReason });

function coerceText(text, type) {
  if (type === 'string') return { ok: true, v: text };
  if (type === 'number') {
    const t = text.trim();
    if (NUMERIC_RE.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return { ok: true, v: n };
    }
    return { ok: false, reason: `not-numeric (${JSON.stringify(text.slice(0, 40))})` };
  }
  const w = text.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(w)) return { ok: true, v: true };
  if (['false', '0', 'off', 'no'].includes(w)) return { ok: true, v: false };
  return { ok: false, reason: `not-boolean (${JSON.stringify(text.slice(0, 40))})` };
}

/** The highest-severity active condition, or the normal state. */
function conditionView(entry) {
  let top = null;
  for (const c of entry.active.values()) {
    if (!top || SEVERITY[c.level] > SEVERITY[top.level] || (SEVERITY[c.level] === SEVERITY[top.level] && (c.sequence ?? 0n) > (top.sequence ?? 0n))) top = c;
  }
  return top || { level: 'normal', nativeCode: '', nativeSeverity: '', qualifier: '', text: entry.normalText || '', conditionType: entry.conditionType || '' };
}

function toSample(tag, entry) {
  if (!entry) return bad(tag, 'no-data (the agent has not reported this item yet)');
  if (entry.unavailable) return { ...bad(tag, 'unavailable'), ...(entry.ts !== undefined ? { tSource: entry.ts } : {}) };
  if (entry.representation && entry.representation !== 'VALUE' && entry.representation !== 'DISCRETE') {
    return bad(tag, `unsupported-representation (${entry.representation})`);
  }
  const ts = entry.ts !== undefined ? { tSource: entry.ts } : {};
  if (entry.kind === 'condition') {
    const c = conditionView(entry);
    const field = tag.field || 'state';
    let raw;
    if (field === 'state') {
      if (tag.type === 'number') return { key: tag.key, v: SEVERITY[c.level], type: tag.type, q: 192, ...ts };
      if (tag.type === 'bool') return { key: tag.key, v: c.level !== 'normal', type: tag.type, q: 192, ...ts };
      raw = c.level;
    } else raw = { nativeCode: c.nativeCode, text: c.text, severity: c.nativeSeverity, qualifier: c.qualifier, type: c.conditionType }[field] || '';
    const r = coerceText(String(raw), tag.type);
    return r.ok ? { key: tag.key, v: r.v, type: tag.type, q: 192, ...ts } : bad(tag, r.reason);
  }
  if (tag.field && tag.field !== 'state') return bad(tag, `field "${tag.field}" applies to conditions only`);
  const r = coerceText(entry.value, tag.type);
  return r.ok ? { key: tag.key, v: r.v, type: tag.type, q: 192, ...ts } : bad(tag, r.reason);
}

// ---- device -----------------------------------------------------------------

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const errors = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...DEFAULT_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 5000;
  if (typeof device.host !== 'string' || !device.host.trim()) errors.push('host must be a non-empty string');
  if (!isInt(port, 1, 65535)) errors.push('port must be an integer 1..65535');
  if (options.device !== undefined && options.device !== '' && (typeof options.device !== 'string' || /[\s/?#&\\]/.test(options.device))) {
    errors.push('options.device must be a device name or uuid without spaces or slashes');
  }
  if (!isInt(options.sampleCount, 1, 100000)) errors.push('options.sampleCount must be an integer 1..100000');
  if (!isInt(options.maxResponseBytes, 4096, 256 * 1024 * 1024)) errors.push('options.maxResponseBytes must be an integer 4096..268435456');
  if (typeof options.keepAlive !== 'boolean') errors.push('options.keepAlive must be true or false');
  for (const f of ['requestDeadlineMs', 'connectTimeoutMs']) if (!(limits[f] > 0)) errors.push(`limits.${f} must be a positive number`);
  if (!(limits.interRequestDelayMs >= 0)) errors.push('limits.interRequestDelayMs must be >= 0');
  const conn = normalizeConnection(device);
  errors.push(...conn.errors);
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
    const err = new Error(`invalid mtconnect device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  return { host: device.host.trim(), port, options, limits, conn: conn.value, tags };
}

function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  const prefix = options.device ? `/${encodeURIComponent(options.device)}` : '';
  let client = null;
  let timeouts = 0;
  // stream state
  let model = { devices: [], items: new Map() };
  let instanceId = null;
  let cursor = null; // BigInt: the next sequence to ask for
  let latest = new Map(); // dataItemId -> entry
  let agentVersion = null;
  const stats = { resyncs: 0, gaps: 0, restarts: 0, requests: 0 };

  const makeClient = () =>
    new HttpClient({
      device, host: cfg.host, port: cfg.port, conn: cfg.conn, maxBytes: options.maxResponseBytes, keepAlive: options.keepAlive,
      userAgent: 'manifold-mtconnect', assertTarget: deps.assertTarget || ((h) => assertAllowedDeviceTarget(h))
    });

  const fatal = (kind, message) => ({ ok: false, kind, fatal: true, message });

  /** GET and parse one agent document. Error documents come back as { kind:'error' } whatever the HTTP status. */
  async function fetchDoc(path, deadlineAt) {
    stats.requests++;
    const res = await client.get(path, { deadlineAt, accept: ACCEPT });
    let doc;
    try {
      doc = parseDocument(res.body);
    } catch (e) {
      if (e instanceof XmlError) {
        if (res.status < 200 || res.status >= 300) throw new AgentError(`HTTP ${res.status} from ${path.split('?')[0]}, and the body is not an MTConnect document (${e.message})`);
        throw new AgentError(`malformed XML from ${path.split('?')[0]}: ${e.message}`);
      }
      throw e;
    }
    if (doc.kind === 'error') return doc;
    if (res.status < 200 || res.status >= 300) throw new AgentError(`HTTP ${res.status} from ${path.split('?')[0]}`);
    return doc;
  }

  const errorText = (doc) => doc.errors.map((e) => `${e.code}${e.message ? `: ${e.message}` : ''}`).join('; ') || 'unspecified error';

  async function loadProbe(deadlineAt) {
    const doc = await fetchDoc(`${prefix}/probe`, deadlineAt);
    if (doc.kind === 'error') throw new AgentError(`the agent refused /probe (${errorText(doc)})`, doc.errors[0] && doc.errors[0].code);
    if (doc.kind !== 'devices') throw new AgentError(`/probe did not return MTConnectDevices (got ${doc.root.name})`);
    model = parseProbe(doc.root);
    if (doc.header && doc.header.version) agentVersion = doc.header.version;
    return doc;
  }

  function applyObservations(obs) {
    const ordered = [...obs].sort((a, b) => {
      if (a.sequence === null || b.sequence === null) return 0;
      return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0;
    });
    for (const o of ordered) {
      let e = latest.get(o.id);
      if (!e) {
        e = { kind: o.kind, active: new Map(), sequence: null };
        latest.set(o.id, e);
      }
      if (o.sequence !== null && e.sequence !== null && o.sequence < e.sequence) continue;
      e.kind = o.kind;
      e.sequence = o.sequence ?? e.sequence;
      e.ts = o.timestamp;
      e.representation = o.representation || (model.items.get(o.id) || {}).representation;
      if (o.kind === 'condition') {
        e.conditionType = o.conditionType || e.conditionType;
        if (o.level === 'unavailable') {
          e.unavailable = true;
          e.active.clear();
        } else {
          e.unavailable = false;
          if (o.level === 'normal') {
            if (o.nativeCode) e.active.delete(o.nativeCode);
            else e.active.clear();
            e.normalText = o.value;
          } else {
            e.active.set(o.nativeCode || '', { level: o.level, nativeCode: o.nativeCode, nativeSeverity: o.nativeSeverity, qualifier: o.qualifier, text: o.value, conditionType: o.conditionType, sequence: o.sequence });
          }
        }
      } else {
        e.unavailable = o.value.toUpperCase() === 'UNAVAILABLE';
        e.value = o.value;
      }
    }
  }

  /** Fresh snapshot: replaces everything we know and sets the cursor. */
  async function resync(deadlineAt) {
    const doc = await fetchDoc(`${prefix}/current`, deadlineAt);
    if (doc.kind === 'error') throw new AgentError(`the agent refused /current (${errorText(doc)})`, doc.errors[0] && doc.errors[0].code);
    if (doc.kind !== 'streams' || !doc.header || doc.header.nextSequence === null || doc.header.instanceId === null) {
      throw new AgentError('/current did not return a usable MTConnectStreams header (instanceId, nextSequence)');
    }
    latest = new Map();
    applyObservations(parseObservations(doc.root));
    instanceId = doc.header.instanceId;
    cursor = doc.header.nextSequence;
    stats.resyncs++;
    return doc;
  }

  /** Follow the stream from the cursor. Returns when we are caught up (or the budget is spent). */
  async function pollStream(deadlineAt) {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() >= deadlineAt) return;
      const doc = await fetchDoc(`${prefix}/sample?from=${cursor.toString()}&count=${options.sampleCount}`, deadlineAt);
      if (doc.kind === 'error') {
        if (doc.errors.some((e) => e.code === 'OUT_OF_RANGE')) {
          stats.gaps++;
          await resync(deadlineAt);
          return;
        }
        throw new AgentError(`the agent refused /sample (${errorText(doc)})`, doc.errors[0] && doc.errors[0].code);
      }
      const h = doc.header;
      if (doc.kind !== 'streams' || !h || h.nextSequence === null || h.instanceId === null) throw new AgentError('/sample did not return a usable MTConnectStreams header');
      if (h.instanceId !== instanceId) {
        stats.restarts++;
        await loadProbe(deadlineAt);
        await resync(deadlineAt);
        return;
      }
      if ((h.firstSequence !== null && h.firstSequence > cursor) || h.nextSequence < cursor) {
        // The agent's buffer moved past us, or its counter went backwards: observations were lost.
        stats.gaps++;
        await resync(deadlineAt);
        return;
      }
      applyObservations(parseObservations(doc.root));
      cursor = h.nextSequence;
      if (h.lastSequence === null || cursor > h.lastSequence) return;
    }
  }

  return {
    protocol,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (client) client.close();
      client = makeClient();
      timeouts = 0;
      latest = new Map();
      instanceId = null;
      cursor = null;
      const started = Date.now();
      const deadlineAt = started + limits.connectTimeoutMs;
      const where = `${cfg.conn.scheme}://${cfg.host}:${cfg.port}${cfg.conn.basePath}${prefix}`;
      try {
        const probe = await loadProbe(deadlineAt);
        const cur = await resync(deadlineAt);
        return {
          url: where,
          agentVersion,
          schemaVersion: (probe.header && probe.header.version) || null,
          devices: model.devices.map((d) => d.name),
          dataItems: model.items.size,
          instanceId,
          nextSequence: cursor.toString(),
          bufferSize: cur.header.bufferSize,
          latencyMs: Date.now() - started,
          limits: { sampleCount: options.sampleCount, requestDeadlineMs: limits.requestDeadlineMs, interRequestDelayMs: limits.interRequestDelayMs }
        };
      } catch (e) {
        client.close();
        client = null;
        if (e instanceof HttpError || e instanceof AgentError) throw new Error(`${where}: ${e.message}`);
        throw e;
      }
    },

    isConnected() {
      return client !== null;
    },

    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      for (const k of keys) if (!cfg.tags.has(k)) throw new Error(`unknown tag key "${k}"`);
      // One poll of the stream serves every tag: a single request.
      return keys.length ? [{ id: 'mtconnect-sample', items: keys.map((key) => ({ key })) }] : [];
    },

    async execute(request, deadlineMs) {
      if (!client) return fatal('transport', 'not connected');
      const deadlineAt = Date.now() + (deadlineMs ?? limits.requestDeadlineMs);
      const tags = request.items.map((i) => cfg.tags.get(i.key));
      let failure = null;
      try {
        await pollStream(deadlineAt);
        timeouts = 0;
      } catch (e) {
        if (e instanceof AgentError) {
          timeouts = 0;
          failure = `agent-error (${e.message})`; // the cursor did not move, so the next poll retries the same range
        } else if (e instanceof HttpError) {
          if (e.kind === 'timeout') {
            timeouts++;
            if (timeouts >= TIMEOUTS_BEFORE_OFFLINE) return fatal('timeout', `${timeouts} requests in a row timed out (${e.message})`);
            failure = 'timeout';
          } else if (e.kind === 'too-large' || e.kind === 'redirect' || e.kind === 'encoding') {
            timeouts = 0;
            failure = `${e.kind === 'too-large' ? 'too-large' : e.kind === 'redirect' ? 'redirect-refused' : 'unsupported-encoding'} (${e.message})`;
          } else return fatal(e.kind, e.message);
        } else return fatal('transport', e && e.message ? e.message : String(e));
      }
      if (failure) return { ok: true, results: tags.map((t) => bad(t, failure)) };
      return {
        ok: true,
        results: tags.map((t) => {
          const known = model.items.get(t.dataItemId);
          if (!known && model.items.size) return bad(t, `unknown-data-item (${t.dataItemId} is not in the agent's /probe)`);
          if (t.device && known && t.device !== known.device && t.device !== known.deviceUuid) return bad(t, `unknown-data-item (${t.dataItemId} belongs to device ${known.device}, not ${t.device})`);
          return toSample(t, latest.get(t.dataItemId));
        })
      };
    },

    /** Devices, components and data items from a fresh /probe. */
    async browse(node) {
      if (!client) throw new Error('not connected');
      const deadlineAt = Date.now() + limits.requestDeadlineMs * 3;
      await loadProbe(deadlineAt);
      const asFolder = (c) => ({ id: c.id, name: c.name, kind: 'folder', meta: { hasChildren: c.folders.length > 0 || c.items.length > 0 } });
      const asTag = (it, device) => ({
        id: `item:${it.id}`,
        name: `${it.name || it.id}${it.type ? ` (${it.type}${it.subType ? `.${it.subType}` : ''})` : ''}`,
        kind: 'tag',
        address: model.devices.length > 1 && prefix === '' ? `${device}/${it.id}` : it.id,
        meta: {
          dataType: it.category === 'SAMPLE' ? 'number' : 'string',
          unit: it.unit || undefined,
          category: it.category,
          representation: it.representation,
          description: `${it.category.toLowerCase()} ${it.type}${it.subType ? `.${it.subType}` : ''}${it.units ? `, ${it.units}` : ''}`.trim(),
          accessible: it.representation === 'VALUE' || it.representation === 'DISCRETE',
          reason: it.representation === 'VALUE' || it.representation === 'DISCRETE' ? undefined : `${it.representation} data items are not supported`
        }
      });
      const index = new Map();
      for (const d of model.devices) {
        const walkTree = (c) => {
          index.set(c.id, { children: [...c.folders.map(asFolder), ...c.items.map((i) => asTag(i, d.name))] });
          c.folders.forEach(walkTree);
        };
        walkTree(d.tree);
      }
      if (!node) return model.devices.map((d) => asFolder(d.tree));
      const hit = index.get(String(node));
      if (!hit) throw new Error(`unknown node "${String(node).slice(0, 80)}"`);
      return hit.children;
    },

    /** Describe one data item: its probe entry and the latest observation. */
    async probe({ address } = {}) {
      if (!client) throw new Error('not connected');
      const v = validateTag({ key: 'probe', type: 'string', address });
      if (!v.ok) throw new RangeError(v.error);
      const deadlineAt = Date.now() + limits.requestDeadlineMs * 2;
      await pollStream(deadlineAt);
      const it = model.items.get(v.normalized.dataItemId);
      if (!it) throw new Error(`data item "${v.normalized.dataItemId}" is not in the agent's /probe (${model.items.size} items known)`);
      const e = latest.get(it.id);
      const d = {
        device: it.device, 'component path': it.path, category: it.category, type: `${it.type}${it.subType ? `.${it.subType}` : ''}`, name: it.name || '(none)', units: it.units || '(none)',
        representation: it.representation
      };
      if (e) {
        if (e.kind === 'condition') {
          const c = conditionView(e);
          Object.assign(d, { 'condition state': e.unavailable ? 'unavailable' : c.level, 'native code': c.nativeCode || '(none)', text: c.text || '(none)', 'active conditions': e.active.size });
        } else d.value = e.unavailable ? 'UNAVAILABLE' : e.value;
        if (e.ts !== undefined) d.timestamp = new Date(e.ts).toISOString();
        if (e.sequence !== null) d.sequence = e.sequence.toString();
      } else d.value = '(no observation yet)';
      return { address: v.normalized.address, type: it.category, decodings: d };
    },

    /** Stream state for tests and diagnostics. */
    streamState() {
      return { instanceId, nextSequence: cursor === null ? null : cursor.toString(), ...stats, items: model.items.size };
    },

    async close() {
      const c = client;
      client = null;
      if (c) c.close();
    }
  };
}

module.exports = { protocol, describe, activeSecretFields, validateTag, createDriver, checkRequestPath };
