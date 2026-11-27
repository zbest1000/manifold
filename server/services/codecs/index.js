'use strict';

/**
 * Payload codecs: decode non-JSON MQTT payloads on ingest so topics, Trends,
 * mappings, pipelines and recordings see values instead of a base64 blob.
 *
 * Two ways a payload gets decoded, both in mqttManager.buildMessage (once per
 * touched topic per flush, never on the socket read path of the broker):
 *
 *  1. A codec binding (stored in the profile store's `codecs` collection):
 *     topic filter (+ optional broker) -> codec, with a schema for Protobuf and
 *     Avro. The most specific matching filter wins (fewer wildcards, then more
 *     levels, then the name). A binding is tried before the JSON/text
 *     detection, because a Protobuf or Avro payload can be valid UTF-8.
 *  2. Auto-detection, for payloads with no binding that are not valid UTF-8
 *     (what the explorer shows as binary today): CBOR and MessagePack only.
 *     It is conservative: the bytes must decode completely, as exactly one map
 *     or array, under exactly one of the two formats; anything else stays
 *     binary exactly as before. Text and JSON never reach it. Sparkplug topics
 *     never reach either path (they have their own decoder).
 *     MANIFOLD_CODEC_AUTODETECT=0 turns it off; a binding with codec "raw"
 *     turns it off for a filter.
 *
 * A failed decode never blocks ingest: the error is counted on the binding and
 * the payload falls through to the normal JSON/text/binary handling.
 *
 * Bounds per payload: MANIFOLD_CODEC_MAX_BYTES (default 256 KiB; bigger
 * payloads are not decoded), nesting depth 32, 100,000 items. Decode work is
 * linear in the payload size.
 */

const { DEFAULT_LIMITS, CodecError } = require('./common');
const { decodeCbor } = require('./cbor');
const { decodeMsgpack } = require('./msgpack');
const { resolveSenml, fromCborLabels, packTime } = require('./senml');
const { compileAvro, decodeAvro } = require('./avro');
const { compileProtobuf, decodeProtobuf } = require('./protobuf');
const { matchParts, compiledView } = require('../mqttMatch');

const CODECS = ['cbor', 'msgpack', 'senml-json', 'senml-cbor', 'protobuf', 'avro', 'raw'];
const CODEC_LABELS = {
  cbor: 'CBOR',
  msgpack: 'MessagePack',
  'senml-json': 'SenML (JSON)',
  'senml-cbor': 'SenML (CBOR)',
  protobuf: 'Protobuf',
  avro: 'Avro',
  raw: 'Raw (no decoding)'
};
const SCHEMA_CODECS = new Set(['protobuf', 'avro']);
const MAX_SCHEMA_BYTES = 128 * 1024;

function envLimits() {
  const maxBytes = Number(process.env.MANIFOLD_CODEC_MAX_BYTES);
  return { ...DEFAULT_LIMITS, maxBytes: Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LIMITS.maxBytes };
}

/**
 * Compile a binding's codec into `(buffer, limits) -> { value, sourceTimestamp? }`.
 * Throws an Error whose message says what is wrong with the schema.
 */
function compileCodec({ codec, schemaText, messageType } = {}) {
  if (!CODECS.includes(codec)) throw new Error(`codec must be one of ${CODECS.join(', ')}`);
  if (SCHEMA_CODECS.has(codec)) {
    if (typeof schemaText !== 'string' || !schemaText.trim()) throw new Error(`a ${CODEC_LABELS[codec]} codec needs a schema`);
    if (Buffer.byteLength(schemaText) > MAX_SCHEMA_BYTES) throw new Error(`the schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB`);
  }
  switch (codec) {
    case 'cbor':
      return { decode: (buf, lim) => ({ value: decodeCbor(buf, lim) }) };
    case 'msgpack':
      return { decode: (buf, lim) => ({ value: decodeMsgpack(buf, lim) }) };
    case 'senml-json':
      return {
        decode: (buf) => {
          let pack;
          try {
            pack = JSON.parse(buf.toString('utf8'));
          } catch (error) {
            throw new CodecError(`not JSON: ${error.message}`);
          }
          const records = resolveSenml(pack);
          return { value: records, sourceTimestamp: packTime(records) };
        }
      };
    case 'senml-cbor':
      return {
        decode: (buf, lim) => {
          const records = resolveSenml(fromCborLabels(decodeCbor(buf, lim, { rawBytes: true })));
          return { value: records, sourceTimestamp: packTime(records) };
        }
      };
    case 'protobuf': {
      const compiled = compileProtobuf(schemaText, messageType);
      return { decode: (buf, lim) => ({ value: decodeProtobuf(compiled, buf, lim) }), messageType: compiled.messageType, messageTypes: compiled.messageTypes };
    }
    case 'avro': {
      const compiled = compileAvro(schemaText);
      return { decode: (buf, lim) => ({ value: decodeAvro(compiled, buf, lim) }), fingerprint: compiled.fingerprint.toString(16).padStart(16, '0') };
    }
    case 'raw':
      return { decode: null };
    default:
      throw new Error(`unknown codec ${codec}`);
  }
}

const isContainer = (v) => v !== null && typeof v === 'object';

/** Is a byte sequence valid UTF-8? */
const strict = new TextDecoder('utf-8', { fatal: true });
function isUtf8(buf) {
  try {
    strict.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Conservative auto-detection of CBOR / MessagePack. Returns { codec, value }
 * or null (leave the payload as it is). Only for bytes that are not valid
 * UTF-8, decode completely as one container under exactly one format.
 */
function autodetect(buf, limits = envLimits()) {
  if (buf.length < 2 || buf.length > limits.maxBytes || isUtf8(buf)) return null;
  let cbor = null;
  let msgpack = null;
  try {
    const v = decodeCbor(buf, limits);
    if (isContainer(v)) cbor = v;
  } catch {
    // not CBOR
  }
  // CBOR's self-describe tag (D9 D9 F7) settles it.
  if (cbor !== null && buf[0] === 0xd9 && buf[1] === 0xd9 && buf[2] === 0xf7) return { codec: 'cbor', value: cbor };
  try {
    const v = decodeMsgpack(buf, limits);
    if (isContainer(v)) msgpack = v;
  } catch {
    // not MessagePack
  }
  if (cbor !== null && msgpack === null) return { codec: 'cbor', value: cbor };
  if (msgpack !== null && cbor === null) return { codec: 'msgpack', value: msgpack };
  return null; // neither, or ambiguous
}

/** Order bindings: exact topics first, then fewer wildcards, then more levels, then name. */
function specificity(parts) {
  let wild = 0;
  for (const p of parts) if (p === '+' || p === '#') wild += p === '#' ? 2 : 1;
  return { wild, levels: parts.length };
}

class PayloadCodecs {
  constructor({ profiles, autodetect: auto = process.env.MANIFOLD_CODEC_AUTODETECT !== '0', limits = envLimits() } = {}) {
    this.profiles = profiles;
    this.autodetectEnabled = auto;
    this.limits = limits;
    this.counters = new Map(); // bindingId -> { decoded, failed, lastError, lastErrorAt, lastDecodedAt, compileError }
    this.auto = { cbor: 0, msgpack: 0, skippedLarge: 0 };
    this.table = compiledView(profiles, () => this._build());
  }

  /** Revision of the compiled table (changes when a binding changes): read-path caches key on it. */
  get rev() {
    return this.profiles.rev ?? 0;
  }

  _build() {
    const rows = [];
    for (const b of this.profiles.listIn('codecs')) {
      const c = this._counter(b.id);
      c.compileError = null;
      if (b.enabled === false || typeof b.filter !== 'string' || !b.filter) continue;
      try {
        const compiled = compileCodec(b);
        const parts = b.filter.split('/');
        rows.push({ binding: b, parts, ...specificity(parts), decode: compiled.decode });
      } catch (error) {
        // A hand-edited or imported config must turn off this binding, not every binding.
        c.compileError = error.message;
      }
    }
    rows.sort((a, b) => a.wild - b.wild || b.levels - a.levels || String(a.binding.name || '').localeCompare(String(b.binding.name || '')));
    return rows;
  }

  _counter(id) {
    let c = this.counters.get(id);
    if (!c) {
      c = { decoded: 0, failed: 0, lastError: null, lastErrorAt: null, lastDecodedAt: null, compileError: null };
      this.counters.set(id, c);
    }
    return c;
  }

  hasBindings() {
    return this.table().length > 0;
  }

  /** The binding row that applies to a topic, or null. */
  match(brokerId, topicParts) {
    for (const row of this.table()) {
      if (row.binding.brokerId && row.binding.brokerId !== brokerId) continue;
      if (matchParts(row.parts, topicParts)) return row;
    }
    return null;
  }

  /**
   * Decode with the binding that matches `topic`, if any.
   * Returns null (no binding), { raw: true } (a "raw" binding: do not decode or
   * auto-detect), { value, codec, sourceTimestamp? } or { error, codec }.
   * `count` false leaves the counters alone (read path).
   */
  decodeBound(brokerId, topic, buf, { count = true } = {}) {
    if (!this.hasBindings()) return null;
    const row = this.match(brokerId, topic.split('/'));
    if (!row) return null;
    const b = row.binding;
    const codec = { name: b.codec, bindingId: b.id, binding: b.name || b.filter };
    if (!row.decode) return { raw: true, codec };
    const c = count ? this._counter(b.id) : null;
    if (buf.length > this.limits.maxBytes) {
      const error = `payload of ${buf.length} bytes is larger than the ${this.limits.maxBytes}-byte decode limit`;
      if (c) Object.assign(c, { failed: c.failed + 1, lastError: error, lastErrorAt: Date.now() });
      return { error, codec };
    }
    try {
      const out = row.decode(buf, this.limits);
      if (c) {
        c.decoded++;
        c.lastDecodedAt = Date.now();
      }
      return { ...out, codec };
    } catch (err) {
      const error = err instanceof CodecError || err?.name === 'SchemaError' ? err.message : `decode failed: ${err?.message || err}`;
      if (c) Object.assign(c, { failed: c.failed + 1, lastError: error, lastErrorAt: Date.now() });
      return { error, codec };
    }
  }

  /** Auto-detect CBOR / MessagePack in a binary payload without a binding. */
  decodeAuto(buf, { count = true } = {}) {
    if (!this.autodetectEnabled) return null;
    if (buf.length > this.limits.maxBytes) {
      if (count) this.auto.skippedLarge++;
      return null;
    }
    const hit = autodetect(buf, this.limits);
    if (!hit) return null;
    if (count) this.auto[hit.codec]++;
    return { value: hit.value, codec: { name: hit.codec, auto: true } };
  }

  getCounters() {
    return Object.fromEntries(this.counters);
  }

  getStatus() {
    return { autodetect: this.autodetectEnabled, auto: { ...this.auto }, limits: { ...this.limits, maxSchemaBytes: MAX_SCHEMA_BYTES }, counters: this.getCounters() };
  }
}

/**
 * One-off decode for the test box: a codec (+ schema) or "auto", on bytes.
 * Returns { ok: true, value, codec, bytes, sourceTimestamp? } or { ok: false, error, bytes }.
 */
function testDecode({ codec, schemaText, messageType }, buf, limits = envLimits()) {
  if (buf.length > limits.maxBytes) return { ok: false, bytes: buf.length, error: `payload of ${buf.length} bytes is larger than the ${limits.maxBytes}-byte decode limit` };
  if (codec === 'auto') {
    const hit = autodetect(buf, limits);
    if (hit) return { ok: true, bytes: buf.length, codec: hit.codec, value: hit.value };
    return { ok: false, bytes: buf.length, error: isUtf8(buf) ? 'the payload is valid UTF-8 text, so auto-detection leaves it as text or JSON' : 'not recognised as CBOR or MessagePack (or it decodes as both); it stays binary' };
  }
  let compiled;
  try {
    compiled = compileCodec({ codec, schemaText, messageType });
  } catch (error) {
    return { ok: false, bytes: buf.length, error: error.message, schemaError: true };
  }
  if (!compiled.decode) return { ok: false, bytes: buf.length, error: 'the raw codec does not decode' };
  try {
    const out = compiled.decode(buf, limits);
    return { ok: true, bytes: buf.length, codec, ...out };
  } catch (error) {
    return { ok: false, bytes: buf.length, error: error.message };
  }
}

module.exports = { PayloadCodecs, compileCodec, autodetect, testDecode, CODECS, CODEC_LABELS, SCHEMA_CODECS, MAX_SCHEMA_BYTES, isUtf8 };
