import { slug, looksLikeRawAddress } from './helpers';

// Pure helpers over the POST /api/tags/bindings/preview response:
//   { valid, error?, layout, format, units, unitErrors, totalTags, truncated,
//     tags: [{ name, address, unitId, hasValue, topic, payload, collisions? }],
//     objects: [{ topic, unitId, payload, bytes, worstCaseBytes, capBytes, collisions? }],
//     meta: [{ topic, payload }], status: [topic], warnings: [{ type, topic, name?, message, bindings? }] }

/** Topics another (enabled) binding already publishes, deduplicated: [{ topic, bindings: [{ id, name }] }]. */
export function blockingCollisions(data) {
  const by = new Map();
  const add = (topic, bindings) => {
    if (topic && bindings?.length && !by.has(topic)) by.set(topic, bindings);
  };
  for (const w of data?.warnings || []) if (w.type === 'collision') add(w.topic, w.bindings);
  for (const t of data?.tags || []) add(t.topic, t.collisions);
  for (const o of data?.objects || []) add(o.topic, o.collisions);
  return [...by].map(([topic, bindings]) => ({ topic, bindings }));
}

/**
 * Pair wizard rows with the server's tag entries. Plain sources match by address; profile
 * bindings repeat the tags once per instance (addresses can carry {param}s), so the first
 * unit's entries are matched by position.
 * -> Map(rowKey -> { entry, rawAddress: warning|null })
 */
export function matchEntries(rows, data, isProfile) {
  const out = new Map();
  if (!data?.tags?.length) return out;
  const firstUnit = data.tags[0].unitId;
  const pool = isProfile ? data.tags.filter((t) => t.unitId === firstUnit) : data.tags;
  const raw = (data.warnings || []).filter((w) => w.type === 'raw-address');
  rows.forEach((r, i) => {
    const entry = isProfile ? pool[i] : pool.find((t) => t.address === r.address);
    if (!entry) return;
    out.set(r.key, { entry, rawAddress: raw.find((w) => w.topic === entry.topic && w.name === entry.name) || null });
  });
  return out;
}

/** Warnings that are not tied to a row: asset-path problems and unit errors. */
export function generalWarnings(data) {
  return [
    ...(data?.warnings || []).filter((w) => w.type === 'asset-path'),
    ...(data?.unitErrors || []).map((u) => ({ type: 'asset-path', message: `${u.unitId.includes('#') ? u.unitId.split('#')[1] : u.unitId}: ${u.error}` }))
  ];
}

/** Largest object estimate across units, for the size line. null when not an object layout. */
export function sizeSummary(data) {
  const objs = data?.objects || [];
  if (data?.layout !== 'object-per-asset' || !objs.length) return null;
  const worst = objs.reduce((a, o) => (o.worstCaseBytes > a.worstCaseBytes ? o : a), objs[0]);
  return { bytes: worst.bytes, worstCaseBytes: worst.worstCaseBytes, capBytes: worst.capBytes, ratio: Math.min(1, worst.worstCaseBytes / worst.capBytes), units: objs.length };
}

export const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} B`);

export const pretty = (payload) => {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

/** Label for a tag's type/unit beside its name ("float32 · kW"). */
export function unitTypeLabel(meta) {
  return [meta?.type, meta?.unit].filter(Boolean).join(' · ');
}

/**
 * View items for the per-tag list. `resolved` = client-side rows (instant fallback while the server
 * request is in flight); `data` = server preview or null; `selfClash` = Set of row keys that resolve
 * to the same topic as another row of this binding.
 */
export function buildItems({ rows, resolved, data, isProfile, selfClash }) {
  const matched = matchEntries(rows, data, isProfile);
  const clash = new Map(blockingCollisions(data).map((c) => [c.topic, c.bindings]));
  const rawWarnings = (data?.warnings || []).filter((w) => w.type === 'raw-address');
  const members = data?.objects?.[0]?.payload?.values;
  return rows.map((row) => {
    const m = matched.get(row.key);
    const res = resolved.find((r) => r.key === row.key);
    let rawAddress = m?.rawAddress || null;
    if (!rawAddress && data) rawAddress = rawWarnings.find((w) => w.name === row.name) || null;
    if (!rawAddress && !data && looksLikeRawAddress(slug(row.name))) rawAddress = { message: 'Looks like a raw device address. Use a meaningful property name.' };
    const topic = m?.entry.topic || res?.topic;
    return {
      row,
      entry: m?.entry,
      rawAddress,
      clashOthers: m ? clash.get(topic) || null : null,
      clashSelf: selfClash.has(row.key),
      slugged: slug(row.name) !== row.name && row.name.trim() ? slug(row.name) : null,
      fallbackTopic: res?.topic,
      memberPayload: members ? members[slug(row.name)] : undefined
    };
  });
}
