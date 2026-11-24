'use strict';

/**
 * S7comm socket client: TCP → COTP CR/CC → setup communication, then one job
 * in flight at a time.
 *
 * Safety rules (design §3 rule 2, §4.3):
 * - every job has a deadline; on expiry the socket is destroyed and never reused,
 *   so a late reply can never be matched to a later request;
 * - every response must carry the PDU reference of the job in flight, anything
 *   else (wrong reference, unsolicited data) destroys the socket;
 * - a framing error poisons the parser and destroys the socket;
 * - TCP keepalive and TCP_NODELAY are set; every socket error is handled.
 */

const net = require('net');
const {
  ROSCTR,
  FUNC,
  S7FramingError,
  S7MismatchError,
  TpktParser,
  encodeConnectRequest,
  encodeS7Frame,
  parseS7Pdu,
  parseSetupCommResponse,
  explainHeaderError,
} = require('./frame');

class S7TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S7TimeoutError';
  }
}

class S7TransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'S7TransportError';
    if (code) this.code = code;
  }
}

/** Header-level error class/code on an ack-data (the CPU refused the job). */
class S7ExceptionError extends Error {
  constructor(info) {
    super(info.message);
    this.name = 'S7ExceptionError';
    Object.assign(this, info);
  }
}

/** Map any client error to the driver's failure kind. */
function errorKind(err) {
  if (err instanceof S7TimeoutError) return 'timeout';
  if (err instanceof S7MismatchError) return 'mismatch';
  if (err instanceof S7FramingError) return 'framing';
  return 'transport';
}

class S7Client {
  /**
   * @param {{host:string, port?:number, localTsap?:number, remoteTsap:number, pduSize?:number,
   *   maxAmq?:number, connectTimeoutMs?:number, keepAliveMs?:number}} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 102;
    this.localTsap = opts.localTsap ?? 0x0100;
    this.remoteTsap = opts.remoteTsap;
    this.requestedPdu = opts.pduSize || 960;
    this.requestedAmq = opts.maxAmq || 1;
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.keepAliveMs = opts.keepAliveMs || 10000;
    this.state = 'idle'; // idle | connecting | online | closed
    this.negotiated = null;
    this.lastError = null;
    this._socket = null;
    this._parser = null;
    this._pending = null;
    this._pduRef = 0;
    this._queue = Promise.resolve();
  }

  isConnected() {
    return this.state === 'online';
  }

  /**
   * @returns {Promise<{pduSize:number, maxAmqCalling:number, maxAmqCalled:number}>}
   * @throws on any failure; the socket is destroyed
   */
  async connect() {
    if (this.state !== 'idle') throw new Error(`S7Client.connect() called in state ${this.state}; create a new client`);
    this.state = 'connecting';
    const deadline = Date.now() + this.connectTimeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this._socket = socket;
      this._parser = new TpktParser();
      socket.setNoDelay(true);
      socket.setKeepAlive(true, this.keepAliveMs);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => this._fault(new S7TransportError(`socket error: ${err.message}`, err.code)));
      socket.on('close', () => this._fault(new S7TransportError('connection closed by the CPU')));

      await this._await({ kind: 'tcp' }, remaining(), 'TCP connect', () => socket.once('connect', () => this._settle(null)));

      await this._await({ kind: 'cc' }, remaining(), 'COTP connect', () =>
        socket.write(encodeConnectRequest({ localTsap: this.localTsap, remoteTsap: this.remoteTsap }))
      );

      const pdu = await this._job(
        { type: 'job', func: FUNC.SETUP_COMM, pduSize: this.requestedPdu, maxAmqCalling: this.requestedAmq, maxAmqCalled: this.requestedAmq },
        remaining(),
        'setup communication'
      );
      if (pdu.errorClass || pdu.errorCode) {
        throw new S7ExceptionError(explainHeaderError(pdu.errorClass, pdu.errorCode));
      }
      const neg = parseSetupCommResponse(pdu);
      if (neg.pduSize < 32 || neg.pduSize > this.requestedPdu) {
        throw new S7MismatchError(`CPU negotiated PDU size ${neg.pduSize} outside 32..${this.requestedPdu}`);
      }
      this.negotiated = neg;
      this.state = 'online';
      return { ...neg };
    } catch (err) {
      this._fault(err);
      throw err;
    }
  }

  /**
   * Send one allowlisted job and resolve with the parsed response PDU. Jobs
   * are serialized: at most one is in flight.
   * @param {object} job descriptor for frame.encodeS7Frame (pduRef is assigned here)
   * @param {number} deadlineMs
   * @returns {Promise<object>} parsed PDU (frame.parseS7Pdu)
   */
  request(job, deadlineMs) {
    const run = () => {
      if (this.state !== 'online') return Promise.reject(new S7TransportError('not connected'));
      return this._job(job, deadlineMs, 'request');
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  _job(job, deadlineMs, label) {
    this._pduRef = (this._pduRef % 0xffff) + 1;
    const pduRef = this._pduRef;
    // Encoding happens before any state change: a refused (non-read) job throws
    // here and nothing reaches the socket.
    const frame = encodeS7Frame({ ...job, pduRef });
    return this._await({ kind: 'pdu', pduRef }, deadlineMs, label, () => this._socket.write(frame));
  }

  _await(spec, ms, label, start) {
    if (this._pending) return Promise.reject(new Error('internal: a job is already in flight'));
    if (!this._socket || this._socket.destroyed) return Promise.reject(new S7TransportError('not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._fault(new S7TimeoutError(`${label} timed out after ${ms} ms; socket destroyed`));
      }, ms);
      this._pending = { ...spec, resolve, reject, timer };
      start();
    });
  }

  _settle(err, value) {
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  _onData(chunk) {
    let msgs;
    try {
      msgs = this._parser.push(chunk);
    } catch (err) {
      this._fault(err);
      return;
    }
    for (const msg of msgs) {
      if (this.state === 'closed') return;
      const p = this._pending;
      if (msg.type === 'DR' || msg.type === 'ER') {
        const during = p && p.kind === 'cc';
        this._fault(
          new S7TransportError(
            during
              ? 'CPU rejected the ISO connection: check rack/slot (or TSAP) and that the CPU accepts PUT/GET clients'
              : `CPU closed the ISO connection (COTP ${msg.type})`
          )
        );
        return;
      }
      if (msg.type === 'CC' && p && p.kind === 'cc') {
        this._settle(null, msg);
        continue;
      }
      if (msg.type === 'DT' && p && p.kind === 'pdu') {
        let pdu;
        try {
          pdu = parseS7Pdu(msg.data);
        } catch (err) {
          this._fault(err);
          return;
        }
        if (pdu.pduRef !== p.pduRef) {
          this._fault(new S7MismatchError(`response PDU reference ${pdu.pduRef} != ${p.pduRef}; socket destroyed`));
          return;
        }
        if (pdu.rosctr === ROSCTR.JOB) {
          this._fault(new S7MismatchError('CPU sent a job instead of a response'));
          return;
        }
        this._settle(null, pdu);
        continue;
      }
      this._fault(new S7MismatchError(`unexpected ${msg.type} message with nothing matching in flight; socket destroyed`));
      return;
    }
  }

  /** Destroy the socket (never reused) and fail whatever is in flight. Idempotent. */
  destroy(err = new S7TransportError('connection destroyed by the driver')) {
    this._fault(err);
  }

  _fault(err) {
    if (this.state === 'closed') {
      this._settle(err);
      return;
    }
    this.state = 'closed';
    this.lastError = err;
    if (this._socket) this._socket.destroy();
    this._settle(err);
  }

  /** Orderly close: FIN, then destroy if the peer does not finish within 500 ms. */
  close() {
    const socket = this._socket;
    if (this.state === 'closed' || !socket) {
      this.state = 'closed';
      return Promise.resolve();
    }
    this.state = 'closed';
    this._settle(new S7TransportError('connection closed by the driver'));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 500);
      timer.unref();
      socket.once('close', done);
      socket.end();
    });
  }
}

module.exports = { S7Client, S7TimeoutError, S7TransportError, S7ExceptionError, errorKind };
