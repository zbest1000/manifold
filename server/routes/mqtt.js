const express = require('express');
const router = express.Router();
const { redactSecrets } = require('../services/secrets');
const { expectedRev, handleRevisionError } = require('../services/revision');
const { usersOfBroker } = require('../services/references');
const { validateCanaryConfig } = require('../services/brokerCanary');
const { presetList } = require('../services/brokerPresets');

const BROKER_PROTOCOLS = ['mqtt', 'mqtts', 'ws', 'wss'];

// Shared POST/PUT body validation for the transport/session fields. The
// manager re-validates on connect, but PUT tears the running client down
// before reconnecting — rejecting bad bodies here means an invalid update can
// never drop a healthy connection.
function validateBrokerConfig(body) {
  if (body.protocol !== undefined && !BROKER_PROTOCOLS.includes(body.protocol)) {
    return `protocol must be one of ${BROKER_PROTOCOLS.join(', ')}`;
  }
  // No standard MQTT-over-WebSocket port exists (EMQX 8083/8084, Mosquitto
  // 9001, proxies 443...), so ws/wss require an explicit one.
  if ((body.protocol === 'ws' || body.protocol === 'wss') && !Number(body.port)) {
    return `port is required for ${body.protocol} connections`;
  }
  if (body.wsPath !== undefined && (typeof body.wsPath !== 'string' || !body.wsPath.startsWith('/'))) {
    return "wsPath must be a string starting with '/'";
  }
  if (body.mqttVersion !== undefined && ![4, 5].includes(Number(body.mqttVersion))) {
    return 'mqttVersion must be 4 or 5';
  }
  if (body.subscribeFilter !== undefined && (typeof body.subscribeFilter !== 'string' || body.subscribeFilter.length === 0)) {
    return 'subscribeFilter must be a non-empty topic filter';
  }
  return validateCanaryConfig(body.canary);
}

// MQTT 5 publish properties: { userProperties?: {k: v strings}, contentType?,
// responseTopic? }. Forwarded to the broker only on v5 sessions (the manager
// silently drops them for v4, where mqtt.js would error).
function validatePublishProperties(properties) {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return 'properties must be an object';
  }
  const { userProperties, contentType, responseTopic } = properties;
  if (userProperties !== undefined) {
    if (typeof userProperties !== 'object' || userProperties === null || Array.isArray(userProperties)) {
      return 'properties.userProperties must be a flat string-to-string object';
    }
    for (const value of Object.values(userProperties)) {
      if (typeof value !== 'string') return 'properties.userProperties must be a flat string-to-string object';
    }
  }
  if (contentType !== undefined && typeof contentType !== 'string') {
    return 'properties.contentType must be a string';
  }
  if (responseTopic !== undefined && typeof responseTopic !== 'string') {
    return 'properties.responseTopic must be a string';
  }
  return null;
}

// GET /api/mqtt/brokers — list connections
router.get('/brokers', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  res.json({
    brokers: mqttManager.getConnections().map((b) => ({
      ...b,
      rev: profiles?.getBroker?.(b.id)?.rev || 0,
      // Compact security summary and canary state for the list; the detail endpoints carry the rest.
      posture: mqttManager.getPosture(b.id)?.summary || null,
      canaryState: mqttManager.canary.summary(b.id)
    }))
  });
});

// GET /api/mqtt/presets: well-known public test brokers the connect form can fill in.
router.get('/presets', (req, res) => {
  res.json({ presets: presetList() });
});

// What a broker looks like to a client: the stored config with credentials masked, plus its
// revision. Used as `current` in a 409 so the editor can show what changed elsewhere.
function brokerView(profiles, id) {
  const entry = profiles?.getBroker?.(id);
  if (!entry) return null;
  return { ...redactSecrets(entry.config), rev: entry.rev || 0, updatedAt: entry.updatedAt || null };
}

function duplicateResponse(res, dup) {
  return res.status(409).json({
    error: `This broker is already connected as "${dup.name}": same protocol, host, port, user and subscribe filter. A second identical connection would double-count every message. Edit "${dup.name}" instead, or use a different subscribe filter or user.`,
    code: 'duplicate',
    existing: dup
  });
}

// POST /api/mqtt/brokers — connect to a broker (profile persisted for restart)
router.post('/brokers', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  const { rev: _rev, ...body } = req.body || {};
  const invalid = validateBrokerConfig(body);
  if (invalid) return res.status(400).json({ error: invalid });
  const dup = mqttManager.findDuplicateBroker(body);
  if (dup) return duplicateResponse(res, dup);
  try {
    const result = mqttManager.connectToBroker(body);
    profiles?.upsertBroker(result.brokerId, { ...body, id: result.brokerId });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/mqtt/brokers/:brokerId — update a saved broker in place: disconnect
// the running client, persist the new config under the SAME id, reconnect.
// The normal disconnect/connection-attempt socket events fire so client
// stores stay truthful. Validated like POST (host is required).
router.put('/brokers/:brokerId', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  const brokerId = req.params.brokerId;
  const saved = profiles?.brokers().find((b) => b.config?.id === brokerId);
  if (!mqttManager.getConnection(brokerId) && !saved) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const { rev: _bodyRev, ...body } = req.body || {};
  try {
    // Refuse a stale edit BEFORE the running connection is touched.
    profiles?.assertRev('mqtt', brokerId, expectedRev(req));
  } catch (error) {
    if (handleRevisionError(res, error, () => brokerView(profiles, brokerId))) return;
    throw error;
  }
  // Leave-blank-to-keep: the list endpoint never echoes credentials, so a body
  // that omits the password keeps the stored one (same pattern as historians).
  if (body.password === undefined && saved?.config?.password !== undefined) {
    body.password = saved.config.password;
  }
  const invalid = validateBrokerConfig(body);
  if (invalid) return res.status(400).json({ error: invalid });
  const dup = mqttManager.findDuplicateBroker(body, brokerId);
  if (dup) return duplicateResponse(res, dup);
  try {
    const result = mqttManager.updateBroker(brokerId, body);
    const stored = profiles?.upsertBroker(brokerId, { ...body, id: brokerId });
    res.status(202).json({ ...result, rev: stored?.rev });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/mqtt/brokers/:brokerId
router.get('/brokers/:brokerId', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  const connection = mqttManager.getConnection(req.params.brokerId);
  if (!connection) return res.status(404).json({ error: 'Broker not found' });
  res.json({
    broker: { ...connection, rev: profiles?.getBroker?.(req.params.brokerId)?.rev || 0 },
    // The saved settings the list does not carry (timeouts, keep-alive, TLS verification...), credentials masked:
    // what an editor needs to open with the real values instead of defaults.
    config: brokerView(profiles, req.params.brokerId),
    subscriptions: mqttManager.getSubscriptions(req.params.brokerId)
  });
});

// DELETE /api/mqtt/brokers/:brokerId — disconnect (profile removed)
router.delete('/brokers/:brokerId', (req, res) => {
  const { mqttManager, profiles, sparkplugPublisher } = req.app.locals.services;
  // Refuse while something still points at it: those routes, mappings, recordings, alert rules,
  // models, contracts and Sparkplug host sessions would otherwise keep running against a
  // broker that no longer exists and silently lose data.
  const users = usersOfBroker(req.params.brokerId, { profiles, mqttManager, sparkplugPublisher });
  if (users.length && (profiles?.getBroker?.(req.params.brokerId) || mqttManager.getConnection(req.params.brokerId))) {
    const names = users.slice(0, 8).map((u) => `${u.type} "${u.name}"`).join(', ');
    return res.status(409).json({
      error: `This broker is still used by ${users.length} item(s): ${names}${users.length > 8 ? ', …' : ''}. Point them at another broker or delete them first.`,
      code: 'in-use',
      usedBy: users
    });
  }
  try {
    const result = mqttManager.disconnectFromBroker(req.params.brokerId);
    profiles?.removeBroker(req.params.brokerId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// GET /api/mqtt/brokers/:brokerId/posture: read-only security assessment from what Manifold already
// knows about the connection (nothing is probed): findings worst first, plus the facts they rest on.
router.get('/brokers/:brokerId/posture', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const posture = mqttManager.getPosture(req.params.brokerId);
  if (!posture) return res.status(404).json({ error: 'Broker not found' });
  res.json({ brokerId: req.params.brokerId, ...posture });
});

// GET /api/mqtt/brokers/:brokerId/canary: round-trip probe status (state "off" when the canary is not enabled).
router.get('/brokers/:brokerId/canary', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const status = mqttManager.getCanary(req.params.brokerId);
  if (!status) return res.status(404).json({ error: 'Broker not found' });
  res.json({ brokerId: req.params.brokerId, ...status });
});

// GET /api/mqtt/brokers/:brokerId/topics?limit=100000
// Bounded so a broker with millions of topics can't produce an unbounded
// response; the live stream keeps filling the client's index beyond the limit.
router.get('/brokers/:brokerId/topics', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const limit = Math.min(Number(req.query.limit) || 100000, 500000);
  const { topics, total, dropped } = mqttManager.getTopics(req.params.brokerId, { limit });
  res.json({ topics, total, dropped, truncated: total > topics.length });
});

// GET /api/mqtt/brokers/:brokerId/messages?topic=...&limit=50
router.get('/brokers/:brokerId/messages', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, limit } = req.query;
  if (!topic) return res.status(400).json({ error: 'topic query parameter is required' });
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const messages = mqttManager.getMessages(
    req.params.brokerId,
    topic,
    Math.min(Number(limit) || 50, 500)
  );
  res.json({ topic, count: messages.length, messages });
});

// GET /api/mqtt/brokers/:brokerId/sparkplug — Sparkplug B device topology
// (real publishing endpoints: Group → Edge Node → Device, with online state and
// each endpoint's metric set). Empty until Sparkplug traffic is observed.
router.get('/brokers/:brokerId/sparkplug', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  res.json(mqttManager.getSparkplug(req.params.brokerId));
});

// GET /api/mqtt/brokers/:brokerId/sys — broker `$SYS` health + audit stats.
// NOTE: standard MQTT (and the `$SYS` tree) exposes broker health and client /
// subscription COUNTS, not a per-client "who subscribes to what" map. That
// requires a broker admin API (EMQX/HiveMQ REST, mosquitto_ctrl); reported here
// via `subscriberVisibility` so the UI can be honest about it.
router.get('/brokers/:brokerId/sys', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const sys = mqttManager.getSysStats(req.params.brokerId);
  res.json({
    ...sys,
    subscriberVisibility: {
      perClientSubscriptions: false,
      reason:
        'Core MQTT and $SYS expose aggregate counts only. Per-client subscriptions require a broker admin API (e.g. EMQX/HiveMQ REST or mosquitto_ctrl).'
    }
  });
});

// GET/POST/DELETE /api/mqtt/brokers/:brokerId/admin — broker admin API config
// (the ONLY honest source of per-client subscriptions). Secret is never echoed.
router.get('/brokers/:brokerId/admin', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  res.json(mqttManager.getBrokerAdmin(req.params.brokerId));
});

router.post('/brokers/:brokerId/admin', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  try {
    const result = mqttManager.setBrokerAdmin(req.params.brokerId, req.body || {});
    profiles?.setBrokerAdmin(req.params.brokerId, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/brokers/:brokerId/admin', (req, res) => {
  const { mqttManager, profiles } = req.app.locals.services;
  profiles?.clearBrokerAdmin(req.params.brokerId);
  res.json(mqttManager.clearBrokerAdmin(req.params.brokerId));
});

// GET /api/mqtt/brokers/:brokerId/admin/pubsub[?resolve=1&sampleLimit=25]
// Clients + their subscriptions fetched live from the configured broker admin
// API (e.g. EMQX REST) — "who subscribes to what", which core MQTT / $SYS cannot
// provide. With ?resolve=1 each unique filter is additionally RESOLVED against
// the observed topic set (exact match counts, covering roots, topic samples), so
// a broad filter like `spBv1.0/#` shows the concrete topics it actually receives.
router.get('/brokers/:brokerId/admin/pubsub', async (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  try {
    const pubsub = await mqttManager.fetchAdminPubSub(req.params.brokerId);
    if (req.query.resolve === '1' && pubsub.configured) {
      const sampleLimit = Math.min(Number(req.query.sampleLimit) || 50, 2000);
      const filters = pubsub.subscriptions.map((s) => s.topic);
      const resolved = mqttManager.resolveSubscriptions(req.params.brokerId, filters, { sampleLimit });
      if (resolved) {
        pubsub.resolution = {
          topicTotal: resolved.topicTotal,
          dropped: resolved.dropped,
          generation: resolved.generation,
          byFilter: Object.fromEntries(resolved.results.map((r) => [r.filter, r]))
        };
      }
    }
    res.json(pubsub);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// POST /api/mqtt/brokers/:brokerId/subscriptions/resolve { filters, sampleLimit?, rootsLimit? }
// Standalone wildcard-resolution primitive: what would these filters receive,
// given the topics actually observed on this broker? Counts are always exact;
// samples/roots are bounded.
router.post('/brokers/:brokerId/subscriptions/resolve', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const { filters, sampleLimit, rootsLimit } = req.body || {};
  if (!Array.isArray(filters) || filters.length === 0) {
    return res.status(400).json({ error: 'filters[] is required' });
  }
  if (filters.length > 5000) {
    return res.status(400).json({ error: 'too many filters (max 5000)' });
  }
  const result = mqttManager.resolveSubscriptions(req.params.brokerId, filters, {
    sampleLimit: Math.min(Number(sampleLimit) || 100, 2000),
    rootsLimit: Math.min(Number(rootsLimit) || 50, 500)
  });
  res.json(result);
});

// GET /api/mqtt/brokers/:brokerId/topictree?prefix=a/b&limit=500
// One level of the observed topic tree with subtree counts — lazy drill-down for
// the Flows lineage view (never ships a whole subtree).
router.get('/brokers/:brokerId/topictree', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  res.json(mqttManager.getTopicChildren(req.params.brokerId, req.query.prefix || '', { limit }));
});

// GET /api/mqtt/brokers/:brokerId/uns/tree?prefix=&depth=4&maxNodes=2000
// Nested namespace skeleton for the UNS module and MCP. Depth/node-capped;
// every node carries its exact subtree topic count even when children are cut.
router.get('/brokers/:brokerId/uns/tree', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const result = mqttManager.getUnsTree(req.params.brokerId, {
    prefix: req.query.prefix || '',
    depth: Math.min(Number(req.query.depth) || 4, 12),
    maxNodes: Math.min(Number(req.query.maxNodes) || 2000, 10000)
  });
  res.json(result);
});

// GET /api/mqtt/brokers/:brokerId/uns/lint — namespace conformance report
// (naming consistency, data-on-branch, empty segments, depth spread...).
router.get('/brokers/:brokerId/uns/lint', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  res.json(mqttManager.lintNamespace(req.params.brokerId));
});

// GET /api/mqtt/brokers/:brokerId/uns/events?limit=200 — namespace event feed:
// new-topic appearances + Sparkplug BIRTH/DEATH lifecycle, newest first.
router.get('/brokers/:brokerId/uns/events', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  if (!mqttManager.getConnection(req.params.brokerId)) {
    return res.status(404).json({ error: 'Broker not found' });
  }
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(mqttManager.getNamespaceEvents(req.params.brokerId, { limit }));
});

// POST /api/mqtt/brokers/:brokerId/subscribe { topic, qos }
router.post('/brokers/:brokerId/subscribe', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, qos } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    mqttManager.subscribe(req.params.brokerId, topic, qos || 0);
    res.status(202).json({ brokerId: req.params.brokerId, topic, qos: qos || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/mqtt/brokers/:brokerId/unsubscribe { topic }
router.post('/brokers/:brokerId/unsubscribe', (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    mqttManager.unsubscribe(req.params.brokerId, topic);
    res.status(202).json({ brokerId: req.params.brokerId, topic });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/mqtt/brokers/:brokerId/publish { topic, payload, qos, retain, properties }
router.post('/brokers/:brokerId/publish', async (req, res) => {
  const { mqttManager } = req.app.locals.services;
  const { topic, payload, qos, retain, properties } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  if (properties !== undefined) {
    const invalid = validatePublishProperties(properties);
    if (invalid) return res.status(400).json({ error: invalid });
  }
  try {
    const result = await mqttManager.publish(req.params.brokerId, topic, payload ?? '', { qos, retain, properties });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
