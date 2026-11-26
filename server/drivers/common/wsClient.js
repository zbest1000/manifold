'use strict';

/**
 * Minimal RFC 6455 WebSocket CLIENT on Node's net/tls, for the bridge drivers
 * (matter-server, zwave-js). Written by hand because the server has no WebSocket client
 * dependency it can reuse with the guarantees below (undici's WebSocket offers
 * permessage-deflate and has no message size cap; socket.io's transitive `ws` is not ours).
 *
 *  - Opening handshake with a random 16-byte key; the 101 answer must carry the matching
 *    Sec-WebSocket-Accept, "Upgrade: websocket" and "Connection: upgrade". No extension and
 *    no subprotocol is requested, so an answer that selects one is refused (permessage-deflate
 *    is never negotiated; RSV bits must stay 0).
 *  - Every client frame is masked with a fresh 4-byte key. Server frames must not be masked.
 *  - Fragmented messages are reassembled; control frames may interleave; ping is answered
 *    with pong; close is echoed and the TCP connection is ended.
 *  - Hard caps: one frame (`maxFrameBytes`), one reassembled message (`maxMessageBytes`), the
 *    handshake answer (16 KiB), fragments per message (4096), pongs queued for a peer that
 *    does not read them (1 MiB, closes with 1008). Exceeding a cap closes with 1009; protocol errors with 1002;
 *    invalid UTF-8 in a text message with 1007.
 *  - Keepalive: when nothing has arrived for `pingIntervalMs` a ping is sent; if still nothing
 *    arrives within `pongTimeoutMs` the socket is destroyed (a half-open TCP connection would
 *    otherwise look healthy forever).
 *  - The TCP connection goes to `address` (the pinned, egress-checked IP); the Host header and
 *    TLS SNI / certificate check use `hostname`. Nothing here resolves a name.
 *
 * Events: 'message' (text: string, isBinary: boolean), 'close' ({ code, reason, error? }) once.
 */

const net = require('net');
const tls = require('tls');
const { tlsConnectOptions, fingerprintProblem } = require('./urlTarget');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_FRAGMENTS = 4096; // per message
const MAX_UNREAD_PONG_BYTES = 1024 * 1024; // pongs queued for a peer that does not read them
const DEFAULTS = {
  connectTimeoutMs: 5000,
  maxFrameBytes: 16 * 1024 * 1024,
  maxMessageBytes: 32 * 1024 * 1024,
  pingIntervalMs: 20000,
  pongTimeoutMs: 10000,
  closeTimeoutMs: 1000,
};

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WsError extends Error {
  /** @param {'handshake'|'protocol'|'too-large'|'timeout'|'transport'|'tls'|'closed'} kind */
  constructor(kind, message, code) {
    super(message);
    this.name = 'WsError';
    this.kind = kind;
    if (code !== undefined) this.code = code;
  }
}

/** Encode one client frame (always masked). Exported for tests. */
function encodeFrame(opcode, payload, { fin = true, maskKey = crypto.randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = data.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  maskKey.copy(out, headerLen);
  for (let i = 0; i < len; i++) out[headerLen + 4 + i] = data[i] ^ maskKey[i & 3];
  return out;
}

/** Chunk queue: avoids re-concatenating a growing buffer for large frames. */
class ChunkQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(buf) {
    if (buf.length) {
      this.chunks.push(buf);
      this.length += buf.length;
    }
  }
  /** First n bytes without consuming (n <= length). */
  peek(n) {
    if (this.chunks[0] && this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    return Buffer.concat(this.chunks, Math.min(this.length, Math.max(n, 0))).subarray(0, n);
  }
  read(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.length -= n;
    return out;
  }
}

/**
 * Incremental parser for server->client frames. Calls back onFrame({fin, opcode, payload}).
 * Throws WsError('protocol'|'too-large') on a violation; the caller closes the connection.
 */
class FrameParser {
  constructor({ maxFrameBytes, onFrame }) {
    this.max = maxFrameBytes;
    this.onFrame = onFrame;
    this.q = new ChunkQueue();
    this.head = null;
  }
  push(buf) {
    this.q.push(buf);
    for (;;) {
      if (!this.head) {
        if (this.q.length < 2) return;
        const h = this.q.peek(2);
        const fin = (h[0] & 0x80) !== 0;
        if (h[0] & 0x70) throw new WsError('protocol', 'reserved bits set (no extension was negotiated)', 1002);
        const opcode = h[0] & 0x0f;
        if (![OP.CONT, OP.TEXT, OP.BINARY, OP.CLOSE, OP.PING, OP.PONG].includes(opcode)) {
          throw new WsError('protocol', `unknown opcode 0x${opcode.toString(16)}`, 1002);
        }
        if (h[1] & 0x80) throw new WsError('protocol', 'server frames must not be masked', 1002);
        const len7 = h[1] & 0x7f;
        const extra = len7 === 126 ? 2 : len7 === 127 ? 8 : 0;
        if (this.q.length < 2 + extra) return;
        const hdr = this.q.read(2 + extra);
        let len = len7;
        if (len7 === 126) {
          len = hdr.readUInt16BE(2);
          if (len < 126) throw new WsError('protocol', 'non-minimal 16-bit length', 1002);
        } else if (len7 === 127) {
          const big = hdr.readBigUInt64BE(2);
          if (big >> 63n) throw new WsError('protocol', '64-bit length with the high bit set', 1002);
          if (big > BigInt(this.max)) throw new WsError('too-large', `frame of ${big} bytes exceeds the ${this.max}-byte cap`, 1009);
          len = Number(big);
          if (len <= 0xffff) throw new WsError('protocol', 'non-minimal 64-bit length', 1002);
        }
        if (opcode >= 0x8) {
          if (!fin) throw new WsError('protocol', 'fragmented control frame', 1002);
          if (len > 125) throw new WsError('protocol', 'control frame longer than 125 bytes', 1002);
        }
        if (len > this.max) throw new WsError('too-large', `frame of ${len} bytes exceeds the ${this.max}-byte cap`, 1009);
        this.head = { fin, opcode, len };
      }
      if (this.q.length < this.head.len) return;
      const { fin, opcode, len } = this.head;
      this.head = null;
      this.onFrame({ fin, opcode, payload: len ? this.q.read(len) : Buffer.alloc(0) });
    }
  }
}

function formatHostHeader(hostname, port, secure) {
  const h = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return (secure && port === 443) || (!secure && port === 80) ? h : `${h}:${port}`;
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const hasCtl = (s) => {
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};
const utf8 = new TextDecoder('utf-8', { fatal: true });

class WsClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.address IP (or name) to open the TCP connection to: the pinned address
   * @param {string} o.hostname configured host name, for Host and TLS SNI / verification
   * @param {number} o.port
   * @param {string} [o.path='/']
   * @param {boolean} [o.secure=false] wss
   * @param {{rejectUnauthorized?:boolean, insecure?:boolean, ca?:string, fingerprint?:string}} [o.tls] see urlTarget.tlsConnectOptions
   * @param {Record<string,string>} [o.headers] extra handshake headers (e.g. authorization)
   */
  constructor(o) {
    super();
    this.opt = { ...DEFAULTS, ...o };
    this.opt.path = o.path || '/';
    if (!this.opt.path.startsWith('/') || hasCtl(this.opt.path) || /\s/.test(this.opt.path)) throw new WsError('handshake', 'path must start with "/" and contain no spaces');
    for (const [k, v] of Object.entries(this.opt.headers || {})) {
      if (!HEADER_NAME_RE.test(k) || hasCtl(v)) throw new WsError('handshake', `invalid header ${k}`);
    }
    this.socket = null;
    this.state = 'idle'; // idle | connecting | open | closing | closed
    this._frag = null; // { opcode, chunks, length }
    this._closeSent = false;
    this._closedEmitted = false;
    this._lastRx = 0;
    this._pingTimer = null;
    this._pingSentAt = 0;
    this._closeTimer = null;
    this.stats = { framesIn: 0, framesOut: 0, bytesIn: 0, pings: 0 };
  }

  isOpen() {
    return this.state === 'open';
  }

  connect() {
    if (this.state !== 'idle') return Promise.reject(new WsError('closed', 'client already used'));
    this.state = 'connecting';
    const o = this.opt;
    return new Promise((resolve, reject) => {
      let settled = false;
      const key = crypto.randomBytes(16).toString('base64');
      const expectAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._teardown();
        this.state = 'closed';
        reject(err);
      };
      const timer = setTimeout(() => fail(new WsError('timeout', `no WebSocket handshake within ${o.connectTimeoutMs} ms`)), o.connectTimeoutMs);
      if (timer.unref) timer.unref();

      const tlsOpts = o.tls || {};
      let sock;
      try {
        // Pinned address, configured name as SNI and certificate identity: the same options as the HTTP drivers.
        const insecure = tlsOpts.insecure === true || tlsOpts.rejectUnauthorized === false;
        sock = o.secure
          ? tls.connect({
              ...tlsConnectOptions({ address: o.address, port: o.port, hostname: o.hostname, tls: { insecure, ca: tlsOpts.ca, fingerprint: tlsOpts.fingerprint } }),
              ALPNProtocols: ['http/1.1'],
            })
          : net.connect({ host: o.address, port: o.port });
      } catch (e) {
        fail(new WsError('transport', e.message));
        return;
      }
      this.socket = sock;
      sock.setNoDelay(true);
      let hs = Buffer.alloc(0);
      const onConnect = () => {
        // A pinned fingerprint replaces chain validation: nothing is sent before it matched.
        const pinProblem = o.secure ? fingerprintProblem(sock, tlsOpts.fingerprint) : null;
        if (pinProblem) return fail(new WsError('tls', pinProblem.message));
        const headers = {
          Host: formatHostHeader(o.hostname, o.port, o.secure),
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'manifold-bridge-reader',
          ...(o.headers || {}),
        };
        const lines = [`GET ${o.path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
        sock.write(lines.join('\r\n'));
      };
      const onHsData = (chunk) => {
        hs = Buffer.concat([hs, chunk]);
        const end = hs.indexOf('\r\n\r\n');
        if (end < 0) {
          if (hs.length > MAX_HANDSHAKE_BYTES) fail(new WsError('handshake', 'handshake answer too large'));
          return;
        }
        const head = hs.subarray(0, end).toString('latin1');
        const rest = hs.subarray(end + 4);
        const [statusLine, ...hdrLines] = head.split('\r\n');
        const m = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(statusLine);
        if (!m) return fail(new WsError('handshake', `not an HTTP/1.1 answer: ${statusLine.slice(0, 80)}`));
        const h = {};
        for (const line of hdrLines) {
          const i = line.indexOf(':');
          if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (m[1] !== '101') {
          const status = Number(m[1]);
          const hint = status === 401 || status === 403 ? ' (authentication required or token refused)' : status === 404 ? ' (wrong path?)' : '';
          return fail(Object.assign(new WsError('handshake', `server answered HTTP ${status} ${m[2] || ''}`.trim() + hint), { status }));
        }
        if (String(h.upgrade || '').toLowerCase() !== 'websocket') return fail(new WsError('handshake', 'answer lacks "Upgrade: websocket"'));
        if (!String(h.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) return fail(new WsError('handshake', 'answer lacks "Connection: upgrade"'));
        if (h['sec-websocket-accept'] !== expectAccept) return fail(new WsError('handshake', 'Sec-WebSocket-Accept does not match the key'));
        if (h['sec-websocket-extensions']) return fail(new WsError('handshake', `server selected an extension that was not offered: ${h['sec-websocket-extensions']}`));
        if (h['sec-websocket-protocol']) return fail(new WsError('handshake', 'server selected a subprotocol that was not offered'));
        sock.removeListener('data', onHsData);
        settled = true;
        clearTimeout(timer);
        this.state = 'open';
        this._lastRx = Date.now();
        this._parser = new FrameParser({ maxFrameBytes: o.maxFrameBytes, onFrame: (f) => this._onFrame(f) });
        sock.on('data', (c) => this._onData(c));
        this._armPing();
        resolve({ headers: h });
        if (rest.length) this._onData(rest);
      };
      sock.once(o.secure ? 'secureConnect' : 'connect', onConnect);
      sock.on('data', onHsData);
      sock.on('error', (e) => {
        const kind = o.secure && /cert|self.signed|unable to verify|SSL|TLS|altname/i.test(`${e.code} ${e.message}`) ? 'tls' : 'transport';
        if (!settled) fail(new WsError(kind, e.message));
        else this._finish(1006, '', new WsError(kind, e.message));
      });
      sock.on('close', () => {
        if (!settled) fail(new WsError('transport', 'connection closed during the handshake'));
        else this._finish(this._peerCode || 1006, this._peerReason || '');
      });
    });
  }

  /** Send one text message. */
  send(text) {
    if (this.state !== 'open') throw new WsError('closed', 'WebSocket is not open');
    const buf = Buffer.from(String(text), 'utf8');
    if (buf.length > this.opt.maxMessageBytes) throw new WsError('too-large', 'outgoing message too large');
    this._write(OP.TEXT, buf);
  }

  _write(opcode, payload) {
    this.stats.framesOut++;
    this.socket.write(encodeFrame(opcode, payload));
  }

  _onData(chunk) {
    this.stats.bytesIn += chunk.length;
    this._lastRx = Date.now();
    this._pingSentAt = 0;
    try {
      this._parser.push(chunk);
    } catch (e) {
      this._protocolError(e);
    }
  }

  _protocolError(e) {
    const err = e instanceof WsError ? e : new WsError('protocol', e.message, 1002);
    this._failConnection(err.code || 1002, err);
  }

  _onFrame({ fin, opcode, payload }) {
    if (this.state !== 'open' && this.state !== 'closing') return;
    this.stats.framesIn++;
    if (opcode === OP.PING) {
      if (this.state !== 'open') return;
      // A peer that keeps pinging without reading the pongs would otherwise grow the write queue without bound.
      if (this.socket.writableLength > MAX_UNREAD_PONG_BYTES) throw new WsError('protocol', 'the server sends pings but does not read the answers', 1008);
      this._write(OP.PONG, payload);
      return;
    }
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) return this._onClose(payload);
    if (opcode === OP.CONT) {
      if (!this._frag) throw new WsError('protocol', 'continuation frame without a message', 1002);
    } else {
      if (this._frag) throw new WsError('protocol', 'new data frame inside a fragmented message', 1002);
      this._frag = { opcode, chunks: [], length: 0 };
    }
    const f = this._frag;
    f.length += payload.length;
    if (f.length > this.opt.maxMessageBytes) throw new WsError('too-large', `message exceeds the ${this.opt.maxMessageBytes}-byte cap`, 1009);
    // Every fragment costs memory even when it is empty: cap their number too.
    if (f.chunks.length >= MAX_FRAGMENTS) throw new WsError('too-large', `message split into more than ${MAX_FRAGMENTS} fragments`, 1009);
    f.chunks.push(payload);
    if (!fin) return;
    this._frag = null;
    const data = f.chunks.length === 1 ? f.chunks[0] : Buffer.concat(f.chunks, f.length);
    if (f.opcode === OP.TEXT) {
      let text;
      try {
        text = utf8.decode(data);
      } catch {
        throw new WsError('protocol', 'text message is not valid UTF-8', 1007);
      }
      this.emit('message', text, false);
    } else {
      this.emit('message', data, true);
    }
  }

  _onClose(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) throw new WsError('protocol', 'close frame with a 1-byte body', 1002);
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        throw new WsError('protocol', 'close reason is not valid UTF-8', 1007);
      }
    }
    this._peerCode = code;
    this._peerReason = reason;
    if (!this._closeSent) {
      this._closeSent = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code === 1005 ? 1000 : code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1002, 0);
      try {
        this._write(OP.CLOSE, body);
      } catch {
        /* socket already gone */
      }
    }
    this.state = 'closing';
    this.socket.end();
    this._armCloseTimer();
  }

  _failConnection(code, err) {
    if (this.state === 'closed') return;
    if (!this._closeSent && this.socket && this.state === 'open') {
      this._closeSent = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      try {
        this._write(OP.CLOSE, body);
      } catch {
        /* ignore */
      }
    }
    this._finish(code, err ? err.message : '', err);
  }

  /** Orderly close: send close, wait briefly for the echo, then drop the TCP connection. */
  close(code = 1000, reason = '') {
    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed';
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.once('close', () => resolve());
      if (this.state === 'open' && !this._closeSent) {
        this._closeSent = true;
        const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
        const body = Buffer.alloc(2 + r.length);
        body.writeUInt16BE(code, 0);
        r.copy(body, 2);
        try {
          this._write(OP.CLOSE, body);
        } catch {
          /* ignore */
        }
        this.state = 'closing';
      }
      this._armCloseTimer();
    });
  }

  /** Drop the connection at once. */
  destroy(reason) {
    this._finish(1006, reason || 'destroyed', reason ? new WsError('closed', String(reason)) : undefined);
  }

  _armCloseTimer() {
    if (this._closeTimer) return;
    this._closeTimer = setTimeout(() => this._finish(this._peerCode || 1006, this._peerReason || 'close timeout'), this.opt.closeTimeoutMs);
    if (this._closeTimer.unref) this._closeTimer.unref();
  }

  _armPing() {
    const o = this.opt;
    if (!(o.pingIntervalMs > 0)) return;
    const tick = Math.max(50, Math.min(o.pingIntervalMs, o.pongTimeoutMs) / 2);
    this._pingTimer = setInterval(() => {
      if (this.state !== 'open') return;
      const now = Date.now();
      if (this._pingSentAt && now - this._pingSentAt >= o.pongTimeoutMs) {
        this._failConnection(1006, new WsError('timeout', `no answer to keepalive ping within ${o.pongTimeoutMs} ms`));
        return;
      }
      if (!this._pingSentAt && now - this._lastRx >= o.pingIntervalMs) {
        this._pingSentAt = now;
        this.stats.pings++;
        try {
          this._write(OP.PING, Buffer.from(String(now)));
        } catch {
          /* close follows */
        }
      }
    }, tick);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _teardown() {
    clearInterval(this._pingTimer);
    clearTimeout(this._closeTimer);
    this._pingTimer = null;
    this._closeTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.on('error', () => {});
      this.socket.destroy();
    }
  }

  _finish(code, reason, error) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.state = 'closed';
    this._teardown();
    this.emit('close', { code, reason, ...(error ? { error } : {}) });
  }
}

module.exports = { WsClient, WsError, FrameParser, encodeFrame, formatHostHeader, OP, GUID, DEFAULTS };
