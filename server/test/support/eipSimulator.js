'use strict';

/**
 * In-process Logix-like EtherNet/IP simulator for tests (node:net).
 *
 * Deliberately written WITHOUT importing the driver's encoders/decoders so
 * the tests compare two independent readings of the protocol. It cannot
 * prove correctness against real firmware (see server/drivers/eip/NOTES.md).
 *
 * Implements: RegisterSession / UnRegisterSession / ListIdentity, SendRRData
 * (bare and Unconnected Send wrapped), SendUnitData, Forward Open, Large
 * Forward Open (optionally rejected), Forward Close, Read Tag, Read Tag
 * Fragmented, Multiple Service Packet (per-item status), Get Instance
 * Attribute List on Symbol 0x6B (paged), Get_Attribute_List + Read Template
 * on 0x6C, Get_Attribute_All on Identity. It ALSO implements Write Tag /
 * Write Tag Fragmented / Read-Modify-Write and counts `stats.writesReceived`
 * so tests can prove the driver never sends one.
 *
 * Fault injection (sim.faults, mutable at any time):
 *   refuseConnections  (bool)   accept then immediately destroy sockets
 *   blackhole          (bool)   never answer data requests
 *   delayMs            (number) delay every reply
 *   lateReply          (number) one-shot: delay the next data reply by N ms
 *   dropConnection     (bool)   one-shot: destroy the socket on the next data request
 *   truncate           (bool)   one-shot: reply with a CPF item longer than the packet
 *   wrongSequence      (bool)   one-shot: connected reply with sequence - 1
 *   wrongContext       (bool)   one-shot: unconnected reply with a different sender context
 */

const net = require('net');

const T = { BOOL: 0xc1, SINT: 0xc2, INT: 0xc3, DINT: 0xc4, LINT: 0xc5, USINT: 0xc6, UINT: 0xc7, UDINT: 0xc8, ULINT: 0xc9, REAL: 0xca, LREAL: 0xcb, DWORD: 0xd3 };
const SIZE = { BOOL: 1, SINT: 1, INT: 2, DINT: 4, LINT: 8, USINT: 1, UINT: 2, UDINT: 4, ULINT: 8, REAL: 4, LREAL: 8, DWORD: 4 };

function writeAtomic(type, buf, off, v) {
  switch (type) {
    case 'BOOL':
      buf[off] = v ? 1 : 0;
      break;
    case 'SINT':
      buf.writeInt8(v, off);
      break;
    case 'INT':
      buf.writeInt16LE(v, off);
      break;
    case 'DINT':
      buf.writeInt32LE(v, off);
      break;
    case 'LINT':
      buf.writeBigInt64LE(BigInt(v), off);
      break;
    case 'USINT':
      buf.writeUInt8(v, off);
      break;
    case 'UINT':
      buf.writeUInt16LE(v, off);
      break;
    case 'UDINT':
    case 'DWORD':
      buf.writeUInt32LE(v >>> 0, off);
      break;
    case 'ULINT':
      buf.writeBigUInt64LE(BigInt(v), off);
      break;
    case 'REAL':
      buf.writeFloatLE(v, off);
      break;
    case 'LREAL':
      buf.writeDoubleLE(v, off);
      break;
    default:
      throw new Error(`sim: no writer for ${type}`);
  }
}

function logixString(text) {
  const b = Buffer.alloc(88);
  b.writeInt32LE(text.length, 0);
  b.write(text, 4, 'latin1');
  return b;
}

// ── default database ──────────────────────────────────────────────────────

const STRING_TPL = {
  id: 0x0f9c,
  handle: 0x0fce,
  name: 'ASCIISTRING82',
  size: 88,
  members: [
    { name: 'LEN', info: 0, type: T.DINT, offset: 0 },
    { name: 'DATA', info: 82, type: T.SINT, offset: 4 },
  ],
};

// MotorType: hidden SINT host at 0 carrying Running (bit 0) and Fault (bit 1),
// 3 bytes padding, Speed REAL @4, Count DINT @8, Name STRING @12 (88 bytes),
// Code SINT @100, 3 bytes tail padding -> size 104.
const MOTOR_TPL = {
  id: 0x0101,
  handle: 0xabcd,
  name: 'MotorType',
  size: 104,
  members: [
    { name: 'ZZZZZZZZZZMotorType0', info: 0, type: T.SINT, offset: 0 },
    { name: 'Running', info: 0, type: T.BOOL, offset: 0 },
    { name: 'Fault', info: 1, type: T.BOOL, offset: 0 },
    { name: 'Speed', info: 0, type: T.REAL, offset: 4 },
    { name: 'Count', info: 0, type: T.DINT, offset: 8 },
    { name: 'Name', info: 0, type: 0x8000 | STRING_TPL.id, offset: 12 },
    { name: 'Code', info: 0, type: T.SINT, offset: 100 },
  ],
};

function motorBytes({ running, fault, speed, count, name, code }) {
  const b = Buffer.alloc(104, 0);
  b[0] = (running ? 1 : 0) | (fault ? 2 : 0);
  b.writeFloatLE(speed, 4);
  b.writeInt32LE(count, 8);
  logixString(name).copy(b, 12);
  b.writeInt8(code, 100);
  return b;
}

function atomicTag(name, type, values, dims = [], access = 0) {
  const n = dims.length ? dims.reduce((a, c) => a * c, 1) : 1;
  const vals = Array.isArray(values) ? values : [values];
  const data = Buffer.alloc(SIZE[type] * n);
  for (let i = 0; i < n; i++) writeAtomic(type, data, i * SIZE[type], vals[i % vals.length]);
  return { name, type, dims, data, access };
}

function defaultDatabase() {
  const boolWords = Buffer.alloc(8);
  boolWords.writeUInt32LE(0x80000005, 0); // bits 0, 2, 31
  boolWords.writeUInt32LE(0x00000002, 4); // bit 33
  const big = Buffer.alloc(2000 * 4);
  for (let i = 0; i < 2000; i++) big.writeInt32LE(i * 3, i * 4);
  const controller = [
    atomicTag('BoolTag', 'BOOL', true),
    atomicTag('SintTag', 'SINT', -5),
    atomicTag('IntTag', 'INT', -1234),
    atomicTag('DintTag', 'DINT', 123456),
    atomicTag('LintTag', 'LINT', -9007199254740993n),
    atomicTag('UsintTag', 'USINT', 200),
    atomicTag('UintTag', 'UINT', 60000),
    atomicTag('UdintTag', 'UDINT', 4000000000),
    atomicTag('UlintTag', 'ULINT', 18446744073709551615n),
    atomicTag('RealTag', 'REAL', 3.5),
    atomicTag('LrealTag', 'LREAL', 2.718281828459045),
    atomicTag('StatusWord', 'DINT', 0b100000), // bit 5 set
    { name: 'StrTag', type: { tpl: STRING_TPL.id }, dims: [], data: logixString('Hello Logix'), access: 0 },
    atomicTag('DintArr', 'DINT', [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [10]),
    atomicTag('Matrix', 'INT', Array.from({ length: 12 }, (_, k) => Math.floor(k / 4) * 10 + (k % 4)), [3, 4]),
    { name: 'BoolArr', type: 'BOOL', dims: [64], data: boolWords, access: 0, boolArray: true },
    { name: 'Motor', type: { tpl: MOTOR_TPL.id }, dims: [], data: motorBytes({ running: true, fault: false, speed: 1450.5, count: 42, name: 'Pump-1', code: -7 }), access: 0 },
    {
      name: 'Motors',
      type: { tpl: MOTOR_TPL.id },
      dims: [3],
      data: Buffer.concat([0, 1, 2].map((k) => motorBytes({ running: k % 2 === 0, fault: k === 2, speed: 100 * k, count: k, name: `M${k}`, code: k }))),
      access: 0,
    },
    { name: 'BigArr', type: 'DINT', dims: [2000], data: big, access: 0 },
    atomicTag('ReadOnlyTag', 'DINT', 5, [], 2),
    atomicTag('Secret', 'DINT', 99, [], 3),
    { name: 'Program:MainProgram', program: true },
    { name: '__SystemThing', type: 'DINT', dims: [], data: Buffer.alloc(4), access: 0, system: true },
  ];
  const programs = {
    MainProgram: [atomicTag('LocalDint', 'DINT', 77), atomicTag('LocalReal', 'REAL', 1.25)],
  };
  return { controller, programs, templates: [STRING_TPL, MOTOR_TPL] };
}

// ── simulator ─────────────────────────────────────────────────────────────

class EipSimulator {
  constructor({ rejectLarge = false, maxConnectionSize = 4002, database = defaultDatabase(), externalAccessAttr = true, revisionMajor = 33 } = {}) {
    this.rejectLarge = rejectLarge;
    this.maxConnectionSize = maxConnectionSize;
    this.db = database;
    this.externalAccessAttr = externalAccessAttr;
    this.revisionMajor = revisionMajor;
    this.templates = new Map(database.templates.map((t) => [t.id, t]));
    this.instanceCounter = 1;
    for (const t of database.controller) t.instance = this.instanceCounter++;
    for (const list of Object.values(database.programs)) for (const t of list) t.instance = this.instanceCounter++;
    this.faults = {};
    this.sockets = new Set();
    this.stats = {
      tcpConnections: 0,
      registerSessions: 0,
      unregisterSessions: 0,
      forwardOpens: 0,
      largeForwardOpens: 0,
      largeRejected: 0,
      forwardCloses: 0,
      openConnections: 0,
      dataRequests: 0,
      services: {},
      innerServices: {},
      writesReceived: 0,
    };
  }

  async start() {
    this.server = net.createServer((s) => this._onSocket(s));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  resetStats() {
    for (const k of Object.keys(this.stats)) {
      if (k === 'writesReceived' || k === 'openConnections') continue;
      this.stats[k] = typeof this.stats[k] === 'number' ? 0 : {};
    }
  }

  _onSocket(socket) {
    this.stats.tcpConnections++;
    if (this.faults.refuseConnections) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const st = { buf: Buffer.alloc(0), session: 0, connections: new Map() };
    socket.on('data', (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      while (st.buf.length >= 24) {
        const len = st.buf.readUInt16LE(2);
        if (st.buf.length < 24 + len) break;
        const pkt = st.buf.subarray(0, 24 + len);
        st.buf = st.buf.subarray(24 + len);
        try {
          this._onPacket(socket, st, Buffer.from(pkt));
        } catch (err) {
          socket.destroy();
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.stats.openConnections -= st.connections.size;
    });
  }

  /**
   * ListIdentity CPF item (type 0x000C): encapsulation protocol version, the socket
   * address (big endian, sin_family 2), then the CIP Identity object: vendor, device
   * type, product code, revision, status, serial, product name (SHORT_STRING), state.
   * A test can override any field by assigning `sim.identity = { productName: '...' }`.
   */
  _identityItem(socket) {
    const id = {
      vendorId: 1, // Rockwell Automation / Allen-Bradley
      deviceType: 0x0e, // Programmable Logic Controller
      productCode: 166,
      revMajor: 32,
      revMinor: 11,
      status: 0x0030,
      serial: 0x006c5f2a,
      productName: '1769-L33ER/A LOGIX5333ER',
      state: 3,
      ...(this.identity || {}),
    };
    const name = Buffer.from(id.productName, 'latin1');
    const data = Buffer.alloc(2 + 16 + 14 + 1 + name.length + 1);
    let o = 0;
    data.writeUInt16LE(1, o); o += 2;
    data.writeUInt16BE(2, o); o += 2; // sin_family AF_INET
    data.writeUInt16BE(this.port || 44818, o); o += 2;
    Buffer.from((socket.localAddress || '127.0.0.1').replace(/^::ffff:/, '').split('.').map(Number)).copy(data, o); o += 4;
    o += 8; // sin_zero
    data.writeUInt16LE(id.vendorId, o); o += 2;
    data.writeUInt16LE(id.deviceType, o); o += 2;
    data.writeUInt16LE(id.productCode, o); o += 2;
    data[o++] = id.revMajor;
    data[o++] = id.revMinor;
    data.writeUInt16LE(id.status, o); o += 2;
    data.writeUInt32LE(id.serial >>> 0, o); o += 4;
    data[o++] = name.length;
    name.copy(data, o); o += name.length;
    data[o] = id.state;
    const head = Buffer.alloc(4);
    head.writeUInt16LE(0x000c, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  }

  _send(socket, buf, isData) {
    let delay = this.faults.delayMs || 0;
    if (isData && this.faults.lateReply) {
      delay = this.faults.lateReply;
      this.faults.lateReply = 0;
    }
    const go = () => {
      if (!socket.destroyed) socket.write(buf);
    };
    if (delay) setTimeout(go, delay).unref();
    else go();
  }

  _header(cmd, len, session, ctx, status = 0) {
    const h = Buffer.alloc(24);
    h.writeUInt16LE(cmd, 0);
    h.writeUInt16LE(len, 2);
    h.writeUInt32LE(session >>> 0, 4);
    h.writeUInt32LE(status, 8);
    ctx.copy(h, 12);
    return h;
  }

  _onPacket(socket, st, pkt) {
    const cmd = pkt.readUInt16LE(0);
    const session = pkt.readUInt32LE(4);
    const ctx = Buffer.from(pkt.subarray(12, 20));
    const body = pkt.subarray(24);
    if (cmd === 0x65) {
      this.stats.registerSessions++;
      st.session = 0x1000 + Math.floor(Math.random() * 0xffff);
      this._send(socket, Buffer.concat([this._header(0x65, 4, st.session, ctx), body.subarray(0, 4)]));
      return;
    }
    if (cmd === 0x66) {
      this.stats.unregisterSessions++;
      st.session = 0;
      return;
    }
    if (cmd === 0x63) {
      const item = this._identityItem(socket);
      this._send(socket, Buffer.concat([this._header(0x63, 2 + item.length, 0, ctx), Buffer.from([1, 0]), item]));
      return;
    }
    if (session !== st.session || !st.session) {
      this._send(socket, this._header(cmd, 0, session, ctx, 0x64));
      return;
    }
    // CPF
    const count = body.readUInt16LE(6);
    let i = 8;
    const items = [];
    for (let n = 0; n < count; n++) {
      const type = body.readUInt16LE(i);
      const len = body.readUInt16LE(i + 2);
      items.push({ type, data: body.subarray(i + 4, i + 4 + len) });
      i += 4 + len;
    }
    this.stats.dataRequests++;
    if (this.faults.blackhole) return;
    if (this.faults.dropConnection) {
      this.faults.dropConnection = false;
      socket.destroy();
      return;
    }
    if (cmd === 0x6f) {
      const msg = items.find((x) => x.type === 0xb2).data;
      const reply = this._unconnected(st, msg);
      let replyCtx = ctx;
      if (this.faults.wrongContext) {
        this.faults.wrongContext = false;
        replyCtx = Buffer.from(ctx);
        replyCtx[0] ^= 0xff;
      }
      this._send(socket, this._cpfReply(0x6f, st.session, replyCtx, [{ type: 0, data: Buffer.alloc(0) }, { type: 0xb2, data: reply }]), true);
      return;
    }
    if (cmd === 0x70) {
      const addr = items.find((x) => x.type === 0xa1).data.readUInt32LE(0);
      const data = items.find((x) => x.type === 0xb1).data;
      const conn = st.connections.get(addr);
      if (!conn) {
        this._send(socket, this._header(0x70, 0, st.session, ctx, 0x03));
        return;
      }
      let seq = data.readUInt16LE(0);
      const reply = this._process(data.subarray(2), { size: conn.size });
      if (this.faults.wrongSequence) {
        this.faults.wrongSequence = false;
        seq = (seq - 1) & 0xffff;
      }
      const addrItem = Buffer.alloc(4);
      addrItem.writeUInt32LE(conn.toId, 0);
      const seqBuf = Buffer.alloc(2);
      seqBuf.writeUInt16LE(seq, 0);
      this._send(socket, this._cpfReply(0x70, st.session, ctx, [{ type: 0xa1, data: addrItem }, { type: 0xb1, data: Buffer.concat([seqBuf, reply]) }]), true);
    }
  }

  _cpfReply(cmd, session, ctx, items) {
    const parts = [];
    const head = Buffer.alloc(8);
    head.writeUInt16LE(items.length, 6);
    parts.push(head);
    let truncate = false;
    if (this.faults.truncate) {
      this.faults.truncate = false;
      truncate = true;
    }
    items.forEach((it, k) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(it.type, 0);
      h.writeUInt16LE(it.data.length + (truncate && k === items.length - 1 ? 50 : 0), 2);
      parts.push(h, it.data);
    });
    const body = Buffer.concat(parts);
    return Buffer.concat([this._header(cmd, body.length, session, ctx), body]);
  }

  static reply(service, status = 0, data = Buffer.alloc(0), ext = []) {
    const h = Buffer.alloc(4 + ext.length * 2);
    h[0] = service | 0x80;
    h[2] = status;
    h[3] = ext.length;
    ext.forEach((e, k) => h.writeUInt16LE(e, 4 + 2 * k));
    return Buffer.concat([h, data]);
  }

  /** Parse an EPATH into a list of segments. */
  static parsePath(path) {
    const segs = [];
    let i = 0;
    while (i < path.length) {
      const s = path[i];
      if (s === 0x91) {
        const len = path[i + 1];
        segs.push({ sym: path.toString('latin1', i + 2, i + 2 + len) });
        i += 2 + len + (len % 2);
      } else if ((s & 0xe0) === 0x20) {
        const fmt = s & 3;
        const kind = (s >> 2) & 7;
        const value = fmt === 0 ? path[i + 1] : fmt === 1 ? path.readUInt16LE(i + 2) : path.readUInt32LE(i + 2);
        i += fmt === 0 ? 2 : fmt === 1 ? 4 : 6;
        segs.push({ kind: ['class', 'instance', 'element', 'cp', 'attribute'][kind], value });
      } else if ((s & 0xe0) === 0) {
        i += s & 0x10 ? 2 + path[i + 1] + (path[i + 1] % 2) : 2;
        segs.push({ port: s & 0x0f });
      } else throw new Error(`sim: bad segment 0x${s.toString(16)}`);
    }
    return segs;
  }

  _unconnected(st, msg) {
    const service = msg[0];
    const path = msg.subarray(2, 2 + msg[1] * 2);
    const data = msg.subarray(2 + msg[1] * 2);
    const segs = EipSimulator.parsePath(path);
    const isCm = segs.length >= 1 && segs[0].kind === 'class' && segs[0].value === 0x06;
    if (isCm && (service === 0x54 || service === 0x5b)) return this._forwardOpen(st, service, data);
    if (isCm && service === 0x4e) return this._forwardClose(st, data);
    if (isCm && service === 0x52) {
      const size = data.readUInt16LE(2);
      return this._process(data.subarray(4, 4 + size), { size: 504 });
    }
    return this._process(msg, { size: 504 });
  }

  _forwardOpen(st, service, data) {
    this.stats.forwardOpens++;
    const large = service === 0x5b;
    if (large) this.stats.largeForwardOpens++;
    if (large && this.rejectLarge) {
      this.stats.largeRejected++;
      return EipSimulator.reply(service, 0x08);
    }
    const toId = data.readUInt32LE(6);
    const serial = data.readUInt16LE(10);
    const vendor = data.readUInt16LE(12);
    const origSerial = data.readUInt32LE(14);
    const params = large ? data.readUInt32LE(26) : data.readUInt16LE(26);
    const size = large ? params & 0xffff : params & 0x1ff;
    if (size > this.maxConnectionSize) return EipSimulator.reply(service, 0x01, Buffer.alloc(0), [0x0109]);
    const otId = 0x10000 + Math.floor(Math.random() * 0xfffff);
    st.connections.set(otId, { toId, serial, origSerial, size });
    this.stats.openConnections++;
    const r = Buffer.alloc(26);
    r.writeUInt32LE(otId, 0);
    r.writeUInt32LE(toId, 4);
    r.writeUInt16LE(serial, 8);
    r.writeUInt16LE(vendor, 10);
    r.writeUInt32LE(origSerial, 12);
    r.writeUInt32LE(2000000, 16);
    r.writeUInt32LE(2000000, 20);
    return EipSimulator.reply(service, 0, r);
  }

  _forwardClose(st, data) {
    this.stats.forwardCloses++;
    const serial = data.readUInt16LE(2);
    for (const [id, c] of st.connections) {
      if (c.serial === serial) {
        st.connections.delete(id);
        this.stats.openConnections--;
      }
    }
    const r = Buffer.alloc(10);
    data.copy(r, 0, 2, 10);
    return EipSimulator.reply(0x4e, 0, r);
  }

  _count(map, service) {
    map[service] = (map[service] || 0) + 1;
  }

  _process(msg, ctx, inner = false) {
    const service = msg[0];
    const path = msg.subarray(2, 2 + msg[1] * 2);
    const data = msg.subarray(2 + msg[1] * 2);
    this._count(inner ? this.stats.innerServices : this.stats.services, service);
    let segs;
    try {
      segs = EipSimulator.parsePath(path);
    } catch {
      return EipSimulator.reply(service, 0x04);
    }
    const cls = segs.find((s) => s.kind === 'class');
    const inst = segs.find((s) => s.kind === 'instance');
    if (service === 0x4d || service === 0x53 || (service === 0x4e && !cls)) {
      this.stats.writesReceived++;
      return this._write(service, segs, data);
    }
    if (service === 0x0a && cls && cls.value === 0x02) return this._msp(data, ctx);
    if (service === 0x4c && cls && cls.value === 0x6c) return this._readTemplate(inst.value, data, ctx);
    if (service === 0x03 && cls && cls.value === 0x6c) return this._templateAttrs(inst.value, data);
    if (service === 0x55 && cls && cls.value === 0x6b) return this._instanceList(segs, inst.value, data, ctx);
    if (service === 0x01 && cls && cls.value === 0x01) return this._identity();
    if ((service === 0x4c || service === 0x52) && segs[0] && segs[0].sym) return this._readTag(service, segs, data, ctx);
    return EipSimulator.reply(service, 0x08);
  }

  _identity() {
    const name = '1756-L83E/B SIM';
    const b = Buffer.alloc(15 + name.length);
    b.writeUInt16LE(1, 0);
    b.writeUInt16LE(0x0e, 2);
    b.writeUInt16LE(166, 4);
    b[6] = this.revisionMajor;
    b[7] = 11;
    b.writeUInt16LE(0x3060, 8);
    b.writeUInt32LE(0xc0ffee01, 10);
    b[14] = name.length;
    b.write(name, 15, 'latin1');
    return EipSimulator.reply(0x01, 0, b);
  }

  _msp(data, ctx) {
    const count = data.readUInt16LE(0);
    const offs = [];
    for (let k = 0; k < count; k++) offs.push(data.readUInt16LE(2 + 2 * k));
    const replies = offs.map((o, k) => this._process(data.subarray(o, k + 1 < count ? offs[k + 1] : data.length), ctx, true));
    const head = Buffer.alloc(2 + 2 * count);
    head.writeUInt16LE(count, 0);
    let off = head.length;
    replies.forEach((r, k) => {
      head.writeUInt16LE(off, 2 + 2 * k);
      off += r.length;
    });
    const anyError = replies.some((r) => r[2] !== 0);
    const out = EipSimulator.reply(0x0a, anyError ? 0x1e : 0, Buffer.concat([head, ...replies]));
    if (out.length > ctx.size - 2) return EipSimulator.reply(0x0a, 0x11);
    return out;
  }

  _lookup(scopeList, name) {
    return scopeList.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /** Resolve a symbolic path to { type, data slice, elementCount available }. */
  _resolve(segs) {
    let k = 0;
    let scope = this.db.controller;
    if (/^program:/i.test(segs[0].sym)) {
      const prog = Object.keys(this.db.programs).find((p) => p.toLowerCase() === segs[0].sym.slice(8).toLowerCase());
      if (!prog) return { status: 0x05 };
      scope = this.db.programs[prog];
      k = 1;
    }
    if (!segs[k] || !segs[k].sym) return { status: 0x04 };
    const tag = this._lookup(scope, segs[k].sym);
    if (!tag || tag.program) return { status: 0x05 };
    if (tag.access === 3) return { status: 0x0f };
    k++;
    let type = tag.type;
    let dims = tag.dims;
    let base = 0;
    let boolArray = !!tag.boolArray;
    const data = tag.data;
    const elemSize = (t) => (typeof t === 'object' ? this.templates.get(t.tpl).size : SIZE[t]);
    while (k < segs.length) {
      const s = segs[k];
      if (s.kind === 'element') {
        const idx = [];
        while (k < segs.length && segs[k].kind === 'element') idx.push(segs[k++].value);
        if (boolArray) {
          if (idx[0] >= dims[0] / 32) return { status: 0xff, ext: [0x2105] };
          base += idx[0] * 4;
          return { type: 'DWORD', data, base, available: dims[0] / 32 - idx[0] };
        }
        if (idx.length !== dims.length) return { status: 0x04 };
        let linear = 0;
        for (let d = 0; d < dims.length; d++) {
          if (idx[d] >= dims[d]) return { status: 0xff, ext: [0x2105] };
          linear = linear * dims[d] + idx[d];
        }
        const total = dims.reduce((a, c) => a * c, 1);
        base += linear * elemSize(type);
        dims = [];
        if (k === segs.length) return { type, data, base, available: total - linear };
        continue;
      }
      if (s.sym) {
        if (typeof type !== 'object' || dims.length) return { status: 0x04 };
        const tpl = this.templates.get(type.tpl);
        const m = tpl.members.find((x) => x.name.toLowerCase() === s.sym.toLowerCase() && !x.name.startsWith('ZZZZZZZZZZ'));
        if (!m) return { status: 0x04 };
        base += m.offset;
        k++;
        if (m.type === T.BOOL) {
          const v = (data[base] >> m.info) & 1;
          return { type: 'BOOL', data: Buffer.from([v ? 1 : 0]), base: 0, available: 1 };
        }
        if (m.type & 0x8000) {
          type = { tpl: m.type & 0xfff };
          dims = m.info ? [m.info] : [];
        } else {
          type = Object.keys(T).find((n) => T[n] === m.type);
          dims = m.info ? [m.info] : [];
        }
        boolArray = false;
        continue;
      }
      return { status: 0x04 };
    }
    if (boolArray) return { type: 'DWORD', data, base, available: dims[0] / 32 };
    const total = dims.length ? dims.reduce((a, c) => a * c, 1) : 1;
    return { type, data, base, available: total };
  }

  _typeHeader(type) {
    if (typeof type === 'object') {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(0x02a0, 0);
      h.writeUInt16LE(this.templates.get(type.tpl).handle, 2);
      return h;
    }
    const h = Buffer.alloc(2);
    h.writeUInt16LE(T[type], 0);
    return h;
  }

  _readTag(service, segs, data, ctx) {
    const r = this._resolve(segs);
    if (r.status !== undefined) return EipSimulator.reply(service, r.status, Buffer.alloc(0), r.ext || []);
    const elements = data.readUInt16LE(0);
    if (elements < 1 || elements > r.available) return EipSimulator.reply(service, 0xff, Buffer.alloc(0), [0x2105]);
    const size = typeof r.type === 'object' ? this.templates.get(r.type.tpl).size : SIZE[r.type];
    const value = r.data.subarray(r.base, r.base + size * elements);
    const header = this._typeHeader(r.type);
    const room = ctx.size - 2 - 4 - header.length;
    if (service === 0x4c) {
      if (value.length > room) return EipSimulator.reply(service, 0x06, Buffer.concat([header, value.subarray(0, room)]));
      return EipSimulator.reply(service, 0, Buffer.concat([header, value]));
    }
    const offset = data.readUInt32LE(2);
    if (offset > value.length) return EipSimulator.reply(service, 0xff, Buffer.alloc(0), [0x2104]);
    const chunkLen = Math.min(room - (room % 4), value.length - offset);
    const more = offset + chunkLen < value.length;
    return EipSimulator.reply(service, more ? 0x06 : 0, Buffer.concat([header, value.subarray(offset, offset + chunkLen)]));
  }

  _write(service, segs, data) {
    if (service === 0x4d && segs[0] && segs[0].sym) {
      const r = this._resolve(segs);
      if (r.status === undefined && typeof r.type === 'string') {
        const typeCode = data.readUInt16LE(0);
        const count = data.readUInt16LE(2);
        if (typeCode === T[r.type]) data.subarray(4, 4 + count * SIZE[r.type]).copy(r.data, r.base);
      }
    }
    return EipSimulator.reply(service, 0);
  }

  _templateBytes(tpl) {
    if (!tpl._bytes) {
      const recs = Buffer.alloc(tpl.members.length * 8);
      tpl.members.forEach((m, k) => {
        recs.writeUInt16LE(m.info, k * 8);
        recs.writeUInt16LE(m.type, k * 8 + 2);
        recs.writeUInt32LE(m.offset, k * 8 + 4);
      });
      const names = `${tpl.name};n\0${tpl.members.map((m) => `${m.name}\0`).join('')}`;
      tpl._bytes = Buffer.concat([recs, Buffer.from(names, 'latin1')]);
    }
    return tpl._bytes;
  }

  _templateAttrs(id, data) {
    const tpl = this.templates.get(id);
    if (!tpl) return EipSimulator.reply(0x03, 0x05);
    const count = data.readUInt16LE(0);
    const bytes = this._templateBytes(tpl);
    const defWords = Math.ceil((bytes.length + 21) / 4);
    const parts = [Buffer.from([count & 0xff, count >> 8])];
    for (let k = 0; k < count; k++) {
      const id2 = data.readUInt16LE(2 + 2 * k);
      const h = Buffer.alloc(4);
      h.writeUInt16LE(id2, 0);
      let v;
      if (id2 === 1 || id2 === 2) {
        v = Buffer.alloc(2);
        v.writeUInt16LE(id2 === 1 ? tpl.handle : tpl.members.length, 0);
      } else if (id2 === 4 || id2 === 5) {
        v = Buffer.alloc(4);
        v.writeUInt32LE(id2 === 4 ? defWords : tpl.size, 0);
      } else {
        h.writeUInt16LE(0x14, 2);
        v = Buffer.alloc(0);
      }
      parts.push(h, v);
    }
    return EipSimulator.reply(0x03, 0, Buffer.concat(parts));
  }

  _readTemplate(id, data, ctx) {
    const tpl = this.templates.get(id);
    if (!tpl) return EipSimulator.reply(0x4c, 0x05);
    const bytes = this._templateBytes(tpl);
    const offset = data.readUInt32LE(0);
    const want = data.readUInt16LE(4);
    const room = ctx.size - 2 - 4;
    const end = Math.min(bytes.length, offset + want);
    const chunkEnd = Math.min(end, offset + room);
    const more = chunkEnd < end;
    return EipSimulator.reply(0x4c, more ? 0x06 : 0, bytes.subarray(offset, chunkEnd));
  }

  _symbolTypeWord(t) {
    if (t.program) return 0x1068;
    const dimBits = (t.dims.length & 3) << 13;
    const sys = t.system ? 0x1000 : 0;
    if (typeof t.type === 'object') return 0x8000 | dimBits | t.type.tpl | sys;
    return T[t.type] | dimBits | sys;
  }

  _instanceList(segs, start, data, ctx) {
    let scope = this.db.controller;
    if (segs[0] && segs[0].sym) {
      const prog = Object.keys(this.db.programs).find((p) => `program:${p.toLowerCase()}` === segs[0].sym.toLowerCase());
      if (!prog) return EipSimulator.reply(0x55, 0x05);
      scope = this.db.programs[prog];
    }
    const count = data.readUInt16LE(0);
    const attrs = [];
    for (let k = 0; k < count; k++) attrs.push(data.readUInt16LE(2 + 2 * k));
    if (attrs.includes(10) && !this.externalAccessAttr) return EipSimulator.reply(0x55, 0x14);
    const room = ctx.size - 2 - 4;
    const parts = [];
    let used = 0;
    let more = false;
    for (const t of scope.filter((x) => x.instance >= start).sort((a, b) => a.instance - b.instance)) {
      const rec = [];
      const idb = Buffer.alloc(4);
      idb.writeUInt32LE(t.instance, 0);
      rec.push(idb);
      for (const a of attrs) {
        if (a === 1) {
          const n = Buffer.alloc(2);
          n.writeUInt16LE(t.name.length, 0);
          rec.push(n, Buffer.from(t.name, 'latin1'));
        } else if (a === 2) {
          const w = Buffer.alloc(2);
          w.writeUInt16LE(this._symbolTypeWord(t), 0);
          rec.push(w);
        } else if (a === 8) {
          const d = Buffer.alloc(12);
          (t.dims || []).forEach((v, k) => d.writeUInt32LE(v, 4 * k));
          rec.push(d);
        } else if (a === 10) {
          rec.push(Buffer.from([t.access || 0]));
        } else return EipSimulator.reply(0x55, 0x14);
      }
      const b = Buffer.concat(rec);
      if (used + b.length > room) {
        more = true;
        break;
      }
      parts.push(b);
      used += b.length;
    }
    return EipSimulator.reply(0x55, more ? 0x06 : 0, Buffer.concat(parts));
  }
}

module.exports = { EipSimulator, defaultDatabase, STRING_TPL, MOTOR_TPL };
