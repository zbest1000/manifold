// Pure state model of the mapping editor (no React). A mapping is a stored binding
// (POST /api/tags/bindings). The editor keeps:
//
//   state = {
//     original,                 stored binding being edited, or null
//     name, mode,               'mqtt' | 'sparkplug'
//     srcType, ref,             source type and its id fields (deviceId, connectionId, profileId, broker/group/edge/device,
//                               filter for an MQTT-topic source with tags: "all")
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
import {
  OV_KEYS, defOf, defaultNameOf, makeRow, entryOf, overrideOf, supportsRules, rowVerdict, buildSelect, EMPTY_RULES, contextRows, contextObject
} from './mappingRows';
import { mqttNames, defaultFilter, mqttSourceKeys } from './mqttModel';

export * from './mqttModel';

export * from './mappingRows';
export * from './mappingBulk';
export * from './mappingTopics';
export * from './mappingValidate';

const SELECT_KEYS = ['include', 'exclude', 'pollGroups', 'types', 'withProperty'];
const BINDING_OWNED = new Set(['id', 'name', 'enabled', 'source', 'target', 'rbe', 'warnings']);
const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);

// ---- state ------------------------------------------------------------------------------------

function formFor(b, { brokers, srcType }) {
  const t = b?.target || {};
  return {
    ...formFromBinding(b, { brokers, srcType }),
    context: contextRows(t.context),
    contextMode: t.contextMode || 'meta',
    contextModeStored: Object.hasOwn(t, 'contextMode'),
    fields: Array.isArray(t.fields) ? [...t.fields] : null,
    metaFields: Array.isArray(t.metaFields) ? [...t.metaFields] : null,
    // MQTT-topic source: default payload field and staleness limit (source level).
    srcField: typeof b?.source?.field === 'string' ? b.source.field : '',
    staleAfterMs: b?.source?.staleAfterMs !== undefined && b?.source?.staleAfterMs !== null ? String(b.source.staleAfterMs) : ''
  };
}

const refOf = (src = {}) => {
  const out = {};
  for (const k of ['deviceId', 'connectionId', 'profileId', 'brokerId', 'group', 'edge', 'device', 'filter']) if (src[k] !== undefined) out[k] = src[k];
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
    tagsLoaded: srcType === 'sparkplug' || srcType === 'opcua' || (srcType === 'mqtt' && !rules) || tagDefs !== null,
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
  } else if (srcType === 'mqtt') {
    const names = mqttNames((picked || []).map((p) => p.address));
    rows = (picked || []).map((p) => makeRow({ srcType, address: p.address, def: defOf(p.meta || {}), stored: { address: p.address, name: names.get(p.address) } }));
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
    const ref = state.srcType === 'mqtt' && !state.ref.filter ? { ...state.ref, filter: defaultFilter(state.rows.map((r) => r.address)) } : state.ref;
    return { ...state, selectMode: 'rules', rows, ref, tagsLoaded: tagDefs !== null };
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
  if (state.srcType === 'mqtt') return { type: 'mqtt', brokerId: r.brokerId };
  if (state.srcType === 'iot') return { type: 'iot', brokerId: r.brokerId, deviceId: r.deviceId };
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
  if (state.srcType === 'mqtt') mqttSourceKeys(base, state);
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
  if (!row || state.srcType === 'sparkplug') return null;
  // Keep what the full draft inherits for this row (list-mode source.overrides), nothing else.
  const inherited = state.selectMode === 'list' && state.orphans[row.address] ? { [row.address]: state.orphans[row.address] } : {};
  const one = { ...state, selectMode: 'list', rows: [{ ...row, enabled: true, enabledKey: false }], orphans: inherited };
  const b = buildMapping(one, { devices });
  // The focused draft is preview-only: never confuse collision checks with the stored mapping itself.
  return b;
}
