// Pure mapping between the wizard form and the stored binding (POST /api/tags/bindings).
// formFromBinding(buildBinding(...)) round-trips every stored shape: legacy pathTemplate,
// assetPath, object-per-asset layout, device-profile (template + per-instance paths).
import { normalizeAssetPath, validateAssetPath } from './assetPath';
import { cleanOverrides } from './profileModel';

// Target keys the form owns; any other stored key is carried through an edit untouched.
const OWNED_TARGET_KEYS = [
  'mode', 'brokerId', 'assetPath', 'pathTemplate', 'assetPathTemplate', 'assetPaths', 'layout', 'maxObjectBytes', 'format',
  'retain', 'qos', 'deadband', 'statusTopic', 'metaTopic', 'historian', 'group', 'edge', 'device'
];

export const DEADBAND_HELP = {
  absolute: 'Suppress a numeric change smaller than this many engineering units.',
  percent:
    'Percent of the tag\'s range (max minus min) when the tag defines a range; otherwise percent of the last published value, so after a 0 any change publishes. Non-numeric values publish on change.'
};

/** Form state for a stored binding (editing) or defaults for a new one. */
export function formFromBinding(b, { brokers = [], srcType = b?.source?.type } = {}) {
  const t = b?.target || {};
  const isProfile = srcType === 'device-profile';
  const hasAsset = t.assetPath !== undefined && t.assetPath !== null && t.assetPath !== '';
  const legacy = Number(t.deadband) > 0 ? { type: 'absolute', value: t.deadband } : null;
  const db = b?.rbe?.deadband && Number(b.rbe.deadband.value) > 0 ? b.rbe.deadband : legacy;
  return {
    brokerId: t.brokerId || brokers[0]?.id || '',
    destKind: isProfile || srcType === 'mqtt' ? 'template' : hasAsset ? 'asset' : b ? 'template' : 'asset',
    assetPath: hasAsset ? String(t.assetPath) : '',
    pathTemplate: t.pathTemplate || 'uns/imported/{name}',
    assetPathTemplate: t.assetPathTemplate || '',
    assetPaths: { ...(t.assetPaths || {}) },
    layout: t.layout === 'object-per-asset' ? 'object-per-asset' : 'topic-per-tag',
    maxObjectBytes: t.maxObjectBytes ?? '',
    format: t.format || (b ? 'plain' : 'envelope'),
    retain: b ? t.retain === true : false,
    qos: t.qos ?? 0,
    statusTopic: t.statusTopic !== false,
    metaTopic: t.metaTopic !== false,
    dbType: db?.type === 'percent' ? 'percent' : 'absolute',
    dbValue: db ? String(db.value) : '',
    heartbeatMs: b?.rbe?.heartbeatMs ?? '',
    historianId: t.historian?.historianId || '',
    samplingInterval: b?.source?.samplingInterval ?? 1000,
    group: t.group || 'Manifold',
    edge: t.edge || 'edge1',
    device: t.device || (isProfile ? '{device}' : 'imported')
  };
}

/** rbe block from the form, or undefined when neither deadband nor heartbeat is set. */
export function buildRbe(form) {
  const rbe = {};
  const hb = Number(form.heartbeatMs);
  if (hb > 0) rbe.heartbeatMs = hb;
  const v = Number(form.dbValue);
  if (form.dbValue !== '' && v > 0) rbe.deadband = { type: form.dbType === 'percent' ? 'percent' : 'absolute', value: v };
  return Object.keys(rbe).length ? rbe : undefined;
}

/** `target` for a binding. devices = known profile instances (null while unknown, keeps overrides as-is). */
export function buildTarget({ mode, form, srcType, editing = null, devices = null }) {
  const extra = {};
  for (const [k, v] of Object.entries(editing?.target || {})) if (!OWNED_TARGET_KEYS.includes(k)) extra[k] = v;
  const historian = form.historianId ? { historian: { historianId: form.historianId } } : {};
  if (mode === 'sparkplug') {
    return { ...extra, mode: 'sparkplug', brokerId: form.brokerId, group: form.group.trim(), edge: form.edge.trim(), device: form.device.trim(), ...historian };
  }
  let dest;
  if (srcType === 'device-profile') {
    const overrides = cleanOverrides(form.assetPaths, devices);
    dest = {
      ...(form.assetPathTemplate.trim() ? { assetPathTemplate: form.assetPathTemplate.trim() } : {}),
      ...(Object.keys(overrides).length ? { assetPaths: overrides } : {})
    };
  } else if (form.destKind === 'asset') {
    dest = { assetPath: normalizeAssetPath(form.assetPath) };
  } else {
    dest = { pathTemplate: form.pathTemplate };
  }
  const object = form.layout === 'object-per-asset';
  return {
    ...extra,
    mode: 'mqtt',
    brokerId: form.brokerId,
    ...dest,
    ...(object ? { layout: 'object-per-asset' } : {}),
    ...(object && form.maxObjectBytes !== '' ? { maxObjectBytes: Number(form.maxObjectBytes) } : {}),
    format: form.format,
    retain: form.retain,
    qos: Number(form.qos) || 0,
    ...(form.statusTopic ? {} : { statusTopic: false }),
    ...(form.metaTopic ? {} : { metaTopic: false }),
    ...historian
  };
}

const entryOf = (row, alwaysName) => (alwaysName || row.explicit ? { address: row.address, name: row.name.trim() } : row.address);

/** `source` for a binding. `allTags` keeps `tags: 'all'` when no tag carries an explicit name. */
export function buildSource({ srcType, source, editing, rows, form, allTags = false, profileId }) {
  const named = srcType === 'opcua';
  const tags = allTags && !rows.some((r) => r.explicit) && (srcType === 'device' || srcType === 'device-profile') ? 'all' : rows.map((r) => entryOf(r, named));
  if (editing) {
    const s = editing.source;
    if (srcType === 'sparkplug') return s;
    const next = { ...s, tags };
    return srcType === 'opcua' ? { ...next, samplingInterval: Number(form.samplingInterval) || 1000 } : next;
  }
  if (srcType === 'opcua') return { type: 'opcua', connectionId: source.id, tags, samplingInterval: Number(form.samplingInterval) || 1000 };
  if (srcType === 'device-profile') return { type: 'device-profile', profileId, tags };
  if (srcType === 'sparkplug') {
    const meta = rows[0]?.meta || {};
    return { type: 'sparkplug', brokerId: source.id, group: meta.group, edge: meta.edge, device: meta.device || null, metrics: rows.map((r) => r.address) };
  }
  return { type: srcType, deviceId: source.id, tags };
}

/** Whole request body (also the body of POST /api/tags/bindings/preview). */
export function buildBinding({ name, mode, form, rows, srcType, source, editing = null, allTags = false, profileId, devices = null }) {
  const rbe = buildRbe(form);
  return {
    ...(editing ? { id: editing.id, enabled: editing.enabled !== false } : {}),
    name: name || null,
    source: buildSource({ srcType, source, editing, rows, form, allTags, profileId }),
    target: buildTarget({ mode, form, srcType, editing, devices }),
    ...(rbe ? { rbe } : {})
  };
}

/** Rows ([{ key, address, name, defaultName, explicit, meta }]) for a stored binding. metaByAddress: { address: node.meta }. */
export function rowsFromBinding(b, metaByAddress = {}, profileTags = null) {
  const s = b?.source || {};
  if (Array.isArray(s.metrics)) return s.metrics.map((m) => ({ key: m, address: m, name: m, defaultName: m, explicit: false, meta: {} }));
  let entries = s.tags;
  if (entries === 'all') entries = (profileTags || Object.keys(metaByAddress).map((k) => ({ key: k }))).map((t) => t.key);
  if (!Array.isArray(entries)) return [];
  return entries.map((e, i) => {
    const address = typeof e === 'string' ? e : e.address;
    const meta = metaByAddress[address] || {};
    const defaultName = s.type === 'opcua' ? address : meta.property || address;
    const stored = typeof e === 'string' ? '' : e.name || '';
    return { key: `${i}:${address}`, address, name: stored || defaultName, defaultName, explicit: Boolean(stored), meta };
  });
}

/** Rows from the Tags-page selection. Device tags default to their `property`. */
export function rowsFromSelection(selection, srcType) {
  return [...selection.values()].map((t) => {
    const meta = t.meta || {};
    const defaultName = srcType === 'device' ? meta.property || t.address : t.name;
    return { key: t.id, address: t.address, name: defaultName, defaultName, explicit: false, meta };
  });
}

/** Rows for a profile: every profile tag, named by its property. */
export function rowsFromProfile(profile) {
  return (profile?.tags || []).map((t) => ({
    key: t.key, address: t.key, name: t.property || t.key, defaultName: t.property || t.key, explicit: false,
    meta: { property: t.property || null, unit: t.unit || null, type: t.type, range: t.range || null }
  }));
}

/**
 * Profile editing/creation: every profile tag as a row plus the set of selected keys.
 * A stored binding overlays its explicit names and selection (`tags: 'all'` = everything).
 */
export function profileRowsFor(profile, binding = null) {
  const rows = rowsFromProfile(profile);
  const stored = binding?.source?.tags;
  if (!Array.isArray(stored)) return { rows, selected: new Set(rows.map((r) => r.key)) };
  const byAddr = new Map(stored.map((e) => [typeof e === 'string' ? e : e.address, typeof e === 'string' ? '' : e.name || '']));
  return {
    rows: rows.map((r) => (byAddr.get(r.address) ? { ...r, name: byAddr.get(r.address), explicit: true } : r)),
    selected: new Set(rows.filter((r) => byAddr.has(r.address)).map((r) => r.key))
  };
}

/** Rename a row: explicit only when the text differs from the default (server lets an explicit name win over `property`). */
export function renameRow(row, value, alwaysExplicit = false) {
  return { ...row, name: value, explicit: alwaysExplicit || value.trim() !== row.defaultName };
}

export { validateAssetPath };
