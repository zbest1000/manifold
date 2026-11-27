'use strict';

/**
 * Avro binary decoding against a JSON schema (Avro 1.11 specification),
 * hand-written, decode only. The schema is interpreted, never turned into code.
 *
 * Schema support: primitives (null, boolean, int, long, float, double, bytes,
 * string); record, enum, array, map, union, fixed; named types with namespaces
 * and references by name (recursive types work); aliases, doc and defaults are
 * accepted and ignored (there is no schema resolution: the writer schema is the
 * schema). Logical types:
 *   decimal (bytes or fixed)            -> exact decimal string
 *   uuid (string)                       -> the string
 *   date (int)                          -> "YYYY-MM-DD"
 *   time-millis (int), time-micros      -> "HH:MM:SS.sss" / "HH:MM:SS.ssssss"
 *   timestamp-millis/-micros/-nanos     -> ISO 8601 UTC string
 *   local-timestamp-millis/-micros/-nanos -> ISO 8601 without the "Z"
 *   duration (fixed 12)                 -> { months, days, milliseconds }
 * An invalid logical type (decimal scale above precision, a date on a string)
 * is ignored and the underlying type decodes, as the specification requires.
 *
 * Values: long is always a decimal string (the repo's 64-bit rule; a field's
 * JSON type does not depend on the value), int a number, bytes and fixed hex,
 * a union branch its plain value (no {"type": value} wrapper).
 *
 * Single-object encoding: a payload starting with C3 01 followed by the 8-byte
 * CRC-64-AVRO fingerprint of the schema's Parsing Canonical Form has the
 * header stripped. The header is optional: without it, or when the fingerprint
 * belongs to another schema, the bytes are read as a bare datum.
 *
 * Not supported: object container files ("Obj" + 0x01), schema evolution
 * (reader/writer resolution), the JSON encoding.
 */

const { CodecError, makeState, spend, enter, leave, need, floatOut, hex, text, setKey, decimalString, isoFromSeconds } = require('./common');

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SCHEMA_DEPTH = 64;
const MAX_NAMED = 2000;

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

// ---- schema compilation --------------------------------------------------------

function fullName(name, namespace) {
  if (typeof name !== 'string' || !name) throw new SchemaError('a named type needs a "name"');
  if (name.includes('.')) return name;
  return namespace ? `${namespace}.${name}` : name;
}

function checkFullName(full) {
  for (const part of full.split('.')) {
    if (!NAME_RE.test(part)) throw new SchemaError(`"${full}" is not a valid Avro name`);
  }
}

function namespaceOf(full) {
  const i = full.lastIndexOf('.');
  return i === -1 ? '' : full.slice(0, i);
}

function logicalOf(node, schema) {
  const lt = schema.logicalType;
  if (typeof lt !== 'string') return;
  const t = node.type;
  switch (lt) {
    case 'decimal': {
      const p = schema.precision;
      const s = schema.scale ?? 0;
      if ((t === 'bytes' || t === 'fixed') && Number.isInteger(p) && p > 0 && Number.isInteger(s) && s >= 0 && s <= p) {
        if (t === 'fixed' && p > Math.floor(Math.log10(2) * (8 * node.size - 1))) return; // precision does not fit
        node.logical = 'decimal';
        node.scale = s;
      }
      return;
    }
    case 'uuid':
      if (t === 'string' || (t === 'fixed' && node.size === 16)) node.logical = 'uuid';
      return;
    case 'date':
    case 'time-millis':
      if (t === 'int') node.logical = lt;
      return;
    case 'time-micros':
    case 'timestamp-millis':
    case 'timestamp-micros':
    case 'timestamp-nanos':
    case 'local-timestamp-millis':
    case 'local-timestamp-micros':
    case 'local-timestamp-nanos':
      if (t === 'long') node.logical = lt;
      return;
    case 'duration':
      if (t === 'fixed' && node.size === 12) node.logical = 'duration';
      return;
    default:
      return; // unknown logical types are ignored
  }
}

/**
 * Compile an Avro schema (parsed JSON or text) into a tree the decoder walks.
 * Throws SchemaError with a message naming the problem.
 */
function compileAvro(schemaInput) {
  let json = schemaInput;
  if (typeof schemaInput === 'string') {
    try {
      json = JSON.parse(schemaInput);
    } catch (error) {
      throw new SchemaError(`schema is not valid JSON: ${error.message}`);
    }
  }
  const named = new Map(); // fullname -> node
  const pending = []; // name references to resolve once every type is defined

  const compile = (s, ns, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) throw new SchemaError(`schema nests deeper than ${MAX_SCHEMA_DEPTH} levels`);
    if (typeof s === 'string') {
      if (PRIMITIVES.has(s)) return { type: s };
      const ref = { type: 'ref', name: s, ns };
      pending.push(ref);
      return ref;
    }
    if (Array.isArray(s)) {
      if (!s.length) throw new SchemaError('a union needs at least one branch');
      const branches = s.map((b) => {
        if (Array.isArray(b)) throw new SchemaError('a union may not directly contain another union');
        return compile(b, ns, depth + 1);
      });
      return { type: 'union', branches };
    }
    if (!s || typeof s !== 'object') throw new SchemaError(`unexpected schema value ${JSON.stringify(s)}`);
    const t = s.type;
    if (Array.isArray(t) || (t && typeof t === 'object')) return compile(t, ns, depth + 1); // {"type": {...}} wrapper
    if (PRIMITIVES.has(t)) {
      const node = { type: t };
      logicalOf(node, s);
      return node;
    }
    if (t === 'record' || t === 'error' || t === 'enum' || t === 'fixed') {
      const full = fullName(s.name, typeof s.namespace === 'string' ? s.namespace : ns);
      checkFullName(full);
      if (PRIMITIVES.has(full)) throw new SchemaError(`"${full}" is a primitive type name`);
      if (named.has(full)) throw new SchemaError(`type "${full}" is defined twice`);
      if (named.size >= MAX_NAMED) throw new SchemaError(`more than ${MAX_NAMED} named types`);
      const node = { type: t === 'error' ? 'record' : t, name: full };
      named.set(full, node);
      const inner = namespaceOf(full);
      if (node.type === 'record') {
        if (!Array.isArray(s.fields)) throw new SchemaError(`record "${full}" needs a "fields" array`);
        const seen = new Set();
        node.fields = s.fields.map((f) => {
          if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !NAME_RE.test(f.name)) {
            throw new SchemaError(`record "${full}" has a field without a valid "name"`);
          }
          if (seen.has(f.name)) throw new SchemaError(`record "${full}" has two fields named "${f.name}"`);
          seen.add(f.name);
          if (f.type === undefined) throw new SchemaError(`field "${full}.${f.name}" needs a "type"`);
          return { name: f.name, type: compile(f.type, inner, depth + 1) };
        });
      } else if (node.type === 'enum') {
        if (!Array.isArray(s.symbols) || !s.symbols.length) throw new SchemaError(`enum "${full}" needs a non-empty "symbols" array`);
        const seen = new Set();
        for (const sym of s.symbols) {
          if (typeof sym !== 'string' || !NAME_RE.test(sym)) throw new SchemaError(`enum "${full}" has an invalid symbol ${JSON.stringify(sym)}`);
          if (seen.has(sym)) throw new SchemaError(`enum "${full}" repeats the symbol "${sym}"`);
          seen.add(sym);
        }
        node.symbols = s.symbols.slice();
      } else {
        if (!Number.isInteger(s.size) || s.size < 0) throw new SchemaError(`fixed "${full}" needs a non-negative integer "size"`);
        node.size = s.size;
        logicalOf(node, s);
      }
      return node;
    }
    if (t === 'array') {
      if (s.items === undefined) throw new SchemaError('an array needs "items"');
      return { type: 'array', items: compile(s.items, ns, depth + 1) };
    }
    if (t === 'map') {
      if (s.values === undefined) throw new SchemaError('a map needs "values"');
      return { type: 'map', values: compile(s.values, ns, depth + 1) };
    }
    if (typeof t === 'string') {
      const ref = { type: 'ref', name: t, ns };
      pending.push(ref);
      return ref;
    }
    throw new SchemaError(`unknown schema type ${JSON.stringify(t)}`);
  };

  const root = compile(json, '', 0);

  // Resolve references in place: the ref node becomes the named node's alias.
  const lookup = (ref) => {
    const candidates = ref.name.includes('.') ? [ref.name] : [ref.ns ? `${ref.ns}.${ref.name}` : ref.name, ref.name];
    for (const c of candidates) if (named.has(c)) return named.get(c);
    throw new SchemaError(`unknown type "${ref.name}"`);
  };
  for (const ref of pending) ref.target = lookup(ref);
  const deref = (n) => (n.type === 'ref' ? n.target : n);

  // Unions: no two branches of the same unnamed type or the same name.
  const checkUnions = (n, seenNodes) => {
    if (n.type === 'ref' || seenNodes.has(n)) return;
    seenNodes.add(n);
    if (n.type === 'union') {
      const keys = new Set();
      n.branches = n.branches.map(deref);
      for (const b of n.branches) {
        if (b.type === 'union') throw new SchemaError('a union may not directly contain another union');
        const key = b.name || b.type;
        if (keys.has(key)) throw new SchemaError(`a union has two branches of type "${key}"`);
        keys.add(key);
        checkUnions(b, seenNodes);
      }
    } else if (n.type === 'record') {
      for (const f of n.fields) {
        f.type = deref(f.type);
        checkUnions(f.type, seenNodes);
      }
    } else if (n.type === 'array') {
      n.items = deref(n.items);
      checkUnions(n.items, seenNodes);
    } else if (n.type === 'map') {
      n.values = deref(n.values);
      checkUnions(n.values, seenNodes);
    }
  };
  const top = deref(root);
  checkUnions(top, new Set());

  const canonical = canonicalForm(json);
  return { root: top, canonical, fingerprint: fingerprint64(Buffer.from(canonical, 'utf8')) };
}

// ---- Parsing Canonical Form + CRC-64-AVRO -----------------------------------------

/** The schema's Parsing Canonical Form (spec: "Parsing Canonical Form for Schemas"). */
function canonicalForm(json) {
  const defined = new Set();
  const q = (s) => JSON.stringify(s);
  const walk = (s, ns) => {
    if (typeof s === 'string') {
      if (PRIMITIVES.has(s)) return q(s);
      return q(s.includes('.') || !ns ? s : defined.has(`${ns}.${s}`) || !defined.has(s) ? `${ns}.${s}` : s);
    }
    if (Array.isArray(s)) return `[${s.map((b) => walk(b, ns)).join(',')}]`;
    const t = s.type;
    if (Array.isArray(t) || (t && typeof t === 'object')) return walk(t, ns);
    if (PRIMITIVES.has(t)) return q(t);
    if (t === 'record' || t === 'error' || t === 'enum' || t === 'fixed') {
      const full = fullName(s.name, typeof s.namespace === 'string' ? s.namespace : ns);
      if (defined.has(full)) return q(full);
      defined.add(full);
      const inner = namespaceOf(full);
      const kind = t === 'error' ? 'error' : t;
      if (kind === 'record' || kind === 'error') {
        const fields = s.fields.map((f) => `{"name":${q(f.name)},"type":${walk(f.type, inner)}}`).join(',');
        return `{"name":${q(full)},"type":${q(kind)},"fields":[${fields}]}`;
      }
      if (kind === 'enum') return `{"name":${q(full)},"type":"enum","symbols":[${s.symbols.map(q).join(',')}]}`;
      return `{"name":${q(full)},"type":"fixed","size":${s.size}}`;
    }
    if (t === 'array') return `{"type":"array","items":${walk(s.items, ns)}}`;
    if (t === 'map') return `{"type":"map","values":${walk(s.values, ns)}}`;
    return walk(t, ns); // a reference written as {"type": "Name"}
  };
  return walk(json, '');
}

const EMPTY64 = 0xc15d213aa4d7a795n;
const MASK64 = 0xffffffffffffffffn;
let FP_TABLE = null;
function fpTable() {
  if (FP_TABLE) return FP_TABLE;
  FP_TABLE = new Array(256);
  for (let i = 0; i < 256; i++) {
    let fp = BigInt(i);
    for (let j = 0; j < 8; j++) fp = (fp >> 1n) ^ (fp & 1n ? EMPTY64 : 0n);
    FP_TABLE[i] = fp;
  }
  return FP_TABLE;
}

/** CRC-64-AVRO (Rabin) fingerprint of `bytes`, as an unsigned 64-bit BigInt. */
function fingerprint64(bytes) {
  const table = fpTable();
  let fp = EMPTY64;
  for (const b of bytes) fp = ((fp >> 8n) ^ table[Number((fp ^ BigInt(b)) & 0xffn)]) & MASK64;
  return fp;
}

// ---- binary decoding --------------------------------------------------------------

/** Zig-zag varint, up to 64 bits, as a BigInt. */
function readLongBig(st) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    need(st, 1);
    const b = st.buf[st.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return (result >> 1n) ^ -(result & 1n);
    shift += 7n;
  }
  throw new CodecError('varint longer than 10 bytes', st.pos);
}

function readInt(st) {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    need(st, 1);
    const b = st.buf[st.pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) {
      const v = result % 2 ? -(result + 1) / 2 : result / 2;
      if (v < -2147483648 || v > 2147483647) throw new CodecError('int out of 32-bit range', st.pos);
      return v;
    }
    shift += 7;
  }
  throw new CodecError('int varint longer than 5 bytes', st.pos);
}

/** A length or count as a safe, non-negative number, bounded by the bytes left (when minBytes > 0). */
function readCount(st, what) {
  const n = readLongBig(st);
  if (n < 0n) throw new CodecError(`negative ${what} length`, st.pos);
  if (n > BigInt(st.buf.length - st.pos)) throw new CodecError(`${what} length ${n} exceeds the ${st.buf.length - st.pos} byte(s) left`, st.pos);
  return Number(n);
}

function take(st, n) {
  need(st, n);
  const out = st.buf.subarray(st.pos, st.pos + n);
  st.pos += n;
  return out;
}

const pad = (n, w) => String(n).padStart(w, '0');
function timeOfDay(units, perSecond, digits) {
  const totalSec = Math.floor(units / perSecond);
  const frac = units - totalSec * perSecond;
  return `${pad(Math.floor(totalSec / 3600), 2)}:${pad(Math.floor(totalSec / 60) % 60, 2)}:${pad(totalSec % 60, 2)}.${pad(frac, digits)}`;
}

function timestamp(big, perSecond, zulu) {
  const p = BigInt(perSecond);
  let sec = big / p;
  let rem = big % p;
  if (rem < 0n) {
    rem += p;
    sec -= 1n;
  }
  return isoFromSeconds(sec, Number(rem) * (1e9 / perSecond), { zulu });
}

function twosComplement(bytes) {
  if (!bytes.length) return 0n;
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if (bytes[0] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return v;
}

function datum(st, node) {
  spend(st);
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean': {
      need(st, 1);
      const b = st.buf[st.pos++];
      if (b > 1) throw new CodecError(`boolean byte ${b} is not 0 or 1`, st.pos - 1);
      return b === 1;
    }
    case 'int': {
      const v = readInt(st);
      if (node.logical === 'date') {
        const iso = isoFromSeconds(v * 86400, 0);
        return iso ? iso.slice(0, 10) : v;
      }
      if (node.logical === 'time-millis') return v >= 0 && v < 86_400_000 ? timeOfDay(v, 1000, 3) : v;
      return v;
    }
    case 'long': {
      const v = readLongBig(st);
      switch (node.logical) {
        case 'time-micros':
          return v >= 0n && v < 86_400_000_000n ? timeOfDay(Number(v), 1e6, 6) : v.toString();
        case 'timestamp-millis':
        case 'local-timestamp-millis':
          return timestamp(v, 1000, node.logical === 'timestamp-millis') ?? v.toString();
        case 'timestamp-micros':
        case 'local-timestamp-micros':
          return timestamp(v, 1e6, node.logical === 'timestamp-micros') ?? v.toString();
        case 'timestamp-nanos':
        case 'local-timestamp-nanos':
          return timestamp(v, 1e9, node.logical === 'timestamp-nanos') ?? v.toString();
        default:
          return v.toString();
      }
    }
    case 'float': {
      need(st, 4);
      const v = st.buf.readFloatLE(st.pos);
      st.pos += 4;
      return floatOut(v);
    }
    case 'double': {
      need(st, 8);
      const v = st.buf.readDoubleLE(st.pos);
      st.pos += 8;
      return floatOut(v);
    }
    case 'bytes': {
      const b = take(st, readCount(st, 'bytes'));
      return node.logical === 'decimal' ? decimalString(twosComplement(b), -node.scale) : hex(b);
    }
    case 'string':
      return text(st, take(st, readCount(st, 'string')));
    case 'fixed': {
      const b = take(st, node.size);
      if (node.logical === 'decimal') return decimalString(twosComplement(b), -node.scale);
      if (node.logical === 'duration') return { months: b.readUInt32LE(0), days: b.readUInt32LE(4), milliseconds: b.readUInt32LE(8) };
      if (node.logical === 'uuid') {
        const h = hex(b);
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      return hex(b);
    }
    case 'enum': {
      const i = readInt(st);
      if (i < 0 || i >= node.symbols.length) throw new CodecError(`enum index ${i} out of range for "${node.name}"`, st.pos);
      return node.symbols[i];
    }
    case 'union': {
      const i = readInt(st);
      if (i < 0 || i >= node.branches.length) throw new CodecError(`union branch ${i} out of range`, st.pos);
      return datum(st, node.branches[i]);
    }
    case 'record': {
      enter(st);
      const out = {};
      for (const f of node.fields) setKey(out, f.name, datum(st, f.type));
      leave(st);
      return out;
    }
    case 'array':
    case 'map': {
      enter(st);
      const isMap = node.type === 'map';
      const out = isMap ? {} : [];
      for (;;) {
        let count = readLongBig(st);
        if (count === 0n) break;
        if (count < 0n) {
          count = -count;
          readLongBig(st); // block size in bytes, only useful for skipping
        }
        if (count > BigInt(st.maxItems)) throw new CodecError(`block of ${count} items exceeds the item budget`, st.pos);
        const n = Number(count);
        spend(st, n); // zero-byte items (nulls) must still count against the budget
        for (let i = 0; i < n; i++) {
          if (isMap) {
            const k = text(st, take(st, readCount(st, 'map key')));
            setKey(out, k, datum(st, node.values));
          } else out.push(datum(st, node.items));
        }
      }
      leave(st);
      return out;
    }
    default:
      throw new CodecError(`cannot decode schema type "${node.type}"`);
  }
}

/** Decode one Avro datum from `buf` with a compiled schema; the whole buffer must be consumed. */
function decodeAvro(compiled, buf, limits = {}) {
  let body = buf;
  let headerNote = null;
  if (buf.length >= 10 && buf[0] === 0xc3 && buf[1] === 0x01) {
    const fp = buf.readBigUInt64LE(2);
    if (fp === compiled.fingerprint) body = buf.subarray(10);
    else headerNote = `starts like a single-object header, but its fingerprint ${fp.toString(16)} is not this schema's (${compiled.fingerprint.toString(16)})`;
  }
  const st = makeState(body, limits);
  try {
    const v = datum(st, compiled.root);
    if (st.pos !== body.length) throw new CodecError(`${body.length - st.pos} trailing byte(s) after the datum`, st.pos);
    return v;
  } catch (error) {
    if (headerNote && error instanceof CodecError) throw new CodecError(`${error.message}; the payload ${headerNote}`);
    throw error;
  }
}

module.exports = { compileAvro, decodeAvro, canonicalForm, fingerprint64, SchemaError };
