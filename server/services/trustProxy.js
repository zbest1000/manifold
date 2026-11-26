'use strict';

const net = require('net');

/**
 * MANIFOLD_TRUST_PROXY -> Express's `trust proxy` setting. Off by default: then the client address is
 * the TCP peer and X-Forwarded-For is ignored. Behind a reverse proxy that peer is the proxy for every
 * user, so the rate limit, the auth-failure throttle and the audit log see one client; set this to name
 * the proxy and they use the forwarded client address instead.
 *
 *   a number N            trust N proxy hops in front of Manifold (1 = one reverse proxy)
 *   addresses / subnets   trust only these proxies, comma-separated (10.0.0.5, 10.0.1.0/24),
 *                         or Express's names loopback, linklocal, uniquelocal
 *
 * `true` (trust any hop) is refused: every client could then pick its own address with X-Forwarded-For
 * and step around the rate limit.
 * @returns {{ value: false|number|string, warning: string|null }}
 */
function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v || /^(0|false|off|no)$/i.test(v)) return { value: false, warning: null };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 1 && n <= 10) return { value: n, warning: null };
    return { value: false, warning: `MANIFOLD_TRUST_PROXY=${v}: use 1-10 hops; trust proxy stays off` };
  }
  if (/^(true|yes|on|all)$/i.test(v)) {
    return { value: false, warning: 'MANIFOLD_TRUST_PROXY=true would trust any X-Forwarded-For; name the hop count (1) or the proxy addresses instead. trust proxy stays off' };
  }
  const NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
  const ok = parts.every((p) => {
    if (NAMES.has(p)) return true;
    const [addr, bits, extra] = p.split('/');
    if (extra !== undefined || !net.isIP(addr)) return false;
    if (bits === undefined) return true;
    const max = net.isIP(addr) === 4 ? 32 : 128;
    return /^\d+$/.test(bits) && Number(bits) <= max;
  });
  if (!ok || !parts.length) return { value: false, warning: `MANIFOLD_TRUST_PROXY=${v} is not a hop count or a list of addresses/subnets; trust proxy stays off` };
  return { value: parts.join(','), warning: null };
}

module.exports = { parseTrustProxy };
