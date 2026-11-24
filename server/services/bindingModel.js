'use strict';

const profilesModel = require('./deviceProfiles');
const { looksLikeRawAddress } = require('./unsLint');

/**
 * Binding model - the pure half of tag bindings (docs/design/southbound-drivers.md
 * section 6): validation, expansion of a binding into publishing UNITS, topic
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
 */

const DEFAULT_OBJECT_CAP = 64 * 1024;
const MIN_OBJECT_CAP = 1024;
const MAX_OBJECT_CAP = 1024 * 1024;
const OBJECT_ENVELOPE_BYTES = 48; // {"t":1730000000000,"values":{}} + slack
const UNKNOWN_VALUE_BYTES = 128;
const STRING_VALUE_BYTES = 256;
const HISTORIAN_TYPES = new Set(['timebase', 'timescaledb']);
const SOURCE_TYPES = ['opcua', 'sparkplug', 'device', 'device-profile'];
const META_FIELDS = ['type', 'unit', 'description', 'range'];
const MAX_WARNINGS = 50;
const PREVIEW_MAX_TAGS = 50;

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

/**
 * Expand a binding into units:
 *   { id, binding, sourceType, sourceId, deviceId?, base, template, spDevice,
 *     tags: [{ address, name, meta }], error? }
 * `base` is the asset path (null for a legacy template unit). Units with an
 * `error` (unresolvable asset path) are skipped by the runtime and reported.
 */
function expandUnits(b, profiles) {
  const src = b?.source || {};
  const target = b?.target || {};
  const spDefault = target.device || slug(b.name || b.id);
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
      // Raw profile key -> this instance's substituted tag.
      const { tags: expanded } = profilesModel.expandProfileTags(profile, values);
      const byRaw = new Map();
      (profile.tags || []).forEach((t, i) => expanded[i] && byRaw.set(t.key, expanded[i]));
      const list = entries === 'all' ? (profile.tags || []).map((t) => ({ address: t.key })) : entries;
      for (const e of list) {
        const tag = byRaw.get(e.address) || (eff.tags || []).find((t) => t.key === e.address);
        if (!tag) continue;
        unit.tags.push({ address: tag.key, name: e.name || tag.property || tag.key, meta: pickMeta(tag, e) });
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
  if (src.type === 'device') {
    unit.deviceId = src.deviceId;
    const eff = effectiveOf(profiles, src.deviceId);
    const byKey = new Map((eff?.tags || []).map((t) => [t.key, t]));
    const entries = tagEntries(src);
    const list = entries === 'all' ? (eff?.tags || []).map((t) => ({ address: t.key })) : entries;
    for (const e of list) {
      const tag = byKey.get(e.address);
      unit.tags.push({ address: e.address, name: e.name || tag?.property || e.address, meta: pickMeta(tag, e) });
    }
  } else if (src.type !== 'sparkplug') {
    const entries = tagEntries(src);
    for (const e of entries === 'all' ? [] : entries) unit.tags.push({ address: e.address, name: e.name || e.address, meta: pickMeta(e) });
  }
  return [unit];
}

// ---- topics -------------------------------------------------------------------

const valueTopicOf = (unit, name) => (unit.base ? `${unit.base}/${slug(name)}` : targetTopic(unit.template, name));
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

/** The _meta document (without updatedAt; the runtime stamps it on publish). */
function metaDoc(unit) {
  const properties = {};
  const b = unit.binding;
  for (const t of unit.tags) {
    const p = { ...t.meta };
    if (b.source.type === 'opcua') p.source = { connectionId: unit.sourceId, address: t.address };
    else p.source = { deviceId: unit.deviceId ?? unit.sourceId, address: t.address };
    if (b.source.type === 'device-profile') p.source.profileId = b.source.profileId;
    properties[slug(t.name)] = p;
  }
  return { properties };
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

function objectEstimate(unit) {
  let worst = 0;
  let total = OBJECT_ENVELOPE_BYTES;
  for (const t of unit.tags) {
    const m = memberBytes(t);
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
    fail('source.type must be "device", "device-profile", "opcua" or "sparkplug" (mqtt tags compile to pipeline routes)');
  }
  const entries = tagEntries(source);
  if (source.type === 'device') {
    const device = effectiveOf(profiles, source.deviceId);
    if (!device) fail('device source needs an existing deviceId');
    if (entries !== 'all') {
      if (!entries.length) fail('device source needs tags[] (or "all")');
      const keys = new Set((device.tags || []).map((t) => t.key));
      const missing = entries.filter((t) => !keys.has(t.address)).map((t) => t.address);
      if (missing.length) fail(`device has no tag(s): ${missing.slice(0, 5).join(', ')}`);
    }
  }
  if (source.type === 'device-profile') {
    const profile = profiles.getIn('deviceProfiles', source.profileId);
    if (!profile) fail('device-profile source needs an existing profileId');
    if (entries !== 'all') {
      if (!entries.length) fail('device-profile source needs tags[] (profile tag keys, or "all")');
      const keys = new Set((profile.tags || []).map((t) => t.key));
      const missing = entries.filter((t) => !keys.has(t.address)).map((t) => t.address);
      if (missing.length) fail(`profile has no tag(s): ${missing.slice(0, 5).join(', ')}`);
    }
  }
  if (source.type === 'opcua' && (!source.connectionId || entries === 'all' || !entries.length)) {
    fail('opcua source needs connectionId and tags[]');
  }
  if (source.type === 'sparkplug' && (!source.brokerId || !source.group || !source.edge)) {
    fail('sparkplug source needs brokerId, group, edge');
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
 * Non-blocking save-time warnings: names that look like raw device addresses
 * and topics another binding already publishes. -> [{ type, topic, message, ... }]
 */
function bindingWarnings(b, profiles, { owners } = {}) {
  const warnings = [];
  const push = (w) => warnings.length < MAX_WARNINGS && warnings.push(w);
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
function previewBinding(b, profiles, { latest = () => null } = {}) {
  const target = b.target || {};
  const layout = layoutOf(b);
  const owners = topicOwners(profiles, b.id);
  const units = expandUnits(b, profiles);
  const now = Date.now();
  const tags = [];
  const objects = [];
  const meta = [];
  const status = [];
  let totalTags = 0;
  for (const unit of units) {
    totalTags += unit.tags.length;
    if (unit.error) continue;
    if (target.mode === 'mqtt') {
      if (target.statusTopic !== false) status.push(statusTopicOf(unit));
      if (target.metaTopic !== false && unit.tags.length && meta.length < 10) meta.push({ topic: metaTopicOf(unit), payload: { ...metaDoc(unit), updatedAt: now } });
    }
    const values = {};
    let t = 0;
    for (const tag of unit.tags) {
      const smp = latest(unit, tag.address, tag.name);
      const e = smp ? { v: smp.v, q: smp.q ?? 192 } : { v: null, q: 0 };
      if (smp?.t > t) t = smp.t;
      if (layout === 'object-per-asset') {
        values[slug(tag.name)] = objectMember(e, tag.meta.unit);
        continue;
      }
      if (tags.length >= PREVIEW_MAX_TAGS) continue;
      const entry = { name: tag.name, address: tag.address, unitId: unit.id, hasValue: Boolean(smp) };
      if (target.mode === 'sparkplug') {
        entry.topic = `spBv1.0/${target.group}/DDATA/${target.edge}/${unit.spDevice}`;
        entry.metric = tag.name;
        entry.payload = { name: tag.name, value: e.v, type: smp?.type || tag.meta.type || null, properties: sparkplugProps(tag.meta) };
      } else {
        entry.topic = valueTopicOf(unit, tag.name);
        entry.payload = target.format === 'envelope' ? envelope(e.v, smp?.t || now, e.q, tag.meta.unit) : e.v;
        const hit = owners.get(`${target.brokerId}\u0000${entry.topic}`);
        if (hit) entry.collisions = hit;
      }
      tags.push(entry);
    }
    if (layout === 'object-per-asset' && objects.length < PREVIEW_MAX_TAGS) {
      const payload = { t: t || now, values };
      const topic = objectTopicOf(unit);
      const est = objectEstimate(unit);
      const o = { topic, unitId: unit.id, payload, bytes: Buffer.byteLength(JSON.stringify(payload)), worstCaseBytes: est.total, capBytes: objectCapOf(b) };
      const hit = owners.get(`${target.brokerId}\u0000${topic}`);
      if (hit) o.collisions = hit;
      objects.push(o);
    }
  }
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
    status: status.slice(0, PREVIEW_MAX_TAGS),
    warnings: bindingWarnings(b, profiles, { owners })
  };
}

/** Sparkplug metric properties from tag metadata (conventional keys engUnit/engLow/engHigh/description). */
function sparkplugProps(meta) {
  if (!meta) return undefined;
  const p = {};
  if (meta.unit) p.engUnit = String(meta.unit);
  if (meta.description) p.description = String(meta.description);
  if (meta.range && Number.isFinite(Number(meta.range.min)) && Number.isFinite(Number(meta.range.max))) {
    p.engLow = Number(meta.range.min);
    p.engHigh = Number(meta.range.max);
  }
  return Object.keys(p).length ? p : undefined;
}

module.exports = {
  BindingValidationError,
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
  sparkplugProps
};
