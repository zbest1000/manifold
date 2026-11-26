const express = require('express');
const router = express.Router();
const { redactSecrets, isSecretKey } = require('../services/secrets');
const { COLLECTIONS } = require('../services/profileStore');

// GET /api/system/status
router.get('/status', (req, res) => {
  const { mqttManager, opcuaManager, discovery, cesmii, i3x } = req.app.locals.services;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mqtt: {
      connections: mqttManager.getConnections().length,
      brokers: mqttManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    opcua: {
      connections: opcuaManager.getConnections().length,
      endpoints: opcuaManager.getConnections().map((c) => ({ id: c.id, name: c.name, status: c.status }))
    },
    discovery: {
      scanning: discovery.isScanning()
    },
    cesmii: cesmii.status(),
    i3x: i3x.status()
  });
});

// GET /api/system/broken-references — every stored object (route, mapping, recording, alert rule,
// model, contract) that points at a broker or historian that no longer exists:
// { broken: [{ type, id, name, missing: [{ kind, id, field }] }] }. Such objects cannot run;
// the Overview lists them under "Needs attention" with a link to the place to fix them.
router.get('/broken-references', (req, res) => {
  const { profiles, mqttManager } = req.app.locals.services;
  const { scanBroken } = require('../services/references');
  res.json({ broken: scanBroken({ profiles, mqttManager }) });
});

// ---- network discovery ----------------------------------------------------------------
// The engine lives in services/discovery.js. Results carry a server-side `known`
// marker (already a broker / OPC UA connection / i3X server / device), so every client
// shows the same thing. The engine learns about those registries from the first request
// that reaches this router.
router.use('/discovery', (req, res, next) => {
  const services = req.app.locals.services;
  services.discovery.bindServices(services);
  next();
});

// Errors the engine raises on purpose carry a code the UI keys off (RANGE_REFUSED names the
// flag that would allow the range; SCAN_RUNNING is a conflict, the rest are bad input).
function sendDiscoveryError(res, error) {
  const status = error.code === 'SCAN_RUNNING' ? 409 : 400;
  const body = { error: error.message };
  if (error.code) body.code = error.code;
  if (error.flag) body.flag = error.flag;
  if (error.categories) body.categories = error.categories;
  res.status(status).json(body);
}

// GET /api/system/discovery/defaults - local subnet, default settings and bounds, port defaults, policy
router.get('/discovery/defaults', (req, res) => {
  res.json(req.app.locals.services.discovery.describe());
});

// POST /api/system/discovery/plan { range, ...options } - what a scan WOULD do (hosts, probes, ETA, refusal)
router.post('/discovery/plan', async (req, res) => {
  const { discovery } = req.app.locals.services;
  try {
    const p = await discovery.plan(req.body || {});
    res.json({ range: p.range, resolvedFrom: p.resolvedFrom, hosts: p.hosts.length, totalProbes: p.totalProbes, ports: p.ports, tcpPorts: p.tcpPorts, udpPorts: p.udpPorts, settings: p.settings, estimate: p.estimate, skipped: p.skipped, notes: p.notes });
  } catch (error) {
    // ?soft=1: the page asks for a plan on every edit, and a refused range is an expected answer there, not a
    // failed request (it would otherwise show up as a console error in the browser). 200 with `refused`.
    if (req.query.soft === '1' && error.code && error.code !== 'SCAN_RUNNING') {
      const refused = { error: error.message, code: error.code };
      if (error.flag) refused.flag = error.flag;
      if (error.categories) refused.categories = error.categories;
      return res.json({ refused });
    }
    sendDiscoveryError(res, error);
  }
});

// POST /api/system/discovery/start { range, includeDevices, mqttPorts, opcuaPorts, i3xPorts, modbusPorts,
//   s7Ports, eipPorts, mqttWsPorts, bacnetPorts / includeBacnet, coapPorts / includeCoap,
//   snmpPorts / includeSnmp (UDP kinds, each opt-in on its own),
//   concurrency, perHost, timeoutMs, identifyTimeoutMs }
router.post('/discovery/start', async (req, res) => {
  const { discovery } = req.app.locals.services;
  try {
    const result = await discovery.startScan(req.body || {});
    res.status(202).json(result);
  } catch (error) {
    sendDiscoveryError(res, error);
  }
});

// POST /api/system/discovery/stop
router.post('/discovery/stop', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json(discovery.stopScan());
});

// GET /api/system/discovery/results - the last scan until the next one starts (survives a page reload)
router.get('/discovery/results', (req, res) => {
  const { discovery } = req.app.locals.services;
  res.json(discovery.getState());
});

// ---- config as code -----------------------------------------------------------
// Export/import the DataOps configuration (routes, models, historians,
// recordings, contracts, bindings, devices, mounts, alert rules) as one JSON
// document, reviewable in version control and promotable between environments.
// Secrets are STRIPPED on export (a config file in a repo must never carry
// credentials) by ONE shared redaction function (services/secrets.js: every
// credential-named field at any depth, URL passwords, webhook URLs); re-enter
// them after import, or import over the same instance, which keeps the stored
// secret wherever the import carries null.

// Collections that travel in a config file (icons are UI data, not config).
const EXPORT_COLLECTIONS = COLLECTIONS.filter((c) => c !== 'icons');

const MAX_ITEMS_PER_COLLECTION = 5000;
const MAX_ITEM_BYTES = 256 * 1024;
const MAX_DEPTH = 24;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Build the export document from a profile store (also used by tests). */
function buildExport(profiles) {
  const out = { manifoldConfig: 1, exportedAt: new Date().toISOString() };
  for (const c of EXPORT_COLLECTIONS) out[c] = profiles.listIn(c).map((item) => redactSecrets(item));
  out.mounts = profiles.mounts().map((m) => redactSecrets(m));
  out.alertRules = profiles.alertRules().map((r) => redactSecrets(r));
  return out;
}

/** Walk a value; return a description of the first forbidden key / over-deep nesting, or null. */
function findUnsafe(value, depth = 0) {
  if (depth > MAX_DEPTH) return 'nesting too deep';
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findUnsafe(v, depth + 1);
      if (bad) return bad;
    }
  } else if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) return `forbidden key "${k}"`;
      const bad = findUnsafe(value[k], depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}

/**
 * Validate an import body completely BEFORE anything is applied.
 * Returns an array of error strings (empty = ok).
 */
function validateImport(body) {
  const errors = [];
  const known = new Set(['manifoldConfig', 'exportedAt', 'mounts', 'alertRules', ...EXPORT_COLLECTIONS]);
  const checkList = (name, list) => {
    if (!Array.isArray(list)) return errors.push(`${name}: must be an array`);
    if (list.length > MAX_ITEMS_PER_COLLECTION) return errors.push(`${name}: more than ${MAX_ITEMS_PER_COLLECTION} items`);
    const seen = new Set();
    list.forEach((item, i) => {
      const where = `${name}[${i}]`;
      if (!isPlainObject(item)) return errors.push(`${where}: must be an object`);
      if (typeof item.id !== 'string' || !ID_RE.test(item.id)) return errors.push(`${where}: id must match ${ID_RE}`);
      if (seen.has(item.id)) return errors.push(`${where}: duplicate id "${item.id}"`);
      seen.add(item.id);
      const bad = findUnsafe(item);
      if (bad) return errors.push(`${where}: ${bad}`);
      let size;
      try {
        size = JSON.stringify(item).length;
      } catch {
        return errors.push(`${where}: not serializable`);
      }
      if (size > MAX_ITEM_BYTES) errors.push(`${where}: larger than ${MAX_ITEM_BYTES} bytes`);
      if (name === 'alertRules' && item.webhookUrl != null) {
        if (typeof item.webhookUrl !== 'string' || item.webhookUrl.length > 2048 || !/^https?:\/\//i.test(item.webhookUrl)) {
          errors.push(`${where}: webhookUrl must be an http(s) URL (max 2048 chars) or null`);
        }
      }
    });
  };
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`forbidden key "${key}"`);
    else if (!known.has(key)) errors.push(`unknown top-level key "${key.slice(0, 64)}"`);
  }
  for (const c of [...EXPORT_COLLECTIONS, 'mounts', 'alertRules']) {
    if (body[c] !== undefined) checkList(c, body[c]);
  }
  return errors;
}

/**
 * Where the import carries a null/absent secret, keep the stored one — at any
 * depth. Returns a NEW object; never writes through `imported`'s prototype.
 */
function restoreSecrets(imported, existing) {
  if (Array.isArray(imported)) {
    return imported.map((v, i) => {
      let match;
      if (Array.isArray(existing)) {
        match = isPlainObject(v) && v.id !== undefined ? existing.find((e) => isPlainObject(e) && e.id === v.id) : existing[i];
      }
      return restoreSecrets(v, match);
    });
  }
  if (!isPlainObject(imported)) return imported;
  const out = {};
  const prior = isPlainObject(existing) ? existing : {};
  for (const [k, v] of Object.entries(imported)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = restoreSecrets(v, Object.hasOwn(prior, k) ? prior[k] : undefined);
  }
  for (const [k, v] of Object.entries(prior)) {
    if (isSecretKey(k) && !FORBIDDEN_KEYS.has(k) && (out[k] === null || out[k] === undefined) && v) out[k] = v;
  }
  return out;
}

// GET /api/system/config/export
router.get('/config/export', (req, res) => {
  const { profiles } = req.app.locals.services;
  res.setHeader('Content-Disposition', 'attachment; filename="manifold-config.json"');
  res.json(buildExport(profiles));
});

// POST /api/system/config/import — merge by id (existing ids are overwritten,
// everything else is left alone; nothing is deleted). The whole document is
// validated first; any problem rejects it with 400 and applies nothing.
router.post('/config/import', (req, res) => {
  const { profiles } = req.app.locals.services;
  const body = req.body;
  if (!isPlainObject(body) || body.manifoldConfig !== 1) {
    return res.status(400).json({ error: 'not a Manifold config export (missing manifoldConfig: 1)' });
  }
  const errors = validateImport(body);
  if (errors.length) return res.status(400).json({ error: 'invalid config', details: errors.slice(0, 20) });

  const imported = {};
  for (const c of EXPORT_COLLECTIONS) {
    if (!Array.isArray(body[c])) continue;
    for (const item of body[c]) profiles.upsertIn(c, item.id, restoreSecrets(item, profiles.getIn(c, item.id)));
    imported[c] = body[c].length;
  }
  if (Array.isArray(body.mounts)) {
    const existing = new Map(profiles.mounts().map((m) => [m.id, m]));
    for (const m of body.mounts) profiles.upsertMount(m.id, restoreSecrets(m, existing.get(m.id)));
    imported.mounts = body.mounts.length;
  }
  if (Array.isArray(body.alertRules)) {
    const existing = new Map(profiles.alertRules().map((r) => [r.id, r]));
    for (const r of body.alertRules) profiles.upsertAlertRule(r.id, restoreSecrets(r, existing.get(r.id)));
    imported.alertRules = body.alertRules.length;
  }
  // Imported bindings/devices take effect now, not at the next edit or restart.
  const { bindings, devices } = req.app.locals.services;
  try {
    bindings?.reconcile?.();
  } catch (error) {
    console.warn(`import: bindings reconcile: ${error.message}`);
  }
  devices?.apply?.().catch((error) => console.warn(`import: devices apply: ${error.message}`));
  res.json({ imported });
});

module.exports = router;
module.exports.buildExport = buildExport;
module.exports.validateImport = validateImport;
module.exports.restoreSecrets = restoreSecrets;
