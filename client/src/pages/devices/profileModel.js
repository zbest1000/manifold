// Pure helpers for the profile editor and the instance dialogs (no React, no I/O).
import { cleanTag } from '@/lib/deviceTags';
import { cleanParams, undeclaredPlaceholders } from '@/lib/deviceProfiles';
import { cleanFields } from './model';

export function blankProfile(descriptor) {
  return { name: '', protocol: descriptor.id, description: '', params: [], options: {}, pollGroups: [{ id: 'default', intervalMs: 1000 }], tags: [] };
}

/** "Create from device": the device's OWN tags (never echoed profile tags) become a profile draft. */
export function profileFromDevice(device) {
  const own = (device.ownTags || device.tags || []).filter((t) => t.origin !== 'profile');
  return {
    name: `${device.name} profile`,
    protocol: device.protocol,
    description: `Created from device ${device.name}`,
    params: [],
    options: { ...(device.options || {}) },
    pollGroups: (device.pollGroups?.length ? device.pollGroups : [{ id: 'default', intervalMs: 1000 }]).map((g) => ({ id: g.id, intervalMs: g.intervalMs })),
    tags: own.map(({ origin: _origin, _id, ...t }) => t)
  };
}

/** Request body for POST/PUT /api/devices/profiles. */
export function toProfilePayload(draft, descriptor) {
  return {
    name: draft.name.trim(),
    protocol: draft.protocol,
    ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
    options: cleanFields(draft.options || {}, descriptor?.optionFields),
    pollGroups: (draft.pollGroups || []).map((g) => ({ id: g.id, intervalMs: Number(g.intervalMs) })),
    params: cleanParams(draft.params),
    tags: (draft.tags || []).map(cleanTag)
  };
}

/** Inline row errors for placeholders no param declares: { [rowIndex]: message }. */
export function placeholderRowErrors(tags, params) {
  const bad = new Map(undeclaredPlaceholders(tags, params).map((u) => [u.key, u.names]));
  const errs = {};
  tags.forEach((t, i) => {
    const names = bad.get(t.key ?? '');
    if (names) errs[i] = `Undeclared parameter ${names.map((n) => `{${n}}`).join(', ')}: declare it under Parameters`;
  });
  return errs;
}

/**
 * A 400 from saving a profile is either per-tag ({ key, error }) or per-instance
 * ({ deviceId, name, error, details }). Split them so the UI can show each properly.
 */
export function splitProfileErrors(details) {
  const list = Array.isArray(details) ? details : [];
  return { instances: list.filter((d) => d && d.deviceId !== undefined), tags: list.filter((d) => d && d.deviceId === undefined) };
}

/** Group poll groups of a profile with an instance's own overrides (by id), like the server's mergePollGroups. */
export function mergeGroups(profileGroups, ownGroups) {
  const byId = new Map();
  for (const g of profileGroups || []) if (g?.id) byId.set(g.id, g);
  for (const g of ownGroups || []) if (g?.id) byId.set(g.id, g);
  return [...byId.values()];
}

/** Count how many tag templates a profile has and how many params it declares, for the list. */
export function profileSummary(p) {
  return { tags: p.tags?.length || 0, params: (p.params || []).map((x) => x.name), instances: p.instances || [] };
}
