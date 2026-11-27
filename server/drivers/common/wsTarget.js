'use strict';

/**
 * Connection settings of the WebSocket bridge drivers (matter-server, zwave-js), on the one
 * URL-device model every URL driver shares (./urlTarget.js; the HTTP drivers use it too):
 *
 * A bridge URL such as ws://ha.local:5580/ws is stored in the device fields
 *   host = "ha.local", port = 5580, scheme = "ws" | "wss", path = "/ws".
 * The main process resolves `host`, checks every address against the egress policy and pins
 * them (device.pinned.addresses); the client connects to the pinned address and sends the
 * configured name as Host header and TLS SNI. The name is never resolved again here.
 *
 * Secret: `authToken` (sent as "Authorization: Bearer <token>" for servers behind an
 * authenticating reverse proxy), a `password` field like every device secret. TLS options are
 * the shared tlsInsecure / tlsCa / tlsFingerprint256.
 */

const net = require('net');
const { connectAddress } = require('../runtime/pinnedAddress');
const { hasControl, normalizePem, tlsSettings, bearerHeaders, urlFields } = require('./urlTarget');

/** The device fields every WebSocket bridge driver shows (the URL parts, token, TLS). */
function wsDeviceFields({ defaultPath }) {
  const url = urlFields({
    schemes: ['ws', 'wss'],
    secure: 'wss',
    schemeHelp: 'wss = WebSocket over TLS (usually behind a reverse proxy).',
    path: { default: defaultPath, help: `The part of the URL after host:port, ${defaultPath === '/' ? 'normally "/"' : `normally "${defaultPath}"`}.` }
  });
  return [
    url.scheme,
    url.path,
    { name: 'authToken', label: 'Bearer token', type: 'password', optional: true, help: 'Only for a server behind an authenticating reverse proxy; sent as "Authorization: Bearer". Leave blank when editing to keep the stored value.' },
    ...url.tls
  ];
}

/**
 * Validate the WebSocket target of a device. Throws Error with every problem joined.
 * @returns {{ address:string, hostname:string, port:number, secure:boolean, path:string,
 *   tls:{rejectUnauthorized:boolean, insecure:boolean, ca?:string, fingerprint?:string},
 *   headers:Record<string,string>, url:string }}
 */
function wsTarget(device, { defaultPort, defaultPath }) {
  const errors = [];
  const scheme = device.scheme === undefined || device.scheme === '' || device.scheme === null ? 'ws' : device.scheme;
  if (scheme !== 'ws' && scheme !== 'wss') errors.push('scheme must be "ws" or "wss"');
  const hostname = String(device.host || '').trim();
  if (!hostname || /[\s/]/.test(hostname)) errors.push('host is required (hostname or IP address, no scheme or path)');
  const port = device.port === undefined || device.port === null || device.port === '' ? defaultPort : Number(device.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be 1-65535');
  let path = device.path === undefined || device.path === null || device.path === '' ? defaultPath : String(device.path).trim();
  if (!path.startsWith('/')) path = `/${path}`;
  if (/[\s#\\]/.test(path) || hasControl(path) || path.startsWith('//') || path.includes('://')) errors.push('path must start with "/" and contain no spaces, "#", "\\" or "://"');
  const bearer = bearerHeaders(device.authToken);
  errors.push(...bearer.errors);
  const headers = bearer.headers.authorization ? { Authorization: bearer.headers.authorization } : {};
  const secure = scheme === 'wss';
  const t = tlsSettings(device, secure);
  errors.push(...t.errors);
  if (errors.length) throw new Error(errors.join('; '));
  const shownHost = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return {
    address: connectAddress({ ...device, host: hostname }),
    hostname,
    port,
    secure,
    path,
    tls: { ...t.tls, rejectUnauthorized: !(t.tls.insecure || t.tls.fingerprint) },
    headers,
    url: `${scheme}://${shownHost}:${port}${path}`
  };
}

/** The secret fields in use: the token only when one is set. */
function activeSecretFields() {
  return ['authToken'];
}

module.exports = { wsDeviceFields, wsTarget, activeSecretFields, normalizePem };
