/** Pure helpers for the Alerts page: rules, active alarms and history (unit tested in src/test/alerts.test.js). */

export const RULE_LABEL = {
  'branch-silent': 'Branch silent',
  'topic-silent': 'Topic silent',
  'new-topic': 'New topic appears',
  'value-threshold': 'Value threshold'
};

export const VALUE_OPS = ['>', '>=', '<', '<=', '==', '!='];

export const EMPTY_RULE_FORM = {
  id: null,
  type: 'branch-silent',
  brokerId: '',
  path: '',
  topic: '',
  prefix: '',
  thresholdSec: 60,
  field: '',
  op: '>',
  value: '',
  sustainSec: '',
  clearValue: '',
  webhookUrl: '',
  // An existing rule's webhook is never sent to the browser (it is a credential): the form knows only
  // whether one is set and its origin. 'keep' leaves it as stored, 'replace' sends webhookUrl, 'remove' clears it.
  hasWebhook: false,
  webhookOrigin: null,
  webhookMode: 'replace',
  name: '',
  severity: 'warning'
};

/**
 * Compact one-line definition of a value rule for the rule list,
 * e.g. "plant/+/temp · v > 80 for 30s, clear at 75".
 */
export function valueRuleSummary(r) {
  let s = `${r.topic} · ${r.field || 'value'} ${r.op} ${r.value}`;
  if (r.sustainMs > 0) s += ` for ${Math.round(r.sustainMs / 1000)}s`;
  if (r.clearValue !== null && r.clearValue !== undefined) s += `, clear at ${r.clearValue}`;
  return s;
}

/** What a rule watches, for the rules table ("plant/line1 > 60s", "under plant/", ...). */
export function ruleScope(r) {
  switch (r.type) {
    case 'branch-silent':
      return `${r.path || '(whole namespace)'} > ${Math.round(r.thresholdMs / 1000)}s`;
    case 'topic-silent':
      return `${r.topic} > ${Math.round(r.thresholdMs / 1000)}s`;
    case 'new-topic':
      return r.prefix ? `under ${r.prefix}` : 'anywhere';
    case 'value-threshold':
      return valueRuleSummary(r);
    default:
      return '';
  }
}

/** Load an existing rule back into the editor form. */
export function formFromRule(r) {
  return {
    id: r.id,
    rev: r.rev, // the revision the form was loaded at: a save over a newer one is refused (409)
    type: r.type,
    brokerId: r.brokerId || '',
    path: r.path || '',
    topic: r.topic || '',
    prefix: r.prefix || '',
    thresholdSec: Math.round((r.thresholdMs || 60_000) / 1000),
    field: r.field || '',
    op: r.op || '>',
    value: r.value ?? '',
    sustainSec: r.sustainMs > 0 ? Math.round(r.sustainMs / 1000) : '',
    clearValue: r.clearValue ?? '',
    webhookUrl: '',
    hasWebhook: Boolean(r.hasWebhook || r.webhookUrl),
    webhookOrigin: r.webhookOrigin || null,
    webhookMode: r.hasWebhook || r.webhookUrl ? 'keep' : 'replace',
    name: r.name || '',
    severity: SEVERITY[r.severity] ? r.severity : 'warning'
  };
}

/** Request body for saving a rule; keeping the id makes the POST an upsert. */
export function ruleBody(form, defaultBrokerId) {
  const body = {
    id: form.id || undefined,
    name: form.name || null,
    type: form.type,
    brokerId: form.brokerId || defaultBrokerId,
    path: form.path,
    topic: form.topic || null,
    prefix: form.prefix,
    thresholdMs: Number(form.thresholdSec) * 1000,
    severity: SEVERITY[form.severity] ? form.severity : 'warning'
  };
  // Webhook, like a password: omitted keeps the stored URL, '' removes it, a value replaces it.
  if (form.webhookMode === 'remove') body.webhookUrl = '';
  else if (form.webhookMode !== 'keep' && form.webhookUrl) body.webhookUrl = form.webhookUrl;
  if (form.id && form.rev !== undefined) body.rev = form.rev;
  if (form.type === 'value-threshold') {
    body.field = form.field || null;
    body.op = form.op;
    body.value = Number(form.value);
    body.sustainMs = form.sustainSec === '' ? 0 : Number(form.sustainSec) * 1000;
    body.clearValue = form.clearValue === '' ? null : Number(form.clearValue);
  }
  return body;
}

/** Tone of an alert event's status. */
export const alertTone = (status) => ({ firing: 'bad', resolved: 'good', acknowledged: 'info', ended: 'neutral', event: 'info' })[status] || 'info';

/** Wording of an alert event's status (history, per-rule events). */
export const STATUS_LABEL = { firing: 'Firing', resolved: 'Resolved', event: 'Event', acknowledged: 'Acknowledged', ended: 'Ended' };

/** Severities, most severe first. `tone` drives StatusText; `rank` sorts. */
export const SEVERITY = {
  critical: { label: 'Critical', tone: 'bad', rank: 3 },
  warning: { label: 'Warning', tone: 'warn', rank: 2 },
  info: { label: 'Info', tone: 'info', rank: 1 }
};
export const severityView = (s) => SEVERITY[s] || SEVERITY.warning;

const STATE_VIEW = {
  idle: { key: 'ok', label: 'Idle', tone: 'good' },
  breached: { key: 'breached', label: 'Breached', tone: 'warn' },
  firing: { key: 'firing', label: 'Firing', tone: 'bad' },
  disabled: { key: 'disabled', label: 'Disabled', tone: 'neutral' },
  broken: { key: 'broken', label: 'Broken reference', tone: 'bad' }
};

/**
 * Where each rule stands now. The server reports the engine's real state on every rule (`r.state`: idle |
 * breached | firing | disabled | broken, with `since`, `value`, `remainingMs` until firing, `lastTransition`,
 * webhook health), so that is what is shown. A rule without it (an older server) falls back to the newest
 * event per rule: 'firing' when its latest event is a firing, 'ok' otherwise.
 */
export function ruleStates(rules, events) {
  const latest = new Map();
  for (const e of events || []) if (!latest.has(e.ruleId)) latest.set(e.ruleId, e); // events are newest first
  const out = {};
  for (const r of rules || []) {
    const e = latest.get(r.id);
    const live = r.state && STATE_VIEW[r.state.state];
    if (live) {
      out[r.id] = { ...live, since: r.state.since, value: r.state.value, topic: r.state.topic, remainingMs: r.state.remainingMs, sustainMs: r.state.sustainMs, firingTopics: r.state.firingTopics, broken: r.state.broken, webhook: r.state.webhook, last: r.state.lastTransition?.ts };
      continue;
    }
    out[r.id] = r.enabled === false ? { key: 'disabled', label: 'Disabled', tone: 'neutral' } : e?.status === 'firing' ? { key: 'firing', label: 'Firing', tone: 'bad', since: e.ts } : { key: 'ok', label: 'Idle', tone: 'good', last: e?.ts };
  }
  return out;
}

// ---- active alarms ----------------------------------------------------------------------------

/** "45 s", "3 min 05 s", "2 h 04 min", "3 d 2 h": how long an alarm has been active. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return `${m} min ${pad(sec)} s`;
  return `${sec} s`;
}

/** Sort accessors for the active-alarm table (used with lib/sortRows). */
export const ALARM_SORT = {
  severity: (a) => severityView(a.severity).rank,
  alarm: (a) => a.ruleName,
  topic: (a) => a.topic,
  value: (a) => (typeof a.value === 'number' ? a.value : null),
  since: (a) => a.since,
  state: (a) => (a.state === 'breached' ? 0 : a.acknowledged ? 1 : 2)
};

/**
 * The default order: what needs a person first. Unacknowledged firing alarms, then acknowledged ones,
 * then breached (not firing yet); within each, most severe first, then longest active.
 */
export function defaultAlarmOrder(alarms) {
  return [...(alarms || [])].sort((a, b) => ALARM_SORT.state(b) - ALARM_SORT.state(a) || ALARM_SORT.severity(b) - ALARM_SORT.severity(a) || a.since - b.since);
}

/** Alarms a person can acknowledge now: firing and not acknowledged yet. */
export const canAcknowledge = (a) => a.state === 'firing' && !a.acknowledged;

/** Where an alarm is shown: the Alerts page with that alarm highlighted. */
export const alarmLink = (ruleId, topic) => `/alerts?alarm=${encodeURIComponent(`${ruleId}|${topic || ''}`)}`;

/**
 * The alarm id a silence or new-topic rule uses on the server is `ruleId|` (no topic); a value rule's is
 * `ruleId|topic`. Overview links carry the rule's reported topic, which for a silence rule is its path, so
 * a link matches an alarm by its id, or by rule when the rule has one alarm.
 */
export function matchesAlarmLink(alarm, link) {
  if (!link) return false;
  if (alarm.id === link) return true;
  const [ruleId] = String(link).split('|');
  return alarm.ruleId === ruleId && alarm.type !== 'value-threshold';
}

/** One line for the active-alarm summary: "3 firing (2 unacknowledged), 1 breached". */
export function activeSummary(counts) {
  const c = counts || {};
  if (!c.firing && !c.breached) return 'No active alarms';
  const parts = [];
  if (c.firing) parts.push(`${c.firing} firing${c.unacknowledged ? ` (${c.unacknowledged} unacknowledged${c.unacknowledgedCritical ? `, ${c.unacknowledgedCritical} critical` : ''})` : ', all acknowledged'}`);
  if (c.breached) parts.push(`${c.breached} breached, not firing yet`);
  return parts.join(', ');
}

// ---- history ----------------------------------------------------------------------------------

export const EMPTY_HISTORY_FILTERS = { q: '', ruleId: '', state: '', severity: '', from: '', to: '' };

/**
 * Query string for GET /api/alerts/history from the filter form. `from`/`to` come from
 * datetime-local inputs (local time, no zone) and are sent as epoch ms.
 */
export function historyQuery(filters, { cursor = null, limit = 100, format = null } = {}) {
  const p = new URLSearchParams();
  const f = { ...EMPTY_HISTORY_FILTERS, ...(filters || {}) };
  if (f.q.trim()) p.set('q', f.q.trim());
  for (const k of ['ruleId', 'state', 'severity']) if (f[k]) p.set(k, f[k]);
  for (const k of ['from', 'to']) {
    if (!f[k]) continue;
    const t = new Date(f[k]).getTime();
    if (Number.isFinite(t)) p.set(k, String(k === 'to' ? t + 59_999 : t)); // "to 10:05" includes all of 10:05
  }
  if (cursor) p.set('cursor', String(cursor));
  if (format) p.set('format', format);
  else p.set('limit', String(limit));
  return p.toString();
}

/** True when any history filter is set. */
export const hasHistoryFilters = (filters) => Object.entries(filters || {}).some(([k, v]) => k in EMPTY_HISTORY_FILTERS && String(v || '').trim() !== '');

/** "1.2 MB" */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
