/** Pure helpers for the Pipelines page (no React, unit-tested in src/test/pipelines.test.js). */

export const TRANSFORM_DEFAULTS = {
  repath: { type: 'repath', to: 'uns/{1-}' },
  pick: { type: 'pick', fields: [] },
  rename: { type: 'rename', map: {} },
  set: { type: 'set', values: {} },
  scale: { type: 'scale', field: '', mul: 1, add: 0 },
  numeric: { type: 'numeric', field: '' },
  sparkplugFlatten: { type: 'sparkplugFlatten' },
  envelope: { type: 'envelope' }
};

export const brokerName = (brokers, id) => brokers.find((b) => b.id === id)?.name || (id ? `${id.slice(0, 8)}…` : '—');

/** Split "a, b ,,c" into ['a','b','c']. */
export function parseCsv(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "old:new,old2:new2" -> { old: 'new', old2: 'new2' } (malformed pairs are dropped). */
export function parseRenameMap(str) {
  const pairs = String(str || '')
    .split(',')
    .map((p) => p.split(':').map((s) => s.trim()))
    .filter((p) => p.length === 2 && p[0]);
  return Object.fromEntries(pairs);
}

export const formatRenameMap = (map) =>
  Object.entries(map || {})
    .map(([a, b]) => `${a}:${b}`)
    .join(',');

/** Parse a JSON object typed into a field; returns null while the text is not (yet) valid. */
export function parseJsonObject(str) {
  try {
    const v = JSON.parse(str || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export const blankRoute = (brokers) => ({
  name: '',
  enabled: true,
  source: { brokerId: brokers[0]?.id || '', filter: '' },
  transforms: [{ ...TRANSFORM_DEFAULTS.repath }],
  target: { type: 'mqtt', brokerId: brokers[0]?.id || '', retain: false }
});

export const cloneRoute = (route) => ({
  ...route,
  source: { ...route.source },
  target: { ...route.target },
  transforms: (route.transforms || []).map((t) => ({ ...t }))
});

export const blankModel = (brokers) => ({
  name: '',
  enabled: true,
  publishMode: 'on-change',
  intervalMs: 5000,
  target: { brokerId: brokers[0]?.id || '', topic: '', retain: true },
  attributes: [{ name: '', source: { brokerId: brokers[0]?.id || '', topic: '', field: '' } }]
});

export const cloneModel = (m) => ({
  ...m,
  target: { ...m.target },
  attributes: m.attributes.map((a) => ({ name: a.name, source: { ...a.source, field: a.source.field || '' } }))
});

/** Drop empty attribute rows and empty `field`s before saving a model. */
export function cleanModel(draft) {
  return {
    ...draft,
    attributes: draft.attributes
      .filter((a) => a.name && a.source.topic)
      .map((a) => ({
        name: a.name,
        source: { brokerId: a.source.brokerId, topic: a.source.topic, ...(a.source.field ? { field: a.source.field } : {}) }
      }))
  };
}

/**
 * Does this payload look like a TVQ envelope ({ v, t?, q? } with a numeric value)? Manifold's own
 * `envelope` publishers and many gateways produce it. A historian target stores a JSON object as
 * TEXT, so such a route needs a `numeric` transform on field "v".
 */
export function looksLikeTvq(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!('v' in payload) || !('t' in payload || 'q' in payload)) return false;
  const v = payload.v;
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
}

/** Is a `numeric` transform on field "v" already part of the chain? */
export const hasTvqNumeric = (transforms) => (transforms || []).some((t) => t.type === 'numeric' && t.field === 'v');

export const routeSaveable = (draft) => Boolean(draft.source.filter) && !(draft.target.type === 'historian' && !draft.target.historianId);
export const modelSaveable = (draft) => Boolean(draft.target.topic) && draft.attributes.some((a) => a.name && a.source.topic);

/** One-line description of where a route sends data. */
export function routeTargetLabel(route, brokers, historians) {
  if (route.target.type === 'mqtt') {
    return `${brokerName(brokers, route.target.brokerId)} (mqtt${route.target.retain ? ', retained' : ''})`;
  }
  const id = route.target.historianId || '';
  const h = historians.find((x) => x.id === id);
  return `historian:${h?.name || id.slice(0, 8)}`;
}

export const BLANK_HISTORIAN = {
  type: 'influxdb', name: '', url: '', org: '', bucket: '', token: '', measurement: '', dataset: '', writePath: '', apiKey: '',
  host: '', port: '', database: '', user: '', password: '', table: '', ssl: false, sslInsecure: false, sslRootCert: '', dropPolicy: 'newest'
};

/** Load a historian into the form; secret fields stay blank (= unchanged). */
export const historianFormFrom = (h) => ({
  ...BLANK_HISTORIAN,
  type: h.type,
  name: h.name || '',
  url: h.url || '',
  org: h.org || '',
  bucket: h.bucket || '',
  measurement: h.measurement || '',
  dataset: h.dataset || '',
  writePath: h.writePath || '',
  host: h.host || '',
  port: h.port || '',
  database: h.database || '',
  user: h.user || '',
  table: h.table || '',
  ssl: Boolean(h.ssl),
  sslInsecure: Boolean(h.sslInsecure),
  sslRootCert: h.sslRootCert || '',
  dropPolicy: h.dropPolicy || 'newest'
});

/**
 * Body for saving a historian. The list endpoint never echoes secrets, so when
 * editing, an empty secret means "keep the stored one": omit the key entirely
 * (the server preserves stored secrets only for omitted keys).
 */
export function historianPayload(form, editingId) {
  const payload = { ...form };
  if (editingId) {
    payload.id = editingId;
    for (const k of ['token', 'apiKey', 'password']) {
      if (!payload[k]) delete payload[k];
    }
  }
  return payload;
}

export function historianSaveDisabled(form) {
  if (form.type === 'timescaledb') return !form.host || !form.database || !form.user;
  if (!form.url) return true;
  if (form.type === 'influxdb') return !form.org || !form.bucket;
  if (form.type === 'timebase') return !form.dataset;
  return false;
}

/** Connection summary line for the historians table. */
export function historianSummary(h) {
  if (h.type === 'timescaledb') return `${h.host}:${h.port || 5432}/${h.database} · table=${h.table || 'manifold_samples'}`;
  let s = h.url || '';
  if (h.type === 'influxdb') s += ` · org=${h.org} bucket=${h.bucket}`;
  if (h.type === 'timebase') s += ` · dataset=${h.dataset}`;
  return s;
}

/** Store-and-forward line pieces for a historian's outbox metrics. */
export function outboxSummary(o) {
  if (!o) return null;
  return {
    written: o.written.toLocaleString(),
    queued: o.queued,
    spilledKb: o.spillBytes > 0 ? (o.spillBytes / 1024).toFixed(1) : null,
    dropped: o.dropped > 0 ? o.dropped : null,
    deadLettered: o.deadLettered > 0 ? o.deadLettered : null,
    deadLetterKb: o.deadLetterBytes > 0 ? (o.deadLetterBytes / 1024).toFixed(1) : null,
    skipped: o.skipped > 0 ? o.skipped : null,
    lastError: o.lastError || null
  };
}

/** Request body to start a recording from the form. */
export function recordingBody(form, brokers) {
  return {
    name: form.name || null,
    brokerId: form.brokerId || brokers[0]?.id,
    filter: form.filter,
    target: form.targetType === 'historian' ? { type: 'historian', historianId: form.historianId } : { type: 'file' }
  };
}

export const recordingStatusLabel = (rec) => (rec.status.full ? 'full' : rec.enabled ? 'recording' : 'paused');

export const formatKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
