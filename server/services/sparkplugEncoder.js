'use strict';

const SparkplugDecoder = require('./sparkplugDecoder');

/**
 * Sparkplug B payload encoder — the outbound half of the story. Reuses the
 * decoder's protobuf schema (keepCase snake_case fields) so anything we encode
 * round-trips through our own decoder, which the tests enforce.
 *
 * Datatype mapping is deliberately minimal and honest: JS numbers → Double
 * (10), booleans → Boolean (11), strings → String (12), objects → String (12,
 * JSON), bdSeq → Int64 (4). Rich types (templates, datasets) are out of scope
 * until something needs them.
 */

const decoder = new SparkplugDecoder(); // schema parses synchronously in the constructor

const DataType = {
  Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt8: 5, UInt16: 6, UInt32: 7, UInt64: 8,
  Float: 9, Double: 10, Boolean: 11, String: 12, DateTime: 13
};

// Normalized tag types (tagSources contract) -> Sparkplug datatype.
const TYPE_MAP = {
  int8: DataType.Int8, int16: DataType.Int16, int32: DataType.Int32, int64: DataType.Int64,
  uint8: DataType.UInt8, uint16: DataType.UInt16, uint32: DataType.UInt32, uint64: DataType.UInt64,
  float32: DataType.Float, float64: DataType.Double, bool: DataType.Boolean,
  string: DataType.String, datetime: DataType.DateTime
};

/** Sparkplug datatype id for a normalized type name, or null if unknown/absent. */
function datatypeFor(type) {
  return (type && TYPE_MAP[type]) || null;
}

function to64(n, unsigned) {
  const b = BigInt.asUintN(64, BigInt(Math.trunc(n)));
  return { low: Number(b & 0xffffffffn) | 0, high: Number(b >> 32n) | 0, unsigned };
}

// Encode with an explicit datatype. Values that cannot be represented as that
// type become is_null (the datatype itself never changes - BIRTH/DATA stability).
function typedValue(dt, v) {
  const isNull = { datatype: dt, is_null: true };
  if (dt === DataType.Boolean) return { datatype: dt, boolean_value: Boolean(v) };
  if (dt === DataType.String) {
    return { datatype: dt, string_value: typeof v === 'object' ? JSON.stringify(v) : String(v) };
  }
  if (dt === DataType.DateTime) {
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(ms) ? { datatype: dt, long_value: to64(ms, true) } : isNull;
  }
  const n = typeof v === 'boolean' ? Number(v) : typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return isNull;
  if (dt === DataType.Float) return { datatype: dt, float_value: n };
  if (dt === DataType.Double) return { datatype: dt, double_value: n };
  if (dt === DataType.Int64) return { datatype: dt, long_value: to64(n, false) };
  if (dt === DataType.UInt64) return { datatype: dt, long_value: to64(n, true) };
  const bits = { 1: 8, 2: 16, 3: 32, 5: 8, 6: 16, 7: 32 }[dt];
  // Signed ints travel as their two's-complement bit pattern in uint32.
  return { datatype: dt, int_value: Number(BigInt.asUintN(bits, BigInt(Math.trunc(n)))) };
}

function metricValue(m) {
  const v = m.value;
  const dt = datatypeFor(m.type);
  if (dt) return v === null || v === undefined ? { datatype: dt, is_null: true } : typedValue(dt, v);
  if (v === null || v === undefined) return { datatype: m.datatype || DataType.String, is_null: true };
  if (typeof v === 'boolean') return { datatype: DataType.Boolean, boolean_value: v };
  if (typeof v === 'number') return { datatype: DataType.Double, double_value: v };
  if (typeof v === 'object') return { datatype: DataType.String, string_value: JSON.stringify(v) };
  return { datatype: DataType.String, string_value: String(v) };
}

/**
 * Encode a Sparkplug payload. `metrics`: [{ name, value, ts?, datatype?, type?, isBdSeq? }]; `type` is an optional
 * normalized type name (int16, float32, bool, ...) selecting the Sparkplug datatype.
 */
function encodePayload({ metrics = [], seq = null, ts = Date.now() }) {
  if (!decoder.Payload) throw new Error('Sparkplug protobuf schema unavailable');
  const payload = {
    timestamp: ts,
    metrics: metrics.map((m) => ({
      name: m.name,
      timestamp: m.ts || ts,
      ...(m.isBdSeq ? { datatype: DataType.Int64, long_value: m.value } : metricValue(m))
    }))
  };
  if (seq !== null) payload.seq = seq;
  const err = decoder.Payload.verify(payload);
  if (err) throw new Error(`invalid sparkplug payload: ${err}`);
  return Buffer.from(decoder.Payload.encode(decoder.Payload.create(payload)).finish());
}

module.exports = { encodePayload, DataType, datatypeFor };
