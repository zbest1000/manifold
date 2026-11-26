'use strict';

/**
 * "Where does this connection send its secret?" — one comparable string per endpoint, used to
 * stop a stored secret from following an endpoint change.
 *
 * Every editor keeps a stored password/token when the field is left blank (the API never shows
 * it). Without this rule, an admin token could change only the host of a saved connection and
 * receive the stored secret at a server of its choosing. The identity is scheme + host + port (a
 * URL's origin); a path, name or option change keeps the secret, an identity change requires it
 * to be entered again (400 `secret-required`, naming the field).
 */

const DEFAULT_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  mqtt: 1883,
  mqtts: 8883,
  tcp: 1883,
  ssl: 8883,
  tls: 8883,
  'opc.tcp': 4840,
  postgres: 5432,
  postgresql: 5432
};

const normHost = (h) => String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** scheme://host:port of an endpoint given as parts. Missing port = the scheme's default. */
function hostIdentity(scheme, host, port, defaultPort) {
  const s = String(scheme ?? '').trim().toLowerCase();
  const p = port === undefined || port === null || port === '' ? defaultPort ?? DEFAULT_PORTS[s] ?? '' : Number(port);
  return `${s}://${normHost(host)}:${p}`;
}

/** scheme://host:port of a URL (its origin, also for opc.tcp://). Unparseable input is its own identity. */
function urlIdentity(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return `invalid:${String(raw ?? '')}`;
  }
  return hostIdentity(u.protocol.replace(/:$/, ''), u.hostname, u.port || undefined);
}

const sameUrlEndpoint = (a, b) => urlIdentity(a) === urlIdentity(b);

const LABELS = {
  password: 'password',
  token: 'token',
  apiKey: 'API key',
  url: 'password in the URL',
  authToken: 'token',
  authPassword: 'password',
  privPassword: 'privacy password',
  community: 'community string',
  apiSecret: 'API secret'
};

/** The message every editor shows next to the field. */
function secretRequiredMessage(field) {
  return `The address changed, so the ${LABELS[field] || field} must be entered again.`;
}

/** The 400 body: { error, code: 'secret-required', field }. */
function secretRequiredBody(field) {
  return { error: secretRequiredMessage(field), code: 'secret-required', field };
}

class SecretRequiredError extends Error {
  constructor(field) {
    super(secretRequiredMessage(field));
    this.name = 'SecretRequiredError';
    this.code = 'secret-required';
    this.field = field;
  }
}

const MASK = '***';

/**
 * A URL that carries a masked password (`user:***@host`, what GET answers show) saved back:
 *  - same endpoint and user: the stored URL's password is put back (a path or query change keeps it);
 *  - different endpoint or user: SecretRequiredError('url') — the stored password never follows;
 *  - no mask: the URL as given (a new password was typed, or none).
 */
function restoreMaskedUrlPassword(next, stored) {
  if (typeof next !== 'string') return next;
  let u;
  try {
    u = new URL(next);
  } catch {
    return next;
  }
  if (decodeURIComponent(u.password) !== MASK) return next;
  let s = null;
  try {
    s = stored ? new URL(String(stored)) : null;
  } catch {
    s = null;
  }
  if (!s || !s.password) throw new SecretRequiredError('url');
  if (urlIdentity(next) !== urlIdentity(stored) || u.username !== s.username) throw new SecretRequiredError('url');
  // Swap only the masked segment, so the rest of the URL stays exactly as typed (s.password is
  // already percent-encoded).
  return next.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):(?:\*\*\*|%2A%2A%2A)@/i, (_, head) => `${head}:${s.password}@`);
}

module.exports = {
  DEFAULT_PORTS,
  hostIdentity,
  urlIdentity,
  sameUrlEndpoint,
  secretRequiredMessage,
  secretRequiredBody,
  SecretRequiredError,
  restoreMaskedUrlPassword
};

/** Historian endpoint: database host/port for TimescaleDB, the URL's origin for the HTTP backends. */
function historianEndpoint(h) {
  if (!h) return '';
  if (h.type === 'timescaledb') return hostIdentity('postgres', h.host, h.port || undefined);
  return urlIdentity(h.url);
}

/** The secret field a historian type authenticates with (besides a password inside its URL). */
function historianSecretField(type) {
  return { influxdb: 'token', timebase: 'apiKey', timescaledb: 'password' }[type] || null;
}

module.exports.historianEndpoint = historianEndpoint;
module.exports.historianSecretField = historianSecretField;
