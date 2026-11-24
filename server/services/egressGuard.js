'use strict';

const dns = require('dns');
const net = require('net');
const { Agent, fetch: undiciFetch } = require('undici');

/**
 * Egress guard — one chokepoint every outbound connection the *caller* cannot
 * make directly (network scan probes, i3X / CESMII / broker-admin HTTP fetches,
 * alert webhooks) must pass through, so Manifold cannot be turned into an SSRF
 * pivot or an internal port scanner.
 *
 * Two tiers of blocking:
 *
 *  - ALWAYS blocked, no opt-out — ranges that have no legitimate reason to be a
 *    broker / i3X / scan target and are the classic SSRF crown jewels:
 *    loopback, the cloud-metadata link-local block (169.254.0.0/16 incl.
 *    169.254.169.254), IPv6 link-local, unspecified, multicast, and reserved /
 *    carrier-grade-NAT space. IPv6 forms that embed an IPv4 address (mapped in
 *    dotted or hex form, NAT64, 6to4, SIIT) are classified by the embedded
 *    address; IPv4-compatible, Teredo and local-use NAT64 are blocked outright.
 *
 *  - Blocked BY DEFAULT (fail-closed), allowed with MANIFOLD_ALLOW_PRIVATE_TARGETS=1
 *    — RFC1918 and IPv6 ULA. This is the SSRF-sensitive tier: an internet-exposed
 *    instance must not become a pivot into a LAN. On-prem/LAN deployments, where
 *    Discovery scanning the plant subnet and reaching on-prem i3X/CESMII is the
 *    point, opt in explicitly. The server logs a loud startup warning whenever
 *    this opt-in is on.
 *
 * Hostnames are resolved and every returned address is checked before the
 * connection is made. `guardedFetch` additionally closes the resolve-then-connect
 * (DNS rebinding) window: it uses an undici Agent whose connect-time `lookup`
 * re-validates every address the socket is actually about to use, so the
 * address that was checked IS the address that is connected to. It follows
 * redirects manually (bounded) and re-validates every hop.
 *
 * Limitation: `assertAllowedTarget` / `assertAllowedDeviceTarget` are
 * check-only helpers for clients we cannot route through `guardedFetch`
 * (pg, mqtt.js, node-opcua open their own sockets). They resolve and check,
 * but the library re-resolves when it connects, so those paths keep a small
 * DNS-rebinding window. Literal IPs have no such window.
 *
 * Device targets (PLCs, simulators): `assertAllowedDeviceTarget` additionally
 * allows loopback when MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 (default off) so local
 * simulators work. Cloud-metadata ranges stay blocked always; RFC1918 still
 * needs MANIFOLD_ALLOW_PRIVATE_TARGETS=1.
 */

// The exported constants are load-time snapshots for the startup warnings; the
// policy functions re-read the environment so behaviour is never stale.
const envFlag = (name) => process.env[name] === '1';
const allowPrivate = () => envFlag('MANIFOLD_ALLOW_PRIVATE_TARGETS');
const allowLoopbackDevices = () => envFlag('MANIFOLD_ALLOW_LOOPBACK_DEVICES');
const ALLOW_PRIVATE = allowPrivate();
const ALLOW_LOOPBACK_DEVICES = allowLoopbackDevices();

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidrV4(ipInt, baseIp, prefix) {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

// Never-legitimate IPv4 ranges — blocked regardless of the private opt-in.
const HARD_BLOCK_V4 = [
  ['0.0.0.0', 8], // "this host"
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local INCLUDING 169.254.169.254 cloud metadata
  ['168.63.129.16', 32], // Azure wireserver / metadata helper
  ['100.64.0.0', 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ['192.0.0.0', 24], // IETF protocol assignments (also Oracle metadata 192.0.0.192)
  ['192.0.2.0', 24], // TEST-NET-1
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved
];

// RFC1918 — dual-use on a plant LAN, blocked unless the operator opts in.
const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
];

// Internal: { cls: 'public'|'private'|'hard-blocked'|'invalid', loopback }.
// `loopback` marks the ONLY hard-blocked range a device target may opt into.
const detail = (cls, loopback = false) => ({ cls, loopback });

function classifyV4Detail(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return detail('invalid');
  if (inCidrV4(ipInt, '127.0.0.0', 8)) return detail('hard-blocked', true);
  if (HARD_BLOCK_V4.some(([b, p]) => inCidrV4(ipInt, b, p))) return detail('hard-blocked');
  if (PRIVATE_V4.some(([b, p]) => inCidrV4(ipInt, b, p))) return detail('private');
  return detail('public');
}

function classifyV4(ip) {
  return classifyV4Detail(ip).cls;
}

/**
 * Parse a (net.isIP-validated) IPv6 literal into eight 16-bit groups.
 * Handles `::` compression, a trailing dotted IPv4 and strips a zone id.
 */
function parseV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]);
    if (v4 === null) return null;
    s = `${dotted[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

const v4FromGroups = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

function classifyV6Detail(ip) {
  const g = parseV6(ip);
  if (!g) return detail('invalid');
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);

  if (zeros(0, 8)) return detail('hard-blocked'); // :: unspecified
  if (zeros(0, 7) && g[7] === 1) return detail('hard-blocked', true); // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d (dotted OR hex form ::ffff:7f00:1) — classify the embedded v4.
  if (zeros(0, 5) && g[5] === 0xffff) return classifyV4Detail(v4FromGroups(g[6], g[7]));
  // IPv4-translated (SIIT) ::ffff:0:a.b.c.d
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return classifyV4Detail(v4FromGroups(g[6], g[7]));
  // IPv4-compatible ::a.b.c.d (deprecated, never legitimate as a target)
  if (zeros(0, 6)) return detail('hard-blocked');
  // NAT64 well-known prefix 64:ff9b::/96 — classify the embedded v4;
  // local-use 64:ff9b:1::/48 (RFC 8215) and the rest of 64:ff9b::/32: block.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    return zeros(2, 6) ? classifyV4Detail(v4FromGroups(g[6], g[7])) : detail('hard-blocked');
  }
  // 6to4 2002::/16 embeds a v4 address in groups 1-2.
  if (g[0] === 0x2002) return classifyV4Detail(v4FromGroups(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) return detail('hard-blocked'); // Teredo (obfuscated v4)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return detail('hard-blocked'); // documentation
  if ((g[0] & 0xffc0) === 0xfe80) return detail('hard-blocked'); // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return detail('hard-blocked'); // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return detail('hard-blocked'); // ff00::/8 multicast
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return detail('hard-blocked'); // AWS IPv6 metadata fd00:ec2::254
  if ((g[0] & 0xfe00) === 0xfc00) return detail('private'); // fc00::/7 unique-local
  return detail('public');
}

function classifyV6(ip) {
  return classifyV6Detail(ip).cls;
}

function classifyDetail(ip) {
  const version = net.isIP(ip);
  if (version === 4) return classifyV4Detail(ip);
  if (version === 6) return classifyV6Detail(ip);
  return detail('invalid');
}

function classifyAddress(ip) {
  return classifyDetail(ip).cls;
}

/**
 * True if a raw IP string is an acceptable connection target under current
 * policy. `{ device: true }` additionally permits loopback when
 * MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 (metadata ranges are never permitted).
 */
function isAllowedAddress(ip, { device = false } = {}) {
  const { cls, loopback } = classifyDetail(ip);
  if (cls === 'public') return true;
  if (cls === 'private') return allowPrivate();
  if (loopback && device) return allowLoopbackDevices();
  return false; // hard-blocked or invalid
}

class EgressBlockedError extends Error {
  constructor(target, reason, purpose) {
    super(
      `Egress${purpose ? ` (${purpose})` : ''} to ${target} blocked: ${reason}.` +
        (reason === 'private/internal address'
          ? ' Set MANIFOLD_ALLOW_PRIVATE_TARGETS=1 to allow RFC1918/LAN targets (safe only on a trusted network).'
          : '')
    );
    this.name = 'EgressBlockedError';
    this.target = target;
    this.code = 'EGRESS_BLOCKED';
  }
}

function reasonFor(cls) {
  if (cls === 'invalid') return 'unresolvable or malformed address';
  if (cls === 'hard-blocked') return 'loopback/link-local/reserved address';
  return 'private/internal address';
}

/** Extract the hostname from a URL, `host:port`, `[v6]:port`, or bare host/IP. */
function hostFromTarget(hostOrUrl) {
  const raw = String(hostOrUrl ?? '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  if (net.isIP(raw)) return raw; // bare v4 or v6 literal
  const colon = raw.indexOf(':');
  if (colon !== -1 && colon === raw.lastIndexOf(':')) return raw.slice(0, colon);
  return raw;
}

const promisedLookup = (host, opts) => dns.promises.lookup(host, opts);

/**
 * Resolve `host` and throw EgressBlockedError unless every resolved address is
 * allowed. A literal IP is checked directly (no DNS). Resolves to the list of
 * validated addresses. `lookup` is a test seam (dns.promises.lookup-compatible).
 */
async function assertAllowedHost(host, { device = false, purpose, lookup = promisedLookup } = {}) {
  if (!host) throw new EgressBlockedError(String(host), 'unresolvable or malformed address', purpose);
  if (net.isIP(host)) {
    if (!isAllowedAddress(host, { device })) {
      throw new EgressBlockedError(host, reasonFor(classifyAddress(host)), purpose);
    }
    return [host];
  }
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new EgressBlockedError(host, 'unresolvable or malformed address', purpose);
  }
  if (!records.length) throw new EgressBlockedError(host, 'unresolvable or malformed address', purpose);
  for (const { address } of records) {
    if (!isAllowedAddress(address, { device })) {
      throw new EgressBlockedError(`${host} (${address})`, reasonFor(classifyAddress(address)), purpose);
    }
  }
  return records.map((r) => r.address);
}

/**
 * Check-only helper for outbound targets whose client opens its own socket and
 * so cannot go through `guardedFetch` (historian URLs, TimescaleDB/pg hosts,
 * ...). Accepts a URL, `host:port` or bare host. Throws EgressBlockedError
 * (code 'EGRESS_BLOCKED'); `purpose` appears in the message. Call it before
 * connecting AND whenever the stored host/URL changes. Residual risk: DNS
 * rebinding between this check and the library's own resolution.
 */
async function assertAllowedTarget(hostOrUrl, { purpose, lookup } = {}) {
  return assertAllowedHost(hostFromTarget(hostOrUrl), { purpose, lookup });
}

/**
 * Like assertAllowedTarget, for southbound DEVICE-driver targets (Modbus, OPC UA,
 * MQTT brokers, ...). Identical policy except loopback is permitted when
 * MANIFOLD_ALLOW_LOOPBACK_DEVICES=1 (local simulators). Cloud-metadata ranges are
 * always blocked and RFC1918 still needs MANIFOLD_ALLOW_PRIVATE_TARGETS=1.
 */
async function assertAllowedDeviceTarget(hostOrUrl, { purpose = 'device', lookup } = {}) {
  return assertAllowedHost(hostFromTarget(hostOrUrl), { device: true, purpose, lookup });
}

// ---- guardedFetch ------------------------------------------------------------

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

// connect-time lookup: validate every address the socket may use, so the address
// that was checked is the address that is connected to (closes DNS rebinding).
function pinnedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...(options || {}), all: true }, (err, records) => {
    if (err) return callback(err);
    const bad = records.find((r) => !isAllowedAddress(r.address));
    if (bad || !records.length) {
      return callback(
        new EgressBlockedError(
          `${hostname} (${bad ? bad.address : 'no address'})`,
          reasonFor(bad ? classifyAddress(bad.address) : 'invalid')
        )
      );
    }
    if (options && options.all) return callback(null, records);
    return callback(null, records[0].address, records[0].family);
  });
}

let sharedAgent = null;
function getAgent() {
  if (!sharedAgent) sharedAgent = new Agent({ connect: { lookup: pinnedLookup } });
  return sharedAgent;
}

/**
 * fetch with an SSRF pre-check, connect-time address pinning, manual redirect
 * handling (each hop re-validated, max 5) and one overall deadline.
 * `deps` ({ fetch, lookup }) is a test seam; when `deps.fetch` is given the
 * connect-time pin is the caller's problem.
 */
async function guardedFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {}) {
  const doFetch = deps.fetch || ((u, o) => undiciFetch(u, { ...o, dispatcher: getAgent() }));
  const signal = AbortSignal.timeout(timeoutMs);
  let current;
  try {
    current = new URL(url);
  } catch {
    throw new EgressBlockedError(String(url), 'unresolvable or malformed address');
  }
  let opts = { ...options, redirect: 'manual', signal };
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new EgressBlockedError(current.protocol, 'only http(s) is allowed');
    }
    await assertAllowedHost(current.hostname.replace(/^\[|\]$/g, ''), { lookup: deps.lookup });
    let res;
    try {
      res = await doFetch(current.toString(), opts);
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
    const location = res.headers && res.headers.get && res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (hop >= MAX_REDIRECTS) {
      throw new EgressBlockedError(String(url), `too many redirects (max ${MAX_REDIRECTS})`);
    }
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new EgressBlockedError(String(location), 'unresolvable or malformed address');
    }
    const method = String(opts.method || 'GET').toUpperCase();
    const toGet = res.status === 303 ? method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST';
    const headers = { ...(opts.headers || {}) };
    if (next.origin !== current.origin) {
      for (const k of Object.keys(headers)) {
        if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete headers[k];
      }
    }
    opts = { ...opts, headers };
    if (toGet) {
      opts.method = 'GET';
      delete opts.body;
      for (const k of Object.keys(headers)) if (/^content-(type|length)$/i.test(k)) delete headers[k];
    }
    current = next;
  }
}

module.exports = {
  guardedFetch,
  assertAllowedHost,
  assertAllowedTarget,
  assertAllowedDeviceTarget,
  isAllowedAddress,
  classifyAddress,
  hostFromTarget,
  EgressBlockedError,
  ALLOW_PRIVATE,
  ALLOW_LOOPBACK_DEVICES,
  MAX_REDIRECTS,
  _pinnedLookup: pinnedLookup // exported for tests
};
