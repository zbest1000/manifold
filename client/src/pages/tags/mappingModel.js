// Pure state model of the mapping editor (no React). A mapping is a stored binding
// (POST /api/tags/bindings). The editor keeps:
//
//   state = {
//     original,                 stored binding being edited, or null
//     name, mode,               'mqtt' | 'sparkplug'
//     srcType, ref,             source type and its id fields (deviceId, connectionId, profileId, broker/group/edge/device)
//     selectMode,               'list' (explicit pick list) | 'rules' (tags: "all" + source.select)
//     rules, rulesExtra, hadSelect,
//     rows,                     one per tag in the mapping (list) or per device/profile tag (rules)
//     orphans,                  source.overrides the rows do not own (carried through untouched)
//     form                      target / delivery fields (bindingForm.formFromBinding + context, fields, metaFields)
//   }
//
// Round trip: buildMapping(stateFromBinding(b)) deep-equals b for every stored shape; keys the
// editor does not know (on the binding, the source, the target, a tag entry) are carried through.
import { formFromBinding, buildTarget, buildRbe } from './bindingForm';
import { slug, looksLikeRawAddress, targetTopic, commonPrefix } from './helpers';
import { normalizeAssetPath, validateAssetPath, validateAssetTemplate } from './assetPath';
import { instanceRows, allowedPlaceholders as pathPlaceholders } from './profileModel';

/** Per-tag override keys the editor edits (the server's list, minus name and enabled which rows hold). */
export const OV_KEYS = ['displayName', 'description', 'unit', 'range', 'dataType', 'scale', 'offset', 'precision', 'states', 'statesMode', 'limits', 'deadband', 'context'];
const ROW_OWNED = new Set(['address', 'name', 'enabled', ...OV_KEYS]);
const SELECT_KEYS = ['include', 'exclude', 'pollGroups', 'types', 'withProperty'];
const BINDING_OWNED = new Set(['id', 'name', 'enabled', 'source', 'target', 'rbe', 'warnings']);
export const LIMIT_KEYS = ['lolo', 'lo', 'hi', 'hihi'];
/** Fields that "copy settings from a row" copies: everything except the tag's identity. */
export const COPY_KEYS = ['unit', 'range', 'dataType', 'scale', 'offset', 'precision', 'states', 'statesMode', 'limits', 'deadband', 'context'];

const hasVal = (x) => x !== undefined && x !== null && x !== '';
const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
const RULE_SOURCES = new Set(['device', 'device-profile']);
export const supportsRules = (srcType) => RULE_SOURCES.has(srcType);
export const supportsOverrides = (srcType) => srcType === 'device' || srcType === 'device-profile' || srcType === 'opcua';
export const renameable = (srcType) => srcType !== 'sparkplug' && srcType !== 'mqtt';

// ---- rows -------------------------------------------------------------------------------------

/** The device definition of a tag as the table shows it (device API tag, profile tag or browse meta). */
export function defOf(t = {}) {
  const d = {};
  for (const k of ['type', 'unit', 'description', 'property', 'range', 'displayName', 'states', 'limits', 'context', 'pollGroup', 'address', 'browseName']) {
    if (hasVal(t[k])) d[k] = t[k];
  }
  return d;
}

/** The name the server publishes when the mapping sets none: property, else the key (OPC UA: the browse name we store). */
export function defaultNameOf(srcType, address, def = {}) {
  if (srcType === 'opcua' || srcType === 'sparkplug' || srcType === 'mqtt') return def.browseName || address;
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
    alwaysName: srcType === 'opcua',
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

/** Effective value of a field and where it comes from: 'mapping' | 'device' | 'default'. */
export function effective(row, field) {
  if (field === 'name') return { value: row.name, origin: row.explicit ? 'mapping' : row.def.property ? 'device' : 'default' };
  if (row.ov[field] !== undefined && hasVal(row.ov[field])) return { value: row.ov[field], origin: 'mapping' };
  if (row.inherited && hasVal(row.inherited[field])) return { value: row.inherited[field], origin: 'mapping' };
  if (hasVal(row.def[field])) return { value: row.def[field], origin: 'device' };
  return { value: undefined, origin: 'default' };
}

/** Merged per-tag context [{ key, value, origin }] (device, then mapping, key by key). */
export function mergedTagContext(row) {
  const out = new Map();
  for (const [k, v] of Object.entries(isObj(row.def.context) ? row.def.context : {})) out.set(k, { key: k, value: v, origin: 'device' });
  for (const [k, v] of Object.entries(isObj(row.inherited?.context) ? row.inherited.context : {})) out.set(k, { key: k, value: v, origin: 'mapping' });
  for (const [k, v] of Object.entries(isObj(row.ov.context) ? row.ov.context : {})) out.set(k, { key: k, value: v, origin: 'mapping' });
  return [...out.values()];
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
  return matchTag(state.rules, { key: row.address, property: row.def.property, pollGroup: row.def.pollGroup, type: row.def.type });
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

// ---- state ------------------------------------------------------------------------------------

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

function formFor(b, { brokers, srcType }) {
  const t = b?.target || {};
  return {
    ...formFromBinding(b, { brokers, srcType }),
    context: contextRows(t.context),
    contextMode: t.contextMode || 'meta',
    contextModeStored: Object.hasOwn(t, 'contextMode'),
    fields: Array.isArray(t.fields) ? [...t.fields] : null,
    metaFields: Array.isArray(t.metaFields) ? [...t.metaFields] : null
  };
}

const refOf = (src = {}) => {
  const out = {};
  for (const k of ['deviceId', 'connectionId', 'profileId', 'brokerId', 'group', 'edge', 'device']) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

/** suggestion list (POST /bindings/suggest .tags) -> Map(address -> suggestion). */
export const suggestionMap = (list) => new Map((list || []).map((t) => [t.address, t]));

/**
 * Editor state for a stored binding. `tagDefs`: the device's effective tags / the profile's tags
 * ([{ key, ... }]) or null while unknown. `suggestions`: Map(address -> suggestion) or null.
 */
export function stateFromBinding(b, { brokers = [], tagDefs = null, suggestions = null } = {}) {
  const src = b.source || {};
  const srcType = src.type;
  const defs = new Map((tagDefs || []).map((t) => [t.key, defOf(t)]));
  const overrides = isObj(src.overrides) ? src.overrides : {};
  const rules = src.tags === 'all' && supportsRules(srcType);
  const sel = isObj(src.select) ? src.select : {};
  let rows = [];
  let orphans = {};
  if (srcType === 'sparkplug') {
    rows = (Array.isArray(src.metrics) ? src.metrics : []).map((m) => makeRow({ srcType, address: m }));
  } else if (rules) {
    rows = (tagDefs || []).map((t) => makeRow({ srcType, address: t.key, def: defs.get(t.key), stored: overrides[t.key] ?? null, suggestion: suggestions?.get(t.key) }));
    const known = new Set(rows.map((r) => r.address));
    orphans = Object.fromEntries(Object.entries(overrides).filter(([k]) => !known.has(k)));
  } else {
    const entries = Array.isArray(src.tags) ? src.tags : [];
    rows = entries.map((e) => {
      const address = typeof e === 'string' ? e : e.address;
      const def = defs.get(address) || (srcType === 'opcua' && typeof e === 'object' && e.name ? { browseName: e.name } : {});
      return makeRow({ srcType, address, def, stored: e, inherited: overrides[address] || null, suggestion: suggestions?.get(address) });
    });
    orphans = { ...overrides };
  }
  return {
    original: b,
    name: b.name || '',
    mode: b.target?.mode || 'mqtt',
    srcType,
    ref: refOf(src),
    selectMode: rules ? 'rules' : 'list',
    rules: {
      include: Array.isArray(sel.include) ? [...sel.include] : [],
      exclude: Array.isArray(sel.exclude) ? [...sel.exclude] : [],
      pollGroups: Array.isArray(sel.pollGroups) ? [...sel.pollGroups] : [],
      types: Array.isArray(sel.types) ? [...sel.types] : [],
      withProperty: typeof sel.withProperty === 'boolean' ? sel.withProperty : null
    },
    rulesExtra: Object.fromEntries(Object.entries(sel).filter(([k]) => !SELECT_KEYS.includes(k))),
    hadSelect: isObj(src.select),
    rows,
    orphans,
    tagsLoaded: srcType === 'sparkplug' || srcType === 'opcua' || tagDefs !== null,
    form: formFor(b, { brokers, srcType })
  };
}

/**
 * Editor state for a new mapping. `picked`: [{ id, address, name, meta }] from the Tags page (list
 * mode), or null for "all tags by rule". `tagDefs`: device / profile tags when known.
 */
export function newState({ srcType, ref, picked = null, tagDefs = null, suggestions = null, brokers = [], selectMode = 'list' }) {
  const defs = new Map((tagDefs || []).map((t) => [t.key, defOf(t)]));
  const mode = selectMode === 'rules' && supportsRules(srcType) ? 'rules' : 'list';
  let rows;
  if (mode === 'rules') {
    rows = (tagDefs || []).map((t) => makeRow({ srcType, address: t.key, def: defs.get(t.key), suggestion: suggestions?.get(t.key), apply: true }));
  } else {
    rows = (picked || []).map((p) => {
      const def = defs.get(p.address) || defOf({ ...(p.meta || {}), browseName: srcType === 'device' || srcType === 'device-profile' ? undefined : p.name });
      return makeRow({ srcType, address: p.address, def, suggestion: suggestions?.get(p.address), apply: true });
    });
  }
  const form = formFor(null, { brokers, srcType });
  return {
    original: null,
    name: '',
    mode: 'mqtt',
    srcType,
    ref: { ...ref },
    selectMode: mode,
    rules: { ...EMPTY_RULES, include: [], exclude: [], pollGroups: [], types: [] },
    rulesExtra: {},
    hadSelect: false,
    rows,
    orphans: {},
    tagsLoaded: mode === 'list' || tagDefs !== null,
    form
  };
}

/** Fill device definitions and (new mappings) suggestions in once they load; rules mode gets every tag as a row. */
export function withTagDefs(state, tagDefs, suggestions = null) {
  const defs = new Map((tagDefs || []).map((t) => [t.key, defOf(t)]));
  const isNew = !state.original;
  if (state.selectMode === 'rules') {
    const byKey = new Map(state.rows.map((r) => [r.address, r]));
    const overrides = isObj(state.original?.source?.overrides) ? state.original.source.overrides : {};
    const rows = (tagDefs || []).map((t) => {
      const have = byKey.get(t.key);
      if (have) return { ...have, def: defs.get(t.key), defaultName: have.explicit ? defaultNameOf(state.srcType, t.key, defs.get(t.key)) : have.defaultName };
      return makeRow({ srcType: state.srcType, address: t.key, def: defs.get(t.key), stored: overrides[t.key] ?? null, suggestion: suggestions?.get(t.key), apply: isNew });
    });
    const known = new Set(rows.map((r) => r.address));
    const orphans = { ...state.orphans };
    for (const k of known) delete orphans[k];
    return { ...state, rows, orphans, tagsLoaded: true };
  }
  const rows = state.rows.map((r) => {
    const def = defs.get(r.address);
    if (!def) return r;
    const defaultName = defaultNameOf(state.srcType, r.address, def);
    const suggestion = suggestions?.get(r.address) || r.suggestion;
    let name = r.explicit ? r.name : defaultName;
    let explicit = r.explicit;
    let fromSuggestion = r.fromSuggestion;
    if (isNew && !r.explicit && suggestion?.suggestedName && suggestion.suggestedName !== defaultName) {
      name = suggestion.suggestedName;
      explicit = true;
      fromSuggestion = true;
    }
    return { ...r, def, defaultName, name, explicit, fromSuggestion, suggestion };
  });
  return { ...state, rows, tagsLoaded: true };
}

/** Switch list <-> rules. list -> rules: every device tag becomes a row; rules -> list: the matched rows. */
export function switchSelectMode(state, mode, tagDefs) {
  if (mode === state.selectMode || (mode === 'rules' && !supportsRules(state.srcType))) return state;
  if (mode === 'rules') {
    const byKey = new Map(state.rows.map((r) => [r.address, r]));
    const rows = (tagDefs || []).map((t) => {
      const have = byKey.get(t.key);
      return have ? { ...have, asObject: false } : makeRow({ srcType: state.srcType, address: t.key, def: defOf(t), apply: !state.original });
    });
    return { ...state, selectMode: 'rules', rows };
  }
  const rows = state.rows.filter((r) => rowVerdict(state, r).matched);
  return { ...state, selectMode: 'list', rows };
}

// ---- building the request ---------------------------------------------------------------------

function initialSource(state) {
  const r = state.ref;
  if (state.srcType === 'device') return { type: 'device', deviceId: r.deviceId };
  if (state.srcType === 'device-profile') return { type: 'device-profile', profileId: r.profileId };
  if (state.srcType === 'opcua') return { type: 'opcua', connectionId: r.connectionId };
  if (state.srcType === 'sparkplug') return { type: 'sparkplug', brokerId: r.brokerId, group: r.group, edge: r.edge, device: r.device ?? null };
  return { type: state.srcType };
}

export function buildSource(state) {
  const o = state.original?.source;
  const base = o ? { ...o } : initialSource(state);
  if (state.srcType === 'sparkplug') {
    if (!o || Array.isArray(o.metrics)) base.metrics = state.rows.filter((r) => r.enabled).map((r) => r.address);
    return base;
  }
  if (state.srcType === 'opcua') base.samplingInterval = Number(state.form.samplingInterval) || 1000;
  if (state.selectMode === 'rules') {
    base.tags = 'all';
    const sel = buildSelect(state.rules, state.rulesExtra);
    if (sel) base.select = sel;
    else if (state.hadSelect) base.select = {};
    else delete base.select;
    const ovs = { ...state.orphans };
    for (const r of state.rows) {
      // A suggested name on a tag the rules exclude is not worth storing.
      const ov = overrideOf(r.fromSuggestion && !rowVerdict(state, r).matched ? { ...r, explicit: false } : r);
      if (ov) ovs[r.address] = ov;
    }
    if (Object.keys(ovs).length) base.overrides = ovs;
    else delete base.overrides;
  } else {
    base.tags = state.rows.map(entryOf);
    delete base.select;
    if (Object.keys(state.orphans).length) base.overrides = state.orphans;
    else delete base.overrides;
  }
  return base;
}

/** The target, with context / contextMode / fields / metaFields on top of bindingForm.buildTarget. */
export function buildMappingTarget(state, devices = null) {
  const f = state.form;
  const t = buildTarget({ mode: state.mode, form: f, srcType: state.srcType, editing: state.original, devices });
  delete t.context;
  delete t.contextMode;
  delete t.fields;
  delete t.metaFields;
  const ctx = contextObject(f.context);
  if (ctx) t.context = ctx;
  if (f.contextModeStored || f.contextMode !== 'meta') t.contextMode = f.contextMode;
  if (state.mode === 'mqtt' && f.fields) t.fields = [...f.fields];
  if (f.metaFields) t.metaFields = [...f.metaFields];
  return t;
}

/** Whole request body (also the body of POST /api/tags/bindings/preview). */
export function buildMapping(state, { devices = null } = {}) {
  const b = state.original || {};
  const extra = {};
  for (const k of Object.keys(b)) if (!BINDING_OWNED.has(k)) extra[k] = b[k];
  const rbe = buildRbe(state.form);
  return {
    ...extra,
    ...(state.original ? { id: b.id, enabled: b.enabled !== false } : {}),
    name: String(state.name || '').trim() || null,
    source: buildSource(state),
    target: buildMappingTarget(state, devices),
    ...(rbe ? { rbe } : {})
  };
}

/** A preview body for one row only (the focused payload), same settings otherwise. */
export function focusDraft(state, row, devices = null) {
  if (!row || state.srcType === 'sparkplug' || state.srcType === 'mqtt') return null;
  const one = { ...state, selectMode: 'list', rows: [{ ...row, enabled: true, enabledKey: false }], orphans: {} };
  const b = buildMapping(one, { devices });
  // The focused draft is preview-only: never confuse collision checks with the stored mapping itself.
  return b;
}

// ---- bulk edits -------------------------------------------------------------------------------

const mapKeys = (rows, keys, fn) => {
  const set = keys instanceof Set ? keys : new Set(keys);
  return rows.map((r) => (set.has(r.key) ? fn(r) : r));
};

export const bulkEnable = (rows, keys, on) => mapKeys(rows, keys, (r) => ({ ...r, enabled: on }));
export const bulkSet = (rows, keys, field, value) => mapKeys(rows, keys, (r) => setOv(r, field, value));
export const bulkContextKey = (rows, keys, key, value) =>
  mapKeys(rows, keys, (r) => setOv(r, 'context', { ...(isObj(r.ov.context) ? r.ov.context : {}), [key]: value }));
export const bulkReset = (rows, keys) => mapKeys(rows, keys, (r) => ({ ...r, ov: {} }));

/** Words of a name: separators and camel/Pascal boundaries. */
export function words(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** camelCase exactly like the server's suggestions: "Motor_Speed" -> motorSpeed, "TT101_PV" -> tt101Pv. */
export function camelCase(s) {
  const parts = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return parts
    .map((w, i) => {
      const lower = /^[A-Z0-9]+$/.test(w) ? w.toLowerCase() : w;
      return i === 0 ? lower.charAt(0).toLowerCase() + lower.slice(1) : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export const snakeCase = (s) => words(s).map((w) => w.toLowerCase()).join('_');
export const stripPrefix = (s, prefix) => (prefix && String(s).toLowerCase().startsWith(String(prefix).toLowerCase()) ? String(s).slice(prefix.length) : String(s));

/** Apply a naming transform to the names of the given rows. kind: camel | snake | strip | replace. */
export function bulkRename(rows, keys, { kind, prefix = '', find = '', replace = '', regex = false, caseSensitive = false }) {
  let re = null;
  if (kind === 'replace') {
    if (!find) return rows;
    const src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch {
      return rows;
    }
  }
  return mapKeys(rows, keys, (r) => {
    let next = r.name;
    if (kind === 'camel') next = camelCase(r.name);
    else if (kind === 'snake') next = snakeCase(r.name);
    else if (kind === 'strip') next = stripPrefix(r.name, prefix);
    else if (kind === 'replace') next = r.name.replace(re, replace);
    return next && next !== r.name ? renameRow(r, next) : r;
  });
}

/** Copy the transferable settings of one row onto others (names are never copied). */
export function bulkCopy(rows, fromKey, keys) {
  const from = rows.find((r) => r.key === fromKey);
  if (!from) return rows;
  return mapKeys(rows, keys, (r) => {
    if (r.key === fromKey) return r;
    const ov = { ...r.ov };
    for (const k of COPY_KEYS) {
      if (from.ov[k] !== undefined) ov[k] = from.ov[k];
      else delete ov[k];
    }
    return { ...r, ov };
  });
}

/** Spreadsheet clipboard text -> rows of cells (tab separated, CRLF tolerant, trailing newline dropped). */
export function parseGrid(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

export const PASTE_COLUMNS = ['name', 'unit', 'description'];

/**
 * Paste a grid starting at (startKey, startCol) over `orderKeys` (the table order). Columns run
 * name -> unit -> description; extra cells are ignored. Returns { rows, count }.
 */
export function applyPaste(rows, orderKeys, startKey, startCol, grid) {
  const startRow = orderKeys.indexOf(startKey);
  const c0 = PASTE_COLUMNS.indexOf(startCol);
  if (startRow < 0 || c0 < 0) return { rows, count: 0 };
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let count = 0;
  grid.forEach((cells, i) => {
    const key = orderKeys[startRow + i];
    if (!key) return;
    let r = byKey.get(key);
    cells.forEach((cell, j) => {
      const col = PASTE_COLUMNS[c0 + j];
      if (!col) return;
      const v = cell.trim();
      if (col === 'name') r = v ? renameRow(r, v) : r;
      else r = setOv(r, col, v);
    });
    byKey.set(key, r);
    count += 1;
  });
  return { rows: rows.map((r) => byKey.get(r.key)), count };
}

// ---- topics & diff ------------------------------------------------------------------------------

/**
 * Value topics the mapping would publish, computed like the server (mqtt, topic-per-tag):
 * [{ key, address, name, topic, unit? }] per instance. Object layout: one topic per unit.
 */
export function computeTopics(state, { profile = null, devices = null } = {}) {
  if (state.mode !== 'mqtt' || state.srcType === 'mqtt') return [];
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
      out.push({ key: `__object__${b.unit || ''}`, address: null, name: null, topic, unit: b.unit, unitName: b.unitName, object: true, members: rows.map((r) => slug(r.name)) });
      continue;
    }
    for (const r of rows) {
      out.push({ key: r.key, address: r.address, name: r.name, topic: b.base ? `${b.base}/${slug(r.name)}` : targetTopic(b.template, r.name), unit: b.unit, unitName: b.unitName });
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

// ---- validation --------------------------------------------------------------------------------

const SP_PART = /^[^\s/+#]+$/;

function num(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Problems with one row's overrides -> [{ field, message }]. Mirrors the server's overrideError. */
export function rowErrors(row, schema = null) {
  const out = [];
  const lim = schema?.limits || {};
  const maxName = lim.maxNameLength || 128;
  const maxPrecision = lim.maxPrecision ?? 10;
  const o = row.ov;
  const name = String(row.name ?? '');
  if (row.enabled && !name.trim()) out.push({ field: 'name', message: 'Give this tag a published name.', required: true });
  if (name.length > maxName) out.push({ field: 'name', message: `Name is ${name.length} characters; at most ${maxName}.` });
  for (const [k, max, label] of [['displayName', 128, 'Display name'], ['description', 512, 'Description'], ['unit', 512, 'Unit']]) {
    if (typeof o[k] === 'string' && o[k].length > max) out.push({ field: k, message: `${label} is longer than ${max} characters.` });
  }
  if (o.range !== undefined) {
    const mn = num(o.range?.min);
    const mx = num(o.range?.max);
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) out.push({ field: 'range', message: 'Range needs a minimum and a maximum.' });
    else if (mn >= mx) out.push({ field: 'range', message: 'Range minimum must be below the maximum.' });
  }
  if (o.scale !== undefined && (!Number.isFinite(o.scale) || o.scale === 0)) out.push({ field: 'scale', message: 'Scale must be a number other than 0.' });
  if (o.offset !== undefined && !Number.isFinite(o.offset)) out.push({ field: 'offset', message: 'Offset must be a number.' });
  if (o.precision !== undefined && (!Number.isInteger(o.precision) || o.precision < 0 || o.precision > maxPrecision)) out.push({ field: 'precision', message: `Precision must be a whole number from 0 to ${maxPrecision}.` });
  if (o.limits !== undefined) {
    const seq = LIMIT_KEYS.filter((k) => o.limits[k] !== undefined);
    if (seq.some((k) => !Number.isFinite(o.limits[k]))) out.push({ field: 'limits', message: 'Limits must be numbers.' });
    else {
      for (let i = 1; i < seq.length; i++) {
        if (o.limits[seq[i - 1]] > o.limits[seq[i]]) {
          out.push({ field: 'limits', message: `Limits must be ordered lolo ≤ lo ≤ hi ≤ hihi (${seq[i - 1]} ${o.limits[seq[i - 1]]} is above ${seq[i]} ${o.limits[seq[i]]}).` });
          break;
        }
      }
    }
  }
  if (o.states !== undefined) {
    const entries = Object.entries(o.states || {});
    if (entries.length > (lim.maxStates || 256)) out.push({ field: 'states', message: `At most ${lim.maxStates || 256} states.` });
    if (entries.some(([k, v]) => !k || !String(v ?? '').trim())) out.push({ field: 'states', message: 'Every state needs a raw value and a label.' });
  }
  if (o.deadband !== undefined) {
    const v = typeof o.deadband === 'number' ? o.deadband : Number(o.deadband?.value);
    if (!Number.isFinite(v) || v < 0) out.push({ field: 'deadband', message: 'Deadband must be a number of 0 or more.' });
    else if (o.deadband?.type === 'percent' && v > 100) out.push({ field: 'deadband', message: 'A percent deadband must be between 0 and 100.' });
  }
  if (o.context !== undefined) {
    const e = contextErrors(contextRows(o.context), schema);
    if (e.length) out.push({ field: 'context', message: e[0].message });
  }
  return out;
}

/** Problems with a context editor list -> [{ id?, message }]. */
export function contextErrors(rows, schema = null, { allowed = null } = {}) {
  const lim = schema?.limits || {};
  const re = new RegExp(lim.contextKeyPattern || '^[A-Za-z][A-Za-z0-9_.-]{0,63}$');
  const maxKeys = lim.maxContextKeys || 32;
  const maxVal = lim.maxContextValueLength || 256;
  const maxBytes = lim.maxContextBytes || 4096;
  const out = [];
  const seen = new Set();
  const used = (rows || []).filter((r) => String(r.key).trim() || String(r.value).trim());
  if (used.length > maxKeys) out.push({ message: `${used.length} keys; at most ${maxKeys} are allowed.` });
  for (const r of used) {
    const k = String(r.key).trim();
    if (!k) out.push({ id: r.id, field: 'key', message: 'Give this value a key.' });
    else if (!re.test(k)) out.push({ id: r.id, field: 'key', message: `"${k}" is not a valid key: start with a letter, then letters, digits, _ . or - (at most 64).` });
    else if (seen.has(k)) out.push({ id: r.id, field: 'key', message: `Key "${k}" is used twice.` });
    seen.add(k);
    if (r.type === 'number' && !Number.isFinite(Number(r.value))) out.push({ id: r.id, field: 'value', message: `${k || 'Value'}: not a number.` });
    if (r.type === 'string' && String(r.value).length > maxVal) out.push({ id: r.id, field: 'value', message: `${k}: ${String(r.value).length} characters; at most ${maxVal}.` });
    if (allowed && r.type === 'string') {
      for (const m of String(r.value).matchAll(/\{(param:)?([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)) {
        const token = `{${m[1] ? 'param:' : ''}${m[2]}}`;
        if (!allowed.includes(token)) out.push({ id: r.id, field: 'value', message: `${k}: unknown placeholder ${token}${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (this source takes no placeholders)'}.` });
      }
    }
  }
  const obj = contextObject(rows);
  const bytes = obj ? new TextEncoder().encode(JSON.stringify(obj)).length : 0;
  if (bytes > maxBytes) out.push({ message: `Context is ${bytes} bytes as JSON; at most ${maxBytes}.` });
  return out;
}

/** Placeholders a context may use for this source: schema tokens with {param:<name>} expanded for the profile. */
export function contextPlaceholders(schema, srcType, profile = null) {
  const list = schema?.placeholders?.[srcType] || [];
  return list.flatMap((p) => (p === '{param:<name>}' ? (profile?.params || []).map((x) => `{param:${x.name}}`) : [p]));
}

/**
 * Every problem -> [{ section, message, rowKey?, field?, required? }]. Sections: setup, what, where,
 * tags, context, payload, delivery, server. `required` problems are shown only after a save attempt.
 */
export function validateMapping(state, { brokers = [], profile = null, devices = null, preview = null, schema = null } = {}) {
  const errors = [];
  const add = (section, message, extra = {}) => errors.push({ section, message, ...extra });
  const f = state.form;
  const isProfile = state.srcType === 'device-profile';

  if (!brokers.length) add('setup', 'No connected broker. Connect one under Brokers first.');
  else if (!f.brokerId) add('setup', 'Choose a target broker.', { field: 'broker', required: true });
  if (isProfile && !profile) add('what', 'Choose a device profile.', { required: true });

  const pub = publishingRows(state);
  if (state.selectMode === 'list' && !state.rows.length && !(state.srcType === 'sparkplug' && state.original && !state.original.source.metrics)) {
    add('what', isProfile ? 'Add at least one profile tag.' : 'Add at least one tag.', { required: true });
  }

  if (state.srcType === 'mqtt') {
    const t = String(f.pathTemplate || '');
    if (!t.trim()) add('where', 'Enter a base path, for example site/area/line.', { field: 'base', required: true });
  } else if (state.mode === 'mqtt') {
    if (isProfile) {
      const hasMap = Object.values(f.assetPaths || {}).some((p) => String(p).trim());
      if (f.assetPathTemplate.trim() || !hasMap) {
        const err = validateAssetTemplate(f.assetPathTemplate, pathPlaceholders(profile));
        if (err) add('where', err, { field: 'dest', required: !f.assetPathTemplate.trim() });
      }
      if (f.assetPathTemplate.trim()) for (const r of instanceRows({ profile, devices, template: f.assetPathTemplate, overrides: f.assetPaths })) if (r.error) add('where', r.error, { field: 'dest' });
    } else if (f.destKind === 'asset') {
      const p = normalizeAssetPath(f.assetPath);
      const err = validateAssetPath(p);
      if (err) add('where', err, { field: 'dest', required: !p });
    } else if (!String(f.pathTemplate || '').trim()) add('where', 'Enter a path template.', { field: 'dest', required: true });
    if (f.layout === 'object-per-asset' && f.maxObjectBytes !== '') {
      const n = Number(f.maxObjectBytes);
      const lim = schema?.limits?.maxObjectBytes || { min: 1024, max: 1048576 };
      if (!Number.isInteger(n) || n < lim.min || n > lim.max) add('delivery', `Maximum object size must be a whole number from ${lim.min} to ${lim.max} bytes.`, { field: 'maxObjectBytes' });
    }
  } else {
    for (const [label, key] of [['Group', 'group'], ['Edge node', 'edge'], ['Device', 'device']]) {
      const v = String(f[key] ?? '').trim();
      if (!v) add('where', `${label} is required.`, { field: key, required: true });
      else if (!SP_PART.test(v)) add('where', `${label} cannot contain spaces, /, + or #.`, { field: key });
    }
  }

  // Names: per row, then duplicates after slugging.
  if (renameable(state.srcType)) {
    const seen = new Map();
    for (const r of state.rows) {
      for (const e of rowErrors(r, schema)) add('tags', e.message, { rowKey: r.key, field: e.field, required: e.required });
    }
    for (const r of pub) {
      const s = slug(r.name).toLowerCase();
      if (!s) continue;
      if (seen.has(s)) add('tags', `"${r.name}" is used by two tags (${seen.get(s)} and ${r.address}). Names must be unique.`, { rowKey: r.key, field: 'name' });
      else seen.set(s, r.address);
    }
  }

  // Asset context.
  if (state.srcType !== 'mqtt') {
    const allowed = contextPlaceholders(schema, state.srcType, profile);
    for (const e of contextErrors(f.context, schema, { allowed })) add('context', e.message, { field: e.id ? `ctx:${e.id}:${e.field}` : 'context' });
  }
  if (state.mode === 'mqtt' && f.fields) {
    if (!f.fields.includes('v')) add('payload', 'The value (v) must be published.', { field: 'fields' });
    if (f.fields.includes('ctx') && f.contextMode === 'none') add('payload', 'Context is switched off, so the ctx field cannot be published.', { field: 'fields' });
  }

  if (state.srcType !== 'mqtt') {
    if (f.dbValue !== '') {
      const v = Number(f.dbValue);
      if (!(v >= 0)) add('delivery', 'Deadband must be a number of 0 or more.', { field: 'deadband' });
      else if (f.dbType === 'percent' && v > 100) add('delivery', 'A percent deadband must be between 0 and 100.', { field: 'deadband' });
    }
    if (f.heartbeatMs !== '' && !(Number.isInteger(Number(f.heartbeatMs)) && Number(f.heartbeatMs) >= 0)) add('delivery', 'Heartbeat must be a whole number of milliseconds (0 = off).', { field: 'heartbeat' });
    else if (Number(f.heartbeatMs) > 0 && Number(f.heartbeatMs) < 1000) add('delivery', 'Heartbeat below 1000 ms floods the broker. Use 1000 or more, or 0 to turn it off.', { field: 'heartbeat' });
  }
  if (state.srcType === 'opcua' && !(Number(f.samplingInterval) >= 50)) add('delivery', 'Sampling interval must be at least 50 ms.', { field: 'sampling' });

  // The server's verdict: a rejection and topics another mapping already publishes block saving.
  const data = preview?.status === 'ok' ? preview.data : null;
  if (data && data.valid === false) add('server', data.error || 'The server rejected this mapping.', { rowKey: rowKeyFromMessage(state, data.error) });
  if (data && data.valid) {
    const topics = computeTopics(state, { profile, devices });
    const byTopic = new Map(topics.map((t) => [t.topic, t]));
    const seenTopics = new Set();
    const collisions = [...(data.warnings || []).filter((w) => w.type === 'collision').map((w) => ({ topic: w.topic, bindings: w.bindings })), ...(data.tags || []).filter((t) => t.collisions?.length).map((t) => ({ topic: t.topic, bindings: t.collisions })), ...(data.objects || []).filter((o) => o.collisions?.length).map((o) => ({ topic: o.topic, bindings: o.collisions }))];
    for (const c of collisions) {
      if (seenTopics.has(c.topic)) continue;
      seenTopics.add(c.topic);
      const owner = (c.bindings || []).map((b) => b.name || b.id).join(', ');
      add('server', `${c.topic} is already published by ${owner}.`, { rowKey: byTopic.get(c.topic)?.key || null, collision: true, topic: c.topic, owner });
    }
  }
  return errors;
}

/** Row a server message names (`tag "x"` / `source.overrides["x"]`), if any. */
export function rowKeyFromMessage(state, message) {
  const m = /tag "([^"]+)"|overrides\["([^"]+)"\]/.exec(String(message || ''));
  const addr = m && (m[1] || m[2]);
  return addr && state.rows.some((r) => r.key === addr) ? addr : null;
}

/** Errors to show: required-field problems only after the user tried to save. */
export const visibleErrors = (errors, attempted) => errors.filter((e) => attempted || !e.required);

/** Is the name a raw device address (client side check, the server's list is wider)? */
export const rawName = (name) => looksLikeRawAddress(slug(name));

/** MQTT-topic sources compile to a pipeline route: each topic's tail is re-pathed under the base. */
export function mqttSourceTopics(rows, pathTemplate) {
  const base = String(pathTemplate || '').replace(/\/?\{name\}$/, '').replace(/\/+$/, '') || 'uns/imported';
  const addrs = rows.map((r) => r.address);
  const prefix = addrs.length === 1 ? addrs[0].split('/').slice(0, -1).join('/') + (addrs[0].includes('/') ? '/' : '') : commonPrefix(addrs);
  return {
    base,
    prefix,
    rows: rows.map((r) => {
      const tail = r.address.slice(prefix.length) || r.address.split('/').pop();
      return { ...r, tail, topic: `${base}/${tail}` };
    })
  };
}

/** POST /api/pipelines body for an MQTT-topic mapping (a pipeline route, not a binding). */
export function pipelineFor(state, sourceId) {
  const rows = state.rows.filter((r) => r.enabled);
  const m = mqttSourceTopics(rows, state.form.pathTemplate);
  const segCount = m.prefix ? m.prefix.split('/').filter(Boolean).length : 0;
  return {
    name: String(state.name || '').trim() || `tags -> ${m.base}`,
    source: { brokerId: sourceId, filter: rows.length === 1 ? rows[0].address : `${m.prefix}#` },
    transforms: [{ type: 'repath', to: `${m.base}/{${segCount + 1}-}` }, ...(state.form.format === 'envelope' ? [{ type: 'envelope' }] : [])],
    target: { type: 'mqtt', brokerId: state.form.brokerId, retain: state.form.retain, qos: Number(state.form.qos) || 0 }
  };
}
