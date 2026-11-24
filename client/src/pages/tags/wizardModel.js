// Pure model for the bind wizard: derive rows, validation and the request body.
import {
  validateTemplate, resolvePreview, findCollisions, commonPrefix, slug, spScope, sparkplugScopeError
} from './helpers';

export const SELECT_CLS =
  'w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20';

/** Rows the wizard works on: [{ key, address, name, meta }]. */
export function initialRows(editing, selection) {
  if (editing) {
    const s = editing.source || {};
    if (Array.isArray(s.tags)) return s.tags.map((t, i) => ({ key: `${i}:${t.address}`, address: t.address, name: t.name || t.address, meta: {} }));
    if (Array.isArray(s.metrics)) return s.metrics.map((m) => ({ key: m, address: m, name: m, meta: {} }));
    return [];
  }
  return [...selection.values()].map((t) => ({ key: t.id, address: t.address, name: t.name, meta: t.meta || {} }));
}

/** Topic each row will land on. mqtt sources compile to a pipeline route (tail re-pathed under the base). */
export function mqttSourceTopics(rows, pathTemplate) {
  const base = String(pathTemplate || '').replace(/\/?\{name\}$/, '') || 'uns/imported';
  const addrs = rows.map((r) => r.address);
  const prefix = addrs.length === 1 ? addrs[0].split('/').slice(0, -1).join('/') + (addrs[0].includes('/') ? '/' : '') : commonPrefix(addrs);
  return {
    base,
    prefix,
    rows: rows.map((r) => ({ ...r, name: r.address.slice(prefix.length) || r.address.split('/').pop() }))
  };
}

const SP_PART = /^[^\s/+#]+$/;

/**
 * Validation. Returns { errors: [{ step, message }], resolved, collisions }.
 * step: 0 target, 1 naming, 2 options.
 */
export function validateWizard({ srcType, mode, form, rows, brokers }) {
  const errors = [];
  const add = (step, message) => errors.push({ step, message });

  if (!brokers.length) add(0, 'No connected broker. Connect one under Brokers first.');
  else if (!form.brokerId) add(0, 'Choose a target broker.');

  let resolved;
  let collisions = new Map();
  if (srcType === 'mqtt') {
    const m = mqttSourceTopics(rows, form.pathTemplate);
    resolved = resolvePreview(`${m.base}/{name}`, m.rows);
    const err = validateTemplate(form.pathTemplate);
    if (err) add(1, err);
  } else if (mode === 'mqtt') {
    const err = validateTemplate(form.pathTemplate);
    if (err) add(1, err);
    resolved = resolvePreview(form.pathTemplate, rows);
    collisions = findCollisions(resolved);
    if (collisions.size) {
      const [topic, keys] = [...collisions][0];
      add(1, `${keys.length} tags resolve to the same topic ${topic}${collisions.size > 1 ? ` (and ${collisions.size - 1} more collision${collisions.size > 2 ? 's' : ''})` : ''}. Rename them in the preview table.`);
    }
    if (rows.some((r) => !String(r.name).trim())) add(1, 'Every tag needs a name.');
  } else {
    resolved = resolvePreview('{name}', rows);
    for (const [label, v] of [['Group', form.group], ['Edge node', form.edge], ['Device', form.device]]) {
      if (!String(v).trim()) add(1, `${label} is required.`);
      else if (!SP_PART.test(String(v).trim())) add(1, `${label} cannot contain spaces, /, + or #.`);
    }
    const dup = findCollisions(resolved.map((r) => ({ ...r, topic: slug(r.name) })));
    if (dup.size) add(1, 'Two metrics have the same name. Rename them in the preview table.');
    if (rows.some((r) => !String(r.name).trim())) add(1, 'Every metric needs a name.');
    if (srcType === 'sparkplug') {
      const e = sparkplugScopeError(rows);
      if (e) add(0, e);
    }
  }
  if (!rows.length) add(0, 'Nothing selected.');

  if (srcType !== 'mqtt') {
    if (form.deadband !== '' && !(Number(form.deadband) >= 0)) add(2, 'Deadband must be a number of 0 or more.');
    if (form.heartbeatMs !== '' && !(Number.isInteger(Number(form.heartbeatMs)) && Number(form.heartbeatMs) >= 0)) add(2, 'Heartbeat must be a whole number of milliseconds (0 = off).');
    else if (Number(form.heartbeatMs) > 0 && Number(form.heartbeatMs) < 1000) add(2, 'Heartbeat below 1000 ms floods the broker. Use 1000 or more, or 0 to turn it off.');
  }
  if (srcType === 'opcua' && !(Number(form.samplingInterval) >= 50)) add(2, 'Sampling interval must be at least 50 ms.');
  return { errors, resolved, collisions };
}

export function buildTarget(mode, form) {
  const deadband = Number(form.deadband) > 0 ? { deadband: Number(form.deadband) } : {};
  if (mode === 'sparkplug') {
    return { mode: 'sparkplug', brokerId: form.brokerId, group: form.group.trim(), edge: form.edge.trim(), device: form.device.trim(), ...deadband };
  }
  return {
    mode: 'mqtt',
    brokerId: form.brokerId,
    pathTemplate: form.pathTemplate,
    format: form.format,
    retain: form.retain,
    qos: Number(form.qos) || 0,
    ...deadband,
    ...(form.statusTopic ? {} : { statusTopic: false })
  };
}

export function buildRbe(form) {
  return Number(form.heartbeatMs) > 0 ? { heartbeatMs: Number(form.heartbeatMs) } : undefined;
}

/** Sparkplug source scope from the first selected metric; all metrics share one scope (validated). */
export function sparkplugSource(brokerId, rows) {
  const meta = rows[0]?.meta || {};
  return { type: 'sparkplug', brokerId, group: meta.group, edge: meta.edge, device: meta.device || null, metrics: rows.map((r) => r.address) };
}

export { spScope };
