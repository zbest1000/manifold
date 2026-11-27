'use strict';

/**
 * Tag address: `[observe:]/path/segments[?query][#selector]`
 *
 *   /sensors/temp
 *   /sensors/temp?unit=c            Uri-Query options (split on "&")
 *   /sensors/all#temperature.value  selector into a JSON / CBOR document
 *   /senml#urn:dev:ow:10e2/temp     the SenML record name (see ./senml.js)
 *   observe:/sensors/temp           subscribe (RFC 7641) instead of polling
 *
 * The part after "#" never goes on the wire (as in a URI fragment); it picks a
 * value out of the response. Only paths are accepted: a scheme or host is
 * refused, `coaps://` with an explanation, because DTLS is not implemented.
 */

const selector = require('./selector');

const MAX_ADDRESS = 1024;
const MAX_SEGMENTS = 32;
const MAX_QUERY = 16;

const COAPS_MESSAGE =
  'coaps:// (CoAP over DTLS) is not supported: Manifold has no DTLS client, so secured CoAP devices cannot be read. ' +
  'Use a device or gateway that serves plain coap:// (port 5683) on a trusted network segment';

class AddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddressError';
  }
}

function decodeSeg(raw, what) {
  let s;
  try {
    s = decodeURIComponent(raw);
  } catch {
    throw new AddressError(`${what} "${raw}" has an invalid percent escape`);
  }
  if (Buffer.byteLength(s, 'utf8') > 255) throw new AddressError(`${what} is longer than 255 bytes`);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) throw new AddressError(`${what} contains a control character`);
  }
  return s;
}

/**
 * @param {string} text
 * @returns {{observe:boolean, path:string, segments:string[], query:string[], selector?:string, uri:string}}
 * @throws {AddressError}
 */
function parseAddress(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AddressError('address is required, for example /sensors/temp');
  let s = text.trim();
  if (s.length > MAX_ADDRESS) throw new AddressError(`address is longer than ${MAX_ADDRESS} characters`);
  if (/^coaps(\+\w+)?:\/\//i.test(s)) throw new AddressError(COAPS_MESSAGE);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new AddressError('enter the resource path only (for example /sensors/temp); the device host and port are set on the device');
  let observe = false;
  const pre = /^observe:/i.exec(s);
  if (pre) {
    observe = true;
    s = s.slice(pre[0].length).trimStart();
  }
  if (!s.startsWith('/')) throw new AddressError('address must start with "/", for example /sensors/temp');
  let sel;
  const hash = s.indexOf('#');
  if (hash >= 0) {
    sel = s.slice(hash + 1);
    s = s.slice(0, hash);
    if (!sel) throw new AddressError('selector after "#" is empty');
    if (sel.length > selector.MAX_LENGTH) throw new AddressError(`selector is longer than ${selector.MAX_LENGTH} characters`);
    for (let i = 0; i < sel.length; i++) {
      const c = sel.charCodeAt(i);
      if (c < 32 || c === 127) throw new AddressError('selector contains a control character');
    }
  }
  let rawQuery = '';
  const qm = s.indexOf('?');
  if (qm >= 0) {
    rawQuery = s.slice(qm + 1);
    s = s.slice(0, qm);
  }
  const rawPath = s;
  const segments = rawPath === '/' ? [] : rawPath.slice(1).split('/').map((seg) => decodeSeg(seg, 'path segment'));
  if (segments.length > MAX_SEGMENTS) throw new AddressError(`path has more than ${MAX_SEGMENTS} segments`);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new AddressError('"." and ".." segments are not allowed in a CoAP path');
  }
  const query = rawQuery ? rawQuery.split('&').filter(Boolean).map((q) => decodeSeg(q, 'query parameter')) : [];
  if (query.length > MAX_QUERY) throw new AddressError(`query has more than ${MAX_QUERY} parameters`);
  const uri = rawPath + (rawQuery ? `?${rawQuery}` : '');
  return { observe, path: rawPath, segments, query, ...(sel !== undefined ? { selector: sel } : {}), uri };
}

/** Canonical text of a parsed address (what the UI shows back). */
function formatAddress(a) {
  return `${a.observe ? 'observe:' : ''}${a.uri}${a.selector !== undefined ? `#${a.selector}` : ''}`;
}

module.exports = { parseAddress, formatAddress, AddressError, COAPS_MESSAGE };
