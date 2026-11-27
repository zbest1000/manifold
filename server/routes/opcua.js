const express = require('express');
const { urlIdentity, secretRequiredBody } = require('../services/endpointIdentity');
const { refuseLinkLocal } = require('../services/egressGuard');
const { expectedRev, handleRevisionError } = require('../services/revision');
const router = express.Router();

/** A connection as GET lists it, with the stored revision (`rev`) editors send back. Never the password. */
function connectionView(opcuaManager, profiles, id) {
  const live = opcuaManager.getConnections().find((c) => c.id === id);
  const saved = profiles?.opcuaEndpoints?.().find((c) => c.id === id);
  if (!live && !saved) return null;
  const { password: _pw, ...cfg } = saved || {};
  return { ...(live || { id, name: cfg.name || cfg.endpointUrl, endpointUrl: cfg.endpointUrl, securityMode: cfg.securityMode || 'None', securityPolicy: cfg.securityPolicy || 'None', username: cfg.username || null, status: 'disconnected' }), rev: saved?.rev || 0, updatedAt: saved?.updatedAt || null };
}

/** Saved configs as identity candidates (a saved connection that is not connected right now still counts). */
const savedConfigs = (profiles) => (profiles?.opcuaEndpoints?.() || []).map(({ password: _pw, ...c }) => c);

function duplicateResponse(res, dup) {
  return res.status(409).json({
    error: `This OPC UA server is already connected as "${dup.name}": same endpoint URL, security mode and policy, and user. A second identical connection would open a second session reading the same data. Edit "${dup.name}" instead, or use a different security setting or user.`,
    code: 'duplicate',
    existing: dup
  });
}

// GET /api/opcua/connections
router.get('/connections', (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  const revs = new Map((profiles?.opcuaEndpoints?.() || []).map((c) => [c.id, c.rev || 0]));
  res.json({ connections: opcuaManager.getConnections().map((c) => ({ ...c, rev: revs.get(c.id) || 0 })) });
});

// POST /api/opcua/discover { endpointUrl } — connect with security None, list
// the server's endpoints (mode/policy/securityLevel + server certificate),
// disconnect. Bounded to ~10s inside the manager.
router.post('/discover', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { endpointUrl } = req.body || {};
  if (!endpointUrl || typeof endpointUrl !== 'string') {
    return res.status(400).json({ error: 'endpointUrl is required (e.g. opc.tcp://host:4840)' });
  }
  try {
    const endpoints = await opcuaManager.discoverEndpoints(endpointUrl);
    res.json({ endpointUrl, endpoints });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/opcua/certificate — the Manifold application certificate (PEM +
// thumbprint/subject/validity), created on first use in <dataDir>/pki.
router.get('/certificate', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    res.json(await opcuaManager.getApplicationCertificate());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opcua/trust — trusted + rejected server certificates in the PKI store
router.get('/trust', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    res.json(await opcuaManager.listTrust());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/opcua/trust { thumbprint } — promote a rejected certificate to trusted
router.post('/trust', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { thumbprint } = req.body || {};
  if (!thumbprint || typeof thumbprint !== 'string') {
    return res.status(400).json({ error: 'thumbprint is required (SHA1 hex, see GET /api/opcua/trust)' });
  }
  try {
    const certificate = await opcuaManager.trustCertificate(thumbprint);
    if (!certificate) {
      return res.status(404).json({ error: `no rejected certificate with thumbprint ${thumbprint}` });
    }
    res.json({ status: 'trusted', certificate });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections — connect to an endpoint (profile persisted)
// An exact duplicate (endpoint, security, user) of an existing connection is refused with
// 409 { code: 'duplicate', existing: { id, name } }.
router.post('/connections', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  const { rev: _rev, ...body } = req.body || {};
  if (await refuseLinkLocal(res, body.endpointUrl, 'OPC UA endpoint')) return;
  const dup = opcuaManager.findDuplicateConnection(body, null, savedConfigs(profiles));
  if (dup) return duplicateResponse(res, dup);
  try {
    const result = await opcuaManager.connect(body);
    profiles?.upsertOpcua(result.connectionId, { ...body, id: result.connectionId });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/opcua/connections/:connectionId — update a saved endpoint in place:
// disconnect the existing session, reconnect under the SAME id, persist the new
// config on success (like POST). Validated like POST (endpointUrl is required).
// Optimistic concurrency: body `rev` / If-Match = the revision the editor loaded; a stale edit is
// refused with 409 { code: 'stale', current } BEFORE the running session is touched. Turning the
// connection into an exact duplicate of another one is refused like POST.
router.put('/connections/:connectionId', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  const connectionId = req.params.connectionId;
  const saved = profiles?.opcuaEndpoints().find((c) => c.id === connectionId);
  if (!opcuaManager.getConnections().some((c) => c.id === connectionId) && !saved) {
    return res.status(404).json({ error: 'OPC UA connection not found' });
  }
  try {
    if (saved) profiles?.assertRev('opcua', connectionId, expectedRev(req));
  } catch (error) {
    if (handleRevisionError(res, error, () => connectionView(opcuaManager, profiles, connectionId))) return;
    throw error;
  }
  const { rev: _rev, ...body } = req.body || {};
  if (await refuseLinkLocal(res, body.endpointUrl, 'OPC UA endpoint')) return;
  const dup = opcuaManager.findDuplicateConnection(body, connectionId, savedConfigs(profiles));
  if (dup) return duplicateResponse(res, dup);
  // Leave-blank-to-keep: an omitted password keeps the stored one, for the same endpoint only. A new
  // scheme, host or port with the password left blank is refused before the session is touched.
  if (body.password === undefined && saved?.password) {
    if (body.username && urlIdentity(body.endpointUrl) !== urlIdentity(saved.endpointUrl)) {
      return res.status(400).json(secretRequiredBody('password'));
    }
    if (urlIdentity(body.endpointUrl) === urlIdentity(saved.endpointUrl)) body.password = saved.password;
  }
  try {
    const result = await opcuaManager.updateConnection(connectionId, body);
    const stored = profiles?.upsertOpcua(connectionId, { ...body, id: connectionId });
    res.json({ ...result, rev: stored?.rev });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/opcua/connections/:connectionId (profile removed)
router.delete('/connections/:connectionId', async (req, res) => {
  const { opcuaManager, profiles } = req.app.locals.services;
  try {
    const result = await opcuaManager.disconnect(req.params.connectionId);
    profiles?.removeOpcua(req.params.connectionId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// GET /api/opcua/connections/:connectionId/browse?nodeId=ns=0;i=84
router.get('/connections/:connectionId/browse', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  try {
    const result = await opcuaManager.browse(req.params.connectionId, req.query.nodeId || undefined);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/opcua/connections/:connectionId/read?nodeId=...
router.get('/connections/:connectionId/read', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  if (!req.query.nodeId) return res.status(400).json({ error: 'nodeId query parameter is required' });
  try {
    const result = await opcuaManager.read(req.params.connectionId, req.query.nodeId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections/:connectionId/monitor { nodeId, samplingInterval }
router.post('/connections/:connectionId/monitor', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { nodeId, samplingInterval } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    const result = await opcuaManager.monitor(req.params.connectionId, nodeId, samplingInterval || 500);
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/opcua/connections/:connectionId/unmonitor { nodeId }
router.post('/connections/:connectionId/unmonitor', async (req, res) => {
  const { opcuaManager } = req.app.locals.services;
  const { nodeId } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    res.json(await opcuaManager.unmonitor(req.params.connectionId, nodeId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
