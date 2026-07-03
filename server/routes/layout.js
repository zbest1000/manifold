const express = require('express');
const router = express.Router();
const { computeLayout, listEngines } = require('../services/graphLayout');

// GET /api/layout/engines — advertise the available layout engines.
router.get('/engines', (req, res) => {
  res.json({ engines: listEngines() });
});

// POST /api/layout — compute a batch layout for a graph.
// Body: { graph: { nodes:[{id,...}], links:[{source,target}] }, engine, direction }
// Returns: { engine, count, width, height, positions: { [nodeId]: {x,y} } }
router.post('/', async (req, res) => {
  const { graph, engine, direction } = req.body || {};
  try {
    const result = await computeLayout(graph, { engine, direction });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
