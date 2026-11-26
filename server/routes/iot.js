const express = require('express');
const { IotManager } = require('../services/iot/iotManager');

const router = express.Router();

/**
 * IoT devices over MQTT (services/iot/). READ-ONLY toward the devices: these routes configure
 * which conventions Manifold reads on a broker and list what it found. There is deliberately no
 * route that publishes to a device, a bridge or a gateway (no /set, cmnd/, command or downlink).
 *
 *   GET  /api/iot/conventions
 *   GET  /api/iot/brokers                     detection status of every broker
 *   GET  /api/iot/brokers/:brokerId           config, suggestions, counts, stats
 *   PUT  /api/iot/brokers/:brokerId           { conventions: { <id>: { enabled, ...options } } }
 *   GET  /api/iot/devices?brokerId=&convention=&q=
 *   GET  /api/iot/devices/:brokerId/:deviceId (deviceId URL-encoded) device with tags and live values
 */

const iotOf = (req) => req.app.locals.services.iot;

router.get('/conventions', (req, res) => {
  res.json({ conventions: IotManager.conventions() });
});

router.get('/brokers', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const iot = iotOf(req);
  const brokers = (mqttManager.getConnections() || []).map((c) => ({ id: c.id, name: c.name, status: c.status, ...iot.status(c.id) }));
  res.json({ brokers });
});

router.get('/brokers/:brokerId', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const conn = mqttManager.getConnection(req.params.brokerId);
  if (!conn) return res.status(404).json({ error: 'Broker not found' });
  res.json({ id: conn.id, name: conn.name, status: conn.status, ...iotOf(req).status(conn.id) });
});

router.put('/brokers/:brokerId', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const conn = mqttManager.getConnection(req.params.brokerId);
  if (!conn) return res.status(404).json({ error: 'Broker not found' });
  try {
    iotOf(req).setConfig(conn.id, req.body || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json({ id: conn.id, name: conn.name, status: conn.status, ...iotOf(req).status(conn.id) });
});

router.get('/devices', (req, res) => {
  const { brokerId, convention, q } = req.query;
  const devices = iotOf(req).listDevices({
    brokerId: typeof brokerId === 'string' && brokerId ? brokerId : null,
    convention: typeof convention === 'string' && convention ? convention : null,
    q: typeof q === 'string' && q ? q.slice(0, 200) : null
  });
  res.json({ devices });
});

router.get('/devices/:brokerId/:deviceId', (req, res) => {
  const dev = iotOf(req).getDevice(req.params.brokerId, req.params.deviceId);
  if (!dev) return res.status(404).json({ error: 'IoT device not found (detection off, device removed, or not seen yet)' });
  res.json({ device: dev });
});

module.exports = router;
