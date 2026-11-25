// Pure mirror of server/services/deviceProfiles.js: {param} placeholder parsing,
// parameter resolution and tag expansion. The rules are copied exactly so the
// preview in the UI shows what the server will store (the server stays the
// authority and re-validates everything).

export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
export const SUBSTITUTED_FIELDS = ['key', 'address', 'property'];
export const MAX_PARAM_VALUE = 256;

/** Placeholder names used in a string ({name} syntax), in order of first use. */
export function placeholders(str) {
  const out = new Set();
  if (typeof str !== 'string') return out;
  for (const m of str.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return out;
}

/** Every placeholder used by a tag's key, address and property. */
export function tagPlaceholders(tag) {
  const out = new Set();
  for (const f of SUBSTITUTED_FIELDS) for (const n of placeholders(tag?.[f])) out.add(n);
  return out;
}

/** Replace {name} with params[name]; throws on a placeholder with no value (as the server does). */
export function substitute(str, params) {
  if (typeof str !== 'string') return str;
  return str.replace(PLACEHOLDER_RE, (_, name) => {
    if (!Object.hasOwn(params, name)) throw new Error(`no value for parameter {${name}}`);
    return String(params[name]);
  });
}

/** Declared params + given values -> { values, errors[] } with defaults applied. Same checks as the server. */
export function resolveParams(profile, given) {
  const values = {};
  const errors = [];
  const declared = new Map((profile?.params || []).map((p) => [p.name, p]));
  const g = given && typeof given === 'object' ? given : {};
  for (const name of Object.keys(g)) {
    if (!declared.has(name)) errors.push(`unknown parameter "${name}" (profile declares: ${[...declared.keys()].join(', ') || 'none'})`);
  }
  for (const [name, p] of declared) {
    const v = Object.hasOwn(g, name) && g[name] !== '' && g[name] !== null && g[name] !== undefined ? g[name] : p.default;
    if (v === undefined || v === null || v === '') {
      errors.push(`parameter "${name}" is required`);
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      errors.push(`parameter "${name}" must be a string or number`);
      continue;
    }
    if (String(v).length > MAX_PARAM_VALUE) {
      errors.push(`parameter "${name}" is longer than ${MAX_PARAM_VALUE} characters`);
      continue;
    }
    values[name] = v;
  }
  return { values, errors };
}

/**
 * Profile tags with params substituted -> { tags, errors: [{ key, error }] }.
 * Each expanded tag keeps `origin: 'profile'` and, for the UI, `_from` = the
 * template key it came from.
 */
export function expandProfileTags(profile, values) {
  const tags = [];
  const errors = [];
  for (const t of profile?.tags || []) {
    try {
      const out = { ...t, origin: 'profile', _from: t.key };
      for (const f of SUBSTITUTED_FIELDS) if (typeof t[f] === 'string') out[f] = substitute(t[f], values);
      tags.push(out);
    } catch (error) {
      errors.push({ key: t?.key ?? null, error: error.message });
    }
  }
  return { tags, errors };
}

/**
 * The live preview of a new instance: resolved params, expanded tags and every
 * problem the server would report for the profile side (a missing parameter,
 * a duplicate effective key, a clash with one of the device's own tags).
 */
export function previewInstance(profile, given, ownTags = []) {
  const { values, errors: paramErrors } = resolveParams(profile, given);
  const errors = paramErrors.map((error) => ({ key: null, error }));
  if (paramErrors.length) return { values, tags: [], errors };
  const { tags, errors: tagErrors } = expandProfileTags(profile, values);
  errors.push(...tagErrors);
  const seen = new Set();
  for (const t of tags) {
    if (seen.has(t.key)) errors.push({ key: t.key, error: `duplicate key "${t.key}" after substitution` });
    seen.add(t.key);
  }
  for (const t of ownTags) if (seen.has(t?.key)) errors.push({ key: t.key, error: `ad-hoc tag "${t.key}" conflicts with a profile tag; rename the ad-hoc tag` });
  return { values, tags, errors };
}

/** Placeholders used by the profile's tags that no param declares: [{ key, names[] }] per tag. */
export function undeclaredPlaceholders(tags, params) {
  const declared = new Set((params || []).map((p) => p.name));
  const out = [];
  for (const t of tags || []) {
    const names = [...tagPlaceholders(t)].filter((n) => !declared.has(n));
    if (names.length) out.push({ key: t.key ?? '', names });
  }
  return out;
}

/** Declared params whose name no tag uses (a hint, not an error). */
export function unusedParams(tags, params) {
  const used = new Set();
  for (const t of tags || []) for (const n of tagPlaceholders(t)) used.add(n);
  return (params || []).map((p) => p.name).filter((n) => n && !used.has(n));
}

/** Param defaults as { name: default } (only params that have one). */
export function paramDefaults(params) {
  return Object.fromEntries((params || []).filter((p) => p.default !== undefined && p.default !== null && p.default !== '').map((p) => [p.name, p.default]));
}

/**
 * Tags a profile editor can already validate with the driver: placeholders are
 * replaced by the parameter defaults; tags that use a parameter without a
 * default (or an undeclared one) are skipped - the server checks them per
 * instance. `keyMap` maps an expanded key back to the template key.
 */
export function expandForValidation(tags, params) {
  const defaults = paramDefaults(params);
  const list = [];
  const keyMap = {};
  const skipped = [];
  for (const t of tags) {
    if (!t.key) continue;
    try {
      const out = { ...t };
      for (const f of SUBSTITUTED_FIELDS) if (typeof t[f] === 'string') out[f] = substitute(t[f], defaults);
      list.push(out);
      keyMap[out.key] = t.key;
    } catch {
      skipped.push(t.key);
    }
  }
  return { list, keyMap, skipped };
}

/** A blank param declaration. */
export const blankParam = () => ({ name: '', default: '', description: '' });

/** Params as sent to the server: blank defaults/descriptions dropped. */
export function cleanParams(params) {
  return (params || [])
    .filter((p) => p.name?.trim())
    .map((p) => ({
      name: p.name.trim(),
      ...(p.default !== undefined && p.default !== null && p.default !== '' ? { default: p.default } : {}),
      ...(p.description?.trim() ? { description: p.description.trim() } : {})
    }));
}

/** Local param-declaration problems -> { [index]: message } (the server re-checks). */
export function paramDeclErrors(params) {
  const seen = new Set();
  const errs = {};
  (params || []).forEach((p, i) => {
    const n = (p.name || '').trim();
    if (!n) return;
    if (!PARAM_NAME_RE.test(n)) errs[i] = 'Use letters, digits and _, not starting with a digit';
    else if (seen.has(n)) errs[i] = 'Duplicate parameter name';
    seen.add(n);
  });
  return errs;
}
