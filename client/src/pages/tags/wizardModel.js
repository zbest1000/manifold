// Pure validation for the bind wizard. Server-side preview results (collisions with
// other bindings, the server's own rejection) are folded in so they block the wizard too.
import { validateTemplate, resolvePreview, findCollisions, commonPrefix, slug, sparkplugScopeError } from './helpers';
import { validateAssetPath, validateAssetTemplate, normalizeAssetPath } from './assetPath';
import { allowedPlaceholders, instanceRows } from './profileModel';
import { blockingCollisions } from './previewModel';

export const SELECT_CLS =
  'w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20';

/** mqtt sources compile to a pipeline route: tail re-pathed under the base template. */
export function mqttSourceTopics(rows, pathTemplate) {
  const base = String(pathTemplate || '').replace(/\/?\{name\}$/, '') || 'uns/imported';
  const addrs = rows.map((r) => r.address);
  const prefix = addrs.length === 1 ? addrs[0].split('/').slice(0, -1).join('/') + (addrs[0].includes('/') ? '/' : '') : commonPrefix(addrs);
  return { base, prefix, rows: rows.map((r) => ({ ...r, name: r.address.slice(prefix.length) || r.address.split('/').pop() })) };
}

const SP_PART = /^[^\s/+#]+$/;

/** Topic template the client fallback uses for rows (no network): asset path or legacy template. */
export function fallbackTemplate(form, srcType) {
  if (srcType === 'device-profile') return '{name}';
  return form.destKind === 'asset' ? `${normalizeAssetPath(form.assetPath) || '?'}/{name}` : form.pathTemplate;
}

/**
 * Returns { errors: [{ step, message }], resolved, collisions }.
 * step: 0 target, 1 naming, 2 options. resolved = client-side rows (instant fallback).
 */
export function validateWizard({ srcType, mode, form, rows, brokers, profile = null, devices = null, preview = null, allowEmpty = false }) {
  const errors = [];
  const add = (step, message, field) => errors.push({ step, message, field });
  const isProfile = srcType === 'device-profile';

  if (!brokers.length) add(0, 'No connected broker. Connect one under Brokers first.');
  else if (!form.brokerId) add(0, 'Choose a target broker.');
  if (isProfile && !profile) add(0, 'Choose a device profile.');
  if (!rows.length && !allowEmpty) add(0, isProfile ? 'Select at least one profile tag.' : 'Nothing selected.');

  let resolved;
  let collisions = new Map();
  if (srcType === 'mqtt') {
    const m = mqttSourceTopics(rows, form.pathTemplate);
    resolved = resolvePreview(`${m.base}/{name}`, m.rows);
    const err = validateTemplate(form.pathTemplate);
    if (err) add(0, err, 'dest');
  } else if (mode === 'mqtt') {
    if (isProfile) {
      const hasMap = Object.values(form.assetPaths || {}).some((p) => String(p).trim());
      if (form.assetPathTemplate.trim() || !hasMap) {
        const err = validateAssetTemplate(form.assetPathTemplate, allowedPlaceholders(profile));
        if (err) add(0, err, 'dest');
      }
      for (const r of instanceRows({ profile, devices, template: form.assetPathTemplate, overrides: form.assetPaths })) {
        if (r.error && form.assetPathTemplate.trim()) add(0, r.error, 'dest');
      }
    } else if (form.destKind === 'asset') {
      const err = validateAssetPath(normalizeAssetPath(form.assetPath));
      if (err) add(0, err, 'dest');
    } else {
      const err = validateTemplate(form.pathTemplate);
      if (err) add(0, err, 'dest');
    }
    resolved = resolvePreview(fallbackTemplate(form, srcType), rows);
    collisions = findCollisions(resolved);
    if (rows.some((r) => !String(r.name).trim())) add(1, 'Every tag needs a name.');
    else if (collisions.size) {
      const [topic, keys] = [...collisions][0];
      add(1, `${keys.length} tags resolve to the same topic ${topic}${collisions.size > 1 ? ` (and ${collisions.size - 1} more)` : ''}. Rename them below.`);
    }
    if (form.layout === 'object-per-asset' && form.maxObjectBytes !== '') {
      const n = Number(form.maxObjectBytes);
      if (!Number.isInteger(n) || n < 1024 || n > 1048576) add(2, 'Maximum object size must be a whole number from 1024 to 1048576 bytes.');
    }
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

  // Server-side preview: other bindings' topics block; the server's own rejection (e.g. the object size cap) blocks.
  if (preview?.status === 'ok' && preview.data) {
    if (preview.data.valid === false) add(1, preview.data.error || 'The server rejected this binding.');
    else {
      const clash = blockingCollisions(preview.data);
      if (clash.length) {
        const c = clash[0];
        add(1, `${clash.length} topic${clash.length === 1 ? '' : 's'} already published by another binding (${c.topic} by ${c.bindings.map((b) => b.name || b.id).join(', ')}). Rename the tag or change the asset path.`);
      }
    }
  }

  if (srcType !== 'mqtt') {
    if (form.dbValue !== '') {
      const v = Number(form.dbValue);
      if (!(v >= 0)) add(2, 'Deadband must be a number of 0 or more.');
      else if (form.dbType === 'percent' && v > 100) add(2, 'A percent deadband must be between 0 and 100.');
    }
    if (form.heartbeatMs !== '' && !(Number.isInteger(Number(form.heartbeatMs)) && Number(form.heartbeatMs) >= 0)) add(2, 'Heartbeat must be a whole number of milliseconds (0 = off).');
    else if (Number(form.heartbeatMs) > 0 && Number(form.heartbeatMs) < 1000) add(2, 'Heartbeat below 1000 ms floods the broker. Use 1000 or more, or 0 to turn it off.');
  }
  if (srcType === 'opcua' && !(Number(form.samplingInterval) >= 50)) add(2, 'Sampling interval must be at least 50 ms.');
  return { errors, resolved, collisions };
}
