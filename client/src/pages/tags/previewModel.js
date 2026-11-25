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
