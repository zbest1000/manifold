'use strict';

const net = require('net');
const modbusFrame = require('../drivers/modbus/frame');
const s7Frame = require('../drivers/s7/frame');
const eipFrame = require('../drivers/eip/frame');
const { COMMAND, CPF } = require('../drivers/eip/cip');
const { parseIdentity } = require('../drivers/eip/client');

/**
 * Read-only identification probes for southbound devices, used by the
 * Discovery CIDR scan (opt-in). Every outgoing byte comes from the drivers'
 * own read-only frame encoders - no frame is built here:
 *
 * - Modbus TCP (502): `modbusFrame.encodeRequest` with FC 3 (Read Holding
 *   Registers), one register at address 0, unit 1. encodeRequest throws
 *   ModbusReadOnlyError for anything but FC 1-4, so this probe CANNOT emit a
 *   write. Any well-formed Modbus response - registers or an exception
 *   (illegal address, gateway path unavailable, ...) - proves a Modbus server.
 * - S7 (102): `s7Frame.encodeConnectRequest` - a COTP Connection Request
 *   (ISO 8073 CR TPDU) and nothing else: no S7 setup-communication, no S7 job.
 *   A COTP CC (or a DR from a PLC that refuses the TSAP) proves ISO-on-TCP.
 * - EtherNet/IP (44818): `eipFrame.encodeFrame({ command: LIST_IDENTITY })` -
 *   the encapsulation ListIdentity request, an identification request with no
 *   CIP service at all (encodeFrame's command allowlist would refuse anything
 *   outside the read-only set).
 *
 * Each probe opens one TCP connection, sends one request, reads one reply
 * (bounded size and time) and closes. Callers apply the egress guard first.
 */

const IDENTIFY_TIMEOUT_MS = 3000;
const MAX_REPLY_BYTES = 4096;

/** One request/one reply over TCP; resolves the parsed reply or null. */
function exchange(host, port, frame, parse, timeoutMs = IDENTIFY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    socket.once('error', () => done(null));
    socket.once('close', () => done(null));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REPLY_BYTES) return done(null);
      try {
        const r = parse(buf);
        if (r !== undefined) done(r);
      } catch {
        done(null);
      }
    });
    socket.connect(port, host, () => socket.write(frame));
  });
}

/** Modbus TCP: FC3 read of one holding register (read-only by encoder construction). */
function identifyModbus(host, port = 502, { unitId = 1, timeoutMs } = {}) {
  const frame = modbusFrame.encodeRequest({ tid: 0x4d46, unitId, fc: 3, address: 0, quantity: 1 });
  const parser = new modbusFrame.FrameParser();
  return exchange(
    host,
    port,
    frame,
    (chunk) => {
      const adus = parser.push(chunk);
      for (const adu of adus) {
        if (adu.tid !== 0x4d46) continue;
        const exception = (adu.fc & 0x80) !== 0;
        return {
          protocol: 'modbus-tcp',
          verified: true,
          identity: {
            unitId: adu.unitId,
            response: exception ? 'exception' : 'registers',
            ...(exception ? { exceptionCode: adu.data[0], exception: modbusFrame.EXCEPTION_NAMES?.[adu.data[0]] || null } : {})
          }
        };
      }
      return undefined;
    },
    timeoutMs
  ).then((r) => r || null);
}

/** S7: COTP Connection Request only (rack 0 / slot 1 TSAP; any COTP answer identifies ISO-on-TCP). */
function identifyS7(host, port = 102, { rack = 0, slot = 1, timeoutMs } = {}) {
  const frame = s7Frame.encodeConnectRequest({ remoteTsap: s7Frame.remoteTsapFor(rack, slot) });
  const parser = new s7Frame.TpktParser();
  return exchange(
    host,
    port,
    frame,
    (chunk) => {
      for (const msg of parser.push(chunk)) {
        if (msg.type === 'CC' || msg.type === 'DR' || msg.type === 'ER') {
          return {
            protocol: 's7',
            verified: true,
            identity: {
              cotp: msg.type,
              accepted: msg.type === 'CC',
              rack,
              slot,
              ...(msg.params?.tpduSize ? { tpduSize: msg.params.tpduSize } : {})
            }
          };
        }
      }
      return undefined;
    },
    timeoutMs
  ).then((r) => r || null);
}

/** Parse a ListIdentity reply body into the CIP identity, or null when it carries none. */
function parseListIdentity(body) {
  if (body.length < 2) return null;
  const count = body.readUInt16LE(0);
  let o = 2;
  for (let n = 0; n < count && o + 4 <= body.length; n++) {
    const type = body.readUInt16LE(o);
    const len = body.readUInt16LE(o + 2);
    const data = body.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    // Item: encapsulation version (2) + socket address (16) + identity.
    if (type === CPF.LIST_IDENTITY && data.length > 18) return parseIdentity(data.subarray(18));
  }
  return null;
}

/** EtherNet/IP: encapsulation ListIdentity (identification request, no CIP service). */
function identifyEip(host, port = 44818, { timeoutMs } = {}) {
  const frame = eipFrame.encodeFrame({ command: COMMAND.LIST_IDENTITY });
  const parser = new eipFrame.FrameParser();
  return exchange(
    host,
    port,
    frame,
    (chunk) => {
      for (const pkt of parser.push(chunk)) {
        if (pkt.command !== COMMAND.LIST_IDENTITY) continue;
        const id = parseListIdentity(pkt.body);
        return { protocol: 'ethernet-ip', verified: true, identity: id || {} };
      }
      return undefined;
    },
    timeoutMs
  ).then((r) => r || null);
}

module.exports = { identifyModbus, identifyS7, identifyEip, parseListIdentity };
