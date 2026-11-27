'use strict';

/**
 * Read-only CoAP (UDP, RFC 7252) driver for constrained devices and sensors.
 * EXPERIMENTAL until verified on real hardware: see NOTES.md.
 *
 * Contract: docs/design/driver-contract.md as consumed by the polling runtime
 * (plan / execute / bisect / browse / probe). The only request this driver can
 * send is GET (a CoAP ping at connect time is an empty message).
 *
 * `execute()` never throws for device or transport problems; it returns
 *   { ok:true, results:[{key, v, type, q, qReason?}] }       (also when the device answers 4.xx / 5.xx: those tags are Bad)
 *   { ok:false, kind:'timeout'|'transport'|'closed', fatal:true, message }   nothing answered: the runtime reconnects
 */

const { connectAddress } = require('../runtime/pinnedAddress');
const { CoapUdpSocket } = require('./coapUdp');
const { CoapClient } = require('./client');
const { parseAddress, formatAddress, AddressError, COAPS_MESSAGE } = require('./address');
const { codeClass } = require('./message');
const linkformat = require('./linkformat');
const selector = require('./selector');
const value = require('./value');

const protocol = 'coap';

const TAG_TYPES = ['number', 'bool', 'string'];
const ACCEPT_NAMES = ['none', 'text/plain', 'application/json', 'application/cbor', 'application/senml+json', 'application/senml+cbor'];
const DEFAULT_OPTIONS = {
  ackTimeoutMs: 2000,
  maxRetransmit: 4,
  nstart: 1,
  blockSize: 1024,
  maxResponseBytes: 262144,
  observeGraceMs: 5000,
  accept: 'none',
  connectCheck: 'ping'
};
// What new CoAP devices are created with (advertised in describe(); a retransmission needs seconds).
const DEFAULT_LIMITS = { requestDeadlineMs: 10000, connectTimeoutMs: 8000, interRequestDelayMs: 0 };
// What the runtime assumes when a stored device has no limits: the driver's own deadlines (probe, browse) must match it.
const RUNTIME_LIMITS = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };
const WELL_KNOWN = ['.well-known', 'core'];
const MAX_BROWSE_CHILDREN = 200;

const isIntIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function describe() {
  return {
    protocol,
    label: 'CoAP (UDP)',
    browseNoun: 'device', // the device's /.well-known/core listing
    experimental: true,
    readOnly: true,
    defaultPort: 5683,
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },
    deviceFields: [],
    optionFields: [
      { name: 'connectCheck', label: 'Check on connect', type: 'select', default: 'ping', options: ['ping', 'none'], help: 'ping sends one CoAP ping (an empty confirmable message) so Test connection and Online mean the device answered. Choose none for a device that ignores pings.' },
      { name: 'accept', label: 'Preferred content format', type: 'select', default: 'none', options: ACCEPT_NAMES, help: 'Sent as the Accept option. none lets the device choose. Use it when a device serves the same resource as text and as JSON, CBOR or SenML.' },
      { name: 'observeGraceMs', label: 'Observe re-register grace (ms)', type: 'number', default: 5000, advanced: true, help: 'After an observed value passes its Max-Age without a notification, wait this long, then register again.' },
      { name: 'ackTimeoutMs', label: 'ACK timeout (ms)', type: 'number', default: 2000, advanced: true, help: 'RFC 7252 ACK_TIMEOUT. The first retransmission waits 1 to 1.5 times this long, then the wait doubles. Raise "Request deadline" so the retransmissions fit inside it.' },
      { name: 'maxRetransmit', label: 'Retransmissions', type: 'number', default: 4, advanced: true, help: 'RFC 7252 MAX_RETRANSMIT (0 to 8).' },
      { name: 'nstart', label: 'Requests in flight', type: 'number', default: 1, advanced: true, help: 'RFC 7252 NSTART: simultaneous outstanding requests to this device. Keep 1 for constrained devices.' },
      { name: 'blockSize', label: 'Block size (bytes)', type: 'select', default: 1024, options: [16, 32, 64, 128, 256, 512, 1024], advanced: true, help: 'The block size proposed for large responses (RFC 7959). The device may choose a smaller one.' },
      { name: 'maxResponseBytes', label: 'Max response size (bytes)', type: 'number', default: 262144, advanced: true, help: 'A response larger than this is abandoned.' }
    ],
    tagTypes: [...TAG_TYPES],
    tagTypeOptional: true,
    addressHelp:
      '/sensors/temp, /sensors/temp?unit=c, /readings#temperature.value (path into JSON or CBOR), /senml#urn:dev:abc/temp (SenML record name). ' +
      'Start with observe: to subscribe instead of poll. The type is optional: numbers, booleans and text are recognised from the response.',
    prerequisites:
      'CoAP over UDP on port 5683, unauthenticated and unencrypted. CoAP over DTLS (coaps://, port 5684) is not supported.\n' +
      'Manifold only sends GET requests (and one empty ping message when the device is added); no resource is ever written. Restrict the network path as well where a hard guarantee is required.\n' +
      'Raise "Request deadline" to 10 s or more for devices on lossy low-power links: CoAP retransmits after 2 to 3 seconds. A device that sends no answer at all is shown offline.'
  };
}

/** Host field check (before the generic host rules): schemes get a specific message, DTLS a clear refusal. */
function checkHost(host) {
  const h = String(host ?? '').trim();
  if (/^coaps(\+\w+)?:\/\//i.test(h)) return COAPS_MESSAGE;
  if (/^coap(\+\w+)?:\/\//i.test(h)) return 'enter the device host name or IP address only; the port goes in its own field and resource paths in each tag address';
  return null;
}

function acceptNumber(v) {
  if (v === undefined || v === null || v === '' || v === 'none') return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535) return v;
  if (typeof v === 'string' && /^\d{1,5}$/.test(v)) return Number(v);
  if (typeof v === 'string' && Object.hasOwn(value.CF_BY_NAME, v)) return value.CF_BY_NAME[v];
  throw new Error(`accept must be one of: ${ACCEPT_NAMES.join(', ')}`);
}

/**
 * Validate one tag.
 * @returns {{ok:true, normalized:object}|{ok:false, error:string}}
 */
function validateTag(tagDef, _deviceOptions = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!tagDef || typeof tagDef !== 'object') return fail('tag must be an object');
  const { key } = tagDef;
  if (typeof key !== 'string' || !key) return fail('key must be a non-empty string');
  let addr;
  try {
    addr = parseAddress(tagDef.address);
  } catch (err) {
    return fail(err.message);
  }
  if (tagDef.observe !== undefined && typeof tagDef.observe !== 'boolean') return fail('observe must be true or false');
  const observe = addr.observe || tagDef.observe === true;
  let type;
  if (tagDef.type !== undefined && tagDef.type !== null && tagDef.type !== '') {
    type = value.normalizeType(tagDef.type);
    if (!type) return fail(`unknown type "${tagDef.type}" (supported: ${TAG_TYPES.join(', ')}; leave it empty to detect)`);
  }
  for (const f of ['scale', 'offset']) {
    if (tagDef[f] !== undefined && !Number.isFinite(tagDef[f])) return fail(`${f} must be a finite number`);
    if (tagDef[f] !== undefined && (type === 'bool' || type === 'string')) return fail(`${f} only applies to number tags`);
  }
  let accept;
  try {
    accept = acceptNumber(tagDef.accept);
  } catch (err) {
    return fail(err.message);
  }
  const normalized = {
    key,
    address: formatAddress({ ...addr, observe }),
    path: addr.path,
    segments: addr.segments,
    query: addr.query,
    uri: addr.uri,
    observe,
    selector: addr.selector,
    type,
    scale: tagDef.scale,
    valueOffset: tagDef.offset,
    accept,
    pollGroup: tagDef.pollGroup
  };
  return { ok: true, normalized };
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const hostProblem = checkHost(device.host);
  if (hostProblem) throw Object.assign(new Error(hostProblem), { details: [{ key: null, error: hostProblem }] });
  const errors = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...RUNTIME_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 5683;
  if (typeof device.host !== 'string' || !device.host.trim()) errors.push('host must be a non-empty string');
  if (!isIntIn(port, 1, 65535)) errors.push('port must be an integer 1..65535');
  if (port === 5684) errors.push('port 5684 is the CoAP-over-DTLS (coaps) port, which is not supported; use the device\'s plain CoAP port (usually 5683)');
  options.blockSize = Number(options.blockSize);
  if (![16, 32, 64, 128, 256, 512, 1024].includes(options.blockSize)) errors.push('options.blockSize must be 16, 32, 64, 128, 256, 512 or 1024');
  if (!isIntIn(options.ackTimeoutMs, 50, 60000)) errors.push('options.ackTimeoutMs must be an integer 50..60000');
  if (!isIntIn(options.maxRetransmit, 0, 8)) errors.push('options.maxRetransmit must be an integer 0..8');
  if (!isIntIn(options.nstart, 1, 8)) errors.push('options.nstart must be an integer 1..8');
  if (!isIntIn(options.maxResponseBytes, 1024, 16 * 1024 * 1024)) errors.push('options.maxResponseBytes must be an integer 1024..16777216');
  if (!isIntIn(options.observeGraceMs, 0, 600000)) errors.push('options.observeGraceMs must be an integer 0..600000');
  if (!['ping', 'none'].includes(options.connectCheck)) errors.push('options.connectCheck must be "ping" or "none"');
  let accept;
  try {
    accept = acceptNumber(options.accept);
  } catch (err) {
    errors.push(`options.${err.message}`);
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
    const err = new Error(`invalid coap device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  const host = device.host.trim();
  return { host, connectHost: connectAddress({ ...device, host }), port, options: { ...options, accept }, limits, tags };
}

const hexOf = (b) => (b ? b.toString('hex') : undefined);

/**
 * @param {object} device
 * @param {{guard?:Function, dgramModule?:object, random?:()=>number}} [deps] test seams
 */
function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  let socket = null;
  let client = null;
  let lastDone = 0;
  const noObserve = new Set(); // request ids whose server ignored Observe: polled for the rest of this connection
  const backoff = new Map(); // request id -> { until, reason } (5.03 with Max-Age)
  const parsed = new WeakMap(); // response -> parsed body | { error }

  const acceptFor = (tagAccept) => tagAccept ?? options.accept;

  function toRequest(group) {
    return {
      id: group.id,
      uri: group.uri,
      path: group.segments,
      query: group.query,
      observe: group.observe,
      accept: group.accept,
      items: group.keys.map((key) => ({ key }))
    };
  }

  function bodyOf(resp) {
    let p = parsed.get(resp);
    if (!p) {
      try {
        p = { body: value.parseBody(resp.payload, resp.cf) };
      } catch (err) {
        p = { error: err.message };
      }
      parsed.set(resp, p);
    }
    return p;
  }

  const bad = (tag, reason) => ({ key: tag.key, v: null, type: value.SAMPLE_TYPE[tag.type] || 'string', q: 0, qReason: reason });

  function decodeItems(request, resp, stale) {
    const tags = request.items.map((i) => cfg.tags.get(i.key));
    const cls = codeClass(resp.code);
    if (cls !== 2) return tags.map((t) => bad(t, resp.codeText));
    if (resp.code !== 0x45 && resp.code !== 0x43) return tags.map((t) => bad(t, `unexpected ${resp.codeText}`));
    const p = bodyOf(resp);
    if (p.error) return tags.map((t) => bad(t, `decode: ${p.error}`));
    return tags.map((t) => {
      try {
        const raw = value.select(p.body, t.selector);
        const c = value.coerce(raw, t.type, { scale: t.scale, offset: t.valueOffset });
        return stale ? { key: t.key, v: c.v, type: c.type, q: 64, qReason: 'stale' } : { key: t.key, v: c.v, type: c.type, q: 192 };
      } catch (err) {
        return bad(t, `decode: ${err.message}`);
      }
    });
  }

  async function pace() {
    const wait = limits.interRequestDelayMs - (Date.now() - lastDone);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const specOf = (request) => ({ path: request.path, query: request.query, accept: request.accept ?? options.accept });

  return {
    protocol,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (client) await client.close().catch(() => {});
      client = null;
      noObserve.clear();
      backoff.clear();
      socket = new CoapUdpSocket({ address: cfg.connectHost, port: cfg.port, displayHost: cfg.host, guard: deps.guard, dgramModule: deps.dgramModule });
      await socket.open();
      client = new CoapClient({
        socket,
        ackTimeoutMs: options.ackTimeoutMs,
        maxRetransmit: options.maxRetransmit,
        nstart: options.nstart,
        blockSize: options.blockSize,
        maxResponseBytes: options.maxResponseBytes,
        observeGraceMs: options.observeGraceMs,
        random: deps.random,
        ...(deps.clientOptions || {})
      });
      let rttMs = null;
      if (options.connectCheck === 'ping') {
        const r = await client.ping(Date.now() + limits.connectTimeoutMs);
        if (!r.ok) {
          await client.close().catch(() => {});
          client = null;
          throw new Error(`no answer to a CoAP ping from ${cfg.host}:${cfg.port} (${r.message}). If the device ignores pings, set "Check on connect" to none.`);
        }
        rttMs = r.rttMs;
      }
      return {
        rttMs,
        limits: {
          requestDeadlineMs: limits.requestDeadlineMs,
          interRequestDelayMs: limits.interRequestDelayMs,
          blockSize: options.blockSize,
          maxResponseBytes: options.maxResponseBytes,
          nstart: options.nstart
        }
      };
    },

    isConnected() {
      return !!client && client.isConnected();
    },

    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      const groups = new Map();
      for (const k of keys) {
        const tag = cfg.tags.get(k);
        if (!tag) throw new Error(`unknown tag key "${k}"`);
        const accept = acceptFor(tag.accept);
        const id = `${tag.observe ? 'O' : 'G'} ${accept ?? '-'} ${tag.uri}`;
        if (!groups.has(id)) groups.set(id, { id, uri: tag.uri, segments: tag.segments, query: tag.query, observe: tag.observe, accept, keys: [] });
        groups.get(id).keys.push(k);
      }
      return [...groups.values()].map(toRequest);
    },

    async execute(request, deadlineMs) {
      const deadline = deadlineMs ?? limits.requestDeadlineMs;
      if (!client || !client.isConnected()) return { ok: false, kind: 'transport', fatal: true, message: 'not connected' };
      const tags = request.items.map((i) => cfg.tags.get(i.key));
      const hold = backoff.get(request.id);
      if (hold) {
        if (Date.now() < hold.until) return { ok: true, results: tags.map((t) => bad(t, hold.reason)) };
        backoff.delete(request.id);
      }
      await pace();
      const deadlineAt = Date.now() + deadline;
      let resp = null;
      let stale = false;
      let r;
      if (request.observe && !noObserve.has(request.id)) {
        const obs = client.observation(request.id);
        if (obs && obs.latest && (obs.state === 'active' || obs.state === 'ended')) {
          resp = obs.latest;
          stale = obs.state === 'active' && Date.now() > resp.receivedAt + resp.maxAge * 1000;
        } else if (!obs) {
          r = await client.observe(request.id, specOf(request), deadlineAt);
          if (r.ok) {
            resp = r.response;
            if (!r.observing && codeClass(resp.code) === 2) noObserve.add(request.id); // the device does not observe: poll
          }
        } else {
          r = await client.get(specOf(request), deadlineAt); // registered, body still arriving: poll meanwhile
          if (r.ok) resp = r.response;
        }
      } else {
        r = await client.get(specOf(request), deadlineAt);
        if (r.ok) resp = r.response;
      }
      lastDone = Date.now();
      if (!resp) {
        const why = r ? r.message : 'no response';
        if (r && (r.kind === 'timeout' || r.kind === 'transport' || r.kind === 'closed')) return { ok: false, kind: r.kind === 'closed' ? 'transport' : r.kind, fatal: true, message: why };
        // reset, protocol or too large: the device is alive but this resource cannot be read right now
        return { ok: true, results: tags.map((t) => bad(t, r && r.kind === 'reset' ? 'reset by device' : `${r ? r.kind : 'error'}: ${why}`)) };
      }
      if (resp.code === 0xa3 /* 5.03 */) {
        const secs = Math.min(resp.maxAge, 300);
        const reason = `${resp.codeText} (retry in ${secs} s)`;
        backoff.set(request.id, { until: Date.now() + secs * 1000, reason });
        return { ok: true, results: tags.map((t) => bad(t, reason)) };
      }
      return { ok: true, results: decodeItems(request, resp, stale) };
    },

    bisect() {
      return null;
    },

    /** Read one resource and show every way the response can be read. */
    async probe({ address } = {}) {
      if (!client || !client.isConnected()) throw new Error('not connected');
      const a = parseAddress(address);
      const r = await client.get({ path: a.segments, query: a.query, accept: options.accept }, Date.now() + limits.requestDeadlineMs * 2);
      if (!r.ok) throw new Error(`probe failed: ${r.kind}: ${r.message}`);
      const resp = r.response;
      const decodings = { 'response code': resp.codeText, 'content format': value.cfName(resp.cf), size: `${resp.payload.length} bytes${resp.blocks > 1 ? ` in ${resp.blocks} blocks` : ''}`, 'max age': `${resp.maxAge} s` };
      if (resp.etag) decodings.etag = hexOf(resp.etag);
      if (resp.observe !== undefined) decodings.observe = `sequence ${resp.observe} (the device accepts observe:)`;
      const out = { address: formatAddress({ ...a, observe: false }), type: value.cfName(resp.cf), rawHex: resp.payload.subarray(0, 512).toString('hex'), decodings };
      if (codeClass(resp.code) !== 2) return out;
      const p = bodyOf(resp);
      if (p.error) {
        decodings['decode error'] = p.error;
        return out;
      }
      const body = p.body;
      if (body.text !== undefined) decodings.text = body.text.length > 500 ? `${body.text.slice(0, 500)}...` : body.text;
      if (body.hex !== undefined) decodings.hex = body.hex.length > 500 ? `${body.hex.slice(0, 500)}...` : body.hex;
      if (body.doc !== undefined && !body.records) decodings[body.format === 'cbor' ? 'cbor' : 'json'] = JSON.stringify(body.doc).slice(0, 800);
      if (body.records) {
        for (const rec of body.records.slice(0, 50)) {
          const label = `senml ${rec.name || `#${rec.index}`}`;
          decodings[label] = rec.kind === null ? `sum ${rec.sum}` : `${rec.value}${rec.unit ? ` ${rec.unit}` : ''}`;
        }
        if (body.records.length > 50) decodings.senml = `${body.records.length} records (first 50 shown)`;
      }
      if (body.format === 'link') {
        const { links } = linkformat.parse(body.text);
        decodings.resources = `${links.length} link${links.length === 1 ? '' : 's'}`;
      }
      if (a.selector !== undefined || body.format === 'text') {
        try {
          const raw = value.select(body, a.selector);
          const c = value.coerce(raw, undefined);
          decodings.value = c.v;
          if (raw.unit) decodings.unit = raw.unit;
        } catch (err) {
          decodings['value error'] = err.message;
        }
      }
      return out;
    },

    /**
     * Browse: the device's /.well-known/core listing; a resource with a structured
     * format expands into the values inside it (JSON / CBOR members, SenML records).
     */
    async browse(node) {
      if (!client || !client.isConnected()) throw new Error('not connected');
      const deadlineAt = () => Date.now() + limits.requestDeadlineMs * 3;
      if (!node) {
        const r = await client.get({ path: WELL_KNOWN, query: [], accept: 40 }, deadlineAt());
        if (!r.ok) throw new Error(`/.well-known/core: ${r.kind}: ${r.message}`);
        const resp = r.response;
        if (codeClass(resp.code) !== 2) throw new Error(`/.well-known/core: the device answered ${resp.codeText}. It does not publish a resource list; add tags by path.`);
        let text;
        try {
          text = value.parseBody(resp.payload, resp.cf === undefined ? 40 : resp.cf).text;
        } catch (err) {
          throw new Error(`/.well-known/core: ${err.message}`);
        }
        if (text === undefined) throw new Error(`/.well-known/core came back as ${value.cfName(resp.cf)}, not link-format`);
        const { links } = linkformat.parse(text);
        return links
          .filter((l) => l.path !== '/.well-known/core')
          .slice(0, 1000)
          .map((l) => {
            const address = l.query ? `${l.path}?${l.query}` : l.path;
            const formats = l.ct.map((n) => value.cfName(n));
            const structured = l.ct.some((n) => [50, 60, 110, 112].includes(n));
            return {
              id: `res:${address}`,
              name: l.title || address,
              kind: 'tag',
              address,
              meta: {
                ...(l.rt.length ? { rt: l.rt.join(' ') } : {}),
                ...(l.if.length ? { interface: l.if.join(' ') } : {}),
                ...(formats.length ? { contentFormats: formats.join(', ') } : {}),
                ...(l.sz !== undefined ? { size: l.sz } : {}),
                observable: l.obs,
                hasChildren: structured
              }
            };
          });
      }
      if (!node.startsWith('res:')) throw new Error(`unknown browse node "${node}"`);
      const a = parseAddress(node.slice(4));
      const r = await client.get({ path: a.segments, query: a.query, accept: options.accept }, deadlineAt());
      if (!r.ok) throw new Error(`${a.uri}: ${r.kind}: ${r.message}`);
      if (codeClass(r.response.code) !== 2) throw new Error(`${a.uri}: the device answered ${r.response.codeText}`);
      const p = bodyOf(r.response);
      if (p.error) throw new Error(`${a.uri}: ${p.error}`);
      const body = p.body;
      const child = (sel, v, extra = {}) => {
        const type = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'string';
        return {
          id: `val:${a.uri}#${sel}`,
          name: sel,
          kind: 'tag',
          address: `${a.uri}#${sel}`,
          meta: { dataType: type, value: typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}...` : v, ...extra }
        };
      };
      if (body.records) {
        return body.records
          .filter((rec) => rec.kind !== null)
          .slice(0, MAX_BROWSE_CHILDREN)
          .map((rec) => child(rec.name, rec.kind === 'data' ? String(rec.value) : rec.value, { ...(rec.unit ? { unit: rec.unit } : {}), ...(rec.time !== null && !rec.relative ? { time: new Date(rec.time * 1000).toISOString() } : {}) }));
      }
      if (body.doc !== undefined) return selector.leaves(body.doc, { maxLeaves: MAX_BROWSE_CHILDREN }).map((l) => child(l.selector, l.value));
      return [];
    },

    async close() {
      const c = client;
      client = null;
      noObserve.clear();
      backoff.clear();
      if (c) await c.close();
      else if (socket) await socket.close();
      socket = null;
    },

    /** Counters for diagnostics and tests. */
    stats() {
      return client ? { ...client.stats, socket: { ...socket.stats } } : null;
    }
  };
}

module.exports = { protocol, describe, validateTag, createDriver, checkHost, AddressError };
