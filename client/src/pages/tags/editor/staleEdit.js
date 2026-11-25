// Concurrent edits of one mapping (pure). The server answers a save based on an old `rev` with
// 409 { code: 'stale', current }; the editor shows what changed elsewhere and lets the user keep
// their version, take the stored one, or go back to editing.

const IGNORED = new Set(['rev', 'warnings', 'updatedAt', 'createdAt']);
const MAX_PATHS = 200;

/** Flatten to { 'target.assetPath': value, 'source.tags[1].unit': value, ... } (leaves only). */
export function flatten(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    if (!value.length) out[prefix] = [];
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => !(prefix === '' && IGNORED.has(k)));
    if (!keys.length && prefix) out[prefix] = {};
    for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = value;
  return out;
}

const show = (v) => (v === undefined ? '(not set)' : typeof v === 'string' ? v : JSON.stringify(v));

/** [{ path, from, to }] where `b` differs from `a` (bounded, sorted by path). */
export function diffFields(a, b) {
  const fa = flatten(a || {});
  const fb = flatten(b || {});
  const out = [];
  for (const path of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    if (JSON.stringify(fa[path]) === JSON.stringify(fb[path])) continue;
    out.push({ path, from: show(fa[path]), to: show(fb[path]) });
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/**
 * The conflict as the dialog shows it: what changed elsewhere since the editor loaded (`base` ->
 * `theirs`), what this editor changed (`base` -> `mine`), and the paths both touched.
 */
export function describeConflict({ base, mine, theirs }) {
  const elsewhere = diffFields(base, theirs);
  const here = diffFields(base, mine);
  const mineSet = new Set(here.map((d) => d.path));
  return { elsewhere, here, both: elsewhere.filter((d) => mineSet.has(d.path)).map((d) => d.path) };
}

/** The body for "keep mine": my version, based on the stored revision (when the server has one). */
export function overwriteBody(mine, theirs) {
  const body = { ...mine };
  if (theirs && theirs.rev !== undefined) body.rev = theirs.rev;
  else delete body.rev;
  return body;
}

/** Is this error the server refusing a save over a newer edit? */
export const isStale = (e) => e?.status === 409 && e?.body?.code === 'stale';
