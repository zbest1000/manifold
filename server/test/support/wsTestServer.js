'use strict';

/**
 * Minimal in-process WebSocket SERVER (RFC 6455) for the bridge simulators. Independent of the
 * driver's client code, so the tests check one implementation against another.
 *
 *  - Validates the handshake (key, version 13), records request headers (Authorization, Host).
 *  - Client frames MUST be masked (an unmasked frame closes with 1002 and is recorded).
 *  - Offered extensions are recorded; none is ever accepted.
 *  - Helpers to misbehave: fragmented sends, raw bytes, bad Accept, oversized frames.
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload, { fin = true, rsv = 0 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | opcode, len]);
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, data]);
}

class Peer extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    this.unmaskedFrames = 0;
    socket.on('data', (c) => this._data(c));
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
    socket.on('error', () => {});
  }
  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      const payload = Buffer.from(this.buf.subarray(off + (masked ? 4 : 0), need));
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (!masked) {
        this.unmaskedFrames++;
        this.emit('violation', 'unmasked client frame');
        this.closeWith(1002);
        return;
      }
      if (b0 & 0x70) this.emit('violation', 'client set RSV bits');
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (opcode === 0x8) {
        this.emit('client-close', payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
        if (!this.closed) {
          this.socket.write(frame(0x8, payload.subarray(0, 2)));
          this.socket.end();
        }
        return;
      }
      if (opcode === 0x9) {
        this.emit('ping', payload);
        if (!this.noPong) this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) {
        this.emit('pong', payload);
        continue;
      }
      if (opcode !== 0) this.frag = { opcode, parts: [] };
      if (!this.frag) continue;
      this.frag.parts.push(payload);
      if (fin) {
        const data = Buffer.concat(this.frag.parts);
        const op = this.frag.opcode;
        this.frag = null;
        this.emit('message', op === 1 ? data.toString('utf8') : data, op !== 1);
      }
    }
  }
  send(text) {
    if (!this.closed) this.socket.write(frame(0x1, text));
  }
  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }
  /** Send a text message split into n fragments, with a ping between them. */
  sendFragmented(text, n = 3) {
    const data = Buffer.from(text, 'utf8');
    const size = Math.ceil(data.length / n);
    for (let i = 0; i < n; i++) {
      const part = data.subarray(i * size, (i + 1) * size);
      this.socket.write(frame(i === 0 ? 0x1 : 0x0, part, { fin: i === n - 1 }));
      if (i === 0) this.socket.write(frame(0x9, 'mid'));
    }
  }
  raw(buf) {
    if (!this.closed) this.socket.write(buf);
  }
  ping(payload = 'p') {
    this.raw(frame(0x9, payload));
  }
  closeWith(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const b = Buffer.alloc(2 + r.length);
    b.writeUInt16BE(code, 0);
    r.copy(b, 2);
    this.socket.write(frame(0x8, b));
    this.socket.end();
  }
  drop() {
    this.socket.destroy();
  }
}

/**
 * Start a WebSocket server. `onConnection(peer)` is called after the handshake.
 * Options: path, tls ({key, cert}), handshake ({status, badAccept, extensions, protocol}) to misbehave,
 * requireToken (string; 401 without "Authorization: Bearer <token>").
 */
async function startWsServer({ path = '/', tlsOptions = null, onConnection, handshake = () => ({}), requireToken = null } = {}) {
  const peers = new Set();
  const requests = [];
  const onSocket = (socket) => {
    let head = Buffer.alloc(0);
    socket.on('error', () => {});
    const onData = (c) => {
      head = Buffer.concat([head, c]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const [method, reqPath] = lines[0].split(' ');
      const headers = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const request = { method, path: reqPath, headers };
      requests.push(request);
      const hs = handshake(request) || {};
      const reject = (status, text) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      };
      if (hs.status) return reject(hs.status, 'Nope');
      if (method !== 'GET' || reqPath !== path) return reject(404, 'Not Found');
      if (requireToken && headers.authorization !== `Bearer ${requireToken}`) return reject(401, 'Unauthorized');
      const key = headers['sec-websocket-key'];
      if (!key || headers['sec-websocket-version'] !== '13' || String(headers.upgrade).toLowerCase() !== 'websocket') return reject(400, 'Bad Request');
      const accept = hs.badAccept ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' : crypto.createHash('sha1').update(key + GUID).digest('base64');
      const extra = [];
      if (hs.extensions) extra.push(`Sec-WebSocket-Extensions: ${hs.extensions}`);
      if (hs.protocol) extra.push(`Sec-WebSocket-Protocol: ${hs.protocol}`);
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...extra, '', ''].join('\r\n'));
      const peer = new Peer(socket, request);
      peers.add(peer);
      peer.on('close', () => peers.delete(peer));
      const rest = head.subarray(end + 4);
      onConnection(peer);
      if (rest.length) peer._data(rest);
    };
    socket.on('data', onData);
  };
  const server = tlsOptions ? tls.createServer(tlsOptions, onSocket) : net.createServer(onSocket);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    peers,
    requests,
    close: async () => {
      for (const p of peers) p.drop();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startWsServer, frame };
