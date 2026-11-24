// Pure, protocol-aware helpers for the device editor. The server describes each
// driver (fields, presets, tag types, address help); nothing here hardcodes a
// form, only small display rules for the three shipped drivers with generic
// fallbacks for anything else.
import { orderCodeFor, cleanTag } from '@/lib/deviceTags';

/** Tag type names. Drivers send ['DINT', ...] or [{ name, needsLength, ... }]. */
export function tagTypeNames(descriptor) {
  return (descriptor?.tagTypes || []).map((t) => (typeof t === 'object' ? t.name : t)).filter(Boolean);
}

export function tagTypeInfo(descriptor, name) {
  const n = String(name || '');
  const map = descriptor?.tagTypeInfo || {};
  const own = map[n] || map[n.toUpperCase()];
  if (own) return own;
  return (descriptor?.tagTypes || []).find((t) => typeof t === 'object' && (t.name === n || t.name === n.toUpperCase()));
}

/** The driver says whether a tag may omit its type (e.g. EtherNet/IP reads it from the controller). */
export function typeOptional(descriptor) {
  return Boolean(descriptor?.tagTypeOptional);
}

/** Does this type take a "length" (S7 STRING / WSTRING)? */
export function typeNeedsLength(descriptor, name) {
  return Boolean(tagTypeInfo(descriptor, name)?.needsLength);
}

/** First example in the driver's address help, for input placeholders. */
export function addressExample(descriptor) {
  const help = String(descriptor?.addressHelp || '');
  const first = help.split(/[.,;]\s|, /)[0].trim();
  if (descriptor?.id === 's7') return 'DB1.DBD0';
  if (descriptor?.id === 'ethernet-ip') return 'Program:MainProgram.Tag';
  return first.length > 0 && first.length < 30 ? first : 'address';
}

/**
 * Columns beyond the common set. `always` ones are shown inline, `advanced` ones
 * behind the toggle. Byte/word order and bit are Modbus register concepts only.
 */
export function extraColumns(descriptor) {
  const id = descriptor?.id;
  const hasLength = Object.values(descriptor?.tagTypeInfo || {}).some((t) => t?.needsLength) || (descriptor?.tagTypes || []).some((t) => typeof t === 'object' && t.needsLength);
  if (id === 'modbus-tcp') return { always: [], advanced: ['length', 'bit', 'byteOrder', 'wordOrder'] };
  if (hasLength) return { always: ['length'], advanced: [] };
  return { always: [], advanced: [] };
}

/** Defaults for a descriptor field list (booleans included). */
export function fieldDefaults(fields) {
  const out = {};
  for (const f of fields || []) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

/** Drop blank optional fields and coerce numbers, so '' never reaches a driver. */
export function cleanFields(values, fields) {
  const out = { ...values };
  for (const f of fields || []) {
    const v = out[f.name];
    if (v === '' || v === undefined || v === null) {
      delete out[f.name];
      continue;
    }
    if (f.type === 'number') out[f.name] = Number(v);
  }
  return out;
}

export function applyPreset(draft, preset) {
  const { label: _label, ...values } = preset;
  return { ...draft, ...values };
}

export function presetActive(draft, preset) {
  const { label: _label, ...values } = preset;
  return Object.entries(values).every(([k, v]) => draft[k] === v);
}

const short = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A compact, human summary of a tag's `normalized` validation result. */
export function summarizeNormalized(protocol, n) {
  if (!n || typeof n !== 'object') return '';
  if (n.table !== undefined && n.offset !== undefined) {
    const order = orderCodeFor(n.byteOrder, n.wordOrder);
    const parts = [`${n.table} ${n.offset} (0-based)${n.count > 1 ? ` x${n.count}` : ''}`];
    if (n.fc) parts.push(`FC${n.fc}`);
    if (order && n.type !== 'bool' && n.type !== 'uint16' && n.type !== 'int16') parts.push(order);
    return parts.join(' · ');
  }
  if (n.areaCode !== undefined || n.area !== undefined) {
    const where = n.area === 'DB' ? `DB${n.db} byte ${n.byteOffset}` : `${n.area} byte ${n.byteOffset}`;
    const bit = n.bitOffset !== undefined && n.bitOffset !== null && n.type === 'BOOL' ? `.${n.bitOffset}` : '';
    return `${n.address} · ${where}${bit} · ${n.type}, ${n.length} byte${n.length === 1 ? '' : 's'}`;
  }
  if (protocol === 'ethernet-ip' || (n.address && !n.table)) {
    return `${n.address}${n.type ? ` · ${n.type}` : ' · type read from the controller'}`;
  }
  return Object.entries(n)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'key' && k !== 'pollGroup')
    .map(([k, v]) => `${k}: ${short(v)}`)
    .join(' · ');
}

/** "Motor.Speed" -> "motorSpeed", "Arr[3]" -> "arr3", "Program:Main.Local_Dint" -> "localDint". */
export function camelCase(text) {
  const tokens = String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!tokens.length) return '';
  const out = tokens.map((t, i) => (i === 0 ? t.toLowerCase() : t[0].toUpperCase() + t.slice(1).toLowerCase())).join('');
  return /^\d/.test(out) ? `tag${out[0].toUpperCase()}${out.slice(1)}` : out;
}

export function uniqueName(base, taken) {
  let name = base || 'tag';
  for (let i = 2; taken.has(name); i++) name = `${base || 'tag'}${i}`;
  taken.add(name);
  return name;
}

const KEY_SAFE = /[^A-Za-z0-9_.\-:[\]]/g;

/** Suggested UNS property: camelCase of the tag path without its program scope. */
export function suggestProperty(address) {
  return camelCase(String(address || '').replace(/^Program:[^.]+\./i, ''));
}

/**
 * Turn selected browse nodes into editor rows with unique keys and property
 * names. `taken` carries the keys / properties already in the table.
 */
export function nodesToTags(nodes, { descriptor, existing = [], pollGroup = '', makeId }) {
  const keys = new Set(existing.map((t) => t.key).filter(Boolean));
  const props = new Set(existing.map((t) => t.property).filter(Boolean));
  const known = new Set(tagTypeNames(descriptor));
  return nodes.map((node) => {
    const dataType = String(node.meta?.dataType || '').toUpperCase();
    const isArray = (node.meta?.dims || []).length > 0;
    return {
      _id: makeId(),
      key: uniqueName(String(node.address).replace(KEY_SAFE, '_').slice(0, 120), keys),
      address: node.address,
      type: known.has(dataType) && !isArray ? dataType : '',
      pollGroup,
      property: uniqueName(suggestProperty(node.address), props)
    };
  });
}

/** Why a browse node cannot be selected, or '' when it can. */
export function nodeDisabledReason(node, takenAddresses = new Set()) {
  if (node.kind !== 'tag') return '';
  if (node.meta?.accessible === false) return node.meta.reason || 'Not accessible';
  if (!node.address) return 'Type definition member: not a readable tag';
  if (takenAddresses.has(node.address)) return 'Already in this device';
  return '';
}

/** Flat visible rows of the lazy browse tree, keyed by node id (ids, not addresses, are unique). */
export function flattenTree(childrenByParent, expanded) {
  const out = [];
  const walk = (parentKey, level, parentId) => {
    const list = childrenByParent[parentKey] || [];
    list.forEach((node, i) => {
      const isFolder = node.kind === 'folder' || Boolean(node.meta?.hasChildren);
      const open = isFolder && expanded.has(node.id);
      out.push({ key: node.id, node, level, parentKey: parentId, isFolder, expanded: open, posInSet: i + 1, setSize: list.length });
      if (open) walk(node.id, level + 1, node.id);
    });
  };
  walk('', 1, null);
  return out;
}

/** Probe inputs per protocol. Result decoding is generic apart from the Modbus order table. */
export function probeSpec(protocol) {
  if (protocol === 'modbus-tcp') return { count: { label: 'Registers', min: 1, max: 125, def: 2 }, unitId: true, placeholder: 'holding:100' };
  if (protocol === 's7') return { count: { label: 'Bytes', min: 1, max: 480, def: '' }, unitId: false, placeholder: 'DB1.DBD0' };
  return { count: null, unitId: false, placeholder: 'Program:MainProgram.Tag' };
}

export function probeBody(protocol, { address, count, unitId }) {
  const body = { address: address.trim() };
  if (protocol === 'modbus-tcp') {
    body.count = Number(count) || 2;
    if (unitId !== '' && unitId !== undefined) body.unitId = Number(unitId);
  } else if (protocol === 's7' && count !== '' && count !== undefined) body.length = Number(count);
  return body;
}

export const DEFAULT_LIMITS = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };

export function blankDevice(descriptor) {
  return {
    name: '',
    protocol: descriptor.id,
    enabled: true,
    host: '',
    port: descriptor.defaultPort,
    ...fieldDefaults(descriptor.deviceFields),
    options: fieldDefaults(descriptor.optionFields),
    limits: { ...DEFAULT_LIMITS },
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: []
  };
}

/** The request body for POST/PUT /devices: no read-only `status`, blank optionals dropped, numbers coerced. */
export function toPayload(draft, descriptor) {
  const { status: _status, ownTags: _own, profileErrors: _errs, paramValues: _pv, ...rest } = draft;
  const top = cleanFields(rest, descriptor?.deviceFields);
  return {
    ...top,
    port: Number(draft.port),
    ...(draft.profileId ? { params: Object.fromEntries(Object.entries(draft.params || {}).filter(([, v]) => v !== '' && v !== undefined)) } : {}),
    options: cleanFields(draft.options || {}, descriptor?.optionFields),
    limits: Object.fromEntries(Object.entries(draft.limits || {}).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
    pollGroups: (draft.pollGroups || []).map((g) => ({ id: g.id, intervalMs: Number(g.intervalMs) })),
    tags: (draft.tags || []).map(cleanTag)
  };
}

/** Why "Import from controller" cannot run right now ('' when it can). */
export function browseBlockedReason(editing, device, live) {
  if (!editing) return 'save the device first; the controller is read through the saved, connected device.';
  if (device.enabled === false) return 'the device is disabled. Enable it and wait for it to go online.';
  const phase = live?.phase || live?.state;
  if (phase !== 'online') return `the device is not online yet (${phase || 'unknown'}). Browsing needs a live connection.`;
  return '';
}
