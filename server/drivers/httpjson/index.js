'use strict';

/**
 * HTTP/JSON polling driver (read-only). Polls a device's REST endpoints with GET and
 * extracts values with a small JSONPath subset (./selector.js). One request per distinct path
 * per poll cycle, shared by every tag on that path. See NOTES.md for what is and is not handled.
 *
 * `execute()` returns { ok:true, results:[{key, v, type, q, qReason?, tSource?}] } for every HTTP
 * answer, including error statuses and bodies that are not JSON: those are Bad quality with a
 * reason, and the device stays online. Only a lost connection (refused, reset, TLS failure, or
 * repeated timeouts) returns { ok:false, kind, fatal:true } so the runtime reconnects with backoff.
 */

const { activeSecretFields, HttpClient, HttpError, normalizeConnection, checkRequestPath, DEFAULT_MAX_BYTES } = require('../common/httpClient');
const { parseSelector, evaluate, flatten, SelectorError } = require('./selector');
const { assertAllowedDeviceTarget } = require('../../services/egressGuard');

const protocol = 'http-json';

const TYPES = ['number', 'bool', 'string'];
const DEFAULT_OPTIONS = { maxResponseBytes: DEFAULT_MAX_BYTES, keepAlive: true, testPath: '' };
const DEFAULT_LIMITS = { requestDeadlineMs: 5000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };
const MAX_RESPONSE_LIMIT = 64 * 1024 * 1024;
const TIMEOUTS_BEFORE_OFFLINE = 3;
const PROBE_LEAVES = 100;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** @returns {object} static driver description for the UI and registry */
function describe() {
  return {
    protocol,
    label: 'HTTP / JSON',
    readOnly: true,
    experimental: true,
    browseNoun: 'device',
    defaultPort: 80,
    options: { ...DEFAULT_OPTIONS },
    limits: { ...DEFAULT_LIMITS },
    tagTypes: [...TYPES],
    addressForms: ['/api/status#$.power.total', "/meters#$.items[?(@.id==\"main\")].kwh"],
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },
    secretFields: ['authPassword', 'authToken', 'authHeaderSecret'],
    deviceFields: [
      { name: 'scheme', label: 'Scheme', type: 'select', default: 'http', options: ['http', 'https'], help: 'https usually means port 443.' },
      { name: 'basePath', label: 'Base path', type: 'string', optional: true, placeholder: '/api/v1', help: 'Prefix added to every tag path. Leave empty when the API is at the root.' },
      { name: 'authType', label: 'Authentication', type: 'select', default: 'none', options: ['none', 'basic', 'bearer', 'header'], help: 'Credentials are stored with the device, hidden in the API and in exports, and sent only to this host.' },
      { name: 'authUsername', showWhen: { name: 'authType', in: ['basic'] }, label: 'User name', type: 'string', optional: true, help: 'Basic authentication.' },
      { name: 'authPassword', showWhen: { name: 'authType', in: ['basic'] }, label: 'Password', type: 'password', optional: true, help: 'Basic authentication. Leave blank when editing to keep the stored value.' },
      { name: 'authToken', showWhen: { name: 'authType', in: ['bearer'] }, label: 'Bearer token', type: 'password', optional: true, help: 'Sent as "Authorization: Bearer". Leave blank when editing to keep the stored value.' },
      { name: 'authHeaderName', showWhen: { name: 'authType', in: ['header'] }, label: 'Header name', type: 'string', optional: true, placeholder: 'X-Api-Key', help: 'Custom header authentication.' },
      { name: 'authHeaderSecret', showWhen: { name: 'authType', in: ['header'] }, label: 'Header value', type: 'password', optional: true, help: 'Custom header authentication. Leave blank when editing to keep the stored value.' },
      { name: 'tlsInsecure', showWhen: { name: 'scheme', in: ['https'] }, label: 'Do not verify the TLS certificate', type: 'boolean', default: false, help: 'Accepts any certificate, so the connection can be intercepted. Prefer a CA or fingerprint below.' },
      { name: 'tlsCa', showWhen: { name: 'scheme', in: ['https'] }, label: 'CA certificate (PEM)', type: 'string', optional: true, help: 'Trust this CA in addition to the system roots, for a device with a private CA.' },
      { name: 'tlsFingerprint256', showWhen: { name: 'scheme', in: ['https'] }, label: 'Pinned certificate fingerprint (SHA-256)', type: 'string', optional: true, help: 'Accept only the certificate with this fingerprint (for a self-signed device). Replaces chain validation.' }
    ],
    optionFields: [
      { name: 'maxResponseBytes', label: 'Max response size (bytes)', type: 'number', default: DEFAULT_MAX_BYTES, help: 'A longer response is aborted and its tags go Bad.' },
      { name: 'testPath', label: 'Test connection path', type: 'string', optional: true, placeholder: '/', help: 'Fetched by "Test connection". Any HTTP answer counts as reachable, except 401 and 403.' },
      { name: 'keepAlive', label: 'Keep connections open', type: 'boolean', default: true, help: 'Reuse one TCP connection between polls. Turn off for devices that mishandle it.' }
    ],
    addressHelp: 'path#selector, for example /api/status#$.power.total. The selector supports $.a.b[0], $["key"] and [?(@.id=="x")].',
    prerequisites:
      'Manifold only sends GET requests, never a body. Poll one endpoint per path, as slowly as the data needs: small devices serve one request at a time.\n' +
      'Warning: a device that changes state on GET (some gateways do) would be affected by polling. Check the device documentation.'
  };
}

// ---- tags -------------------------------------------------------------------

function splitAddress(address) {
  const at = address.indexOf('#');
  if (at < 0) return { path: address, selector: '' };
  return { path: address.slice(0, at), selector: address.slice(at + 1) };
}

/**
 * Validate one tag. Addressed either as `address: "/path#$.selector"` or with explicit
 * `path` and `selector`. Returns { ok:true, normalized } or { ok:false, error }.
 */
function compileTag(tagDef) {
  const fail = (error) => ({ ok: false, error });
  if (!tagDef || typeof tagDef !== 'object') return fail('tag must be an object');
  const { key, type } = tagDef;
  if (typeof key !== 'string' || !key) return fail('key must be a non-empty string');
  if (!TYPES.includes(type)) return fail(`unknown type "${type}" (supported: ${TYPES.join(', ')})`);
  let path = tagDef.path;
  let selector = tagDef.selector;
  if (typeof tagDef.address === 'string' && tagDef.address) {
    const parts = splitAddress(tagDef.address);
    path = parts.path;
    selector = parts.selector;
  }
  if (typeof path !== 'string' || !path) return fail('address must be "<path>#<selector>", for example /status#$.power');
  const why = checkRequestPath(path);
  if (why) return fail(why);
  if (typeof selector !== 'string' || !selector) return fail('address needs a selector after "#", for example /status#$.power');
  let steps;
  try {
    steps = parseSelector(selector);
  } catch (e) {
    if (e instanceof SelectorError) return fail(`selector: ${e.message}`);
    throw e;
  }
  let tsSteps = null;
  if (tagDef.timestampSelector !== undefined && tagDef.timestampSelector !== '') {
    try {
      tsSteps = parseSelector(tagDef.timestampSelector);
    } catch (e) {
      if (e instanceof SelectorError) return fail(`timestampSelector: ${e.message}`);
      throw e;
    }
  }
  let qualitySteps = null;
  let qualityEquals;
  if (tagDef.qualitySelector !== undefined && tagDef.qualitySelector !== '') {
    try {
      qualitySteps = parseSelector(tagDef.qualitySelector);
    } catch (e) {
      if (e instanceof SelectorError) return fail(`qualitySelector: ${e.message}`);
      throw e;
    }
    qualityEquals = tagDef.qualityEquals;
    if (!(typeof qualityEquals === 'string' || typeof qualityEquals === 'number' || typeof qualityEquals === 'boolean' || qualityEquals === null)) {
      return fail('qualityEquals is required with qualitySelector and must be a string, number, boolean or null');
    }
  } else if (tagDef.qualityEquals !== undefined) {
    return fail('qualityEquals needs a qualitySelector');
  }
  let okStatus = null;
  if (tagDef.okStatus !== undefined) {
    if (!Array.isArray(tagDef.okStatus) || !tagDef.okStatus.length || !tagDef.okStatus.every((s) => isInt(s, 100, 599))) {
      return fail('okStatus must be a list of HTTP status codes, for example [200, 404]');
    }
    okStatus = [...tagDef.okStatus];
  }
  return {
    ok: true,
    normalized: {
      key, type, path, selector, steps, timestampSelector: tagDef.timestampSelector || undefined, tsSteps,
      qualitySelector: tagDef.qualitySelector || undefined, qualitySteps, qualityEquals, okStatus, pollGroup: tagDef.pollGroup
    }
  };
}

/** Public validator: the normalized form without the compiled selector steps. */
function validateTag(tagDef) {
  const r = compileTag(tagDef);
  if (!r.ok) return r;
  const { steps: _s, tsSteps: _t, qualitySteps: _q, ...normalized } = r.normalized;
  return { ok: true, normalized };
}

// ---- value handling ---------------------------------------------------------

const NUMERIC_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const TRUE_WORDS = new Set(['true', 'on', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'off', 'no', '0']);

/** @returns {{ok:true, v:*}|{ok:false}} */
function coerce(value, type) {
  if (value === null || value === undefined) return { ok: false, reason: 'null' };
  if (type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, v: value } : { ok: false };
    if (typeof value === 'boolean') return { ok: true, v: value ? 1 : 0 };
    if (typeof value === 'string' && NUMERIC_RE.test(value.trim())) {
      const n = Number(value.trim());
      return Number.isFinite(n) ? { ok: true, v: n } : { ok: false };
    }
    return { ok: false };
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return { ok: true, v: value };
    if (typeof value === 'number') return value === 0 || value === 1 ? { ok: true, v: value === 1 } : { ok: false };
    if (typeof value === 'string') {
      const w = value.trim().toLowerCase();
      if (TRUE_WORDS.has(w)) return { ok: true, v: true };
      if (FALSE_WORDS.has(w)) return { ok: true, v: false };
    }
    return { ok: false };
  }
  if (typeof value === 'string') return { ok: true, v: value };
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, v: String(value) };
  const text = JSON.stringify(value);
  return text.length <= 4096 ? { ok: true, v: text } : { ok: false };
}

/** ISO 8601 text, epoch seconds or epoch milliseconds -> ms, or undefined. */
function toTimestamp(value) {
  let ms;
  if (typeof value === 'number') ms = value > 1e11 ? value : value * 1000;
  else if (typeof value === 'string' && value.trim()) {
    ms = NUMERIC_RE.test(value.trim()) ? Number(value) : Date.parse(value);
    if (NUMERIC_RE.test(value.trim())) ms = ms > 1e11 ? ms : ms * 1000;
  }
  // Plausible range only: 2000-01-01 .. 2100-01-01
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= 4102444800000 ? Math.round(ms) : undefined;
}

const bad = (tag, qReason) => ({ key: tag.key, v: null, type: tag.type, q: 0, qReason });

function statusOk(tag, status) {
  if (tag.okStatus) return tag.okStatus.includes(status);
  return status >= 200 && status < 300;
}

function evalTag(tag, status, doc) {
  if (!statusOk(tag, status)) return bad(tag, `http-${status}`);
  if (doc === undefined) return bad(tag, 'not-json');
  const r = evaluate(tag.steps, doc);
  if (!r.found) return bad(tag, `selector-no-match (stopped at ${r.at})`);
  if (tag.qualitySteps) {
    const qr = evaluate(tag.qualitySteps, doc);
    if (!qr.found) return bad(tag, 'quality-rule (field missing)');
    if (qr.value !== tag.qualityEquals) return bad(tag, `quality-rule (${tag.qualitySelector} is ${JSON.stringify(qr.value)})`);
  }
  const c = coerce(r.value, tag.type);
  if (!c.ok) return bad(tag, c.reason === 'null' ? 'null-value' : `type-mismatch (not a ${tag.type})`);
  const out = { key: tag.key, v: c.v, type: tag.type, q: 192 };
  if (tag.tsSteps) {
    const t = evaluate(tag.tsSteps, doc);
    const ms = t.found ? toTimestamp(t.value) : undefined;
    if (ms !== undefined) out.tSource = ms;
  }
  return out;
}

function parseBody(body) {
  let text = body.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { ok: false, reason: 'empty body' };
  try {
    return { ok: true, doc: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---- device -----------------------------------------------------------------

function normalizeDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device config must be an object');
  const errors = [];
  const options = { ...DEFAULT_OPTIONS, ...(device.options || {}) };
  const limits = { ...DEFAULT_LIMITS, ...(device.limits || {}) };
  const port = device.port ?? 80;
  if (typeof device.host !== 'string' || !device.host.trim()) errors.push('host must be a non-empty string');
  if (!isInt(port, 1, 65535)) errors.push('port must be an integer 1..65535');
  if (!isInt(options.maxResponseBytes, 1024, MAX_RESPONSE_LIMIT)) errors.push(`options.maxResponseBytes must be an integer 1024..${MAX_RESPONSE_LIMIT}`);
  if (typeof options.keepAlive !== 'boolean') errors.push('options.keepAlive must be true or false');
  if (options.testPath !== undefined && options.testPath !== '' && typeof options.testPath === 'string') {
    const why = checkRequestPath(options.testPath);
    if (why) errors.push(`options.testPath: ${why}`);
  } else if (options.testPath !== undefined && options.testPath !== '') errors.push('options.testPath must be a string');
  for (const f of ['requestDeadlineMs', 'connectTimeoutMs']) if (!(limits[f] > 0)) errors.push(`limits.${f} must be a positive number`);
  if (!(limits.interRequestDelayMs >= 0)) errors.push('limits.interRequestDelayMs must be >= 0');
  const conn = normalizeConnection(device);
  errors.push(...conn.errors);
  const tags = new Map();
  const details = errors.map((error) => ({ key: null, error }));
  if (!Array.isArray(device.tags ?? [])) details.push({ key: null, error: 'tags must be an array' });
  else {
    for (const t of device.tags || []) {
      const r = compileTag(t);
      if (!r.ok) details.push({ key: t && t.key !== undefined ? t.key : null, error: r.error });
      else if (tags.has(r.normalized.key)) details.push({ key: r.normalized.key, error: 'duplicate tag key' });
      else tags.set(r.normalized.key, r.normalized);
    }
  }
  if (details.length) {
    const err = new Error(`invalid http-json device config: ${details.map((d) => (d.key ? `${d.key}: ${d.error}` : d.error)).join('; ')}`);
    err.details = details;
    throw err;
  }
  return { host: device.host.trim(), port, options, limits, conn: conn.value, tags };
}

/**
 * @param {object} device device config
 * @param {{assertTarget?:Function}} [deps]
 * @returns {object} driver (contract in southbound-drivers.md section 4.1)
 */
function createDriver(device, deps = {}) {
  const cfg = normalizeDevice(device);
  const { options, limits } = cfg;
  const cache = new Map(); // path -> { etag, doc }
  let client = null;
  let timeouts = 0;

  const makeClient = () =>
    new HttpClient({
      device,
      host: cfg.host,
      port: cfg.port,
      conn: cfg.conn,
      maxBytes: options.maxResponseBytes,
      keepAlive: options.keepAlive,
      userAgent: 'manifold-http-json',
      assertTarget: deps.assertTarget || ((h) => assertAllowedDeviceTarget(h))
    });

  const fatal = (kind, message) => ({ ok: false, kind, fatal: true, message });

  async function fetchPath(path, deadlineAt, { conditional }) {
    const headers = {};
    const cached = cache.get(path);
    if (conditional && cached && cached.etag) headers['if-none-match'] = cached.etag;
    return client.get(path, { deadlineAt, headers });
  }

  return {
    protocol,
    capabilities: { browse: true, subscribe: false, maxInFlight: 1 },

    async connect() {
      if (client) client.close();
      client = makeClient();
      timeouts = 0;
      cache.clear();
      const started = Date.now();
      const path = options.testPath || '/';
      let res;
      try {
        res = await client.get(path, { timeoutMs: limits.connectTimeoutMs });
      } catch (e) {
        client.close();
        client = null;
        throw new Error(e instanceof HttpError ? `${client_label(cfg, path)}: ${e.message}` : e.message);
      }
      if (res.status === 401 || res.status === 403) {
        client.close();
        client = null;
        throw new Error(`${client_label(cfg, path)}: the device answered ${res.status}; check the credentials`);
      }
      return {
        url: client_label(cfg, path),
        status: res.status,
        server: res.headers.server || null,
        contentType: res.headers['content-type'] || null,
        note: res.status >= 400 ? `reachable; ${path} answered ${res.status}, which is fine if the device has nothing at that path` : null,
        latencyMs: Date.now() - started,
        limits: { maxResponseBytes: options.maxResponseBytes, requestDeadlineMs: limits.requestDeadlineMs, interRequestDelayMs: limits.interRequestDelayMs }
      };
    },

    isConnected() {
      return client !== null;
    },

    /** One request per distinct path, in tag order. */
    plan(tagKeys) {
      const keys = tagKeys || [...cfg.tags.keys()];
      const byPath = new Map();
      for (const k of keys) {
        const tag = cfg.tags.get(k);
        if (!tag) throw new Error(`unknown tag key "${k}"`);
        if (!byPath.has(tag.path)) byPath.set(tag.path, []);
        byPath.get(tag.path).push({ key: tag.key });
      }
      return [...byPath].map(([path, items]) => ({ id: `GET ${path}`, path, items }));
    },

    async execute(request, deadlineMs) {
      if (!client) return fatal('transport', 'not connected');
      const deadlineAt = Date.now() + (deadlineMs ?? limits.requestDeadlineMs);
      const tags = request.items.map((i) => cfg.tags.get(i.key));
      const allBad = (reason) => ({ ok: true, results: tags.map((t) => bad(t, reason)) });
      let res;
      try {
        res = await fetchPath(request.path, deadlineAt, { conditional: true });
      } catch (e) {
        if (!(e instanceof HttpError)) return fatal('transport', e && e.message ? e.message : String(e));
        if (e.kind === 'too-large') {
          timeouts = 0;
          return allBad('too-large');
        }
        if (e.kind === 'redirect') {
          timeouts = 0;
          return allBad(`redirect-refused (${e.message})`);
        }
        if (e.kind === 'encoding') {
          timeouts = 0;
          return allBad(`unsupported-encoding (${e.message})`);
        }
        if (e.kind === 'timeout') {
          timeouts++;
          if (timeouts >= TIMEOUTS_BEFORE_OFFLINE) return fatal('timeout', `${timeouts} requests in a row timed out (${e.message})`);
          return allBad('timeout');
        }
        return fatal(e.kind, e.message);
      }
      timeouts = 0;
      let doc;
      if (res.status === 304) {
        const c = cache.get(request.path);
        if (!c) return allBad('http-304 (not modified, but nothing cached)');
        doc = c.doc;
        res = { ...res, status: 200 };
      } else if ((res.status >= 200 && res.status < 300) || tags.some((t) => t.okStatus && t.okStatus.includes(res.status))) {
        const p = parseBody(res.body);
        if (p.ok) {
          doc = p.doc;
          if (res.status >= 200 && res.status < 300 && res.headers.etag) cache.set(request.path, { etag: String(res.headers.etag), doc });
          else cache.delete(request.path);
        } else cache.delete(request.path);
      } else cache.delete(request.path);
      return { ok: true, results: tags.map((t) => evalTag(t, res.status, doc)) };
    },

    /** Fetch a path and list its leaf selectors with sample values. Nodes: root -> paths -> leaves. */
    async browse(node) {
      if (!client) throw new Error('not connected');
      if (!node) {
        const paths = new Set(['/']);
        for (const t of cfg.tags.values()) paths.add(t.path);
        return [...paths].map((p) => ({ id: p, name: p, kind: 'folder', meta: { hasChildren: true } }));
      }
      const path = String(node);
      const why = checkRequestPath(path);
      if (why) throw new Error(why);
      const res = await client.get(path, { timeoutMs: limits.requestDeadlineMs * 2 });
      if (res.status < 200 || res.status >= 300) throw new Error(`${path} answered HTTP ${res.status}`);
      const p = parseBody(res.body);
      if (!p.ok) throw new Error(`${path} did not return JSON (${p.reason})`);
      const { leaves, truncated } = flatten(p.doc);
      const nodes = leaves.map((l) => ({
        id: `${path}#${l.selector}`,
        name: l.selector,
        kind: 'tag',
        address: `${path}#${l.selector}`,
        meta: { dataType: l.type === 'null' ? '' : l.type, sample: l.value, ...(truncated ? { truncated: true } : {}) }
      }));
      return nodes;
    },

    /** Read one address (`/path` lists every leaf, `/path#$.sel` returns that value). */
    async probe({ address } = {}) {
      if (!client) throw new Error('not connected');
      if (typeof address !== 'string' || !address.startsWith('/')) throw new RangeError('address must be a path, optionally followed by #selector');
      const { path, selector } = splitAddress(address.trim());
      const why = checkRequestPath(path);
      if (why) throw new RangeError(why);
      const res = await client.get(path, { timeoutMs: limits.requestDeadlineMs * 2 });
      const p = parseBody(res.body);
      const base = { address: path, status: res.status, contentType: res.headers['content-type'] || null, bytes: res.body.length };
      if (!p.ok) throw new Error(`HTTP ${res.status}; the body is not JSON (${p.reason}). First bytes: ${JSON.stringify(res.body.subarray(0, 60).toString('utf8'))}`);
      if (selector) {
        const r = evaluate(parseSelector(selector), p.doc);
        if (!r.found) throw new Error(`HTTP ${res.status}; selector matched nothing (stopped at ${r.at})`);
        return { ...base, address: `${path}#${selector}`, decodings: { value: r.value, 'JSON type': Array.isArray(r.value) ? 'array' : r.value === null ? 'null' : typeof r.value } };
      }
      const { leaves, truncated } = flatten(p.doc, { maxLeaves: PROBE_LEAVES });
      const decodings = {};
      for (const l of leaves) decodings[l.selector] = l.value;
      return { ...base, decodings, truncated };
    },

    async close() {
      const c = client;
      client = null;
      if (c) c.close();
    }
  };
}

function client_label(cfg, path) {
  return `${cfg.conn.scheme}://${cfg.host}:${cfg.port}${cfg.conn.basePath}${path}`;
}

module.exports = { protocol, describe, activeSecretFields, validateTag, createDriver, coerce, toTimestamp };
