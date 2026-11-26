'use strict';

/**
 * CoAP client transaction layer over a CoapUdpSocket (RFC 7252, 7959, 7641).
 *
 * What it does
 *  - Confirmable GET with RFC 7252 retransmission: first timeout is
 *    ACK_TIMEOUT x random(1, ACK_RANDOM_FACTOR), doubled after every
 *    retransmission, up to MAX_RETRANSMIT retransmissions.
 *  - Message-id and token matching. A response only completes an exchange when
 *    its token (and, for piggybacked ones, its message id) matches. Tokens are
 *    8 random bytes, so an off-path sender cannot guess them.
 *  - Piggybacked responses, and separate responses: an empty ACK stops the
 *    retransmission, the CON or NON response that follows is matched by token
 *    (a CON one is ACKed). A response that overtakes its empty ACK is accepted.
 *  - Deduplication of incoming CON/NON messages by message id (EXCHANGE_LIFETIME),
 *    answering a duplicate CON with the same ACK again, never processing it twice.
 *  - Reset handling: a RST for our message id fails the exchange with kind
 *    'reset'; a CON/NON response that matches nothing is answered with RST.
 *  - NSTART outstanding exchanges per device (default 1); the rest wait in a
 *    bounded queue with their own deadlines.
 *  - Block-wise transfer of responses (Block2): size negotiation (the first
 *    request proposes our size, the server's size wins), ETag consistency,
 *    restart on a changed ETag, an overall size cap, a fall-back for servers
 *    that answer 4.02 to a Block2 option.
 *  - Observe: registration, notification freshness (RFC 7641 section 3.4),
 *    ACKing CON notifications, re-registration when Max-Age passes without a
 *    notification or after a failed/reset registration, block-wise notifications,
 *    and deregistration (GET with Observe=1) on close.
 *
 * Results never reject for network problems:
 *   { ok:true, response }                         a CoAP response arrived (any code)
 *   { ok:false, kind:'timeout'|'reset'|'transport'|'protocol'|'toolarge'|'closed', message }
 * The only requests this module can create are GET and empty messages (see ./message.js).
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const msgs = require('./message');

const { TYPE, OPT } = msgs;
const EXCHANGE_LIFETIME_MS = 247000;
const MAX_SEEN = 512;
const MAX_QUEUE = 256;
const MAX_RESTARTS = 2;

const DEFAULTS = {
  ackTimeoutMs: 2000,
  ackRandomFactor: 1.5,
  maxRetransmit: 4,
  nstart: 1,
  blockSize: 1024,
  maxResponseBytes: 262144,
  observeGraceMs: 5000,
  defaultMaxAgeS: 60,
  reregisterBackoffMs: [1000, 2000, 5000, 15000, 60000],
  closeGraceMs: 800
};

const hex = (b) => b.toString('hex');

class CoapClient extends EventEmitter {
  /**
   * @param {{socket: import('./coapUdp').CoapUdpSocket, random?:()=>number, now?:()=>number} & Partial<typeof DEFAULTS>} opts
   */
  constructor(opts) {
    super();
    const o = { ...DEFAULTS, ...opts };
    this.socket = o.socket;
    this.cfg = {
      ackTimeoutMs: o.ackTimeoutMs,
      ackRandomFactor: o.ackRandomFactor,
      maxRetransmit: o.maxRetransmit,
      nstart: Math.max(1, o.nstart),
      szx: msgs.szxForSize(o.blockSize),
      maxResponseBytes: o.maxResponseBytes,
      observeGraceMs: o.observeGraceMs,
      defaultMaxAgeS: o.defaultMaxAgeS,
      reregisterBackoffMs: o.reregisterBackoffMs,
      closeGraceMs: o.closeGraceMs
    };
    this._random = o.random || Math.random;
    this._now = o.now || Date.now;
    this._mid = crypto.randomInt(0, 0x10000);
    this._pending = new Map(); // mid -> exchange
    this._byToken = new Map(); // token hex -> exchange
    this._queue = [];
    this._active = 0;
    this._seen = new Map(); // mid -> { at, ack?: Buffer }
    this._obs = new Map(); // key -> observation
    this._obsByToken = new Map(); // token hex -> observation
    this._closed = false;
    this._broken = null;
    this._noBlock2 = false;
    this.stats = {
      requests: 0,
      retransmissions: 0,
      timeouts: 0,
      resets: 0,
      duplicates: 0,
      malformed: 0,
      unmatched: 0,
      ignored: 0,
      separate: 0,
      blocks: 0,
      notifications: 0,
      staleNotifications: 0,
      reregistrations: 0,
      maxInFlight: 0,
      lastRttMs: null
    };
    this._onMessage = (buf) => this._onDatagram(buf);
    this._onSocketError = (err) => this._failAll('transport', /ECONNREFUSED/.test(err.code || err.message) ? 'port unreachable (the device answered with ICMP port unreachable)' : `socket error: ${err.message}`);
    this._onSocketClosed = () => {
      if (!this._closed) this._failAll('transport', 'socket closed');
    };
    this.socket.on('message', this._onMessage);
    this.socket.on('socket-error', this._onSocketError);
    this.socket.on('closed', this._onSocketClosed);
  }

  isConnected() {
    return !this._closed && !this._broken && this.socket.isOpen();
  }

  // ---- low-level exchange ---------------------------------------------------------

  /**
   * One confirmable GET (or a ping when spec.ping) and its response. Queued
   * behind NSTART.
   * @param {{path?:string[], query?:string[], accept?:number, observe?:number, block2?:{num:number,szx:number},
   *   uriHost?:string, token?:Buffer, ping?:boolean, observeKey?:string, spec?:object}} spec
   * @param {number} deadlineAt absolute ms
   */
  exchange(spec, deadlineAt) {
    if (this._closed) return Promise.resolve({ ok: false, kind: 'closed', message: 'client is closed' });
    if (this._broken) return Promise.resolve({ ok: false, kind: 'transport', message: this._broken });
    if (this._queue.length >= MAX_QUEUE) return Promise.resolve({ ok: false, kind: 'transport', message: `more than ${MAX_QUEUE} requests queued` });
    return new Promise((resolve) => {
      const item = { spec, deadlineAt, resolve, timer: null };
      item.timer = setTimeout(() => {
        const i = this._queue.indexOf(item);
        if (i >= 0) {
          this._queue.splice(i, 1);
          this.stats.timeouts++;
          resolve({ ok: false, kind: 'timeout', message: 'the request waited in the queue until its deadline' });
        }
      }, Math.max(0, deadlineAt - this._now()));
      item.timer.unref();
      this._queue.push(item);
      this._pump();
    });
  }

  _pump() {
    while (this._active < this.cfg.nstart && this._queue.length && !this._closed) {
      const item = this._queue.shift();
      clearTimeout(item.timer);
      if (this._now() >= item.deadlineAt) {
        this.stats.timeouts++;
        item.resolve({ ok: false, kind: 'timeout', message: 'the request waited in the queue until its deadline' });
        continue;
      }
      this._active++;
      if (this._active > this.stats.maxInFlight) this.stats.maxInFlight = this._active;
      this._start(item);
    }
  }

  _allocMid() {
    for (let i = 0; i < 0x10000; i++) {
      this._mid = (this._mid + 1) & 0xffff;
      if (!this._pending.has(this._mid)) return this._mid;
    }
    throw new Error('no free message id');
  }

  _start(item) {
    const { spec, deadlineAt, resolve } = item;
    const mid = this._allocMid();
    const token = spec.ping ? Buffer.alloc(0) : spec.token || crypto.randomBytes(8);
    const ex = {
      mid,
      token,
      tokenHex: hex(token),
      spec,
      resolve,
      acked: false,
      rtx: 0,
      timeout: this.cfg.ackTimeoutMs * (1 + this._random() * (this.cfg.ackRandomFactor - 1)),
      timer: null,
      deadlineTimer: null,
      sentAt: this._now(),
      buf: spec.ping ? msgs.encodePing(mid) : msgs.encodeGet({ ...spec, mid, token })
    };
    this._pending.set(mid, ex);
    if (!spec.ping) this._byToken.set(ex.tokenHex, ex);
    this.stats.requests++;
    ex.deadlineTimer = setTimeout(() => {
      this.stats.timeouts++;
      this._finish(ex, { ok: false, kind: 'timeout', message: ex.acked ? 'the device acknowledged the request but sent no response before the deadline' : `no response within the deadline (${ex.rtx} retransmission${ex.rtx === 1 ? '' : 's'})` });
    }, Math.max(0, deadlineAt - this._now()));
    ex.deadlineTimer.unref();
    this._transmit(ex);
  }

  _transmit(ex) {
    this.socket.send(ex.buf).catch((err) => {
      if (this._pending.get(ex.mid) === ex) this._finish(ex, { ok: false, kind: 'transport', message: `send failed: ${err.message}` });
    });
    ex.timer = setTimeout(() => this._retransmit(ex), ex.timeout);
    ex.timer.unref();
  }

  _retransmit(ex) {
    if (this._pending.get(ex.mid) !== ex || ex.acked) return;
    if (ex.rtx >= this.cfg.maxRetransmit) {
      this.stats.timeouts++;
      this._finish(ex, { ok: false, kind: 'timeout', message: `no response after ${ex.rtx} retransmissions` });
      return;
    }
    ex.rtx++;
    ex.timeout *= 2;
    this.stats.retransmissions++;
    this._transmit(ex);
  }

  _finish(ex, result) {
    if (this._pending.get(ex.mid) !== ex) return;
    clearTimeout(ex.timer);
    clearTimeout(ex.deadlineTimer);
    this._pending.delete(ex.mid);
    this._byToken.delete(ex.tokenHex);
    this._active--;
    if (result.ok) {
      this.stats.lastRttMs = this._now() - ex.sentAt;
      result.rttMs = this.stats.lastRttMs;
      result.tokenHex = ex.tokenHex;
      if (result.msg) this._maybeStartObservation(ex, result.msg);
    }
    ex.resolve(result);
    this._pump();
  }

  _failAll(kind, message) {
    if (this._closed) return;
    this._broken = message;
    for (const ex of [...this._pending.values()]) this._finish(ex, { ok: false, kind, message });
    const queued = this._queue;
    this._queue = [];
    for (const item of queued) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, kind, message });
    }
    for (const obs of this._obs.values()) clearTimeout(obs.timer);
  }

  // ---- incoming datagrams -----------------------------------------------------------

  _sendEmpty(type, mid) {
    const buf = msgs.encodeEmpty(type, mid);
    this.socket.send(buf).catch(() => {});
    return buf;
  }

  _remember(mid) {
    const now = this._now();
    if (this._seen.size >= MAX_SEEN) {
      for (const [k, v] of this._seen) {
        if (now - v.at > EXCHANGE_LIFETIME_MS || this._seen.size >= MAX_SEEN) this._seen.delete(k);
        else break;
      }
    }
    const e = { at: now, ack: null };
    this._seen.set(mid, e);
    return e;
  }

  _onDatagram(buf) {
    if (this._closed) return;
    let m;
    try {
      m = msgs.decode(buf);
    } catch {
      this.stats.malformed++;
      return;
    }
    if (m.type === TYPE.RST) {
      const ex = this._pending.get(m.mid);
      if (!ex) {
        this.stats.ignored++;
        return;
      }
      if (ex.spec.ping) this._finish(ex, { ok: true, pong: true });
      else {
        this.stats.resets++;
        this._finish(ex, { ok: false, kind: 'reset', message: 'the device answered with a Reset (it cannot process the request)' });
      }
      return;
    }
    if (m.code === msgs.EMPTY) {
      if (m.type === TYPE.ACK) {
        const ex = this._pending.get(m.mid);
        if (!ex) {
          this.stats.ignored++;
          return;
        }
        if (ex.spec.ping) {
          this._finish(ex, { ok: true, pong: true });
          return;
        }
        if (!ex.acked) {
          ex.acked = true;
          this.stats.separate++;
          clearTimeout(ex.timer);
        }
      } else if (m.type === TYPE.CON) {
        this._sendEmpty(TYPE.RST, m.mid); // a ping from the peer: answer, as the RFC says
      }
      return;
    }
    if (m.code < 0x40) {
      // A request: this client serves nothing.
      if (m.type === TYPE.CON) this._sendEmpty(TYPE.RST, m.mid);
      this.stats.ignored++;
      return;
    }
    // A response (piggybacked on an ACK, or a separate CON/NON one, or a notification).
    if (m.type === TYPE.CON || m.type === TYPE.NON) {
      const dup = this._seen.get(m.mid);
      if (dup && this._now() - dup.at <= EXCHANGE_LIFETIME_MS) {
        this.stats.duplicates++;
        if (m.type === TYPE.CON && dup.ack) this.socket.send(dup.ack).catch(() => {});
        return;
      }
      const seen = this._remember(m.mid);
      const ack = () => {
        if (m.type === TYPE.CON) seen.ack = this._sendEmpty(TYPE.ACK, m.mid);
      };
      const hexToken = hex(m.token);
      const ex = this._byToken.get(hexToken);
      if (ex) {
        ack();
        this._finish(ex, { ok: true, msg: m });
        return;
      }
      const obs = this._obsByToken.get(hexToken);
      if (obs) {
        ack();
        this._onNotification(obs, m);
        return;
      }
      this.stats.unmatched++;
      this._sendEmpty(TYPE.RST, m.mid);
      return;
    }
    // ACK carrying a response.
    const ex = this._pending.get(m.mid);
    if (!ex || ex.spec.ping || hex(m.token) !== ex.tokenHex) {
      this.stats.ignored++;
      return;
    }
    this._finish(ex, { ok: true, msg: m });
  }

  // ---- GET with block-wise assembly --------------------------------------------------

  _summary(first, payload, blocks) {
    return {
      code: first.code,
      codeText: msgs.codeLabel(first.code),
      payload,
      cf: msgs.optionUint(first, OPT.CONTENT_FORMAT),
      maxAge: msgs.optionUint(first, OPT.MAX_AGE) ?? this.cfg.defaultMaxAgeS,
      etag: msgs.option(first, OPT.ETAG),
      observe: msgs.optionUint(first, OPT.OBSERVE),
      blocks,
      receivedAt: this._now()
    };
  }

  /**
   * GET one resource, following Block2 until the body is complete.
   * @param {{path?:string[], query?:string[], accept?:number, observe?:number, uriHost?:string}} spec
   * @param {number} deadlineAt absolute ms for the whole transfer
   * @param {{observeKey?:string}} [extra]
   * @returns {Promise<{ok:true, response:object, rttMs:number, tokenHex:string}|{ok:false, kind:string, message:string}>}
   */
  async get(spec, deadlineAt, extra = {}) {
    for (let restart = 0; ; restart++) {
      const sendBlock = !this._noBlock2;
      let r = await this.exchange({ ...spec, observeKey: extra.observeKey, block2: sendBlock ? { num: 0, szx: this.cfg.szx } : undefined }, deadlineAt);
      if (!r.ok) return r;
      if (sendBlock && r.msg.code === 0x82) {
        // 4.02 Bad Option: this device does not know Block2. Remember, and ask again plainly.
        this._noBlock2 = true;
        r = await this.exchange({ ...spec, observeKey: extra.observeKey }, deadlineAt);
        if (!r.ok) return r;
      }
      const a = await this._assemble(spec, r.msg, deadlineAt);
      if (a === 'restart') {
        if (restart >= MAX_RESTARTS) return { ok: false, kind: 'protocol', message: 'the resource kept changing while its blocks were being fetched (ETag differs between blocks)' };
        continue;
      }
      if (!a.ok) return a;
      return { ok: true, response: a.response, rttMs: r.rttMs, tokenHex: r.tokenHex };
    }
  }

  async _assemble(spec, first, deadlineAt) {
    const ok = (payload, blocks) => ({ ok: true, response: this._summary(first, payload, blocks) });
    if (msgs.codeClass(first.code) !== 2) return ok(first.payload, 1);
    let b;
    try {
      const bo = msgs.option(first, OPT.BLOCK2);
      b = bo ? msgs.decodeBlock(bo) : null;
    } catch (err) {
      return { ok: false, kind: 'protocol', message: `bad Block2 option: ${err.message}` };
    }
    if (!b) return ok(first.payload, 1);
    const size2 = msgs.optionUint(first, OPT.SIZE2);
    if (size2 !== undefined && size2 > this.cfg.maxResponseBytes) {
      return { ok: false, kind: 'toolarge', message: `the resource is ${size2} bytes, over the ${this.cfg.maxResponseBytes} byte limit` };
    }
    if (b.num !== 0) return { ok: false, kind: 'protocol', message: `the device answered block 0 with block ${b.num}` };
    if (b.more && first.payload.length !== b.size) return { ok: false, kind: 'protocol', message: `block 0 carries ${first.payload.length} bytes but its size is ${b.size}` };
    const etag = msgs.option(first, OPT.ETAG);
    const chunks = [first.payload];
    let total = first.payload.length;
    let blocks = 1;
    const maxBlocks = Math.ceil(this.cfg.maxResponseBytes / 16) + 2;
    while (b.more) {
      if (total > this.cfg.maxResponseBytes) return { ok: false, kind: 'toolarge', message: `the response is over the ${this.cfg.maxResponseBytes} byte limit` };
      if (blocks > maxBlocks) return { ok: false, kind: 'protocol', message: 'too many blocks' };
      if (total % b.size !== 0) return { ok: false, kind: 'protocol', message: 'the device changed its block size to one that does not divide the data received so far' };
      const num = total / b.size;
      const r = await this.exchange({ path: spec.path, query: spec.query, accept: spec.accept, uriHost: spec.uriHost, block2: { num, szx: b.szx } }, deadlineAt);
      if (!r.ok) return r;
      this.stats.blocks++;
      const m = r.msg;
      if (msgs.codeClass(m.code) !== 2) return { ok: true, response: this._summary(m, m.payload, blocks + 1) };
      const e2 = msgs.option(m, OPT.ETAG);
      if ((etag && (!e2 || !etag.equals(e2))) || (!etag && e2)) return 'restart';
      let nb;
      try {
        const bo = msgs.option(m, OPT.BLOCK2);
        if (!bo) return { ok: false, kind: 'protocol', message: `block ${num} came back without a Block2 option` };
        nb = msgs.decodeBlock(bo);
      } catch (err) {
        return { ok: false, kind: 'protocol', message: `bad Block2 option: ${err.message}` };
      }
      if (nb.num !== num) return { ok: false, kind: 'protocol', message: `asked for block ${num}, got block ${nb.num}` };
      if (nb.more && m.payload.length !== nb.size) return { ok: false, kind: 'protocol', message: `block ${num} carries ${m.payload.length} bytes but its size is ${nb.size}` };
      chunks.push(m.payload);
      total += m.payload.length;
      blocks++;
      b = nb;
    }
    if (total > this.cfg.maxResponseBytes) return { ok: false, kind: 'toolarge', message: `the response is over the ${this.cfg.maxResponseBytes} byte limit` };
    return ok(Buffer.concat(chunks), blocks);
  }

  /** CoAP ping (an empty confirmable message): resolves { ok:true, pong:true, rttMs } when the device answers with RST or ACK. */
  ping(deadlineAt) {
    return this.exchange({ ping: true }, deadlineAt);
  }

  // ---- observe ---------------------------------------------------------------------------

  /**
   * Register an observation (GET with Observe=0) and return the first response.
   * The server's notifications are then kept in the observation (see
   * `observation(key)`); a server that ignores Observe leaves no observation.
   * @returns {Promise<{ok:true, response:object, observing:boolean}|{ok:false, kind:string, message:string}>}
   */
  async observe(key, spec, deadlineAt) {
    const r = await this.get({ ...spec, observe: 0 }, deadlineAt, { observeKey: key });
    if (!r.ok) return r;
    const obs = this._obs.get(key);
    const mine = obs && obs.tokenHex === r.tokenHex;
    if (mine && obs.state === 'active' && obs.latest === null) {
      // The registration body was fetched in blocks: it is the latest unless a newer notification landed meanwhile.
      if (obs.seq === r.response.observe) obs.latest = r.response;
    }
    return { ok: true, response: r.response, observing: Boolean(mine && obs.state === 'active') };
  }

  /** The current state of an observation, or null. */
  observation(key) {
    const o = this._obs.get(key);
    if (!o) return null;
    return { state: o.state, latest: o.latest, seq: o.seq, reregistering: o.reregistering, failures: o.failures };
  }

  _maybeStartObservation(ex, m) {
    // Called from the exchange path: a registration response that carries Observe starts the observation.
    const key = ex.spec.observeKey;
    if (!key || ex.spec.observe !== 0 || msgs.codeClass(m.code) !== 2) return;
    const seq = msgs.optionUint(m, OPT.OBSERVE);
    if (seq === undefined) return;
    const old = this._obs.get(key);
    if (old) this._dropObservation(old);
    const bo = msgs.option(m, OPT.BLOCK2);
    let more = false;
    try {
      more = bo ? msgs.decodeBlock(bo).more : false;
    } catch {
      more = true;
    }
    const obs = {
      key,
      spec: { path: ex.spec.path, query: ex.spec.query, accept: ex.spec.accept, uriHost: ex.spec.uriHost },
      token: ex.token,
      tokenHex: ex.tokenHex,
      seq,
      seqAt: this._now(),
      state: 'active',
      latest: more ? null : this._summary(m, m.payload, 1),
      timer: null,
      gen: 0,
      failures: 0,
      reregistering: false
    };
    this._obs.set(key, obs);
    this._obsByToken.set(obs.tokenHex, obs);
    this._arm(obs, msgs.optionUint(m, OPT.MAX_AGE));
  }

  _dropObservation(obs) {
    clearTimeout(obs.timer);
    obs.timer = null;
    obs.state = 'dropped';
    if (this._obs.get(obs.key) === obs) this._obs.delete(obs.key);
    if (this._obsByToken.get(obs.tokenHex) === obs) this._obsByToken.delete(obs.tokenHex);
  }

  _arm(obs, maxAgeS) {
    clearTimeout(obs.timer);
    const age = (maxAgeS ?? this.cfg.defaultMaxAgeS) * 1000;
    obs.timer = setTimeout(() => this._reregister(obs), age + this.cfg.observeGraceMs);
    obs.timer.unref();
  }

  _onNotification(obs, m) {
    this.stats.notifications++;
    const now = this._now();
    const seq = msgs.optionUint(m, OPT.OBSERVE);
    if (msgs.codeClass(m.code) !== 2 || seq === undefined) {
      // The server ended the relationship (an error code, or a response without Observe).
      clearTimeout(obs.timer);
      obs.state = 'ended';
      obs.latest = this._summary(m, m.payload, 1);
      obs.timer = setTimeout(() => this._reregister(obs), this.cfg.reregisterBackoffMs[0]);
      obs.timer.unref();
      return;
    }
    if (!msgs.observeIsFresh(obs.seq, obs.seqAt, seq, now)) {
      this.stats.staleNotifications++;
      return;
    }
    obs.seq = seq;
    obs.seqAt = now;
    this._arm(obs, msgs.optionUint(m, OPT.MAX_AGE));
    let b = null;
    try {
      const bo = msgs.option(m, OPT.BLOCK2);
      b = bo ? msgs.decodeBlock(bo) : null;
    } catch {
      b = { num: 0, more: false, szx: 0, size: 16, bad: true };
    }
    if (!b) {
      obs.latest = this._summary(m, m.payload, 1);
      obs.gen++;
      return;
    }
    if (b.bad || b.num !== 0) return;
    if (!b.more) {
      obs.latest = this._summary(m, m.payload, 1);
      obs.gen++;
      return;
    }
    // A notification too big for one datagram: fetch the remaining blocks, then replace the value.
    const gen = ++obs.gen;
    this._assemble(obs.spec, m, now + 10000)
      .then((a) => {
        if (a && a.ok && obs.gen === gen && obs.state === 'active') obs.latest = a.response;
      })
      .catch(() => {});
  }

  async _reregister(obs) {
    obs.timer = null;
    if (this._closed || this._broken || this._obs.get(obs.key) !== obs) return;
    obs.reregistering = true;
    this.stats.reregistrations++;
    const r = await this.observe(obs.key, obs.spec, this._now() + Math.max(5000, this.cfg.ackTimeoutMs * 8)).catch(() => ({ ok: false, kind: 'transport' }));
    obs.reregistering = false;
    if (this._closed || this._broken) return;
    if (r.ok && r.observing) return; // the new observation replaced this one
    if (r.ok) {
      // The device answered but no longer observes: stop (the caller falls back to polling).
      this._dropObservation(obs);
      return;
    }
    if (this._obs.get(obs.key) !== obs) return;
    obs.failures++;
    const steps = this.cfg.reregisterBackoffMs;
    obs.timer = setTimeout(() => this._reregister(obs), steps[Math.min(obs.failures, steps.length - 1)]);
    obs.timer.unref();
  }

  // ---- shutdown ----------------------------------------------------------------------------

  /** Deregister every observation (GET with Observe=1, a read), best effort within the grace period. */
  async deregisterAll() {
    const list = [...this._obs.values()].filter((o) => o.state === 'active');
    const deadlineAt = this._now() + this.cfg.closeGraceMs;
    for (const o of this._obs.values()) {
      clearTimeout(o.timer);
      o.timer = null;
    }
    await Promise.all(
      list.map(async (o) => {
        this._obsByToken.delete(o.tokenHex); // late notifications now get a RST, which also tells the server to stop
        await this.exchange({ ...o.spec, observe: 1, token: o.token }, deadlineAt).catch(() => {});
      })
    );
    this._obs.clear();
  }

  async close() {
    if (this._closed) return;
    if (!this._broken && this.socket.isOpen()) await this.deregisterAll().catch(() => {});
    this._closed = true;
    for (const o of this._obs.values()) clearTimeout(o.timer);
    this._obs.clear();
    this._obsByToken.clear();
    for (const ex of [...this._pending.values()]) {
      clearTimeout(ex.timer);
      clearTimeout(ex.deadlineTimer);
      this._pending.delete(ex.mid);
      this._byToken.delete(ex.tokenHex);
      this._active--;
      ex.resolve({ ok: false, kind: 'closed', message: 'client closed' });
    }
    for (const item of this._queue) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, kind: 'closed', message: 'client closed' });
    }
    this._queue = [];
    this.socket.removeListener('message', this._onMessage);
    this.socket.removeListener('socket-error', this._onSocketError);
    this.socket.removeListener('closed', this._onSocketClosed);
    await this.socket.close();
  }
}

module.exports = { CoapClient, DEFAULTS, EXCHANGE_LIFETIME_MS };
