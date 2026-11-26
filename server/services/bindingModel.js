'use strict';

const profilesModel = require('./deviceProfiles');
const { looksLikeRawAddress } = require('./unsLint');
const cx = require('./bindingContext');
const mq = require('./bindingMqtt');

/**
 * Binding model - the pure half of tag bindings (ARCHITECTURE.md, Bindings;
 * docs/wiki/Mapping-to-the-UNS.md): validation, expansion of a binding into publishing UNITS, topic
 * resolution, payload shapes, the `_meta` document, the retained-topic set a
 * binding owns, save-time warnings and the preview. No I/O; TagBindings
 * (./tagBindings.js) runs the hot path on top of it.
 *
 * A UNIT is one (source, asset) pair: a plain binding is one unit (id =
 * binding id); a `device-profile` binding is one unit per instance of the
 * profile (id = `<bindingId>#<deviceId>`), which is how one binding definition
 * maps fifty identical devices and picks up instances added later.
 *
 * Destination
 *   target.assetPath          ISA-95 path, no placeholders: topic = <assetPath>/<property>
 *   target.pathTemplate       legacy: 'site/area/{name}' ({name} = property), still supported
 *   target.assetPaths         device-profile only: { <deviceId>: <assetPath> } (wins)
 *   target.assetPathTemplate  device-profile only: 'acme/{site}/{device}' where {device} is
 *                             the slugged device name, {deviceId} its id, and any other
 *                             {param} one of the profile's params for that instance
 *   Asset paths: '/'-separated, no empty segments, no '+' or '#', no segment
 *   starting with '$', no braces.
 *
 * Published names: device tags publish under the binding entry's explicit
 * `name` when it has one (unchanged behaviour for stored bindings), otherwise
 * the tag's `property`, otherwise its key. Raw device addresses are never
 * proposed as names; lint flags names that look like one.
 *
 * Payloads (mqtt)
 *   topic-per-tag, plain     the bare value
 *   topic-per-tag, envelope  { v, t, q } plus u (engineering unit) when the tag has one
 *   object-per-asset         ONE retained-or-not JSON object per asset per source batch,
 *                            published to the asset path itself:
 *                              { t: <newest sample ms>, values: { <property>: { v, q, u? } } }
 *                            Always carries quality (both formats). Report-by-exception at
 *                            object level: published when any member's value or quality
 *                            changed (per-member deadband applies), plus the heartbeat.
 *                            Capped at target.maxObjectBytes (default 64 KB, max 1 MB); a
 *                            binding whose tag count x worst-case member size exceeds the
 *                            cap is rejected at save time.
 *   <asset>/_status          retained { online, since, reason }   (target.statusTopic: false opts out)
 *   <asset>/_meta            retained { properties: { <name>: { type, unit, description, range,
 *                            source: { deviceId | connectionId, address } } }, updatedAt }
 *                            (target.metaTopic: false opts out)
 *
 * Report by exception: rbe.deadband = { type: 'absolute' | 'percent', value }
 * (legacy numeric target.deadband = absolute). Percent is of the tag's
 * engineering range (max - min) when the tag defines `range`, otherwise of the
 * magnitude of the LAST PUBLISHED value (so 0 -> any change publishes).
 * Non-numeric values publish on change.
 *
 * Direct historian target (opt-in): target.historian = { historianId } enqueues
 * every published sample (after RBE, including the Bad sample on disconnect,
 * excluding heartbeat repeats of an already-written TVQ) to the
 * store-and-forward outbox as { tag: <resolved topic>, ts, value, quality }.
 * Only Timebase and TimescaleDB historians are accepted; InfluxDB is excluded
 * by project decision because it drops quality.
 *
 * Choosing what to map and adding context (all optional, defaults keep the
 * behaviour above byte for byte; helpers in ./bindingContext.js):
 *   source.tags[i]      { address, name?, enabled? (default true), ...overrides }; a
 *                       disabled entry is kept but not monitored/published/listed/retained
 *   source.select       rules for tags: 'all' (device, device-profile):
 *                       { include?, exclude?, pollGroups?, types?, withProperty? }
 *   source.overrides    { <tagKey>: overrides } for rule-selected (or listed) tags
 *   overrides           name displayName description unit range dataType scale offset
 *                       precision states statesMode limits deadband context enabled;
 *                       each falls back to the device tag definition (context merges,
 *                       mapping wins key by key; entry wins over source.overrides)
 *   target.fields       envelope / object-member field list (v t q u name src ctx)
 *   target.metaFields   _meta fields (type unit description range source context
 *                       displayName limits states), default all
 *   target.context      asset context with {device} {deviceId} {protocol} {host} {param:x}
 *   target.contextMode  'meta' (default) | 'payload' (also `ctx` in payloads) | 'none'
 */

const DEFAULT_OBJECT_CAP = 64 * 1024;
const MIN_OBJECT_CAP = 1024;
const MAX_OBJECT_CAP = 1024 * 1024;
const OBJECT_ENVELOPE_BYTES = 48; // {"t":1730000000000,"values":{}} + slack
const UNKNOWN_VALUE_BYTES = 128;
const STRING_VALUE_BYTES = 256;
const HISTORIAN_TYPES = new Set(['timebase', 'timescaledb']);
const SOURCE_TYPES = ['opcua', 'sparkplug', 'device', 'device-profile', 'mqtt', 'iot'];
const META_FIELDS = ['type', 'unit', 'description', 'range'];
const MAX_WARNINGS = 50;
const PREVIEW_MAX_TAGS = 50;
const PREVIEW_HARD_MAX = 2000;

class BindingValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BindingValidationError';
    this.details = details;
  }
}

function slug(name) {
  return String(name).trim().replace(/[\s/+#]+/g, '_');
}

/**
 * Observed topics for filter-mode MQTT sources: the runtime (and the routes) attach a resolver to
 * the profile store, `(brokerId, filter, limit) -> [topic]`, so every caller of expandUnits (save,
 * preview, warnings, the compiled index) sees the same topic set without a signature change.
 */
const topicResolvers = new WeakMap();
function attachTopicSource(profiles, resolve) {
  if (profiles && typeof profiles === 'object') topicResolvers.set(profiles, resolve);
}
function observedTopics(profiles, brokerId, filter) {
  const fn = profiles && topicResolvers.get(profiles);
  if (!fn || !brokerId || !filter) return [];
  try {
    return (fn(brokerId, filter, mq.MAX_FILTER_TOPICS) || []).slice(0, mq.MAX_FILTER_TOPICS);
  } catch {
    return [];
  }
}

/**
 * Server-side metadata of OPC UA nodes (EngineeringUnits, EURange, DataType, Description), read by
 * the runtime once per (re)connect: `(connectionId, nodeId) -> { type, unit, range: {min,max},
 * description } | null`. Attached to the profile store like the topic source, so the compiled
 * index and the preview see the same values. It is the LOWEST layer: mapping settings win.
 */
const serverMetaResolvers = new WeakMap();
function attachServerMeta(profiles, resolve) {
  if (profiles && typeof profiles === 'object') serverMetaResolvers.set(profiles, resolve);
}
function serverMetaOf(profiles, connectionId, nodeId) {
  const fn = profiles && serverMetaResolvers.get(profiles);
  if (!fn || !connectionId) return null;
  try {
    return fn(connectionId, nodeId) || null;
  } catch {
    return null;
  }
}

/**
 * IoT-over-MQTT devices (./iot/iotManager.js): the runtime attaches the device registry to the
 * profile store, { device(brokerId, deviceId) -> registry device | null, readFilters(brokerId) ->
 * [filter] }, so expandUnits / validation see the tags the conventions derived (name, type, unit,
 * range, description) without a signature change. Registry metadata is the device layer: mapping
 * settings win.
 */
const iotResolvers = new WeakMap();
function attachIotSource(profiles, resolver) {
  if (profiles && typeof profiles === 'object') iotResolvers.set(profiles, resolver);
}
function iotDeviceOf(profiles, brokerId, deviceId) {
  const r = profiles && iotResolvers.get(profiles);
  if (!r || !brokerId || !deviceId) return null;
  try {
    return r.device(brokerId, deviceId) || null;
  } catch {
    return null;
  }
}
function iotReadFilters(profiles, brokerId) {
  const r = profiles && iotResolvers.get(profiles);
  try {
    return (r?.readFilters?.(brokerId) || []).map(String);
  } catch {
    return [];
  }
}
/** Registry tag -> the device-tag shape buildTag / selection rules read. */
function iotTagDef(t) {
  const d = { key: t.key, property: t.name, type: t.type && t.type !== 'unknown' ? t.type : undefined };
  if (t.unit) d.unit = t.unit;
  if (t.description) d.description = t.description;
  if (t.range && Number.isFinite(t.range.min) && Number.isFinite(t.range.max)) d.range = { min: t.range.min, max: t.range.max };
  return d;
}
const iotSourceId = (src) => `${src.brokerId}|${src.deviceId}`;

/** The key a tag publishes under (topic level, object member, _meta property). MQTT sources keep levels. */
const nameKey = (unit, name) => (unit?.sourceType === 'mqtt' ? mq.slugPath(name) : slug(name));

function targetTopic(template, tagName) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, slug(tagName)) : `${t.replace(/\/+$/, '')}/${slug(tagName)}`;
}

/** Retained device-status topic: `{name}` -> `_status`, else `<template>/_status`. */
function statusTopic(template) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, '_status') : `${t.replace(/\/+$/, '')}/_status`;
}

function metaTopicFromTemplate(template) {
  const t = String(template || 'uns/{name}');
  return t.includes('{name}') ? t.replace(/\{name\}/g, '_meta') : `${t.replace(/\/+$/, '')}/_meta`;
}

/** The asset (object) topic of a legacy template: the template with its {name} segment removed. */
function assetFromTemplate(template) {
  const t = String(template || 'uns/{name}');
  return t
    .split('/')
    .filter((seg) => seg !== '{name}')
    .join('/')
    .replace(/\{name\}/g, '')
    .replace(/\/+$/, '');
}

/** Validate an ISA-95 asset path -> error string or null. */
function validateAssetPath(p, what = 'assetPath') {
  if (typeof p !== 'string' || !p.trim()) return `${what} must be a non-empty string`;
  if (p.length > 512) return `${what} is longer than 512 characters`;
  if (/[{}]/.test(p)) return `${what} must not contain placeholders`;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(p)) return `${what} must not contain control characters`;
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '') return `${what} "${p}" has an empty segment (leading, trailing or double "/")`;
    if (seg.includes('+') || seg.includes('#')) return `${what} "${p}" contains an MQTT wildcard (+ or #)`;
    if (seg.startsWith('$')) return `${what} "${p}" has a segment starting with "$" (reserved for broker topics)`;
  }
  return null;
}

/** Source tag entries: strings or { address, name? , unit?, ... } -> [{ address, name?, ... }]; 'all' passes through. */
function tagEntries(source) {
  if (source?.tags === 'all') return 'all';
  return (Array.isArray(source?.tags) ? source.tags : [])
    .map((t) => (typeof t === 'string' ? { address: t } : t && typeof t === 'object' ? t : null))
    .filter((t) => t && t.address !== undefined && t.address !== null && t.address !== '');
}

function pickMeta(...objs) {
  const out = {};
  for (const o of objs) {
    if (!o) continue;
    for (const f of META_FIELDS) if (o[f] !== undefined && o[f] !== null && o[f] !== '') out[f] = o[f];
  }
  return out;
}

const sourceIdOf = (b) => b.source.connectionId ?? b.source.deviceId;

function effectiveOf(profiles, deviceId) {
  const d = profiles.getIn('devices', deviceId);
  if (!d) return null;
  const profile = d.profileId ? profiles.getIn('deviceProfiles', d.profileId) : null;
  return profilesModel.effectiveDevice(d, profile).device;
}

function deadbandOf(b) {
  const db = b?.rbe?.deadband;
  if (db && typeof db === 'object' && Number(db.value) > 0) {
    return { type: db.type === 'percent' ? 'percent' : 'absolute', value: Number(db.value) };
  }
  const legacy = Number(b?.target?.deadband);
  return legacy > 0 ? { type: 'absolute', value: legacy } : null;
}

/** True when a numeric change is inside the deadband (i.e. suppressed). */
function withinDeadband(db, v, prev, range) {
  if (!db || typeof v !== 'number' || typeof prev !== 'number') return false;
  let band = db.value;
  if (db.type === 'percent') {
    const span = range && Number.isFinite(Number(range.max)) && Number.isFinite(Number(range.min)) ? Number(range.max) - Number(range.min) : null;
    band = (db.value / 100) * (span !== null && span > 0 ? span : Math.abs(prev));
  }
  return Math.abs(v - prev) < band;
}

function substituteVars(template, vars) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => {
    if (!Object.hasOwn(vars, n)) throw new Error(`unknown placeholder {${n}}`);
    return slug(vars[n]);
  });
}

const contextModeOf = (b) => (cx.CONTEXT_MODES.includes(b?.target?.contextMode) ? b.target.contextMode : 'meta');
const hasVal = (x) => x !== undefined && x !== null && x !== '';
const overridesOf = (src) => (cx.isPlainObject(src?.overrides) ? src.overrides : null);

/**
 * One unit tag: { address, name, meta } exactly as before, plus - only when
 * configured - displayName, limits, states/statesMode/labels, transform/plan/
 * outType, precision, deadband, context (tag level, device merged with
 * mapping) and ctx (asset + tag context, frozen; absent with contextMode
 * 'none'). `dt` is the device tag definition (null for OPC UA entries), `e`
 * the binding entry, `ov` source.overrides[key]. Mapping beats device.
 */
function buildTag(address, dt, e, ov, unit, details, sm = null) {
  const ent = e || {};
  const mv = (k) => (hasVal(ent[k]) ? ent[k] : ov && hasVal(ov[k]) ? ov[k] : undefined);
  const dv = (k) => (dt && cx.validDeviceField(k, dt[k]) ? dt[k] : undefined);
  // `sm`: what the OPC UA server says about the node, below the device and the mapping.
  const tag = { address, name: ent.name || ov?.name || dt?.property || address, meta: pickMeta(sm, dt, ov, ent) };

  const displayName = mv('displayName') ?? dv('displayName');
  const limits = mv('limits') ?? dv('limits');
  const states = mv('states') ?? dv('states');
  const dataType = mv('dataType');
  const scale = mv('scale');
  const offset = mv('offset');
  const precision = mv('precision');
  const deadband = cx.normDeadband(ent.deadband ?? ov?.deadband);
  const devCtx = dt ? cx.sanitizeDeviceContext(dt.context).context : null;
  const mapCtx = cx.isPlainObject(ov?.context) || cx.isPlainObject(ent.context) ? { ...(ov?.context || {}), ...(ent.context || {}) } : null;
  const tagCtx = devCtx || (mapCtx && Object.keys(mapCtx).length) ? { ...(devCtx || {}), ...(mapCtx || {}) } : null;

  if (displayName !== undefined) tag.displayName = displayName;
  if (limits !== undefined) tag.limits = limits;
  if (states !== undefined) {
    tag.states = states;
    tag.statesMode = mv('statesMode') || 'label-field';
    tag.labels = new Map(Object.entries(states));
  }
  const plan = cx.transformPlan({ scale, offset, dataType });
  if (plan) {
    tag.plan = plan;
    tag.transform = {
      ...(plan.linear ? { scale: plan.scale, offset: plan.offset } : {}),
      ...(dataType ? { dataType } : {})
    };
    tag.outType = dataType ? cx.OUT_TYPES[dataType] : 'float64';
  }
  if (tag.states && tag.statesMode === 'replace') tag.outType = 'string';
  if (precision !== undefined) tag.precision = precision;
  if (deadband !== undefined) tag.deadband = deadband;
  if (tagCtx) tag.context = Object.freeze(tagCtx);
  if (unit.sourceType === 'mqtt') {
    const src = unit.binding.source || {};
    if (!hasVal(ent.name) && !hasVal(ov?.name)) tag.name = mq.topicName(address, unit.mqtt?.prefixLen ?? null);
    const field = ent.field ?? ov?.field ?? src.field;
    if (field) tag.field = field;
    const stale = Number(ent.staleAfterMs ?? ov?.staleAfterMs ?? src.staleAfterMs);
    if (stale > 0) tag.staleAfterMs = stale;
  }
  if (unit.ctxMode !== 'none' && (unit.assetContext || tag.context)) tag.ctx = Object.freeze({ ...(unit.assetContext || {}), ...(tag.context || {}) });

  if (details) {
    const o = { name: hasVal(ent.name) || hasVal(ov?.name) ? 'mapping' : dt?.property ? 'device' : 'default' };
    for (const f of ['type', 'unit', 'description', 'range']) o[f] = hasVal(ent[f]) || hasVal(ov?.[f]) ? 'mapping' : hasVal(dt?.[f]) ? 'device' : hasVal(sm?.[f]) ? 'server' : 'default';
    for (const f of ['displayName', 'limits', 'states']) o[f] = mv(f) !== undefined ? 'mapping' : dv(f) !== undefined ? 'device' : 'default';
    for (const f of ['statesMode', 'dataType', 'scale', 'offset', 'precision', 'deadband']) o[f] = mv(f) !== undefined ? 'mapping' : 'default';
    o.context = mapCtx && Object.keys(mapCtx).length ? 'mapping' : devCtx ? 'device' : 'default';
    tag.origins = o;
    const co = {};
    for (const k of Object.keys(unit.assetContext || {})) co[k] = 'asset';
    for (const k of Object.keys(devCtx || {})) co[k] = 'device';
    for (const k of Object.keys(mapCtx || {})) co[k] = 'mapping';
    tag.contextOrigins = co;
  }
  return tag;
}

/** Resolve the asset context of a unit (throws naming the key on a missing placeholder value). */
function assignAssetContext(unit, target, vars) {
  unit.ctxMode = contextModeOf(unit.binding);
  unit.assetContext = null;
  if (unit.ctxMode === 'none' || !cx.isPlainObject(target.context)) return;
  unit.assetContext = cx.resolveContext(target.context, vars);
}

/**
 * Expand a binding into units:
 *   { id, binding, sourceType, sourceId, deviceId?, base, template, spDevice,
 *     assetContext, ctxMode, tags: [{ address, name, meta, ... }], error? }
 * `base` is the asset path (null for a legacy template unit). Units with an
 * `error` (unresolvable asset path or context placeholder) are skipped by the
 * runtime and reported.
 * opts.selection: an array that receives one row per candidate tag
 *   { unitId, key, property, matched, rule?, pattern? } (preview);
 * opts.details: add origins/contextOrigins to each tag (preview).
 */
function expandUnits(b, profiles, opts = {}) {
  const src = b?.source || {};
  const target = b?.target || {};
  const spDefault = target.device || slug(b.name || b.id);
  const overrides = overridesOf(src);
  const sel = opts.selection;
  const details = Boolean(opts.details);
  const ruleSet = tagEntries(src) === 'all' ? cx.compileSelect(src.select) : null;
  /** enabled + rules -> keep? (records a selection row when asked) */
  const keep = (unit, key, tag, e, isAll) => {
    const ov = overrides?.[key];
    const row = sel ? { unitId: unit.id, key, property: tag?.property || null } : null;
    let verdict = { matched: true };
    if (!tag && isAll) verdict = { matched: false, rule: 'missing' };
    else if ((e.enabled ?? ov?.enabled) === false) verdict = { matched: false, rule: 'disabled' };
    else if (isAll && ruleSet) verdict = cx.selectTag(ruleSet, tag);
    if (row && !tag && unit.sourceType === 'device') row.missing = true; // a listed key the device no longer has
    if (row) sel.push({ ...row, ...verdict });
    return verdict.matched;
  };
  if (src.type === 'device-profile') {
    const profile = profiles.getIn('deviceProfiles', src.profileId);
    if (!profile) return [];
    const entries = tagEntries(src);
    const units = [];
    const devices = profiles
      .listIn('devices')
      .filter((d) => d.profileId === src.profileId)
      .sort((a, c) => String(a.id).localeCompare(String(c.id)));
    for (const d of devices) {
      const eff = profilesModel.effectiveDevice(d, profile).device;
      const values = eff.paramValues || {};
      const vars = { ...values, device: d.name || d.id, deviceId: d.id };
      const unit = { id: `${b.id}#${d.id}`, binding: b, sourceType: 'device', sourceId: d.id, deviceId: d.id, base: null, template: null, tags: [] };
      try {
        if (target.mode === 'sparkplug') {
          unit.spDevice = substituteVars(target.device || '{device}', vars);
        } else {
          const mapped = target.assetPaths && typeof target.assetPaths === 'object' ? target.assetPaths[d.id] : undefined;
          unit.base = mapped !== undefined ? String(mapped) : substituteVars(target.assetPathTemplate || '', vars);
          const err = validateAssetPath(unit.base, `asset path for ${d.name || d.id}`);
          if (err) throw new Error(err);
        }
      } catch (error) {
        unit.error = error.message;
      }
      try {
        assignAssetContext(unit, target, cx.contextVars(eff, values));
      } catch (error) {
        unit.error = unit.error || `${d.name || d.id}: ${error.message}`;
      }
      // Raw profile key -> this instance's substituted tag.
      const { tags: expanded } = profilesModel.expandProfileTags(profile, values);
      const byRaw = new Map();
      (profile.tags || []).forEach((t, i) => expanded[i] && byRaw.set(t.key, expanded[i]));
      const isAll = entries === 'all';
      const list = isAll ? (profile.tags || []).map((t) => ({ address: t.key })) : entries;
      for (const e of list) {
        const tag = byRaw.get(e.address) || (eff.tags || []).find((t) => t.key === e.address);
        if (!tag) {
          if (sel && !isAll) sel.push({ unitId: unit.id, key: e.address, property: null, matched: false, rule: 'missing' });
          continue;
        }
        if (!keep(unit, e.address, tag, e, isAll)) continue;
        unit.tags.push(buildTag(tag.key, tag, e, overrides?.[e.address], unit, details));
      }
      units.push(unit);
    }
    return units;
  }

  const unit = {
    id: b.id,
    binding: b,
    sourceType: src.type,
    sourceId: src.type === 'sparkplug' ? null : sourceIdOf(b),
    base: null,
    template: null,
    spDevice: spDefault,
    tags: []
  };
  if (target.mode !== 'sparkplug') {
    if (target.assetPath !== undefined && target.assetPath !== null && target.assetPath !== '') {
      unit.base = String(target.assetPath).replace(/\/+$/, '');
      const err = validateAssetPath(unit.base);
      if (err) unit.error = err;
    } else {
      unit.template = target.pathTemplate || 'uns/{name}';
    }
  }
  if (src.type === 'iot') unit.sourceId = iotSourceId(src);
  if (src.type === 'mqtt') {
    unit.sourceId = src.brokerId;
    unit.mqtt = { filter: src.tags === 'all' ? String(src.filter || '') : null, prefixLen: src.tags === 'all' ? mq.filterPrefix(src.filter || '').length : null };
  }
  const eff = src.type === 'device' ? effectiveOf(profiles, src.deviceId) : null;
  try {
    assignAssetContext(unit, target, cx.contextVars(eff, null));
  } catch (error) {
    unit.error = unit.error || error.message;
  }
  if (src.type === 'device') {
    unit.deviceId = src.deviceId;
    const byKey = new Map((eff?.tags || []).map((t) => [t.key, t]));
    const entries = tagEntries(src);
    const isAll = entries === 'all';
    const list = isAll ? (eff?.tags || []).map((t) => ({ address: t.key })) : entries;
    for (const e of list) {
      const tag = byKey.get(e.address);
      if (!keep(unit, e.address, tag, e, isAll)) continue;
      unit.tags.push(buildTag(e.address, tag, e, overrides?.[e.address], unit, details));
    }
  } else if (src.type === 'mqtt') {
    const entries = tagEntries(src);
    if (entries === 'all') {
      unit.mqtt.select = ruleSet;
      for (const topic of observedTopics(profiles, src.brokerId, unit.mqtt.filter)) {
        const tag = mqttCandidate(unit, topic, overrides?.[topic], details, keep);
        if (tag) unit.tags.push(tag);
      }
    } else {
      for (const e of entries) {
        if (!keep(unit, e.address, null, e, false)) continue;
        unit.tags.push(buildTag(e.address, null, e, overrides?.[e.address], unit, details));
      }
    }
  } else if (src.type === 'iot') {
    unit.iot = { brokerId: src.brokerId, deviceId: src.deviceId };
    const dev = iotDeviceOf(profiles, src.brokerId, src.deviceId);
    const defs = dev ? [...dev.tags.values()].map(iotTagDef) : [];
    const byKey = new Map(defs.map((t) => [t.key, t]));
    const entries = tagEntries(src);
    const isAll = entries === 'all';
    for (const e of isAll ? defs.map((t) => ({ address: t.key })) : entries) {
      const tag = byKey.get(e.address);
      if (!keep(unit, e.address, tag, e, isAll)) continue;
      unit.tags.push(buildTag(e.address, tag || null, e, overrides?.[e.address], unit, details));
    }
  } else if (src.type !== 'sparkplug') {
    const entries = tagEntries(src);
    for (const e of entries === 'all' ? [] : entries) {
      if (!keep(unit, e.address, null, e, false)) continue;
      const sm = src.type === 'opcua' ? serverMetaOf(profiles, unit.sourceId, e.address) : null;
      unit.tags.push(buildTag(e.address, null, e, null, unit, details, sm));
    }
  }
  return [unit];
}

/** A filter-mode MQTT topic as a unit tag, when the filter and the rules keep it (else null). */
function mqttCandidate(unit, topic, ov, details, keep) {
  const parts = topic.split('/');
  if (!mq.matchParts(unit.mqtt.filter.split('/'), parts)) return null;
  const name = hasVal(ov?.name) ? String(ov.name) : mq.topicName(topic, unit.mqtt.prefixLen);
  const probe = { key: topic, property: name };
  if (keep) {
    if (!keep(unit, topic, probe, {}, true)) return null;
  } else {
    if (ov?.enabled === false) return null;
    if (unit.mqtt.select && !cx.selectTag(unit.mqtt.select, probe).matched) return null;
  }
  return buildTag(topic, null, null, ov, unit, details);
}

/**
 * Runtime: a topic a filter-mode MQTT unit has not seen before -> its new tag (added to the unit),
 * or null when the filter/rules do not keep it or the unit is at its topic cap.
 */
function addMqttTopic(unit, topic) {
  if (!unit.mqtt?.filter || unit.tags.length >= mq.MAX_FILTER_TOPICS) return null;
  const tag = mqttCandidate(unit, topic, overridesOf(unit.binding.source)?.[topic], false, null);
  if (!tag) return null;
  if (unit.tagByName?.has(tag.name)) return null; // two topics, one name: the first keeps it (warned at save)
  unit.tags.push(tag);
  return tag;
}

// ---- topics -------------------------------------------------------------------

const valueTopicOf = (unit, name) => {
  if (unit.sourceType === 'mqtt') {
    const n = mq.slugPath(name) || '_';
    return unit.base ? `${unit.base}/${n}` : String(unit.template || 'uns/{name}').includes('{name}') ? String(unit.template).replace(/\{name\}/g, n) : `${String(unit.template).replace(/\/+$/, '')}/${n}`;
  }
  return unit.base ? `${unit.base}/${slug(name)}` : targetTopic(unit.template, name);
};
const statusTopicOf = (unit) => (unit.base ? `${unit.base}/_status` : statusTopic(unit.template));
const metaTopicOf = (unit) => (unit.base ? `${unit.base}/_meta` : metaTopicFromTemplate(unit.template));
const objectTopicOf = (unit) => (unit.base ? unit.base : assetFromTemplate(unit.template));
const layoutOf = (b) => (b?.target?.mode === 'mqtt' && b.target.layout === 'object-per-asset' ? 'object-per-asset' : 'topic-per-tag');
const objectCapOf = (b) => {
  const n = Number(b?.target?.maxObjectBytes);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_OBJECT_CAP, Math.max(MIN_OBJECT_CAP, Math.round(n))) : DEFAULT_OBJECT_CAP;
};

// ---- payloads -------------------------------------------------------------------

function envelope(value, ts, quality, unit) {
  const p = { v: value, t: ts, q: quality };
  if (unit) p.u = unit;
  return p;
}

function objectMember(e, unit) {
  const m = { v: e.v, q: e.q };
  if (unit) m.u = unit;
  return m;
}

/**
 * Field lists of a binding: { env, member } where null means the legacy
 * default shapes (envelope v,t,q,u / member v,q,u). contextMode 'payload'
 * adds 'ctx' to whichever list is in use.
 */
function fieldPlan(b) {
  const target = b?.target || {};
  const payloadCtx = contextModeOf(b) === 'payload';
  const given = Array.isArray(target.fields) && target.fields.length ? target.fields.filter((f) => cx.FIELD_OPTIONS.includes(f)) : null;
  const withCtx = (list) => (payloadCtx && !list.includes('ctx') ? [...list, 'ctx'] : list);
  if (given) {
    const list = withCtx(given);
    if (contextModeOf(b) === 'none') return { env: list.filter((f) => f !== 'ctx'), member: list.filter((f) => f !== 'ctx') };
    return { env: list, member: list };
  }
  if (payloadCtx) return { env: withCtx([...cx.DEFAULT_FIELDS]), member: withCtx([...cx.DEFAULT_MEMBER_FIELDS]) };
  return { env: null, member: null };
}

/** True when a tag needs no new-style formatting (no transform, precision or states). */
const plainTag = (tag) => !tag || (!tag.plan && tag.precision === undefined && !tag.labels);

/**
 * mqtt payload for one tag sample: the bare (formatted) value for `plain`,
 * the legacy envelope object for an unchanged binding, else built from the
 * field list. `fields` = fieldPlan(b).env.
 */
function tagPayload(format, fields, tag, value, ts, quality, reason) {
  if (format !== 'envelope') return cx.formatValue(tag, value);
  if (!fields && plainTag(tag) && reason === undefined) return envelope(value, ts, quality, tag?.meta?.unit);
  return cx.buildFields(fields || cx.DEFAULT_FIELDS, tag, value, ts, quality, reason);
}

/** Object member for one tag (`e` = { v, q, ts, r? }); `fields` = fieldPlan(b).member. */
function memberPayload(fields, tag, e) {
  if (!fields && plainTag(tag) && e.r === undefined) return objectMember(e, tag?.meta?.unit);
  return cx.buildFields(fields || cx.DEFAULT_MEMBER_FIELDS, tag, e.v, e.ts, e.q, e.r);
}

/** metaFields of a binding as a Set, or null (= all). */
function metaFieldSet(b) {
  const mf = b?.target?.metaFields;
  return Array.isArray(mf) ? new Set(mf) : null;
}

/** The _meta document (without updatedAt; the runtime stamps it on publish). */
function metaDoc(unit) {
  const properties = {};
  const b = unit.binding;
  const allow = metaFieldSet(b);
  const ok = (f) => !allow || allow.has(f);
  const ctxOk = unit.ctxMode !== 'none' && ok('context');
  for (const t of unit.tags) {
    const p = { ...t.meta };
    if (allow) for (const f of META_FIELDS) if (!allow.has(f)) delete p[f];
    if (t.transform && ok('type')) Object.assign(p, t.transform);
    if (t.precision !== undefined && ok('type')) p.precision = t.precision;
    if (t.displayName !== undefined && ok('displayName')) p.displayName = t.displayName;
    if (t.limits !== undefined && ok('limits')) p.limits = t.limits;
    if (t.states !== undefined && ok('states')) {
      p.states = t.states;
      p.statesMode = t.statesMode;
    }
    if (t.context && ctxOk) p.context = t.context;
    if (ok('source')) {
      if (b.source.type === 'opcua') p.source = { connectionId: unit.sourceId, address: t.address };
      else if (b.source.type === 'mqtt') p.source = { brokerId: unit.sourceId, topic: t.address, ...(t.field ? { field: t.field } : {}) };
      else if (b.source.type === 'iot') p.source = { brokerId: b.source.brokerId, iotDeviceId: b.source.deviceId, address: t.address };
      else p.source = { deviceId: unit.deviceId ?? unit.sourceId, address: t.address };
      if (b.source.type === 'device-profile') p.source.profileId = b.source.profileId;
    }
    properties[nameKey(unit, t.name)] = p;
  }
  return unit.assetContext && ctxOk ? { context: unit.assetContext, properties } : { properties };
}

// ---- sizing ---------------------------------------------------------------------

function valueBytes(type) {
  const t = String(type || '').toLowerCase();
  if (!t || t === 'unknown') return UNKNOWN_VALUE_BYTES;
  if (/bool|bit/.test(t)) return 5;
  if (/string|char|struct|udt|array|byte\[|wstring/.test(t)) return STRING_VALUE_BYTES;
  if (/64|lint|lreal|ulint|lword|real|float|double|time|date/.test(t)) return 24;
  if (/int|word|byte|sint|dint/.test(t)) return 11;
  return UNKNOWN_VALUE_BYTES;
}

/** Worst-case JSON bytes of one object member: "name":{"v":V,"q":192,"u":"unit"}, */
function memberBytes(tag) {
  const unit = tag.meta?.unit ? JSON.stringify(String(tag.meta.unit)).length + 5 : 0;
  return JSON.stringify(slug(tag.name)).length + 1 + 5 + valueBytes(tag.meta?.type) + 8 + unit + 2;
}

/** Worst-case member bytes under a field list (null = legacy shape). */
function memberBytesFor(fields, tag) {
  if (!fields && plainTag(tag)) return memberBytes(tag);
  return JSON.stringify(slug(tag.name)).length + 1 + cx.fieldBytes(fields || cx.DEFAULT_MEMBER_FIELDS, tag, valueBytes) + 1;
}

/** Worst-case bytes of one topic-per-tag payload. */
function payloadBytesFor(b, tag) {
  const target = b?.target || {};
  if (target.mode !== 'mqtt' || target.format !== 'envelope') {
    let n = valueBytes(tag.outType || tag.meta?.type);
    if (tag.labels && tag.statesMode === 'replace') for (const l of tag.labels.values()) n = Math.max(n, JSON.stringify(l).length);
    return n;
  }
  const fields = fieldPlan(b).env;
  return cx.fieldBytes(fields || cx.DEFAULT_FIELDS, tag, valueBytes);
}

function objectEstimate(unit) {
  let worst = 0;
  let total = OBJECT_ENVELOPE_BYTES;
  const fields = fieldPlan(unit.binding).member;
  for (const t of unit.tags) {
    const m = memberBytesFor(fields, t);
    total += m;
    if (m > worst) worst = m;
  }
  return { tags: unit.tags.length, worstMember: worst, total };
}

// ---- retained set ---------------------------------------------------------------

/**
 * Every retained topic a binding (in its CURRENT config) publishes, derived
 * deterministically from config: [{ brokerId, topic }]. Used to clear stale
 * retained messages after an edit, rename, disable or delete.
 * (Sparkplug-source bindings with retain on publish metric names that are only
 * known at runtime; their value topics are not derivable and not included.)
 */
function retainedTopics(b, profiles) {
  const out = [];
  const target = b?.target || {};
  if (!b || b.enabled === false || target.mode !== 'mqtt' || !target.brokerId) return out;
  const layout = layoutOf(b);
  for (const unit of expandUnits(b, profiles)) {
    if (unit.error) continue;
    if (target.statusTopic !== false) out.push({ brokerId: target.brokerId, topic: statusTopicOf(unit) });
    if (target.metaTopic !== false && unit.tags.length) out.push({ brokerId: target.brokerId, topic: metaTopicOf(unit) });
    if (target.retain) {
      if (layout === 'object-per-asset') out.push({ brokerId: target.brokerId, topic: objectTopicOf(unit) });
      else for (const t of unit.tags) out.push({ brokerId: target.brokerId, topic: valueTopicOf(unit, t.name) });
    }
  }
  return out;
}

/** Resolved data topics of a binding: [{ topic, name, address, unitId }] (object layout: one per unit). */
function dataTopics(b, profiles, limit = Infinity) {
  const out = [];
  if (!b || b.target?.mode !== 'mqtt') return out;
  const layout = layoutOf(b);
  for (const unit of expandUnits(b, profiles)) {
    if (unit.error) continue;
    if (layout === 'object-per-asset') {
      out.push({ topic: objectTopicOf(unit), name: null, address: null, unitId: unit.id });
    } else {
      for (const t of unit.tags) {
        out.push({ topic: valueTopicOf(unit, t.name), name: t.name, address: t.address, unitId: unit.id });
        if (out.length >= limit) return out;
      }
    }
    if (out.length >= limit) return out;
  }
  return out;
}

// ---- validation ---------------------------------------------------------------

/**
 * Validate a binding draft against the stored configuration. Returns the
 * normalized binding body { name, enabled, source, target, rbe? } or throws
 * BindingValidationError. Unknown extra fields on source/target are kept.
 */
function validateBinding(draft, { profiles }) {
  const { name, enabled, source, target, rbe } = draft || {};
  const fail = (msg, details) => {
    throw new BindingValidationError(msg, details);
  };
  if (!source?.type || !SOURCE_TYPES.includes(source.type)) {
    fail('source.type must be "device", "device-profile", "opcua", "sparkplug", "mqtt" or "iot"');
  }
  const entries = tagEntries(source);
  // Disabled entries may name a tag the device no longer has (they only remember settings).
  const enabledEntries = entries === 'all' ? entries : entries.filter((t) => t.enabled !== false);
  if (source.type === 'device') {
    const device = effectiveOf(profiles, source.deviceId);
    if (!device) fail('device source needs an existing deviceId');
    if (entries !== 'all') {
      if (!entries.length) fail('device source needs tags[] (or "all")');
      const keys = new Set((device.tags || []).map((t) => t.key));
      const missing = enabledEntries.filter((t) => !keys.has(t.address)).map((t) => t.address);
      if (missing.length) fail(`device has no tag(s): ${missing.slice(0, 5).join(', ')}`);
    }
  }
  if (source.type === 'device-profile') {
    const profile = profiles.getIn('deviceProfiles', source.profileId);
    if (!profile) fail('device-profile source needs an existing profileId');
    if (entries !== 'all') {
      if (!entries.length) fail('device-profile source needs tags[] (profile tag keys, or "all")');
      const keys = new Set((profile.tags || []).map((t) => t.key));
      const missing = enabledEntries.filter((t) => !keys.has(t.address)).map((t) => t.address);
      if (missing.length) fail(`profile has no tag(s): ${missing.slice(0, 5).join(', ')}`);
    }
  }
  if (source.type === 'opcua' && (!source.connectionId || entries === 'all' || !entries.length)) {
    fail('opcua source needs connectionId and tags[]');
  }
  if (source.type === 'sparkplug' && (!source.brokerId || !source.group || !source.edge)) {
    fail('sparkplug source needs brokerId, group, edge');
  }
  if (source.type === 'mqtt') {
    const units = target && typeof target === 'object' ? expandUnits({ name, source, target, id: draft.id || 'draft' }, profiles) : [];
    const err = mq.mqttSourceError(source, target || {}, units);
    if (err) fail(err);
  }
  if (source.type === 'iot') {
    if (typeof source.brokerId !== 'string' || !source.brokerId) fail('iot source needs brokerId');
    if (typeof source.deviceId !== 'string' || !source.deviceId || /\s/.test(source.deviceId)) fail('iot source needs deviceId (the IoT device id, e.g. "z2m:0x00158d0001a2b3c4")');
    if (entries !== 'all' && !entries.length) fail('iot source needs tags[] (tag keys of the device, or "all")');
    // A mapping must not publish into what the conventions read on the same broker.
    if (target && target.brokerId === source.brokerId) {
      const pair = mq.overlapPair(source.brokerId, iotReadFilters(profiles, source.brokerId), target.brokerId, mq.publishFilters({ target }, []));
      if (pair) fail(`loop: this mapping would publish into topics IoT detection reads (target ${pair.target} overlaps ${pair.source} on broker ${source.brokerId}); publish elsewhere or to another broker`);
    }
  }
  if (!target?.mode || !['mqtt', 'sparkplug'].includes(target.mode)) fail('target.mode must be "mqtt" or "sparkplug"');
  if (!target.brokerId) fail('target.brokerId is required');
  if (target.mode === 'sparkplug' && (!target.group || !target.edge)) fail('sparkplug target needs group and edge');

  if (target.mode === 'mqtt') {
    if (target.layout !== undefined && !['topic-per-tag', 'object-per-asset'].includes(target.layout)) {
      fail('target.layout must be "topic-per-tag" or "object-per-asset"');
    }
    if (target.format !== undefined && !['plain', 'envelope'].includes(target.format)) fail('target.format must be "plain" or "envelope"');
    const hasAsset = target.assetPath !== undefined && target.assetPath !== null && target.assetPath !== '';
    if (hasAsset) {
      const err = validateAssetPath(String(target.assetPath).replace(/\/+$/, ''));
      if (err) fail(err);
    }
    if (source.type === 'device-profile') {
      const hasMap = target.assetPaths && typeof target.assetPaths === 'object' && Object.keys(target.assetPaths).length;
      if (!hasMap && !target.assetPathTemplate) {
        fail('a device-profile binding needs target.assetPathTemplate (e.g. "acme/dallas/{device}") or target.assetPaths { deviceId: path }');
      }
      if (target.assetPathTemplate) {
        const profile = profiles.getIn('deviceProfiles', source.profileId);
        const allowed = new Set(['device', 'deviceId', ...(profile.params || []).map((p) => p.name)]);
        const used = profilesModel.placeholders(target.assetPathTemplate);
        const unknown = [...used].filter((n) => !allowed.has(n));
        if (unknown.length) fail(`assetPathTemplate uses unknown placeholder(s) ${unknown.map((n) => `{${n}}`).join(', ')} (allowed: ${[...allowed].map((n) => `{${n}}`).join(', ')})`);
        const err = validateAssetPath(String(target.assetPathTemplate).replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'x'), 'assetPathTemplate');
        if (err) fail(err);
      }
      for (const [devId, p] of Object.entries(target.assetPaths || {})) {
        const err = validateAssetPath(String(p), `assetPaths["${devId}"]`);
        if (err) fail(err);
      }
    }
    if (target.maxObjectBytes !== undefined) {
      const n = Number(target.maxObjectBytes);
      if (!Number.isFinite(n) || n < MIN_OBJECT_CAP || n > MAX_OBJECT_CAP) fail(`target.maxObjectBytes must be ${MIN_OBJECT_CAP}..${MAX_OBJECT_CAP}`);
    }
  } else if (target.layout === 'object-per-asset') {
    fail('layout "object-per-asset" is only available for mqtt targets');
  }

  if (target.historian !== undefined && target.historian !== null) {
    const hid = target.historian?.historianId;
    const h = hid ? profiles.getIn('historians', hid) : null;
    if (!h) fail('target.historian.historianId must name an existing historian');
    if (h.type === 'influxdb') {
      fail('InfluxDB cannot be a direct historian target for device data: its writer drops quality (project decision). Use a Timebase or TimescaleDB historian, or record via a pipeline.');
    }
    if (!HISTORIAN_TYPES.has(h.type)) fail(`historian type "${h.type}" is not supported as a direct target (allowed: timebase, timescaledb)`);
  }

  validateMappingOptions(source, target, profiles, fail);

  let rbeOut;
  if (rbe && typeof rbe === 'object') {
    rbeOut = {};
    if (Number(rbe.heartbeatMs) > 0) rbeOut.heartbeatMs = Math.max(1000, Math.round(Number(rbe.heartbeatMs)));
    if (rbe.deadband !== undefined && rbe.deadband !== null) {
      const db = rbe.deadband;
      const type = db?.type ?? 'absolute';
      const value = Number(db?.value);
      if (!['absolute', 'percent'].includes(type)) fail('rbe.deadband.type must be "absolute" or "percent"');
      if (!Number.isFinite(value) || value < 0) fail('rbe.deadband.value must be a number >= 0');
      if (type === 'percent' && value > 100) fail('a percent deadband must be 0..100');
      rbeOut.deadband = { type, value };
    }
    if (!Object.keys(rbeOut).length) rbeOut = undefined;
  }

  const binding = {
    name: name || null,
    enabled: enabled !== false,
    source,
    target,
    ...(rbeOut ? { rbe: rbeOut } : {})
  };

  // Payload context cap (contextMode 'payload' / fields with 'ctx'): per tag, after placeholders.
  const fp = fieldPlan(binding);
  const ctxInPayload = target.mode === 'mqtt' && ((fp.env && fp.env.includes('ctx') && (target.format === 'envelope' || layoutOf(binding) === 'object-per-asset')));
  if (ctxInPayload || (target.mode === 'sparkplug' && cx.isPlainObject(target.context))) {
    for (const unit of expandUnits({ ...binding, id: draft.id || 'draft' }, profiles)) {
      if (unit.assetContext) {
        const bytes = cx.bytesOf(unit.assetContext);
        if (bytes > cx.MAX_CONTEXT_BYTES) fail(`target.context resolves to ${bytes} bytes for ${unit.id}; at most ${cx.MAX_CONTEXT_BYTES} bytes are allowed`);
      }
      if (!ctxInPayload) continue;
      for (const t of unit.tags) {
        const bytes = t.ctx ? cx.bytesOf(t.ctx) : 0;
        if (bytes > cx.MAX_PAYLOAD_CONTEXT_BYTES) {
          fail(
            `tag "${t.address}": payload context (ctx) is ${bytes} bytes, over the ${cx.MAX_PAYLOAD_CONTEXT_BYTES}-byte cap for context in payloads; ` +
              'keep it in _meta (contextMode "meta"), drop keys or shorten values'
          );
        }
      }
    }
  }

  // Size cap for object payloads: per unit, tag count x worst-case member size.
  if (layoutOf(binding) === 'object-per-asset') {
    const cap = objectCapOf(binding);
    for (const unit of expandUnits({ ...binding, id: draft.id || 'draft' }, profiles)) {
      const est = objectEstimate(unit);
      if (est.total > cap) {
        fail(
          `object-per-asset payload for ${unit.base || objectTopicOf(unit)} could reach ${est.total} bytes ` +
            `(${est.tags} tags x up to ${est.worstMember} bytes each + envelope) which exceeds the ${cap}-byte cap; ` +
            'split the binding, bind fewer tags, or raise target.maxObjectBytes (max 1048576)'
        );
      }
    }
  }
  return binding;
}

/** Validation of the "choose what to map" / "context" options; calls fail(msg) on the first error. */
function validateMappingOptions(source, target, profiles, fail) {
  const entries = tagEntries(source);
  const isMqtt = source.type === 'mqtt';
  const listSource = source.type === 'device' || source.type === 'device-profile' || source.type === 'iot' || isMqtt;
  // MQTT entries also carry `field` and `staleAfterMs` (checked by bindingMqtt.mqttSourceError).
  const own = (o) => {
    if (!isMqtt || !cx.isPlainObject(o)) return o;
    const { field: _f, staleAfterMs: _s, ...rest } = o;
    return rest;
  };
  if (Array.isArray(source.tags)) {
    for (const t of source.tags) {
      if (!t || typeof t !== 'object') continue;
      const err = cx.overrideError(own(t), `tag "${t.address}"`);
      if (err) fail(err);
    }
  }
  if (source.select !== undefined && source.select !== null) {
    if (!listSource || entries !== 'all') fail('source.select applies only to device, device-profile, iot and mqtt sources with tags: "all"');
    const err = cx.selectError(source.select);
    if (err) fail(err);
    if (isMqtt && Object.keys(source.select).some((k) => k !== 'include' && k !== 'exclude')) fail('source.select of an mqtt source takes include and exclude only (topic globs)');
  }
  if (source.overrides !== undefined && source.overrides !== null) {
    if (!listSource) fail('source.overrides applies only to device, device-profile, iot and mqtt sources');
    if (!cx.isPlainObject(source.overrides)) fail('source.overrides must be an object { <tagKey>: { ...overrides } }');
    for (const [k, o] of Object.entries(source.overrides)) {
      const err = cx.overrideError(own(o), `source.overrides["${k}"]`, { strict: true });
      if (err) fail(err);
    }
  }
  if (target.contextMode !== undefined && !cx.CONTEXT_MODES.includes(target.contextMode)) fail(`target.contextMode must be one of ${cx.CONTEXT_MODES.join(', ')}`);
  if (target.fields !== undefined && target.fields !== null) {
    if (target.mode !== 'mqtt') fail('target.fields applies to mqtt targets only');
    const f = target.fields;
    if (!Array.isArray(f) || !f.length) fail(`target.fields must be a non-empty array of ${cx.FIELD_OPTIONS.join(', ')}`);
    const bad = f.filter((x) => !cx.FIELD_OPTIONS.includes(x));
    if (bad.length) fail(`target.fields has unknown field(s) ${bad.map((x) => JSON.stringify(x)).join(', ')} (allowed: ${cx.FIELD_OPTIONS.join(', ')})`);
    if (new Set(f).size !== f.length) fail('target.fields lists a field twice');
    if (!f.includes('v')) fail('target.fields must include "v" (the value)');
    if (f.includes('ctx') && target.contextMode === 'none') fail('target.fields includes "ctx" but target.contextMode is "none"');
  }
  if (target.metaFields !== undefined && target.metaFields !== null) {
    const f = target.metaFields;
    if (!Array.isArray(f)) fail(`target.metaFields must be an array of ${cx.META_FIELD_OPTIONS.join(', ')}`);
    const bad = f.filter((x) => !cx.META_FIELD_OPTIONS.includes(x));
    if (bad.length) fail(`target.metaFields has unknown field(s) ${bad.map((x) => JSON.stringify(x)).join(', ')} (allowed: ${cx.META_FIELD_OPTIONS.join(', ')})`);
  }
  if (target.context !== undefined && target.context !== null) {
    const err = cx.contextError(target.context, 'target.context');
    if (err) fail(err);
    const profile = source.type === 'device-profile' ? profiles.getIn('deviceProfiles', source.profileId) : null;
    const allowed = cx.allowedPlaceholders(source.type, profile);
    for (const [token, key] of cx.contextPlaceholders(target.context)) {
      if (!allowed.includes(token)) {
        fail(
          `target.context.${key} uses unknown placeholder {${token}} ` +
            `(allowed for a ${source.type} source: ${allowed.length ? allowed.map((p) => `{${p}}`).join(', ') : 'none'})`
        );
      }
    }
  }
}

// ---- warnings & preview -----------------------------------------------------------

/** topic -> [{ id, name }] for every other binding's resolved data topics (save-time only). */
function topicOwners(profiles, excludeId) {
  const owners = new Map();
  for (const other of profiles.listIn('bindings')) {
    if (other.id === excludeId || other.enabled === false) continue;
    for (const { topic } of dataTopics(other, profiles)) {
      const key = `${other.target.brokerId}\u0000${topic}`;
      if (!owners.has(key)) owners.set(key, []);
      const list = owners.get(key);
      if (!list.some((o) => o.id === other.id)) list.push({ id: other.id, name: other.name || null });
    }
  }
  return owners;
}

/**
 * Warnings for the selection/fields/context options (none for a binding that
 * uses none of them). Each: { type, message, tag?, key?, topic: null }.
 */
function mappingWarnings(b, profiles, push) {
  const src = b?.source || {};
  const target = b?.target || {};
  const fields = Array.isArray(target.fields) ? target.fields : null;
  if (fields && target.mode === 'mqtt') {
    if (!fields.includes('q')) {
      push({ type: 'no-quality', topic: null, message: 'target.fields drops "q": consumers cannot tell a dead value from a live one' });
    }
    if (target.format !== 'envelope' && layoutOf(b) !== 'object-per-asset') {
      push({ type: 'fields-ignored', topic: null, message: 'target.fields applies to the envelope format and object-per-asset members; plain payloads are the bare value' });
    }
  }
  const credential = (ctx, where) => {
    for (const k of cx.credentialLikeKeys(ctx)) {
      push({ type: 'credential-like-context', topic: null, key: k, message: `${where} key "${k}" looks like a credential; context is published to the broker in clear text` });
    }
  };
  credential(target.context, 'target.context');
  const listed = Array.isArray(src.tags) ? src.tags.filter((t) => t && typeof t === 'object') : [];
  for (const t of listed) credential(t.context, `tag "${t.address}" context`);
  for (const [k, o] of Object.entries(overridesOf(src) || {})) credential(o?.context, `source.overrides["${k}"].context`);

  // Keys / entries that name no tag.
  let keys = null;
  if (src.type === 'device') keys = new Set((effectiveOf(profiles, src.deviceId)?.tags || []).map((t) => t.key));
  if (src.type === 'device-profile') keys = new Set((profiles.getIn('deviceProfiles', src.profileId)?.tags || []).map((t) => t.key));
  if (keys) {
    for (const k of Object.keys(overridesOf(src) || {})) {
      if (!keys.has(k)) push({ type: 'unknown-override', topic: null, tag: k, message: `source.overrides["${k}"] names no tag of the ${src.type === 'device' ? 'device' : 'profile'}; it applies if such a tag is added` });
    }
    for (const t of listed) {
      if (t.enabled === false && !keys.has(t.address)) push({ type: 'disabled-missing', topic: null, tag: t.address, message: `disabled entry "${t.address}" names no tag of the ${src.type === 'device' ? 'device' : 'profile'}` });
    }
    // Device-level context that cannot be used.
    const devTags = src.type === 'device' ? effectiveOf(profiles, src.deviceId)?.tags || [] : profiles.getIn('deviceProfiles', src.profileId)?.tags || [];
    for (const dt of devTags) {
      if (dt?.context === undefined) continue;
      const { context, ignored } = cx.sanitizeDeviceContext(dt.context);
      if (ignored.length) push({ type: 'device-context', topic: null, tag: dt.key, message: `device tag "${dt.key}" context key(s) ${ignored.slice(0, 5).join(', ')} are invalid and not published` });
      credential(context, `device tag "${dt.key}" context`);
    }
  }

  if (src.type === 'sparkplug') return;
  const units = expandUnits(b, profiles);
  for (const unit of units) {
    if (!unit.tags.length && !unit.error) {
      const why =
        src.type === 'mqtt' && src.tags === 'all'
          ? `no topic seen on the broker matches ${src.filter}${src.select ? ' and the rules' : ''} yet; new matching topics are picked up when they appear`
          : src.select
            ? 'the selection rules match no tag'
            : 'every tag entry is disabled or the source has no tags';
      push({ type: 'no-tags', topic: null, unitId: unit.id, message: `${unit.id}: nothing to publish (${why})` });
    }
    const seen = new Map();
    for (const t of unit.tags) {
      const s = nameKey(unit, t.name);
      if (seen.has(s) && seen.get(s) !== t.address) {
        push({ type: 'duplicate-name', topic: null, name: t.name, message: `tags "${seen.get(s)}" and "${t.address}" both publish as "${s}" in ${unit.id}` });
      } else seen.set(s, t.address);
      if (target.mode === 'sparkplug' && t.ctx) {
        for (const k of Object.keys(t.ctx)) {
          if (cx.SPARKPLUG_STANDARD_PROPS.has(k)) push({ type: 'sparkplug-context-collision', topic: null, key: k, message: `context key "${k}" collides with a standard Sparkplug metric property and is not sent in BIRTH` });
        }
      }
    }
  }
}

/**
 * Non-blocking save-time warnings: names that look like raw device addresses
 * and topics another binding already publishes. -> [{ type, topic, message, ... }]
 */
function bindingWarnings(b, profiles, { owners } = {}) {
  const warnings = [];
  const push = (w) => warnings.length < MAX_WARNINGS && warnings.push(w);
  mappingWarnings(b, profiles, push);
  // Options that are accepted but cannot take effect on this target.
  const t = b?.target || {};
  if (t.contextMode === 'payload' && t.mode === 'mqtt' && t.format !== 'envelope' && t.layout !== 'object-per-asset') {
    push({ type: 'option-ignored', topic: null, message: 'context cannot ride a plain payload (it is a bare value); use the envelope format or the object layout, or keep context in _meta' });
  }
  if (t.mode === 'sparkplug' && Array.isArray(t.metaFields)) {
    push({ type: 'option-ignored', topic: null, message: 'metaFields has no effect on a Sparkplug target (there is no _meta document; metadata travels as metric properties in BIRTH)' });
  }
  if (b?.source?.type === 'mqtt') {
    const unitsOf = (x) => expandUnits(x, profiles).filter((u) => !u.error);
    for (const w of mq.loopWarnings(b, profiles.listIn('bindings'), unitsOf)) push(w);
  }
  if (b?.target?.mode !== 'mqtt') return warnings;
  const own = owners || topicOwners(profiles, b.id);
  for (const unit of expandUnits(b, profiles)) {
    if (unit.error) push({ type: 'asset-path', topic: null, message: unit.error });
    for (const t of unit.tags) {
      if (looksLikeRawAddress(slug(t.name))) {
        push({
          type: 'raw-address',
          topic: valueTopicOf(unit, t.name),
          name: t.name,
          message: `"${t.name}" looks like a raw device address; give the tag a property name (e.g. "speed") so the UNS does not depend on PLC addressing`
        });
      }
    }
  }
  for (const { topic } of dataTopics(b, profiles)) {
    const hit = own.get(`${b.target.brokerId}\u0000${topic}`);
    if (hit) push({ type: 'collision', topic, bindings: hit, message: `topic ${topic} is already published by binding ${hit.map((h) => h.name || h.id).join(', ')}` });
  }
  return warnings;
}

/**
 * Preview a binding draft (read-only). `latest(unit, address)` returns the
 * newest known sample { v, q, t, type } or null (args: unit, address, name).
 */
function previewBinding(b, profiles, { latest = () => null, maxTags } = {}) {
  // Callers that render a full editor table may ask for more rows (bounded).
  const cap = Math.min(PREVIEW_HARD_MAX, Math.max(1, Math.floor(Number(maxTags)) || PREVIEW_MAX_TAGS));
  const target = b.target || {};
  const layout = layoutOf(b);
  const owners = topicOwners(profiles, b.id);
  const selectionRows = [];
  const units = expandUnits(b, profiles, { selection: selectionRows, details: true });
  const warnings = bindingWarnings(b, profiles, { owners });
  const fp = fieldPlan(b);
  const bindingDeadband = deadbandOf(b);
  const now = Date.now();
  const tags = [];
  const members = [];
  const objects = [];
  const meta = [];
  const status = [];
  const contexts = [];
  const tx = {};
  let totalTags = 0;
  let exampleBytes = 0;
  let worstPayload = 0;
  let worstCycle = 0;
  const tagWarnings = (tag, topic) =>
    warnings.filter((w) => (w.tag !== undefined && w.tag === tag.address) || (w.name !== undefined && w.name === tag.name && (!w.topic || w.topic === topic)));
  const detail = (tag) => ({
    metadata: effectiveMetadata(tag, bindingDeadband),
    origins: tag.origins,
    contextOrigins: tag.contextOrigins
  });
  for (const unit of units) {
    totalTags += unit.tags.length;
    if (unit.error) continue;
    if (contexts.length < cap) contexts.push({ unitId: unit.id, context: unit.assetContext || null });
    if (target.mode === 'mqtt') {
      if (target.statusTopic !== false) status.push(statusTopicOf(unit));
      if (target.metaTopic !== false && unit.tags.length && meta.length < 10) meta.push({ topic: metaTopicOf(unit), payload: { ...metaDoc(unit), updatedAt: now } });
    }
    const values = {};
    let t = 0;
    for (const tag of unit.tags) {
      const smp = latest(unit, tag.address, tag.name);
      if (smp) cx.applyTransform(tag.plan, smp.v, smp.q ?? 192, tx);
      const e = smp ? { v: tx.v, q: tx.q, ts: smp.t || now, r: tx.r } : { v: null, q: 0, ts: now, r: undefined };
      if (smp?.t > t) t = smp.t;
      if (layout === 'object-per-asset') {
        const member = memberPayload(fp.member, tag, e);
        values[nameKey(unit, tag.name)] = member;
        if (members.length < cap) {
          const topic = objectTopicOf(unit);
          members.push({
            name: tag.name,
            address: tag.address,
            unitId: unit.id,
            hasValue: Boolean(smp),
            topic,
            member: nameKey(unit, tag.name),
            payload: member,
            bytes: Buffer.byteLength(JSON.stringify(member)),
            worstCaseBytes: memberBytesFor(fp.member, tag),
            ...detail(tag),
            warnings: tagWarnings(tag, topic)
          });
        }
        continue;
      }
      let worst = null;
      if (target.mode === 'mqtt') {
        worst = payloadBytesFor(b, tag);
        worstCycle += worst;
        if (worst > worstPayload) worstPayload = worst;
      }
      if (tags.length >= cap) continue;
      const entry = { name: tag.name, address: tag.address, unitId: unit.id, hasValue: Boolean(smp) };
      if (target.mode === 'sparkplug') {
        entry.topic = `spBv1.0/${target.group}/DDATA/${target.edge}/${unit.spDevice}`;
        entry.metric = tag.name;
        entry.payload = { name: tag.name, value: cx.formatValue(tag, e.v), type: tag.outType || smp?.type || tag.meta.type || null, properties: sparkplugProps(tag.meta, tag) };
      } else {
        entry.topic = valueTopicOf(unit, tag.name);
        entry.payload = tagPayload(target.format, fp.env, tag, e.v, smp?.t || now, e.q, e.r);
        const hit = owners.get(`${target.brokerId}\u0000${entry.topic}`);
        if (hit) entry.collisions = hit;
        const bytes = Buffer.byteLength(typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload ?? null));
        entry.bytes = bytes;
        entry.worstCaseBytes = worst;
        exampleBytes += bytes;
      }
      Object.assign(entry, detail(tag));
      entry.warnings = tagWarnings(tag, entry.topic);
      tags.push(entry);
    }
    if (layout === 'object-per-asset') {
      const est = objectEstimate(unit);
      worstCycle += est.total;
      if (est.total > worstPayload) worstPayload = est.total;
      if (objects.length < cap) {
        const payload = { t: t || now, values };
        const topic = objectTopicOf(unit);
        const o = { topic, unitId: unit.id, payload, bytes: Buffer.byteLength(JSON.stringify(payload)), worstCaseBytes: est.total, capBytes: objectCapOf(b) };
        const hit = owners.get(`${target.brokerId}\u0000${topic}`);
        if (hit) o.collisions = hit;
        exampleBytes += o.bytes;
        objects.push(o);
      }
    }
  }
  const SELECTION_MAX = 500;
  return {
    layout,
    format: target.mode === 'mqtt' ? target.format || 'plain' : 'sparkplug',
    units: units.length,
    unitErrors: units.filter((u) => u.error).map((u) => ({ unitId: u.id, error: u.error })),
    totalTags,
    truncated: layout === 'object-per-asset' ? units.length > objects.length : totalTags > tags.length,
    tags,
    objects,
    meta,
    status: status.slice(0, cap),
    warnings,
    members,
    selection: {
      matched: selectionRows.filter((r) => r.matched).length,
      excluded: selectionRows.filter((r) => !r.matched).length,
      truncated: selectionRows.length > SELECTION_MAX,
      rows: selectionRows.slice(0, SELECTION_MAX)
    },
    contexts,
    fields: { envelope: target.mode === 'mqtt' && target.format === 'envelope' ? fp.env || [...cx.DEFAULT_FIELDS] : null, member: layout === 'object-per-asset' ? fp.member || [...cx.DEFAULT_MEMBER_FIELDS] : null },
    contextMode: contextModeOf(b),
    sizes: target.mode === 'mqtt' ? { exampleBytes, worstCasePayloadBytes: worstPayload, worstCaseCycleBytes: worstCycle } : null
  };
}

/** The effective (merged) metadata of one tag, as the preview reports it. */
function effectiveMetadata(tag, bindingDeadband) {
  const m = { name: tag.name, ...tag.meta };
  for (const f of ['displayName', 'limits', 'states', 'statesMode', 'precision']) if (tag[f] !== undefined) m[f] = tag[f];
  if (tag.transform) Object.assign(m, tag.transform);
  m.deadband = tag.deadband !== undefined ? tag.deadband : bindingDeadband;
  if (tag.context) m.context = tag.context;
  return m;
}

/**
 * Sparkplug metric properties (BIRTH only) from tag metadata: conventional keys
 * engUnit/engLow/engHigh/description, then displayName, limitLoLo/limitLo/
 * limitHi/limitHiHi (Double), then the merged asset + tag context as String
 * properties (keys are already restricted to A-Z a-z 0-9 _ . -; a context key
 * equal to a standard property is skipped). `tag` is optional.
 */
function sparkplugProps(meta, tag) {
  if (!meta) return undefined;
  const p = {};
  if (meta.unit) p.engUnit = String(meta.unit);
  if (meta.description) p.description = String(meta.description);
  if (meta.range && Number.isFinite(Number(meta.range.min)) && Number.isFinite(Number(meta.range.max))) {
    p.engLow = Number(meta.range.min);
    p.engHigh = Number(meta.range.max);
  }
  if (tag) {
    if (tag.displayName) p.displayName = String(tag.displayName);
    if (tag.limits) {
      for (const [k, prop] of [['lolo', 'limitLoLo'], ['lo', 'limitLo'], ['hi', 'limitHi'], ['hihi', 'limitHiHi']]) {
        if (Number.isFinite(tag.limits[k])) p[prop] = tag.limits[k];
      }
    }
    if (tag.ctx) for (const [k, v] of Object.entries(tag.ctx)) if (!cx.SPARKPLUG_STANDARD_PROPS.has(k)) p[k] = String(v);
  }
  return Object.keys(p).length ? p : undefined;
}

/**
 * Suggestions for the mapping wizard (POST /api/tags/bindings/suggest):
 * names from `property`, else a cleaned key; asset context from the device.
 * Nothing is guessed beyond that (no units, no AI).
 */
function suggestMapping(source, profiles) {
  const src = source || {};
  let tags;
  let context;
  if (src.type === 'device') {
    const eff = effectiveOf(profiles, src.deviceId);
    if (!eff) throw new BindingValidationError('device source needs an existing deviceId');
    tags = eff.tags || [];
    context = { suggested: { deviceName: '{device}', protocol: '{protocol}' }, resolved: { deviceName: eff.name || eff.id, protocol: eff.protocol } };
  } else if (src.type === 'device-profile') {
    const profile = profiles.getIn('deviceProfiles', src.profileId);
    if (!profile) throw new BindingValidationError('device-profile source needs an existing profileId');
    tags = profile.tags || [];
    const first = profiles
      .listIn('devices')
      .filter((d) => d.profileId === profile.id)
      .sort((a, c) => String(a.id).localeCompare(String(c.id)))[0];
    context = {
      suggested: { deviceName: '{device}', protocol: '{protocol}' },
      resolved: first ? { deviceName: first.name || first.id, protocol: profile.protocol } : null,
      resolvedFor: first ? first.id : null
    };
  } else if (src.type === 'opcua') {
    const entries = tagEntries(src);
    tags = (entries === 'all' ? [] : entries).map((e) => ({ key: e.address }));
    context = { suggested: {}, resolved: {} };
  } else if (src.type === 'mqtt') {
    const entries = tagEntries(src);
    const prefix = entries === 'all' ? mq.filterPrefix(src.filter || '').length : null;
    const topics = entries === 'all' ? observedTopics(profiles, src.brokerId, src.filter) : entries.map((e) => e.address);
    const rows = topics.map((topic) => ({ address: topic, property: null, type: null, unit: null, description: null, suggestedName: mq.topicName(topic, prefix), basis: 'topic', rawAddress: false }));
    return { sourceType: 'mqtt', tags: rows, entries: rows.map((r) => ({ address: r.address, name: r.suggestedName })), context: { suggested: {}, resolved: {} } };
  } else if (src.type === 'iot') {
    const dev = iotDeviceOf(profiles, src.brokerId, src.deviceId);
    if (!dev) throw new BindingValidationError('iot source: no such device on that broker (is detection enabled and the device seen?)');
    tags = [...dev.tags.values()].map(iotTagDef);
    context = { suggested: {}, resolved: {} };
  } else {
    throw new BindingValidationError('suggest supports device, device-profile, opcua, iot and mqtt sources');
  }
  const byName = new Map();
  const out = tags.map((t) => {
    const s = cx.suggestName(t);
    const row = {
      address: t.key,
      property: t.property || null,
      type: t.type || null,
      unit: t.unit || null,
      description: t.description || null,
      suggestedName: s.name,
      basis: s.basis,
      rawAddress: s.reason === 'raw-address' || looksLikeRawAddress(String(t.key || ''))
    };
    if (s.reason) row.reason = s.reason;
    if (s.name) {
      const k = slug(s.name).toLowerCase();
      if (byName.has(k)) row.duplicateOf = byName.get(k);
      else byName.set(k, t.key);
    }
    return row;
  });
  return {
    sourceType: src.type,
    tags: out,
    entries: out.filter((r) => r.suggestedName).map((r) => ({ address: r.address, name: r.suggestedName })),
    context
  };
}

module.exports = {
  BindingValidationError,
  attachTopicSource,
  observedTopics,
  attachServerMeta,
  serverMetaOf,
  attachIotSource,
  iotDeviceOf,
  iotTagDef,
  addMqttTopic,
  nameKey,
  DEFAULT_OBJECT_CAP,
  MAX_OBJECT_CAP,
  PREVIEW_MAX_TAGS,
  slug,
  targetTopic,
  statusTopic,
  assetFromTemplate,
  validateAssetPath,
  tagEntries,
  sourceIdOf,
  deadbandOf,
  withinDeadband,
  expandUnits,
  valueTopicOf,
  statusTopicOf,
  metaTopicOf,
  objectTopicOf,
  layoutOf,
  objectCapOf,
  envelope,
  objectMember,
  metaDoc,
  memberBytes,
  objectEstimate,
  retainedTopics,
  dataTopics,
  validateBinding,
  topicOwners,
  bindingWarnings,
  previewBinding,
  sparkplugProps,
  suggestMapping,
  applyTransform: cx.applyTransform,
  formatValue: cx.formatValue,
  fieldPlan,
  tagPayload,
  memberPayload,
  payloadBytesFor,
  memberBytesFor,
  contextModeOf,
  effectiveMetadata,
  bindingSchema: () =>
    cx.bindingSchema({ defaultObjectCap: DEFAULT_OBJECT_CAP, minObjectCap: MIN_OBJECT_CAP, maxObjectCap: MAX_OBJECT_CAP, previewMaxTags: PREVIEW_MAX_TAGS })
};
