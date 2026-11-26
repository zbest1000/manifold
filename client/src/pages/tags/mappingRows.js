// Rows, selection rules and context lists of the mapping editor (pure; see mappingModel.js).

/** Per-tag override keys the editor edits (the server's list, minus name and enabled which rows hold). */
// `field` and `staleAfterMs` exist on MQTT-topic sources only (where in the payload, staleness limit).
export const OV_KEYS = ['displayName', 'description', 'unit', 'range', 'dataType', 'scale', 'offset', 'precision', 'states', 'statesMode', 'limits', 'deadband', 'context', 'field', 'staleAfterMs'];
const ROW_OWNED = new Set(['address', 'name', 'enabled', ...OV_KEYS]);
export const LIMIT_KEYS = ['lolo', 'lo', 'hi', 'hihi'];
/** Fields that "copy settings from a row" copies: everything except the tag's identity. */
export const COPY_KEYS = ['unit', 'range', 'dataType', 'scale', 'offset', 'precision', 'states', 'statesMode', 'limits', 'deadband', 'context', 'field', 'staleAfterMs'];

const hasVal = (x) => x !== undefined && x !== null && x !== '';
const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
const RULE_SOURCES = new Set(['device', 'device-profile', 'mqtt', 'iot']);
export const supportsRules = (srcType) => RULE_SOURCES.has(srcType);
export const supportsOverrides = (srcType) => srcType === 'device' || srcType === 'device-profile' || srcType === 'opcua' || srcType === 'mqtt' || srcType === 'iot';
export const renameable = (srcType) => srcType !== 'sparkplug';

/** A published name as a topic level, like the server: MQTT-topic sources keep "/" levels (each cleaned). */
export function nameSlug(srcType, name) {
  if (srcType !== 'mqtt') return String(name).trim().replace(/[\s/+#]+/g, '_');
  return String(name)
    .split('/')
    .map((x) => x.trim().replace(/[\s+#]+/g, '_'))
    .filter(Boolean)
    .join('/');
}

/** Last level of a topic (the server's default name of an explicitly listed MQTT topic). */
export const lastLevel = (topic) => String(topic).split('/').filter(Boolean).pop() || String(topic);

// ---- rows -------------------------------------------------------------------------------------

/** The device definition of a tag as the table shows it (device API tag, profile tag or browse meta). */
export function defOf(t = {}) {
  const d = {};
  for (const k of ['type', 'unit', 'description', 'property', 'range', 'displayName', 'states', 'limits', 'context', 'pollGroup', 'address', 'browseName']) {
    if (hasVal(t[k])) d[k] = t[k];
  }
  return d;
}

/**
 * The value a row inherits for `field` when the mapping sets none, for the editor's placeholders:
 * the device / browse definition, else what the server reported for this tag in the preview when
 * it came from the source itself (OPC UA EngineeringUnits, Description, EURange). A row reopened
 * from a stored OPC UA mapping has no browse metadata, only the server's answer.
 */
export function inheritedValue(row, serverTag, field) {
  const own = row?.def?.[field];
  if (hasVal(own)) return own;
  const origin = serverTag?.origins?.[field];
  if (origin !== 'server' && origin !== 'device') return undefined;
  const v = serverTag?.metadata?.[field];
  return hasVal(v) ? v : undefined;
}

/** The name the server publishes when the mapping sets none: property, else the key (OPC UA: the browse name we store). */
export function defaultNameOf(srcType, address, def = {}) {
  if (srcType === 'mqtt') return def.browseName || lastLevel(address);
  if (srcType === 'opcua' || srcType === 'sparkplug') return def.browseName || address;
  return def.property || address;
}

/**
 * One row. `stored` is the list entry (string | object) or, in rules mode, source.overrides[key].
 * `inherited` is source.overrides[key] in list mode (shown, not edited). `apply` pre-fills the
 * suggested name (new mappings only).
 */
export function makeRow({ srcType, address, def = {}, stored = null, inherited = null, suggestion = null, apply = false }) {
  const s = typeof stored === 'string' ? { address: stored } : stored || {};
  const defaultName = defaultNameOf(srcType, address, def);
  const storedName = hasVal(s.name) ? String(s.name) : '';
  let name = storedName || (inherited && hasVal(inherited.name) ? String(inherited.name) : defaultName);
  let explicit = Boolean(storedName);
  let fromSuggestion = false;
  if (!storedName && apply && suggestion?.suggestedName && suggestion.suggestedName !== defaultName && renameable(srcType)) {
    name = suggestion.suggestedName;
    explicit = true;
    fromSuggestion = true;
  }
  const ov = {};
  const extra = {};
  for (const [k, v] of Object.entries(s)) {
    if (OV_KEYS.includes(k)) ov[k] = v;
    else if (!ROW_OWNED.has(k)) extra[k] = v;
  }
  return {
    key: address,
    address,
    enabled: (s.enabled ?? inherited?.enabled) !== false,
    enabledKey: Object.hasOwn(s, 'enabled'),
    present: stored !== null && stored !== undefined,
    asObject: isObj(stored),
    name,
    defaultName,
    explicit,
    fromSuggestion,
    alwaysName: srcType === 'opcua' || srcType === 'mqtt',
    ov,
    extra,
    inherited: isObj(inherited) ? inherited : null,
    def,
    suggestion: suggestion || null
  };
}

/** List entry for a row: a bare address string when nothing else is set (the legacy shape). */
export function entryOf(row) {
  const o = { address: row.address };
  const name = String(row.name ?? '').trim();
  if ((row.alwaysName || row.explicit) && name) o.name = name;
  if (!row.enabled || row.enabledKey) o.enabled = row.enabled;
  for (const k of OV_KEYS) if (row.ov[k] !== undefined) o[k] = row.ov[k];
  Object.assign(o, row.extra);
  return Object.keys(o).length === 1 && !row.asObject ? row.address : o;
}

/** source.overrides[key] for a rule-selected row, or null when it overrides nothing. */
export function overrideOf(row) {
  const o = {};
  const name = String(row.name ?? '').trim();
  if (row.explicit && name) o.name = name;
  if (!row.enabled || row.enabledKey) o.enabled = row.enabled;
  for (const k of OV_KEYS) if (row.ov[k] !== undefined) o[k] = row.ov[k];
  Object.assign(o, row.extra);
  return Object.keys(o).length || row.present ? o : null;
}

/** Rename: explicit only when the text differs from the server default (OPC UA always stores the name). */
export function renameRow(row, value) {
  return { ...row, name: value, explicit: row.alwaysName || String(value).trim() !== row.defaultName, fromSuggestion: false };
}

/** Set (or clear, with undefined / '') one override of a row. */
export function setOv(row, field, value) {
  const ov = { ...row.ov };
  if (value === undefined || value === null || value === '' || (isObj(value) && !Object.keys(value).length)) delete ov[field];
  else ov[field] = value;
  return { ...row, ov };
}

/** Number of fields a row overrides (name included). */
export const overrideCount = (row) => Object.keys(row.ov).length + (row.explicit && !row.alwaysName ? 1 : 0);

// ---- selection rules (mirror of server/services/bindingContext.js compileSelect / selectTag) --

const globCache = new Map();
function globToRegExp(p) {
  const key = String(p);
  let re = globCache.get(key);
  if (!re) {
    const src = key
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${src}$`, 'i');
    if (globCache.size > 500) globCache.clear();
    globCache.set(key, re);
  }
  return re;
}

export const EMPTY_RULES = Object.freeze({ include: [], exclude: [], pollGroups: [], types: [], withProperty: null });

/** source.select for the rules, keeping unknown keys; null when nothing is set. */
export function buildSelect(rules, extra = {}) {
  const o = { ...extra };
  for (const k of ['include', 'exclude', 'pollGroups', 'types']) if (rules[k]?.length) o[k] = [...rules[k]];
  if (typeof rules.withProperty === 'boolean') o.withProperty = rules.withProperty;
  return Object.keys(o).length ? o : null;
}

/** Verdict for one tag ({ key, property, pollGroup, type }): { matched } | { matched: false, rule, pattern? }. */
export function matchTag(rules, tag) {
  const hit = (list) => list.find((p) => globToRegExp(p).test(String(tag.key ?? '')) || (tag.property ? globToRegExp(p).test(String(tag.property)) : false));
  if (rules.include?.length && !hit(rules.include)) return { matched: false, rule: 'include' };
  if (rules.pollGroups?.length && !rules.pollGroups.map(String).includes(String(tag.pollGroup || 'default'))) return { matched: false, rule: 'pollGroups' };
  if (rules.types?.length && !rules.types.map((t) => String(t).toLowerCase()).includes(String(tag.type || '').toLowerCase())) return { matched: false, rule: 'types' };
  if (rules.withProperty === true && !tag.property) return { matched: false, rule: 'withProperty' };
  if (rules.withProperty === false && tag.property) return { matched: false, rule: 'withProperty' };
  const ex = rules.exclude?.length ? hit(rules.exclude) : null;
  if (ex) return { matched: false, rule: 'exclude', pattern: ex };
  return { matched: true };
}

/** Rule verdict of a row in the current state (list mode: always matched). */
export function rowVerdict(state, row) {
  if (state.selectMode !== 'rules') return { matched: true };
  // MQTT topics: the server tests include/exclude against the topic and the published name.
  const property = state.srcType === 'mqtt' ? row.name : row.def.property;
  return matchTag(state.rules, { key: row.address, property, pollGroup: row.def.pollGroup, type: row.def.type });
}

/** Rows that publish: enabled and (rules mode) matched. */
export function publishingRows(state) {
  return state.rows.filter((r) => r.enabled && rowVerdict(state, r).matched);
}

export const RULE_LABEL = {
  include: 'no include pattern matches',
  pollGroups: 'not in the chosen poll groups',
  types: 'type not chosen',
  withProperty: 'property filter',
  exclude: 'excluded by',
  disabled: 'switched off',
  missing: 'not on the device'
};

// ---- context lists ---------------------------------------------------------------------------

/** Context object -> editor rows [{ id, key, value, type }]. */
export function contextRows(ctx) {
  if (!isObj(ctx)) return [];
  return Object.entries(ctx).map(([key, v], i) => ({ id: `c${i}-${key}`, key, value: String(v), type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' }));
}

/** Editor rows -> context object (null when empty). Invalid numbers are kept as text and reported by validation. */
export function contextObject(rows) {
  const o = {};
  for (const r of rows || []) {
    const k = String(r.key).trim();
    if (!k) continue;
    if (r.type === 'number' && r.value !== '' && Number.isFinite(Number(r.value))) o[k] = Number(r.value);
    else if (r.type === 'boolean') o[k] = r.value === 'true';
    else o[k] = r.value;
  }
  return Object.keys(o).length ? o : null;
}
