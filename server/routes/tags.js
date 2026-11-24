const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();

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
  const { mqttManager, opcuaManager, profiles } = req.app.locals.services;
  const { type, id, node = '' } = req.query;
  try {
    if (type === 'device') {
      // Configured tags, grouped by poll group when a device has more than one.
      const device = profiles.getIn('devices', id);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      const tags = device.tags || [];
      const groups = [...new Set(tags.map((t) => t.pollGroup || 'default'))];
      const asNode = (t) => ({
        id: t.key,
        name: t.property || t.key,
        kind: 'tag',
        address: t.key,
        meta: { deviceAddress: t.address, type: t.type, unit: t.unit || null, description: t.description || null }
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

// POST /api/bindings
router.post('/bindings', async (req, res) => {
  const { profiles, bindings } = req.app.locals.services;
  const { id, name, enabled, source, target, rbe } = req.body || {};
  if (!source?.type || !['opcua', 'sparkplug', 'device'].includes(source.type)) {
    return res.status(400).json({ error: 'source.type must be "device", "opcua" or "sparkplug" (mqtt tags compile to pipeline routes)' });
  }
  if (source.type === 'device') {
    const device = profiles.getIn('devices', source.deviceId);
    if (!device) return res.status(400).json({ error: 'device source needs an existing deviceId' });
    if (!Array.isArray(source.tags) || !source.tags.length) return res.status(400).json({ error: 'device source needs tags[]' });
    const keys = new Set((device.tags || []).map((t) => t.key));
    const missing = source.tags.filter((t) => !keys.has(t.address)).map((t) => t.address);
    if (missing.length) return res.status(400).json({ error: `device has no tag(s): ${missing.slice(0, 5).join(', ')}` });
  }
  if (source.type === 'opcua' && (!source.connectionId || !Array.isArray(source.tags) || !source.tags.length)) {
    return res.status(400).json({ error: 'opcua source needs connectionId and tags[]' });
  }
  if (source.type === 'sparkplug' && (!source.brokerId || !source.group || !source.edge)) {
    return res.status(400).json({ error: 'sparkplug source needs brokerId, group, edge' });
  }
  if (!target?.mode || !['mqtt', 'sparkplug'].includes(target.mode)) {
    return res.status(400).json({ error: 'target.mode must be "mqtt" or "sparkplug"' });
  }
  if (!target.brokerId) return res.status(400).json({ error: 'target.brokerId is required' });
  if (target.mode === 'sparkplug' && (!target.group || !target.edge)) {
    return res.status(400).json({ error: 'sparkplug target needs group and edge' });
  }
  const saved = profiles.upsertIn('bindings', id || uuidv4(), {
    name: name || null,
    enabled: enabled !== false,
    source,
    target,
    // report-by-exception extras: { heartbeatMs } republishes an unchanged value
    ...(rbe && Number(rbe.heartbeatMs) > 0 ? { rbe: { heartbeatMs: Math.max(1000, Math.round(Number(rbe.heartbeatMs))) } } : {})
  });
  bindings.reconcile(); // reset state if this edited an existing binding
  await bindings.syncMonitors();
  res.status(201).json(saved);
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
