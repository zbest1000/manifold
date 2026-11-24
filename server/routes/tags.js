const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const bindingModel = require('../services/bindingModel');

// Tag browser + bindings: browse device tags across our drivers (OPC UA
// address space, Sparkplug device registry, MQTT topic trie) with one unified
// node shape, and bind selections into the UNS.
//   node: { id, name, kind: 'folder'|'tag', address, meta? }

// GET /api/tags/sources — what can be browsed right now
router.get('/sources', (req, res) => {
  const { mqttManager, opcuaManager, devices } = req.app.locals.services;
  const sources = [];
  for (const d of devices?.list() || []) {
    sources.push({ type: 'device', id: d.id, label: `${d.name} · ${d.protocol}`, state: d.status?.state });
  }
  for (const c of opcuaManager.getConnections()) {
    if (c.status === 'connected') sources.push({ type: 'opcua', id: c.id, label: c.name || c.endpointUrl });
  }
  for (const b of mqttManager.getConnections()) {
    if (b.status !== 'connected') continue;
    const sp = mqttManager.getSparkplug(b.id);
    if (sp.summary.edgeNodes > 0) sources.push({ type: 'sparkplug', id: b.id, label: `${b.name} · Sparkplug` });
    sources.push({ type: 'mqtt', id: b.id, label: `${b.name} · topics` });
  }
  res.json({ sources });
});

// GET /api/tags/browse?type=&id=&node= — one level of children under `node`
router.get('/browse', async (req, res) => {
  const { mqttManager, opcuaManager, profiles, devices } = req.app.locals.services;
  const { type, id, node = '' } = req.query;
  try {
    if (type === 'device') {
      // Configured (effective: profile + ad-hoc) tags, grouped by poll group when a device has more than one.
      const device = profiles.getIn('devices', id);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      const tags = devices?.effectiveTags ? devices.effectiveTags(id) : device.tags || [];
      const groups = [...new Set(tags.map((t) => t.pollGroup || 'default'))];
      const asNode = (t) => ({
        id: t.key,
        name: t.property || t.key,
        kind: 'tag',
        address: t.key,
        meta: {
          deviceAddress: t.address,
          type: t.type,
          unit: t.unit || null,
          description: t.description || null,
          property: t.property || null,
          range: t.range || null,
          origin: t.origin || 'device'
        }
      });
      if (!node && groups.length > 1) {
        return res.json({ children: groups.map((g) => ({ id: `group:${g}`, name: g, kind: 'folder', address: `group:${g}` })) });
      }
      const group = node.startsWith('group:') ? node.slice(6) : null;
      return res.json({ children: tags.filter((t) => !group || (t.pollGroup || 'default') === group).map(asNode) });
    }
    if (type === 'opcua') {
      const result = await opcuaManager.browse(id, node || undefined);
      return res.json({
        children: result.references
          .filter((r) => r.isForward !== false)
          .map((r) => ({
            id: r.nodeId,
            name: r.displayName || r.browseName,
            kind: r.nodeClass === 'Variable' ? 'tag' : 'folder',
            address: r.nodeId
          }))
      });
    }
    if (type === 'sparkplug') {
      // node path: '' | group | group/edge | group/edge/device('' for node metrics)
      const sp = mqttManager.getSparkplug(id);
      const segs = node ? node.split('/') : [];
      if (segs.length === 0) {
        return res.json({ children: sp.groups.map((g) => ({ id: g.id, name: g.id, kind: 'folder', address: g.id })) });
      }
      const group = sp.groups.find((g) => g.id === segs[0]);
      if (!group) return res.json({ children: [] });
      if (segs.length === 1) {
        return res.json({
          children: group.edgeNodes.map((e) => ({
            id: `${node}/${e.id}`,
            name: `${e.id}${e.online ? '' : ' (offline)'}`,
            kind: 'folder',
            address: `${node}/${e.id}`
          }))
        });
      }
      const edge = group.edgeNodes.find((e) => e.id === segs[1]);
      if (!edge) return res.json({ children: [] });
      if (segs.length === 2) {
        const children = edge.devices.map((d) => ({
          id: `${node}/${d.id}`,
          name: `${d.id}${d.online ? '' : ' (offline)'}`,
          kind: 'folder',
          address: `${node}/${d.id}`
        }));
        for (const m of edge.metrics) {
          children.push({
            id: `${node}//${m}`,
            name: m,
            kind: 'tag',
            address: m,
            meta: { group: segs[0], edge: segs[1], device: null }
          });
        }
        return res.json({ children });
      }
      const device = edge.devices.find((d) => d.id === segs[2]);
      return res.json({
        children: (device?.metrics || []).map((m) => ({
          id: `${node}/${m}`,
          name: m,
          kind: 'tag',
          address: m,
          meta: { group: segs[0], edge: segs[1], device: segs[2] }
        }))
      });
    }
    if (type === 'mqtt') {
      const out = mqttManager.getTopicChildren(id, node || '', { limit: 500 });
      if (!out) return res.status(404).json({ error: 'Broker not found' });
      return res.json({
        children: out.children.map((c) => ({
          id: c.path,
          name: c.segment,
          kind: c.isTopic && c.subtreeCount <= 1 ? 'tag' : 'folder',
          address: c.path,
          meta: { subtreeCount: c.subtreeCount, isTopic: c.isTopic }
        }))
      });
    }
    res.status(400).json({ error: 'type must be device, opcua, sparkplug, or mqtt' });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// ---- bindings -----------------------------------------------------------------

// GET /api/bindings
router.get('/bindings', (req, res) => {
  const { profiles, bindings, sparkplugPublisher } = req.app.locals.services;
  res.json({
    bindings: profiles.listIn('bindings'),
    status: bindings.getStatus(),
    sparkplug: sparkplugPublisher.getStatus()
  });
});

// POST /api/tags/bindings — create or edit (by id). Validation lives in
// services/bindingModel.js. The response is the stored binding plus
// `warnings: [...]` (non-blocking: raw-address-looking names, topic collisions
// with other bindings). Retained topics the edit made stale (old path/broker,
// _status, _meta, retained values) are cleared by bindings.reconcile().
router.post('/bindings', async (req, res) => {
  const { profiles, bindings } = req.app.locals.services;
  const id = req.body?.id || uuidv4();
  let body;
  try {
    body = bindingModel.validateBinding({ ...(req.body || {}), id }, { profiles });
  } catch (error) {
    if (error instanceof bindingModel.BindingValidationError) return res.status(400).json({ error: error.message, details: error.details });
    return res.status(500).json({ error: error.message });
  }
  const warnings = bindingModel.bindingWarnings({ ...body, id }, profiles);
  const saved = profiles.upsertIn('bindings', id, body);
  bindings.reconcile(); // reset state if this edited an existing binding; clear stale retained topics; publish _meta
  await bindings.syncMonitors();
  res.status(201).json({ ...saved, warnings });
});

// POST /api/tags/bindings/preview — read-only dry run of a binding draft:
// resolved topics + example payloads (latest known values) for up to 50 tags,
// collisions with other bindings' topics, and the save-time warnings. Nothing
// is stored or published.
router.post('/bindings/preview', (req, res) => {
  const { profiles, bindings, devices } = req.app.locals.services;
  const draft = { ...(req.body || {}), id: req.body?.id || '__preview__' };
  let body;
  try {
    body = bindingModel.validateBinding(draft, { profiles });
  } catch (error) {
    if (error instanceof bindingModel.BindingValidationError) {
      return res.json({ valid: false, error: error.message, details: error.details });
    }
    return res.status(500).json({ error: error.message });
  }
  const latest = (unit, address, name) => {
    if (unit.sourceType === 'device' && devices?.getValues) {
      const v = devices.getValues(unit.sourceId)[address];
      if (v) return { v: v.v, q: v.q, t: v.tRead, type: v.type };
    }
    return bindings.latest?.(unit.id, name) || null;
  };
  res.json({ valid: true, ...bindingModel.previewBinding({ ...body, id: draft.id }, profiles, { latest }) });
});

// GET /api/tags/bindings/schema — read-only description of the mapping options
// (fields, override keys with types/limits, select rules, placeholders, size
// limits, statesMode values) so forms render from the server's truth.
router.get('/bindings/schema', (req, res) => {
  res.json(bindingModel.bindingSchema());
});

// POST /api/tags/bindings/suggest { source } — read-only: suggested per-tag
// names (property, else a cleaned key; raw addresses get none) and asset
// context from the device. Nothing is stored or published.
router.post('/bindings/suggest', (req, res) => {
  const { profiles } = req.app.locals.services;
  try {
    res.json(bindingModel.suggestMapping(req.body?.source, profiles));
  } catch (error) {
    if (error instanceof bindingModel.BindingValidationError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});
// ---- Sparkplug host application STATE -----------------------------------------

// POST /api/tags/sparkplug/state { brokerId, hostId, enabled } — start/stop a
// host-application session (retained spBv1.0/STATE/{hostId} with will + birth).
router.post('/sparkplug/state', async (req, res) => {
  const { profiles, sparkplugPublisher } = req.app.locals.services;
  const { brokerId, hostId, enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (typeof hostId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) {
    return res.status(400).json({ error: 'hostId must match [A-Za-z0-9_-]{1,64}' });
  }
  if (!profiles.brokers().some((b) => b.config?.id === brokerId)) {
    return res.status(400).json({ error: `broker ${brokerId} has no saved profile (needed for a dedicated host connection)` });
  }
  try {
    if (enabled) sparkplugPublisher.startHost({ brokerId, hostId });
    else await sparkplugPublisher.stopHost(brokerId, hostId);
    res.json({ sparkplug: sparkplugPublisher.getStatus() });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// DELETE /api/bindings/:id
router.delete('/bindings/:id', (req, res) => {
  const { profiles, bindings } = req.app.locals.services;
  if (!profiles.removeIn('bindings', req.params.id)) {
    return res.status(404).json({ error: 'Binding not found' });
  }
  bindings.reconcile(); // drop the binding's last/status state
  res.json({ removed: req.params.id });
});

module.exports = router;
