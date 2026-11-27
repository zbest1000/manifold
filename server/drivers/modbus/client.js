'use strict';

/**
 * Modbus TCP client: one socket, exactly one request in flight, strict
 * response validation. Any timeout, mismatch or framing error destroys the
 * socket for good, so a late reply can never be matched to a later request
 * (docs/design/driver-contract.md, design rules).
 *
 * Result shape of `request()` (it RESOLVES; it never rejects for device or
 * transport problems, only throws for programmer errors such as a write
 * function code or an out-of-range field):
 *   { ok:true, data:Buffer }
 *   { ok:false, kind:'exception', code, name, classification }   socket stays up
 *   { ok:false, kind:'timeout'|'mismatch'|'framing'|'transport', message }
 *       the socket has been destroyed; reconnect with connect()
 *   { ok:false, kind:'queue-full', message }                      socket unaffected
 * Queued requests behind a failed one resolve with kind 'transport'.
 */

const net = require('node:net');
const { encodeRequest, matchResponse, classifyException, FrameParser, ModbusFramingError } = require('./frame');

const MAX_QUEUE = 64;
const CLOSE_GRACE_MS = 500;

class ModbusClient {
  /**
   * @param {{host:string, port?:number, connectTimeoutMs?:number, maxQueue?:number,
   *   socketFactory?:(opts:{host:string, port:number}) => net.Socket}} opts
   */
  constructor({ host, displayHost, port = 502, connectTimeoutMs = 5000, maxQueue = MAX_QUEUE, socketFactory } = {}) {
    this.host = host; // the address the socket opens (a validated, pinned IP when the device has a hostname)
    this.displayHost = displayHost || host; // what messages and logs call it
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxQueue = maxQueue;
    this._factory = socketFactory || (({ host: h, port: p }) => net.createConnection({ host: h, port: p }));
    this._sock = null;
    this._connected = false;
    this._parser = null;
    this._tid = 0;
    this._inflight = null;
    this._queue = [];
  }

  /** @returns {boolean} true while a usable socket is established */
  isConnected() {
    return this._connected;
  }

  /**
   * Open a fresh socket (any previous one is destroyed first).
   * @returns {Promise<void>} rejects with an Error on refusal, reset or connect timeout
   */
  connect() {
    this.destroy('reconnect');
    const sock = this._factory({ host: this.host, port: this.port });
    this._sock = sock;
    this._parser = new FrameParser();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          if (this._sock === sock) this._sock = null;
          sock.destroy();
          reject(err);
        } else {
          this._connected = true;
          resolve();
        }
      };
      const timer = setTimeout(() => done(new Error(`connect to ${this.displayHost}:${this.port} timed out`)), this.connectTimeoutMs);
      timer.unref();
      sock.once('connect', () => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 10_000);
        done();
      });
      sock.on('error', (err) => {
        if (!settled) done(err);
        else if (this._sock === sock) this._fail('transport', err.message);
      });
      sock.on('close', () => {
        if (!settled) done(new Error('connection closed during connect'));
        else if (this._sock === sock) this._fail('transport', 'connection closed by peer');
      });
      sock.on('data', (chunk) => {
        if (this._sock === sock && settled) this._onData(chunk);
      });
    });
  }

  /**
   * Issue one read. Waits in a bounded FIFO behind the request in flight. The
   * deadline starts when the frame is written, not while queued.
   * @param {{unitId:number, fc:number, address:number, quantity:number}} req
   * @param {number} deadlineMs
   * @returns {Promise<object>} see the module doc for the result shape
   * @throws {ModbusReadOnlyError|RangeError} (as a rejection) for an invalid request
   */
  async request({ unitId, fc, address, quantity }, deadlineMs) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError('deadlineMs must be a positive number');
    encodeRequest({ tid: 0, unitId, fc, address, quantity }); // validate (and enforce the allowlist) up front
    if (!this._connected) return { ok: false, kind: 'transport', message: 'not connected' };
    if (this._queue.length >= this.maxQueue) {
      return { ok: false, kind: 'queue-full', message: `more than ${this.maxQueue} requests queued` };
    }
    return new Promise((resolve) => {
      this._queue.push({ unitId, fc, address, quantity, deadlineMs, resolve });
      this._pump();
    });
  }

  /** Orderly shutdown: pending requests fail with 'transport', then FIN and wait for close. */
  async close() {
    const sock = this._sock;
    this._drain('transport', 'client closed');
    if (!sock) return;
    this._sock = null;
    this._connected = false;
    await new Promise((resolve) => {
      const t = setTimeout(() => sock.destroy(), CLOSE_GRACE_MS);
      t.unref();
      sock.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      sock.end();
    });
  }

  /** Immediately drop the socket; pending requests fail with 'transport'. */
  destroy(reason = 'destroyed') {
    this._fail('transport', reason);
  }

  _pump() {
    if (this._inflight || !this._queue.length || !this._connected) return;
    const item = this._queue.shift();
    this._tid = (this._tid + 1) & 0xffff;
    const tid = this._tid;
    const sock = this._sock;
    const timer = setTimeout(
      () => this._fail('timeout', `no response within ${item.deadlineMs} ms (unit ${item.unitId} fc ${item.fc} @${item.address}+${item.quantity})`),
      item.deadlineMs
    );
    timer.unref();
    this._inflight = {
      req: { tid, unitId: item.unitId, fc: item.fc, quantity: item.quantity },
      resolve: item.resolve,
      timer,
    };
    // The only socket write in this module; encodeRequest enforces read-only.
    const frame = encodeRequest({ tid, unitId: item.unitId, fc: item.fc, address: item.address, quantity: item.quantity });
    sock.write(frame, (err) => {
      if (err && this._sock === sock) this._fail('transport', err.message);
    });
  }

  _onData(chunk) {
    let adus;
    try {
      adus = this._parser.push(chunk);
    } catch (err) {
      this._fail(err instanceof ModbusFramingError ? 'framing' : 'transport', err.message);
      return;
    }
    if (!adus.length) return;
    // We never have more than one request outstanding, so >1 ADU (or any ADU
    // with nothing in flight) can only be a stale or foreign response.
    if (adus.length > 1 || !this._inflight) {
      this._fail('mismatch', this._inflight ? 'more than one response for one request' : 'unsolicited response');
      return;
    }
    const { req, resolve, timer } = this._inflight;
    const m = matchResponse(req, adus[0]);
    if (m.kind === 'mismatch') {
      this._fail('mismatch', m.reason);
      return;
    }
    clearTimeout(timer);
    this._inflight = null;
    resolve(m.ok ? m : { ...m, classification: classifyException(m.code) });
    this._pump();
  }

  /** Kill the socket and fail everything: the in-flight request with `kind`, the queue with 'transport'. */
  _fail(kind, message) {
    const sock = this._sock;
    this._sock = null;
    this._connected = false;
    if (sock) sock.destroy();
    this._drain(kind, message);
  }

  _drain(kind, message) {
    const inflight = this._inflight;
    this._inflight = null;
    if (inflight) {
      clearTimeout(inflight.timer);
      inflight.resolve({ ok: false, kind, message });
    }
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) q.resolve({ ok: false, kind: 'transport', message: `connection lost: ${message}` });
  }
}

module.exports = { ModbusClient, MAX_QUEUE };
