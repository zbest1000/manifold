// Target and delivery fields of a mapping <-> the stored binding's target / rbe.
// Rows, selection and per-tag settings live in mappingModel.js, which builds on these.
import { normalizeAssetPath, validateAssetPath } from './assetPath';
import { cleanOverrides } from './profileModel';

// Target keys the form owns; any other stored key is carried through an edit untouched.
const OWNED_TARGET_KEYS = [
  'mode', 'brokerId', 'assetPath', 'pathTemplate', 'assetPathTemplate', 'assetPaths', 'layout', 'maxObjectBytes', 'format',
  'retain', 'qos', 'deadband', 'statusTopic', 'metaTopic', 'historian', 'group', 'edge', 'device',
  'context', 'contextMode', 'fields', 'metaFields'
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

export { validateAssetPath };
