'use strict';

/**
 * CoAP message codec (RFC 7252 section 3) and block option helpers (RFC 7959).
 *
 * READ-ONLY BY CONSTRUCTION: the only request this module can encode is GET
 * (code 0.01). There is no method parameter anywhere; PUT, POST, DELETE, FETCH
 * and PATCH are not representable. `assertReadOnlyDatagram` re-checks the code
 * of every datagram right before it reaches the socket.
 */

const TYPE = { CON: 0, NON: 1, ACK: 2, RST: 3 };
const TYPE_NAME = ['CON', 'NON', 'ACK', 'RST'];

const GET = 0x01;
const EMPTY = 0x00;

const OPT = {
  IF_MATCH: 1,
  URI_HOST: 3,
  ETAG: 4,
  IF_NONE_MATCH: 5,
  OBSERVE: 6,
  URI_PORT: 7,
  LOCATION_PATH: 8,
  URI_PATH: 11,
  CONTENT_FORMAT: 12,
  MAX_AGE: 14,
  URI_QUERY: 15,
  ACCEPT: 17,
  LOCATION_QUERY: 20,
  BLOCK2: 23,
  BLOCK1: 27,
  SIZE2: 28,
  PROXY_URI: 35,
  PROXY_SCHEME: 39,
  SIZE1: 60
};

const CODE_NAMES = {
  '0.00': 'Empty',
  '0.01': 'GET',
  '2.01': 'Created',
  '2.02': 'Deleted',
  '2.03': 'Valid',
  '2.04': 'Changed',
  '2.05': 'Content',
  '2.31': 'Continue',
  '4.00': 'Bad Request',
  '4.01': 'Unauthorized',
  '4.02': 'Bad Option',
  '4.03': 'Forbidden',
  '4.04': 'Not Found',
  '4.05': 'Method Not Allowed',
  '4.06': 'Not Acceptable',
  '4.08': 'Request Entity Incomplete',
  '4.09': 'Conflict',
  '4.12': 'Precondition Failed',
  '4.13': 'Request Entity Too Large',
  '4.15': 'Unsupported Content-Format',
  '4.29': 'Too Many Requests',
  '5.00': 'Internal Server Error',
  '5.01': 'Not Implemented',
  '5.02': 'Bad Gateway',
  '5.03': 'Service Unavailable',
  '5.04': 'Gateway Timeout',
  '5.05': 'Proxying Not Supported',
  '5.06': 'Hop Limit Reached'
};

class CoapFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoapFormatError';
  }
}

class CoapReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoapReadOnlyError';
    this.code = 'READ_ONLY';
  }
}

/** "2.05" for the raw code byte 0x45. */
function codeString(code) {
  return `${code >> 5}.${String(code & 31).padStart(2, '0')}`;
}

/** "4.04 Not Found" (the name is omitted for codes the RFCs do not define). */
function codeLabel(code) {
  const s = codeString(code);
  return CODE_NAMES[s] ? `${s} ${CODE_NAMES[s]}` : s;
}

const codeClass = (code) => code >> 5;
const isResponseCode = (code) => code >= 0x40;

// ---- unsigned integer options -------------------------------------------------

function encodeUint(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('option integer out of range');
  if (value === 0) return Buffer.alloc(0);
  const out = [];
  let v = value;
  while (v > 0) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
}

function decodeUint(buf) {
  if (buf.length > 4) throw new CoapFormatError(`integer option of ${buf.length} bytes`);
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

// ---- encoding -----------------------------------------------------------------

function encodeOptions(options) {
  // Stable sort by option number: options with equal numbers keep their order (Uri-Path segments).
  const sorted = options.map((o, i) => ({ ...o, i })).sort((a, b) => a.num - b.num || a.i - b.i);
  const parts = [];
  let prev = 0;
  for (const o of sorted) {
    const value = Buffer.isBuffer(o.value) ? o.value : Buffer.from(o.value);
    const delta = o.num - prev;
    prev = o.num;
    const ext = (n) => {
      if (n < 13) return { nib: n, bytes: Buffer.alloc(0) };
      if (n < 269) return { nib: 13, bytes: Buffer.from([n - 13]) };
      const b = Buffer.alloc(2);
      b.writeUInt16BE(n - 269);
      return { nib: 14, bytes: b };
    };
    if (value.length > 65535 + 269) throw new RangeError('option value too long');
    const d = ext(delta);
    const l = ext(value.length);
    parts.push(Buffer.from([(d.nib << 4) | l.nib]), d.bytes, l.bytes, value);
  }
  return Buffer.concat(parts);
}

/**
 * @param {{type:number, code:number, mid:number, token?:Buffer, options?:{num:number,value:Buffer}[], payload?:Buffer}} m
 * @returns {Buffer}
 */
function encode(m) {
  const token = m.token || Buffer.alloc(0);
  if (token.length > 8) throw new RangeError('token longer than 8 bytes');
  if (!Number.isInteger(m.mid) || m.mid < 0 || m.mid > 0xffff) throw new RangeError('message id out of range');
  const header = Buffer.from([0x40 | (m.type << 4) | token.length, m.code, m.mid >> 8, m.mid & 0xff]);
  const parts = [header, token, encodeOptions(m.options || [])];
  if (m.payload && m.payload.length) parts.push(Buffer.from([0xff]), m.payload);
  return Buffer.concat(parts);
}

/**
 * Encode a confirmable GET. The method is fixed: there is no way to ask this
 * function for anything else.
 * @param {{mid:number, token:Buffer, path?:string[], query?:string[], observe?:number, accept?:number,
 *   block2?:{num:number,szx:number}, uriHost?:string}} r
 */
function encodeGet(r) {
  const options = [];
  if (r.uriHost) options.push({ num: OPT.URI_HOST, value: Buffer.from(r.uriHost, 'utf8') });
  if (r.observe !== undefined) options.push({ num: OPT.OBSERVE, value: encodeUint(r.observe) });
  for (const seg of r.path || []) options.push({ num: OPT.URI_PATH, value: Buffer.from(seg, 'utf8') });
  for (const q of r.query || []) options.push({ num: OPT.URI_QUERY, value: Buffer.from(q, 'utf8') });
  if (r.accept !== undefined) options.push({ num: OPT.ACCEPT, value: encodeUint(r.accept) });
  if (r.block2) options.push({ num: OPT.BLOCK2, value: encodeBlock(r.block2.num, false, r.block2.szx) });
  return encode({ type: TYPE.CON, code: GET, mid: r.mid, token: r.token, options });
}

/** Empty ACK or RST for message id `mid` (4 bytes, code 0.00). */
function encodeEmpty(type, mid) {
  return encode({ type, code: EMPTY, mid, token: Buffer.alloc(0) });
}

/** CoAP ping: an empty confirmable message. A live endpoint answers with RST. */
function encodePing(mid) {
  return encodeEmpty(TYPE.CON, mid);
}

/**
 * Final guard before the socket: the datagram must be an empty message (0.00)
 * or a GET (0.01). Anything else (including every other request method and
 * every response code) is refused.
 */
function assertReadOnlyDatagram(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] >> 6 !== 1) throw new CoapReadOnlyError('refusing to send a datagram that is not a CoAP message');
  const code = buf[1];
  if (code !== EMPTY && code !== GET) throw new CoapReadOnlyError(`refusing to send CoAP code ${codeString(code)}: this driver only sends GET`);
}

// ---- decoding -----------------------------------------------------------------

/**
 * Parse one datagram. Throws CoapFormatError for anything malformed (a
 * message that fails here must be ignored or answered with RST by the caller).
 * @returns {{type:number, code:number, mid:number, token:Buffer, options:{num:number,value:Buffer}[], payload:Buffer}}
 */
function decode(buf) {
  if (!Buffer.isBuffer(buf)) throw new CoapFormatError('not a buffer');
  if (buf.length < 4) throw new CoapFormatError('shorter than the 4-byte header');
  const ver = buf[0] >> 6;
  if (ver !== 1) throw new CoapFormatError(`unsupported version ${ver}`);
  const type = (buf[0] >> 4) & 3;
  const tkl = buf[0] & 15;
  if (tkl > 8) throw new CoapFormatError(`token length ${tkl} is reserved`);
  const code = buf[1];
  const mid = buf.readUInt16BE(2);
  if (code === EMPTY) {
    if (tkl !== 0 || buf.length !== 4) throw new CoapFormatError('empty message with a token or content');
    return { type, code, mid, token: Buffer.alloc(0), options: [], payload: Buffer.alloc(0) };
  }
  // 0.xx other than 0.00/0.01 are requests we never serve, but they parse like any other message.
  if (buf.length < 4 + tkl) throw new CoapFormatError('truncated token');
  const token = Buffer.from(buf.subarray(4, 4 + tkl));
  let p = 4 + tkl;
  const options = [];
  let num = 0;
  let payload = Buffer.alloc(0);
  while (p < buf.length) {
    const b = buf[p];
    if (b === 0xff) {
      if (p + 1 >= buf.length) throw new CoapFormatError('payload marker followed by no payload');
      payload = Buffer.from(buf.subarray(p + 1));
      break;
    }
    p++;
    let delta = b >> 4;
    let len = b & 15;
    const ext = (n) => {
      if (n === 15) throw new CoapFormatError('reserved option delta or length 15');
      if (n === 13) {
        if (p + 1 > buf.length) throw new CoapFormatError('truncated option header');
        return buf[p++] + 13;
      }
      if (n === 14) {
        if (p + 2 > buf.length) throw new CoapFormatError('truncated option header');
        const v = buf.readUInt16BE(p) + 269;
        p += 2;
        return v;
      }
      return n;
    };
    delta = ext(delta);
    len = ext(len);
    if (p + len > buf.length) throw new CoapFormatError('option value runs past the datagram');
    num += delta;
    if (num > 0xffff) throw new CoapFormatError('option number out of range');
    options.push({ num, value: Buffer.from(buf.subarray(p, p + len)) });
    p += len;
    if (options.length > 64) throw new CoapFormatError('more than 64 options');
  }
  return { type, code, mid, token, options, payload };
}

function option(msg, num) {
  const o = msg.options.find((x) => x.num === num);
  return o ? o.value : undefined;
}

function optionUint(msg, num) {
  const v = option(msg, num);
  return v === undefined ? undefined : decodeUint(v);
}

// ---- block option (RFC 7959 section 2.2) -----------------------------------------

const BLOCK_SIZES = [16, 32, 64, 128, 256, 512, 1024];

function encodeBlock(num, more, szx) {
  if (!Number.isInteger(num) || num < 0 || num > 0xfffff) throw new RangeError('block number out of range');
  if (!Number.isInteger(szx) || szx < 0 || szx > 6) throw new RangeError('block size exponent out of range');
  return encodeUint(num * 16 + (more ? 8 : 0) + szx);
}

/** @returns {{num:number, more:boolean, szx:number, size:number}} */
function decodeBlock(buf) {
  if (buf.length > 3) throw new CoapFormatError('block option longer than 3 bytes');
  const v = decodeUint(buf);
  const szx = v & 7;
  if (szx === 7) throw new CoapFormatError('block size exponent 7 is reserved');
  return { num: v >> 4, more: ((v >> 3) & 1) === 1, szx, size: BLOCK_SIZES[szx] };
}

function szxForSize(size) {
  const i = BLOCK_SIZES.indexOf(size);
  if (i < 0) throw new RangeError(`block size must be one of ${BLOCK_SIZES.join(', ')}`);
  return i;
}

// ---- observe freshness (RFC 7641 section 3.4) ---------------------------------------

/**
 * Is a notification with sequence `v2` received at `t2` (ms) newer than the
 * last accepted one (`v1`, `t1`)? 24-bit serial arithmetic, with a 128 s
 * escape hatch for servers that restart or reuse numbers.
 */
function observeIsFresh(v1, t1, v2, t2) {
  if (v1 === undefined || v1 === null) return true;
  return (v1 < v2 && v2 - v1 < 1 << 23) || (v1 > v2 && v1 - v2 > 1 << 23) || t2 > t1 + 128000;
}

module.exports = {
  TYPE,
  TYPE_NAME,
  GET,
  EMPTY,
  OPT,
  CODE_NAMES,
  BLOCK_SIZES,
  CoapFormatError,
  CoapReadOnlyError,
  codeString,
  codeLabel,
  codeClass,
  isResponseCode,
  encodeUint,
  decodeUint,
  encode,
  encodeGet,
  encodeEmpty,
  encodePing,
  assertReadOnlyDatagram,
  decode,
  option,
  optionUint,
  encodeBlock,
  decodeBlock,
  szxForSize,
  observeIsFresh
};
