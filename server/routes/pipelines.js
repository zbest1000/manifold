const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const { filterProblem, topicProblem } = require('../services/mqttMatch');
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage, brokenRefs } = require('../services/references');

// Pipeline routes: source → transforms → target, persisted in profiles and
// executed by the PipelineEngine on the live (coalesced) message stream.

const TRANSFORM_TYPES = ['repath', 'pick', 'rename', 'set', 'scale', 'numeric', 'sparkplugFlatten', 'envelope'];

function validateRoute(body) {
  if (!body.source?.brokerId || !body.source?.filter) return 'source.brokerId and source.filter are required';
  const fp = filterProblem(body.source.filter);
  if (fp) return `source filter "${body.source.filter}" ${fp}`;
  const target = body.target || {};
  if (target.type === 'mqtt') {
    if (!target.brokerId) return 'target.brokerId is required for mqtt targets';
  } else if (target.type === 'historian') {
    if (!target.historianId) return 'target.historianId is required for historian targets';
  } else {
    return 'target.type must be "mqtt" or "historian"';
  }
  for (const t of body.transforms || []) {
    if (!TRANSFORM_TYPES.includes(t.type)) return `unknown transform type "${t.type}" (supported: ${TRANSFORM_TYPES.join(', ')})`;
    if (t.type === 'repath') {
      // {1} {2-} {topic} are placeholders; whatever is left is the literal output topic
      const literal = String(t.to ?? '').replace(/\{[^}]*\}/g, 'x');
      const tp = topicProblem(literal);
      if (tp) return `repath target "${t.to ?? ''}" ${tp}`;
    }
  }
  return null;
}

// GET /api/pipelines — routes + live metrics + store-and-forward outbox health
router.get('/', (req, res) => {
  const { profiles, pipelines, outbox } = req.app.locals.services;
  const { mqttManager } = req.app.locals.services;
  res.json({
    // `broken`: references that no longer exist (deleted broker/historian) - the route cannot run until fixed.
    routes: profiles.listIn('pipelines').map((r) => {
      const broken = brokenRefs('pipelines', r, { profiles, mqttManager });
      return broken.length ? { ...r, broken } : r;
    }),
    metrics: pipelines.getMetrics(),
    outbox: outbox ? outbox.getStats() : {},
    transformTypes: TRANSFORM_TYPES
  });
});

// POST /api/pipelines { id?, rev?, name, enabled, source, transforms, target } - with an id it replaces that route;
// `rev` (or If-Match) makes a stale replace a 409 { code:'stale', current }.
router.post('/', (req, res) => {
  const { profiles, mqttManager } = req.app.locals.services;
  const body = req.body || {};
  const id = body.id || uuidv4();
  const expectRev = checkpoint(req, res, profiles, 'pipelines', body.id, () => profiles.getIn('pipelines', body.id));
  if (expectRev === false) return;
  const problem = validateRoute(body) || missingRefsMessage('pipelines', body, { profiles, mqttManager });
  if (problem) return res.status(400).json({ error: problem });
  let saved;
  try {
    saved = profiles.upsertIn('pipelines', id, {
      name: body.name || null,
      enabled: body.enabled !== false,
      source: { brokerId: body.source.brokerId, filter: body.source.filter },
      transforms: body.transforms || [],
      target: body.target
    }, { expectRev });
  } catch (error) {
    if (handleRevisionError(res, error, (x) => x)) return;
    throw error;
  }
  res.status(201).json(saved);
});

// DELETE /api/pipelines/:id
router.delete('/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('pipelines', req.params.id)) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.json({ removed: req.params.id });
});

// POST /api/pipelines/preview { route, sampleLimit? } — dry-run an (unsaved)
// route definition against observed topics; nothing is published.
router.post('/preview', (req, res) => {
  const { pipelines } = req.app.locals.services;
  const { route, sampleLimit } = req.body || {};
  if (!route) return res.status(400).json({ error: 'route is required' });
  const problem = validateRoute(route);
  if (problem) return res.status(400).json({ error: problem });
  res.json(pipelines.preview(route, { sampleLimit: Math.min(Number(sampleLimit) || 25, 200) }));
});

module.exports = router;
