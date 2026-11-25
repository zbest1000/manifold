const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();

// UNS mounts: external sources (OPC UA connections, the i3X namespace) grafted
// into the Unified Namespace view. A mount is pure configuration — the client
// resolves it against the live connection when rendering — so it persists in
// the profile store and survives restarts.
//
//   { id, type: 'opcua'|'i3x', connectionId?, label?, nodeId? }

// GET /api/uns/mounts
router.get('/mounts', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.json({ mounts: profiles?.mounts() || [] });
});

// POST /api/uns/mounts { type, connectionId?, label?, nodeId? }
router.post('/mounts', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { type, connectionId, label, nodeId } = req.body || {};
  if (!['opcua', 'i3x'].includes(type)) {
    return res.status(400).json({ error: 'type must be "opcua" or "i3x"' });
  }
  if (type === 'opcua' && !connectionId) {
    return res.status(400).json({ error: 'connectionId is required for opcua mounts' });
  }
  const mount = profiles.upsertMount(uuidv4(), {
    type,
    connectionId: connectionId || null,
    label: label || null,
    nodeId: nodeId || null
  });
  res.status(201).json(mount);
});

// GET /api/uns/mounts/:id/tree — the structure of an OPC UA mount for the UNS view, walked on the
// server level by level: one BrowseRequest per level (in chunks of 32 nodes), at most
// MOUNT_CHILD_CAP children per node, MOUNT_TOTAL_CAP nodes, MOUNT_DEPTH levels below the start node
// and MOUNT_BUDGET_MS in all. A mount of a disconnected server answers 409 with the reason.
const MOUNT_CHILD_CAP = 50;
const MOUNT_TOTAL_CAP = 400;
const MOUNT_DEPTH = 2;
const MOUNT_BUDGET_MS = 8000;
const ROOT_NODE_ID = 'ns=0;i=84';

router.get('/mounts/:id/tree', async (req, res) => {
  const { profiles, opcuaManager } = req.app.locals.services;
  const mount = (profiles?.mounts() || []).find((m) => m.id === req.params.id);
  if (!mount) return res.status(404).json({ error: 'Mount not found' });
  if (mount.type !== 'opcua') return res.status(400).json({ error: 'Only OPC UA mounts are walked on the server' });
  const conn = opcuaManager.getConnections().find((c) => c.id === mount.connectionId);
  if (!conn || conn.status !== 'connected') {
    return res.status(409).json({ error: `The OPC UA connection ${mount.connectionId} is not connected${conn?.lastError ? ` (${conn.lastError})` : ''}`, code: 'source-offline' });
  }
  const startedAt = Date.now();
  const root = { nodeId: mount.nodeId || ROOT_NODE_ID, children: [] };
  let total = 0;
  let requests = 0;
  let truncated = false;
  let level = [root];
  try {
    for (let depth = 1; depth <= MOUNT_DEPTH && level.length && total < MOUNT_TOTAL_CAP; depth++) {
      if (Date.now() - startedAt > MOUNT_BUDGET_MS) {
        truncated = true;
        break;
      }
      const ids = level.map((n) => n.nodeId);
      requests += Math.ceil(ids.length / 32);
      const found = await opcuaManager.browseMany(mount.connectionId, ids, { maxPerNode: MOUNT_CHILD_CAP });
      const next = [];
      for (const parent of level) {
        const r = found.get(parent.nodeId);
        if (r?.truncated) truncated = true;
        const seen = new Set();
        for (const ref of r?.references || []) {
          if (total >= MOUNT_TOTAL_CAP) {
            truncated = true;
            break;
          }
          const name = ref.displayName || ref.browseName || ref.nodeId;
          if (seen.has(name)) continue;
          seen.add(name);
          const child = { name, nodeId: ref.nodeId, nodeClass: ref.nodeClass, children: [] };
          parent.children.push(child);
          next.push(child);
          total++;
        }
      }
      level = next;
    }
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
  res.json({ mountId: mount.id, root, total, requests, truncated, elapsedMs: Date.now() - startedAt, limits: { childCap: MOUNT_CHILD_CAP, totalCap: MOUNT_TOTAL_CAP, depth: MOUNT_DEPTH } });
});

// DELETE /api/uns/mounts/:id
router.delete('/mounts/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeMount(req.params.id)) {
    return res.status(404).json({ error: 'Mount not found' });
  }
  res.json({ removed: req.params.id });
});

// Custom UNS icons: user-defined single-path SVGs the client's icon picker
// offers alongside the bundled Lucide subset. Pure data (a path `d` string on
// a 24x24 viewBox) — validated strictly so nothing script- or URL-shaped can
// be stored and later inlined into an SVG.
//
//   { id, name (unique, kebab-case), svgPath }

const ICON_NAME_RE = /^[a-z0-9-]{1,40}$/;
// SVG path data only: commands, numbers, separators. No <, >, (, ), quotes,
// or anything else that could smuggle markup/scripts/urls into the SVG.
const ICON_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+-]+$/;
const ICON_PATH_MAX = 4000;

// GET /api/uns/icons
router.get('/icons', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.json({ icons: profiles?.listIn('icons') || [] });
});

// POST /api/uns/icons { name, svgPath } — upserts by name
router.post('/icons', (req, res) => {
  const { profiles } = req.app.locals.services;
  const { name, svgPath } = req.body || {};
  if (typeof name !== 'string' || !ICON_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name must be 1-40 chars of lowercase letters, digits, or hyphens' });
  }
  if (typeof svgPath !== 'string' || !svgPath.trim() || svgPath.length > ICON_PATH_MAX || !ICON_PATH_RE.test(svgPath)) {
    return res.status(400).json({ error: `svgPath must be SVG path data (M/L/C/... commands and numbers) up to ${ICON_PATH_MAX} chars` });
  }
  const existing = profiles.listIn('icons').find((i) => i.name === name);
  const icon = profiles.upsertIn('icons', existing?.id || uuidv4(), { name, svgPath: svgPath.trim() });
  res.status(existing ? 200 : 201).json(icon);
});

// DELETE /api/uns/icons/:id
router.delete('/icons/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeIn('icons', req.params.id)) {
    return res.status(404).json({ error: 'Icon not found' });
  }
  res.json({ removed: req.params.id });
});

module.exports = router;
