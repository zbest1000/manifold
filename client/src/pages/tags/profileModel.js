// Device-profile bindings: placeholder set and the per-instance asset-path table.
// Mirrors server/services/bindingModel.js (expandUnits / substituteVars): each
// placeholder value is slugged, {device} is the device name (or id), {deviceId}
// its id, any other {param} one of the profile's params (instance value, else default).
import { slug } from './helpers';
import { validateAssetPath } from './assetPath';

/** Placeholder names a template may use for this profile. */
export function allowedPlaceholders(profile) {
  return new Set(['device', 'deviceId', ...(profile?.params || []).map((p) => p.name)]);
}

/** Substitution variables for one instance (device record with optional params). */
export function instanceVars(profile, device) {
  const vars = {};
  for (const p of profile?.params || []) {
    const given = device?.params?.[p.name];
    const v = given !== undefined && given !== null && given !== '' ? given : p.default;
    if (v !== undefined && v !== null && v !== '') vars[p.name] = v;
  }
  return { ...vars, device: device?.name || device?.id, deviceId: device?.id };
}

export function substituteTemplate(template, vars) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => {
    if (!Object.hasOwn(vars, n) || vars[n] === undefined) throw new Error(`no value for {${n}} on this instance`);
    return slug(vars[n]);
  });
}

/**
 * Instance -> resolved asset path rows: [{ deviceId, name, path, error, overridden }].
 * overrides = { deviceId: path } wins over the template, like target.assetPaths on the server.
 */
export function instanceRows({ profile, devices, template, overrides = {} }) {
  const mine = (devices || []).filter((d) => d.profileId === profile?.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return mine.map((d) => {
    const over = overrides[d.id];
    const overridden = over !== undefined && String(over).trim() !== '';
    let path = '';
    let error = null;
    try {
      path = overridden ? String(over).trim().replace(/\/+$/, '') : substituteTemplate(String(template || '').trim(), instanceVars(profile, d));
      error = path || overridden ? validateAssetPath(path, `Asset path for ${d.name || d.id}`) : 'No asset path template.';
    } catch (e) {
      error = e.message;
    }
    return { deviceId: d.id, name: d.name || d.id, path, error, overridden };
  });
}

/** Keep only non-empty overrides for known instances. */
export function cleanOverrides(overrides, devices) {
  const ids = new Set((devices || []).map((d) => d.id));
  const out = {};
  for (const [id, p] of Object.entries(overrides || {})) {
    if (String(p ?? '').trim() && (!devices || ids.has(id))) out[id] = String(p).trim().replace(/\/+$/, '');
  }
  return out;
}
