'use strict';

const crypto = require('crypto');

/**
 * BACnet/IP client for ONE device: one UDP socket (ephemeral local port), confirmed requests
 * matched by invoke id, APDU timeout + retries, Who-Is/I-Am.
 *
 * UDP has no connection to destroy after a timeout, so the TCP drivers' "late reply can never be
 * matched to a later request" rule is kept differently:
 *   - a reply is accepted only from the device's IP address (any source port: some devices and
 *     routers answer from a port other than the one we sent to), only with the expected NPDU
 *     source (SNET/SADR for a routed device, none for a local one), only for a pending invoke id,
 *     and only when its service choice matches the request;
 *   - an invoke id whose request timed out is retired for `retireMs` before it is used again, so
 *     a late reply to it is dropped instead of answering a newer request;
 *   - close() releases the socket; the next connect() binds a new one (new port), so nothing from
 *     an earlier session reaches the new one.
 * Retries re-send the same datagram with the same invoke id (clause 5.4.5.3).
 *
 * `request()` RESOLVES (never rejects for device or transport problems):
 *   { ok:true, apdu }                                                   ComplexACK / SimpleACK
 *   { ok:false, kind:'error', errorClass, errorCode }                   Error PDU
 *   { ok:false, kind:'reject', reason } | { ok:false, kind:'abort', reason, server }
 *   { ok:false, kind:'segmented', message }   the device segmented although we said we cannot reassemble
 *   { ok:false, kind:'timeout'|'unreachable'|'transport'|'queue-full', message }
 */

const dgram = require('node:dgram');
const net = require('node:net');
const frame = require('./frame');

const MAX_QUEUE = 256;
const DEFAULT_RETIRE_MS = 10_000;

function normIp(a) {
  return String(a || '').replace(/^::ffff:/i, '').toLowerCase();
}

function macText(mac) {
  if (!mac) return '';
  if (mac.length === 1) return String(mac[0]);
  if (mac.length === 6) return `${mac[0]}.${mac[1]}.${mac[2]}.${mac[3]}:${mac.readUInt16BE(4)}`;
  return mac.toString('hex').match(/../g).join(':');
}

class BacnetClient {
  /**
   * @param {object} o
   * @param {string} o.host IP address to send to (already validated and pinned by the main process)
   * @param {string} [o.displayHost] what messages call it
   * @param {number} [o.port]
   * @param {{network:number, mac:Buffer}|null} [o.route] device behind a BACnet router
   * @param {number} [o.maxOutstanding] confirmed requests in flight at once
   * @param {number} [o.retireMs]
   * @param {Function} [o.socketFactory] (type) => dgram.Socket (tests)
   */
  constructor({ host, displayHost, port = 47808, route = null, maxOutstanding = 1, retireMs = DEFAULT_RETIRE_MS, socketFactory, onSend } = {}) {
    if (!net.isIP(String(host))) throw new Error(`BACnet/IP needs an IP address to send to, got "${host}"`);
    this.host = normIp(host);
    this.displayHost = displayHost || host;
    this.port = port;
    this.route = route;
    this.maxOutstanding = Math.max(1, Math.min(32, maxOutstanding | 0 || 1));
    this.retireMs = retireMs;
    this._factory = socketFactory || ((type) => dgram.createSocket({ type }));
    this._onSend = onSend || null; // test hook: observe every outgoing datagram
    this._sock = null;
    this._open = false;
    this._pending = new Map(); // invokeId -> entry
    this._retired = new Map(); // invokeId -> until (ms)
    this._queue = [];
    this._nextId = crypto.randomInt(256);
    this._iAmWaiters = new Set();
    this.stats = { sent: 0, received: 0, retries: 0, timeouts: 0, foreign: 0, malformed: 0, late: 0, routedElsewhere: null, wrongService: 0 };
  }

  isOpen() {
    return this._open;
  }

  /** Bind a fresh socket on an ephemeral port. */
  open() {
    this.close();
    const type = net.isIPv6(this.host) ? 'udp6' : 'udp4';
    const sock = this._factory(type);
    this._sock = sock;
    return new Promise((resolve, reject) => {
      let settled = false;
      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          if (this._sock === sock) this._sock = null;
          try {
            sock.close();
          } catch {
            /* already closed */
          }
          reject(err);
          return;
        }
        if (this._sock === sock) {
          this._open = false;
          this._failAll('transport', `socket error: ${err.message}`);
        }
      });
      sock.on('message', (msg, rinfo) => {
        if (this._sock === sock) this._onMessage(msg, rinfo);
      });
      sock.bind(0, () => {
        settled = true;
        this._open = true;
        resolve();
      });
    });
  }

  close() {
    const sock = this._sock;
    this._sock = null;
    this._open = false;
    this._failAll('transport', 'client closed');
    if (sock) {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    }
  }

  _send(packet) {
    if (!this._sock || !this._open) return false;
    if (this._onSend) this._onSend(packet);
    this.stats.sent++;
    this._sock.send(packet, this.port, this.host, (err) => {
      if (err && this._open) {
        this._open = false;
        this._failAll('transport', `send failed: ${err.message}`);
      }
    });
    return true;
  }

  // ---- invoke ids ------------------------------------------------------------------------------

  _allocId(now) {
    for (const [id, until] of this._retired) if (until <= now) this._retired.delete(id);
    for (let i = 0; i < 256; i++) {
      const id = (this._nextId + i) & 0xff;
      if (!this._pending.has(id) && !this._retired.has(id)) {
        this._nextId = (id + 1) & 0xff;
        return id;
      }
    }
    return -1;
  }

  /** Number of confirmed requests on the wire now (test hook; counts this client's own work). */
  inFlight() {
    return this._pending.size;
  }

  // ---- confirmed requests ----------------------------------------------------------------------

  /**
   * @param {(invokeId:number) => Buffer} build packet builder (frame.readPropertyPacket ...)
   * @param {{service:number, apduTimeoutMs:number, retries:number, deadlineMs:number, label?:string}} opts
   */
  request(build, { service, apduTimeoutMs = 3000, retries = 3, deadlineMs, label = 'request' }) {
    if (!this._open) return Promise.resolve({ ok: false, kind: 'transport', message: 'not connected' });
    if (this._queue.length >= MAX_QUEUE) return Promise.resolve({ ok: false, kind: 'queue-full', message: `more than ${MAX_QUEUE} requests queued` });
    const deadlineAt = Date.now() + (deadlineMs ?? apduTimeoutMs * (retries + 1));
    return new Promise((resolve) => {
      this._queue.push({ build, service, apduTimeoutMs, retries, deadlineAt, label, resolve });
      this._pump();
    });
  }

  _pump() {
    while (this._open && this._queue.length && this._pending.size < this.maxOutstanding) {
      const now = Date.now();
      const id = this._allocId(now);
      if (id < 0) {
        // Every id is pending or retired: try again when the earliest retirement ends.
        const next = Math.min(...this._retired.values());
        if (!this._pumpTimer) {
          this._pumpTimer = setTimeout(() => {
            this._pumpTimer = null;
            this._pump();
          }, Math.max(1, next - now));
          this._pumpTimer.unref?.();
        }
        return;
      }
      const item = this._queue.shift();
      if (now >= item.deadlineAt) {
        item.resolve({ ok: false, kind: 'timeout', message: `${item.label}: deadline passed while queued` });
        continue;
      }
      let packet;
      try {
        packet = item.build(id); // read-only allowlist enforced inside the encoder
      } catch (err) {
        item.resolve({ ok: false, kind: 'invalid', message: err.message, error: err });
        continue;
      }
      const entry = { id, item, packet, attempt: 0, timer: null };
      this._pending.set(id, entry);
      this._attempt(entry);
    }
  }

  _attempt(entry) {
    const { item } = entry;
    const remaining = item.deadlineAt - Date.now();
    if (entry.attempt > item.retries || remaining <= 0) {
      this._finish(entry, this._timeoutResult(entry));
      this._retired.set(entry.id, Date.now() + this.retireMs);
      return;
    }
    if (entry.attempt > 0) this.stats.retries++;
    entry.attempt++;
    if (!this._send(entry.packet)) {
      this._finish(entry, { ok: false, kind: 'transport', message: 'not connected' });
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this._pending.get(entry.id) === entry) this._attempt(entry);
    }, Math.min(item.apduTimeoutMs, remaining));
    entry.timer.unref?.();
  }

  _timeoutResult(entry) {
    this.stats.timeouts++;
    const where = this.route ? `${this.displayHost}:${this.port} via network ${this.route.network} MAC ${macText(this.route.mac)}` : `${this.displayHost}:${this.port}`;
    let message = `${entry.item.label}: no answer from ${where} after ${entry.attempt} attempt${entry.attempt === 1 ? '' : 's'}`;
    const r = this.stats.routedElsewhere;
    if (r) {
      message += this.route
        ? `; replies did arrive from network ${r.snet} MAC ${macText(r.sadr)}: check the network number and MAC`
        : `; replies did arrive from network ${r.snet} MAC ${macText(r.sadr)}: this device is behind a BACnet router, set Network ${r.snet} and MAC ${macText(r.sadr)}`;
    }
    return { ok: false, kind: 'timeout', message };
  }

  _finish(entry, result) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this._pending.get(entry.id) === entry) this._pending.delete(entry.id);
    entry.item.resolve(result);
    setImmediate(() => this._pump());
  }

  _failAll(kind, message) {
    if (this._pumpTimer) clearTimeout(this._pumpTimer);
    this._pumpTimer = null;
    for (const entry of [...this._pending.values()]) {
      if (entry.timer) clearTimeout(entry.timer);
      this._pending.delete(entry.id);
      entry.item.resolve({ ok: false, kind, message });
    }
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) q.resolve({ ok: false, kind, message });
    for (const w of this._iAmWaiters) w(null);
    this._iAmWaiters.clear();
  }

  // ---- receive ---------------------------------------------------------------------------------

  _sourceMatches(npdu) {
    if (this.route) return npdu.snet === this.route.network && npdu.sadr && npdu.sadr.equals(this.route.mac);
    return npdu.snet === undefined;
  }

  _onMessage(msg, rinfo) {
    // Egress pinning in reverse: only the device's own address may answer. Anything else
    // (another device, a spoofed or broadcast datagram) is counted and dropped.
    if (normIp(rinfo.address) !== this.host) {
      this.stats.foreign++;
      return;
    }
    let pkt;
    try {
      pkt = frame.decodePacket(msg);
    } catch {
      this.stats.malformed++;
      return;
    }
    this.stats.received++;
    if (pkt.bvlcResult !== undefined) {
      // A BVLC-Result NAK from a BBMD is not an answer to a confirmed request; ignore.
      return;
    }
    if (pkt.networkMessage) {
      const m = pkt.networkMessage;
      if (m.type === 0x03 && this.route && (m.network === this.route.network || m.network === undefined)) {
        // The socket is fine; only the requests to that network are lost.
        this._failAll('unreachable', `the BACnet router at ${this.displayHost} cannot reach network ${this.route.network}: ${m.reasonText || 'rejected'}`);
      }
      return;
    }
    if (!pkt.apdu) return;
    if (!this._sourceMatches(pkt.npdu)) {
      if (pkt.npdu.snet !== undefined) this.stats.routedElsewhere = { snet: pkt.npdu.snet, sadr: pkt.npdu.sadr };
      this.stats.foreign++;
      return;
    }
    let apdu;
    try {
      apdu = frame.decodeApdu(pkt.apdu);
    } catch {
      this.stats.malformed++;
      return;
    }
    if (apdu.type === 'unconfirmed-request') {
      if (apdu.service === frame.UNCONFIRMED.I_AM) {
        let iam;
        try {
          iam = frame.parseIAm(apdu.body);
        } catch {
          this.stats.malformed++;
          return;
        }
        for (const w of [...this._iAmWaiters]) w(iam);
      }
      return; // other unconfirmed traffic (COV, time sync, Who-Has ...) is not for us
    }
    if (apdu.type === 'confirmed-request' || apdu.type === 'segment-ack') return; // we serve nothing
    const entry = this._pending.get(apdu.invokeId);
    if (!entry) {
      this.stats.late++;
      return;
    }
    const svc = entry.item.service;
    if ((apdu.type === 'complex-ack' || apdu.type === 'simple-ack' || apdu.type === 'error') && apdu.service !== svc) {
      this.stats.wrongService++;
      return; // not the answer to this request: keep waiting (and retrying)
    }
    let result;
    switch (apdu.type) {
      case 'complex-ack':
        result = apdu.segmented
          ? { ok: false, kind: 'segmented', message: 'the device sent a segmented reply although this client does not accept segmentation' }
          : { ok: true, apdu };
        break;
      case 'simple-ack':
        result = { ok: true, apdu };
        break;
      case 'error':
        result = { ok: false, kind: 'error', errorClass: apdu.errorClass, errorCode: apdu.errorCode };
        break;
      case 'reject':
        result = { ok: false, kind: 'reject', reason: apdu.reason };
        break;
      case 'abort':
        result = { ok: false, kind: 'abort', reason: apdu.reason, server: apdu.server };
        break;
      default:
        return;
    }
    this._finish(entry, result);
  }

  // ---- Who-Is / I-Am ---------------------------------------------------------------------------

  /**
   * Send a unicast Who-Is (limited to `instance` when known) and wait up to `waitMs` for the I-Am.
   * Many devices answer Who-Is with a BROADCAST I-Am to port 47808, which this socket (ephemeral
   * port) never sees, so a null result is not proof of absence: callers fall back to ReadProperty.
   * @returns {Promise<object|null>} parsed I-Am or null
   */
  whoIs({ instance, waitMs = 1000 } = {}) {
    if (!this._open) return Promise.resolve(null);
    const limits = Number.isInteger(instance) ? { low: instance, high: instance } : undefined;
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (iam) => {
        if (iam && limits && iam.instance !== instance) return;
        clearTimeout(timer);
        this._iAmWaiters.delete(waiter);
        resolve(iam);
      };
      this._iAmWaiters.add(waiter);
      timer = setTimeout(() => waiter(null), waitMs);
      timer.unref?.();
      try {
        if (!this._send(frame.whoIsPacket(limits, { route: this.route }))) waiter(null);
      } catch {
        waiter(null);
      }
    });
  }
}

module.exports = { BacnetClient, macText, normIp };
