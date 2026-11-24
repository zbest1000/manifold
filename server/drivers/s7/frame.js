'use strict';

/**
 * Siemens S7comm (classic, protocol id 0x32) framing over ISO-on-TCP.
 *
 * Layers, outermost first:
 *   TPKT  (RFC 1006 §6):  version 3, reserved 0, u16 total length incl. this 4-byte header
 *   COTP  (ISO 8073 / RFC 905 class 0): CR 0xE0, CC 0xD0, DT 0xF0, DR 0x80, ER 0x70
 *   S7    header 10 bytes (job / userdata) or 12 bytes (ack / ack-data, + error class + code)
 *
 * Wire layouts were taken from public descriptions, not from any GPL code:
 *   - Wireshark S7comm dissector (epan/dissectors/packet-s7comm.c) and its display
 *     filter reference (https://www.wireshark.org/docs/dfref/s/s7comm.html)
 *   - Apache PLC4X S7 protocol description (https://plc4x.apache.org/protocols/s7/s7comm.html)
 *   - Snap7 documentation for TSAP derivation and PDU sizes (https://snap7.sourceforge.net/)
 *   - "The Siemens S7 Communication" parts 1-2 (G. Miru), which documents the
 *     even-byte alignment (fill byte) of Read Var response items.
 * Details that could only be checked against the in-process simulator are
 * listed in NOTES.md ("Verify on real hardware").
 *
 * READ-ONLY BY CONSTRUCTION. `encodeS7Frame` is the only function that builds
 * an outgoing S7 PDU. It accepts exactly: job 0xF0 (setup communication), job
 * 0x04 (Read Var) and userdata group 4 / subfunction 1 (read SZL). Everything
 * else — Write Var 0x05, PLC control 0x28, PLC stop 0x29, block
 * upload/download 0x1A-0x1F, clock set, programmer commands, any ack — throws
 * S7ReadOnlyError before a single byte is allocated (design §7).
 */

const TPKT_HEADER = 4;
const MAX_TPKT_LENGTH = 0xffff;

const COTP = Object.freeze({ CR: 0xe0, CC: 0xd0, DT: 0xf0, DR: 0x80, DC: 0xc0, ER: 0x70 });
const ROSCTR = Object.freeze({ JOB: 1, ACK: 2, ACK_DATA: 3, USERDATA: 7 });
const FUNC = Object.freeze({ SETUP_COMM: 0xf0, READ_VAR: 0x04 });
const AREA = Object.freeze({ I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 });
const AREA_NAME = Object.freeze({ 0x81: 'I', 0x82: 'Q', 0x83: 'M', 0x84: 'DB' });

// Request item transport sizes (Wireshark "item_transportsizes").
const TS_REQ_BYTE = 0x02;
// Response data transport sizes (Wireshark "data_transportsizes").
const TS_DATA = Object.freeze({ NULL: 0x00, BIT: 0x03, BYTE: 0x04, INT: 0x05, DINT: 0x06, REAL: 0x07, OCTET: 0x09 });

const S7_JOB_HEADER = 10;
const S7_ACK_HEADER = 12;
const READ_ITEM_SPEC = 12; // 0x12 0x0A 0x10 ts len(2) db(2) area addr(3)
const READ_PARAM_HEAD = 2; // function + item count
/** Request bytes for n Read Var items: header + function/count + 12 per item. */
const readRequestSize = (n) => S7_JOB_HEADER + READ_PARAM_HEAD + READ_ITEM_SPEC * n;
/** Response header + function/count. Each item then adds 4 + length (+1 fill byte if odd). */
const READ_RESPONSE_OVERHEAD = S7_ACK_HEADER + READ_PARAM_HEAD;
const READ_RESPONSE_ITEM_HEAD = 4;
const MAX_READ_ITEMS = 20; // design §5.2; widely documented S7-300/400 limit
const MAX_BYTE_OFFSET = 0x1fffff; // the 3-byte address field holds byteOffset*8 + bit

// ── errors ─────────────────────────────────────────────────────────────────

class S7ReadOnlyError extends Error {
  constructor(what) {
    super(`S7 ${what} is refused: this driver is read-only (allowed: setup communication, Read Var, read SZL)`);
    this.name = 'S7ReadOnlyError';
  }
}

/** Unrecoverable stream violation: the caller must destroy the socket. */
class S7FramingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S7FramingError';
  }
}

/** A well-framed response that does not answer the request in flight. Destroy the socket. */
class S7MismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S7MismatchError';
  }
}

function assertInt(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
}

// ── TSAP / COTP connect ────────────────────────────────────────────────────

const CONNECTION_TYPE = Object.freeze({ pg: 0x01, op: 0x02, basic: 0x03 });

/**
 * Remote TSAP from rack/slot as documented by Snap7:
 * (connectionType << 8) | (rack * 0x20 + slot). Local TSAP defaults to 0x0100.
 * @param {number} rack 0..7
 * @param {number} slot 0..31
 * @param {'pg'|'op'|'basic'} [connectionType='pg']
 */
function remoteTsapFor(rack, slot, connectionType = 'pg') {
  assertInt('rack', rack, 0, 7);
  assertInt('slot', slot, 0, 31);
  const ct = CONNECTION_TYPE[connectionType];
  if (!ct) throw new RangeError(`connectionType must be pg, op or basic, got ${connectionType}`);
  return (ct << 8) | (rack * 0x20 + slot);
}

function tpkt(payload) {
  const total = TPKT_HEADER + payload.length;
  if (total > MAX_TPKT_LENGTH) throw new RangeError(`frame of ${total} bytes exceeds TPKT maximum`);
  const head = Buffer.from([3, 0, total >> 8, total & 0xff]);
  return Buffer.concat([head, payload]);
}

/**
 * COTP Connection Request inside TPKT.
 * @param {{localTsap:number, remoteTsap:number, srcRef?:number, tpduSizeCode?:number}} p
 *   tpduSizeCode 0x0A = 1024 bytes (2^code)
 */
function encodeConnectRequest({ localTsap = 0x0100, remoteTsap, srcRef = 0x0001, tpduSizeCode = 0x0a }) {
  assertInt('localTsap', localTsap, 0, 0xffff);
  assertInt('remoteTsap', remoteTsap, 0, 0xffff);
  assertInt('srcRef', srcRef, 0, 0xffff);
  assertInt('tpduSizeCode', tpduSizeCode, 0x07, 0x0d);
  const body = Buffer.from([
    COTP.CR, 0x00, 0x00, srcRef >> 8, srcRef & 0xff, 0x00, // dst ref 0, src ref, class 0
    0xc0, 0x01, tpduSizeCode,
    0xc1, 0x02, localTsap >> 8, localTsap & 0xff,
    0xc2, 0x02, remoteTsap >> 8, remoteTsap & 0xff,
  ]);
  return tpkt(Buffer.concat([Buffer.from([body.length]), body]));
}

// ── the single S7 PDU encoder (read-only allowlist) ────────────────────────

function s7Header(rosctr, pduRef, paramLength, dataLength) {
  const h = Buffer.alloc(S7_JOB_HEADER);
  h[0] = 0x32;
  h[1] = rosctr;
  h.writeUInt16BE(0, 2);
  h.writeUInt16BE(pduRef, 4);
  h.writeUInt16BE(paramLength, 6);
  h.writeUInt16BE(dataLength, 8);
  return h;
}

function hexName(n) {
  return typeof n === 'number' ? `0x${n.toString(16).padStart(2, '0')}` : JSON.stringify(n);
}

/** Decide whether a job descriptor is allowlisted, before any validation or allocation. */
function assertAllowed(job) {
  if (!job || typeof job !== 'object') throw new S7ReadOnlyError('request without a descriptor');
  if (job.type === 'job') {
    if (job.func === FUNC.SETUP_COMM || job.func === FUNC.READ_VAR) return;
    throw new S7ReadOnlyError(`job function ${hexName(job.func)}`);
  }
  if (job.type === 'userdata') {
    if (job.group === 0x4 && job.subfunction === 0x01) return;
    throw new S7ReadOnlyError(`userdata group ${hexName(job.group)} subfunction ${hexName(job.subfunction)}`);
  }
  throw new S7ReadOnlyError(`message type ${JSON.stringify(job.type)}`);
}

function encodeSetupComm({ pduRef, pduSize = 960, maxAmqCalling = 1, maxAmqCalled = 1 }) {
  assertInt('pduSize', pduSize, 64, 0xffff);
  assertInt('maxAmqCalling', maxAmqCalling, 1, 0xffff);
  assertInt('maxAmqCalled', maxAmqCalled, 1, 0xffff);
  const p = Buffer.alloc(8);
  p[0] = FUNC.SETUP_COMM;
  p[1] = 0;
  p.writeUInt16BE(maxAmqCalling, 2);
  p.writeUInt16BE(maxAmqCalled, 4);
  p.writeUInt16BE(pduSize, 6);
  return Buffer.concat([s7Header(ROSCTR.JOB, pduRef, p.length, 0), p]);
}

function encodeReadVar({ pduRef, items, maxPdu }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_READ_ITEMS) {
    throw new RangeError(`Read Var needs 1..${MAX_READ_ITEMS} items`);
  }
  const p = Buffer.alloc(READ_PARAM_HEAD + READ_ITEM_SPEC * items.length);
  p[0] = FUNC.READ_VAR;
  p[1] = items.length;
  items.forEach((it, i) => {
    if (!AREA_NAME[it.area]) throw new RangeError(`unknown area code ${hexName(it.area)}`);
    assertInt('db', it.db, it.area === AREA.DB ? 1 : 0, it.area === AREA.DB ? 0xffff : 0);
    assertInt('start', it.start, 0, MAX_BYTE_OFFSET);
    assertInt('length', it.length, 1, 0xffff);
    const o = READ_PARAM_HEAD + i * READ_ITEM_SPEC;
    p[o] = 0x12; // variable specification
    p[o + 1] = 0x0a; // length of the following address spec
    p[o + 2] = 0x10; // syntax id S7ANY
    p[o + 3] = TS_REQ_BYTE;
    p.writeUInt16BE(it.length, o + 4);
    p.writeUInt16BE(it.db, o + 6);
    p[o + 8] = it.area;
    const bitAddr = it.start * 8;
    p[o + 9] = (bitAddr >> 16) & 0xff;
    p[o + 10] = (bitAddr >> 8) & 0xff;
    p[o + 11] = bitAddr & 0xff;
  });
  const pdu = Buffer.concat([s7Header(ROSCTR.JOB, pduRef, p.length, 0), p]);
  if (maxPdu !== undefined && pdu.length > maxPdu) {
    throw new RangeError(`Read Var request of ${pdu.length} bytes exceeds the negotiated PDU of ${maxPdu}`);
  }
  return pdu;
}

function encodeSzlRead({ pduRef, szlId, szlIndex }) {
  assertInt('szlId', szlId, 0, 0xffff);
  assertInt('szlIndex', szlIndex, 0, 0xffff);
  // param head 00 01 12, param length 4, method 0x11 (request),
  // type 4 (request) | group 4 (CPU functions), subfunction 0x01 (read SZL), sequence 0
  const p = Buffer.from([0x00, 0x01, 0x12, 0x04, 0x11, 0x44, 0x01, 0x00]);
  const d = Buffer.alloc(8);
  d[0] = 0xff; // return code: request
  d[1] = TS_DATA.OCTET;
  d.writeUInt16BE(4, 2);
  d.writeUInt16BE(szlId, 4);
  d.writeUInt16BE(szlIndex, 6);
  return Buffer.concat([s7Header(ROSCTR.USERDATA, pduRef, p.length, d.length), p, d]);
}

/**
 * Build a complete outgoing frame (TPKT + COTP DT + S7 PDU). The ONLY place
 * S7 PDUs are produced.
 *
 * @param {{type:'job', func:0xF0, pduRef:number, pduSize?:number, maxAmqCalling?:number, maxAmqCalled?:number}
 *   | {type:'job', func:0x04, pduRef:number, items:{area:number, db:number, start:number, length:number}[], maxPdu?:number}
 *   | {type:'userdata', group:4, subfunction:1, pduRef:number, szlId:number, szlIndex:number}} job
 * @returns {Buffer}
 * @throws {S7ReadOnlyError} for anything not on the allowlist (no bytes are produced)
 * @throws {RangeError} for out-of-range fields of an allowed job
 */
function encodeS7Frame(job) {
  assertAllowed(job);
  assertInt('pduRef', job.pduRef, 0, 0xffff);
  let pdu;
  if (job.type === 'userdata') pdu = encodeSzlRead(job);
  else if (job.func === FUNC.SETUP_COMM) pdu = encodeSetupComm(job);
  else pdu = encodeReadVar(job);
  return tpkt(Buffer.concat([Buffer.from([0x02, COTP.DT, 0x80]), pdu]));
}

// ── streaming TPKT/COTP parser ─────────────────────────────────────────────

function parseCotpParams(buf) {
  const params = {};
  let o = 0;
  while (o + 2 <= buf.length) {
    const code = buf[o];
    const len = buf[o + 1];
    if (o + 2 + len > buf.length) throw new S7FramingError(`COTP parameter 0x${code.toString(16)} overruns the header`);
    const v = buf.subarray(o + 2, o + 2 + len);
    if (code === 0xc0 && len === 1) params.tpduSize = 1 << v[0];
    else if (code === 0xc1 && len === 2) params.srcTsap = v.readUInt16BE(0);
    else if (code === 0xc2 && len === 2) params.dstTsap = v.readUInt16BE(0);
    o += 2 + len;
  }
  return params;
}

/**
 * Streaming parser for TPKT/COTP. Feed raw TCP chunks; it returns every
 * complete message. COTP DT fragments (no EOT bit) are reassembled into one
 * S7 PDU. After a framing error the parser is poisoned and every further
 * `push` rethrows: the caller must drop the socket.
 */
class TpktParser {
  constructor({ maxPduBytes = 0x4000 } = {}) {
    this._buf = Buffer.alloc(0);
    this._failure = null;
    this._fragments = [];
    this._fragmentBytes = 0;
    this._maxPduBytes = maxPduBytes;
  }

  /**
   * @param {Buffer} chunk
   * @returns {({type:'DT', data:Buffer} | {type:'CC', dstRef:number, srcRef:number, params:object}
   *   | {type:'DR'|'ER', raw:Buffer})[]}
   * @throws {S7FramingError}
   */
  push(chunk) {
    if (this._failure) throw this._failure;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const out = [];
    while (this._buf.length >= TPKT_HEADER) {
      if (this._buf[0] !== 3) this._fail(`TPKT version ${this._buf[0]} (expected 3)`);
      const total = this._buf.readUInt16BE(2);
      if (total < TPKT_HEADER + 3) this._fail(`TPKT length ${total} too short`);
      if (this._buf.length < total) break;
      const frame = this._buf.subarray(TPKT_HEADER, total);
      this._buf = this._buf.subarray(total);
      const msg = this._cotp(frame);
      if (msg) out.push(msg);
    }
    return out;
  }

  _cotp(frame) {
    const li = frame[0];
    if (li < 2 || li + 1 > frame.length) this._fail(`COTP length indicator ${li} invalid for a ${frame.length}-byte TPDU`);
    const type = frame[1] & 0xf0;
    if (type === COTP.DT) {
      if (li !== 2) this._fail(`COTP DT length indicator ${li} (expected 2)`);
      const data = frame.subarray(3);
      this._fragmentBytes += data.length;
      if (this._fragmentBytes > this._maxPduBytes) this._fail(`reassembled S7 PDU exceeds ${this._maxPduBytes} bytes`);
      this._fragments.push(Buffer.from(data));
      if (!(frame[2] & 0x80)) return null; // more fragments follow
      const pdu = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
      this._fragments = [];
      this._fragmentBytes = 0;
      return { type: 'DT', data: pdu };
    }
    if (type === COTP.CC || type === COTP.CR) {
      if (li < 6) this._fail(`COTP ${type === COTP.CC ? 'CC' : 'CR'} too short`);
      let params;
      try {
        params = parseCotpParams(frame.subarray(7, li + 1));
      } catch (err) {
        this._fail(err.message);
      }
      return {
        type: type === COTP.CC ? 'CC' : 'CR',
        dstRef: frame.readUInt16BE(2),
        srcRef: frame.readUInt16BE(4),
        params,
      };
    }
    if (type === COTP.DR || type === COTP.ER || type === COTP.DC) {
      return { type: type === COTP.ER ? 'ER' : 'DR', raw: Buffer.from(frame) };
    }
    this._fail(`unknown COTP PDU type 0x${frame[1].toString(16)}`);
    return null;
  }

  _fail(message) {
    this._failure = new S7FramingError(message);
    throw this._failure;
  }
}

// ── S7 PDU parsing ─────────────────────────────────────────────────────────

/**
 * Split an S7 PDU into header fields, parameter and data. Throws
 * S7FramingError when the header is malformed or its lengths disagree with
 * the PDU size.
 */
function parseS7Pdu(buf) {
  if (buf.length < S7_JOB_HEADER) throw new S7FramingError(`S7 PDU of ${buf.length} bytes is shorter than a header`);
  if (buf[0] !== 0x32) throw new S7FramingError(`S7 protocol id 0x${buf[0].toString(16)} (expected 0x32)`);
  const rosctr = buf[1];
  if (![ROSCTR.JOB, ROSCTR.ACK, ROSCTR.ACK_DATA, ROSCTR.USERDATA].includes(rosctr)) {
    throw new S7FramingError(`unknown S7 ROSCTR ${rosctr}`);
  }
  const headLen = rosctr === ROSCTR.ACK || rosctr === ROSCTR.ACK_DATA ? S7_ACK_HEADER : S7_JOB_HEADER;
  if (buf.length < headLen) throw new S7FramingError(`S7 PDU of ${buf.length} bytes is shorter than its ${headLen}-byte header`);
  const paramLength = buf.readUInt16BE(6);
  const dataLength = buf.readUInt16BE(8);
  if (headLen + paramLength + dataLength !== buf.length) {
    throw new S7FramingError(
      `S7 lengths (header ${headLen} + param ${paramLength} + data ${dataLength}) disagree with PDU size ${buf.length}`
    );
  }
  return {
    rosctr,
    pduRef: buf.readUInt16BE(4),
    errorClass: headLen === S7_ACK_HEADER ? buf[10] : 0,
    errorCode: headLen === S7_ACK_HEADER ? buf[11] : 0,
    param: buf.subarray(headLen, headLen + paramLength),
    data: buf.subarray(headLen + paramLength),
  };
}

/** @returns {{maxAmqCalling:number, maxAmqCalled:number, pduSize:number}} */
function parseSetupCommResponse(pdu) {
  if (pdu.rosctr !== ROSCTR.ACK_DATA) throw new S7MismatchError(`setup communication answered with ROSCTR ${pdu.rosctr}`);
  if (pdu.param.length !== 8 || pdu.param[0] !== FUNC.SETUP_COMM) {
    throw new S7MismatchError('setup communication response has an unexpected parameter block');
  }
  return {
    maxAmqCalling: pdu.param.readUInt16BE(2),
    maxAmqCalled: pdu.param.readUInt16BE(4),
    pduSize: pdu.param.readUInt16BE(6),
  };
}

function dataByteLength(ts, len) {
  // BIT, BYTE/WORD/DWORD and INTEGER carry the length in bits; the rest in bytes.
  if (ts === TS_DATA.BIT || ts === TS_DATA.BYTE || ts === TS_DATA.INT) return Math.ceil(len / 8);
  return len;
}

/**
 * Parse a Read Var ack-data against the items requested.
 * @param {object} pdu from parseS7Pdu
 * @param {{length:number}[]} items the requested items, in order
 * @returns {({ok:true, data:Buffer} | {ok:false, code:number, name:string})[]}
 * @throws {S7MismatchError} when the response cannot belong to this request
 */
function parseReadVarResponse(pdu, items) {
  if (pdu.rosctr !== ROSCTR.ACK_DATA) throw new S7MismatchError(`Read Var answered with ROSCTR ${pdu.rosctr}`);
  if (pdu.param.length !== 2 || pdu.param[0] !== FUNC.READ_VAR) {
    throw new S7MismatchError('Read Var response has an unexpected parameter block');
  }
  if (pdu.param[1] !== items.length) {
    throw new S7MismatchError(`Read Var response has ${pdu.param[1]} items, request had ${items.length}`);
  }
  const d = pdu.data;
  const out = [];
  let o = 0;
  for (let i = 0; i < items.length; i++) {
    if (o + READ_RESPONSE_ITEM_HEAD > d.length) throw new S7MismatchError(`Read Var response truncated at item ${i}`);
    const rc = d[o];
    const ts = d[o + 1];
    const n = dataByteLength(ts, d.readUInt16BE(o + 2));
    o += READ_RESPONSE_ITEM_HEAD;
    if (o + n > d.length) throw new S7MismatchError(`Read Var item ${i} overruns the response`);
    if (rc === 0xff) {
      if (n !== items[i].length) {
        throw new S7MismatchError(`Read Var item ${i} returned ${n} bytes, requested ${items[i].length}`);
      }
      out.push({ ok: true, data: Buffer.from(d.subarray(o, o + n)) });
    } else {
      out.push({ ok: false, code: rc, name: ITEM_RETURN_NAMES[rc] || `unknown return code 0x${rc.toString(16)}` });
    }
    o += n;
    if (n % 2 === 1 && i < items.length - 1) o += 1; // fill byte keeps the next item word-aligned
  }
  if (o !== d.length) throw new S7MismatchError(`Read Var response has ${d.length - o} trailing bytes`);
  return out;
}

/**
 * Parse a read-SZL userdata response (first data unit only; continuation
 * units are not requested — see NOTES.md).
 * @returns {{szlId:number, szlIndex:number, recordLength:number, records:Buffer[], more:boolean}}
 * @throws {S7MismatchError} on structure errors, Error with `.code` for SZL errors
 */
function parseSzlResponse(pdu) {
  if (pdu.rosctr !== ROSCTR.USERDATA) throw new S7MismatchError(`SZL read answered with ROSCTR ${pdu.rosctr}`);
  const p = pdu.param;
  if (p.length < 8 || p[0] !== 0x00 || p[1] !== 0x01 || p[2] !== 0x12) {
    throw new S7MismatchError('SZL response has an unexpected parameter head');
  }
  if ((p[5] & 0x0f) !== 0x4 || p[6] !== 0x01) throw new S7MismatchError('SZL response is not a CPU-functions/read-SZL answer');
  const more = p.length >= 10 ? p[9] !== 0x00 : false;
  const errorCode = p.length >= 12 ? p.readUInt16BE(10) : 0;
  const d = pdu.data;
  if (errorCode !== 0 || d.length < 4 || d[0] !== 0xff) {
    const code = errorCode || (d.length ? d[0] : 0);
    const err = new Error(`SZL read refused (code 0x${code.toString(16)})`);
    err.code = code;
    throw err;
  }
  const len = d.readUInt16BE(2);
  if (4 + len > d.length || len < 8) throw new S7MismatchError('SZL response data length is inconsistent');
  const body = d.subarray(4, 4 + len);
  const recordLength = body.readUInt16BE(4);
  const count = body.readUInt16BE(6);
  const records = [];
  for (let i = 0, o = 8; i < count && o + recordLength <= body.length && recordLength > 0; i++, o += recordLength) {
    records.push(Buffer.from(body.subarray(o, o + recordLength)));
  }
  return { szlId: body.readUInt16BE(0), szlIndex: body.readUInt16BE(2), recordLength, records, more };
}

// ── error vocabulary ───────────────────────────────────────────────────────

const ITEM_RETURN_NAMES = Object.freeze({
  0x00: 'reserved',
  0x01: 'hardware fault',
  0x03: 'accessing the object not allowed',
  0x05: 'invalid address (out of range)',
  0x06: 'data type not supported',
  0x07: 'data type inconsistent',
  0x0a: 'object does not exist',
  0xff: 'success',
});

const PUTGET_HINT = 'PUT/GET not permitted, optimized block access enabled, or protection level too high';

/**
 * Operator-language explanation of a Read Var item return code.
 * @param {number} code
 * @param {string} [area] 'DB' | 'M' | 'I' | 'Q'
 */
function explainItemCode(code, area) {
  switch (code) {
    case 0x05:
      return area === 'DB' ? 'DB shorter than the requested range' : `address beyond the end of the ${area || 'memory'} area`;
    case 0x0a:
      return area === 'DB' ? 'DB does not exist' : `${area || 'area'} not available on this CPU`;
    case 0x03:
      return PUTGET_HINT;
    case 0x01:
      return 'CPU reported a hardware fault for this address';
    case 0x06:
    case 0x07:
      return 'CPU rejected the data type of the request';
    default:
      return ITEM_RETURN_NAMES[code] || `CPU returned item code 0x${code.toString(16)}`;
  }
}

const ERROR_CLASS_NAMES = Object.freeze({
  0x00: 'no error',
  0x81: 'application relationship error',
  0x82: 'object definition error',
  0x83: 'no resources available',
  0x84: 'error on service processing',
  0x85: 'error on supplies',
  0x87: 'access error',
});

/**
 * Translate a whole-request error (header error class + code of an ack-data).
 * @returns {{code:number, name:string, classification:'permanent'|'retry', message:string}}
 */
function explainHeaderError(errorClass, errorCode) {
  const code = (errorClass << 8) | errorCode;
  const name = `${ERROR_CLASS_NAMES[errorClass] || `error class 0x${errorClass.toString(16)}`} (0x${code.toString(16).padStart(4, '0')})`;
  let classification = 'permanent';
  let message;
  if (errorClass === 0x83) {
    classification = 'retry';
    message = 'CPU has no free communication resources; will retry';
  } else if (code === 0x8104 || errorClass === 0x87 || errorClass === 0x81) {
    message = `CPU refused the request: ${PUTGET_HINT}`;
  } else if (errorClass === 0x85) {
    message = 'CPU rejected the request size (larger than the negotiated PDU)';
  } else if (errorClass === 0x84) {
    classification = 'retry';
    message = 'CPU could not process the request at the moment; will retry';
  } else {
    message = `CPU rejected the request: ${name}`;
  }
  return { code, name, classification, message };
}

module.exports = {
  COTP,
  ROSCTR,
  FUNC,
  AREA,
  AREA_NAME,
  TS_DATA,
  MAX_READ_ITEMS,
  MAX_BYTE_OFFSET,
  READ_RESPONSE_OVERHEAD,
  READ_RESPONSE_ITEM_HEAD,
  readRequestSize,
  S7ReadOnlyError,
  S7FramingError,
  S7MismatchError,
  CONNECTION_TYPE,
  remoteTsapFor,
  encodeConnectRequest,
  encodeS7Frame,
  TpktParser,
  parseS7Pdu,
  parseSetupCommResponse,
  parseReadVarResponse,
  parseSzlResponse,
  ITEM_RETURN_NAMES,
  explainItemCode,
  explainHeaderError,
  PUTGET_HINT,
};
