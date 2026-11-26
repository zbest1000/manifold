'use strict';

/**
 * One EtherNet/IP session + one class 3 connection over node:net.
 *
 * Rules (docs/design/driver-contract.md, design rules):
 * - exactly one request in flight; a second concurrent request is refused;
 * - every request has a deadline; on expiry the socket is DESTROYED and the
 *   client is dead (never reused), so a late reply can never be matched to a
 *   later request;
 * - every reply is validated against its request: encapsulation command,
 *   session handle, sender context (unconnected) or connection id + sequence
 *   count (connected), and the CIP reply service code. Anything else is a
 *   `mismatch` and kills the socket;
 * - all outgoing bytes come from frame.encodeFrame (allowlist) and are
 *   re-checked byte-wise by frame.inspectOutgoingFrame before socket.write;
 * - socket errors never throw: they reject the pending request.
 * There are no hidden retries or reconnect loops: reconnecting is the
 * runtime's job.
 */

const net = require('net');
const crypto = require('crypto');

const cip = require('./cip');
const frame = require('./frame');

const { COMMAND, CPF } = cip;

class EipTransportError extends Error {
  /** @param {'timeout'|'mismatch'|'framing'|'transport'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'EipTransportError';
    this.kind = kind;
  }
}

/** A CIP-level error status on a request that must succeed (e.g. Forward Open). */
class EipCipError extends Error {
  constructor(what, reply) {
    super(`${what} failed: ${cip.statusName(reply.status, reply.ext)} (0x${reply.status.toString(16)}${reply.ext.length ? `/0x${reply.ext[0].toString(16)}` : ''})`);
    this.name = 'EipCipError';
    this.status = reply.status;
    this.ext = reply.ext;
  }
}

const LARGE_SIZE = 4002;
const SMALL_SIZE = 504;

class EipClient {
  /**
   * @param {{host:string, port?:number, route:Buffer, connectTimeoutMs?:number,
   *   onFrame?:(buf:Buffer)=>void}} opts
   */
  constructor({ host, displayHost, port = 44818, route, connectTimeoutMs = 5000, onFrame }) {
    this.host = host; // the address the socket opens (a validated, pinned IP when the device has a hostname)
    this.displayHost = displayHost || host; // what messages and logs call it
    this.port = port;
    this.route = route;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onFrame = onFrame;
    this.socket = null;
    this.parser = new frame.FrameParser();
    this.session = 0;
    this.connection = null; // { otId, toId, serial, originatorSerial, size, large }
    this.sequence = crypto.randomInt(0, 0xffff);
    this.contextCounter = 0;
    this.pending = null;
    this.dead = false;
    this.deathReason = null;
    this.stats = { framesSent: 0, bytesOut: 0, bytesIn: 0 };
  }

  get isOpen() {
    return !this.dead && !!this.socket && this.session !== 0;
  }

  // ── socket lifecycle ────────────────────────────────────────────────────

  _connectTcp() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._die('timeout', `TCP connect to ${this.displayHost}:${this.port} timed out after ${this.connectTimeoutMs} ms`);
        reject(new EipTransportError('timeout', `TCP connect to ${this.displayHost}:${this.port} timed out`));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
        resolve();
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new EipTransportError('transport', `connect to ${this.displayHost}:${this.port} failed: ${err.message}`));
        }
        this._die('transport', `socket error: ${err.message}`);
      });
      socket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new EipTransportError('transport', `connection to ${this.displayHost}:${this.port} closed during connect`));
        }
        this._die('transport', 'connection closed by peer');
      });
    });
  }

  /** Destroy the socket and fail whatever is pending. Idempotent. */
  _die(kind, message) {
    if (!this.dead) {
      this.dead = true;
      this.deathReason = { kind, message };
      if (this.socket) this.socket.destroy();
    }
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new EipTransportError(kind, message));
    }
  }

  destroy(reason = 'destroyed') {
    this._die('transport', reason);
  }

  _onData(chunk) {
    if (this.dead) return;
    this.stats.bytesIn += chunk.length;
    let packets;
    try {
      packets = this.parser.push(chunk);
    } catch (err) {
      this._die('framing', err.message);
      return;
    }
    for (const pkt of packets) {
      const p = this.pending;
      if (!p) {
        this._die('mismatch', `unsolicited encapsulation packet 0x${pkt.command.toString(16)} (late reply?)`);
        return;
      }
      let result;
      try {
        result = p.match(pkt);
      } catch (err) {
        let kind = 'mismatch';
        if (err instanceof frame.EipFramingError) kind = 'framing';
        else if (err instanceof EipTransportError) kind = err.kind;
        this._die(kind, err.message);
        return;
      }
      if (typeof result === 'string') {
        this._die('mismatch', result);
        return;
      }
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(result);
    }
  }

  /** The only path to socket.write. */
  _write(buf) {
    frame.inspectOutgoingFrame(buf); // byte-level allowlist re-check
    if (this.onFrame) this.onFrame(buf);
    this.stats.framesSent++;
    this.stats.bytesOut += buf.length;
    this.socket.write(buf);
  }

  /**
   * Send one frame and wait for its validated reply.
   * @param {object} spec encodeFrame spec
   * @param {(pkt:object)=>any|string} match returns the result, or a string mismatch reason
   */
  _exchange(spec, match, deadlineMs) {
    if (this.dead) {
      return Promise.reject(new EipTransportError('transport', `connection is closed (${this.deathReason ? this.deathReason.message : 'not open'})`));
    }
    if (this.pending) return Promise.reject(new Error('EipClient: a request is already in flight (maxInFlight is 1)'));
    let buf;
    try {
      buf = frame.encodeFrame(spec); // EipReadOnlyError: nothing sent, socket untouched
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._die('timeout', `no reply within ${deadlineMs} ms`), deadlineMs);
      this.pending = { match, resolve, reject, timer };
      try {
        this._write(buf);
      } catch (err) {
        this.pending = null;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _context() {
    const c = Buffer.alloc(8);
    c.writeUInt32LE(++this.contextCounter >>> 0, 0);
    crypto.randomFillSync(c, 4, 4);
    return c;
  }

  // ── session + connection ────────────────────────────────────────────────

  async _registerSession(deadlineMs) {
    const context = this._context();
    this.session = await this._exchange({ command: COMMAND.REGISTER_SESSION, context }, (pkt) => {
      if (pkt.command !== COMMAND.REGISTER_SESSION) return `RegisterSession reply has command 0x${pkt.command.toString(16)}`;
      if (!pkt.context.equals(context)) return 'RegisterSession reply sender context mismatch';
      if (pkt.status !== 0) throw new EipTransportError('transport', `RegisterSession refused (encapsulation status 0x${pkt.status.toString(16)})`);
      if (pkt.session === 0) return 'RegisterSession returned session handle 0';
      return pkt.session;
    }, deadlineMs);
  }

  /**
   * Unconnected request via SendRRData. `local` sends to the module we are
   * connected to (Forward Open/Close); otherwise the request is wrapped in
   * Unconnected Send and routed along `route`.
   */
  requestUnconnected(req, deadlineMs, { local = false } = {}) {
    const context = this._context();
    const wire = local ? req : frame.unconnectedSend(req, this.route);
    return this._exchange({ command: COMMAND.SEND_RR_DATA, session: this.session, context, cip: wire, timeout: 0 }, (pkt) => {
      if (pkt.command !== COMMAND.SEND_RR_DATA) return `SendRRData reply has command 0x${pkt.command.toString(16)}`;
      if (pkt.session !== this.session) return `session handle 0x${pkt.session.toString(16)} != 0x${this.session.toString(16)}`;
      if (!pkt.context.equals(context)) return 'sender context mismatch (reply belongs to another request)';
      if (pkt.status !== 0) throw new EipTransportError('transport', `encapsulation status 0x${pkt.status.toString(16)}`);
      const { items } = frame.parseCpf(pkt.body);
      const item = items.find((it) => it.type === CPF.UNCONNECTED_DATA);
      if (!item) return 'SendRRData reply has no unconnected data item';
      const reply = frame.parseCipReply(item.data);
      const svc = reply.service & 0x7f;
      if (svc !== req.service && !(svc === cip.SERVICE.UNCONNECTED_SEND && !local)) {
        return `reply service 0x${reply.service.toString(16)} does not answer 0x${req.service.toString(16)}`;
      }
      return reply;
    }, deadlineMs);
  }

  /** Connected explicit message via SendUnitData; falls back to unconnected when no connection is open. */
  request(req, deadlineMs) {
    if (!this.connection) return this.requestUnconnected(req, deadlineMs);
    this.sequence = (this.sequence + 1) & 0xffff;
    const seq = this.sequence;
    const conn = this.connection;
    return this._exchange(
      { command: COMMAND.SEND_UNIT_DATA, session: this.session, cip: req, connectionId: conn.otId, sequence: seq },
      (pkt) => {
        if (pkt.command !== COMMAND.SEND_UNIT_DATA) return `SendUnitData reply has command 0x${pkt.command.toString(16)}`;
        if (pkt.session !== this.session) return `session handle 0x${pkt.session.toString(16)} != 0x${this.session.toString(16)}`;
        if (pkt.status !== 0) throw new EipTransportError('transport', `encapsulation status 0x${pkt.status.toString(16)}`);
        const { items } = frame.parseCpf(pkt.body);
        const addr = items.find((it) => it.type === CPF.CONNECTED_ADDRESS);
        const data = items.find((it) => it.type === CPF.CONNECTED_DATA);
        if (!addr || addr.data.length !== 4 || !data || data.data.length < 2) return 'malformed SendUnitData reply';
        const connId = addr.data.readUInt32LE(0);
        if (connId !== conn.toId) return `connection id 0x${connId.toString(16)} != 0x${conn.toId.toString(16)}`;
        const gotSeq = data.data.readUInt16LE(0);
        if (gotSeq !== seq) return `sequence count ${gotSeq} != ${seq} (late or foreign reply)`;
        const reply = frame.parseCipReply(data.data.subarray(2));
        if ((reply.service & 0x7f) !== req.service) {
          return `reply service 0x${reply.service.toString(16)} does not answer 0x${req.service.toString(16)}`;
        }
        return reply;
      },
      deadlineMs
    );
  }

  async _forwardOpen(size, deadlineMs) {
    const large = size > 511;
    const params = {
      large,
      size,
      toConnectionId: crypto.randomInt(1, 0x7fffffff),
      serial: crypto.randomInt(1, 0xffff),
      originatorSerial: crypto.randomInt(1, 0x7fffffff),
      rpiUs: 2000000,
      multiplier: 5, // x128 -> connection timeout ~256 s at RPI 2 s
      route: this.route,
    };
    const reply = await this.requestUnconnected(frame.forwardOpen(params), deadlineMs, { local: true });
    if (reply.status !== 0) throw new EipCipError(large ? 'Large Forward Open' : 'Forward Open', reply);
    const r = frame.parseForwardOpenReply(reply.data);
    if (r.serial !== params.serial || r.originatorSerial !== params.originatorSerial) {
      this._die('mismatch', 'Forward Open reply serial numbers do not match the request');
      throw new EipTransportError('mismatch', 'Forward Open reply serial numbers do not match the request');
    }
    this.connection = { otId: r.otConnectionId, toId: r.toConnectionId, serial: params.serial, originatorSerial: params.originatorSerial, size, large };
    return this.connection;
  }

  /**
   * TCP connect, RegisterSession, Forward Open (Large first unless
   * `preferredSize` <= 511, then 504).
   * @returns {Promise<{connectionSize:number, large:boolean, fallbackReason?:string}>}
   */
  async open({ preferredSize = LARGE_SIZE, deadlineMs = 2000 } = {}) {
    await this._connectTcp();
    await this._registerSession(deadlineMs);
    let fallbackReason;
    if (preferredSize > 511) {
      try {
        await this._forwardOpen(Math.min(preferredSize, LARGE_SIZE), deadlineMs);
        return { connectionSize: this.connection.size, large: true };
      } catch (err) {
        if (!(err instanceof EipCipError)) throw err; // transport problems are not a reason to fall back
        fallbackReason = err.message;
      }
    }
    await this._forwardOpen(Math.min(preferredSize, SMALL_SIZE), deadlineMs);
    return { connectionSize: this.connection.size, large: false, fallbackReason };
  }

  /**
   * Orderly shutdown: Forward Close, UnRegisterSession, FIN. Never throws.
   */
  async close(deadlineMs = 1000) {
    if (this.dead || !this.socket) {
      this._die('transport', 'closed');
      return;
    }
    if (this.pending) {
      this._die('transport', 'closed while a request was in flight');
      return;
    }
    if (this.connection) {
      const c = this.connection;
      this.connection = null;
      try {
        await this.requestUnconnected(frame.forwardClose({ serial: c.serial, originatorSerial: c.originatorSerial, route: this.route }), deadlineMs, {
          local: true,
        });
      } catch {
        /* best effort: the connection times out on the controller side */
      }
    }
    if (!this.dead && this.session) {
      try {
        this._write(frame.encodeFrame({ command: COMMAND.UNREGISTER_SESSION, session: this.session }));
      } catch {
        /* ignore */
      }
    }
    const socket = this.socket;
    this.dead = true;
    this.deathReason = { kind: 'transport', message: 'closed' };
    if (socket && !socket.destroyed) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          socket.destroy();
          resolve();
        }, 500);
        socket.once('close', () => {
          clearTimeout(t);
          resolve();
        });
        socket.end(); // FIN
      });
    }
  }
}

/** Parse an Identity object Get_Attribute_All reply (ODVA Vol. 1 5-2). */
function parseIdentity(data) {
  if (data.length < 15) return null;
  const nameLen = data[14];
  return {
    vendorId: data.readUInt16LE(0),
    deviceType: data.readUInt16LE(2),
    productCode: data.readUInt16LE(4),
    revision: `${data[6]}.${data[7]}`,
    revisionMajor: data[6],
    status: data.readUInt16LE(8),
    serialNumber: data.readUInt32LE(10).toString(16).padStart(8, '0'),
    productName: data.toString('latin1', 15, 15 + nameLen),
  };
}

module.exports = { EipClient, EipTransportError, EipCipError, parseIdentity, LARGE_SIZE, SMALL_SIZE };
