'use strict';

/**
 * JSON command/answer session over a WsClient, shared by the bridge drivers. The protocol
 * specifics live in two functions the driver passes in:
 *
 *   encode(command, args, id) -> string   builds the outgoing text. This is the ONLY way a
 *                                          message reaches the socket, and each driver's encode
 *                                          refuses every command that is not on its read-only
 *                                          allow-list.
 *   classify(obj) -> { kind:'hello', data } | { kind:'result', id, ok, result, error }
 *                  | { kind:'event', data } | { kind:'ignore' } | null (malformed)
 *
 * Text that is not JSON, a binary message, or an object `classify` cannot place means the
 * stream can no longer be trusted (an update may have been lost): the connection is dropped
 * and the runtime reconnects, which reloads the full state. Answers to unknown ids (late,
 * after a timeout) are ignored.
 */

const { EventEmitter } = require('events');
const { WsClient } = require('./wsClient');

class BridgeError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

class JsonWsSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.target from wsTarget()
   * @param {(command:string, args:object, id:string)=>string} o.encode
   * @param {(obj:any)=>object|null} o.classify
   * @param {object} [o.ws] WsClient options (caps, keepalive, timeouts)
   * @param {number} [o.maxPending=256]
   * @param {(o:object)=>WsClient} [o.createWs] test hook
   */
  constructor(o) {
    super();
    this.target = o.target;
    this.encode = o.encode;
    this.classify = o.classify;
    this.wsOptions = o.ws || {};
    this.maxPending = o.maxPending || 256;
    this.createWs = o.createWs || ((opts) => new WsClient(opts));
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.lostReason = null;
    this.stats = { sent: 0, received: 0, events: 0, malformed: 0 };
  }

  isOpen() {
    return Boolean(this.ws && this.ws.isOpen() && !this.lostReason);
  }

  /** Connect and wait for the server's greeting. Resolves with the greeting's data. */
  async open(helloTimeoutMs) {
    const t = this.target;
    this.ws = this.createWs({
      ...this.wsOptions,
      address: t.address,
      hostname: t.hostname,
      port: t.port,
      path: t.path,
      secure: t.secure,
      tls: t.tls,
      headers: t.headers,
    });
    let helloResolve;
    let helloReject;
    const hello = new Promise((res, rej) => {
      helloResolve = res;
      helloReject = rej;
    });
    hello.catch(() => {}); // awaited below; never an unhandled rejection in between
    this._hello = { resolve: helloResolve, reject: helloReject, done: false };
    this.ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    this.ws.on('close', (c) => this._lost(c.error ? c.error.message : `closed by the server (code ${c.code}${c.reason ? `: ${c.reason}` : ''})`));
    await this.ws.connect();
    const timer = setTimeout(() => this._lost(`no greeting from the server within ${helloTimeoutMs} ms`), helloTimeoutMs);
    if (timer.unref) timer.unref();
    try {
      return await hello;
    } finally {
      clearTimeout(timer);
    }
  }

  _onMessage(data, isBinary) {
    if (this.lostReason) return;
    this.stats.received++;
    let obj;
    if (isBinary) return this._malformed('binary message');
    try {
      obj = JSON.parse(data);
    } catch {
      return this._malformed('message is not JSON');
    }
    let c;
    try {
      c = this.classify(obj);
    } catch (e) {
      c = null;
      void e;
    }
    if (!c) return this._malformed('message of an unknown shape');
    if (c.kind === 'ignore') return;
    if (c.kind === 'hello') {
      if (!this._hello.done) {
        this._hello.done = true;
        this._hello.resolve(c.data);
      } else {
        this.emit('hello', c.data);
      }
      return;
    }
    if (!this._hello.done) return this._malformed('first message was not the server greeting');
    if (c.kind === 'result') {
      const p = this.pending.get(String(c.id));
      if (!p) return;
      this.pending.delete(String(c.id));
      clearTimeout(p.timer);
      if (c.ok) p.resolve(c.result);
      else p.reject(new BridgeError('server', c.error || 'command failed', { code: c.code, command: p.command }));
      return;
    }
    if (c.kind === 'event') {
      this.stats.events++;
      try {
        this.emit('event', c.data);
      } catch (e) {
        this._lost(`event handler failed: ${e.message}`);
      }
    }
  }

  _malformed(what) {
    this.stats.malformed++;
    this._lost(`protocol error: ${what}; reconnecting to reload the state`);
    if (this.ws) this.ws.destroy(what);
  }

  /** Send a command; resolves with its result. Only the driver's encode can produce the text. */
  request(command, args, timeoutMs) {
    if (!this.isOpen()) return Promise.reject(new BridgeError('closed', this.lostReason || 'not connected'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new BridgeError('busy', 'too many commands in flight'));
    const id = `m${++this.seq}`;
    const text = this.encode(command, args || {}, id); // throws for a command off the allow-list
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `${command}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, command });
      try {
        this.ws.send(text);
        this.stats.sent++;
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('closed', e.message));
      }
    });
  }

  _lost(reason) {
    if (this.lostReason) return;
    this.lostReason = reason;
    if (this._hello && !this._hello.done) {
      this._hello.done = true;
      this._hello.reject(new BridgeError('closed', reason));
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('closed', reason));
    }
    this.pending.clear();
    this.emit('lost', reason);
  }

  async close() {
    const ws = this.ws;
    this._lost('closed by Manifold');
    if (ws) await ws.close(1000, 'bye').catch(() => {});
  }
}

module.exports = { JsonWsSession, BridgeError };
