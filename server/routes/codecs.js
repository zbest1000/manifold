const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { PayloadCodecs, compileCodec, CODEC_TYPES } = require('../services/payloadCodecs');
const router = express.Router();

// Payload codecs: user-supplied Protobuf/Avro schemas mapped to topic filters,
// decoded on ingest so binary telemetry shows as structured JSON instead of a
// base64 blob. Sparkplug (spBv1.0) has its own decoder and never uses these.

// Wire the registry into the live services at mount time — index.js mounts
// with `app.use('/api/codecs', codecRoutes.init(app.locals.services))` so
// codecs restored from disk decode from the very first message, not from the
// first API request.
router.init = (services) => {
  services.codecs = new PayloadCodecs({ profiles: services.profiles });
  services.mqttManager.codecs = services.codecs;
  return router;
};

// GET /api/codecs — registered codecs + per-codec { decoded, errors, lastError }
router.get('/', (req, res) => {
  const { profiles, codecs } = req.app.locals.services;
  res.json({ codecs: profiles.listIn('codecs'), counters: codecs.getCounters() });
});

// POST /api/codecs { id?, name?, type, brokerId?, filter, messageType?, schemaText, enabled? }
// brokerId omitted/null = any broker; messageType is required for protobuf.
// The schema is compiled BEFORE persisting — an uncompilable codec is rejected
// with the compiler's message and never reaches the hot path.
router.post('/', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { id, name, type, brokerId, filter, messageType, schemaText, enabled } = req.body || {};
  if (!filter || typeof filter !== 'string') {
    return res.status(400).json({ error: 'filter (MQTT topic filter) is required' });
  }
  if (!CODEC_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${CODEC_TYPES.join(', ')}` });
  }
  const codec = {
    name: name || null,
    type,
    brokerId: brokerId || null,
    filter,
    messageType: messageType || null,
    schemaText,
    enabled: enabled !== false
  };
  try {
    compileCodec(codec);
  } catch (error) {
    return res.status(400).json({ error: `schema failed to compile: ${error.message}` });
  }
  const saved = profiles.upsertIn('codecs', id || uuidv4(), codec);
  res.status(201).json(saved);
});

// DELETE /api/codecs/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('codecs', req.params.id)) {
    return res.status(404).json({ error: 'Codec not found' });
  }
  res.json({ removed: req.params.id });
});

module.exports = router;
