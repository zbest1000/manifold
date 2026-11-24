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

/** Colour class for an audit entry's status. */
export const auditStatusClass = (e) => (e.status >= 400 ? 'text-rose-300' : 'text-emerald-300');

export const alertStatusClass = (status) => (status === 'firing' ? 'text-red-300' : status === 'resolved' ? 'text-emerald-300' : 'text-sky-300');
