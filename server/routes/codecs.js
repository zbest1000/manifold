const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage, brokenRefs } = require('../services/references');
const { filterProblem } = require('../services/mqttMatch');
const { redactSecrets } = require('../services/secrets');
const { compileCodec, testDecode, CODECS, CODEC_LABELS, SCHEMA_CODECS, MAX_SCHEMA_BYTES } = require('../services/codecs');

// Payload codec bindings: topic filter (+ optional broker) -> codec, with a
// schema for Protobuf and Avro. Decoding happens on ingest (services/codecs).

const MAX_NAME = 120;
const MAX_MESSAGE_TYPE = 256;

/** Bytes from the test box: hex (spaces, colons and 0x allowed), base64, or text. */
function payloadBytes(payload, encoding) {
  if (typeof payload !== 'string') throw new Error('payload must be a string');
  if (encoding === 'text') return Buffer.from(payload, 'utf8');
  if (encoding === 'base64') {
    const clean = payload.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new Error('payload is not valid base64');
    return Buffer.from(clean.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  const clean = payload.replace(/0x/gi, '').replace(/[\s:,]+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('payload is not valid hex (use 0-9 and a-f, spaces allowed)');
  if (clean.length % 2) throw new Error('hex payload has an odd number of digits');
  return Buffer.from(clean, 'hex');
}

const present = (b) => redactSecrets(b);

// GET /api/codecs — bindings, per-binding counters, auto-detection status and limits
router.get('/', (req, res) => {
  const { profiles, codecs, mqttManager } = req.app.locals.services;
  const status = codecs.getStatus();
  res.json({
    codecs: profiles.listIn('codecs').map((b) => {
      const broken = brokenRefs('codecs', b, { profiles, mqttManager });
      return broken.length ? { ...present(b), broken } : present(b);
    }),
    counters: status.counters,
    autodetect: status.autodetect,
    auto: status.auto,
    limits: status.limits,
    available: CODECS.map((id) => ({ id, label: CODEC_LABELS[id], schema: SCHEMA_CODECS.has(id) }))
  });
});

// POST /api/codecs { id?, name?, brokerId?, filter, codec, schemaText?, messageType?, enabled?, rev? }
// The schema is compiled before anything is stored; a schema that does not
// compile is refused with the parser's message.
router.post('/', (req, res) => {
  const { profiles, mqttManager } = req.app.locals.services;
  const body = req.body || {};
  const { id, name, brokerId, filter, codec, schemaText, messageType, enabled } = body;
  const expectRev = checkpoint(req, res, profiles, 'codecs', id, () => profiles.getIn('codecs', id));
  if (expectRev === false) return;
  const problem = filterProblem(filter);
  if (problem) return res.status(400).json({ error: `filter ${problem}` });
  if (!CODECS.includes(codec)) return res.status(400).json({ error: `codec must be one of ${CODECS.join(', ')}` });
  if (name != null && (typeof name !== 'string' || name.length > MAX_NAME)) return res.status(400).json({ error: `name must be text of at most ${MAX_NAME} characters` });
  if (brokerId != null && brokerId !== '' && typeof brokerId !== 'string') return res.status(400).json({ error: 'brokerId must be a string' });
  if (messageType != null && (typeof messageType !== 'string' || messageType.length > MAX_MESSAGE_TYPE)) {
    return res.status(400).json({ error: `messageType must be text of at most ${MAX_MESSAGE_TYPE} characters` });
  }
  const usesSchema = SCHEMA_CODECS.has(codec);
  if (usesSchema) {
    if (typeof schemaText !== 'string' || !schemaText.trim()) return res.status(400).json({ error: `a ${CODEC_LABELS[codec]} binding needs a schema` });
    const bytes = Buffer.byteLength(schemaText);
    if (bytes > MAX_SCHEMA_BYTES) return res.status(413).json({ error: `the schema is ${Math.ceil(bytes / 1024)} KiB; the limit is ${MAX_SCHEMA_BYTES / 1024} KiB` });
  }
  let compiled;
  try {
    compiled = compileCodec({ codec, schemaText, messageType });
  } catch (error) {
    return res.status(400).json({ error: `schema error: ${error.message}`, schemaError: true });
  }
  const next = {
    name: name ? name.trim() : null,
    brokerId: brokerId || null,
    filter,
    codec,
    schemaText: usesSchema ? schemaText : null,
    messageType: codec === 'protobuf' ? compiled.messageType : null,
    enabled: enabled !== false
  };
  const missing = missingRefsMessage('codecs', next, { profiles, mqttManager });
  if (missing) return res.status(400).json({ error: missing });
  let saved;
  try {
    saved = profiles.upsertIn('codecs', id || uuidv4(), next, { expectRev });
  } catch (error) {
    if (handleRevisionError(res, error, present)) return;
    throw error;
  }
  res.status(201).json(present(saved));
});

// DELETE /api/codecs/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('codecs', req.params.id)) return res.status(404).json({ error: 'Codec binding not found' });
  res.json({ removed: req.params.id });
});

// POST /api/codecs/test { codec: 'auto'|<codec>, schemaText?, messageType?, bindingId?, payload, encoding: 'hex'|'base64'|'text' }
// One-off decode for the test box. Read-only: nothing is stored or counted.
router.post('/test', (req, res) => {
  const { profiles, codecs } = req.app.locals.services;
  const body = req.body || {};
  let spec = { codec: body.codec, schemaText: body.schemaText, messageType: body.messageType };
  if (body.bindingId) {
    const b = profiles.getIn('codecs', body.bindingId);
    if (!b) return res.status(404).json({ error: 'Codec binding not found' });
    spec = { codec: b.codec, schemaText: b.schemaText, messageType: b.messageType };
  }
  if (spec.codec !== 'auto' && !CODECS.includes(spec.codec)) return res.status(400).json({ error: `codec must be auto or one of ${CODECS.join(', ')}` });
  if (typeof spec.schemaText === 'string' && Buffer.byteLength(spec.schemaText) > MAX_SCHEMA_BYTES) {
    return res.status(413).json({ error: `the schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB` });
  }
  if (!['hex', 'base64', 'text', undefined].includes(body.encoding)) return res.status(400).json({ error: 'encoding must be hex, base64 or text' });
  let buf;
  try {
    buf = payloadBytes(body.payload, body.encoding || 'hex');
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!buf.length) return res.status(400).json({ error: 'payload is empty' });
  res.json(testDecode(spec, buf, codecs.limits));
});

module.exports = router;
module.exports.payloadBytes = payloadBytes;
