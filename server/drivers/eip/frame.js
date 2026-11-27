'use strict';

/**
 * EtherNet/IP encapsulation + CIP request encoding, read-only by construction.
 *
 * `encodeFrame` is the ONLY function in this driver that produces outgoing
 * bytes. It takes structured requests (never pre-built CIP bytes), runs every
 * CIP service — including each service inside a Multiple Service Packet and
 * the message embedded in an Unconnected Send — through `assertCipAllowed`,
 * and throws `EipReadOnlyError` before any byte exists for anything outside
 * the allowlist (docs/design/driver-contract.md, read-only by construction). The transport
 * additionally re-parses every buffer it is asked to write with
 * `inspectOutgoingFrame` (defence in depth: a byte-level allowlist check).
 *
 * Wire formats (ODVA Vol. 2 ch. 2 encapsulation and CPF; Vol. 1 3-5.5 Forward
 * Open; 1756-PM020 Logix services) — see cip.js for the reference list.
 */

const cip = require('./cip');

const { SERVICE, CLASS, COMMAND, CPF } = cip;

const HEADER_SIZE = 24;
const MAX_ENCAP_LENGTH = 16384; // far above Large Forward Open (4002) + overhead

class EipReadOnlyError extends Error {
  constructor(what, detail) {
    super(`${what} is refused: this EtherNet/IP driver is read-only${detail ? ` (${detail})` : ''}`);
    this.name = 'EipReadOnlyError';
  }
}

/** Unrecoverable framing violation: the caller must destroy the socket. */
class EipFramingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EipFramingError';
  }
}

const ALLOWED_COMMANDS = new Set([
  COMMAND.LIST_IDENTITY,
  COMMAND.REGISTER_SESSION,
  COMMAND.UNREGISTER_SESSION,
  COMMAND.SEND_RR_DATA,
  COMMAND.SEND_UNIT_DATA,
]);

const GET_SERVICES = new Set([SERVICE.GET_ATTRIBUTE_ALL, SERVICE.GET_ATTRIBUTE_LIST, SERVICE.GET_ATTRIBUTE_SINGLE]);

function hex2(n) {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/**
 * The CIP service allowlist. Service codes are object-specific, so the
 * decision is keyed on (service, target class): 0x4E is Forward Close on the
 * Connection Manager but Read-Modify-Write on a tag; 0x52 is Unconnected Send
 * on the Connection Manager but Read Tag Fragmented on a tag.
 *
 * @param {{service:number, path:Buffer, embedded?:object, services?:object[]}} req
 * @param {{nested?:boolean}} [ctx]
 * @throws {EipReadOnlyError}
 */
function assertCipAllowed(req, ctx = {}) {
  if (!req || typeof req !== 'object') throw new EipReadOnlyError('CIP request', 'not a request object');
  const { service } = req;
  if (!Number.isInteger(service) || service < 0 || service > 0x7f) {
    throw new EipReadOnlyError(`CIP service ${service}`, 'invalid service code');
  }
  if (!Buffer.isBuffer(req.path)) throw new EipReadOnlyError(`CIP service ${hex2(service)}`, 'path must be a Buffer');
  let p;
  try {
    p = cip.describePath(req.path);
  } catch (err) {
    throw new EipReadOnlyError(`CIP service ${hex2(service)}`, `unparseable path: ${err.message}`);
  }
  const cls = p.classes.length ? p.classes[p.classes.length - 1] : null;
  const refuse = (detail) => {
    throw new EipReadOnlyError(`CIP service ${hex2(service)}${cls !== null ? ` on class ${hex2(cls)}` : ''}`, detail);
  };
  const tagTarget = (p.symbolic && cls === null) || cls === CLASS.SYMBOL;

  switch (service) {
    case SERVICE.READ_TAG: // Read Tag, or Read Template on class 0x6C
      if (tagTarget || cls === CLASS.TEMPLATE) return;
      return refuse('Read Tag needs a symbolic/Symbol path; Read Template needs class 0x6C');
    case SERVICE.READ_TAG_FRAGMENTED: // == UNCONNECTED_SEND on the Connection Manager
      if (cls === CLASS.CONNECTION_MANAGER) {
        if (ctx.nested) return refuse('nested Unconnected Send');
        if (!req.embedded) return refuse('Unconnected Send without a structured embedded request');
        return assertCipAllowed(req.embedded, { nested: true });
      }
      if (tagTarget) return;
      return refuse('Read Tag Fragmented needs a symbolic/Symbol path');
    case SERVICE.READ_MODIFY_WRITE: // == FORWARD_CLOSE on the Connection Manager
      if (cls === CLASS.CONNECTION_MANAGER && !p.symbolic) return;
      return refuse('Read-Modify-Write Tag');
    case SERVICE.FORWARD_OPEN:
    case SERVICE.LARGE_FORWARD_OPEN:
      if (cls === CLASS.CONNECTION_MANAGER && !p.symbolic && !ctx.nested) return;
      return refuse('Forward Open is only allowed on the Connection Manager');
    case SERVICE.GET_INSTANCE_ATTRIBUTE_LIST:
      if (cls === CLASS.SYMBOL) return;
      return refuse('Get Instance Attribute List is only allowed on the Symbol class 0x6B');
    case SERVICE.MULTIPLE_SERVICE_PACKET: {
      if (cls !== CLASS.MESSAGE_ROUTER || p.symbolic) return refuse('Multiple Service Packet must target the Message Router');
      if (!Array.isArray(req.services) || req.services.length === 0) {
        return refuse('Multiple Service Packet without structured inner services');
      }
      for (const inner of req.services) {
        if (inner.service === SERVICE.MULTIPLE_SERVICE_PACKET) refuse('nested Multiple Service Packet');
        if (inner.embedded) refuse('Unconnected Send inside Multiple Service Packet');
        assertCipAllowed(inner, { nested: true });
      }
      return;
    }
    default:
      if (GET_SERVICES.has(service) && cls !== null && !p.symbolic) return;
      return refuse(SERVICE_NAMES[service] || 'service not on the read-only allowlist');
  }
}

const SERVICE_NAMES = {
  0x02: 'Set_Attribute_All',
  0x04: 'Set_Attribute_List',
  0x05: 'Reset',
  0x06: 'Start',
  0x07: 'Stop',
  0x08: 'Create',
  0x09: 'Delete',
  0x10: 'Set_Attribute_Single',
  0x4d: 'Write Tag',
  0x53: 'Write Tag Fragmented',
};

/** Raw CIP request bytes for an ALREADY CHECKED request. Private. */
function cipBytes(req) {
  if (req.path.length % 2) throw new Error('EPATH must be an even number of bytes');
  let data;
  if (req.service === SERVICE.MULTIPLE_SERVICE_PACKET) {
    const parts = req.services.map(cipBytes);
    const head = Buffer.alloc(2 + 2 * parts.length);
    head.writeUInt16LE(parts.length, 0);
    let off = head.length;
    parts.forEach((b, i) => {
      head.writeUInt16LE(off, 2 + 2 * i);
      off += b.length;
    });
    data = Buffer.concat([head, ...parts]);
  } else if (req.embedded) {
    // Unconnected Send (ODVA Vol. 1 3-5.5.2): priority/tick, timeout ticks,
    // message size, message, pad, route path size (words), reserved, route path.
    const msg = cipBytes(req.embedded);
    const route = req.route || Buffer.alloc(0);
    const h = Buffer.alloc(4);
    h[0] = req.priorityTick ?? 0x0a;
    h[1] = req.timeoutTicks ?? 0x0e;
    h.writeUInt16LE(msg.length, 2);
    const pad = msg.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    data = Buffer.concat([h, msg, pad, Buffer.from([route.length / 2, 0]), route]);
  } else {
    data = req.data || Buffer.alloc(0);
  }
  return Buffer.concat([Buffer.from([req.service, req.path.length / 2]), req.path, data]);
}

/**
 * Encode a CIP request after the allowlist check.
 * @throws {EipReadOnlyError}
 */
function encodeCip(req) {
  assertCipAllowed(req);
  return cipBytes(req);
}

function header(command, length, session, context) {
  const h = Buffer.alloc(HEADER_SIZE);
  h.writeUInt16LE(command, 0);
  h.writeUInt16LE(length, 2);
  h.writeUInt32LE(session >>> 0, 4);
  h.writeUInt32LE(0, 8);
  if (context) context.copy(h, 12, 0, 8);
  h.writeUInt32LE(0, 20);
  return h;
}

/**
 * THE outgoing-frame choke point.
 *
 * @param {{command:number, session?:number, context?:Buffer, cip?:object,
 *   connectionId?:number, sequence?:number, timeout?:number}} spec
 * @returns {Buffer}
 * @throws {EipReadOnlyError} for a command or CIP service outside the allowlist
 */
function encodeFrame(spec) {
  if (!spec || !ALLOWED_COMMANDS.has(spec.command)) {
    throw new EipReadOnlyError(`encapsulation command ${spec && spec.command}`, 'not on the allowlist');
  }
  const session = spec.session || 0;
  const ctx = spec.context || Buffer.alloc(8);
  switch (spec.command) {
    case COMMAND.LIST_IDENTITY:
      return header(COMMAND.LIST_IDENTITY, 0, 0, ctx);
    case COMMAND.REGISTER_SESSION: {
      const body = Buffer.from([1, 0, 0, 0]); // protocol version 1, options 0
      return Buffer.concat([header(COMMAND.REGISTER_SESSION, body.length, 0, ctx), body]);
    }
    case COMMAND.UNREGISTER_SESSION:
      return header(COMMAND.UNREGISTER_SESSION, 0, session, ctx);
    case COMMAND.SEND_RR_DATA: {
      const msg = encodeCip(spec.cip);
      const body = Buffer.alloc(16);
      body.writeUInt32LE(0, 0); // interface handle: CIP
      body.writeUInt16LE(spec.timeout ?? 0, 4);
      body.writeUInt16LE(2, 6); // item count
      body.writeUInt16LE(CPF.NULL_ADDRESS, 8);
      body.writeUInt16LE(0, 10);
      body.writeUInt16LE(CPF.UNCONNECTED_DATA, 12);
      body.writeUInt16LE(msg.length, 14);
      const len = body.length + msg.length;
      return Buffer.concat([header(COMMAND.SEND_RR_DATA, len, session, ctx), body, msg]);
    }
    case COMMAND.SEND_UNIT_DATA: {
      const msg = encodeCip(spec.cip);
      const body = Buffer.alloc(22);
      body.writeUInt32LE(0, 0);
      body.writeUInt16LE(0, 4);
      body.writeUInt16LE(2, 6);
      body.writeUInt16LE(CPF.CONNECTED_ADDRESS, 8);
      body.writeUInt16LE(4, 10);
      body.writeUInt32LE(spec.connectionId >>> 0, 12);
      body.writeUInt16LE(CPF.CONNECTED_DATA, 16);
      body.writeUInt16LE(msg.length + 2, 18);
      body.writeUInt16LE(spec.sequence & 0xffff, 20);
      const len = body.length + msg.length;
      return Buffer.concat([header(COMMAND.SEND_UNIT_DATA, len, session, ctx), body, msg]);
    }
    default:
      throw new EipReadOnlyError(`encapsulation command ${spec.command}`);
  }
}

// ── parsing ────────────────────────────────────────────────────────────────

function parseHeader(buf) {
  return {
    command: buf.readUInt16LE(0),
    length: buf.readUInt16LE(2),
    session: buf.readUInt32LE(4),
    status: buf.readUInt32LE(8),
    context: Buffer.from(buf.subarray(12, 20)),
    options: buf.readUInt32LE(20),
    body: Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + buf.readUInt16LE(2))),
  };
}

/**
 * Streaming parser for encapsulation packets. Poisoned after a framing error:
 * every further push rethrows and the caller must drop the socket.
 */
class FrameParser {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._failure = null;
  }

  push(chunk) {
    if (this._failure) throw this._failure;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const out = [];
    while (this._buf.length >= HEADER_SIZE) {
      const length = this._buf.readUInt16LE(2);
      const command = this._buf.readUInt16LE(0);
      if (!ALLOWED_COMMANDS.has(command)) this._fail(`unexpected encapsulation command 0x${command.toString(16)}`);
      if (length > MAX_ENCAP_LENGTH) this._fail(`encapsulation length ${length} exceeds ${MAX_ENCAP_LENGTH}`);
      const total = HEADER_SIZE + length;
      if (this._buf.length < total) break;
      out.push(parseHeader(this._buf.subarray(0, total)));
      this._buf = this._buf.subarray(total);
    }
    return out;
  }

  _fail(message) {
    this._failure = new EipFramingError(message);
    throw this._failure;
  }
}

/**
 * Parse a Common Packet Format body (SendRRData / SendUnitData).
 * @returns {{items:{type:number, data:Buffer}[]}}
 * @throws {EipFramingError}
 */
function parseCpf(body) {
  if (body.length < 8) throw new EipFramingError(`CPF body too short (${body.length})`);
  const count = body.readUInt16LE(6);
  const items = [];
  let i = 8;
  for (let n = 0; n < count; n++) {
    if (i + 4 > body.length) throw new EipFramingError('truncated CPF item header');
    const type = body.readUInt16LE(i);
    const len = body.readUInt16LE(i + 2);
    if (i + 4 + len > body.length) throw new EipFramingError('truncated CPF item');
    items.push({ type, data: Buffer.from(body.subarray(i + 4, i + 4 + len)) });
    i += 4 + len;
  }
  if (i !== body.length) throw new EipFramingError(`CPF has ${body.length - i} trailing bytes`);
  return { items };
}

/**
 * Parse a CIP reply (Message Router response format, ODVA Vol. 1 2-4.2).
 * @returns {{service:number, status:number, ext:number[], data:Buffer}}
 * @throws {EipFramingError}
 */
function parseCipReply(buf) {
  if (buf.length < 4) throw new EipFramingError(`CIP reply too short (${buf.length})`);
  const service = buf[0];
  if (!(service & 0x80)) throw new EipFramingError(`CIP reply service 0x${service.toString(16)} lacks the reply bit`);
  const status = buf[2];
  const extWords = buf[3];
  if (4 + extWords * 2 > buf.length) throw new EipFramingError('truncated CIP extended status');
  const ext = [];
  for (let k = 0; k < extWords; k++) ext.push(buf.readUInt16LE(4 + 2 * k));
  return { service, status, ext, data: Buffer.from(buf.subarray(4 + extWords * 2)) };
}

/**
 * Split a Multiple Service Packet reply body into inner replies.
 * @returns {ReturnType<typeof parseCipReply>[]}
 * @throws {EipFramingError}
 */
function parseMspReply(data, expectedCount) {
  if (data.length < 2) throw new EipFramingError('MSP reply too short');
  const count = data.readUInt16LE(0);
  if (expectedCount !== undefined && count !== expectedCount) {
    throw new EipFramingError(`MSP reply has ${count} items, request had ${expectedCount}`);
  }
  if (2 + 2 * count > data.length) throw new EipFramingError('truncated MSP offset table');
  const offsets = [];
  for (let k = 0; k < count; k++) offsets.push(data.readUInt16LE(2 + 2 * k));
  return offsets.map((off, k) => {
    const end = k + 1 < count ? offsets[k + 1] : data.length;
    if (off < 2 + 2 * count || end > data.length || end < off) throw new EipFramingError(`bad MSP offset ${off}`);
    return parseCipReply(data.subarray(off, end));
  });
}

/**
 * Parse a raw CIP request back into its structured form (used by the
 * byte-level guard). Unconnected Send and MSP are unwrapped.
 * @throws {Error} on malformed bytes
 */
function parseCipRequest(buf) {
  if (buf.length < 2) throw new Error('CIP request too short');
  const service = buf[0];
  const pathLen = buf[1] * 2;
  if (2 + pathLen > buf.length) throw new Error('truncated request path');
  const path = Buffer.from(buf.subarray(2, 2 + pathLen));
  const data = Buffer.from(buf.subarray(2 + pathLen));
  const req = { service, path, data };
  let p;
  try {
    p = cip.describePath(path);
  } catch {
    return req; // allowlist will refuse it
  }
  const cls = p.classes.length ? p.classes[p.classes.length - 1] : null;
  if (service === SERVICE.UNCONNECTED_SEND && cls === CLASS.CONNECTION_MANAGER) {
    if (data.length < 4) throw new Error('truncated Unconnected Send');
    const size = data.readUInt16LE(2);
    if (4 + size > data.length) throw new Error('truncated Unconnected Send message');
    req.embedded = parseCipRequest(data.subarray(4, 4 + size));
  } else if (service === SERVICE.MULTIPLE_SERVICE_PACKET) {
    const count = data.readUInt16LE(0);
    const offs = [];
    for (let k = 0; k < count; k++) offs.push(data.readUInt16LE(2 + 2 * k));
    req.services = offs.map((o, k) => parseCipRequest(data.subarray(o, k + 1 < count ? offs[k + 1] : data.length)));
  }
  return req;
}

/**
 * Byte-level allowlist check for a complete outgoing encapsulation frame.
 * @param {Buffer} buf
 * @throws {EipReadOnlyError}
 */
function inspectOutgoingFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) throw new EipReadOnlyError('outgoing frame', 'not an encapsulation packet');
  const command = buf.readUInt16LE(0);
  if (!ALLOWED_COMMANDS.has(command)) throw new EipReadOnlyError(`encapsulation command 0x${command.toString(16)}`);
  if (buf.readUInt16LE(2) !== buf.length - HEADER_SIZE) throw new EipReadOnlyError('outgoing frame', 'length field mismatch');
  if (command !== COMMAND.SEND_RR_DATA && command !== COMMAND.SEND_UNIT_DATA) return;
  let req;
  try {
    const { items } = parseCpf(buf.subarray(HEADER_SIZE));
    const dataItem = items.find((it) => it.type === CPF.UNCONNECTED_DATA || it.type === CPF.CONNECTED_DATA);
    if (!dataItem || items.length !== 2) throw new Error('missing data item');
    const msg = dataItem.type === CPF.CONNECTED_DATA ? dataItem.data.subarray(2) : dataItem.data;
    req = parseCipRequest(msg);
  } catch (err) {
    throw new EipReadOnlyError('outgoing frame', `unparseable: ${err.message}`);
  }
  assertCipAllowed(req);
}

// ── request builders (structured; encoded only by encodeFrame) ────────────

function readTag(path, elements = 1) {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(elements, 0);
  return { service: SERVICE.READ_TAG, path, data };
}

function readTagFragmented(path, elements, byteOffset) {
  const data = Buffer.alloc(6);
  data.writeUInt16LE(elements, 0);
  data.writeUInt32LE(byteOffset >>> 0, 2);
  return { service: SERVICE.READ_TAG_FRAGMENTED, path, data };
}

function multipleServicePacket(services) {
  return { service: SERVICE.MULTIPLE_SERVICE_PACKET, path: cip.MESSAGE_ROUTER_PATH, services };
}

function getAttributeAll(classId, instance) {
  return { service: SERVICE.GET_ATTRIBUTE_ALL, path: Buffer.concat([cip.logical('class', classId), cip.logical('instance', instance)]) };
}

function getAttributeList(classId, instance, attributes) {
  const data = Buffer.alloc(2 + 2 * attributes.length);
  data.writeUInt16LE(attributes.length, 0);
  attributes.forEach((a, k) => data.writeUInt16LE(a, 2 + 2 * k));
  return {
    service: SERVICE.GET_ATTRIBUTE_LIST,
    path: Buffer.concat([cip.logical('class', classId), cip.logical('instance', instance)]),
    data,
  };
}

/** Get Instance Attribute List on the Symbol class, starting at `startInstance`. */
function getInstanceAttributeList(startInstance, attributes, program) {
  const data = Buffer.alloc(2 + 2 * attributes.length);
  data.writeUInt16LE(attributes.length, 0);
  attributes.forEach((a, k) => data.writeUInt16LE(a, 2 + 2 * k));
  const base = Buffer.concat([cip.logical('class', CLASS.SYMBOL), cip.logical('instance', startInstance)]);
  return {
    service: SERVICE.GET_INSTANCE_ATTRIBUTE_LIST,
    path: program ? Buffer.concat([cip.symbolic(program), base]) : base,
    data,
  };
}

/** Read Template (service 0x4C on class 0x6C): byte offset + byte count. */
function readTemplate(instance, offset, bytes) {
  const data = Buffer.alloc(6);
  data.writeUInt32LE(offset >>> 0, 0);
  data.writeUInt16LE(bytes, 4);
  return {
    service: SERVICE.READ_TAG,
    path: Buffer.concat([cip.logical('class', CLASS.TEMPLATE), cip.logical('instance', instance)]),
    data,
  };
}

function unconnectedSend(embedded, route) {
  return { service: SERVICE.UNCONNECTED_SEND, path: cip.CONNECTION_MANAGER_PATH, embedded, route };
}

/**
 * Forward Open / Large Forward Open (ODVA Vol. 1 3-5.5.2; Large FO adds a
 * 32-bit network connection parameter word). Class 3, point-to-point,
 * variable size, transport trigger 0xA3 (server, application triggered,
 * class 3).
 */
function forwardOpen({ large, size, toConnectionId, serial, vendor = 0x1337, originatorSerial, rpiUs = 2000000, multiplier = 3, route }) {
  const fixed = Buffer.alloc(large ? 39 : 35);
  let o = 0;
  fixed[o++] = 0x0a; // priority/time tick
  fixed[o++] = 0x0e; // timeout ticks (with tick 10: 2^10 ms * 14 ~ 14 s)
  fixed.writeUInt32LE(0, o); // O->T connection id: chosen by the target
  o += 4;
  fixed.writeUInt32LE(toConnectionId >>> 0, o);
  o += 4;
  fixed.writeUInt16LE(serial, o);
  o += 2;
  fixed.writeUInt16LE(vendor, o);
  o += 2;
  fixed.writeUInt32LE(originatorSerial >>> 0, o);
  o += 4;
  fixed[o++] = multiplier & 0xff; // timeout multiplier code
  o += 3; // reserved
  const writeParams = () => {
    fixed.writeUInt32LE(rpiUs >>> 0, o);
    o += 4;
    if (large) {
      // owner exclusive=0, point-to-point (bits 29-30 = 2), low priority, variable (bit 25)
      fixed.writeUInt32LE((0x42000000 | (size & 0xffff)) >>> 0, o);
      o += 4;
    } else {
      fixed.writeUInt16LE(0x4200 | (size & 0x1ff), o);
      o += 2;
    }
  };
  writeParams(); // O->T
  writeParams(); // T->O
  fixed[o++] = 0xa3; // transport type/trigger
  const connPath = Buffer.concat([route, cip.MESSAGE_ROUTER_PATH]);
  const data = Buffer.concat([fixed.subarray(0, o), Buffer.from([connPath.length / 2]), connPath]);
  return { service: large ? cip.SERVICE.LARGE_FORWARD_OPEN : cip.SERVICE.FORWARD_OPEN, path: cip.CONNECTION_MANAGER_PATH, data };
}

/** @returns {{otConnectionId:number, toConnectionId:number, serial:number}} */
function parseForwardOpenReply(data) {
  if (data.length < 26) throw new EipFramingError(`Forward Open reply too short (${data.length})`);
  return {
    otConnectionId: data.readUInt32LE(0),
    toConnectionId: data.readUInt32LE(4),
    serial: data.readUInt16LE(8),
    vendor: data.readUInt16LE(10),
    originatorSerial: data.readUInt32LE(12),
    otApiUs: data.readUInt32LE(16),
    toApiUs: data.readUInt32LE(20),
  };
}

function forwardClose({ serial, vendor = 0x1337, originatorSerial, route }) {
  const fixed = Buffer.alloc(10);
  fixed[0] = 0x0a;
  fixed[1] = 0x0e;
  fixed.writeUInt16LE(serial, 2);
  fixed.writeUInt16LE(vendor, 4);
  fixed.writeUInt32LE(originatorSerial >>> 0, 6);
  const connPath = Buffer.concat([route, cip.MESSAGE_ROUTER_PATH]);
  const data = Buffer.concat([fixed, Buffer.from([connPath.length / 2, 0]), connPath]);
  return { service: SERVICE.FORWARD_CLOSE, path: cip.CONNECTION_MANAGER_PATH, data };
}

module.exports = {
  HEADER_SIZE,
  EipReadOnlyError,
  EipFramingError,
  assertCipAllowed,
  encodeCip,
  encodeFrame,
  inspectOutgoingFrame,
  FrameParser,
  parseCpf,
  parseCipReply,
  parseMspReply,
  parseCipRequest,
  readTag,
  readTagFragmented,
  multipleServicePacket,
  getAttributeAll,
  getAttributeList,
  getInstanceAttributeList,
  readTemplate,
  unconnectedSend,
  forwardOpen,
  parseForwardOpenReply,
  forwardClose,
};
