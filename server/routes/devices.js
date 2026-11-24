const express = require('express');
const router = express.Router();
const { DeviceValidationError } = require('../services/deviceManager');

// Southbound devices (Modbus TCP, S7, EtherNet/IP): CRUD, connection test,
// tag validation, commissioning probe and latest values. Drivers are
// read-only; no route here can write to a device.

function fail(res, error) {
  if (error instanceof DeviceValidationError) {
    return res.status(400).json({ error: error.message, details: error.details });
  }
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

// POST /api/devices
router.post('/', async (req, res) => {
  const { devices } = req.app.locals.services;
  try {
    const { id: _ignored, ...body } = req.body || {};
    res.status(201).json(await devices.save(body));
  } catch (error) {
    fail(res, error);
  }
});

// PUT /api/devices/:id
router.put('/:id', async (req, res) => {
  const { devices, profiles, bindings } = req.app.locals.services;
  if (!profiles.getIn('devices', req.params.id)) return res.status(404).json({ error: 'Device not found' });
  try {
    const saved = await devices.save(req.body, req.params.id);
    bindings.reconcile?.();
    res.json(saved);
  } catch (error) {
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

// GET /api/devices/:id/values — latest value per tag
router.get('/:id/values', (req, res) => {
  const { devices, profiles } = req.app.locals.services;
  if (!profiles.getIn('devices', req.params.id)) return res.status(404).json({ error: 'Device not found' });
  res.json({ values: devices.getValues(req.params.id) });
});

module.exports = router;
