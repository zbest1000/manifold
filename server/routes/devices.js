const express = require('express');
const router = express.Router();
const { DeviceValidationError, DeviceConflictError } = require('../services/deviceManager');
const { expectedRev, handleRevisionError } = require('../services/revision');

// Southbound devices (every registered driver): CRUD, device profiles
// and instances, connection test, tag validation, commissioning probe and
// latest values. Drivers are read-only; no route here can write to a device.
// GET /api/devices returns each device's EFFECTIVE tags (profile tags marked
// origin:'profile' + ad-hoc tags) plus profileId/params/ownTags.
// Device secrets (password-type descriptor fields) are handled by DeviceManager
// for every route here: a stored secret is answered as null, an edit that
// leaves it absent/null/blank keeps it (see the comment above maskSecrets).

function fail(res, error) {
  if (error instanceof DeviceValidationError) {
    // A stored secret that would follow an endpoint change: { code: 'secret-required', field } for the form.
    if (error.code === 'secret-required') return res.status(400).json({ error: error.message, code: error.code, field: error.field });
    return res.status(400).json({ error: error.message, details: error.details });
  }
  if (error instanceof DeviceConflictError) return res.status(409).json({ error: error.message, instances: error.details });
  if (error?.name === 'EgressBlockedError') return res.status(403).json({ error: error.message });
  return res.status(502).json({ error: error.message });
}

// GET /api/devices
router.get('/', (req, res) => {
  const { devices } = req.app.locals.services;
  res.json({ devices: devices.list(), hosts: devices.hosts(), protocols: devices.protocols() });
});

// POST /api/devices/test { device } — one-off connect with an unsaved config
router.post('/test', async (req, res) => {
  const { devices } = req.app.locals.services;
  try {
    res.json(await devices.test(req.body?.device || req.body));
  } catch (error) {
    fail(res, error);
  }
});

// ---- device profiles (registered before /:id so "profiles" is never a device id) ----
//   profile: { id, name, protocol, description?, options, pollGroups,
//              params: [{ name, default?, description? }],
//              tags: [{ key, address, type, property?, unit?, description?, range?, pollGroup?, ... }] }
//   {param} placeholders are allowed in a tag's key, address and property.

// GET /api/devices/profiles — profiles with their instances [{ id, name }]
router.get('/profiles', (req, res) => {
  const { devices } = req.app.locals.services;
  res.json({ profiles: devices.listProfiles() });
});

// GET /api/devices/profiles/:id
router.get('/profiles/:id', (req, res) => {
  const { devices } = req.app.locals.services;
  const p = devices.listProfiles().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json(p);
});

// POST /api/devices/profiles
router.post('/profiles', async (req, res) => {
  const { devices } = req.app.locals.services;
  try {
    const { id: _ignored, ...body } = req.body || {};
    res.status(201).json(await devices.saveProfile(body));
  } catch (error) {
    fail(res, error);
  }
});

// PUT /api/devices/profiles/:id — re-applies to every instance atomically;
// 400 with details [{ deviceId, name, error, details }] if any instance would break.
router.put('/profiles/:id', async (req, res) => {
  const { devices, profiles, bindings } = req.app.locals.services;
  if (!profiles.getIn('deviceProfiles', req.params.id)) return res.status(404).json({ error: 'Profile not found' });
  try {
    const { rev: _rev, ...body } = req.body || {};
    const saved = await devices.saveProfile(body, req.params.id, { expectRev: expectedRev(req) });
    bindings.reconcile?.();
    await bindings.syncMonitors?.();
    res.json(saved);
  } catch (error) {
    if (handleRevisionError(res, error, () => devices.listProfiles().find((x) => x.id === req.params.id) || null)) return;
    fail(res, error);
  }
});

// DELETE /api/devices/profiles/:id — 409 while devices use it
router.delete('/profiles/:id', async (req, res) => {
  const { devices, profiles } = req.app.locals.services;
  const inUse = profiles.listIn('bindings').filter((b) => b.source?.type === 'device-profile' && b.source.profileId === req.params.id);
  if (inUse.length) {
    return res.status(409).json({
      error: `Profile is used by ${inUse.length} binding(s): ${inUse.slice(0, 5).map((b) => b.name || b.id).join(', ')}. Delete them first.`,
      bindings: inUse.map((b) => ({ id: b.id, name: b.name || null }))
    });
  }
  try {
    if (!(await devices.removeProfile(req.params.id))) return res.status(404).json({ error: 'Profile not found' });
    res.json({ removed: req.params.id });
  } catch (error) {
    fail(res, error);
  }
});

// POST /api/devices/profiles/:id/instantiate { name, host, port?, params, enabled?, ...protocol fields, tags? }
router.post('/profiles/:id/instantiate', async (req, res) => {
  const { devices, bindings } = req.app.locals.services;
  try {
    const saved = await devices.instantiate(req.params.id, req.body);
    bindings.reconcile?.(); // device-profile bindings pick the new instance up
    await bindings.syncMonitors?.();
    res.status(201).json(saved);
  } catch (error) {
    fail(res, error);
  }
});

// POST /api/devices/validate-tags { protocol, options, tags } — read-only
router.post('/validate-tags', (req, res) => {
  const { devices } = req.app.locals.services;
  const { protocol, options, tags } = req.body || {};
  try {
    res.json({ results: devices.validateTags(protocol, options, tags) });
  } catch (error) {
    fail(res, error);
  }
});

// POST /api/devices/bulk { devices: [...], profileId? } — all-or-nothing: every row is validated
// first; on any failure nothing is created and 400 carries `rows` [{ index, name, error, details }].
router.post('/bulk', async (req, res) => {
  const { devices, bindings } = req.app.locals.services;
  try {
    const created = await devices.saveBulk(req.body?.devices, { profileId: req.body?.profileId });
    bindings?.reconcile?.();
    await bindings?.syncMonitors?.();
    res.status(201).json({ created });
  } catch (error) {
    if (error instanceof DeviceValidationError && Array.isArray(error.details)) {
      return res.status(400).json({ error: error.message, rows: error.details });
    }
    fail(res, error);
  }
});

// POST /api/devices
router.post('/', async (req, res) => {
  const { devices, bindings } = req.app.locals.services;
  try {
    const { id: _ignored, ...body } = req.body || {};
    const saved = await devices.save(body);
    bindings?.reconcile?.(); // a new profile instance joins device-profile bindings
    await bindings?.syncMonitors?.();
    res.status(201).json(saved);
  } catch (error) {
    fail(res, error);
  }
});

// PUT /api/devices/:id — body `rev` (or If-Match) = the revision the client loaded; 409 { code:'stale', current } when it moved
router.put('/:id', async (req, res) => {
  const { devices, profiles, bindings } = req.app.locals.services;
  if (!profiles.getIn('devices', req.params.id)) return res.status(404).json({ error: 'Device not found' });
  try {
    const { rev: _rev, ...body } = req.body || {};
    const saved = await devices.save(body, req.params.id, { expectRev: expectedRev(req) });
    bindings.reconcile?.();
    res.json(saved);
  } catch (error) {
    if (handleRevisionError(res, error, () => devices.list().find((d) => d.id === req.params.id) || null)) return;
    fail(res, error);
  }
});

// DELETE /api/devices/:id
router.delete('/:id', async (req, res) => {
  const { devices, profiles, bindings } = req.app.locals.services;
  const inUse = profiles
    .listIn('bindings')
    .filter((b) => b.source?.type === 'device' && b.source.deviceId === req.params.id)
    .map((b) => b.name || b.id);
  if (inUse.length) {
    return res.status(409).json({ error: `Device is used by ${inUse.length} binding(s): ${inUse.slice(0, 5).join(', ')}. Delete them first.` });
  }
  if (!(await devices.remove(req.params.id))) return res.status(404).json({ error: 'Device not found' });
  bindings.reconcile?.();
  res.json({ removed: req.params.id });
});

// POST /api/devices/:id/probe { address, count?, unitId? } — raw read + decodings
router.post('/:id/probe', async (req, res) => {
  const { devices } = req.app.locals.services;
  try {
    res.json(await devices.probe(req.params.id, req.body));
  } catch (error) {
    fail(res, error);
  }
});

// GET /api/devices/:id/browse?node= — the controller's own tag list (browse-capable drivers)
router.get('/:id/browse', async (req, res) => {
  const { devices } = req.app.locals.services;
  try {
    res.json({ children: await devices.browse(req.params.id, req.query.node) });
  } catch (error) {
    fail(res, error);
  }
});

// GET /api/devices/:id/values — latest value per tag
router.get('/:id/values', (req, res) => {
  const { devices, profiles } = req.app.locals.services;
  if (!profiles.getIn('devices', req.params.id)) return res.status(404).json({ error: 'Device not found' });
  res.json({ values: devices.getValues(req.params.id) });
});

module.exports = router;
