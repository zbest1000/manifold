'use strict';

/**
 * In-process S7comm server for tests (node:net). Deliberately written
 * independently of server/drivers/s7/frame.js so that driver and simulator
 * do not share framing bugs.
 *
 * Implements: COTP CR/CC, setup communication (PDU negotiated down to
 * `maxPdu`), Read Var (BYTE and BIT items) over DB/M/I/Q byte arrays with
 * per-item return codes, read SZL (0x011C, 0x0111, 0x0424), and — so tests can
 * prove the driver never sends them — Write Var and PLC control/stop, which
 * are counted in `stats.writesReceived` / `stats.controlReceived`.
 *
 * Fault injection (`sim.faults`, applied to Read Var jobs unless noted):
 *   blackhole        never answer
 *   delayMs          answer after this many ms
 *   lateReply        answer after this many ms (meant to be longer than the client deadline)
 *   dropConnection   destroy the socket when the request arrives
 *   truncate         answer with an S7 header whose lengths overrun the PDU
 *   wrongPduRef      answer with PDU reference + 1
 *   refuseConnections  destroy every new TCP connection immediately (all traffic)
 *   rejectCotp       answer COTP CR with a disconnect request (all traffic)
 *   szlBlackhole     never answer SZL reads
 *   headerError      [errorClass, errorCode]: answer with a whole-request error
 */

const net = require('net');

function createS7Simulator({
  maxPdu = 960,
  dbs = {},
  M = Buffer.alloc(64),
  I = Buffer.alloc(16),
  Q = Buffer.alloc(16),
  identity = {
    systemName: 'Manifold test PLC',
    moduleName: 'CPU 1516-3 PN/DP',
    serialNumber: 'S C-TEST00001',
    moduleTypeName: 'CPU 1516-3 PN/DP',
    orderCode: '6ES7 516-3AN02-0AB0',
    firmware: [2, 9, 4],
  },
  cpuState = 0x08,
} = {}) {
  const areas = { 0x81: I, 0x82: Q, 0x83: M };
  const memory = { dbs: new Map(Object.entries(dbs).map(([k, v]) => [Number(k), v])), areas };
  const stats = {
    connections: 0,
    cotpConnects: 0,
    setupComm: 0,
    readVar: 0,
    readItems: 0,
    szlReads: 0,
    writesReceived: 0,
    controlReceived: 0,
    otherJobs: 0,
    otherUserdata: 0,
    oversizeRequests: 0,
    oversizeResponses: 0,
    lastRemoteTsap: null,
    maxItemsInRequest: 0,
  };
  const faults = {
    blackhole: false,
    delayMs: 0,
    lateReply: 0,
    dropConnection: false,
    truncate: false,
    wrongPduRef: false,
    refuseConnections: false,
    rejectCotp: false,
    szlBlackhole: false,
    headerError: null,
  };
  const sockets = new Set();
  const timers = new Set();

  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function tpkt(payload) {
    const h = Buffer.from([3, 0, 0, 0]);
    h.writeUInt16BE(payload.length + 4, 2);
    return Buffer.concat([h, payload]);
  }
  const dt = (s7) => tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), s7]));

  function ackData(ref, param, data = Buffer.alloc(0), errClass = 0, errCode = 0) {
    const h = Buffer.alloc(12);
    h[0] = 0x32;
    h[1] = 3;
    h.writeUInt16BE(ref, 4);
    h.writeUInt16BE(param.length, 6);
    h.writeUInt16BE(data.length, 8);
    h[10] = errClass;
    h[11] = errCode;
    return Buffer.concat([h, param, data]);
  }

  function userdata(ref, param, data) {
    const h = Buffer.alloc(10);
    h[0] = 0x32;
    h[1] = 7;
    h.writeUInt16BE(ref, 4);
    h.writeUInt16BE(param.length, 6);
    h.writeUInt16BE(data.length, 8);
    return Buffer.concat([h, param, data]);
  }

  function memFor(area, db) {
    if (area === 0x84) return memory.dbs.get(db) || null;
    return memory.areas[area] || null;
  }

  function readItems(param) {
    const count = param[1];
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = 2 + i * 12;
      const ts = param[o + 3];
      const len = param.readUInt16BE(o + 4);
      const db = param.readUInt16BE(o + 6);
      const area = param[o + 8];
      const bitAddr = (param[o + 9] << 16) | (param[o + 10] << 8) | param[o + 11];
      const mem = memFor(area, db);
      if (!mem) {
        out.push({ rc: 0x0a });
        continue;
      }
      if (ts === 0x01) {
        const byte = bitAddr >> 3;
        if (byte >= mem.length) out.push({ rc: 0x05 });
        else out.push({ rc: 0xff, ts: 0x03, bits: 1, data: Buffer.from([(mem[byte] >> (bitAddr & 7)) & 1]) });
        continue;
      }
      if (ts !== 0x02) {
        out.push({ rc: 0x06 });
        continue;
      }
      const start = bitAddr >> 3;
      if (start + len > mem.length) out.push({ rc: 0x05 });
      else out.push({ rc: 0xff, ts: 0x04, bits: len * 8, data: Buffer.from(mem.subarray(start, start + len)) });
    }
    return out;
  }

  function encodeReadData(items) {
    const parts = [];
    items.forEach((it, i) => {
      if (it.rc !== 0xff) {
        parts.push(Buffer.from([it.rc, 0, 0, 0]));
        return;
      }
      const h = Buffer.from([0xff, it.ts, 0, 0]);
      h.writeUInt16BE(it.bits, 2);
      parts.push(h, it.data);
      if (it.data.length % 2 === 1 && i < items.length - 1) parts.push(Buffer.from([0]));
    });
    return Buffer.concat(parts);
  }

  function szlRecord(id, index) {
    const text = (s) => {
      const b = Buffer.alloc(34);
      b.writeUInt16BE(index, 0);
      b.write(String(s || ''), 2, 32, 'latin1');
      return b;
    };
    if (id === 0x011c) {
      const map = { 1: identity.systemName, 2: identity.moduleName, 5: identity.serialNumber, 7: identity.moduleTypeName };
      if (map[index] === undefined) return null;
      return { len: 34, records: [text(map[index])] };
    }
    if (id === 0x0111) {
      const r = Buffer.alloc(28);
      r.writeUInt16BE(index, 0);
      if (index === 1) {
        r.fill(0x20, 2, 22);
        r.write(identity.orderCode, 2, 20, 'latin1');
      } else if (index === 7) {
        r.fill(0x20, 2, 22);
        const [a, b, c] = identity.firmware;
        r[24] = 0x56; // 'V'
        r[25] = a;
        r[26] = b;
        r[27] = c;
      } else return null;
      return { len: 28, records: [r] };
    }
    if (id === 0x0424 && index === 0) {
      const r = Buffer.alloc(20);
      r.writeUInt16BE(0x4302, 0);
      r[2] = 0xff;
      r[3] = cpuState;
      return { len: 20, records: [r] };
    }
    return null;
  }

  function handleSzl(sock, ref, param, data) {
    stats.szlReads++;
    if (faults.szlBlackhole) return;
    const id = data.readUInt16BE(4);
    const index = data.readUInt16BE(6);
    const rec = szlRecord(id, index);
    const p = Buffer.from([0x00, 0x01, 0x12, 0x08, 0x12, 0x84, 0x01, param[7], 0x00, 0x00, 0x00, 0x00]);
    if (!rec) {
      p.writeUInt16BE(0xd401, 10);
      sock.write(dt(userdata(ref, p, Buffer.from([0x0a, 0x00, 0x00, 0x00]))));
      return;
    }
    const body = Buffer.alloc(8);
    body.writeUInt16BE(id, 0);
    body.writeUInt16BE(index, 2);
    body.writeUInt16BE(rec.len, 4);
    body.writeUInt16BE(rec.records.length, 6);
    const payload = Buffer.concat([body, ...rec.records]);
    const head = Buffer.from([0xff, 0x09, 0, 0]);
    head.writeUInt16BE(payload.length, 2);
    sock.write(dt(userdata(ref, p, Buffer.concat([head, payload]))));
  }

  function respondRead(sock, conn, ref, s7len, param) {
    stats.readVar++;
    stats.maxItemsInRequest = Math.max(stats.maxItemsInRequest, param[1]);
    if (s7len > conn.pdu) {
      stats.oversizeRequests++;
      sock.write(dt(ackData(ref, Buffer.from([0x04, 0]), Buffer.alloc(0), 0x85, 0x00)));
      return;
    }
    if (faults.headerError) {
      sock.write(dt(ackData(ref, Buffer.from([0x04, 0]), Buffer.alloc(0), faults.headerError[0], faults.headerError[1])));
      return;
    }
    const items = readItems(param);
    stats.readItems += items.length;
    const data = encodeReadData(items);
    let reply = ackData(ref, Buffer.from([0x04, items.length]), data);
    if (reply.length > conn.pdu) {
      stats.oversizeResponses++;
      reply = ackData(ref, Buffer.from([0x04, 0]), Buffer.alloc(0), 0x85, 0x00);
    }
    if (faults.dropConnection) {
      sock.destroy();
      return;
    }
    if (faults.blackhole) return;
    if (faults.wrongPduRef) reply.writeUInt16BE((ref + 1) & 0xffff, 4);
    if (faults.truncate) reply.writeUInt16BE(reply.readUInt16BE(8) + 10, 8);
    const send = () => {
      if (!sock.destroyed) sock.write(dt(reply));
    };
    const wait = faults.lateReply || faults.delayMs;
    if (wait) later(wait, send);
    else send();
  }

  function handleWrite(sock, conn, ref, param, data) {
    stats.writesReceived++;
    const count = param[1];
    let o = 0;
    const rcs = [];
    for (let i = 0; i < count; i++) {
      const p = 2 + i * 12;
      const db = param.readUInt16BE(p + 6);
      const area = param[p + 8];
      const start = ((param[p + 9] << 16) | (param[p + 10] << 8) | param[p + 11]) >> 3;
      const ts = data[o + 1];
      const lenField = data.readUInt16BE(o + 2);
      const n = ts === 0x03 || ts === 0x04 || ts === 0x05 ? Math.ceil(lenField / 8) : lenField;
      const mem = memFor(area, db);
      if (mem && start + n <= mem.length) {
        data.copy(mem, start, o + 4, o + 4 + n);
        rcs.push(0xff);
      } else rcs.push(0x05);
      o += 4 + n + (n % 2);
    }
    sock.write(dt(ackData(ref, Buffer.from([0x05, count]), Buffer.from(rcs))));
  }

  function handleS7(sock, conn, s7) {
    const rosctr = s7[1];
    const ref = s7.readUInt16BE(4);
    const plen = s7.readUInt16BE(6);
    const dlen = s7.readUInt16BE(8);
    const param = s7.subarray(10, 10 + plen);
    const data = s7.subarray(10 + plen, 10 + plen + dlen);
    if (rosctr === 1) {
      const fn = param[0];
      if (fn === 0xf0) {
        stats.setupComm++;
        const want = param.readUInt16BE(6);
        conn.pdu = Math.min(want, maxPdu);
        const p = Buffer.from(param);
        p.writeUInt16BE(conn.pdu, 6);
        sock.write(dt(ackData(ref, p)));
      } else if (fn === 0x04) {
        respondRead(sock, conn, ref, s7.length, param);
      } else if (fn === 0x05) {
        handleWrite(sock, conn, ref, param, data);
      } else if (fn === 0x28 || fn === 0x29) {
        stats.controlReceived++;
        sock.write(dt(ackData(ref, Buffer.from([fn]))));
      } else {
        stats.otherJobs++;
        sock.write(dt(ackData(ref, Buffer.from([fn]), Buffer.alloc(0), 0x81, 0x04)));
      }
      return;
    }
    if (rosctr === 7) {
      const group = param[5] & 0x0f;
      const sub = param[6];
      if (group === 0x4 && sub === 0x01) {
        handleSzl(sock, ref, param, data);
        return;
      }
      stats.otherUserdata++;
      if (group === 0x1 || group === 0x7) stats.controlReceived++; // programmer commands / clock set
    }
  }

  function onConnection(sock) {
    stats.connections++;
    if (faults.refuseConnections) {
      sock.destroy();
      return;
    }
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const conn = { pdu: 240, buf: Buffer.alloc(0) };
    sock.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      while (conn.buf.length >= 4) {
        const len = conn.buf.readUInt16BE(2);
        if (conn.buf[0] !== 3 || len < 7) {
          sock.destroy();
          return;
        }
        if (conn.buf.length < len) return;
        const frame = conn.buf.subarray(0, len);
        conn.buf = conn.buf.subarray(len);
        const type = frame[5];
        if (type === 0xe0) {
          if (faults.rejectCotp) {
            sock.end(tpkt(Buffer.from([0x06, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00])));
            return;
          }
          stats.cotpConnects++;
          const li = frame[4];
          const params = frame.subarray(11, 5 + li);
          for (let o = 0; o + 2 <= params.length; o += 2 + params[o + 1]) {
            if (params[o] === 0xc2) stats.lastRemoteTsap = params.readUInt16BE(o + 2);
          }
          const cc = Buffer.from(frame.subarray(4));
          cc[1] = 0xd0;
          cc.writeUInt16BE(frame.readUInt16BE(8), 2); // dst ref = client's src ref
          cc.writeUInt16BE(0x0001, 4);
          sock.write(tpkt(cc));
        } else if (type === 0xf0) {
          handleS7(sock, conn, Buffer.from(frame.subarray(7)));
        }
      }
    });
  }

  const server = net.createServer(onConnection);

  return {
    stats,
    faults,
    memory,
    get openConnections() {
      return sockets.size;
    },
    get port() {
      return server.address().port;
    },
    setCpuState(v) {
      cpuState = v;
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    /** Drop every open connection (simulates a PLC restart) without closing the listener. */
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createS7Simulator };
