const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { RULE_TYPES, VALUE_OPS } = require('../services/alertEngine');
const router = express.Router();
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage } = require('../services/references');

// A rule as GET shows it: the viewer role sees only whether a webhook is set.
const presentRule = (role, r) => (role === 'viewer' && r.webhookUrl ? { ...r, webhookUrl: null, hasWebhook: true } : r);

// Alert rules are persisted in the profile store; the engine picks changes up
// on its next evaluation pass (no restart, no re-arm dance).

// GET /api/alerts/rules
router.get('/rules', (req, res) => {
  const { profiles, alerts } = req.app.locals.services;
  res.json({
    // Webhook URLs are credentials (Slack/Teams); the read-only role sees only
    // whether one is set.
    // `state` is the engine's own view of the rule (idle | breached | firing | disabled | broken, since,
    // value, remainingMs until firing, lastTransition, webhook health) - nothing here is guessed from events.
    rules: (profiles?.alertRules() || []).map((r) => ({ ...presentRule(req.role, r), state: alerts?.getRuleState?.(r) || null })),
    types: RULE_TYPES,
    // Webhook delivery health — collected by the engine, surfaced here so a
    // silently failing webhook shows up somewhere an operator looks.
    webhookFailures: alerts?.webhookFailures || 0,
    lastWebhookError: alerts?.lastWebhookError || null
  });
});

// POST /api/alerts/rules { name, type, brokerId, path?, topic?, prefix?, thresholdMs?,
//                          field?, op?, value?, sustainMs?, clearValue?, webhookUrl?, enabled? }
router.post('/rules', (req, res) => {
  const { profiles, mqttManager } = req.app.locals.services;
  const { id, name, type, brokerId, path, topic, prefix, thresholdMs, field, op, value, sustainMs, clearValue, webhookUrl, enabled } = req.body || {};
  const expectRev = checkpoint(req, res, profiles, 'alertRules', id, () => {
    const r = profiles.alertRules().find((x) => x.id === id);
    return r ? presentRule(req.role, r) : null;
  });
  if (expectRev === false) return;
  if (!RULE_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${RULE_TYPES.join(', ')}` });
  }
  if (!brokerId) return res.status(400).json({ error: 'brokerId is required' });
  if (type === 'topic-silent' && !topic) return res.status(400).json({ error: 'topic is required for topic-silent rules' });

  const base = {
    name: name || null,
    type,
    brokerId,
    path: path || '',
    topic: topic || null,
    prefix: prefix || '',
    thresholdMs: Number(thresholdMs) > 0 ? Number(thresholdMs) : 60_000,
    webhookUrl: webhookUrl || null,
    enabled: enabled !== false
  };

  if (type === 'value-threshold') {
    if (!topic) return res.status(400).json({ error: 'topic is required for value-threshold rules' });
    if (!VALUE_OPS.includes(op)) return res.status(400).json({ error: `op must be one of: ${VALUE_OPS.join(', ')}` });
    const limit = Number(value);
    if (!Number.isFinite(limit)) return res.status(400).json({ error: 'value must be a number' });
    const sustain = sustainMs === undefined || sustainMs === null || sustainMs === '' ? 0 : Number(sustainMs);
    if (!Number.isFinite(sustain) || sustain < 0) return res.status(400).json({ error: 'sustainMs must be a number >= 0' });
    let clear = null;
    if (clearValue !== undefined && clearValue !== null && clearValue !== '') {
      clear = Number(clearValue);
      if (!Number.isFinite(clear)) return res.status(400).json({ error: 'clearValue must be a number' });
    }
    Object.assign(base, {
      field: field ? String(field) : null,
      op,
      value: limit,
      sustainMs: sustain,
      clearValue: clear
    });
  }

  const missing = missingRefsMessage('alertRules', base, { profiles, mqttManager });
  if (missing) return res.status(400).json({ error: missing });
  let rule;
  try {
    rule = profiles.upsertAlertRule(id || uuidv4(), base, { expectRev });
  } catch (error) {
    if (handleRevisionError(res, error, (r) => presentRule(req.role, r))) return;
    throw error;
  }
  res.status(201).json(rule);
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', (req, res) => {
  const { profiles } = req.app.locals.services;
  if (!profiles.removeAlertRule(req.params.id)) {
    return res.status(404).json({ error: 'Rule not found' });
  }
  res.json({ removed: req.params.id });
});

// GET /api/alerts/events?limit=200&ruleId= — recent firings, newest first (one rule's with ruleId)
router.get('/events', (req, res) => {
  const { alerts } = req.app.locals.services;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const ruleId = typeof req.query.ruleId === 'string' && req.query.ruleId ? req.query.ruleId : null;
  res.json({ events: alerts ? alerts.getEvents(limit, { ruleId }) : [] });
});

module.exports = router;
