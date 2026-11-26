'use strict';

const net = require('net');
const modbusFrame = require('../drivers/modbus/frame');
const s7Frame = require('../drivers/s7/frame');
const s7Driver = require('../drivers/s7');
const eipFrame = require('../drivers/eip/frame');
const { COMMAND, CPF } = require('../drivers/eip/cip');
const { parseIdentity } = require('../drivers/eip/client');
const bacnetFrame = require('../drivers/bacnet/frame');
const { BacnetClient } = require('../drivers/bacnet/client');
const { WILDCARD_INSTANCE } = require('../drivers/bacnet/encoding');
const { SEGMENTATION } = require('../drivers/bacnet/enums');
const { CoapUdpSocket } = require('../drivers/coap/coapUdp');
const { CoapClient } = require('../drivers/coap/client');
const coapLinks = require('../drivers/coap/linkformat');
const coapMsg = require('../drivers/coap/message');

/**
 * Read-only identification probes for the Discovery CIDR scan. A probe opens one
 * TCP connection (S7 may open a second, see below), sends identification requests
 * only, reads bounded replies and closes. Callers apply the egress guard first.
 *
 *  - Modbus TCP: FC 43 / MEI 14 "Read Device Identification" (basic category, object 0
 *    onward) first - it names vendor, product code and revision. Many devices answer
 *    it with exception 1 (illegal function) or ignore it, so the same connection then
 *    sends FC 3 (read ONE holding register at 0, unit 1) through the driver's own
 *    read-only encoder. Any well-formed Modbus reply proves a Modbus server;
 *    `method` records which request answered (`fc43-device-id` | `fc3-register-read`).
 *    FC 43 is built here from a fixed constant frame (function 0x2B, MEI 0x0E, read
 *    code 1, object 0) rather than added to the driver's allowlist: the driver's
 *    `encodeRequest` stays limited to FC 1-4, so nothing here widens what the driver can
 *    ever send. Writes cannot be expressed by either path.
 *  - S7: COTP Connection Request (the driver's `encodeConnectRequest`). When the CPU
 *    accepts (CC) the S7 driver is reused once for its read-only SZL identity read
 *    (setup-communication + read-SZL userdata; cpu type, order code, firmware, serial).
 *    That second connection is made after the first closed, never concurrently, and
 *    only for hosts that answered COTP. `deep: false` keeps COTP only.
 *  - EtherNet/IP: encapsulation ListIdentity (no CIP service): vendor, device type,
 *    product code, revision, serial, product name, state.
 *  - BACnet/IP (UDP, opt-in): one UNICAST Who-Is to the address and, at the same time, a
 *    ReadProperty of the wildcard device instance 4194303 (many devices answer Who-Is only with a
 *    broadcast I-Am, which a probe socket on an ephemeral port never receives). Either answer
 *    identifies the device; its device object is then read (object-name, vendor-name, model-name,
 *    vendor-identifier, firmware-revision) with ReadPropertyMultiple, or ReadProperty when RPM is
 *    rejected. Frames come from the BACnet driver's read-only encoder; nothing is broadcast.
 *  - CoAP (UDP, opt-in): ONE unicast confirmable GET /.well-known/core to the address, with a single
 *    retransmission. Any well-formed CoAP response proves a CoAP server (even 4.04: not every device
 *    publishes a listing); a 2.05 link-format body adds the resource count and the first few paths.
 *    No multicast, no broadcast, nothing but that GET. The UDP socket goes through the same egress
 *    policy as every device target.
 *  - OPC UA: the UA-TCP Hello message (connection level, before any secure channel or
 *    session); an Acknowledge or Error reply identifies an OPC UA server.
 *
 * Every socket is destroyed on completion, timeout or abort.
 */

const IDENTIFY_TIMEOUT_MS = 3000;
const MAX_REPLY_BYTES = 4096;
const MODBUS_TID = 0x4d46;
const MODBUS_FC43_WAIT_MS = 1200;

/** Resolves null when `signal` is already aborted. */
const aborted = (signal) => Boolean(signal && signal.aborted);

/**
 * One TCP session: connect, then any number of request/reply exchanges, all inside
 * one overall deadline. `request()` resolves the parsed reply, or null on timeout,
 * close, error, abort or an oversize reply. The socket is always destroyed by close().
 */
function openSession(host, port, { timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    if (aborted(signal)) return resolve(null);
    const socket = new net.Socket();
    let buf = Buffer.alloc(0);
    let pending = null; // { parse, resolve, timer }
    let closed = false;
    const deadline = Date.now() + timeoutMs;

    const settlePending = (value) => {
      if (!pending) return;
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(value);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(overall);
      signal?.removeEventListener?.('abort', close);
      socket.destroy();
      settlePending(null);
      resolve(null); // no-op once connected
    };
    const overall = setTimeout(close, timeoutMs);
    overall.unref?.();
    signal?.addEventListener?.('abort', close, { once: true });

    const session = {
      close,
      /** Send `frame`, wait up to `waitMs` (capped by the session deadline) for `parse(buf)` to return non-undefined. */
      request(frame, parse, waitMs = timeoutMs) {
        return new Promise((res) => {
          if (closed) return res(null);
          buf = Buffer.alloc(0);
          const remaining = Math.max(1, deadline - Date.now());
          const timer = setTimeout(() => settlePending(null), Math.min(waitMs, remaining));
          timer.unref?.();
          pending = { parse, resolve: res, timer };
          socket.write(frame);
        });
      }
    };

    socket.once('error', close);
    socket.once('close', close);
    socket.on('data', (chunk) => {
      if (!pending) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REPLY_BYTES) return settlePending(null);
      try {
        const r = pending.parse(buf);
        if (r !== undefined) settlePending(r);
      } catch {
        settlePending(null);
      }
    });
    socket.connect(port, host, () => resolve(session));
  });
}

/** One request, one reply, then close. */
async function exchange(host, port, frame, parse, { timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  const session = await openSession(host, port, { timeoutMs, signal });
  if (!session) return null;
  try {
    return await session.request(frame, parse, timeoutMs);
  } finally {
    session.close();
  }
}

// ---- Modbus TCP ------------------------------------------------------------------------

const FC43_OBJECTS = { 0: 'vendorName', 1: 'productCode', 2: 'revision', 3: 'vendorUrl', 4: 'productName', 5: 'modelName', 6: 'applicationName' };

/** FC 43 / MEI 14 Read Device Identification request, basic category, starting at object 0. A constant frame. */
function encodeReadDeviceId({ tid = MODBUS_TID, unitId = 1 } = {}) {
  const buf = Buffer.alloc(11);
  buf.writeUInt16BE(tid, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(5, 4);
  buf.writeUInt8(unitId, 6);
  buf.writeUInt8(0x2b, 7); // function: encapsulated interface transport
  buf.writeUInt8(0x0e, 8); // MEI type: read device identification
  buf.writeUInt8(0x01, 9); // read device id code: basic stream
  buf.writeUInt8(0x00, 10); // object id: start at VendorName
  return buf;
}

/** Parse the data bytes (after the function code) of an FC 43/14 response into named objects, or null. */
function parseReadDeviceId(data) {
  if (data.length < 6 || data[0] !== 0x0e) return null;
  const count = data[5];
  const out = {};
  let o = 6;
  for (let i = 0; i < count && o + 2 <= data.length; i++) {
    const id = data[o];
    const len = data[o + 1];
    if (o + 2 + len > data.length) break;
    const text = data.toString('latin1', o + 2, o + 2 + len).replace(/\0+$/g, '').trim();
    out[FC43_OBJECTS[id] || `object${id}`] = text;
    o += 2 + len;
  }
  return Object.keys(out).length ? out : null;
}

/** Modbus TCP identification (see the module comment for the exact requests). */
async function identifyModbus(host, port = 502, { unitId = 1, timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  const session = await openSession(host, port, { timeoutMs, signal });
  if (!session) return null;
  try {
    const parser = new modbusFrame.FrameParser();
    const match = (tid) => (chunk) => {
      for (const adu of parser.push(chunk)) if (adu.tid === tid) return adu;
      return undefined;
    };

    // 1. Device identification (cheap, informative). Exception or silence falls through.
    const idAdu = await session.request(encodeReadDeviceId({ tid: MODBUS_TID, unitId }), match(MODBUS_TID), MODBUS_FC43_WAIT_MS);
    if (idAdu && idAdu.fc === 0x2b) {
      const objects = parseReadDeviceId(idAdu.data);
      if (objects) {
        return { protocol: 'modbus-tcp', verified: true, method: 'fc43-device-id', identity: { unitId: idAdu.unitId, response: 'device-id', ...objects } };
      }
    }
    const idException = idAdu && (idAdu.fc & 0x80) !== 0 ? idAdu.data[0] : null;

    // 2. A single holding-register read, built by the driver's read-only encoder.
    const tid = MODBUS_TID + 1;
    const frame = modbusFrame.encodeRequest({ tid, unitId, fc: 3, address: 0, quantity: 1 });
    const adu = await session.request(frame, match(tid));
    if (!adu) {
      // The device answered FC 43 with something Modbus-shaped but ignored FC 3: still a Modbus server.
      return idAdu
        ? { protocol: 'modbus-tcp', verified: true, method: 'fc43-device-id', identity: { unitId: idAdu.unitId, response: 'exception', exceptionCode: idException, exception: modbusFrame.EXCEPTION_NAMES[idException] || null } }
        : null;
    }
    const exception = (adu.fc & 0x80) !== 0;
    return {
      protocol: 'modbus-tcp',
      verified: true,
      method: 'fc3-register-read',
      identity: {
        unitId: adu.unitId,
        response: exception ? 'exception' : 'registers',
        ...(exception ? { exceptionCode: adu.data[0], exception: modbusFrame.EXCEPTION_NAMES[adu.data[0]] || null } : {})
      }
    };
  } finally {
    session.close();
  }
}

// ---- Siemens S7 ------------------------------------------------------------------------

/**
 * S7: COTP Connection Request, then (when accepted and `deep`) the S7 driver's own
 * read-only identity read. Rack 0 / slot 1 (S7-1200/1500); 0/2 for S7-300/400 is
 * tried when slot 1 is refused with a COTP Disconnect Request.
 */
async function identifyS7(host, port = 102, { rack = 0, slot = 1, timeoutMs = IDENTIFY_TIMEOUT_MS, signal, deep = true } = {}) {
  const cotp = async (r, s) => {
    const frame = s7Frame.encodeConnectRequest({ remoteTsap: s7Frame.remoteTsapFor(r, s) });
    const parser = new s7Frame.TpktParser();
    return exchange(
      host,
      port,
      frame,
      (chunk) => {
        for (const msg of parser.push(chunk)) {
          if (msg.type === 'CC' || msg.type === 'DR' || msg.type === 'ER') {
            return { type: msg.type, tpduSize: msg.params?.tpduSize };
          }
        }
        return undefined;
      },
      { timeoutMs, signal }
    );
  };

  let useSlot = slot;
  let reply = await cotp(rack, useSlot);
  if (reply && reply.type !== 'CC' && slot === 1 && !aborted(signal)) {
    // Slot 1 refused: an S7-300/400 answers on slot 2. Take the first that accepts, else keep slot 1's answer.
    const alt = await cotp(rack, 2);
    if (alt && alt.type === 'CC') {
      reply = alt;
      useSlot = 2;
    }
  }
  if (!reply) return null;

  const identity = {
    cotp: reply.type,
    accepted: reply.type === 'CC',
    rack,
    slot: useSlot,
    ...(reply.tpduSize ? { tpduSize: reply.tpduSize } : {})
  };
  let method = 'cotp-connect';

  if (reply.type === 'CC' && deep && !aborted(signal)) {
    let driver = null;
    try {
      driver = s7Driver.createDriver({ host, port, rack, slot: useSlot, limits: { connectTimeoutMs: timeoutMs, requestDeadlineMs: Math.min(2000, timeoutMs) } });
      const onAbort = () => driver.close().catch(() => {});
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const info = await Promise.race([
        driver.connect(),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs * 2);
          t.unref?.();
        })
      ]);
      signal?.removeEventListener?.('abort', onAbort);
      if (info && info.identity) {
        Object.assign(identity, info.identity);
        method = 'cotp-connect+szl';
      } else if (info) {
        identity.szl = 'not answered';
      }
    } catch (error) {
      identity.szl = `not read: ${error.message}`.slice(0, 120);
    } finally {
      if (driver) await driver.close().catch(() => {});
    }
  }
  return { protocol: 's7', verified: true, method, identity };
}

// ---- EtherNet/IP -----------------------------------------------------------------------

// Only entries known with certainty; anything else is shown as the numeric id.
const CIP_VENDORS = { 1: 'Rockwell Automation / Allen-Bradley', 26: 'Festo', 40: 'WAGO', 47: 'Omron' };
const CIP_DEVICE_TYPES = {
  0x00: 'Generic Device',
  0x02: 'AC Drive',
  0x07: 'General Purpose Discrete I/O',
  0x0c: 'Communications Adapter',
  0x0e: 'Programmable Logic Controller',
  0x2b: 'Generic Device (keyable)'
};
const CIP_STATES = { 0: 'nonexistent', 1: 'device self testing', 2: 'standby', 3: 'operational', 4: 'major recoverable fault', 5: 'major unrecoverable fault', 255: 'default for Get_Attributes_All' };

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
    // Item: encapsulation version (2) + socket address (16) + identity (+ state byte).
    if (type === CPF.LIST_IDENTITY && data.length > 18) {
      const raw = data.subarray(18);
      const id = parseIdentity(raw);
      if (!id) return null;
      const stateAt = 15 + (raw[14] || 0);
      const state = raw.length > stateAt ? raw[stateAt] : undefined;
      return {
        ...id,
        ...(CIP_VENDORS[id.vendorId] ? { vendor: CIP_VENDORS[id.vendorId] } : {}),
        deviceTypeName: CIP_DEVICE_TYPES[id.deviceType] || null,
        ...(state !== undefined ? { state, stateName: CIP_STATES[state] || null } : {})
      };
    }
  }
  return null;
}

/** EtherNet/IP: encapsulation ListIdentity (identification request, no CIP service). */
async function identifyEip(host, port = 44818, { timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  const frame = eipFrame.encodeFrame({ command: COMMAND.LIST_IDENTITY });
  const parser = new eipFrame.FrameParser();
  const r = await exchange(
    host,
    port,
    frame,
    (chunk) => {
      for (const pkt of parser.push(chunk)) {
        if (pkt.command !== COMMAND.LIST_IDENTITY) continue;
        const id = parseListIdentity(pkt.body);
        return { protocol: 'ethernet-ip', verified: true, method: 'list-identity', identity: id || {} };
      }
      return undefined;
    },
    { timeoutMs, signal }
  );
  return r || null;
}

// ---- CoAP ------------------------------------------------------------------------------

/** CoAP: one GET /.well-known/core. Resolves null when nothing answers like CoAP. */
async function identifyCoap(host, port = 5683, { timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  if (signal && signal.aborted) return null;
  const socket = new CoapUdpSocket({ address: host, port });
  let client = null;
  let onAbort = null;
  try {
    await socket.open();
    const ack = Math.max(150, Math.floor(timeoutMs / 4));
    client = new CoapClient({ socket, ackTimeoutMs: ack, ackRandomFactor: 1, maxRetransmit: 1, blockSize: 256, maxResponseBytes: 65536, closeGraceMs: 0 });
    const aborted = new Promise((resolve) => {
      onAbort = () => resolve(null);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
    // One exchange: a single GET, no Block2 follow-up. A long listing is read from its first datagram only.
    const r = await Promise.race([client.exchange({ path: ['.well-known', 'core'], query: [], accept: 40 }, Date.now() + timeoutMs), aborted]);
    if (!r || !r.ok || !r.msg) return null;
    const m = r.msg;
    const identity = { code: coapMsg.codeLabel(m.code) };
    if (coapMsg.codeClass(m.code) === 2 && [40, undefined].includes(coapMsg.optionUint(m, coapMsg.OPT.CONTENT_FORMAT))) {
      const { links } = coapLinks.parse(m.payload.toString('utf8'));
      const resources = links.filter((l) => l.path !== '/.well-known/core');
      identity.resourceCount = resources.length;
      identity.observableCount = resources.filter((l) => l.obs).length;
      identity.resources = resources.slice(0, 8).map((l) => l.path);
      if (coapMsg.option(m, coapMsg.OPT.BLOCK2)) identity.partial = true; // the listing continues in further blocks that a scan does not fetch
    } else {
      identity.note = 'Answered, but without a resource listing.';
    }
    return { protocol: 'coap', verified: true, method: 'well-known-core', identity };
  } catch {
    return null; // refused by the egress policy, unreachable, or not an address
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (client) await client.close().catch(() => {});
    else await socket.close().catch(() => {});
  }
}

// ---- OPC UA ----------------------------------------------------------------------------

function encodeOpcuaHello(endpointUrl) {
  const url = Buffer.from(endpointUrl, 'utf8');
  const buf = Buffer.alloc(32 + url.length);
  buf.write('HELF', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 4);
  buf.writeUInt32LE(0, 8); // protocol version
  buf.writeUInt32LE(65536, 12); // receive buffer
  buf.writeUInt32LE(65536, 16); // send buffer
  buf.writeUInt32LE(0, 20); // max message size (no limit)
  buf.writeUInt32LE(0, 24); // max chunk count (no limit)
  buf.writeInt32LE(url.length, 28);
  url.copy(buf, 32);
  return buf;
}

/** OPC UA binary Hello; an ACK or ERR message proves a UA-TCP server. Nothing beyond the handshake is sent. */
async function identifyOpcua(host, port = 4840, { timeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  const endpointUrl = `opc.tcp://${host}:${port}`;
  const r = await exchange(
    host,
    port,
    encodeOpcuaHello(endpointUrl),
    (buf) => {
      if (buf.length < 8) return undefined;
      const kind = buf.toString('latin1', 0, 3);
      const chunkType = buf.toString('latin1', 3, 4);
      const size = buf.readUInt32LE(4);
      if ((kind !== 'ACK' && kind !== 'ERR') || chunkType !== 'F' || size < 8 || size > MAX_REPLY_BYTES) throw new Error('not UA-TCP');
      if (buf.length < size) return undefined;
      if (kind === 'ACK') {
        return { accepted: true, protocolVersion: buf.readUInt32LE(8), receiveBufferSize: buf.readUInt32LE(12), sendBufferSize: buf.readUInt32LE(16) };
      }
      return { accepted: false, errorCode: `0x${buf.readUInt32LE(8).toString(16).padStart(8, '0')}` };
    },
    { timeoutMs, signal }
  );
  if (!r) return null;
  return { protocol: 'opcua', verified: true, method: 'ua-hello', identity: { ...r, endpointUrl } };
}

// ---- BACnet/IP -------------------------------------------------------------------------

const BACNET_PROPS = { objectName: 77, vendorName: 121, modelName: 70, vendorId: 120, firmwareRevision: 44 };

function firstApp(values) {
  return values && values.length === 1 && values[0].tag ? values[0] : null;
}

/**
 * BACnet/IP identification (see the module comment). `timeoutMs` bounds the wait for the first
 * answer (the Discovery connect timeout), `identifyTimeoutMs` the device-object read after it.
 * @returns {Promise<object|null>} { protocol:'bacnet-ip', verified, method, identity } or null
 */
async function identifyBacnet(host, port = 47808, { timeoutMs = 1200, identifyTimeoutMs = IDENTIFY_TIMEOUT_MS, signal } = {}) {
  if (aborted(signal) || !net.isIP(host)) return null;
  const client = new BacnetClient({ host, port, maxOutstanding: 2 });
  const onAbort = () => client.close();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    await client.open();
    const rp = (ref, deadlineMs) =>
      client.request((id) => bacnetFrame.readPropertyPacket(id, ref), { service: bacnetFrame.SERVICE.READ_PROPERTY, apduTimeoutMs: deadlineMs, retries: 0, deadlineMs, label: 'identify' });
    const [iam, wild] = await Promise.all([client.whoIs({ waitMs: timeoutMs }), rp({ objectType: 8, instance: WILDCARD_INSTANCE, property: 75 }, timeoutMs)]);
    if (aborted(signal)) return null;
    let instance = iam ? iam.instance : null;
    let method = iam ? 'who-is' : null;
    if (instance === null && wild.ok) {
      try {
        const v = firstApp(bacnetFrame.parseReadPropertyAck(wild.apdu.body).values);
        if (v && v.tag === 'object-identifier') {
          instance = v.value.instance;
          method = 'read-property';
        }
      } catch {
        /* not a usable answer */
      }
    }
    if (instance === null) {
      // A BACnet Error/Reject/Abort still proves a BACnet device is listening.
      if (!wild.ok && ['error', 'reject', 'abort'].includes(wild.kind)) return { protocol: 'bacnet-ip', verified: true, method: 'read-property', identity: { answered: wild.kind } };
      return null;
    }
    const identity = { deviceInstance: instance };
    if (iam) Object.assign(identity, { vendorId: iam.vendorId, maxApdu: iam.maxApdu, segmentation: SEGMENTATION[iam.segmentation] || iam.segmentation });
    const deadlineMs = identifyTimeoutMs;
    const refs = Object.values(BACNET_PROPS).map((property) => ({ property }));
    const store = (property, values) => {
      const v = firstApp(values);
      if (!v) return;
      const name = Object.keys(BACNET_PROPS).find((k) => BACNET_PROPS[k] === property);
      if (name === 'vendorId') identity.vendorId ??= Number(v.value);
      else if (v.tag === 'character-string') identity[name] = String(v.value).slice(0, 128);
    };
    const multi = await client.request((id) => bacnetFrame.readPropertyMultiplePacket(id, [{ objectType: 8, instance, refs }]), { service: bacnetFrame.SERVICE.READ_PROPERTY_MULTIPLE, apduTimeoutMs: deadlineMs, retries: 0, deadlineMs, label: 'identify' });
    if (multi.ok) {
      try {
        for (const a of bacnetFrame.parseReadPropertyMultipleAck(multi.apdu.body)) for (const r of a.results) if (!r.error) store(r.property, r.values);
      } catch {
        /* identity stays partial */
      }
    } else if (!aborted(signal) && multi.kind !== 'timeout' && multi.kind !== 'transport') {
      const until = Date.now() + deadlineMs;
      for (const property of [BACNET_PROPS.modelName, BACNET_PROPS.vendorName, BACNET_PROPS.objectName]) {
        const left = until - Date.now();
        if (left <= 0 || aborted(signal)) break;
        const r = await rp({ objectType: 8, instance, property }, left);
        if (!r.ok) continue;
        try {
          store(property, bacnetFrame.parseReadPropertyAck(r.apdu.body).values);
        } catch {
          /* skip */
        }
      }
    }
    return { protocol: 'bacnet-ip', verified: true, method, identity };
  } catch {
    return null;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    client.close();
  }
}

module.exports = {
  identifyModbus,
  identifyBacnet,
  identifyS7,
  identifyEip,
  identifyCoap,
  identifyOpcua,
  parseListIdentity,
  encodeReadDeviceId,
  parseReadDeviceId,
  encodeOpcuaHello,
  IDENTIFY_TIMEOUT_MS
};
