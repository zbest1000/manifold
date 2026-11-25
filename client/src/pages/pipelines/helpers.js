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
  envelope: false,
  staleMs: 60000,
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
  rev: h.rev, // the revision the form was loaded at: a save over a newer one is refused (409)
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

/* ------------------------------------------------------------------ */
/* Presentation helpers (added with the design-system rebuild)         */
/* ------------------------------------------------------------------ */

/** Plain-language name and one-line explanation for each transform type. */
export const TRANSFORM_META = {
  repath: { label: 'Re-path', hint: 'Change the output topic. {n} is segment n, {n-} is everything from segment n, {topic} is the whole topic.' },
  pick: { label: 'Pick fields', hint: 'Keep only the listed fields of the payload.' },
  rename: { label: 'Rename fields', hint: 'Rename payload fields, written as old:new pairs.' },
  set: { label: 'Set values', hint: 'Add or overwrite fields with fixed values.' },
  scale: { label: 'Scale', hint: 'value × factor + offset, on the whole payload or on one field.' },
  numeric: { label: 'To number', hint: 'Turn the payload, or one field of it, into a plain number. A message that is not a number is dropped.' },
  sparkplugFlatten: { label: 'Flatten Sparkplug', hint: 'Turn the metrics array into one { name: value } object.' },
  envelope: { label: 'Wrap as TVQ', hint: 'Wrap the value as { v, t, q }: value, source time and quality.' }
};

export const transformLabel = (t) => TRANSFORM_META[t?.type]?.label || t?.type || 'Transform';

/** Move list[from] to index `to` (no-op when out of range). Returns a new list. */
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Pieces of the one-line route summary: source filter, transform names, target. */
export function routeFlow(route, brokers, historians) {
  const target = route.target?.type === 'historian' ? routeTargetLabel(route, brokers, historians) : `${brokerName(brokers, route.target?.brokerId)}${route.target?.retain ? ' (retained)' : ''}`;
  return {
    source: route.source?.filter || '',
    transforms: (route.transforms || []).map(transformLabel),
    target
  };
}

/** State of a route for the list: running / paused / failing / loop-blocked. */
export function routeState(route, m = {}) {
  // A broker or historian it points at was deleted: it cannot run until someone fixes the reference.
  if (route.broken?.length) return { key: 'broken', label: 'Broken reference', tone: 'bad' };
  if (!route.enabled) return { key: 'paused', label: 'Paused', tone: 'neutral' };
  // The historian is refusing what this route sends: "running" would be a lie.
  if (m.target === 'historian' && m.rejected > 0 && m.delivered === 0) return { key: 'rejected', label: 'Historian rejecting', tone: 'bad' };
  if (m.errors > 0 && m.lastError) return { key: 'failing', label: 'Failing', tone: 'bad' };
  if (m.loopBlocked > 0) return { key: 'blocked', label: 'Loop blocked', tone: 'warn' };
  return { key: 'running', label: 'Running', tone: 'good' };
}

/** "broker "abc" is missing, historian "x" is missing": what a broken route (or model, recording...) points at. */
export const brokenSummary = (item) => (item?.broken || []).map((b) => `${b.kind} "${b.id}" is missing`).join(', ');

/**
 * What the four counters of a route mean, in the words the tooltips use. A route to a historian hands points
 * to a store-and-forward buffer first, so "routed" can be healthy while "delivered" is zero.
 */
export const COUNTER_HELP = {
  in: 'Messages that matched this route\'s source filter.',
  routed: 'Points this route handed on. For a historian that means accepted into the local buffer, not yet written.',
  delivered: 'Points the target accepted. For a historian: written to the database. For a broker: the publish succeeded.',
  pending: 'Handed on but not delivered yet: waiting in memory or in the on-disk buffer (the historian is slow or unreachable).',
  rejected: 'Points the historian refused for good (for example a type conflict). They are kept in the dead-letter file, not retried.',
  blocked: 'Messages stopped by loop protection (the output would feed back into this route).',
  errors: 'Messages that failed in a transform or a publish.'
};

/** Health of a historian's store-and-forward outbox: tone, label and the reason in words. */
export function outboxHealth(o) {
  if (!o) return { tone: 'neutral', label: 'No traffic yet', detail: null };
  const s = outboxSummary(o);
  if (s.deadLettered) {
    return { tone: 'bad', label: 'Rejecting points', detail: `${s.deadLettered.toLocaleString()} rejected by the historian${s.deadLetterKb ? `, ${s.deadLetterKb} KB kept in the dead-letter file` : ''}` };
  }
  if (s.dropped) return { tone: 'bad', label: 'Dropping points', detail: `${s.dropped.toLocaleString()} dropped because the offline buffer is full` };
  if (s.lastError) return { tone: 'warn', label: s.spilledKb || o.queued > 0 ? 'Buffering' : 'Retrying', detail: s.lastError };
  if (s.spilledKb || o.queued > 0) return { tone: 'warn', label: 'Buffering', detail: s.spilledKb ? `${s.spilledKb} KB held on disk` : `${o.queued.toLocaleString()} points waiting to be sent` };
  return { tone: 'good', label: 'Healthy', detail: null };
}

/** "12.3 KB" / "4.1 MB" for byte counts. */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** Everything that still writes to this historian, as plain names, from raw lists. */
export function historianUsers(id, { routes = [], recordings = [], bindings = [] }) {
  return [
    ...routes.filter((r) => r.target?.type === 'historian' && r.target.historianId === id).map((r) => `Route "${r.name || r.source?.filter}"`),
    ...recordings.filter((r) => r.target?.type === 'historian' && r.target.historianId === id).map((r) => `Recording "${r.name || r.filter}"`),
    ...bindings.filter((b) => b.target?.historian?.historianId === id).map((b) => `Tag binding "${b.name || b.id}"`)
  ];
}

/** Editor-only stable keys for transforms (so reordering keeps each row's input state); stripped before saving. */
let uidCounter = 0;
const nextUid = () => `t${(uidCounter += 1)}`;
export const withTransformIds = (route) => ({ ...route, transforms: (route.transforms || []).map((t) => ({ ...t, _uid: t._uid || nextUid() })) });
export const newTransform = (type) => ({ ...TRANSFORM_DEFAULTS[type], _uid: nextUid() });
export const stripTransformIds = (route) => ({
  ...route,
  transforms: (route.transforms || []).map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== '_uid')))
});
