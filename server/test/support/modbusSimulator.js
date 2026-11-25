'use strict';

/**
 * In-process Modbus TCP server for tests and local demos, with runtime fault
 * injection. It implements the read codes (1-4) AND the write codes
 * (5, 6, 15, 16) on purpose: every write is counted in `stats.writesReceived`
 * so tests can prove the driver under test never sends one.
 *
 * Tables are named 'holding' | 'input' | 'coil' | 'discrete' (plural forms are
 * accepted). Missing registers inside a mapped range read as 0; ranges listed in
 * `unmapped` answer exception 02 for any read that overlaps them (inclusive,
 * wire offsets). A request for a unit id that is not configured answers 0B.
 *
 * Faults (`sim.faults` for all units; `sim.unitFaults[unit]` overrides per
 * unit; both settable at runtime):
 *   blackhole: true                 accept the request, never answer
 *   delayMs: n                      delay every answer
 *   lateReply: {delayMs, count=1}   delay only the next `count` answers
 *   dropConnection: true            RST the socket instead of answering
 *   truncate: true | {bytes=9, close=true}  send a partial frame (then close)
 *   wrongTid: true                  answer with a different transaction id
 *   exception: {fc?, code}          answer with that exception (for fc, or any)
 *   refuseConnections: true         destroy every new connection on accept
 *   maxConnections: n               destroy connections beyond n open ones
 *   echoUnitId: n                   answer with this unit id
 * `stopListening()` / `startListening()` give a genuine ECONNREFUSED.
 */

const net = require('node:net');

const TABLE_ALIASES = {
  holding: 'holding', holdings: 'holding', input: 'input', inputs: 'input',
  coil: 'coil', coils: 'coil', discrete: 'discrete',
};
const FC_TABLE = { 1: 'coil', 2: 'discrete', 3: 'holding', 4: 'input' };

function tableName(t) {
  const name = TABLE_ALIASES[t];
  if (!name) throw new Error(`unknown table "${t}"`);
  return name;
}

function toMap(src) {
  return new Map(Object.entries(src || {}).map(([k, v]) => [Number(k), Number(v)]));
}

function makeUnit(cfg = {}) {
  return {
    holding: toMap(cfg.holding),
    input: toMap(cfg.input),
    coil: toMap(cfg.coils || cfg.coil),
    discrete: toMap(cfg.discrete),
    unmapped: (cfg.unmapped || []).map((u) => ({ ...u, table: tableName(u.table) })),
  };
}

/** Lay `buf` out the way a device with the given orders would put it on the wire. */
function wireOrder(buf, { byteOrder = 'big', wordOrder = 'big' } = {}) {
  const out = Buffer.from(buf);
  if (wordOrder === 'little') {
    const r = Buffer.alloc(out.length);
    for (let i = 0; i < out.length; i += 2) out.copy(r, out.length - 2 - i, i, i + 2);
    r.copy(out);
  }
  if (byteOrder === 'little') {
    for (let i = 0; i + 1 < out.length; i += 2) out.writeUInt16BE(out.readUInt16LE(i), i);
  }
  return out;
}

function mbap(tid, unit, pdu) {
  const head = Buffer.alloc(7);
  head.writeUInt16BE(tid, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head.writeUInt8(unit, 6);
  return Buffer.concat([head, pdu]);
}

/**
 * @param {{port?:number, host?:string, units?:Record<number,object>, faults?:object}} [opts]
 * @returns {Promise<object>} simulator handle (see module doc)
 */
async function startSimulator({ port = 0, host = '127.0.0.1', units = {}, faults = {} } = {}) {
  const unitData = new Map(Object.entries(units).map(([id, cfg]) => [Number(id), makeUnit(cfg)]));
  const unitFaults = {};
  Object.entries(units).forEach(([id, cfg]) => {
    if (cfg.faults) unitFaults[id] = { ...cfg.faults };
  });
  const stats = { connections: 0, openConnections: 0, refused: 0, requests: 0, byFc: {}, writesReceived: 0 };
  const sockets = new Set();
  const timers = new Set();
  const sim = { faults: { ...faults }, unitFaults, stats };
  let listenPort = port;

  const effective = (unit) => ({ ...sim.faults, ...(unitFaults[unit] || {}) });
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function exceptionPdu(fc, code) {
    return Buffer.from([fc | 0x80, code]);
  }

  function readPdu(data, fc, address, quantity) {
    const table = FC_TABLE[fc];
    const max = fc <= 2 ? 2000 : 125;
    if (quantity < 1 || quantity > max) return exceptionPdu(fc, 3);
    if (address + quantity > 0x10000) return exceptionPdu(fc, 2);
    const last = address + quantity - 1;
    if (data.unmapped.some((u) => u.table === table && u.from <= last && u.to >= address)) {
      return exceptionPdu(fc, 2);
    }
    const store = data[table];
    if (fc <= 2) {
      const bytes = Buffer.alloc(Math.ceil(quantity / 8));
      for (let i = 0; i < quantity; i++) if (store.get(address + i)) bytes[i >> 3] |= 1 << (i & 7);
      return Buffer.concat([Buffer.from([fc, bytes.length]), bytes]);
    }
    const bytes = Buffer.alloc(quantity * 2);
    for (let i = 0; i < quantity; i++) bytes.writeUInt16BE((store.get(address + i) || 0) & 0xffff, i * 2);
    return Buffer.concat([Buffer.from([fc, bytes.length]), bytes]);
  }

  function writePdu(data, fc, pdu) {
    const address = pdu.readUInt16BE(1);
    if (fc === 5) {
      data.coil.set(address, pdu.readUInt16BE(3) === 0xff00 ? 1 : 0);
      return pdu;
    }
    if (fc === 6) {
      data.holding.set(address, pdu.readUInt16BE(3));
      return pdu;
    }
    const qty = pdu.readUInt16BE(3);
    if (fc === 15) {
      for (let i = 0; i < qty; i++) data.coil.set(address + i, (pdu[6 + (i >> 3)] >> (i & 7)) & 1);
    } else {
      for (let i = 0; i < qty; i++) data.holding.set(address + i, pdu.readUInt16BE(6 + i * 2));
    }
    return pdu.subarray(0, 5);
  }

  function buildPdu(unit, pdu, f) {
    const fc = pdu[0];
    const data = unitData.get(unit);
    if (!data) return exceptionPdu(fc, 0x0b);
    if (f.exception && (f.exception.fc === undefined || f.exception.fc === fc)) {
      return exceptionPdu(fc, f.exception.code);
    }
    if (fc >= 1 && fc <= 4 && pdu.length === 5) {
      return readPdu(data, fc, pdu.readUInt16BE(1), pdu.readUInt16BE(3));
    }
    if ([5, 6, 15, 16].includes(fc) && pdu.length >= 5) return writePdu(data, fc, pdu);
    return exceptionPdu(fc, 1);
  }

  function respond(sock, tid, unit, pdu, f) {
    if (sock.destroyed) return;
    if (f.dropConnection) {
      sock.resetAndDestroy();
      return;
    }
    const frame = mbap(f.wrongTid ? (tid + 1) & 0xffff : tid, f.echoUnitId ?? unit, buildPdu(unit, pdu, f));
    if (f.truncate) {
      const t = typeof f.truncate === 'object' ? f.truncate : {};
      sock.write(frame.subarray(0, Math.min(t.bytes ?? 9, frame.length - 1)));
      if (t.close !== false) sock.end();
      return;
    }
    sock.write(frame);
  }

  function handle(sock, tid, unit, pdu) {
    const fc = pdu[0];
    stats.requests++;
    stats.byFc[fc] = (stats.byFc[fc] || 0) + 1;
    if ([5, 6, 15, 16, 22, 23].includes(fc)) stats.writesReceived++;
    const f = effective(unit);
    if (f.blackhole) return;
    let delay = f.delayMs || 0;
    if (f.lateReply && (f.lateReply.count ?? 1) > 0) {
      delay = f.lateReply.delayMs;
      f.lateReply.count = (f.lateReply.count ?? 1) - 1;
    }
    if (delay > 0) later(delay, () => respond(sock, tid, unit, pdu, f));
    else respond(sock, tid, unit, pdu, f);
  }

  const server = net.createServer((sock) => {
    stats.connections++;
    sock.on('error', () => {});
    if (sim.faults.refuseConnections || (sim.faults.maxConnections !== undefined && sockets.size >= sim.faults.maxConnections)) {
      stats.refused++;
      sock.destroy();
      return;
    }
    sockets.add(sock);
    stats.openConnections = sockets.size;
    sock.on('close', () => {
      sockets.delete(sock);
      stats.openConnections = sockets.size;
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const total = 6 + buf.readUInt16BE(4);
        if (buf.length < total) break;
        handle(sock, buf.readUInt16BE(0), buf[6], Buffer.from(buf.subarray(7, total)));
        buf = buf.subarray(total);
      }
    });
  });
  server.on('error', () => {});

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, host, () => {
        server.removeListener('error', reject);
        listenPort = server.address().port;
        resolve();
      });
    });
  await listen();

  const store = (unit, table) => {
    const u = unitData.get(unit);
    if (!u) throw new Error(`unit ${unit} not configured`);
    return u[tableName(table)];
  };

  Object.assign(sim, {
    host,
    get port() {
      return listenPort;
    },
    /** Set one register (or coil/discrete bit) value. */
    setRegister(unit, table, offset, value) {
      store(unit, table).set(offset, value);
    },
    /** Write raw wire bytes (even length) into consecutive registers. */
    setBuffer(unit, table, offset, buf) {
      for (let i = 0; i < buf.length; i += 2) store(unit, table).set(offset + i / 2, buf.readUInt16BE(i));
    },
    setFloat32(unit, table, offset, value, orders) {
      const b = Buffer.alloc(4);
      b.writeFloatBE(value);
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    setFloat64(unit, table, offset, value, orders) {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(value);
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    setInt32(unit, table, offset, value, orders) {
      const b = Buffer.alloc(4);
      b.writeInt32BE(value);
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    setUInt32(unit, table, offset, value, orders) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(value);
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    setInt64(unit, table, offset, value, orders) {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(value));
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    setUInt64(unit, table, offset, value, orders) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(value));
      this.setBuffer(unit, table, offset, wireOrder(b, orders));
    },
    /** ASCII string padded with NULs to `registers` registers. */
    setString(unit, table, offset, text, registers) {
      const b = Buffer.alloc(registers * 2);
      b.write(text, 'latin1');
      this.setBuffer(unit, table, offset, b);
    },
    setUnitFault(unit, name, value) {
      unitFaults[unit] = { ...(unitFaults[unit] || {}), [name]: value };
    },
    clearFaults() {
      sim.faults = {};
      Object.keys(unitFaults).forEach((k) => delete unitFaults[k]);
    },
    /** Close the listener (new connections get ECONNREFUSED); existing sockets stay. */
    stopListening() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    startListening: listen,
    /** Destroy every open connection (a device power cycle). */
    dropAll() {
      sockets.forEach((s) => s.resetAndDestroy());
    },
    async close() {
      timers.forEach(clearTimeout);
      timers.clear();
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    },
  });
  return sim;
}

module.exports = { startSimulator, wireOrder };
