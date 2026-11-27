'use strict';

/**
 * Modbus TCP framing: request encoder, streaming response parser and response
 * validation. Read-only by construction — `encodeRequest` is the only function
 * that builds outgoing frames and it refuses every function code except the
 * four read codes (docs/design/driver-contract.md, read-only by construction).
 */

const READ_FUNCTION_CODES = new Set([1, 2, 3, 4]);
const MBAP_LENGTH = 6; // tid(2) + protocol(2) + length(2), before the unit id

class ModbusReadOnlyError extends Error {
  constructor(fc) {
    super(`Modbus function code ${fc} is refused: this driver is read-only (allowed: 1, 2, 3, 4)`);
    this.name = 'ModbusReadOnlyError';
    this.fc = fc;
  }
}

/** Unrecoverable framing violation: the caller must destroy the socket. */
class ModbusFramingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModbusFramingError';
  }
}

function assertInt(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
}

/**
 * Build a Modbus TCP read request (MBAP header + PDU).
 * @param {{tid:number, unitId:number, fc:number, address:number, quantity:number}} req
 * @returns {Buffer}
 * @throws {ModbusReadOnlyError} for any function code other than 1, 2, 3, 4
 * @throws {RangeError} for out-of-range fields
 */
function encodeRequest({ tid, unitId, fc, address, quantity }) {
  if (!READ_FUNCTION_CODES.has(fc)) throw new ModbusReadOnlyError(fc);
  assertInt('tid', tid, 0, 0xffff);
  assertInt('unitId', unitId, 0, 255);
  assertInt('address', address, 0, 0xffff);
  assertInt('quantity', quantity, 1, fc <= 2 ? 2000 : 125);
  if (address + quantity > 0x10000) {
    throw new RangeError(`address ${address} + quantity ${quantity} exceeds 65536`);
  }
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(tid, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(6, 4);
  buf.writeUInt8(unitId, 6);
  buf.writeUInt8(fc, 7);
  buf.writeUInt16BE(address, 8);
  buf.writeUInt16BE(quantity, 10);
  return buf;
}

/**
 * Streaming parser for Modbus TCP responses. Feed it raw TCP chunks; it
 * returns every complete ADU. After a framing error the parser is poisoned
 * and every further `push` rethrows: the caller must drop the socket.
 */
class FrameParser {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._failure = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {{tid:number, unitId:number, fc:number, data:Buffer}[]} complete ADUs;
   *   `data` is everything after the function code
   * @throws {ModbusFramingError} on a non-zero protocol id or a bad length field
   */
  push(chunk) {
    if (this._failure) throw this._failure;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const adus = [];
    while (this._buf.length >= MBAP_LENGTH) {
      const protocol = this._buf.readUInt16BE(2);
      const length = this._buf.readUInt16BE(4);
      if (protocol !== 0) this._fail(`unexpected protocol id ${protocol}`);
      if (length < 2 || length > 254) this._fail(`invalid length field ${length}`);
      const total = MBAP_LENGTH + length;
      if (this._buf.length < total) break;
      adus.push({
        tid: this._buf.readUInt16BE(0),
        unitId: this._buf[6],
        fc: this._buf[7],
        data: Buffer.from(this._buf.subarray(8, total)),
      });
      this._buf = this._buf.subarray(total);
    }
    return adus;
  }

  _fail(message) {
    this._failure = new ModbusFramingError(message);
    throw this._failure;
  }
}

const EXCEPTION_NAMES = {
  0x01: 'illegal function',
  0x02: 'illegal data address',
  0x03: 'illegal data value',
  0x04: 'server device failure',
  0x05: 'acknowledge',
  0x06: 'server device busy',
  0x0a: 'gateway path unavailable',
  0x0b: 'gateway target device failed to respond',
};

const EXCEPTION_CLASS = {
  0x01: 'permanent',
  0x02: 'permanent',
  0x03: 'permanent',
  0x04: 'retry',
  0x05: 'retry',
  0x06: 'retry',
  0x0a: 'gateway',
  0x0b: 'unit-down',
};

/**
 * Classify an exception code: 'permanent' (do not retry; 02 means bisect),
 * 'retry' (back off and retry), 'unit-down' (trip that unit's breaker only),
 * 'gateway' (gateway alarm). Unknown codes are 'permanent'.
 * @param {number} code
 * @returns {'permanent'|'retry'|'unit-down'|'gateway'}
 */
function classifyException(code) {
  return EXCEPTION_CLASS[code] || 'permanent';
}

/**
 * Validate a response ADU against the request that is in flight.
 *
 * A `mismatch` result means the stream can no longer be trusted (a late or
 * foreign response): the caller MUST destroy the socket and never reuse it.
 *
 * @param {{tid:number, unitId:number, fc:number, quantity:number}} request
 * @param {{tid:number, unitId:number, fc:number, data:Buffer}} adu
 * @returns {{ok:true, data:Buffer}
 *   | {ok:false, kind:'exception', code:number, name:string}
 *   | {ok:false, kind:'mismatch', reason:string}}
 */
function matchResponse(request, adu) {
  const mismatch = (reason) => ({ ok: false, kind: 'mismatch', reason });
  if (adu.tid !== request.tid) return mismatch(`transaction id ${adu.tid} != ${request.tid}`);
  if (adu.unitId !== request.unitId) return mismatch(`unit id ${adu.unitId} != ${request.unitId}`);
  if (adu.fc === (request.fc | 0x80)) {
    if (adu.data.length !== 1) return mismatch(`exception PDU has ${adu.data.length} data bytes`);
    const code = adu.data[0];
    return { ok: false, kind: 'exception', code, name: EXCEPTION_NAMES[code] || `unknown (0x${code.toString(16)})` };
  }
  if (adu.fc !== request.fc) return mismatch(`function code ${adu.fc} != ${request.fc}`);
  const expected = request.fc <= 2 ? Math.ceil(request.quantity / 8) : request.quantity * 2;
  if (adu.data.length !== expected + 1 || adu.data[0] !== expected) {
    return mismatch(`byte count ${adu.data[0]} (payload ${adu.data.length - 1}) != expected ${expected}`);
  }
  return { ok: true, data: adu.data.subarray(1) };
}

module.exports = {
  READ_FUNCTION_CODES,
  ModbusReadOnlyError,
  ModbusFramingError,
  encodeRequest,
  FrameParser,
  EXCEPTION_NAMES,
  classifyException,
  matchResponse,
};
