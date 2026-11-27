'use strict';

/**
 * SNMP message framing: v1 / v2c community messages (RFC 1157, RFC 1901) and
 * v3 messages with the User-based Security Model (RFC 3412, RFC 3414).
 *
 * READ-ONLY BY CONSTRUCTION: the only PDUs this module can encode are
 * GetRequest, GetNextRequest and GetBulkRequest, and every outgoing varbind
 * carries NULL. There is no SetRequest tag in this file and no way to put a
 * value into a request.
 */

const ber = require('./ber');
const usm = require('./usm');

const { TAG } = ber;

const PDU = Object.freeze({
  GET: 0xa0,
  GET_NEXT: 0xa1,
  RESPONSE: 0xa2,
  TRAP_V1: 0xa4,
  GET_BULK: 0xa5,
  INFORM: 0xa6,
  TRAP_V2: 0xa7,
  REPORT: 0xa8,
});

/** The complete set of PDU types this driver will ever send. */
const REQUEST_PDUS = Object.freeze(new Set([PDU.GET, PDU.GET_NEXT, PDU.GET_BULK]));

const PDU_NAME = Object.freeze({
  [PDU.GET]: 'GetRequest',
  [PDU.GET_NEXT]: 'GetNextRequest',
  [PDU.RESPONSE]: 'Response',
  [PDU.TRAP_V1]: 'Trap',
  [PDU.GET_BULK]: 'GetBulkRequest',
  [PDU.INFORM]: 'InformRequest',
  [PDU.TRAP_V2]: 'SNMPv2-Trap',
  [PDU.REPORT]: 'Report',
});

const VERSION = Object.freeze({ v1: 0, v2c: 1, v3: 3 });

const ERROR_STATUS = Object.freeze([
  'noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr', 'noAccess', 'wrongType', 'wrongLength',
  'wrongEncoding', 'wrongValue', 'noCreation', 'inconsistentValue', 'resourceUnavailable', 'commitFailed',
  'undoFailed', 'authorizationError', 'notWritable', 'inconsistentName',
]);

const FLAG = Object.freeze({ AUTH: 0x01, PRIV: 0x02, REPORTABLE: 0x04 });
const USM_MODEL = 3;
const MIN_MAX_SIZE = 484;

class SnmpFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnmpFrameError';
  }
}

function errorStatusName(code) {
  return ERROR_STATUS[code] || `error ${code}`;
}

// ── encoding ─────────────────────────────────────────────────────────────

/**
 * Encode a request PDU. `oids` are numeric OID strings; every value is NULL.
 * @param {number} type PDU.GET | PDU.GET_NEXT | PDU.GET_BULK
 */
function encodeRequestPdu(type, requestId, oids, { nonRepeaters = 0, maxRepetitions = 10 } = {}) {
  if (!REQUEST_PDUS.has(type)) throw new Error(`refusing to encode PDU type 0x${Number(type).toString(16)}: only Get, GetNext and GetBulk are allowed`);
  if (!Array.isArray(oids)) throw new TypeError('oids must be an array');
  const varbinds = oids.map((oid) => ber.sequence(ber.encodeOid(oid), ber.encodeNull()));
  const a = type === PDU.GET_BULK ? nonRepeaters : 0;
  const b = type === PDU.GET_BULK ? maxRepetitions : 0;
  return ber.tlv(type, Buffer.concat([ber.encodeInteger(requestId), ber.encodeInteger(a), ber.encodeInteger(b), ber.sequence(...varbinds)]));
}

/** v1 / v2c message around an already-encoded PDU. */
function assertRequestPdu(pdu) {
  if (!Buffer.isBuffer(pdu) || !REQUEST_PDUS.has(pdu[0])) throw new Error('refusing to send: only Get, GetNext and GetBulk PDUs are allowed');
}

function encodeCommunityMessage(version, community, pdu) {
  if (version !== VERSION.v1 && version !== VERSION.v2c) throw new Error('community messages are v1 or v2c');
  assertRequestPdu(pdu);
  return ber.sequence(ber.encodeInteger(version), ber.encodeOctetString(Buffer.isBuffer(community) ? community : Buffer.from(String(community), 'utf8')), pdu);
}

/**
 * Build a v3 message.
 * @param {object} p
 * @param {number} p.msgId
 * @param {number} p.msgMaxSize
 * @param {'noAuthNoPriv'|'authNoPriv'|'authPriv'} p.level
 * @param {boolean} [p.reportable=true]
 * @param {Buffer} p.engineId authoritative engine ID (empty for discovery)
 * @param {number} p.engineBoots
 * @param {number} p.engineTime
 * @param {Buffer|string} p.user
 * @param {{protocol:string, key:Buffer}} [p.auth]
 * @param {{protocol:string, key:Buffer, salt:number|bigint}} [p.priv]
 * @param {Buffer} [p.contextEngineId]
 * @param {Buffer|string} [p.contextName]
 * @param {Buffer} p.pdu encoded PDU
 */
function encodeV3Message(p) {
  const level = p.level || 'noAuthNoPriv';
  const auth = level !== 'noAuthNoPriv';
  const priv = level === 'authPriv';
  if (auth && !(p.auth && p.auth.key)) throw new Error('authNoPriv/authPriv need an authentication key');
  if (priv && !(p.priv && p.priv.key)) throw new Error('authPriv needs a privacy key');
  assertRequestPdu(p.pdu);
  let flags = p.reportable === false ? 0 : FLAG.REPORTABLE;
  if (auth) flags |= FLAG.AUTH;
  if (priv) flags |= FLAG.PRIV;
  const scoped = ber.sequence(
    ber.encodeOctetString(p.contextEngineId || p.engineId || Buffer.alloc(0)),
    ber.encodeOctetString(p.contextName === undefined ? Buffer.alloc(0) : p.contextName),
    p.pdu
  );
  let msgData = scoped;
  let privParams = Buffer.alloc(0);
  if (priv) {
    const r = usm.encrypt(p.priv.protocol, p.priv.key, scoped, { engineBoots: p.engineBoots, engineTime: p.engineTime, salt: p.priv.salt });
    msgData = ber.encodeOctetString(r.encrypted);
    privParams = r.privParams;
  }
  const authLen = auth ? usm.macLength(p.auth.protocol) : 0;
  const secParams = ber.sequence(
    ber.encodeOctetString(p.engineId || Buffer.alloc(0)),
    ber.encodeInteger(p.engineBoots || 0),
    ber.encodeInteger(p.engineTime || 0),
    ber.encodeOctetString(p.user === undefined ? Buffer.alloc(0) : p.user),
    ber.encodeOctetString(Buffer.alloc(authLen)),
    ber.encodeOctetString(privParams)
  );
  const msg = ber.sequence(
    ber.encodeInteger(VERSION.v3),
    ber.sequence(ber.encodeInteger(p.msgId), ber.encodeInteger(Math.max(MIN_MAX_SIZE, p.msgMaxSize || 65507)), ber.encodeOctetString(Buffer.from([flags])), ber.encodeInteger(USM_MODEL)),
    ber.encodeOctetString(secParams),
    msgData
  );
  if (auth) {
    const { usm: sec } = decodeV3Envelope(msg);
    usm.computeMac(p.auth.protocol, p.auth.key, msg).copy(msg, sec.authOffset);
  }
  return msg;
}

// ── decoding ─────────────────────────────────────────────────────────────

/** Decode a PDU of any type from a reader positioned on it. */
function decodePdu(reader) {
  const t = reader.read();
  if ((t.tag & 0xe0) !== 0xa0) throw new SnmpFrameError(`expected a PDU, got tag 0x${t.tag.toString(16)}`);
  const r = new ber.Reader(reader.buf, t.start, t.end);
  const type = t.tag;
  if (type === PDU.TRAP_V1) throw new SnmpFrameError('v1 Trap PDUs are not handled');
  const requestId = r.integer('request-id');
  const a = r.integer('error-status');
  const b = r.integer('error-index');
  const list = r.sub(TAG.SEQUENCE, 'varbind list');
  const varbinds = [];
  while (list.remaining > 0) {
    const vb = list.sub(TAG.SEQUENCE, 'varbind');
    const oid = vb.oid('varbind name');
    const v = vb.read();
    if (vb.remaining !== 0) throw new SnmpFrameError('trailing data in varbind');
    varbinds.push({ oid, tag: v.tag, value: reader.buf.subarray(v.start, v.end) });
  }
  if (r.remaining !== 0) throw new SnmpFrameError('trailing data in PDU');
  const out = { type, typeName: PDU_NAME[type] || `PDU 0x${type.toString(16)}`, requestId: Number(requestId), varbinds };
  if (type === PDU.GET_BULK) {
    out.nonRepeaters = Number(a);
    out.maxRepetitions = Number(b);
  } else {
    out.errorStatus = Number(a);
    out.errorIndex = Number(b);
  }
  return out;
}

/** v3 envelope without touching msgData: header, USM parameters and the auth-field offset. */
function decodeV3Envelope(buf) {
  const top = new ber.Reader(buf).sub(TAG.SEQUENCE, 'message');
  const version = top.integer('msgVersion');
  if (version !== VERSION.v3) throw new SnmpFrameError(`not an SNMPv3 message (version ${version})`);
  const g = top.sub(TAG.SEQUENCE, 'msgGlobalData');
  const msgId = Number(g.integer('msgID'));
  const msgMaxSize = Number(g.integer('msgMaxSize'));
  const flagsBuf = g.octets('msgFlags');
  if (flagsBuf.length !== 1) throw new SnmpFrameError('msgFlags must be one byte');
  const securityModel = Number(g.integer('msgSecurityModel'));
  const secOctets = top.expect(TAG.OCTET_STRING, 'msgSecurityParameters');
  let sec = null;
  if (securityModel === USM_MODEL) {
    const s = new ber.Reader(buf, secOctets.start, secOctets.end).sub(TAG.SEQUENCE, 'UsmSecurityParameters');
    const engineId = Buffer.from(s.octets('msgAuthoritativeEngineID'));
    const engineBoots = Number(s.integer('msgAuthoritativeEngineBoots'));
    const engineTime = Number(s.integer('msgAuthoritativeEngineTime'));
    const user = Buffer.from(s.octets('msgUserName'));
    const authT = s.expect(TAG.OCTET_STRING, 'msgAuthenticationParameters');
    const privParams = Buffer.from(s.octets('msgPrivacyParameters'));
    sec = { engineId, engineBoots, engineTime, user, authParams: Buffer.from(buf.subarray(authT.start, authT.end)), authOffset: authT.start, privParams };
  }
  const data = top.read();
  if (top.remaining !== 0) throw new SnmpFrameError('trailing data after msgData');
  return { version, msgId, msgMaxSize, flags: flagsBuf[0], securityModel, usm: sec, msgData: { tag: data.tag, tlvStart: data.tlvStart, start: data.start, end: data.end } };
}

/** Decode a plaintext ScopedPDU. */
function decodeScopedPdu(buf, start = 0, end = buf.length) {
  const r = new ber.Reader(buf, start, end).sub(TAG.SEQUENCE, 'ScopedPDU');
  const contextEngineId = Buffer.from(r.octets('contextEngineID'));
  const contextName = Buffer.from(r.octets('contextName'));
  const pdu = decodePdu(r);
  // Decrypted DES data carries up to 7 pad bytes after the ScopedPDU; they are ignored.
  return { contextEngineId, contextName, pdu };
}

/**
 * Decode a v1/v2c message, or the v3 envelope (msgData decoded only when it is plaintext).
 * Throws BerError / SnmpFrameError on malformed input.
 */
function decodeMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) throw new SnmpFrameError('datagram too short');
  const outer = new ber.Reader(buf);
  const peek = outer.sub(TAG.SEQUENCE, 'message');
  if (outer.remaining !== 0) throw new SnmpFrameError('trailing data after the message');
  const version = peek.integer('version');
  if (version === VERSION.v1 || version === VERSION.v2c) {
    const community = Buffer.from(peek.octets('community'));
    const pdu = decodePdu(peek);
    if (peek.remaining !== 0) throw new SnmpFrameError('trailing data after PDU');
    return { version, community, pdu };
  }
  if (version === VERSION.v3) {
    const env = decodeV3Envelope(buf);
    const out = { version, v3: env };
    if (env.msgData.tag === TAG.SEQUENCE) out.scoped = decodeScopedPdu(buf, env.msgData.tlvStart, env.msgData.end);
    else if (env.msgData.tag === TAG.OCTET_STRING) out.encrypted = Buffer.from(buf.subarray(env.msgData.start, env.msgData.end));
    else throw new SnmpFrameError(`unexpected msgData tag 0x${env.msgData.tag.toString(16)}`);
    return out;
  }
  throw new SnmpFrameError(`unsupported SNMP version ${version}`);
}

/** Copy of a v3 message with the authentication parameters zeroed (for MAC verification). */
function zeroAuth(buf, sec) {
  const copy = Buffer.from(buf);
  copy.fill(0, sec.authOffset, sec.authOffset + sec.authParams.length);
  return copy;
}

module.exports = {
  PDU,
  PDU_NAME,
  REQUEST_PDUS,
  VERSION,
  FLAG,
  USM_MODEL,
  ERROR_STATUS,
  SnmpFrameError,
  errorStatusName,
  encodeRequestPdu,
  encodeCommunityMessage,
  encodeV3Message,
  decodePdu,
  decodeV3Envelope,
  decodeScopedPdu,
  decodeMessage,
  zeroAuth,
};
