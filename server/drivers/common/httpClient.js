'use strict';

/**
 * Read-only HTTP client shared by the URL-based drivers (http-json, mtconnect).
 *
 *  - GET only. There is no method parameter and no request body anywhere in this file;
 *    the single `http(s).request` call below hard-codes GET.
 *  - The connection goes to the address the main process validated and pinned
 *    (`device.pinned.addresses`), through the agent's `lookup`; Host and the TLS SNI name keep
 *    the configured host name. The name is never resolved again here.
 *  - Redirects are followed by hand, at most MAX_REDIRECTS, and only to the same host, port and
 *    scheme. Anything else is reported, never followed, so credentials cannot leave the device.
 *  - The response is read with a hard size cap and the request has one overall deadline.
 *  - TLS is verified by default. Per device: an extra CA, a pinned SHA-256 fingerprint
 *    (replaces chain validation), or an explicit "do not verify" opt-out.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { connectAddress } = require('../runtime/pinnedAddress');

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1024 * 1024;

class HttpError extends Error {
  /** @param {'timeout'|'transport'|'too-large'|'redirect'|'tls'|'encoding'} kind */
  constructor(kind, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function hasControl(text) {
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A request target must stay on the device: origin-form only, no scheme, no fragment, no control characters. */
function checkRequestPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return 'path must start with "/"';
  if (p.startsWith('//')) return 'path must not start with "//"';
  if (/[\s\\#]/.test(p) || hasControl(p)) return 'path must not contain spaces, backslashes, "#" or control characters';
  if (/^\/[^?]*:\/\//.test(p) || /(^|\/)\.\.(\/|\?|$)/.test(p)) return 'path must not contain "://" or ".." segments';
  return null;
}

function normalizeBasePath(base) {
  const b = String(base ?? '').trim();
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
 * Validate the connection fields shared by URL-based devices. Returns { errors, value }.
 * `device` carries scheme, basePath, auth*, tls* (flat names; the secret ones match the
 * credential-name pattern the config export and audit log redact by).
 */
function normalizeConnection(device) {
  const errors = [];
  const scheme = device.scheme === undefined || device.scheme === '' ? 'http' : device.scheme;
  if (scheme !== 'http' && scheme !== 'https') errors.push('scheme must be "http" or "https"');
  const authType = device.authType || 'none';
  if (!['none', 'basic', 'bearer', 'header'].includes(authType)) errors.push('authType must be none, basic, bearer or header');
  const auth = { type: authType };
  if (authType === 'basic') {
    if (typeof device.authUsername !== 'string' || !device.authUsername) errors.push('authUsername is required for basic authentication');
    else if (device.authUsername.includes(':') || hasControl(device.authUsername)) errors.push('authUsername must not contain ":" or control characters');
    auth.username = device.authUsername;
    auth.password = typeof device.authPassword === 'string' ? device.authPassword : '';
    if (hasControl(auth.password)) errors.push('authPassword must not contain control characters');
  } else if (authType === 'bearer') {
    if (typeof device.authToken !== 'string' || !device.authToken) errors.push('authToken is required for bearer authentication');
    else if (hasControl(device.authToken)) errors.push('authToken must not contain control characters');
    auth.token = device.authToken;
  } else if (authType === 'header') {
    if (typeof device.authHeaderName !== 'string' || !HEADER_NAME_RE.test(device.authHeaderName)) errors.push('authHeaderName must be a valid HTTP header name');
    else if (/^(host|content-length|transfer-encoding|connection)$/i.test(device.authHeaderName)) errors.push('authHeaderName must not be a header the client controls');
    if (typeof device.authHeaderSecret !== 'string' || !device.authHeaderSecret) errors.push('authHeaderSecret is required for header authentication');
    else if (hasControl(device.authHeaderSecret)) errors.push('authHeaderSecret must not contain control characters');
    auth.headerName = device.authHeaderName;
    auth.headerValue = device.authHeaderSecret;
  }
  const basePath = normalizeBasePath(device.basePath);
  if (basePath) {
    const why = checkRequestPath(basePath);
    if (why) errors.push(`basePath: ${why}`);
  }
  const tls = { insecure: Boolean(device.tlsInsecure), ca: undefined, fingerprint: undefined };
  if (device.tlsCa !== undefined && device.tlsCa !== '' && device.tlsCa !== null) {
    const pem = normalizePem(device.tlsCa);
    if (!pem) errors.push('tlsCa must contain a PEM certificate (-----BEGIN CERTIFICATE-----)');
    else tls.ca = pem;
  }
  if (device.tlsFingerprint256 !== undefined && device.tlsFingerprint256 !== '' && device.tlsFingerprint256 !== null) {
    const fp = normalizeFingerprint(device.tlsFingerprint256);
    if (fp.length !== 64) errors.push('tlsFingerprint256 must be a SHA-256 fingerprint (64 hexadecimal digits, colons optional)');
    else tls.fingerprint = fp;
  }
  // TLS settings are meaningless on plain http: ignored, not an error (the form hides them for http).
  if (scheme === 'http') Object.assign(tls, { insecure: false, ca: undefined, fingerprint: undefined });
  return { errors, value: { scheme, auth, basePath, tls } };
}

/** The secret fields the chosen authentication actually uses; the rest are not kept. */
function activeSecretFields(device) {
  const t = device && device.authType;
  return t === 'basic' ? ['authPassword'] : t === 'bearer' ? ['authToken'] : t === 'header' ? ['authHeaderSecret'] : [];
}

function authHeaders(auth) {
  if (auth.type === 'basic') return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` };
  if (auth.type === 'bearer') return { authorization: `Bearer ${auth.token}` };
  if (auth.type === 'header') return { [auth.headerName]: auth.headerValue };
  return {};
}

const TLS_CODES = /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|EPROTO)/;

function classify(e) {
  if (e instanceof HttpError) return e;
  const code = e && e.code ? String(e.code) : '';
  const msg = e && e.message ? e.message : String(e);
  if (TLS_CODES.test(code) || /fingerprint|certificate/i.test(msg)) return new HttpError('tls', `TLS: ${msg}`, { code });
  return new HttpError('transport', code ? `${code}: ${msg}` : msg, { code });
}

class HttpClient {
  /**
   * @param {object} o
   * @param {object} o.device the device config (only `pinned` is read, to pick the address)
   * @param {string} o.host configured host name or IP
   * @param {number} o.port
   * @param {{scheme:string, auth:object, basePath:string, tls:object}} o.conn from normalizeConnection
   * @param {number} [o.maxBytes]
   * @param {boolean} [o.keepAlive]
   * @param {string} [o.userAgent]
   * @param {Function} [o.assertTarget] async (host) => void, run for literal-IP hosts before a redirect is followed
   */
  constructor(o) {
    this.host = String(o.host).replace(/^\[|\]$/g, '');
    this.port = o.port;
    this.scheme = o.conn.scheme;
    this.auth = o.conn.auth;
    this.basePath = o.conn.basePath;
    this.tls = o.conn.tls;
    this.maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
    this.userAgent = o.userAgent || 'manifold-device-driver';
    this.assertTarget = o.assertTarget || null;
    this.address = connectAddress({ ...o.device, host: this.host });
    this.pinned = this.address !== this.host;
    this.isHttps = this.scheme === 'https';
    const lookup = (hostname, options, cb) => {
      const family = net.isIPv6(this.address) ? 6 : 4;
      if (typeof options === 'function') return options(null, this.address, family);
      if (options && options.all) return cb(null, [{ address: this.address, family }]);
      return cb(null, this.address, family);
    };
    const agentOpts = { keepAlive: o.keepAlive !== false, maxSockets: 1, maxFreeSockets: 1, lookup };
    if (this.isHttps) {
      if (this.tls.ca) agentOpts.ca = this.tls.ca;
      if (this.tls.insecure) agentOpts.rejectUnauthorized = false;
      if (this.tls.fingerprint) agentOpts.rejectUnauthorized = false; // the pin replaces chain validation
    }
    this.keepAlive = o.keepAlive !== false;
    this.agent = this.isHttps ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
    if (this.isHttps && this.tls.fingerprint) this._pinFingerprint(this.tls.fingerprint);
  }

  /**
   * Fingerprint pinning. `checkServerIdentity` is skipped by Node when chain validation already
   * failed (the normal case for a self-signed device), so it cannot carry the pin. Instead the
   * agent hands the socket to the request only after the handshake, once the peer certificate's
   * SHA-256 fingerprint matched; no request byte is written before that.
   */
  _pinFingerprint(want) {
    this.agent.createConnection = (options, cb) => {
      let done = false;
      const finish = (err, sock) => {
        if (done) return;
        done = true;
        cb(err, sock);
      };
      const sock = tls.connect(options);
      sock.once('secureConnect', () => {
        const cert = sock.getPeerCertificate();
        const got = normalizeFingerprint(cert && cert.fingerprint256);
        if (got !== want) {
          const err = new Error(`server certificate fingerprint ${got || 'unknown'} does not match the pinned fingerprint`);
          sock.destroy();
          finish(err);
        } else finish(null, sock);
      });
      sock.once('error', (err) => finish(err));
      return undefined;
    };
  }

  /** Host[:port] as it appears in the Host header, for messages. */
  authority() {
    const def = this.isHttps ? 443 : 80;
    const h = net.isIPv6(this.host) ? `[${this.host}]` : this.host;
    return this.port === def ? h : `${h}:${this.port}`;
  }

  /** The full request target for a device-relative path. */
  target(p) {
    const why = checkRequestPath(p);
    if (why) throw new HttpError('transport', `invalid path "${p}": ${why}`);
    return `${this.basePath}${p}`;
  }

  /**
   * GET one device-relative path (redirects to the same origin are followed).
   * @param {string} p path (and optional query) relative to the base path
   * @param {{deadlineAt?:number, timeoutMs?:number, headers?:object, maxBytes?:number, accept?:string}} [opts]
   * @returns {Promise<{status:number, headers:object, body:Buffer}>}
   * @throws {HttpError}
   */
  async get(p, opts = {}) {
    const deadlineAt = opts.deadlineAt || Date.now() + (opts.timeoutMs || 5000);
    let target = this.target(p);
    for (let hop = 0; ; hop++) {
      const res = await this._once(target, deadlineAt, opts);
      if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return res;
      if (hop >= MAX_REDIRECTS) throw new HttpError('redirect', `too many redirects (more than ${MAX_REDIRECTS})`);
      target = await this._redirectTarget(target, String(res.headers.location));
    }
  }

  async _redirectTarget(from, location) {
    let next;
    try {
      next = new URL(location, `${this.scheme}://${net.isIPv6(this.host) ? `[${this.host}]` : this.host}:${this.port}${from}`);
    } catch {
      throw new HttpError('redirect', `redirect to an unparseable address "${location.slice(0, 80)}"`);
    }
    const sameHost = next.hostname.replace(/^\[|\]$/g, '').toLowerCase() === this.host.toLowerCase();
    const nextPort = next.port ? Number(next.port) : next.protocol === 'https:' ? 443 : 80;
    if (next.protocol !== `${this.scheme}:` || !sameHost || nextPort !== this.port) {
      throw new HttpError('redirect', `redirect to another host, port or scheme (${next.protocol}//${next.host}) refused; set the device's real address`, {
        location: `${next.protocol}//${next.host}`
      });
    }
    // The pinned address was validated for this host; a literal IP has no pin, so check it again.
    if (!this.pinned && this.assertTarget) {
      try {
        await this.assertTarget(this.host);
      } catch (e) {
        throw new HttpError('redirect', `redirect target blocked: ${e.message}`);
      }
    }
    const t = `${next.pathname}${next.search}`;
    const why = checkRequestPath(t);
    if (why) throw new HttpError('redirect', `redirect to an unusable path: ${why}`);
    return t;
  }

  _once(target, deadlineAt, opts) {
    return new Promise((resolve, reject) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return reject(new HttpError('timeout', 'request timed out'));
      const maxBytes = opts.maxBytes || this.maxBytes;
      let settled = false;
      let req = null;
      let timer = null;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      timer = setTimeout(() => {
        finish(reject, new HttpError('timeout', 'no complete response within the deadline'));
        if (req) req.destroy();
      }, remaining);
      const headers = {
        accept: opts.accept || 'application/json, */*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': this.userAgent,
        ...(this.keepAlive ? {} : { connection: 'close' }),
        ...authHeaders(this.auth),
        ...(opts.headers || {})
      };
      const mod = this.isHttps ? https : http;
      try {
        // The one request this module can make: GET, no body.
        req = mod.request({ agent: this.agent, method: 'GET', host: this.host, port: this.port, path: target, headers }, (res) => {
          const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase();
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            finish(reject, new HttpError('too-large', `response of ${declared} bytes exceeds the ${maxBytes} byte limit`));
            req.destroy();
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              finish(reject, new HttpError('too-large', `response exceeds the ${maxBytes} byte limit`));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (enc !== 'identity' && size > 0) return finish(reject, new HttpError('encoding', `unsupported Content-Encoding "${enc}"`));
            finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks, size) });
          });
          res.on('error', (e) => finish(reject, classify(e)));
          res.on('aborted', () => finish(reject, new HttpError('transport', 'connection closed before the response was complete')));
        });
      } catch (e) {
        finish(reject, classify(e));
        return;
      }
      req.on('error', (e) => finish(reject, classify(e)));
      req.end();
    });
  }

  close() {
    try {
      this.agent.destroy();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { activeSecretFields, HttpClient, HttpError, normalizeConnection, normalizeBasePath, checkRequestPath, normalizePem, authHeaders, DEFAULT_MAX_BYTES, MAX_REDIRECTS };
