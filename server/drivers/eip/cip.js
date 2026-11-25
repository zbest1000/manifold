'use strict';

/**
 * CIP constants, status codes and EPATH segment encoders for the read-only
 * EtherNet/IP (Logix) driver. Pure: no I/O.
 *
 * References relied on (no code copied):
 * - ODVA "The CIP Networks Library" Vol. 1 (CIP), Appendix B general status
 *   codes and C-1.4 logical / port / symbolic segment formats; Vol. 2
 *   (EtherNet/IP adaptation) section 2 encapsulation, as summarised by the
 *   Wireshark `packet-cip.c` / `packet-enip.c` dissector field definitions.
 * - Rockwell "Logix 5000 Controllers Data Access" (1756-PM020) for the Logix
 *   services 0x4C/0x52/0x55, the Symbol (0x6B) and Template (0x6C) classes
 *   and the atomic data type codes; behaviour cross-checked against the MIT
 *   licensed pycomm3 documentation/source. 1756-PM020 itself could not be
 *   downloaded from the build environment: see NOTES.md "Verify on real
 *   hardware".
 */

const SERVICE = Object.freeze({
  GET_ATTRIBUTE_ALL: 0x01,
  SET_ATTRIBUTE_ALL: 0x02,
  GET_ATTRIBUTE_LIST: 0x03,
  SET_ATTRIBUTE_LIST: 0x04,
  RESET: 0x05,
  START: 0x06,
  STOP: 0x07,
  CREATE: 0x08,
  DELETE: 0x09,
  MULTIPLE_SERVICE_PACKET: 0x0a,
  APPLY_ATTRIBUTES: 0x0d,
  GET_ATTRIBUTE_SINGLE: 0x0e,
  SET_ATTRIBUTE_SINGLE: 0x10,
  // Logix object-specific services (1756-PM020)
  READ_TAG: 0x4c, // on Template class 0x6C this is "Read Template"
  WRITE_TAG: 0x4d,
  READ_MODIFY_WRITE: 0x4e, // on Connection Manager this code is Forward Close
  READ_TAG_FRAGMENTED: 0x52, // on Connection Manager this code is Unconnected Send
  WRITE_TAG_FRAGMENTED: 0x53,
  GET_INSTANCE_ATTRIBUTE_LIST: 0x55,
  // Connection Manager (class 0x06) services
  FORWARD_CLOSE: 0x4e,
  UNCONNECTED_SEND: 0x52,
  FORWARD_OPEN: 0x54,
  LARGE_FORWARD_OPEN: 0x5b,
});

const CLASS = Object.freeze({
  IDENTITY: 0x01,
  MESSAGE_ROUTER: 0x02,
  CONNECTION_MANAGER: 0x06,
  SYMBOL: 0x6b,
  TEMPLATE: 0x6c,
});

/** Encapsulation commands (ODVA Vol. 2, 2-3). */
const COMMAND = Object.freeze({
  NOP: 0x0000,
  LIST_SERVICES: 0x0004,
  LIST_IDENTITY: 0x0063,
  LIST_INTERFACES: 0x0064,
  REGISTER_SESSION: 0x0065,
  UNREGISTER_SESSION: 0x0066,
  SEND_RR_DATA: 0x006f,
  SEND_UNIT_DATA: 0x0070,
});

/** Common Packet Format item type ids (ODVA Vol. 2, 2-6). */
const CPF = Object.freeze({
  NULL_ADDRESS: 0x0000,
  LIST_IDENTITY: 0x000c,
  CONNECTED_ADDRESS: 0x00a1,
  CONNECTED_DATA: 0x00b1,
  UNCONNECTED_DATA: 0x00b2,
});

/** Logix atomic data type codes (1756-PM020 "Atomic data types"). */
const TYPE = Object.freeze({
  BOOL: 0xc1,
  SINT: 0xc2,
  INT: 0xc3,
  DINT: 0xc4,
  LINT: 0xc5,
  USINT: 0xc6,
  UINT: 0xc7,
  UDINT: 0xc8,
  ULINT: 0xc9,
  REAL: 0xca,
  LREAL: 0xcb,
  BYTE: 0xd1,
  WORD: 0xd2,
  DWORD: 0xd3, // a 32-bit word of a BOOL array
  LWORD: 0xd4,
});
/** Read Tag reply type word for a structure: 0x02A0, followed by the structure handle. */
const STRUCT_TYPE_WORD = 0x02a0;

const TYPE_NAME = Object.freeze(Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k])));

const GENERAL_STATUS = Object.freeze({
  0x00: 'success',
  0x01: 'connection failure',
  0x02: 'resource unavailable',
  0x03: 'invalid parameter value',
  0x04: 'path segment error',
  0x05: 'path destination unknown',
  0x06: 'partial transfer',
  0x07: 'connection lost',
  0x08: 'service not supported',
  0x09: 'invalid attribute value',
  0x0a: 'attribute list error',
  0x0b: 'already in requested mode/state',
  0x0c: 'object state conflict',
  0x0d: 'object already exists',
  0x0e: 'attribute not settable',
  0x0f: 'privilege violation',
  0x10: 'device state conflict',
  0x11: 'reply data too large',
  0x12: 'fragmentation of a primitive value',
  0x13: 'not enough data',
  0x14: 'attribute not supported',
  0x15: 'too much data',
  0x16: 'object does not exist',
  0x17: 'service fragmentation sequence not in progress',
  0x18: 'no stored attribute data',
  0x19: 'store operation failure',
  0x1a: 'routing failure, request packet too large',
  0x1b: 'routing failure, response packet too large',
  0x1c: 'missing attribute list entry data',
  0x1d: 'invalid attribute value list',
  0x1e: 'embedded service error',
  0x1f: 'vendor specific error',
  0x20: 'invalid parameter',
  0x25: 'key failure in path',
  0x26: 'path size invalid',
  0x27: 'unexpected attribute in list',
  0x28: 'invalid member id',
  0xff: 'general error (see extended status)',
});

/** Logix extended status for general status 0xFF (1756-PM020 error codes). */
const LOGIX_EXTENDED = Object.freeze({
  0x2104: 'offset out of range',
  0x2105: 'beyond end of the object / array index out of range',
  0x2107: 'data type mismatch',
});

/** Statuses after which a tag's resolved symbol/template may be stale (rule 9). */
const LAYOUT_STATUSES = new Set([0x04, 0x05, 0x16]);
const RETRY_STATUSES = new Set([0x01, 0x02, 0x07, 0x10, 0x1a, 0x1b]);

function statusName(code, ext) {
  const base = GENERAL_STATUS[code] || `unknown status 0x${code.toString(16)}`;
  if (code === 0xff && ext && ext.length && LOGIX_EXTENDED[ext[0]]) return `${base}: ${LOGIX_EXTENDED[ext[0]]}`;
  return base;
}

/** @returns {'permanent'|'retry'} */
function classifyStatus(code) {
  return RETRY_STATUSES.has(code) ? 'retry' : 'permanent';
}

// ── EPATH segments (ODVA Vol. 1 C-1.4) ─────────────────────────────────────

/**
 * Logical segment. type: 'class'|'instance'|'member'|'attribute'. Uses the
 * smallest format that fits (8-bit, 16-bit padded, 32-bit padded).
 */
function logical(type, value) {
  const code = { class: 0x20, instance: 0x24, member: 0x28, connectionPoint: 0x2c, attribute: 0x30 }[type];
  if (code === undefined) throw new Error(`unknown logical segment type ${type}`);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${type} id ${value} out of range`);
  if (value <= 0xff) return Buffer.from([code, value]);
  if (value <= 0xffff) {
    const b = Buffer.alloc(4);
    b[0] = code | 1;
    b.writeUInt16LE(value, 2);
    return b;
  }
  if (type === 'class' || type === 'attribute') throw new RangeError(`${type} id ${value} exceeds 16 bits`);
  const b = Buffer.alloc(6);
  b[0] = code | 2;
  b.writeUInt32LE(value, 2);
  return b;
}

/** Logix array element index: a logical member segment (1756-PM020). */
function element(index) {
  return logical('member', index);
}

/** ANSI extended symbolic segment 0x91, padded to an even length. */
function symbolic(name) {
  const bytes = Buffer.from(name, 'latin1');
  if (bytes.length < 1 || bytes.length > 255) throw new RangeError(`symbol "${name}" length must be 1..255`);
  const b = Buffer.alloc(2 + bytes.length + (bytes.length % 2));
  b[0] = 0x91;
  b[1] = bytes.length;
  bytes.copy(b, 2);
  return b;
}

/**
 * Port segment. `link` is a number (slot / node) or an IP address string
 * (extended link address, used to hop through a bridge module).
 */
function port(portNumber, link) {
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 14) {
    throw new RangeError(`port ${portNumber} must be 1..14`);
  }
  if (typeof link === 'number') {
    if (!Number.isInteger(link) || link < 0 || link > 255) throw new RangeError(`link ${link} must be 0..255`);
    return Buffer.from([portNumber, link]);
  }
  const addr = Buffer.from(String(link), 'latin1');
  const b = Buffer.alloc(2 + addr.length + (addr.length % 2));
  b[0] = 0x10 | portNumber;
  b[1] = addr.length;
  addr.copy(b, 2);
  return b;
}

/**
 * Parse a route path string: comma separated `port,link` pairs, e.g. `1,0`
 * (backplane slot 0) or `1,2,2,10.0.0.5,1,0`.
 * @returns {Buffer}
 */
function encodeRoutePath(text) {
  const parts = String(text)
    .split(/[,/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length % 2 !== 0) {
    throw new Error(`route path "${text}" must be comma separated port,link pairs, e.g. "1,0"`);
  }
  const segs = [];
  for (let i = 0; i < parts.length; i += 2) {
    const p = Number(parts[i]);
    const linkText = parts[i + 1];
    const link = /^\d+$/.test(linkText) ? Number(linkText) : linkText;
    if (typeof link === 'string' && !/^[0-9.]+$/.test(link)) throw new Error(`route path link "${linkText}" is not a number or IPv4 address`);
    segs.push(port(p, link));
  }
  return Buffer.concat(segs);
}

/** Default route to a controller in a backplane slot: port 1 (backplane), link = slot. */
function slotRoute(slot = 0) {
  return port(1, slot);
}

const MESSAGE_ROUTER_PATH = Buffer.concat([logical('class', CLASS.MESSAGE_ROUTER), logical('instance', 1)]);
const CONNECTION_MANAGER_PATH = Buffer.concat([logical('class', CLASS.CONNECTION_MANAGER), logical('instance', 1)]);

/**
 * Walk an EPATH and describe it. Used by the allowlist: classes addressed,
 * whether a symbolic segment is present. Throws on a malformed path.
 * @param {Buffer} path
 * @returns {{classes:number[], instances:number[], symbolic:boolean, ports:number}}
 */
function describePath(path) {
  const out = { classes: [], instances: [], symbolic: false, ports: 0 };
  let i = 0;
  const need = (n) => {
    if (i + n > path.length) throw new Error('truncated EPATH');
  };
  while (i < path.length) {
    const seg = path[i];
    if ((seg & 0xe0) === 0x00) {
      // port segment
      out.ports++;
      if (seg & 0x10) {
        need(2);
        const len = path[i + 1];
        i += 2 + len + (len % 2);
      } else i += 2;
      need(0);
    } else if ((seg & 0xe0) === 0x20) {
      const fmt = seg & 0x03;
      const kind = (seg >> 2) & 0x07;
      let value;
      if (fmt === 0) {
        need(2);
        value = path[i + 1];
        i += 2;
      } else if (fmt === 1) {
        need(4);
        value = path.readUInt16LE(i + 2);
        i += 4;
      } else if (fmt === 2) {
        need(6);
        value = path.readUInt32LE(i + 2);
        i += 6;
      } else throw new Error(`reserved logical format in segment 0x${seg.toString(16)}`);
      if (kind === 0) out.classes.push(value);
      else if (kind === 1) out.instances.push(value);
    } else if (seg === 0x91) {
      need(2);
      const len = path[i + 1];
      need(2 + len + (len % 2));
      out.symbolic = true;
      i += 2 + len + (len % 2);
    } else {
      throw new Error(`unsupported EPATH segment 0x${seg.toString(16)}`);
    }
  }
  return out;
}

module.exports = {
  SERVICE,
  CLASS,
  COMMAND,
  CPF,
  TYPE,
  TYPE_NAME,
  STRUCT_TYPE_WORD,
  GENERAL_STATUS,
  LAYOUT_STATUSES,
  statusName,
  classifyStatus,
  logical,
  element,
  symbolic,
  port,
  encodeRoutePath,
  slotRoute,
  MESSAGE_ROUTER_PATH,
  CONNECTION_MANAGER_PATH,
  describePath,
};
