const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const { filterProblem } = require('../services/mqttMatch');
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage, brokenRefs } = require('../services/references');

// Recordings (time-series capture) + replay control.

// GET /api/recorder — recordings with live status
router.get('/', (req, res) => {
  const { profiles, recorder, replayer, mqttManager } = req.app.locals.services;
  res.json({
    recordings: profiles.listIn('recordings').map((r) => {
      const broken = brokenRefs('recordings', r, { profiles, mqttManager });
      return { ...r, status: recorder.getStatus(r.id), ...(broken.length ? { broken } : {}) };
    }),
    replay: replayer.getStatus()
  });
});

// Replay control — registered before the /:id routes so "replay" is never
// captured as a recording id.
// POST /api/recorder/replay { recordingId, brokerId, speed?, loop?, topicPrefix? }
router.post('/replay', async (req, res) => {
  const { replayer } = req.app.locals.services;
  try {
    res.status(202).json(await replayer.start(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/recorder/replay — stop the active replay
router.delete('/replay', (req, res) => {
  const { replayer } = req.app.locals.services;
  res.json({ stopped: replayer.stop() });
});

// POST /api/recorder { id?, name, brokerId, filter, target?, maxBytes?, enabled? }
router.post('/', (req, res) => {
  const { profiles, recorder, mqttManager } = req.app.locals.services;
  const { id, name, brokerId, filter, target, maxBytes, enabled } = req.body || {};
  const expectRev = checkpoint(req, res, profiles, 'recordings', id, () => {
    const r = profiles.getIn('recordings', id);
    return r ? { ...r, status: recorder.getStatus(id) } : null;
  });
  if (expectRev === false) return;
  if (!brokerId || !filter) return res.status(400).json({ error: 'brokerId and filter are required' });
  const fp = filterProblem(filter);
  if (fp) return res.status(400).json({ error: `filter "${filter}" ${fp}` });
  if (target && target.type === 'historian' && !target.historianId) {
    return res.status(400).json({ error: 'target.historianId is required for historian targets' });
  }
  const next = {
    name: name || null,
    brokerId,
    filter,
    target: target?.type === 'historian' ? { type: 'historian', historianId: target.historianId } : { type: 'file' },
    maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : undefined,
    enabled: enabled !== false
  };
  const missing = missingRefsMessage('recordings', next, { profiles, mqttManager });
  if (missing) return res.status(400).json({ error: missing });
  let saved;
  try {
    saved = profiles.upsertIn('recordings', id || uuidv4(), next, { expectRev });
  } catch (error) {
    if (handleRevisionError(res, error, (x) => x)) return;
    throw error;
  }
  res.status(201).json(saved);
});

// DELETE /api/recorder/:id — remove config AND its data file
router.delete('/:id', (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.removeIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  recorder.remove(req.params.id);
  res.json({ removed: req.params.id });
});

// GET /api/recorder/:id/data?topic=&from=&to=&limit= — bounded read-back
router.get('/:id/data', async (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.getIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  try {
    res.json(
      await recorder.read(req.params.id, {
        topic: req.query.topic || null,
        from: Number(req.query.from) || 0,
        to: Number(req.query.to) || Infinity,
        limit: Number(req.query.limit) || 500
      })
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/recorder/:id/series?tags=a,b&from=&to=&maxPoints= — downsampled numeric
// series for the Trends chart, no external historian required.
router.get('/:id/series', async (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.getIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  const tags = String(req.query.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  try {
    res.json(
      await recorder.series(req.params.id, {
        tags,
        from: Number(req.query.from) || 0,
        to: Number(req.query.to) || Infinity,
        maxPoints: Number(req.query.maxPoints) || 1000
      })
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/recorder/:id/tags?query=&limit= — distinct numeric topics captured,
// so the Trends recording source can search instead of typing a path blind.
router.get('/:id/tags', async (req, res) => {
  const { profiles, recorder } = req.app.locals.services;
  if (!profiles.getIn('recordings', req.params.id)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  try {
    res.json({ tags: await recorder.tags(req.params.id, { query: req.query.query || '', limit: Number(req.query.limit) || 50 }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
