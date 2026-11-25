/** Pure helpers for the Settings page cards (unit-tested in src/test/settingsHelpers.test.js). */

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
  name: ''
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
    webhookUrl: r.webhookUrl || '',
    name: r.name || ''
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
    webhookUrl: form.webhookUrl || null
  };
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

const CONFIG_KEYS = ['historians', 'pipelines', 'models', 'recordings', 'contracts', 'bindings', 'alertRules', 'mounts'];

/** "3 pipelines, 1 historians" for the import confirmation. */
export function importSummary(cfg) {
  return CONFIG_KEYS.map((k) => (Array.isArray(cfg?.[k]) && cfg[k].length ? `${cfg[k].length} ${k}` : null))
    .filter(Boolean)
    .join(', ');
}

/** Tone of an audit entry's status: failed calls read bad, successful ones good. */
export const auditTone = (e) => (e.status >= 400 ? 'bad' : 'good');

/** Tone of an alert event's status. */
export const alertTone = (status) => (status === 'firing' ? 'bad' : status === 'resolved' ? 'good' : 'info');

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
