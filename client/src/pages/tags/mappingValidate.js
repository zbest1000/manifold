// Client-side validation of a mapping draft; the server's verdict is folded in (pure; see mappingModel.js).
import { slug, looksLikeRawAddress } from './helpers';
import { normalizeAssetPath, validateAssetPath, validateAssetTemplate } from './assetPath';
import { instanceRows, allowedPlaceholders as pathPlaceholders } from './profileModel';
import { LIMIT_KEYS, renameable, publishingRows, contextRows, contextObject, nameSlug } from './mappingRows';
import { computeTopics } from './mappingTopics';

// ---- validation --------------------------------------------------------------------------------

const SP_PART = /^[^\s/+#]+$/;

function num(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Problems with one row's overrides -> [{ field, message }]. Mirrors the server's overrideError. */
export function rowErrors(row, schema = null) {
  const out = [];
  const lim = schema?.limits || {};
  const maxName = lim.maxNameLength || 128;
  const maxPrecision = lim.maxPrecision ?? 10;
  const o = row.ov;
  const name = String(row.name ?? '');
  if (row.enabled && !name.trim()) out.push({ field: 'name', message: 'Give this tag a published name.', required: true });
  if (name.length > maxName) out.push({ field: 'name', message: `Name is ${name.length} characters; at most ${maxName}.` });
  for (const [k, max, label] of [['displayName', 128, 'Display name'], ['description', 512, 'Description'], ['unit', 512, 'Unit']]) {
    if (typeof o[k] === 'string' && o[k].length > max) out.push({ field: k, message: `${label} is longer than ${max} characters.` });
  }
  if (o.range !== undefined) {
    const mn = num(o.range?.min);
    const mx = num(o.range?.max);
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) out.push({ field: 'range', message: 'Range needs a minimum and a maximum.' });
    else if (mn >= mx) out.push({ field: 'range', message: 'Range minimum must be below the maximum.' });
  }
  if (o.scale !== undefined && (!Number.isFinite(o.scale) || o.scale === 0)) out.push({ field: 'scale', message: 'Scale must be a number other than 0.' });
  if (o.offset !== undefined && !Number.isFinite(o.offset)) out.push({ field: 'offset', message: 'Offset must be a number.' });
  if (o.precision !== undefined && (!Number.isInteger(o.precision) || o.precision < 0 || o.precision > maxPrecision)) out.push({ field: 'precision', message: `Precision must be a whole number from 0 to ${maxPrecision}.` });
  if (o.limits !== undefined) {
    const seq = LIMIT_KEYS.filter((k) => o.limits[k] !== undefined);
    if (seq.some((k) => !Number.isFinite(o.limits[k]))) out.push({ field: 'limits', message: 'Limits must be numbers.' });
    else {
      for (let i = 1; i < seq.length; i++) {
        if (o.limits[seq[i - 1]] > o.limits[seq[i]]) {
          out.push({ field: 'limits', message: `Limits must be ordered lolo ≤ lo ≤ hi ≤ hihi (${seq[i - 1]} ${o.limits[seq[i - 1]]} is above ${seq[i]} ${o.limits[seq[i]]}).` });
          break;
        }
      }
    }
  }
  if (o.states !== undefined) {
    const entries = Object.entries(o.states || {});
    if (entries.length > (lim.maxStates || 256)) out.push({ field: 'states', message: `At most ${lim.maxStates || 256} states.` });
    if (entries.some(([k, v]) => !k || !String(v ?? '').trim())) out.push({ field: 'states', message: 'Every state needs a raw value and a label.' });
  }
  if (o.deadband !== undefined) {
    const v = typeof o.deadband === 'number' ? o.deadband : Number(o.deadband?.value);
    if (!Number.isFinite(v) || v < 0) out.push({ field: 'deadband', message: 'Deadband must be a number of 0 or more.' });
    else if (o.deadband?.type === 'percent' && v > 100) out.push({ field: 'deadband', message: 'A percent deadband must be between 0 and 100.' });
  }
  if (o.context !== undefined) {
    const e = contextErrors(contextRows(o.context), schema);
    if (e.length) out.push({ field: 'context', message: e[0].message });
  }
  return out;
}

/** Problems with a context editor list -> [{ id?, message }]. */
export function contextErrors(rows, schema = null, { allowed = null } = {}) {
  const lim = schema?.limits || {};
  const re = new RegExp(lim.contextKeyPattern || '^[A-Za-z][A-Za-z0-9_.-]{0,63}$');
  const maxKeys = lim.maxContextKeys || 32;
  const maxVal = lim.maxContextValueLength || 256;
  const maxBytes = lim.maxContextBytes || 4096;
  const out = [];
  const seen = new Set();
  const used = (rows || []).filter((r) => String(r.key).trim() || String(r.value).trim());
  if (used.length > maxKeys) out.push({ message: `${used.length} keys; at most ${maxKeys} are allowed.` });
  for (const r of used) {
    const k = String(r.key).trim();
    if (!k) out.push({ id: r.id, field: 'key', message: 'Give this value a key.' });
    else if (!re.test(k)) out.push({ id: r.id, field: 'key', message: `"${k}" is not a valid key: start with a letter, then letters, digits, _ . or - (at most 64).` });
    else if (seen.has(k)) out.push({ id: r.id, field: 'key', message: `Key "${k}" is used twice.` });
    seen.add(k);
    if (r.type === 'number' && !Number.isFinite(Number(r.value))) out.push({ id: r.id, field: 'value', message: `${k || 'Value'}: not a number.` });
    if (r.type === 'string' && String(r.value).length > maxVal) out.push({ id: r.id, field: 'value', message: `${k}: ${String(r.value).length} characters; at most ${maxVal}.` });
    if (allowed && r.type === 'string') {
      for (const m of String(r.value).matchAll(/\{(param:)?([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)) {
        const token = `{${m[1] ? 'param:' : ''}${m[2]}}`;
        if (!allowed.includes(token)) out.push({ id: r.id, field: 'value', message: `${k}: unknown placeholder ${token}${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (this source takes no placeholders)'}.` });
      }
    }
  }
  const obj = contextObject(rows);
  const bytes = obj ? new TextEncoder().encode(JSON.stringify(obj)).length : 0;
  if (bytes > maxBytes) out.push({ message: `Context is ${bytes} bytes as JSON; at most ${maxBytes}.` });
  return out;
}

/** Placeholders a context may use for this source: schema tokens with {param:<name>} expanded for the profile. */
export function contextPlaceholders(schema, srcType, profile = null) {
  const list = schema?.placeholders?.[srcType] || [];
  return list.flatMap((p) => (p === '{param:<name>}' ? (profile?.params || []).map((x) => `{param:${x.name}}`) : [p]));
}

/**
 * Every problem -> [{ section, message, rowKey?, field?, required? }]. Sections: setup, what, where,
 * tags, context, payload, delivery, server. `required` problems are shown only after a save attempt.
 */
export function validateMapping(state, { brokers = [], profile = null, devices = null, preview = null, schema = null } = {}) {
  const errors = [];
  const add = (section, message, extra = {}) => errors.push({ section, message, ...extra });
  const f = state.form;
  const isProfile = state.srcType === 'device-profile';

  if (!brokers.length) add('setup', 'No connected broker. Connect one under Brokers first.');
  else if (!f.brokerId) add('setup', 'Choose a target broker.', { field: 'broker', required: true });
  if (isProfile && !profile) add('what', 'Choose a device profile.', { required: true });

  const pub = publishingRows(state);
  if (state.selectMode === 'list' && !state.rows.length && !(state.srcType === 'sparkplug' && state.original && !state.original.source.metrics)) {
    add('what', isProfile ? 'Add at least one profile tag.' : 'Add at least one tag.', { required: true });
  }

  if (state.srcType === 'mqtt') mqttSourceErrors(state, add);
  if (state.mode === 'mqtt') {
    if (isProfile) {
      const hasMap = Object.values(f.assetPaths || {}).some((p) => String(p).trim());
      if (f.assetPathTemplate.trim() || !hasMap) {
        const err = validateAssetTemplate(f.assetPathTemplate, pathPlaceholders(profile));
        if (err) add('where', err, { field: 'dest', required: !f.assetPathTemplate.trim() });
      }
      if (f.assetPathTemplate.trim()) for (const r of instanceRows({ profile, devices, template: f.assetPathTemplate, overrides: f.assetPaths })) if (r.error) add('where', r.error, { field: 'dest' });
    } else if (f.destKind === 'asset') {
      const p = normalizeAssetPath(f.assetPath);
      const err = validateAssetPath(p);
      if (err) add('where', err, { field: 'dest', required: !p });
    } else if (!String(f.pathTemplate || '').trim()) add('where', 'Enter a path template.', { field: 'dest', required: true });
    if (f.layout === 'object-per-asset' && f.maxObjectBytes !== '') {
      const n = Number(f.maxObjectBytes);
      const lim = schema?.limits?.maxObjectBytes || { min: 1024, max: 1048576 };
      if (!Number.isInteger(n) || n < lim.min || n > lim.max) add('delivery', `Maximum object size must be a whole number from ${lim.min} to ${lim.max} bytes.`, { field: 'maxObjectBytes' });
    }
  } else {
    for (const [label, key] of [['Group', 'group'], ['Edge node', 'edge'], ['Device', 'device']]) {
      const v = String(f[key] ?? '').trim();
      if (!v) add('where', `${label} is required.`, { field: key, required: true });
      else if (!SP_PART.test(v)) add('where', `${label} cannot contain spaces, /, + or #.`, { field: key });
    }
  }

  // Names: per row, then duplicates after slugging.
  if (renameable(state.srcType)) {
    const seen = new Map();
    for (const r of state.rows) {
      for (const e of rowErrors(r, schema)) add('tags', e.message, { rowKey: r.key, field: e.field, required: e.required });
    }
    for (const r of pub) {
      const s = nameSlug(state.srcType, r.name).toLowerCase();
      if (!s) continue;
      if (seen.has(s)) add('tags', `"${r.name}" is used by two tags (${seen.get(s)} and ${r.address}). Names must be unique.`, { rowKey: r.key, field: 'name' });
      else seen.set(s, r.address);
    }
  }

  // Asset context.
  const allowed = contextPlaceholders(schema, state.srcType, profile);
  for (const e of contextErrors(f.context, schema, { allowed })) add('context', e.message, { field: e.id ? `ctx:${e.id}:${e.field}` : 'context' });
  if (state.mode === 'mqtt' && f.fields) {
    if (!f.fields.includes('v')) add('payload', 'The value (v) must be published.', { field: 'fields' });
    if (f.fields.includes('ctx') && f.contextMode === 'none') add('payload', 'Context is switched off, so the ctx field cannot be published.', { field: 'fields' });
  }

  if (f.dbValue !== '') {
    const v = Number(f.dbValue);
    if (!(v >= 0)) add('delivery', 'Deadband must be a number of 0 or more.', { field: 'deadband' });
    else if (f.dbType === 'percent' && v > 100) add('delivery', 'A percent deadband must be between 0 and 100.', { field: 'deadband' });
  }
  if (f.heartbeatMs !== '' && !(Number.isInteger(Number(f.heartbeatMs)) && Number(f.heartbeatMs) >= 0)) add('delivery', 'Heartbeat must be a whole number of milliseconds (0 = off).', { field: 'heartbeat' });
  else if (Number(f.heartbeatMs) > 0 && Number(f.heartbeatMs) < 1000) add('delivery', 'Heartbeat below 1000 ms floods the broker. Use 1000 or more, or 0 to turn it off.', { field: 'heartbeat' });
  if (state.srcType === 'opcua' && !(Number(f.samplingInterval) >= 50)) add('delivery', 'Sampling interval must be at least 50 ms.', { field: 'sampling' });

  // The server's verdict: a rejection and topics another mapping already publishes block saving.
  const data = preview?.status === 'ok' ? preview.data : null;
  if (data && data.valid === false) add('server', data.error || 'The server rejected this mapping.', { rowKey: rowKeyFromMessage(state, data.error) });
  if (data && data.valid) {
    const topics = computeTopics(state, { profile, devices });
    const byTopic = new Map(topics.map((t) => [t.topic, t]));
    const seenTopics = new Set();
    const collisions = [...(data.warnings || []).filter((w) => w.type === 'collision').map((w) => ({ topic: w.topic, bindings: w.bindings })), ...(data.tags || []).filter((t) => t.collisions?.length).map((t) => ({ topic: t.topic, bindings: t.collisions })), ...(data.objects || []).filter((o) => o.collisions?.length).map((o) => ({ topic: o.topic, bindings: o.collisions }))];
    for (const c of collisions) {
      if (seenTopics.has(c.topic)) continue;
      seenTopics.add(c.topic);
      const owner = (c.bindings || []).map((b) => b.name || b.id).join(', ');
      add('server', `${c.topic} is already published by ${owner}.`, { rowKey: byTopic.get(c.topic)?.key || null, collision: true, topic: c.topic, owner });
    }
  }
  return errors;
}

/** Row a server message names (`tag "x"` / `source.overrides["x"]`), if any. */
export function rowKeyFromMessage(state, message) {
  const m = /tag "([^"]+)"|overrides\["([^"]+)"\]/.exec(String(message || ''));
  const addr = m && (m[1] || m[2]);
  return addr && state.rows.some((r) => r.key === addr) ? addr : null;
}

/** Errors to show: required-field problems only after the user tried to save. */
export const visibleErrors = (errors, attempted) => errors.filter((e) => attempted || !e.required);

/** Is the name a raw device address (client side check, the server's list is wider)? */
export const rawName = (name) => looksLikeRawAddress(slug(name));

const FIELD_PATH = /^[^.]+(\.[^.]+)*$/;
const staleError = (v) => (v === undefined || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 1000 && Number(v) <= 86400000 ? null : 'Mark stale after must be a whole number of milliseconds from 1000 to 86400000 (empty: never).');

/** MQTT-topic source: the filter (tags: "all"), field paths and staleness limits. */
function mqttSourceErrors(state, add) {
  const f = state.form;
  if (state.selectMode === 'rules') {
    const flt = String(state.ref.filter || '').trim();
    if (!flt) add('what', 'Enter a topic filter, for example plant1/line1/#.', { field: 'filter', required: true });
    else if (/#./.test(flt) || flt.split('/').some((x) => x.length > 1 && /[+#]/.test(x))) add('what', '# may only be the last level and + a whole level.', { field: 'filter' });
  }
  if (String(f.srcField || '').trim() && !FIELD_PATH.test(String(f.srcField).trim())) add('delivery', 'Value field must be a dot path such as data.value.', { field: 'srcField' });
  const se = staleError(String(f.staleAfterMs ?? '').trim());
  if (se) add('delivery', se, { field: 'staleAfterMs' });
  for (const r of state.rows) {
    if (r.ov.field !== undefined && !FIELD_PATH.test(String(r.ov.field))) add('tags', `${r.name || r.address}: value field must be a dot path such as data.value.`, { rowKey: r.key, field: 'field' });
    const e = staleError(r.ov.staleAfterMs);
    if (e) add('tags', `${r.name || r.address}: ${e}`, { rowKey: r.key, field: 'staleAfterMs' });
  }
}
