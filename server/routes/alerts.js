const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { RULE_TYPES, VALUE_OPS, SEVERITIES } = require('../services/alertEngine');
const { toCsv } = require('../services/alertHistory');
const router = express.Router();
const { checkpoint, handleRevisionError } = require('../services/revision');
const { missingRefsMessage } = require('../services/references');

// A rule as every answer shows it. The webhook URL is a secret like a password (for Slack/Teams-style
// hooks the path IS the credential): no role ever gets it back, only whether one is set and its origin
// (scheme://host[:port]) so an editor can tell which service it calls.
function webhookOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const presentRule = (_role, r) => (r ? { ...r, webhookUrl: null, hasWebhook: Boolean(r.webhookUrl), webhookOrigin: r.webhookUrl ? webhookOrigin(r.webhookUrl) : null } : r);

// Alert rules are persisted in the profile store; the engine picks changes up
// on its next evaluation pass (no restart, no re-arm dance).

// GET /api/alerts/rules
router.get('/rules', (req, res) => {
  const { profiles, alerts } = req.app.locals.services;
  res.json({
    // Webhook URLs are credentials (Slack/Teams): every role sees only whether one is set and its origin.
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

// POST /api/alerts/rules { name, type, brokerId, severity?, path?, topic?, prefix?, thresholdMs?,
//                          field?, op?, value?, sustainMs?, clearValue?, webhookUrl?, enabled? }
// severity: info | warning | critical (default warning). sustainMs is the "for" time a value rule must
// stay breached before it fires; clearValue is its clear hysteresis. Silence rules fire after thresholdMs.
router.post('/rules', (req, res) => {
  const { profiles, mqttManager, alerts } = req.app.locals.services;
  const { id, name, type, brokerId, severity, path, topic, prefix, thresholdMs, field, op, value, sustainMs, clearValue, webhookUrl, enabled } = req.body || {};
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
  if (severity !== undefined && severity !== null && severity !== '' && !SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
  }

  const base = {
    name: name || null,
    type,
    brokerId,
    severity: SEVERITIES.includes(severity) ? severity : 'warning',
    path: path || '',
    topic: topic || null,
    prefix: prefix || '',
    thresholdMs: Number(thresholdMs) > 0 ? Number(thresholdMs) : 60_000,
    // Leave-blank-to-keep, like a password: absent or null keeps the stored URL (answers never carry
    // it), an empty string removes it, any other value replaces it.
    webhookUrl: webhookUrl === undefined || webhookUrl === null ? (id && profiles.alertRules().find((x) => x.id === id)?.webhookUrl) || null : webhookUrl || null,
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
  alerts?.reconcileRules?.(); // a rule that was just disabled closes its active alarms now, not on the next pass
  res.status(201).json(presentRule(req.role, rule));
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', (req, res) => {
  const { profiles, alerts } = req.app.locals.services;
  if (!profiles.removeAlertRule(req.params.id)) {
    return res.status(404).json({ error: 'Rule not found' });
  }
  alerts?.reconcileRules?.(); // its active alarms end now, with an 'ended' event in the history
  res.json({ removed: req.params.id });
});

// GET /api/alerts/events?limit=200&ruleId= — recent firings, newest first (one rule's with ruleId)
router.get('/events', (req, res) => {
  const { alerts } = req.app.locals.services;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const ruleId = typeof req.query.ruleId === 'string' && req.query.ruleId ? req.query.ruleId : null;
  res.json({ events: alerts ? alerts.getEvents(limit, { ruleId }) : [] });
});

// GET /api/alerts/active — the alarms that are firing now (one per rule, or per concrete topic for wildcard
// value rules), plus value rules breached and waiting out their sustain time. Oldest first.
//   { alarms: [{ id, ruleId, ruleName, severity, type, brokerId, topic, value, since, state, condition,
//                remainingMs?, acknowledged, ack: { by, at, note } | null }],
//     counts: { firing, breached, unacknowledged, unacknowledgedCritical }, serverTime }
router.get('/active', (req, res) => {
  const { alerts } = req.app.locals.services;
  const now = Date.now();
  const alarms = alerts?.getActive?.(now) || [];
  const counts = { firing: 0, breached: 0, unacknowledged: 0, unacknowledgedCritical: 0 };
  for (const a of alarms) {
    counts[a.state] = (counts[a.state] || 0) + 1;
    if (a.state === 'firing' && !a.acknowledged) {
      counts.unacknowledged++;
      if (a.severity === 'critical') counts.unacknowledgedCritical++;
    }
  }
  res.json({ alarms, counts, serverTime: now });
});

// Who acknowledged: the named token's name when the server has authentication, otherwise "operator"
// (an open instance cannot tell people apart, and must not pretend to).
const ackIdentity = (req) => (req.tokenName && req.tokenName !== 'open' ? req.tokenName : 'operator');

// POST /api/alerts/ack { ruleId, topic?, all?, note?, since? }
//   One alarm: ruleId (+ topic for value rules). Every firing alarm of a rule: all: true.
//   since (optional): the start of the occurrence the operator saw; 409 when it has fired again since.
// The acknowledgement holds until the alarm clears and never suppresses a later firing.
router.post('/ack', (req, res) => {
  const { alerts } = req.app.locals.services;
  const { ruleId, topic, all, note, since } = req.body || {};
  if (typeof ruleId !== 'string' || !ruleId) return res.status(400).json({ error: 'ruleId is required' });
  if (topic !== undefined && topic !== null && typeof topic !== 'string') return res.status(400).json({ error: 'topic must be a string' });
  if (note !== undefined && note !== null && typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' });
  if (typeof note === 'string' && note.length > 500) return res.status(400).json({ error: 'note must be 500 characters or fewer' });
  const result = alerts.acknowledge({ ruleId, topic: topic || null, all: all === true, note, since: since ?? null, by: ackIdentity(req) });
  if (result.error === 'not-found') return res.status(404).json({ error: 'Rule not found' });
  if (result.error === 'not-firing') return res.status(409).json({ code: 'not-firing', error: 'That alarm is not firing (it may have cleared)' });
  if (result.error === 'stale') return res.status(409).json({ code: 'stale', error: 'That alarm cleared and fired again since you looked: review it before acknowledging' });
  res.json(result);
});

// GET /api/alerts/history?cursor=&limit=&ruleId=&state=&severity=&q=&from=&to=&format=csv
//   Durable history (data/alerts.jsonl), newest first. state/severity take comma-separated lists
//   (state: firing, resolved, event, acknowledged, ended). from/to: epoch ms or ISO time. Paging: pass the
//   returned nextCursor as cursor. format=csv exports every matching event (up to 100,000) instead.
router.get('/history', (req, res) => {
  const { alerts } = req.app.locals.services;
  if (req.query.format === 'csv') {
    const { events } = alerts.queryHistory({ ...req.query, cursor: null, limit: 100_000 }, { maxLimit: 100_000 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manifold-alert-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv"`);
    return res.send(toCsv(events));
  }
  const page = alerts.queryHistory(req.query);
  res.json({ ...page, journal: alerts.journal ? { bytes: alerts.journal.bytes(), maxBytes: alerts.journal.maxBytes, writeErrors: alerts.journal.stats.writeErrors } : null });
});

module.exports = router;
