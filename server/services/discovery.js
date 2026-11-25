'use strict';

const net = require('net');
const os = require('os');
const dns = require('dns');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { classifyScanTarget } = require('./egressGuard');
const deviceIdentify = require('./deviceIdentify');

/**
 * Network discovery: a CIDR scan that finds MQTT brokers, OPC UA servers and i3X
 * servers and, opt-in, Modbus TCP / Siemens S7 / EtherNet/IP devices.
 *
 * What it does, in order, for every host:port it is asked to look at:
 *   1. a plain TCP connect (bounded by `timeoutMs`); nothing is sent;
 *   2. only if the port is open, a protocol-specific identification handshake
 *      (MQTT CONNECT, OPC UA Hello then GetEndpoints over security None, i3X
 *      GET /info, Modbus device-id/FC3 read, S7 COTP (+ SZL identity),
 *      EtherNet/IP ListIdentity). Identification never writes (see
 *      ./deviceIdentify.js);
 *   3. one result per host:port. `verified: true` means the protocol answered;
 *      `verified: false` means:
 *        - MQTT: the conventional port is open but did not answer a CONNECT;
 *        - OPC UA: the port answered the UA-TCP Hello but GetEndpoints failed
 *          (a listener that does not answer the Hello is not reported).
 *      Devices and i3X are never reported unless they answered.
 *
 * Safety: every host passes the egress policy (classifyScanTarget): see SECURITY.md.
 * Pressure on the network is bounded: `concurrency` sockets in flight overall and at
 * most `perHost` to any one IP (PLCs have few connection slots); the per-probe and
 * per-identification timeouts bound the total time, which `plan()` reports up front.
 */

const DEFAULT_MQTT_PORTS = [1883, 8883];
// 4840 is the OPC UA default; 50000 is where Microsoft's opc-plc simulator listens
// (common in OPC UA demos and what this project's demo stack runs), which a
// 4840-only scan silently misses.
const DEFAULT_OPCUA_PORTS = [4840, 50000];
const DEFAULT_I3X_PORTS = [80, 443, 8080];
const DEFAULT_MODBUS_PORTS = [502];
const DEFAULT_S7_PORTS = [102];
const DEFAULT_EIP_PORTS = [44818];
// Common base paths an i3X server might be mounted under; each open HTTP port is
// checked for a live /info document at one of these prefixes.
const DEFAULT_I3X_PATHS = ['', '/v1', '/i3x', '/i3x/v1'];

const DEFAULTS = Object.freeze({
  // Sockets in flight across the whole scan. Conservative: a /24 with six ports is
  // well under a minute when closed ports answer with a reset and ~1 min when they
  // are silently dropped, and a flat 32 is invisible to switches and IDS thresholds.
  concurrency: 32,
  // Simultaneous connections to ONE address, probe and identification together.
  perHost: 2,
  timeoutMs: 1200, // TCP connect
  identifyTimeoutMs: 3000 // one identification handshake
});
const BOUNDS = Object.freeze({
  concurrency: [1, 512],
  perHost: [1, 16],
  timeoutMs: [100, 10000],
  identifyTimeoutMs: [500, 15000]
});
const MAX_PORTS_PER_KIND = 32;
const KIND_ORDER = ['mqtt', 'opcua', 'i3x', 'modbus', 's7', 'ethernet-ip'];
const DEVICE_KINDS = new Set(['modbus', 's7', 'ethernet-ip']);

function maxHosts() {
  const n = Number(process.env.MANIFOLD_DISCOVERY_MAX_HOSTS);
  return Number.isInteger(n) && n >= 1 ? n : 1024; // a /22
}

class DiscoveryError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const fmtInt = (n) => n.toLocaleString('en-US');

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = s / 3600;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

const CATEGORY_TEXT = {
  loopback: 'loopback (127.0.0.0/8)',
  private: 'private RFC1918 (10/8, 172.16/12, 192.168/16)',
  'link-local': 'link-local / cloud-metadata (169.254.0.0/16)',
  multicast: 'multicast (224.0.0.0/4)',
  reserved: 'reserved or documentation space (0/8, CGNAT 100.64/10, TEST-NET, 240/4)',
  invalid: 'not an IPv4 address'
};
const FLAG_TEXT = {
  MANIFOLD_ALLOW_PRIVATE_TARGETS: 'Set MANIFOLD_ALLOW_PRIVATE_TARGETS=1 and restart the server to scan LAN subnets (only on a trusted network).',
  MANIFOLD_ALLOW_LOOPBACK_DEVICES: 'Set MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 and restart the server to scan this machine (intended for local simulators and development).'
};

/** Build the refusal for a range in which no address may be scanned. */
function refusal(range, counts) {
  const cats = Object.keys(counts);
  const total = cats.reduce((n, c) => n + counts[c].count, 0);
  const parts = cats.map((c) => `${fmtInt(counts[c].count)} ${CATEGORY_TEXT[c] || c}`);
  const flags = [...new Set(cats.map((c) => counts[c].flag).filter(Boolean))];
  const never = cats.filter((c) => !counts[c].flag);
  let msg = `Nothing to scan in ${range}: all ${fmtInt(total)} address${total === 1 ? ' is' : 'es are'} blocked targets (${parts.join('; ')}).`;
  for (const f of flags) msg += ` ${FLAG_TEXT[f]}`;
  if (never.length) {
    msg += flags.length
      ? ` ${never.map((c) => CATEGORY_TEXT[c]).join(' and ')} stay blocked whatever you set.`
      : ' No setting allows this range: Manifold never scans these addresses.';
  }
  return new DiscoveryError(msg, 'RANGE_REFUSED', { flag: flags.length === 1 ? flags[0] : flags.length ? flags : null, categories: Object.fromEntries(cats.map((c) => [c, counts[c].count])) });
}

/** "10.0.0.5" / "10.0.0.0/24" -> { base, prefix }, else throws DiscoveryError. */
function parseRange(range) {
  const text = String(range).trim();
  if (net.isIPv6(text.replace(/^\[|\]$/g, '').split('/')[0])) {
    throw new DiscoveryError('IPv6 ranges are not supported. Enter an IPv4 address or CIDR such as 192.168.1.0/24.', 'RANGE_INVALID');
  }
  const [base, prefixText, extra] = text.split('/');
  if (extra !== undefined || (prefixText !== undefined && !/^\d{1,2}$/.test(prefixText))) {
    throw new DiscoveryError(`Invalid CIDR: ${text}. Use the form 192.168.1.0/24.`, 'RANGE_INVALID');
  }
  return { base, prefix: prefixText === undefined ? 32 : Number(prefixText) };
}

const uniqInts = (list) => [...new Set(list)];

function intList(name, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new DiscoveryError(`${name} must be a list of port numbers`, 'OPTION_INVALID');
  const out = value.map((p) => (typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p) : p));
  const bad = out.find((p) => !Number.isInteger(p) || p < 1 || p > 65535);
  if (bad !== undefined) throw new DiscoveryError(`${name}: "${bad}" is not a port (1-65535)`, 'OPTION_INVALID');
  if (out.length > MAX_PORTS_PER_KIND) throw new DiscoveryError(`${name}: at most ${MAX_PORTS_PER_KIND} ports per protocol`, 'OPTION_INVALID');
  return uniqInts(out);
}

function boundedInt(name, value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  const [lo, hi] = BOUNDS[name];
  if (!Number.isInteger(n) || n < lo || n > hi) throw new DiscoveryError(`${name} must be a whole number from ${lo} to ${hi}`, 'OPTION_INVALID');
  return n;
}

/** Hosts reported per probe-kind; the engine's single source for "what will be scanned". */
function kindsFromOptions(options) {
  const devices = options.includeDevices === true;
  const kinds = {
    mqtt: intList('mqttPorts', options.mqttPorts, DEFAULT_MQTT_PORTS),
    opcua: intList('opcuaPorts', options.opcuaPorts, DEFAULT_OPCUA_PORTS),
    i3x: intList('i3xPorts', options.i3xPorts, options.includeI3x === false ? [] : DEFAULT_I3X_PORTS),
    modbus: intList('modbusPorts', options.modbusPorts, devices ? DEFAULT_MODBUS_PORTS : []),
    s7: intList('s7Ports', options.s7Ports, devices ? DEFAULT_S7_PORTS : []),
    'ethernet-ip': intList('eipPorts', options.eipPorts, devices ? DEFAULT_EIP_PORTS : [])
  };
  const mqttWs = intList('mqttWsPorts', options.mqttWsPorts, []);
  return { kinds, mqttWs };
}

// ---- OPC UA GetEndpoints (runtime dependency node-opcua-client, loaded on first use) ----

const MODE_ORDER = ['None', 'Sign', 'SignAndEncrypt'];

/** Connect with security None, GetEndpoints, disconnect. Bounded and cancellable; never leaves the client open. */
async function getEndpointsNone(endpointUrl, { timeoutMs, signal }) {
  const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = require('node-opcua-client');
  const client = OPCUAClient.create({
    applicationName: 'Manifold', // the name the default client certificate was made for
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    transportTimeout: timeoutMs,
    connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 }
  });
  let timer = null;
  let onAbort = null;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(endpointUrl);
        return (await client.getEndpoints()) || [];
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener?.('abort', onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener?.('abort', onAbort);
    await client.disconnect().catch(() => {});
  }
}

/** What a GetEndpoints answer says about the server: identity and the security it offers. */
function summarizeEndpoints(endpoints, MessageSecurityMode = require('node-opcua-client').MessageSecurityMode) {
  const first = endpoints.find((e) => e.server) || {};
  const app = first.server || {};
  const modes = new Set();
  const policies = new Set();
  const tokens = new Set();
  for (const e of endpoints) {
    const mode = MessageSecurityMode[e.securityMode];
    if (mode && mode !== 'Invalid') modes.add(mode);
    const uri = e.securityPolicyUri || '';
    if (uri) policies.add(uri.includes('#') ? uri.split('#').pop() : uri);
    for (const t of e.userIdentityTokens || []) {
      const k = ['Anonymous', 'UserName', 'Certificate', 'IssuedToken'][t.tokenType];
      if (k) tokens.add(k);
    }
  }
  const applicationUri = app.applicationUri || null;
  const applicationName = app.applicationName?.text || null;
  return {
    applicationUri,
    applicationName,
    identity: {
      applicationUri,
      applicationName,
      productUri: app.productUri || null,
      securityModes: MODE_ORDER.filter((m) => modes.has(m)),
      securityPolicies: [...policies],
      userTokens: [...tokens],
      endpointCount: endpoints.length
    }
  };
}

/**
 * Honest network discovery: TCP port probing across a CIDR range followed by a
 * real protocol handshake to confirm what is listening. No synthetic results.
 */
class DiscoveryService extends EventEmitter {
  constructor(io, deps = {}) {
    super();
    this.io = io;
    this.i3x = deps.i3x || null; // used to verify discovered i3X HTTP endpoints
    this.deps = { known: deps.known || null, lookup: deps.lookup || ((host) => dns.promises.lookup(host, { family: 4 })) };
    this.scanning = false;
    this.abortRequested = false;
    this.lastResults = [];
    this.scan = null; // summary of the current or last scan
    this._abort = null;
    this._finish = null;
  }

  /** Give the engine access to what Manifold already has, so results can say `known`. */
  bindServices(services) {
    if (this.deps.known || !services) return;
    this.deps.known = () => ({
      brokers: services.mqttManager?.getConnections?.() || [],
      opcua: services.opcuaManager?.getConnections?.() || [],
      i3x: services.i3x?.status?.() || null,
      devices: services.devices?.list?.() || []
    });
  }

  // ---- already-added detection (server side) -------------------------------------------

  _knownIndex() {
    let k = null;
    try {
      k = this.deps.known ? this.deps.known() : null;
    } catch {
      /* a failing lookup means nothing is known yet: keep k = null */
    }
    return k;
  }

  /** `{ kind: 'broker'|'opcua'|'i3x'|'device', id, name }` when Manifold already has this endpoint, else null. */
  knownFor(result, index = this._knownIndex()) {
    if (!index) return null;
    const norm = (h) => {
      const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
      return x === 'localhost' || x === '::1' ? '127.0.0.1' : x;
    };
    const host = norm(result.host);
    const same = (h, p) => norm(h) === host && Number(p) === Number(result.port);
    const fromUrl = (u) => {
      try {
        const url = new URL(u);
        return [url.hostname, Number(url.port) || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 4840)];
      } catch {
        return [null, null];
      }
    };
    if (result.kind === 'mqtt') {
      const b = (index.brokers || []).find((x) => same(x.host, x.port || 1883));
      return b ? { kind: 'broker', id: b.id, name: b.name || b.id } : null;
    }
    if (result.kind === 'opcua') {
      const c = (index.opcua || []).find((x) => same(...fromUrl(x.endpointUrl)));
      return c ? { kind: 'opcua', id: c.id, name: c.name || c.id } : null;
    }
    if (result.kind === 'i3x') {
      const base = index.i3x?.configured ? index.i3x.baseUrl : null;
      if (base && same(...fromUrl(base))) return { kind: 'i3x', id: 'i3x', name: index.i3x.info?.serverName || base };
      return null;
    }
    if (DEVICE_KINDS.has(result.kind)) {
      const d = (index.devices || []).find((x) => same(x.host, x.port));
      return d ? { kind: 'device', id: d.id, name: d.name || d.id } : null;
    }
    return null;
  }

  _annotate(result, index) {
    return { ...result, known: this.knownFor(result, index) };
  }

  // ---- identification -----------------------------------------------------------------

  async identifyI3xServer(host, port, { deadlineMs = 4000, signal } = {}) {
    if (!this.i3x) return null;
    const scheme = port === 443 || port === 8443 ? 'https' : 'http';
    const until = Date.now() + deadlineMs;
    for (const path of DEFAULT_I3X_PATHS) {
      if (signal?.aborted || Date.now() >= until) return null;
      const baseUrl = `${scheme}://${host}:${port}${path}`;
      // `probe` cannot be cancelled, only bounded (its own 3 s timeout); the race keeps the scan on schedule.
      const info = await Promise.race([
        this.i3x.probe(baseUrl),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), Math.max(1, until - Date.now()));
          t.unref?.();
        })
      ]);
      if (info) {
        return { verified: true, method: 'i3x-info', baseUrl, serverName: info.serverName || null, specVersion: info.specVersion || null };
      }
    }
    return null;
  }

  /**
   * Identify a southbound device (read-only probe). Result merged into the
   * discovery candidate:
   *   { verified: true, protocol: 'modbus-tcp'|'s7'|'ethernet-ip', method, identity: {...},
   *     suggestedDevice: { name, protocol, host, port } }   // body for POST /api/devices
   * or null when the port does not speak the protocol.
   */
  async identifyDevice(kind, host, port, opts = {}) {
    const fn = { modbus: deviceIdentify.identifyModbus, s7: deviceIdentify.identifyS7, 'ethernet-ip': deviceIdentify.identifyEip }[kind];
    if (!fn) return null;
    const r = await fn(host, port, opts).catch(() => null);
    if (!r) return null;
    const id = r.identity || {};
    const product = id.productName || id.modelName || id.moduleTypeName || id.orderCode || null;
    const name = product ? `${product} ${host}` : `${r.protocol} ${host}`;
    return {
      verified: true,
      protocol: r.protocol,
      method: r.method,
      identity: r.identity,
      suggestedDevice: { name, protocol: r.protocol, host, port }
    };
  }

  /**
   * OPC UA: a UA-TCP Hello (cheap, rejects anything that is not UA-TCP), then a real
   * GetEndpoints over a security None channel. Bounded by `timeoutMs` per step, cancelled
   * by `signal`; the client is always disconnected. Result (merged into the candidate):
   *   { verified: true, method: 'ua-getendpoints', applicationUri, applicationName, identity }
   *   { verified: false, method: 'ua-hello', identity, note }   Hello answered, GetEndpoints did not
   *   null                                                      not an OPC UA server
   */
  async identifyOpcuaServer(host, port, { timeoutMs = DEFAULTS.identifyTimeoutMs, signal } = {}) {
    const hello = await deviceIdentify.identifyOpcua(host, port, { timeoutMs, signal }).catch(() => null);
    if (!hello || signal?.aborted) return null;
    const endpointUrl = `opc.tcp://${host}:${port}`;
    let endpoints;
    try {
      endpoints = await getEndpointsNone(endpointUrl, { timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted) return null;
      const why = hello.identity?.accepted === false ? `the server refused the Hello (${hello.identity.errorCode})` : `GetEndpoints failed: ${error.message}`;
      return { verified: false, method: 'ua-hello', identity: hello.identity, note: `Answered the OPC UA Hello, but ${why}.` };
    }
    if (signal?.aborted) return null;
    return { verified: true, method: 'ua-getendpoints', ...summarizeEndpoints(endpoints) };
  }

  isScanning() {
    return this.scanning;
  }

  /** Results of the current/last scan, each with its server-side `known` marker. */
  getLastResults() {
    const index = this._knownIndex();
    return this.lastResults.map((r) => this._annotate(r, index));
  }

  /** Everything a page needs after a reload: running flag, scan summary, results. */
  getState() {
    return { scanning: this.scanning, scan: this.scan ? { ...this.scan } : null, results: this.getLastResults() };
  }

  /** Hostless defaults and limits for the UI. */
  describe() {
    const g = (ip) => classifyScanTarget(ip);
    return {
      localSubnet: this.detectLocalSubnet(),
      defaults: { ...DEFAULTS },
      bounds: BOUNDS,
      ports: { mqtt: DEFAULT_MQTT_PORTS, opcua: DEFAULT_OPCUA_PORTS, i3x: DEFAULT_I3X_PORTS, modbus: DEFAULT_MODBUS_PORTS, s7: DEFAULT_S7_PORTS, 'ethernet-ip': DEFAULT_EIP_PORTS },
      limits: { maxHosts: maxHosts() },
      policy: { loopback: g('127.0.0.1').allowed, private: g('192.168.0.1').allowed }
    };
  }

  detectLocalSubnet() {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const octets = addr.address.split('.');
          return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
        }
      }
    }
    return null;
  }

  expandCidr(cidr) {
    const [base, prefixStr] = cidr.split('/');
    const prefix = Number(prefixStr ?? 32);
    const octets = base.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      throw new Error(`Invalid CIDR: ${cidr}`);
    }
    if (Number.isNaN(prefix) || prefix < 16 || prefix > 32) {
      throw new Error('CIDR prefix must be between /16 and /32');
    }

    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const hostBits = 32 - prefix;
    const network = (baseInt >> hostBits << hostBits) >>> 0;
    const count = 2 ** hostBits;

    const hosts = [];
    const start = count > 2 ? 1 : 0; // skip network address for real subnets
    const end = count > 2 ? count - 1 : count; // skip broadcast address
    for (let i = start; i < end; i++) {
      const ip = (network + i) >>> 0;
      hosts.push([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'));
    }
    return hosts;
  }

  probePort(host, port, { timeoutMs = DEFAULTS.timeoutMs, signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const socket = new net.Socket();
      let settled = false;
      const done = (open) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        socket.destroy();
        resolve(open);
      };
      const onAbort = () => done(false);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  /**
   * MQTT CONNECT (anonymous), then DISCONNECT. `transport`: 'tcp' (1883), 'tls' (8883,
   * certificate not checked: we are identifying, not trusting) or 'ws'.
   */
  identifyMqttBroker(host, port, { timeoutMs = DEFAULTS.identifyTimeoutMs, signal, transport } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      const how = transport || (port === 8883 ? 'tls' : 'tcp');
      const scheme = { tcp: 'mqtt', tls: 'mqtts', ws: 'ws' }[how];
      let client;
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        try {
          client?.end(true);
        } catch {
          /* already closed */
        }
        resolve(value);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        client = mqtt.connect(`${scheme}://${host}:${port}`, {
          connectTimeout: timeoutMs,
          reconnectPeriod: 0,
          rejectUnauthorized: false,
          clientId: `manifold-discovery-${crypto.randomBytes(4).toString('hex')}`
        });
      } catch {
        return done(null);
      }
      client.once('connect', (connack) => done({ verified: true, method: 'mqtt-connect', identity: { anonymousAccess: true, transport: how, sessionPresent: Boolean(connack.sessionPresent) } }));
      client.once('error', (error) => {
        // Auth errors still prove an MQTT broker is answering
        if (/not authorized|bad user name|identifier rejected|bad username/i.test(error.message)) {
          done({ verified: true, method: 'mqtt-connect', identity: { anonymousAccess: false, transport: how, reason: error.message } });
        } else done(null);
      });
    });
  }

  // ---- planning ------------------------------------------------------------------------

  /**
   * Validate the request and work out exactly what a scan would do, without touching
   * the network (a hostname is resolved). Throws DiscoveryError with a message a user
   * can act on: bad input, a range the policy refuses (naming the flag that would
   * allow it), or a range too large (naming size, duration and the limit).
   */
  async plan(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new DiscoveryError('Scan options must be an object', 'OPTION_INVALID');
    let range = options.range ? String(options.range).trim() : this.detectLocalSubnet();
    if (!range) throw new DiscoveryError('No scan range provided and no local subnet detected. Enter a range such as 192.168.1.0/24.', 'RANGE_INVALID');

    const settings = {
      concurrency: boundedInt('concurrency', options.concurrency, DEFAULTS.concurrency),
      perHost: boundedInt('perHost', options.perHost, DEFAULTS.perHost),
      timeoutMs: boundedInt('timeoutMs', options.timeoutMs, DEFAULTS.timeoutMs),
      identifyTimeoutMs: boundedInt('identifyTimeoutMs', options.identifyTimeoutMs, DEFAULTS.identifyTimeoutMs)
    };
    const { kinds, mqttWs } = kindsFromOptions(options);

    // Hostnames resolve to one IPv4 address; the guard then judges the address, not the name.
    let resolvedFrom = null;
    const looksNumeric = /^[\d.]+(\/\d+)?$/.test(range);
    if (!looksNumeric && !net.isIPv6(range.replace(/^\[|\]$/g, '').split('/')[0])) {
      if (range.includes('/')) throw new DiscoveryError(`Invalid CIDR: ${range}. Ranges are IPv4 CIDR such as 192.168.1.0/24; a hostname scans just that one host.`, 'RANGE_INVALID');
      if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(range)) throw new DiscoveryError(`"${range}" is not an IPv4 address, CIDR or hostname.`, 'RANGE_INVALID');
      try {
        const r = await this.deps.lookup(range);
        resolvedFrom = range;
        range = r.address;
      } catch {
        throw new DiscoveryError(`Could not resolve the hostname "${range}" to an IPv4 address.`, 'RANGE_INVALID');
      }
    }
    const { base, prefix } = parseRange(range);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new DiscoveryError(`Invalid CIDR: ${range}. The prefix must be 0-32.`, 'RANGE_INVALID');
    if (base.split('.').length !== 4 || base.split('.').some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
      throw new DiscoveryError(`Invalid CIDR: ${range}. Use the form 192.168.1.0/24.`, 'RANGE_INVALID');
    }

    const ports = [];
    const seenPort = new Set();
    for (const kind of KIND_ORDER) for (const p of kinds[kind]) if (!seenPort.has(p)) { seenPort.add(p); ports.push(p); }
    for (const p of mqttWs) if (!seenPort.has(p)) { seenPort.add(p); ports.push(p); }
    if (ports.length === 0) throw new DiscoveryError('No ports selected: pick at least one protocol to look for.', 'OPTION_INVALID');

    // Size before expansion: a /8 must not allocate 16 million strings just to be refused.
    const hostCount = prefix >= 31 ? 2 ** (32 - prefix) : Math.max(0, 2 ** (32 - prefix) - 2);
    const limit = maxHosts();
    const probesFor = (hosts) => hosts * ports.length;
    const slotsFor = (hosts) => Math.max(1, Math.min(settings.concurrency, hosts * Math.min(settings.perHost, ports.length)));
    const worstFor = (hosts) => Math.ceil(probesFor(hosts) / slotsFor(hosts)) * settings.timeoutMs;
    if (hostCount > limit) {
      const chunk = 32 - Math.floor(Math.log2(limit + 2));
      throw new DiscoveryError(
        `${range} is ${fmtInt(hostCount)} hosts (${fmtInt(probesFor(hostCount))} probes with the selected ports), up to about ${fmtDuration(worstFor(hostCount))} if every address is silent. ` +
          `The limit is ${fmtInt(limit)} hosts per scan (a /${chunk}). Scan it in /${chunk} pieces, or raise MANIFOLD_DISCOVERY_MAX_HOSTS if you really mean it.`,
        'RANGE_TOO_LARGE',
        { hosts: hostCount, probes: probesFor(hostCount), maxHosts: limit, worstCaseMs: worstFor(hostCount) }
      );
    }
    let allHosts;
    try {
      allHosts = this.expandCidr(`${base}/${prefix}`);
    } catch (error) {
      throw new DiscoveryError(error.message, 'RANGE_INVALID');
    }

    // Policy: every address is judged by the egress guard. Loopback is honoured (with
    // MANIFOLD_ALLOW_LOOPBACK_DEVICES=1) for every probe kind except i3X: the i3X client
    // reaches servers through the guarded fetch, which never allows loopback, so a found
    // i3X on 127.0.0.1 could not be connected to.
    const counts = {};
    const hosts = [];
    const loopbackHosts = new Set();
    for (const host of allHosts) {
      const c = classifyScanTarget(host);
      if (c.allowed) {
        hosts.push(host);
        if (c.category === 'loopback') loopbackHosts.add(host);
      } else {
        counts[c.category] ||= { count: 0, flag: c.flag };
        counts[c.category].count++;
      }
    }
    if (hosts.length === 0) throw refusal(range, counts);

    const skipped = Object.fromEntries(Object.entries(counts).map(([c, v]) => [c, { count: v.count, flag: v.flag }]));
    const notes = [];
    for (const [c, v] of Object.entries(skipped)) {
      notes.push(`${fmtInt(v.count)} ${CATEGORY_TEXT[c] || c} address${v.count === 1 ? ' was' : 'es were'} skipped${v.flag ? ` (${v.flag}=1 would include them)` : ' (never scanned)'}.`);
    }

    // Jobs: one per host:port; the kinds that listed the port decide how it is identified.
    const kindsOfPort = new Map();
    const note = (p, kind, extra) => {
      const e = kindsOfPort.get(p) || { kinds: [], ws: false };
      if (kind && !e.kinds.includes(kind)) e.kinds.push(kind);
      if (extra === 'ws') e.ws = true;
      kindsOfPort.set(p, e);
    };
    for (const kind of KIND_ORDER) for (const p of kinds[kind]) note(p, kind);
    for (const p of mqttWs) note(p, 'mqtt', 'ws');
    const jobs = [];
    let i3xOnLoopback = 0;
    for (const host of hosts) {
      for (const p of ports) {
        const e = kindsOfPort.get(p);
        const useKinds = loopbackHosts.has(host) ? e.kinds.filter((k) => k !== 'i3x') : e.kinds;
        if (useKinds.length === 0) {
          i3xOnLoopback++;
          continue;
        }
        jobs.push({ host, port: p, kinds: useKinds, ws: e.ws });
      }
    }
    if (i3xOnLoopback) notes.push('i3X is not probed on loopback addresses: the i3X client cannot connect to them.');

    const totalProbes = jobs.length;
    const slots = slotsFor(hosts.length);
    const worstCaseMs = Math.ceil(totalProbes / slots) * settings.timeoutMs;
    return {
      range,
      resolvedFrom,
      hosts,
      jobs,
      ports,
      kinds,
      settings,
      skipped,
      notes,
      totalProbes,
      estimate: {
        // Every address silent (packets dropped): each probe waits out the full connect timeout.
        worstCaseMs,
        // Closed ports answer with a reset in milliseconds; this is what a typical LAN looks like.
        typicalMs: Math.max(1000, Math.ceil(totalProbes / slots) * 25),
        // Added once per open port that accepts a connection and then never answers.
        perOpenPortMs: settings.identifyTimeoutMs * 2,
        slots
      }
    };
  }

  // ---- running -------------------------------------------------------------------------

  async startScan(options = {}) {
    if (this.scanning) {
      const s = this.scan;
      throw new DiscoveryError(
        `A scan of ${s?.range || 'the network'} is already running${s ? ` (${s.completed} of ${s.totalProbes} probes)` : ''}. Stop it first, or wait for it to finish.`,
        'SCAN_RUNNING'
      );
    }
    this.scanning = true; // claimed before the first await so two starts cannot both pass
    let plan;
    try {
      plan = await this.plan(options);
    } catch (error) {
      this.scanning = false;
      throw error;
    }
    return this._run(plan);
  }

  _run(plan) {
    const { range, jobs, settings, totalProbes } = plan;
    const id = crypto.randomBytes(6).toString('hex');
    const startedAt = Date.now();
    const controller = new AbortController();
    const { signal } = controller;
    this.abortRequested = false;
    this._abort = controller;
    this.lastResults = [];
    const results = this.lastResults;
    const scan = {
      id,
      range,
      status: 'running',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
      totalProbes,
      completed: 0,
      open: 0,
      found: 0,
      ports: plan.ports,
      settings,
      estimate: plan.estimate,
      skipped: plan.skipped,
      notes: plan.notes,
      error: null
    };
    this.scan = scan;
    this.io.emit('discovery-started', {
      scanId: id,
      range,
      ports: plan.ports,
      totalProbes,
      blockedHosts: Object.values(plan.skipped).reduce((n, v) => n + v.count, 0),
      skipped: plan.skipped,
      notes: plan.notes,
      settings,
      estimate: plan.estimate,
      startedAt: scan.startedAt
    });

    // Per-host queues + a round-robin dispatcher: at most `concurrency` jobs overall and
    // `perHost` per address (a job holds its slot through the connect AND the identification).
    const queues = new Map();
    for (const job of jobs) {
      if (!queues.has(job.host)) queues.set(job.host, { jobs: [], active: 0 });
      queues.get(job.host).jobs.push(job);
    }
    const order = [...queues.keys()];
    let cursor = 0;
    let active = 0;
    let remaining = jobs.length;
    let lastEmitted = -1;
    let ended = false;

    const eta = () => {
      const left = totalProbes - scan.completed;
      if (left <= 0) return 0;
      const elapsed = Date.now() - startedAt;
      if (scan.completed < 8 || elapsed < 500) return Math.max(0, plan.estimate.worstCaseMs - elapsed);
      return Math.round((elapsed / scan.completed) * left);
    };
    const emitProgress = (force = false) => {
      if (!force && scan.completed === lastEmitted) return;
      lastEmitted = scan.completed;
      this.io.emit('discovery-progress', {
        scanId: id,
        completed: scan.completed,
        total: totalProbes,
        found: scan.found,
        open: scan.open,
        elapsedMs: Date.now() - startedAt,
        etaMs: eta()
      });
    };
    const ticker = setInterval(() => emitProgress(), 250);
    ticker.unref?.();

    const finish = (status, error = null) => {
      if (ended) return;
      ended = true;
      clearInterval(ticker);
      scan.status = status;
      scan.error = error;
      scan.finishedAt = new Date().toISOString();
      scan.found = results.length;
      this.scanning = false;
      this._abort = null;
      if (status === 'error') {
        this.io.emit('discovery-error', { scanId: id, error });
        return;
      }
      emitProgress(true);
      this.io.emit('discovery-complete', {
        scanId: id,
        range,
        status,
        aborted: status === 'cancelled',
        found: results.length,
        elapsedMs: Date.now() - startedAt,
        completed: scan.completed,
        total: totalProbes,
        notes: plan.notes,
        results: this.getLastResults()
      });
      this.emit('done', scan);
    };
    this._finish = finish;

    const runJob = async (job) => {
      const open = await this.probePort(job.host, job.port, { timeoutMs: settings.timeoutMs, signal });
      if (!open || signal.aborted) return null;
      scan.open++;
      const base = { host: job.host, port: job.port, discoveredAt: new Date().toISOString() };
      const identifyOpts = { timeoutMs: settings.identifyTimeoutMs, signal };
      let fallback = null;
      for (const kind of job.kinds) {
        if (signal.aborted) return null;
        if (kind === 'mqtt') {
          const found = await this.identifyMqttBroker(job.host, job.port, { ...identifyOpts, transport: job.ws ? 'ws' : undefined });
          if (found) return { ...base, kind, protocol: 'mqtt', ...found };
          fallback ||= { ...base, kind, protocol: 'mqtt', verified: false, method: 'tcp-connect', note: 'The port is open but did not answer an MQTT CONNECT.' };
        } else if (kind === 'opcua') {
          const found = await this.identifyOpcuaServer(job.host, job.port, identifyOpts).catch(() => null);
          const endpointUrl = `opc.tcp://${job.host}:${job.port}`;
          if (found?.verified) return { ...base, kind, protocol: 'opcua', ...found, endpointUrl };
          // Answered the Hello but not GetEndpoints: still an OPC UA server, honestly unconfirmed.
          // A port that does not answer the Hello at all is not a result (as for devices).
          if (found) fallback ||= { ...base, kind, protocol: 'opcua', ...found, endpointUrl };
        } else if (kind === 'i3x') {
          const found = await this.identifyI3xServer(job.host, job.port, { deadlineMs: settings.identifyTimeoutMs + 1000, signal });
          // An open HTTP port that is not an i3X server is not a result
          if (found) return { ...base, kind, protocol: 'i3x', ...found, identity: { serverName: found.serverName, specVersion: found.specVersion } };
        } else if (DEVICE_KINDS.has(kind)) {
          const found = await this.identifyDevice(kind, job.host, job.port, identifyOpts);
          // An open port that did not answer the protocol is never reported as a device
          if (found) return { ...base, kind, ...found };
        }
      }
      return fallback;
    };

    const startJob = (host, st) => {
      const job = st.jobs.shift();
      st.active++;
      active++;
      remaining--;
      runJob(job)
        .catch(() => null)
        .then((candidate) => {
          st.active--;
          active--;
          scan.completed++;
          if (candidate && !signal.aborted && !ended) {
            candidate.scanId = id;
            results.push(candidate);
            scan.found = results.length;
            this.io.emit('discovery-result', this._annotate(candidate));
          }
          pump();
        });
    };

    const pump = () => {
      if (ended) return;
      while (!signal.aborted && active < settings.concurrency && remaining > 0) {
        let picked = null;
        for (let n = 0; n < order.length; n++) {
          const host = order[(cursor + n) % order.length];
          const st = queues.get(host);
          if (st.jobs.length && st.active < settings.perHost) {
            picked = [host, st];
            cursor = (cursor + n + 1) % order.length;
            break;
          }
        }
        if (!picked) break;
        startJob(picked[0], picked[1]);
      }
      if (!signal.aborted && remaining === 0 && active === 0) finish('complete');
    };

    if (jobs.length === 0) finish('complete');
    else pump();

    return {
      scanId: id,
      range,
      hosts: plan.hosts.length,
      totalProbes,
      ports: plan.ports,
      settings,
      estimate: plan.estimate,
      skipped: plan.skipped,
      notes: plan.notes,
      status: 'scanning'
    };
  }

  /** Cancel the running scan: sockets are destroyed at once and the scan completes as `cancelled`. */
  stopScan() {
    if (!this.scanning || !this._abort) return { status: 'idle' };
    this.abortRequested = true;
    this._abort.abort();
    this._finish?.('cancelled');
    return { status: 'stopping' };
  }
}

DiscoveryService.DiscoveryError = DiscoveryError;
DiscoveryService.DEFAULTS = DEFAULTS;
DiscoveryService.BOUNDS = BOUNDS;
module.exports = DiscoveryService;
