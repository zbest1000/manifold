'use strict';

/**
 * Protobuf decoding against a user-supplied .proto schema.
 *
 * protobufjs (already a dependency, for Sparkplug B) only PARSES the schema
 * text into its reflection objects (Root, Type, Field, Enum). Decoding walks
 * the wire format here, driven by that reflection: protobufjs's generated
 * decoders (Type.decode, which compiles code from the schema at runtime) are
 * never used, so nothing in a schema becomes code.
 *
 * Output (the shape protobufjs's toObject would give with defaults on):
 *  - every field of the message by its name as written in the .proto
 *    (keepCase); absent scalars carry their default (0, "0", false, "", the
 *    first enum value), absent messages null, repeated [] and maps {};
 *  - oneof members only when set;
 *  - enums by name (an unknown number stays a number);
 *  - 64-bit integer types (int64, uint64, sint64, fixed64, sfixed64) always as
 *    decimal strings (the repo's 64-bit rule), bytes as hex, non-finite floats
 *    as "NaN"/"Infinity";
 *  - well-known types: google.protobuf.Timestamp as an ISO 8601 string, the
 *    wrapper types (DoubleValue ...) as their plain value, Struct / Value /
 *    ListValue as the JSON they stand for.
 * Packed and unpacked repeated scalars are both accepted, unknown fields are
 * skipped (including groups), a repeated non-repeated field keeps the last
 * value (messages merge, as the spec says).
 *
 * Not supported: proto2 groups as declared fields, imports other than the
 * google/protobuf well-known types (put every message in one schema), and
 * extensions.
 */

const protobuf = require('protobufjs');
const { CodecError, makeState, spend, enter, leave, need, floatOut, hex, text, setKey, isoFromSeconds } = require('./common');

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Every message type in a reflection namespace, depth first (full names without the leading dot). */
function messageTypes(ns, out = []) {
  for (const nested of ns.nestedArray || []) {
    if (nested instanceof protobuf.Type) {
      out.push(nested.fullName.replace(/^\./, ''));
      messageTypes(nested, out);
    } else if (nested instanceof protobuf.Namespace) messageTypes(nested, out);
  }
  return out;
}

/**
 * Parse a .proto schema and pick the message type to decode. `messageType` may
 * be omitted when the schema defines exactly one message (outside
 * google.protobuf). Throws SchemaError with protobufjs's message (it names the
 * line) on a bad schema.
 */
function compileProtobuf(schemaText, messageType) {
  if (typeof schemaText !== 'string' || !schemaText.trim()) throw new SchemaError('the .proto schema is empty');
  const root = new protobuf.Root();
  let parsed;
  try {
    parsed = protobuf.parse(schemaText, root, { keepCase: true });
  } catch (error) {
    throw new SchemaError(`.proto does not parse: ${error.message}`);
  }
  for (const file of [...(parsed.imports || []), ...(parsed.weakImports || [])]) {
    const common = /^google\/protobuf\/[a-z_]+\.proto$/.test(file) ? protobuf.common.get(file) : null;
    if (!common) throw new SchemaError(`import "${file}" is not available: only google/protobuf well-known types can be imported; put every other message in this schema`);
    try {
      root.addJSON(common.nested);
    } catch {
      // already present (two imports of overlapping files)
    }
  }
  try {
    root.resolveAll();
  } catch (error) {
    throw new SchemaError(`.proto does not resolve: ${error.message}`);
  }
  const all = messageTypes(root);
  const own = all.filter((n) => !n.startsWith('google.protobuf.'));
  let name = typeof messageType === 'string' ? messageType.trim().replace(/^\./, '') : '';
  if (!name) {
    if (own.length !== 1) {
      throw new SchemaError(own.length ? `the schema defines ${own.length} messages; choose the message type (${own.slice(0, 8).join(', ')}${own.length > 8 ? ', ...' : ''})` : 'the schema defines no message');
    }
    name = own[0];
  }
  let type;
  try {
    type = root.lookupType(name);
  } catch {
    const pkg = parsed.package ? `${parsed.package}.${name}` : null;
    type = pkg ? root.lookup(pkg) : null;
    if (!(type instanceof protobuf.Type)) throw new SchemaError(`message type "${name}" is not in the schema (it defines: ${own.slice(0, 8).join(', ') || 'none'})`);
  }
  return { type, messageType: type.fullName.replace(/^\./, ''), messageTypes: own };
}

// ---- wire format ------------------------------------------------------------

function varint(st) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    need(st, 1);
    const b = st.buf[st.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return result & 0xffffffffffffffffn;
    shift += 7n;
  }
  throw new CodecError('varint longer than 10 bytes', st.pos);
}

/** A varint that must fit 32 bits (tags, lengths); fast path, no BigInt. */
function varint32(st) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    need(st, 1);
    const b = st.buf[st.pos++];
    result += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return result;
  }
  // Tolerate the 10-byte form of a negative int32 tag/length by consuming it, then refuse.
  throw new CodecError('varint does not fit 32 bits', st.pos);
}

function length(st) {
  const n = varint32(st);
  if (n > st.buf.length - st.pos) throw new CodecError(`length ${n} exceeds the ${st.buf.length - st.pos} byte(s) left`, st.pos);
  return n;
}

function skip(st, wt, depth = 0) {
  switch (wt) {
    case 0:
      varint(st);
      return;
    case 1:
      need(st, 8);
      st.pos += 8;
      return;
    case 2: {
      const n = length(st); // read first: `st.pos += length(st)` adds to the position before the length
      st.pos += n;
      return;
    }
    case 5:
      need(st, 4);
      st.pos += 4;
      return;
    case 3: {
      if (depth > st.maxDepth) throw new CodecError('groups nested too deeply', st.pos);
      for (;;) {
        const tag = varint32(st);
        const w = tag & 7;
        if (w === 4) return;
        skip(st, w, depth + 1);
      }
    }
    default:
      throw new CodecError(`invalid wire type ${wt}`, st.pos);
  }
}

const VARINT_TYPES = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']);
const FIXED64_TYPES = new Set(['fixed64', 'sfixed64', 'double']);
const FIXED32_TYPES = new Set(['fixed32', 'sfixed32', 'float']);

function wireTypeOf(field) {
  const t = field.type;
  if (VARINT_TYPES.has(t)) return 0;
  if (FIXED64_TYPES.has(t)) return 1;
  if (FIXED32_TYPES.has(t)) return 5;
  if (t === 'string' || t === 'bytes') return 2;
  if (field.resolvedType instanceof protobuf.Enum) return 0;
  return 2; // message
}

function enumName(en, n) {
  return Object.hasOwn(en.valuesById, n) ? en.valuesById[n] : n;
}

/** One scalar or enum value of wire type `wt` for a field of protobuf type `t`. */
function scalar(st, t, resolved) {
  switch (t) {
    case 'int32':
      return Number(BigInt.asIntN(32, varint(st)));
    case 'uint32':
      return Number(BigInt.asUintN(32, varint(st)));
    case 'sint32': {
      const v = Number(BigInt.asUintN(32, varint(st)));
      return (v >>> 1) ^ -(v & 1);
    }
    case 'int64':
      return BigInt.asIntN(64, varint(st)).toString();
    case 'uint64':
      return varint(st).toString();
    case 'sint64': {
      const v = varint(st);
      return ((v >> 1n) ^ -(v & 1n)).toString();
    }
    case 'bool':
      return varint(st) !== 0n;
    case 'fixed64': {
      need(st, 8);
      const v = st.buf.readBigUInt64LE(st.pos);
      st.pos += 8;
      return v.toString();
    }
    case 'sfixed64': {
      need(st, 8);
      const v = st.buf.readBigInt64LE(st.pos);
      st.pos += 8;
      return v.toString();
    }
    case 'double': {
      need(st, 8);
      const v = st.buf.readDoubleLE(st.pos);
      st.pos += 8;
      return floatOut(v);
    }
    case 'fixed32': {
      need(st, 4);
      const v = st.buf.readUInt32LE(st.pos);
      st.pos += 4;
      return v;
    }
    case 'sfixed32': {
      need(st, 4);
      const v = st.buf.readInt32LE(st.pos);
      st.pos += 4;
      return v;
    }
    case 'float': {
      need(st, 4);
      const v = st.buf.readFloatLE(st.pos);
      st.pos += 4;
      return floatOut(v);
    }
    case 'string': {
      const n = length(st);
      const v = text(st, st.buf.subarray(st.pos, st.pos + n));
      st.pos += n;
      return v;
    }
    case 'bytes': {
      const n = length(st);
      const v = hex(st.buf.subarray(st.pos, st.pos + n));
      st.pos += n;
      return v;
    }
    default:
      if (resolved instanceof protobuf.Enum) return enumName(resolved, Number(BigInt.asIntN(32, varint(st))));
      throw new CodecError(`cannot decode field type "${t}"`, st.pos);
  }
}

const SIXTY_FOUR = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
function defaultOf(field) {
  const opt = field.options && field.options.default;
  const t = field.type;
  if (field.resolvedType instanceof protobuf.Enum) {
    const en = field.resolvedType;
    if (opt !== undefined) return typeof opt === 'number' ? enumName(en, opt) : opt;
    const first = Object.keys(en.values)[0];
    return first === undefined ? 0 : first;
  }
  if (field.resolvedType instanceof protobuf.Type) return null;
  if (SIXTY_FOUR.has(t)) return opt !== undefined ? String(opt) : '0';
  if (t === 'bool') return opt !== undefined ? Boolean(opt) : false;
  if (t === 'string') return opt !== undefined ? String(opt) : '';
  if (t === 'bytes') return '';
  return typeof opt === 'number' ? opt : 0;
}

function message(st, type, end) {
  enter(st);
  const out = {};
  const seen = new Set();
  while (st.pos < end) {
    const tag = varint32(st);
    const id = Math.floor(tag / 8);
    const wt = tag & 7;
    if (id === 0) throw new CodecError('field number 0', st.pos);
    const field = type.fieldsById[id];
    if (!field) {
      skip(st, wt);
      continue;
    }
    spend(st);
    if (field.map) {
      const n = length(st);
      const entryEnd = st.pos + n;
      let key;
      let value;
      const valueField = { type: field.type, resolvedType: field.resolvedType };
      while (st.pos < entryEnd) {
        const et = varint32(st);
        const eid = Math.floor(et / 8);
        const ew = et & 7;
        if (eid === 1 && ew === wireTypeOf({ type: field.keyType })) key = scalar(st, field.keyType);
        else if (eid === 2 && ew === wireTypeOf(valueField)) value = valueField.resolvedType instanceof protobuf.Type ? sub(st, valueField.resolvedType) : scalar(st, field.type, field.resolvedType);
        else skip(st, ew);
      }
      if (st.pos !== entryEnd) throw new CodecError('map entry overruns its length', st.pos);
      if (!seen.has(field.name)) {
        setKey(out, field.name, {});
        seen.add(field.name);
      }
      const k = key === undefined ? defaultOf({ type: field.keyType }) : key;
      setKey(out[field.name], String(k), value === undefined ? defaultOf(valueField) : value);
      continue;
    }
    const expected = wireTypeOf(field);
    let values;
    if (field.repeated && wt === 2 && expected !== 2) {
      // packed scalars
      const n = length(st);
      const packEnd = st.pos + n;
      values = [];
      while (st.pos < packEnd) {
        spend(st);
        values.push(scalar(st, field.type, field.resolvedType));
      }
      if (st.pos !== packEnd) throw new CodecError('packed field overruns its length', st.pos);
    } else {
      if (wt !== expected) throw new CodecError(`field "${field.name}" (${field.type}) arrived with wire type ${wt}, expected ${expected}`, st.pos);
      const v = field.resolvedType instanceof protobuf.Type ? sub(st, field.resolvedType) : scalar(st, field.type, field.resolvedType);
      values = [v];
    }
    if (field.repeated) {
      if (!seen.has(field.name)) {
        setKey(out, field.name, []);
        seen.add(field.name);
      }
      for (const v of values) out[field.name].push(v);
    } else {
      const v = values[values.length - 1];
      if (field.partOf) for (const other of field.partOf.fieldsArray) if (other !== field) delete out[other.name];
      const prev = out[field.name];
      const merge = field.resolvedType instanceof protobuf.Type && prev && typeof prev === 'object' && v && typeof v === 'object' && !Array.isArray(v);
      setKey(out, field.name, merge ? { ...prev, ...v } : v);
      seen.add(field.name);
    }
  }
  if (st.pos !== end) throw new CodecError('message overruns its length', st.pos);
  for (const field of type.fieldsArray) {
    if (seen.has(field.name) || field.partOf) continue;
    setKey(out, field.name, field.map ? {} : field.repeated ? [] : defaultOf(field));
  }
  leave(st);
  return wellKnown(type, out);
}

function sub(st, type) {
  const n = length(st);
  return message(st, type, st.pos + n);
}

const WRAPPERS = new Set(['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue']);

// google.protobuf.Value: the set member of its `kind` oneof. The bundled
// definitions name the members in camelCase (numberValue ...).
function structValue(v) {
  if (!v || typeof v !== 'object') return null;
  for (const k of ['numberValue', 'stringValue', 'boolValue', 'structValue', 'listValue']) if (k in v) return v[k];
  return null; // nullValue, or no member set
}

function wellKnown(type, out) {
  const full = type.fullName;
  if (!full.startsWith('.google.protobuf.')) return out;
  const short = full.slice('.google.protobuf.'.length);
  if (short === 'Timestamp') {
    const iso = isoFromSeconds(BigInt(out.seconds || '0'), Number(out.nanos) || 0);
    return iso ?? out;
  }
  if (WRAPPERS.has(short)) return out.value;
  if (short === 'Struct') return out.fields || {};
  if (short === 'ListValue') return out.values || []; // each Value is already plain
  if (short === 'Value') return structValue(out);
  return out;
}

/** Decode `buf` as one message of the compiled type. */
function decodeProtobuf(compiled, buf, limits = {}) {
  const st = makeState(buf, limits);
  return message(st, compiled.type, buf.length);
}

module.exports = { compileProtobuf, decodeProtobuf, SchemaError };
