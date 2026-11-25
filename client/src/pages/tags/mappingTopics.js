// Topics a mapping draft publishes and what an edit changes (pure; see mappingModel.js).
import { normalizeAssetPath, validateAssetPath } from './assetPath';
import { instanceRows } from './profileModel';
import { publishingRows, nameSlug } from './mappingRows';

// ---- topics & diff ------------------------------------------------------------------------------

/**
 * Value topics the mapping would publish, computed like the server (mqtt, topic-per-tag):
 * [{ key, address, name, topic, unit? }] per instance. Object layout: one topic per unit.
 */
export function computeTopics(state, { profile = null, devices = null } = {}) {
  if (state.mode !== 'mqtt') return [];
  const leaf = (name) => nameSlug(state.srcType, name);
  const rows = publishingRows(state);
  const f = state.form;
  const object = f.layout === 'object-per-asset';
  const bases = [];
  if (state.srcType === 'device-profile') {
    for (const inst of instanceRows({ profile, devices, template: f.assetPathTemplate, overrides: f.assetPaths })) {
      if (!inst.error) bases.push({ unit: inst.deviceId, unitName: inst.name, base: inst.path });
    }
  } else if (f.destKind === 'asset') {
    const p = normalizeAssetPath(f.assetPath);
    if (p && !validateAssetPath(p)) bases.push({ unit: null, base: p });
  } else {
    bases.push({ unit: null, template: f.pathTemplate });
  }
  const out = [];
  for (const b of bases) {
    if (object) {
      const topic = b.base || String(b.template || '').split('/').filter((s) => s !== '{name}').join('/');
      out.push({ key: `__object__${b.unit || ''}`, address: null, name: null, topic, unit: b.unit, unitName: b.unitName, object: true, members: rows.map((r) => leaf(r.name)) });
      continue;
    }
    for (const r of rows) {
      out.push({ key: r.key, address: r.address, name: r.name, topic: b.base ? `${b.base}/${leaf(r.name)}` : templateTopic(b.template, leaf(r.name)), unit: b.unit, unitName: b.unitName });
    }
  }
  return out;
}

/** What an edit changes: { renamed: [{ address, from, to }], removed: [{ address, topic }], added: [...] } (topic-per-tag). */
export function diffTopics(before, after) {
  const key = (t) => `${t.unit || ''}\u0000${t.address}`;
  const a = new Map(before.filter((t) => !t.object).map((t) => [key(t), t]));
  const b = new Map(after.filter((t) => !t.object).map((t) => [key(t), t]));
  const renamed = [];
  const removed = [];
  const added = [];
  for (const [k, t] of a) {
    const n = b.get(k);
    if (!n) removed.push({ address: t.address, topic: t.topic, unitName: t.unitName });
    else if (n.topic !== t.topic) renamed.push({ address: t.address, from: t.topic, to: n.topic, unitName: t.unitName });
  }
  for (const [k, t] of b) if (!a.has(k)) added.push({ address: t.address, topic: t.topic, unitName: t.unitName });
  const objBefore = before.filter((t) => t.object).map((t) => t.topic);
  const objAfter = new Set(after.filter((t) => t.object).map((t) => t.topic));
  for (const t of objBefore) if (!objAfter.has(t)) removed.push({ address: null, topic: t });
  return { renamed, removed, added };
}

/** A value topic from a legacy path template (the leaf is already cleaned). */
function templateTopic(template, leaf) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, leaf) : `${t.replace(/\/+$/, '')}/${leaf}`;
}
