// Asset-path helpers. validateAssetPath mirrors server/services/bindingModel.js
// (validateAssetPath, valueTopicOf, statusTopicOf, metaTopicOf) so the wizard
// reports the same problems the server would, before a request is made.
import { slug } from './helpers';

/** Trim whitespace and trailing slashes (the server also drops trailing slashes). */
export const normalizeAssetPath = (p) => String(p ?? '').trim().replace(/\/+$/, '');

/** Error string for an ISA-95 asset path (no placeholders), or null. */
export function validateAssetPath(p, what = 'Asset path') {
  const v = String(p ?? '');
  if (!v.trim()) return `${what} is required, for example acme/dallas/line4/filler.`;
  if (v.length > 512) return `${what} is longer than 512 characters.`;
  if (/[{}]/.test(v)) return `${what} cannot contain placeholders. Use Advanced for a template.`;
  if ([...v].some((c) => c.charCodeAt(0) < 0x20)) return `${what} cannot contain control characters.`;
  for (const seg of v.split('/')) {
    if (seg === '') return `${what} "${v}" has an empty segment (leading, trailing or double slash).`;
    if (/[+#]/.test(seg)) return `${what} "${v}" contains an MQTT wildcard (+ or #).`;
    if (seg.startsWith('$')) return `${what} "${v}" has a segment starting with $ (reserved for broker topics).`;
  }
  return null;
}

/** Template with {device}/{deviceId}/{param} placeholders. allowed = Set of placeholder names. */
export function validateAssetTemplate(t, allowed) {
  const v = String(t ?? '').trim();
  if (!v) return 'Enter an asset path template, for example acme/dallas/{device}.';
  const names = [...v.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const unknown = names.filter((n) => !allowed.has(n));
  if (unknown.length) return `Unknown placeholder {${unknown[0]}}. Allowed: ${[...allowed].map((n) => `{${n}}`).join(', ')}.`;
  return validateAssetPath(v.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'x'), 'Asset path template');
}

export const assetValueTopic = (asset, name) => `${asset}/${slug(name)}`;
export const assetStatusTopic = (asset) => `${asset}/_status`;
export const assetMetaTopic = (asset) => `${asset}/_meta`;

/** Parent of a path ('a/b/c' -> 'a/b', 'a' -> ''). */
export const parentPath = (p) => String(p ?? '').split('/').slice(0, -1).join('/');

/** The asset path a stored binding publishes to, as one copyable string (template shown as-is). */
export function bindingAssetPath(b) {
  const t = b?.target || {};
  if (t.mode !== 'mqtt') return '';
  if (t.assetPath) return String(t.assetPath);
  if (t.assetPathTemplate) return String(t.assetPathTemplate);
  const tpl = String(t.pathTemplate || 'uns/{name}');
  return tpl.split('/').filter((s) => s !== '{name}').join('/').replace(/\{name\}/g, '').replace(/\/+$/, '');
}

/** Flatten the loaded tree into the visible rows of an ARIA tree. */
export function visibleRows(childrenOf, expanded) {
  const out = [];
  const walk = (prefix, level) => {
    for (const c of childrenOf.get(prefix) || []) {
      out.push({ ...c, level });
      if (expanded.has(c.path)) walk(c.path, level + 1);
    }
  };
  walk('', 1);
  return out;
}

