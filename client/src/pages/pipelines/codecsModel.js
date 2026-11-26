/**
 * Pure helpers for the Codecs tab (tested in src/test/codecsModel.test.js).
 * The server is the authority on schemas (it compiles them on save); these only
 * shape the form and the table.
 */

export const CODEC_OPTIONS = [
  { value: 'cbor', label: 'CBOR', hint: 'RFC 8949 binary JSON-like data.' },
  { value: 'msgpack', label: 'MessagePack', hint: 'Compact binary maps and arrays.' },
  { value: 'senml-json', label: 'SenML (JSON)', hint: 'RFC 8428 sensor packs; base name, time and unit are resolved into records.' },
  { value: 'senml-cbor', label: 'SenML (CBOR)', hint: 'RFC 8428 packs with integer labels.' },
  { value: 'protobuf', label: 'Protobuf', hint: 'Needs the .proto schema and, when it defines several messages, the message type.' },
  { value: 'avro', label: 'Avro', hint: 'Needs the Avro JSON schema. A single-object header (C3 01) is optional.' },
  { value: 'raw', label: 'Raw (no decoding)', hint: 'Keeps matching payloads exactly as they arrive and turns auto-detection off for them.' }
];

export const SCHEMA_CODECS = new Set(['protobuf', 'avro']);
export const MAX_SCHEMA_BYTES = 128 * 1024;

export const codecLabel = (id) => CODEC_OPTIONS.find((o) => o.value === id)?.label || id || '—';

/** An empty form, or the form for an existing binding. */
export function formFor(binding) {
  if (!binding) return { id: null, rev: undefined, name: '', brokerId: '', filter: '', codec: 'cbor', schemaText: '', messageType: '', enabled: true };
  return {
    id: binding.id,
    rev: binding.rev,
    name: binding.name || '',
    brokerId: binding.brokerId || '',
    filter: binding.filter || '',
    codec: binding.codec || 'cbor',
    schemaText: binding.schemaText || '',
    messageType: binding.messageType || '',
    enabled: binding.enabled !== false
  };
}

/** Byte length of a string as UTF-8. */
export const utf8Bytes = (s) => new TextEncoder().encode(String(s || '')).length;

/** Field errors the form can know before the server compiles the schema: { filter?, schemaText? }. */
export function formErrors(form) {
  const errors = {};
  const f = form.filter.trim();
  if (!f) errors.filter = 'Enter the topic filter the codec applies to, for example plant/+/pump/#.';
  else {
    const parts = f.split('/');
    if (parts.some((p, i) => p.includes('#') && (p !== '#' || i !== parts.length - 1))) errors.filter = 'A # wildcard must be a whole, final level (plant/#).';
    else if (parts.some((p) => p.includes('+') && p !== '+')) errors.filter = 'A + wildcard must be a whole level (plant/+/pump).';
  }
  if (SCHEMA_CODECS.has(form.codec)) {
    if (!form.schemaText.trim()) errors.schemaText = form.codec === 'protobuf' ? 'Paste or upload the .proto schema.' : 'Paste or upload the Avro schema (JSON).';
    else if (utf8Bytes(form.schemaText) > MAX_SCHEMA_BYTES) errors.schemaText = `The schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB.`;
  }
  return errors;
}

/** The request body for POST /api/codecs. */
export function toRequest(form) {
  const usesSchema = SCHEMA_CODECS.has(form.codec);
  const body = {
    name: form.name.trim() || null,
    brokerId: form.brokerId || null,
    filter: form.filter.trim(),
    codec: form.codec,
    schemaText: usesSchema ? form.schemaText : null,
    messageType: form.codec === 'protobuf' && form.messageType.trim() ? form.messageType.trim() : null,
    enabled: form.enabled
  };
  if (form.id) {
    body.id = form.id;
    if (form.rev !== undefined) body.rev = form.rev;
  }
  return body;
}

/** State of a binding row: { tone, label, detail? }. */
export function bindingState(binding, counter) {
  if (binding.broken?.length) return { tone: 'bad', label: 'Broken reference', detail: binding.broken.map((b) => `${b.kind} "${b.id}" is missing`).join(', ') };
  if (counter?.compileError) return { tone: 'bad', label: 'Schema error', detail: counter.compileError };
  if (binding.enabled === false) return { tone: 'neutral', label: 'Disabled' };
  if (counter?.failed && counter.lastErrorAt && (!counter.lastDecodedAt || counter.lastErrorAt > counter.lastDecodedAt)) {
    return { tone: 'warn', label: 'Failing', detail: counter.lastError };
  }
  if (binding.codec === 'raw') return { tone: 'neutral', label: 'Kept raw' };
  return { tone: counter?.decoded ? 'good' : 'neutral', label: counter?.decoded ? 'Decoding' : 'Waiting for data' };
}

/** "Decoded by Protobuf (binding Pumps)" / "Auto-detected CBOR" for the topic detail. */
export function codecCaption(codec) {
  if (!codec) return null;
  if (codec.auto) return `Auto-detected ${codecLabel(codec.name)}`;
  return `Decoded by ${codecLabel(codec.name)}${codec.binding ? ` (binding ${codec.binding})` : ''}`;
}

/** Normalise a payload typed in the test box for display of its size: hex digits -> bytes, base64 -> bytes. */
export function payloadSize(text, encoding) {
  const s = String(text || '');
  if (encoding === 'text') return utf8Bytes(s);
  if (encoding === 'base64') {
    const clean = s.replace(/\s+/g, '').replace(/=+$/, '');
    return Math.floor((clean.length * 3) / 4);
  }
  const clean = s.replace(/0x/gi, '').replace(/[\s:,]+/g, '');
  return /^[0-9a-fA-F]*$/.test(clean) ? Math.floor(clean.length / 2) : null;
}
