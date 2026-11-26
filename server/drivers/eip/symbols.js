'use strict';

/**
 * Symbol (class 0x6B) and Template (class 0x6C) discovery, pure parsing plus
 * thin async fetchers that take a `request(cipReq) => Promise<reply>` function.
 *
 * Get Instance Attribute List (0x55), per 1756-PM020 and pycomm3 behaviour:
 * request = attribute count + attribute ids; reply = repeated
 * { UDINT instance id, attribute values in the requested order }, general
 * status 0x06 when more instances remain (continue at last id + 1).
 * Attributes used: 1 name (UINT length + chars), 2 symbol type (UINT),
 * 8 dimensions (3 x UDINT), 10 external access (USINT; firmware v18+).
 *
 * Symbol type word: bit 15 structure, bits 13-14 number of dimensions,
 * bit 12 system/reserved, bits 0-11 template instance id (structure) or
 * bits 0-7 atomic type code with bits 8-10 the bit position of a BOOL.
 *
 * Template attributes (Get_Attribute_List on 0x6C): 1 structure handle
 * (UINT), 2 member count (UINT), 4 object definition size in 32-bit words
 * (UDINT), 5 structure size in bytes (UDINT). Read Template byte count:
 * definition size * 4 - 21 (pycomm3; 1756-PM020 reportedly states - 23 —
 * both work because the reply is parsed by member count and NUL-terminated
 * names, see NOTES.md).
 */

const { TYPE_NAME } = require('./cip');
const frame = require('./frame');
const { parseTemplate } = require('./decode');

const ATTR = { NAME: 1, TYPE: 2, DIMS: 8, EXTERNAL_ACCESS: 10 };
const EXTERNAL_ACCESS = { 0: 'Read/Write', 1: 'Reserved', 2: 'Read Only', 3: 'None' };
const MAX_SYMBOLS = 200000; // per scope; Logix controllers hold far fewer

class SymbolError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SymbolError';
    this.status = status;
  }
}

/** Decode a symbol type word. */
function parseSymbolType(typeWord) {
  const struct = (typeWord & 0x8000) !== 0;
  const dimCount = (typeWord >> 13) & 0x03;
  const system = (typeWord & 0x1000) !== 0;
  if (struct) return { struct, dimCount, system, templateId: typeWord & 0x0fff };
  const code = typeWord & 0xff;
  return { struct, dimCount, system, code, bitPosition: (typeWord >> 8) & 0x07, typeName: TYPE_NAME[code] || `0x${code.toString(16)}` };
}

/**
 * Parse one Get Instance Attribute List reply body.
 * @returns {{instance:number, name:string, typeWord:number, dims:number[], access:string|null}[]}
 */
function parseInstanceAttributeList(data, withAccess) {
  const out = [];
  let i = 0;
  const need = (n) => {
    if (i + n > data.length) throw new SymbolError(`truncated symbol list at byte ${i}`);
  };
  while (i < data.length) {
    need(6);
    const instance = data.readUInt32LE(i);
    const nameLen = data.readUInt16LE(i + 4);
    i += 6;
    need(nameLen + 2 + 12);
    const name = data.toString('latin1', i, i + nameLen);
    i += nameLen;
    const typeWord = data.readUInt16LE(i);
    i += 2;
    const dims = [data.readUInt32LE(i), data.readUInt32LE(i + 4), data.readUInt32LE(i + 8)];
    i += 12;
    let access = null;
    if (withAccess) {
      need(1);
      access = EXTERNAL_ACCESS[data[i]] || 'Unknown';
      i += 1;
    }
    out.push({ instance, name, typeWord, dims, access, ...parseSymbolType(typeWord) });
  }
  return out;
}

/**
 * Fetch every symbol of one scope.
 * @param {(req:object)=>Promise<object>} request
 * @param {string|null} program e.g. 'Program:MainProgram', null for controller scope
 * @param {{externalAccess:boolean}} opts
 */
async function fetchSymbols(request, program, { externalAccess }) {
  const attrs = [ATTR.NAME, ATTR.TYPE, ATTR.DIMS];
  if (externalAccess) attrs.push(ATTR.EXTERNAL_ACCESS);
  const all = [];
  let start = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const reply = await request(frame.getInstanceAttributeList(start, attrs, program));
    if (reply.status !== 0 && reply.status !== 0x06) {
      throw new SymbolError(`symbol list for ${program || 'controller'} failed with status 0x${reply.status.toString(16)}`, reply.status);
    }
    const batch = parseInstanceAttributeList(reply.data, externalAccess);
    if (all.length + batch.length > MAX_SYMBOLS) throw new SymbolError(`symbol list for ${program || 'controller'} has more than ${MAX_SYMBOLS} entries`);
    all.push(...batch);
    if (reply.status === 0) return all;
    if (batch.length === 0) throw new SymbolError('partial symbol list reply with no symbols');
    const next = batch[batch.length - 1].instance + 1;
    // The continuation must move forward, or a faulty controller keeps us asking for the same page.
    if (next <= start) throw new SymbolError(`symbol list did not advance (continued at instance ${next - 1} after asking from ${start})`);
    start = next;
  }
  throw new SymbolError('symbol list did not terminate');
}

/** Parse a Get_Attribute_List reply into {attrId: Buffer-at-value}. */
function parseAttributeList(data, sizes) {
  const count = data.readUInt16LE(0);
  const out = {};
  let i = 2;
  for (let k = 0; k < count; k++) {
    const id = data.readUInt16LE(i);
    const status = data.readUInt16LE(i + 2);
    i += 4;
    if (status !== 0) throw new SymbolError(`attribute ${id} returned status 0x${status.toString(16)}`, status);
    const size = sizes[id];
    if (!size) throw new SymbolError(`unexpected attribute ${id}`);
    if (i + size > data.length) throw new SymbolError(`truncated attribute ${id}`);
    out[id] = size === 2 ? data.readUInt16LE(i) : data.readUInt32LE(i);
    i += size;
  }
  return out;
}

/**
 * Fetch and parse one template.
 * @param {(req:object)=>Promise<object>} request
 * @param {number} id template instance id
 */
async function fetchTemplate(request, id) {
  const attrReply = await request(frame.getAttributeList(0x6c, id, [4, 5, 2, 1]));
  if (attrReply.status !== 0) throw new SymbolError(`template ${id} attributes: status 0x${attrReply.status.toString(16)}`, attrReply.status);
  const a = parseAttributeList(attrReply.data, { 1: 2, 2: 2, 4: 4, 5: 4 });
  const total = a[4] * 4 - 21;
  if (total <= 0 || total > 65535 * 4) throw new SymbolError(`template ${id}: implausible definition size ${a[4]}`);
  const parts = [];
  let offset = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const reply = await request(frame.readTemplate(id, offset, Math.min(total - offset, 0xffff)));
    if (reply.status !== 0 && reply.status !== 0x06) throw new SymbolError(`Read Template ${id}: status 0x${reply.status.toString(16)}`, reply.status);
    parts.push(reply.data);
    offset += reply.data.length;
    if (reply.status === 0 || offset >= total) break;
    if (reply.data.length === 0) throw new SymbolError(`Read Template ${id}: empty partial reply`);
  }
  return parseTemplate({ id, handle: a[1], memberCount: a[2], structSize: a[5] }, Buffer.concat(parts));
}

module.exports = {
  ATTR,
  EXTERNAL_ACCESS,
  SymbolError,
  parseSymbolType,
  parseInstanceAttributeList,
  fetchSymbols,
  fetchTemplate,
};
