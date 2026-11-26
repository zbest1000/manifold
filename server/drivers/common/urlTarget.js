'use strict';

/**
 * The one URL-device model shared by every URL-based driver: HTTP (http-json, mtconnect, see
 * ./httpClient.js) and WebSocket (matter-server, zwave-js, see ./wsTarget.js).
 *
 * A device URL such as https://meter.local:8443/api/v1 or wss://ha.local:5580/ws is stored in flat
 * device fields with the same names for every driver:
 *   scheme             http | https, or ws | wss
 *   host, port         the generic device fields (the main process resolves, checks and pins host)
 *   path               the part after host:port. HTTP: a prefix in front of every request path
 *                      (empty = the root); WebSocket: the endpoint itself (default per driver)
 *   authToken          the bearer token ("Authorization: Bearer"), a `password` field
 *   tlsInsecure        explicit "do not verify the TLS certificate" opt-out
 *   tlsCa              an extra CA (PEM) trusted in addition to the system roots
 *   tlsFingerprint256  a pinned SHA-256 certificate fingerprint; replaces chain validation
 *
 * The connection always goes to the pinned address (device.pinned.addresses, via connectAddress);
 * the configured name is sent as Host and as TLS SNI, and the certificate is checked against it.
 * The name is never resolved again in the driver process.
 */

const tls = require('tls');
const net = require('net');

function hasControl(text) {
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const present = (v) => v !== undefined && v !== null && v !== '';

/** A request path must stay on the device: origin-form only, no scheme, no fragment, no control characters. */
function checkRequestPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return 'path must start with "/"';
  if (p.startsWith('//')) return 'path must not start with "//"';
  if (/[\s\\#]/.test(p) || hasControl(p)) return 'path must not contain spaces, backslashes, "#" or control characters';
  if (/^\/[^?]*:\/\//.test(p) || /(^|\/)\.\.(\/|\?|$)/.test(p)) return 'path must not contain "://" or ".." segments';
  return null;
}

/** "api/v1/" -> "/api/v1"; "" or "/" -> "" (a prefix). */
function normalizePrefixPath(p) {
  const b = String(p ?? '').trim();
  if (!b || b === '/') return '';
  const withSlash = b.startsWith('/') ? b : `/${b}`;
  return withSlash.replace(/\/+$/, '');
}

function normalizeFingerprint(fp) {
  return String(fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** A PEM pasted into a single-line field loses its newlines: re-wrap the base64 bodies. */
function normalizePem(text) {
  const s = String(text || '').trim();
  if (!s) return undefined;
  const out = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let m;
  while ((m = re.exec(s))) {
    const body = m[2].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) return null;
    out.push(`-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`);
  }
  return out.length ? out.join('') : null;
}

/**
 * The TLS fields of a device. Ignored (all off) when the scheme is not secure: the form hides them then.
 * @returns {{ errors: string[], tls: { insecure: boolean, ca?: string, fingerprint?: string } }}
 */
function tlsSettings(device, secure) {
  const errors = [];
  const out = { insecure: false, ca: undefined, fingerprint: undefined };
  if (!secure) return { errors, tls: out };
  out.insecure = device.tlsInsecure === true;
  if (present(device.tlsCa)) {
    const pem = normalizePem(device.tlsCa);
    if (!pem) errors.push('tlsCa must contain a PEM certificate (-----BEGIN CERTIFICATE-----)');
    else out.ca = pem;
  }
  if (present(device.tlsFingerprint256)) {
    const fp = normalizeFingerprint(device.tlsFingerprint256);
    if (fp.length !== 64) errors.push('tlsFingerprint256 must be a SHA-256 fingerprint (64 hexadecimal digits, colons optional)');
    else out.fingerprint = fp;
  }
  return { errors, tls: out };
}

/** The bearer token field, checked: a single header-safe word. Returns { errors, headers }. */
function bearerHeaders(token, { required = false } = {}) {
  const errors = [];
  const headers = {};
  if (!present(token)) {
    if (required) errors.push('authToken is required for bearer authentication');
  } else if (typeof token !== 'string' || hasControl(token) || /\s/.test(token)) {
    errors.push('authToken must be a single word without spaces or control characters');
  } else headers.authorization = `Bearer ${token}`;
  return { errors, headers };
}

/**
 * tls.connect options for a connection to the pinned `address` that presents and verifies the
 * configured `hostname` (SNI and certificate identity). A fingerprint pin turns chain validation off;
 * the caller must then call fingerprintProblem() on 'secureConnect' before sending anything.
 */
function tlsConnectOptions({ address, port, hostname, tls: t = {} }) {
  return {
    host: address,
    port,
    servername: net.isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: !(t.insecure || t.fingerprint),
    ca: t.ca,
    checkServerIdentity: (_h, cert) => tls.checkServerIdentity(hostname, cert)
  };
}

/** After the TLS handshake: an Error when the peer certificate does not match the pin, else null. */
function fingerprintProblem(socket, want) {
  if (!want) return null;
  const cert = socket.getPeerCertificate();
  const got = normalizeFingerprint(cert && cert.fingerprint256);
  return got === want ? null : new Error(`server certificate fingerprint ${got || 'unknown'} does not match the pinned fingerprint`);
}

/**
 * Descriptor fields of the URL parts every URL driver shows, with the same names, types and
 * conditions everywhere. Each family adds its own authentication fields.
 * @param {{ schemes: string[], secure: string, schemeHelp: string, path: { default?: string, placeholder?: string, optional?: boolean, help: string } }} o
 * @returns {{ scheme: object, path: object, tls: object[] }}
 */
function urlFields({ schemes, secure, schemeHelp, path }) {
  const when = { scheme: [secure] };
  return {
    scheme: { name: 'scheme', label: 'Scheme', type: 'select', default: schemes[0], options: schemes, help: schemeHelp },
    path: {
      name: 'path',
      label: 'Path',
      type: 'string',
      ...(path.default !== undefined ? { default: path.default } : {}),
      ...(path.optional ? { optional: true } : {}),
      placeholder: path.placeholder ?? path.default,
      help: path.help
    },
    tls: [
      { name: 'tlsInsecure', showWhen: when, label: 'Do not verify the TLS certificate', type: 'boolean', default: false, help: 'Accepts any certificate, so the connection can be intercepted. Prefer a CA or fingerprint below.' },
      { name: 'tlsCa', showWhen: when, label: 'CA certificate (PEM)', type: 'string', optional: true, help: 'Trust this CA in addition to the system roots, for a device or proxy with a private CA.' },
      { name: 'tlsFingerprint256', showWhen: when, label: 'Pinned certificate fingerprint (SHA-256)', type: 'string', optional: true, help: 'Accept only the certificate with this fingerprint (for a self-signed device). Replaces chain validation.' }
    ]
  };
}

module.exports = {
  hasControl,
  checkRequestPath,
  normalizePrefixPath,
  normalizeFingerprint,
  normalizePem,
  tlsSettings,
  bearerHeaders,
  tlsConnectOptions,
  fingerprintProblem,
  urlFields
};
