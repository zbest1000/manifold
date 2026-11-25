'use strict';

/**
 * Logix value decoding. All CIP data is little-endian.
 *
 * Structures are decoded ONLY from the controller's template (class 0x6C):
 * member offsets, BOOL members hosted in hidden SINT members and padding all
 * come from the template, never from summed member sizes (design rule 10).
 *
 * Template format (1756-PM020 "Read Template Service", cross-checked with the
 * MIT licensed pycomm3): `memberCount` 8-byte member records
 * {UINT info, UINT type, UDINT offset} followed by NUL-terminated names — the
 * template name first ("NAME;n..." up to the ';'), then one name per member.
 * `info` is the bit number for a BOOL member, the element count for an array
 * member, 0 for a scalar.
 */

const { TYPE, TYPE_NAME, STRUCT_TYPE_WORD } = require('./cip');

const ATOMIC = {
  [TYPE.BOOL]: { size: 1, type: 'bool', read: (b, o) => b[o] !== 0 },
  [TYPE.SINT]: { size: 1, type: 'int8', read: (b, o) => b.readInt8(o) },
  [TYPE.INT]: { size: 2, type: 'int16', read: (b, o) => b.readInt16LE(o) },
  [TYPE.DINT]: { size: 4, type: 'int32', read: (b, o) => b.readInt32LE(o) },
  [TYPE.LINT]: { size: 8, type: 'int64', read: (b, o) => b.readBigInt64LE(o).toString() },
  [TYPE.USINT]: { size: 1, type: 'uint8', read: (b, o) => b.readUInt8(o) },
  [TYPE.UINT]: { size: 2, type: 'uint16', read: (b, o) => b.readUInt16LE(o) },
  [TYPE.UDINT]: { size: 4, type: 'uint32', read: (b, o) => b.readUInt32LE(o) },
  [TYPE.ULINT]: { size: 8, type: 'uint64', read: (b, o) => b.readBigUInt64LE(o).toString() },
  [TYPE.REAL]: { size: 4, type: 'float32', read: (b, o) => b.readFloatLE(o) },
  [TYPE.LREAL]: { size: 8, type: 'float64', read: (b, o) => b.readDoubleLE(o) },
  [TYPE.BYTE]: { size: 1, type: 'uint8', read: (b, o) => b.readUInt8(o) },
  [TYPE.WORD]: { size: 2, type: 'uint16', read: (b, o) => b.readUInt16LE(o) },
  [TYPE.DWORD]: { size: 4, type: 'uint32', read: (b, o) => b.readUInt32LE(o) },
  [TYPE.LWORD]: { size: 8, type: 'uint64', read: (b, o) => b.readBigUInt64LE(o).toString() },
};

/** Tag type names accepted in configuration, mapped to Logix type codes. */
const TYPE_BY_NAME = {
  BOOL: TYPE.BOOL,
  SINT: TYPE.SINT,
  INT: TYPE.INT,
  DINT: TYPE.DINT,
  LINT: TYPE.LINT,
  USINT: TYPE.USINT,
  UINT: TYPE.UINT,
  UDINT: TYPE.UDINT,
  ULINT: TYPE.ULINT,
  REAL: TYPE.REAL,
  LREAL: TYPE.LREAL,
};

class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** Layout drift: the controller's structure no longer matches our cached template. */
class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayoutError';
  }
}

const HIDDEN = /^(ZZZZZZZZZZ|__)/;

/**
 * Parse Read Template bytes into a layout.
 * @param {{id:number, handle:number, memberCount:number, structSize:number}} attrs
 * @param {Buffer} bytes concatenated Read Template reply data
 * @returns {{id:number, handle:number, name:string, size:number, members:object[], string:boolean}}
 */
function parseTemplate(attrs, bytes) {
  const { id, handle, memberCount, structSize } = attrs;
  const infoLen = memberCount * 8;
  if (bytes.length < infoLen) throw new DecodeError(`template ${id}: ${bytes.length} bytes, member table needs ${infoLen}`);
  const names = bytes
    .subarray(infoLen)
    .toString('latin1')
    .split('\0');
  let name = names.shift() || '';
  if (name.includes(';')) name = name.slice(0, name.indexOf(';'));
  const members = [];
  for (let k = 0; k < memberCount; k++) {
    const info = bytes.readUInt16LE(k * 8);
    const typeWord = bytes.readUInt16LE(k * 8 + 2);
    const offset = bytes.readUInt32LE(k * 8 + 4);
    const memberName = names[k] || `__unknown${k}`;
    const struct = (typeWord & 0x8000) !== 0;
    const code = struct ? null : typeWord & 0xff;
    const m = { name: memberName, offset, typeWord, hidden: HIDDEN.test(memberName) };
    if (struct) {
      m.kind = 'struct';
      m.templateId = typeWord & 0x0fff;
      m.count = info > 0 ? info : 1;
      m.array = info > 0;
    } else if (code === TYPE.BOOL) {
      m.kind = 'bit';
      m.code = code;
      m.bit = info;
    } else if (code === TYPE.DWORD && info > 0) {
      m.kind = 'boolArray';
      m.code = code;
      m.words = info;
    } else {
      if (!ATOMIC[code]) throw new DecodeError(`template ${name}: member ${memberName} has unknown type 0x${typeWord.toString(16)}`);
      m.kind = 'atomic';
      m.code = code;
      m.count = info > 0 ? info : 1;
      m.array = info > 0;
    }
    if (offset > structSize) throw new DecodeError(`template ${name}: member ${memberName} offset ${offset} beyond size ${structSize}`);
    members.push(m);
  }
  if (name === 'ASCIISTRING82') name = 'STRING'; // Logix internal name of the built-in STRING
  const visible = members.filter((m) => !m.hidden);
  const string =
    visible.length === 2 &&
    visible[0].name === 'LEN' &&
    visible[0].kind === 'atomic' &&
    visible[1].name === 'DATA' &&
    visible[1].kind === 'atomic' &&
    visible[1].array &&
    (visible[1].code === TYPE.SINT || visible[1].code === TYPE.USINT);
  return { id, handle, name, size: structSize, members, string };
}

function need(buf, offset, size, what) {
  if (offset + size > buf.length) throw new DecodeError(`${what}: needs ${offset + size} bytes, have ${buf.length}`);
}

function readAtomic(code, buf, offset) {
  const a = ATOMIC[code];
  if (!a) throw new DecodeError(`unsupported type code 0x${code.toString(16)}`);
  need(buf, offset, a.size, TYPE_NAME[code]);
  return a.read(buf, offset);
}

function decodeString(tpl, buf, offset) {
  const visible = tpl.members.filter((m) => !m.hidden);
  const [lenM, dataM] = visible;
  need(buf, offset, tpl.size, `STRING ${tpl.name}`);
  const len = readAtomic(lenM.code, buf, offset + lenM.offset);
  const n = Math.max(0, Math.min(Number(len), dataM.count));
  return buf.toString('latin1', offset + dataM.offset, offset + dataM.offset + n);
}

/**
 * Decode one structure instance from its template.
 * @param {object} tpl parseTemplate() result
 * @param {Buffer} buf
 * @param {number} offset
 * @param {(id:number)=>object|undefined} getTemplate nested template lookup
 */
function decodeStruct(tpl, buf, offset, getTemplate) {
  if (tpl.string) return decodeString(tpl, buf, offset);
  need(buf, offset, tpl.size, `structure ${tpl.name}`);
  const out = {};
  for (const m of tpl.members) {
    if (m.hidden) continue;
    const at = offset + m.offset;
    if (m.kind === 'bit') {
      need(buf, at, 1, m.name);
      out[m.name] = ((buf[at] >> m.bit) & 1) === 1;
    } else if (m.kind === 'boolArray') {
      const bits = [];
      for (let w = 0; w < m.words; w++) {
        const word = readAtomic(TYPE.DWORD, buf, at + 4 * w);
        for (let b = 0; b < 32; b++) bits.push(((word >>> b) & 1) === 1);
      }
      out[m.name] = bits;
    } else if (m.kind === 'atomic') {
      const size = ATOMIC[m.code].size;
      if (m.array) out[m.name] = Array.from({ length: m.count }, (_, i) => readAtomic(m.code, buf, at + i * size));
      else out[m.name] = readAtomic(m.code, buf, at);
    } else {
      const sub = getTemplate(m.templateId);
      if (!sub) throw new LayoutError(`template ${m.templateId} for member ${tpl.name}.${m.name} is not loaded`);
      if (m.array) out[m.name] = Array.from({ length: m.count }, (_, i) => decodeStruct(sub, buf, at + i * sub.size, getTemplate));
      else out[m.name] = decodeStruct(sub, buf, at, getTemplate);
    }
  }
  return out;
}

/**
 * Decode Read Tag / Read Tag Fragmented reply data.
 *
 * @param {Buffer} data reply data: UINT type [UINT struct handle] values...
 * @param {{elements?:number, bit?:number|null, boolIndex?:number|null,
 *   template?:object, getTemplate?:(id:number)=>object}} ctx
 * @returns {{v:any, type:string}}
 * @throws {DecodeError|LayoutError}
 */
function decodeTagReply(data, ctx = {}) {
  if (data.length < 2) throw new DecodeError('reply has no type word');
  const typeWord = data.readUInt16LE(0);
  const elements = ctx.elements || 1;
  if (typeWord === STRUCT_TYPE_WORD) {
    if (data.length < 4) throw new DecodeError('structure reply has no handle');
    const handle = data.readUInt16LE(2);
    const tpl = ctx.template;
    if (!tpl) throw new LayoutError(`structure reply (handle 0x${handle.toString(16)}) for a tag with no resolved template`);
    if (tpl.handle !== handle) {
      throw new LayoutError(`structure handle 0x${handle.toString(16)} != template ${tpl.name} handle 0x${tpl.handle.toString(16)}`);
    }
    const body = data.subarray(4);
    if (body.length !== tpl.size * elements) {
      throw new DecodeError(`structure ${tpl.name}: ${body.length} bytes, expected ${tpl.size * elements}`);
    }
    const get = ctx.getTemplate || (() => undefined);
    const type = tpl.string ? 'string' : 'struct';
    if (elements === 1) return { v: decodeStruct(tpl, body, 0, get), type };
    return { v: Array.from({ length: elements }, (_, i) => decodeStruct(tpl, body, i * tpl.size, get)), type };
  }
  if (typeWord & 0xff00) throw new DecodeError(`unexpected type word 0x${typeWord.toString(16)}`);
  const a = ATOMIC[typeWord];
  if (!a) throw new DecodeError(`unsupported type code 0x${typeWord.toString(16)}`);
  const body = data.subarray(2);
  if (body.length !== a.size * elements) {
    throw new DecodeError(`${TYPE_NAME[typeWord]}: ${body.length} bytes, expected ${a.size * elements}`);
  }
  if (ctx.boolIndex !== null && ctx.boolIndex !== undefined) {
    // BOOL array element: we read the DWORD that holds it.
    if (typeWord !== TYPE.DWORD) throw new LayoutError(`BOOL array element read returned ${TYPE_NAME[typeWord]}, expected DWORD`);
    return { v: ((body.readUInt32LE(0) >>> (ctx.boolIndex & 31)) & 1) === 1, type: 'bool' };
  }
  if (ctx.bit !== null && ctx.bit !== undefined) {
    const bits = a.size * 8;
    if (typeWord === TYPE.BOOL || typeWord === TYPE.REAL || typeWord === TYPE.LREAL || ctx.bit >= bits) {
      throw new DecodeError(`bit ${ctx.bit} is not addressable in ${TYPE_NAME[typeWord]}`);
    }
    const raw = a.size === 8 ? body.readBigUInt64LE(0) : BigInt(body.readUIntLE(0, a.size));
    return { v: ((raw >> BigInt(ctx.bit)) & 1n) === 1n, type: 'bool' };
  }
  if (typeWord === TYPE.DWORD && ctx.boolArray) {
    const bits = [];
    for (let w = 0; w < elements; w++) for (let b = 0; b < 32; b++) bits.push(((body.readUInt32LE(4 * w) >>> b) & 1) === 1);
    return { v: bits, type: 'bool' };
  }
  if (elements === 1) return { v: a.read(body, 0), type: a.type };
  return { v: Array.from({ length: elements }, (_, i) => a.read(body, i * a.size)), type: a.type };
}

/**
 * Every plausible decoding of raw value bytes (commissioning probe).
 * @param {Buffer} raw value bytes without the type word
 */
function probeDecodings(raw) {
  const out = {};
  for (const [name, code] of Object.entries(TYPE_BY_NAME)) {
    const a = ATOMIC[code];
    if (raw.length >= a.size) out[name] = a.read(raw, 0);
  }
  if (raw.length >= 4) {
    const len = raw.readInt32LE(0);
    if (len >= 0 && len <= raw.length - 4) out.STRING = raw.toString('latin1', 4, 4 + len);
  }
  out.ASCII = raw.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  return out;
}

module.exports = {
  ATOMIC,
  TYPE_BY_NAME,
  DecodeError,
  LayoutError,
  parseTemplate,
  decodeStruct,
  decodeTagReply,
  probeDecodings,
};
