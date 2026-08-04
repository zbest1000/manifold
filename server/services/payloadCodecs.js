'use strict';

const protobuf = require('protobufjs');
const avsc = require('avsc');
const { matchParts, compiledView } = require('./mqttMatch');

/**
 * Payload codec registry — user-supplied Protobuf/Avro schemas mapped to MQTT
 * topic filters, applied at ingest so binary telemetry shows up as structured
 * JSON instead of a base64 blob.
 *
 * The manager consults `decode()` in buildMessage BEFORE its generic JSON/text
 * detection (see mqttManager.buildMessage), so this sits on the hot path:
 * entries are compiled into a matcher table via the shared compiledView
 * pattern (pre-split filter segments, schema compiled once, rebuilt only when
 * profiles.rev changes) and the per-message cost when nothing is registered is
 * a single length check.
 *
 * Failure posture: a bad schema or a buffer that doesn't decode must NEVER
 * break ingest — decode() counts the error and returns null, and the message
 * falls through to the normal JSON/text path. Sparkplug traffic never reaches
 * this registry at all (the manager guards with isSparkplugTopic).
 */

const CODEC_TYPES = ['protobuf', 'avro'];

/**
 * Compile a codec entry into a `(buffer) -> plain object` decoder. Throws with
 * a human-readable message on a bad schema — the save route relies on that to
 * reject uncompilable codecs with a 400 before they are ever persisted.
 */
function compileCodec(codec = {}) {
  if (!codec.schemaText || typeof codec.schemaText !== 'string') {
    throw new Error('schemaText is required');
  }
  if (codec.type === 'protobuf') {
    if (!codec.messageType) {
      throw new Error('messageType (fully-qualified message name) is required for protobuf codecs');
    }
    // keepCase so the decoded JSON carries field names exactly as written in
    // the .proto — operators grep for the names they authored, not camelCase.
    const { root } = protobuf.parse(codec.schemaText, { keepCase: true });
    const Message = root.lookupType(codec.messageType); // throws "no such type" when absent
    return (buffer) =>
      Message.toObject(Message.decode(buffer), { longs: Number, enums: String, bytes: String, defaults: true });
  }
  if (codec.type === 'avro') {
    const type = avsc.Type.forSchema(JSON.parse(codec.schemaText));
    // fromBuffer validates the whole buffer is consumed, so trailing garbage
    // throws instead of silently decoding to nonsense.
    return (buffer) => type.fromBuffer(buffer);
  }
  throw new Error(`type must be one of ${CODEC_TYPES.join(', ')}`);
}

class PayloadCodecs {
  constructor({ profiles }) {
    this.profiles = profiles;
    this.counters = new Map(); // codecId -> { decoded, errors, lastError }
    this.table = compiledView(profiles, () => {
      const rows = [];
      for (const codec of this.profiles.listIn('codecs')) {
        if (codec.enabled === false || !codec.filter) continue;
        try {
          rows.push({ codec, parts: String(codec.filter).split('/'), decode: compileCodec(codec) });
        } catch (error) {
          // Saved via the API this can't happen (save compiles first), but a
          // hand-edited profiles.json must degrade to "this codec is off",
          // never "no codec works" — surface it on the codec's counter.
          this._counter(codec.id).lastError = `schema failed to compile: ${error.message}`;
        }
      }
      return rows;
    });
  }

  _counter(id) {
    let c = this.counters.get(id);
    if (!c) {
      c = { decoded: 0, errors: 0, lastError: null };
      this.counters.set(id, c);
    }
    return c;
  }

  /**
   * Hot path — first matching codec wins. Returns
   * `{ codecId, codecName, value }` on success or null when no codec matches
   * OR the matching codec fails to decode (error counted; caller falls back to
   * the normal JSON/text interpretation).
   */
  decode(brokerId, topic, buffer) {
    const table = this.table();
    if (!table.length) return null;
    const topicParts = String(topic).split('/');
    for (const { codec, parts, decode } of table) {
      if (codec.brokerId && codec.brokerId !== brokerId) continue;
      if (!matchParts(parts, topicParts)) continue;
      const c = this._counter(codec.id);
      try {
        const value = decode(buffer);
        c.decoded++;
        return { codecId: codec.id, codecName: codec.name || codec.filter, value };
      } catch (error) {
        c.errors++;
        c.lastError = error.message;
        return null;
      }
    }
    return null;
  }

  getCounters() {
    return Object.fromEntries(this.counters);
  }
}

module.exports = { PayloadCodecs, compileCodec, CODEC_TYPES };
