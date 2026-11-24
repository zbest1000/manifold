'use strict';

/**
 * Device profiles and instances (docs/design/southbound-drivers.md 4.4) - the
 * pure half: parameter resolution, placeholder substitution and the merge of a
 * profile with one device instance into the EFFECTIVE device the drivers see.
 * No I/O, no driver knowledge; DeviceManager adds driver validation on top.
 *
 *   deviceProfile { id, name, protocol, options, pollGroups,
 *                   tags: [{ key, address, property?, ... with {param} placeholders }],
 *                   params: [{ name, default?, description? }] }
 *   device        { ..., profileId?, params?: { name: value }, tags: [ad-hoc tags] }
 *
 * Merge rules (effectiveDevice):
 * - protocol: the profile's (a device may repeat it; a different one is an error)
 * - options: { ...profile.options, ...device.options } (instance overrides win)
 * - pollGroups: profile groups, overridden/extended by the device's groups by id
 * - tags: profile tags with placeholders substituted in `key`, `address` and
 *   `property`, then the device's own ad-hoc tags. An ad-hoc tag whose key
 *   equals a profile tag key is a validation ERROR (never a silent override).
 *   Effective profile tags carry `origin: 'profile'` so a client that echoes
 *   GET /api/devices back on PUT does not turn them into ad-hoc tags (tags
 *   marked that way are dropped from a save).
 */

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const SUBSTITUTED_FIELDS = ['key', 'address', 'property'];
const MAX_PARAMS = 64;
const MAX_PARAM_VALUE = 256;

/** Placeholder names used in a string ({name} syntax). */
function placeholders(str) {
  const out = new Set();
  if (typeof str !== 'string') return out;
  for (const m of str.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return out;
}

/** Replace {name} with params[name]; throws on a placeholder with no value. */
function substitute(str, params) {
  if (typeof str !== 'string') return str;
  return str.replace(PLACEHOLDER_RE, (_, name) => {
    if (!Object.hasOwn(params, name)) throw new Error(`no value for parameter {${name}}`);
    return String(params[name]);
  });
}

/** Declared params + instance values -> { values, errors[] } (defaults applied). */
function resolveParams(profile, given) {
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

/** Profile tags with params substituted -> { tags, errors: [{ key, error }] }. */
function expandProfileTags(profile, values) {
  const tags = [];
  const errors = [];
  for (const t of profile?.tags || []) {
    try {
      const out = { ...t, origin: 'profile' };
      for (const f of SUBSTITUTED_FIELDS) if (typeof t[f] === 'string') out[f] = substitute(t[f], values);
      tags.push(out);
    } catch (error) {
      errors.push({ key: t?.key ?? null, error: error.message });
    }
  }
  return { tags, errors };
}

function mergePollGroups(profileGroups, deviceGroups) {
  const byId = new Map();
  for (const g of Array.isArray(profileGroups) ? profileGroups : []) if (g?.id) byId.set(g.id, g);
  for (const g of Array.isArray(deviceGroups) ? deviceGroups : []) if (g?.id) byId.set(g.id, g);
  return [...byId.values()];
}

/** Device tags as stored: drop echoed profile tags. */
function ownTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((t) => !(t && t.origin === 'profile'));
}

/**
 * The effective device: { device, errors: [{ key?, error }] }. A device
 * without profileId is returned as is. `profile` is the referenced profile
 * (or null when it does not exist).
 */
function effectiveDevice(device, profile) {
  if (!device?.profileId) return { device, errors: [] };
  const own = ownTags(device.tags);
  if (!profile) {
    return { device: { ...device, tags: own }, errors: [{ key: null, error: `device profile "${device.profileId}" not found` }] };
  }
  const errors = [];
  if (device.protocol && device.protocol !== profile.protocol) {
    errors.push({ key: null, error: `protocol "${device.protocol}" does not match the profile's "${profile.protocol}"` });
  }
  const { values, errors: paramErrors } = resolveParams(profile, device.params);
  for (const e of paramErrors) errors.push({ key: null, error: e });
  const { tags: fromProfile, errors: tagErrors } = paramErrors.length ? { tags: [], errors: [] } : expandProfileTags(profile, values);
  errors.push(...tagErrors);
  const profileKeys = new Set(fromProfile.map((t) => t.key));
  for (const t of own) {
    if (profileKeys.has(t?.key)) {
      errors.push({ key: t.key, error: `ad-hoc tag "${t.key}" conflicts with a tag of profile "${profile.name || profile.id}"; rename the ad-hoc tag` });
    }
  }
  const pollGroups = mergePollGroups(profile.pollGroups, device.pollGroups);
  return {
    device: {
      ...device,
      protocol: profile.protocol,
      options: { ...(profile.options || {}), ...(device.options || {}) },
      pollGroups: pollGroups.length ? pollGroups : [{ id: 'default', intervalMs: 1000 }],
      tags: [...fromProfile, ...own.filter((t) => !profileKeys.has(t?.key))],
      paramValues: values
    },
    errors
  };
}

/** Structural validation of params[] declarations -> error string or null. */
function validateParamDecls(params) {
  if (params === undefined) return null;
  if (!Array.isArray(params)) return 'params must be an array of { name, default?, description? }';
  if (params.length > MAX_PARAMS) return `at most ${MAX_PARAMS} params`;
  const seen = new Set();
  for (const p of params) {
    if (!p || typeof p.name !== 'string' || !PARAM_NAME_RE.test(p.name)) {
      return `param name "${p?.name}" is invalid (letters, digits, _; must not start with a digit)`;
    }
    if (seen.has(p.name)) return `duplicate param "${p.name}"`;
    seen.add(p.name);
    if (p.default !== undefined && p.default !== null && typeof p.default !== 'string' && typeof p.default !== 'number') {
      return `param "${p.name}": default must be a string or number`;
    }
  }
  return null;
}

module.exports = {
  PARAM_NAME_RE,
  placeholders,
  substitute,
  resolveParams,
  expandProfileTags,
  mergePollGroups,
  effectiveDevice,
  ownTags,
  validateParamDecls
};
