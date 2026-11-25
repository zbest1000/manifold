const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage, brokenRefs } = require('../services/references');

// Schema contracts: lock a topic's payload shape, watch for drift.

// GET /api/contracts
router.get('/', (req, res) => {
  const { profiles, contracts, mqttManager } = req.app.locals.services;
  res.json({
    contracts: profiles.listIn('contracts').map((c) => {
      const broken = brokenRefs('contracts', c, { profiles, mqttManager });
      return broken.length ? { ...c, broken } : c;
    }),
    counters: contracts.getCounters()
  });
});

// POST /api/contracts/infer { brokerId, topic } — schema from the latest payload
router.post('/infer', (req, res) => {
  const { contracts } = req.app.locals.services;
  const { brokerId, topic } = req.body || {};
  if (!brokerId || !topic) return res.status(400).json({ error: 'brokerId and topic are required' });
  const schema = contracts.inferFromTopic(brokerId, topic);
  if (!schema) return res.status(404).json({ error: 'no observed payload for that topic' });
  res.json({ topic, schema });
});

// POST /api/contracts { id?, name, brokerId, filter, schema, enabled? }
router.post('/', (req, res) => {
  const { profiles, mqttManager } = req.app.locals.services;
  const { id, name, brokerId, filter, schema, enabled } = req.body || {};
  const expectRev = checkpoint(req, res, profiles, 'contracts', id, () => profiles.getIn('contracts', id));
  if (expectRev === false) return;
  if (!brokerId || !filter) return res.status(400).json({ error: 'brokerId and filter are required' });
  if (!schema || typeof schema !== 'object' || !schema.type) {
    return res.status(400).json({ error: 'schema is required (use POST /api/contracts/infer to derive one)' });
  }
  const next = {
    name: name || null,
    brokerId,
    filter,
    schema,
    lockedAt: new Date().toISOString(),
    enabled: enabled !== false
  };
  const missing = missingRefsMessage('contracts', next, { profiles, mqttManager });
  if (missing) return res.status(400).json({ error: missing });
  let saved;
  try {
    saved = profiles.upsertIn('contracts', id || uuidv4(), next, { expectRev });
  } catch (error) {
    if (handleRevisionError(res, error, (x) => x)) return;
    throw error;
  }
  res.status(201).json(saved);
});

// DELETE /api/contracts/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('contracts', req.params.id)) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json({ removed: req.params.id });
});

// GET /api/contracts/violations?limit=200 — drift events, newest first
router.get('/violations', (req, res) => {
  const { contracts } = req.app.locals.services;
  res.json({ violations: contracts.getViolations(Math.min(Number(req.query.limit) || 200, 500)) });
});

module.exports = router;
