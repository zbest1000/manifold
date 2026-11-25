'use strict';

const { isSecretKey } = require('./secrets');
const { looksLikeRawAddress } = require('./unsLint');

/**
 * Binding context - the pure helpers behind "choose what to map" and "add
 * context to tags" (docs/wiki/Mapping-to-the-UNS.md, "Choosing what to map"
 * and "Adding context"). No I/O. bindingModel.js composes these into units;
 * tagBindings.js runs the compiled result.
 *
 *   per-tag entry      { address, name?, enabled?, ...overrides }
 *   source.select      { include?, exclude?, pollGroups?, types?, withProperty? }   (tags: 'all' only)
 *   source.overrides   { <tagKey>: { ...overrides } }
 *   overrides          name, displayName, description, unit, range, dataType, scale, offset,
 *                      precision, states, statesMode, limits, deadband, context, enabled
 *   target.fields      subset/order of v t q u name src ctx (must include v)
 *   target.metaFields  subset of type unit description range source context displayName limits states
 *   target.context     { key: value } with placeholders {device} {deviceId} {protocol} {host} {param:<name>}
 *   target.contextMode 'meta' (default) | 'payload' | 'none'
 *
 * Value pipeline (per sample): read -> device decode -> scale/offset -> cast
 * (dataType) -> deadband/RBE -> publish; precision and states are applied to
 * the PUBLISHED representation only (change detection uses the unrounded,
 * unlabelled value). A failed scale or cast publishes Bad quality (q 0) with
 * value null and a `reason`; it never publishes a wrong value.
 *
 * Limits are carried as metadata only: there is no alarm engine.
 */

const FIELD_OPTIONS = ['v', 't', 'q', 'u', 'name', 'src', 'ctx'];
const DEFAULT_FIELDS = Object.freeze(['v', 't', 'q', 'u']);
const DEFAULT_MEMBER_FIELDS = Object.freeze(['v', 'q', 'u']);
const META_FIELD_OPTIONS = ['type', 'unit', 'description', 'range', 'source', 'context', 'displayName', 'limits', 'states'];
const CONTEXT_MODES = ['meta', 'payload', 'none'];
const STATES_MODES = ['label-field', 'replace'];
const DATA_TYPES = ['number', 'integer', 'boolean', 'string'];
const LIMIT_KEYS = ['lolo', 'lo', 'hi', 'hihi'];
const OVERRIDE_KEYS = [
  'name', 'displayName', 'description', 'unit', 'range', 'dataType', 'scale', 'offset',
  'precision', 'states', 'statesMode', 'limits', 'deadband', 'context', 'enabled'
];
const SELECT_KEYS = ['include', 'exclude', 'pollGroups', 'types', 'withProperty'];

const CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_CONTEXT_KEYS = 32;
const MAX_CONTEXT_VALUE = 256;
const MAX_CONTEXT_BYTES = 4096;
const MAX_PAYLOAD_CONTEXT_BYTES = 1024;
const MAX_STATES = 256;
const MAX_STATE_KEY = 64;
const MAX_STATE_LABEL = 128;
const MAX_NAME = 128;
const MAX_DISPLAY_NAME = 128;
const MAX_META_TEXT = 512;
const MAX_PRECISION = 10;
const MAX_PATTERNS = 64;
const MAX_PATTERN_LEN = 128;
const REASON_BYTES = 96;

// {device} {deviceId} {protocol} {host} {param:<name>}
const CTX_PLACEHOLDER_RE = /\{(param:)?([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const DEVICE_PLACEHOLDERS = ['device', 'deviceId', 'protocol', 'host'];

// Sparkplug metric properties the binding sets itself; context keys never replace them.
const SPARKPLUG_STANDARD_PROPS = new Set(['engUnit', 'engLow', 'engHigh', 'description', 'displayName', 'limitLoLo', 'limitLo', 'limitHi', 'limitHiHi']);

const isPlainObject = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v));

// ---- context ---------------------------------------------------------------------

/** Validate a context object -> error string or null. `where` names it in the message. */
function contextError(ctx, where) {
  if (ctx === undefined || ctx === null) return null;
  if (!isPlainObject(ctx)) return `${where} must be an object of { key: string | number | boolean }`;
  const keys = Object.keys(ctx);
  if (keys.length > MAX_CONTEXT_KEYS) return `${where} has ${keys.length} keys; at most ${MAX_CONTEXT_KEYS} are allowed`;
  for (const k of keys) {
    if (!CONTEXT_KEY_RE.test(k)) {
      return `${where} key "${String(k).slice(0, 80)}" is invalid: 1-64 characters of A-Z a-z 0-9 _ . -, starting with a letter`;
    }
    const v = ctx[k];
    if (typeof v === 'string') {
      if (v.length > MAX_CONTEXT_VALUE) return `${where}.${k} is ${v.length} characters; at most ${MAX_CONTEXT_VALUE} are allowed`;
    } else if (!isFiniteNumber(v) && typeof v !== 'boolean') {
      return `${where}.${k} must be a string, a finite number or a boolean`;
    }
  }
  const bytes = bytesOf(ctx);
  if (bytes > MAX_CONTEXT_BYTES) return `${where} is ${bytes} bytes as JSON; at most ${MAX_CONTEXT_BYTES} bytes are allowed`;
  return null;
}

/** Placeholder tokens used by a context's string values: Set('device', 'param:line', ...). */
function contextPlaceholders(ctx) {
  const out = new Map(); // token -> first key using it
  if (!isPlainObject(ctx)) return out;
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(CTX_PLACEHOLDER_RE)) {
      const token = `${m[1] ? 'param:' : ''}${m[2]}`;
      if (!out.has(token)) out.set(token, k);
    }
  }
  return out;
}

/** Placeholders a source type may use in target.context: ['device', ..., 'param:line']. */
function allowedPlaceholders(sourceType, profile) {
  if (sourceType === 'device') return [...DEVICE_PLACEHOLDERS];
  if (sourceType === 'device-profile') return [...DEVICE_PLACEHOLDERS, ...(profile?.params || []).map((p) => `param:${p.name}`)];
  return [];
}

/** Substitute placeholders in a context -> new frozen object; throws naming the key on a missing value. */
function resolveContext(ctx, vars) {
  if (!isPlainObject(ctx) || !Object.keys(ctx).length) return null;
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] =
      typeof v === 'string'
        ? v.replace(CTX_PLACEHOLDER_RE, (whole, param, n) => {
            const token = `${param ? 'param:' : ''}${n}`;
            if (!Object.hasOwn(vars, token) || vars[token] === undefined || vars[token] === null) {
              throw new Error(`target.context.${k}: no value for placeholder {${token}}`);
            }
            return String(vars[token]);
          })
        : v;
  }
  return Object.freeze(out);
}

/** Context placeholder values for one device (effective) and its profile params. */
function contextVars(device, paramValues) {
  const vars = {};
  if (device) {
    vars.device = device.name || device.id;
    vars.deviceId = device.id;
    vars.protocol = device.protocol;
    vars.host = device.host;
  }
  for (const [k, v] of Object.entries(paramValues || {})) vars[`param:${k}`] = v;
  return vars;
}

/** Device-level context: only valid entries are used. -> { context, ignored: [key] } */
function sanitizeDeviceContext(ctx) {
  if (!isPlainObject(ctx)) return { context: null, ignored: ctx === undefined || ctx === null ? [] : ['(not an object)'] };
  const out = {};
  const ignored = [];
  for (const [k, v] of Object.entries(ctx)) {
    const ok = CONTEXT_KEY_RE.test(k) && ((typeof v === 'string' && v.length <= MAX_CONTEXT_VALUE) || isFiniteNumber(v) || typeof v === 'boolean');
    if (ok && Object.keys(out).length < MAX_CONTEXT_KEYS) out[k] = v;
    else ignored.push(k);
  }
  return { context: Object.keys(out).length ? out : null, ignored };
}

/** Context keys that look like credentials (same heuristic as the audit-log redaction). */
function credentialLikeKeys(ctx) {
  return isPlainObject(ctx) ? Object.keys(ctx).filter((k) => isSecretKey(k)) : [];
}

// ---- selection rules ---------------------------------------------------------------

function globToRegExp(p) {
  const src = String(p)
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`, 'i');
}

/** source.select -> compiled rules, or null when there is no select. */
function compileSelect(select) {
  if (!isPlainObject(select)) return null;
  const pats = (list) => (Array.isArray(list) ? list.map((p) => ({ pattern: String(p), re: globToRegExp(p) })) : null);
  return {
    include: Array.isArray(select.include) && select.include.length ? pats(select.include) : null,
    exclude: pats(select.exclude) || [],
    pollGroups: Array.isArray(select.pollGroups) && select.pollGroups.length ? new Set(select.pollGroups.map(String)) : null,
    types: Array.isArray(select.types) && select.types.length ? new Set(select.types.map((t) => String(t).toLowerCase())) : null,
    withProperty: typeof select.withProperty === 'boolean' ? select.withProperty : undefined
  };
}

const globHit = (list, tag) => list.find((p) => p.re.test(String(tag.key ?? '')) || (tag.property ? p.re.test(String(tag.property)) : false));

/**
 * Apply compiled rules to one effective tag. Order: include (when present),
 * then the filters (pollGroups, types, withProperty), then exclude.
 * -> { matched: true } | { matched: false, rule, pattern? }
 */
function selectTag(cs, tag) {
  if (!cs) return { matched: true };
  if (cs.include && !globHit(cs.include, tag)) return { matched: false, rule: 'include' };
  if (cs.pollGroups && !cs.pollGroups.has(String(tag.pollGroup || 'default'))) return { matched: false, rule: 'pollGroups' };
  if (cs.types && !cs.types.has(String(tag.type || '').toLowerCase())) return { matched: false, rule: 'types' };
  if (cs.withProperty === true && !tag.property) return { matched: false, rule: 'withProperty' };
  if (cs.withProperty === false && tag.property) return { matched: false, rule: 'withProperty' };
  const ex = globHit(cs.exclude, tag);
  if (ex) return { matched: false, rule: 'exclude', pattern: ex.pattern };
  return { matched: true };
}

function selectError(select) {
  if (!isPlainObject(select)) return 'source.select must be an object { include?, exclude?, pollGroups?, types?, withProperty? }';
  for (const k of Object.keys(select)) if (!SELECT_KEYS.includes(k)) return `source.select.${k} is not a selection rule (allowed: ${SELECT_KEYS.join(', ')})`;
  for (const k of ['include', 'exclude', 'pollGroups', 'types']) {
    const v = select[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `source.select.${k} must be an array of strings`;
    if (v.length > MAX_PATTERNS) return `source.select.${k} has ${v.length} entries; at most ${MAX_PATTERNS} are allowed`;
    for (const p of v) {
      if (typeof p !== 'string' || !p || p.length > MAX_PATTERN_LEN) return `source.select.${k} entries must be non-empty strings of at most ${MAX_PATTERN_LEN} characters`;
    }
  }
  if (select.withProperty !== undefined && typeof select.withProperty !== 'boolean') return 'source.select.withProperty must be a boolean';
  return null;
}

// ---- overrides ---------------------------------------------------------------------

function deadbandError(db, where) {
  if (db === undefined || db === null) return null;
  if (typeof db === 'number') return Number.isFinite(db) && db >= 0 ? null : `${where}.deadband must be a number >= 0`;
  if (!isPlainObject(db)) return `${where}.deadband must be a number (absolute) or { type: 'absolute'|'percent', value }`;
  const type = db.type ?? 'absolute';
  if (!['absolute', 'percent'].includes(type)) return `${where}.deadband.type must be "absolute" or "percent"`;
  const v = Number(db.value);
  if (!Number.isFinite(v) || v < 0) return `${where}.deadband.value must be a number >= 0`;
  if (type === 'percent' && v > 100) return `${where}.deadband: a percent deadband must be 0..100`;
  return null;
}

function textError(v, max, what) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return `${what} must be a string`;
  if (v.length > max) return `${what} is ${v.length} characters; at most ${max} are allowed`;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(v)) return `${what} must not contain control characters`;
  return null;
}

/**
 * Validate one override set (a tag entry or source.overrides[key]) -> error string or null.
 * `strict` rejects unknown keys (source.overrides); entries keep unknown keys
 * for backward compatibility with stored bindings.
 */
function overrideError(o, where, { strict = false } = {}) {
  if (!isPlainObject(o)) return `${where} must be an object`;
  if (strict) {
    for (const k of Object.keys(o)) if (!OVERRIDE_KEYS.includes(k)) return `${where}.${k} is not an override (allowed: ${OVERRIDE_KEYS.join(', ')})`;
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return `${where}.enabled must be a boolean`;
  if (o.name !== undefined && o.name !== null && o.name !== '') {
    const e = textError(o.name, MAX_NAME, `${where}.name`);
    if (e) return e;
  }
  for (const [k, max] of [['displayName', MAX_DISPLAY_NAME], ['description', MAX_META_TEXT], ['unit', MAX_META_TEXT]]) {
    const e = textError(o[k], max, `${where}.${k}`);
    if (e) return e;
  }
  if (o.range !== undefined && o.range !== null) {
    const r = o.range;
    if (!isPlainObject(r) || !Number.isFinite(Number(r.min)) || !Number.isFinite(Number(r.max)) || Number(r.min) >= Number(r.max)) {
      return `${where}.range must be { min, max } with finite numbers and min < max`;
    }
  }
  if (o.dataType !== undefined && o.dataType !== null && !DATA_TYPES.includes(o.dataType)) return `${where}.dataType must be one of ${DATA_TYPES.join(', ')}`;
  if (o.scale !== undefined && o.scale !== null && (!isFiniteNumber(o.scale) || o.scale === 0)) return `${where}.scale must be a non-zero finite number`;
  if (o.offset !== undefined && o.offset !== null && !isFiniteNumber(o.offset)) return `${where}.offset must be a finite number`;
  if (o.precision !== undefined && o.precision !== null && (!Number.isInteger(o.precision) || o.precision < 0 || o.precision > MAX_PRECISION)) {
    return `${where}.precision must be an integer 0..${MAX_PRECISION} (decimal places)`;
  }
  if (o.states !== undefined && o.states !== null) {
    if (!isPlainObject(o.states)) return `${where}.states must be an object { "<raw value>": "<label>" }`;
    const keys = Object.keys(o.states);
    if (keys.length > MAX_STATES) return `${where}.states has ${keys.length} entries; at most ${MAX_STATES} are allowed`;
    for (const k of keys) {
      if (!k || k.length > MAX_STATE_KEY) return `${where}.states key "${k.slice(0, 80)}" must be 1-${MAX_STATE_KEY} characters`;
      const e = textError(o.states[k], MAX_STATE_LABEL, `${where}.states["${k}"]`);
      if (e) return e;
      if (o.states[k] === null || o.states[k] === undefined || o.states[k] === '') return `${where}.states["${k}"] must be a non-empty label`;
    }
  }
  if (o.statesMode !== undefined && o.statesMode !== null && !STATES_MODES.includes(o.statesMode)) return `${where}.statesMode must be "label-field" or "replace"`;
  if (o.limits !== undefined && o.limits !== null) {
    if (!isPlainObject(o.limits)) return `${where}.limits must be { lolo?, lo?, hi?, hihi? }`;
    for (const k of Object.keys(o.limits)) {
      if (!LIMIT_KEYS.includes(k)) return `${where}.limits.${k} is not a limit (allowed: ${LIMIT_KEYS.join(', ')})`;
      if (!isFiniteNumber(o.limits[k])) return `${where}.limits.${k} must be a finite number`;
    }
    const seq = LIMIT_KEYS.filter((k) => o.limits[k] !== undefined);
    for (let i = 1; i < seq.length; i++) {
      if (o.limits[seq[i - 1]] > o.limits[seq[i]]) return `${where}.limits must be ordered lolo <= lo <= hi <= hihi (${seq[i - 1]} ${o.limits[seq[i - 1]]} > ${seq[i]} ${o.limits[seq[i]]})`;
    }
  }
  const db = deadbandError(o.deadband, where);
  if (db) return db;
  return contextError(o.context, `${where}.context`);
}

/** Device-level limits/states/displayName: used only when valid (the device API does not check them). */
function validDeviceField(name, v) {
  if (v === undefined || v === null || v === '') return false;
  return !overrideError({ [name]: v }, 'x');
}

/** Normalized per-tag deadband: undefined (inherit), null (none) or { type, value }. */
function normDeadband(db) {
  if (db === undefined || db === null) return undefined;
  if (typeof db === 'number') return db > 0 ? { type: 'absolute', value: db } : null;
  const value = Number(db.value);
  return value > 0 ? { type: db.type === 'percent' ? 'percent' : 'absolute', value } : null;
}

// ---- transforms ---------------------------------------------------------------------

const OUT_TYPES = { number: 'float64', integer: 'int64', boolean: 'bool', string: 'string' };

/** Transform plan for a tag or null: { linear, scale, offset, dataType }. */
function transformPlan({ scale, offset, dataType }) {
  const linear = (scale !== undefined && scale !== null) || (offset !== undefined && offset !== null);
  if (!linear && !dataType) return null;
  return { linear, scale: linear ? Number(scale ?? 1) : 1, offset: linear ? Number(offset ?? 0) : 0, dataType: dataType || null };
}

function describeValue(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

const BOOL_STRINGS = { true: true, false: false, 1: true, 0: false, on: true, off: false, yes: true, no: false };

/**
 * Run a transform plan on one raw value, writing into `out` (reused, no
 * per-sample allocation): out.v, out.q, out.r (reason, only on failure).
 * Order: scale/offset, then cast. Null/undefined values pass through untouched.
 */
function applyTransform(plan, v, q, out) {
  out.v = v;
  out.q = q;
  out.r = undefined;
  if (!plan || v === null || v === undefined) return out;
  let x = typeof v === 'bigint' ? Number(v) : v;
  if (plan.linear) {
    const n = toNumber(x);
    if (!Number.isFinite(n)) return bad(out, `scale/offset needs a numeric value, got ${describeValue(v)}`);
    x = n * plan.scale + plan.offset;
  }
  switch (plan.dataType) {
    case 'number': {
      const n = toNumber(x);
      if (!Number.isFinite(n)) return bad(out, `cannot cast ${describeValue(x)} to number`);
      x = n;
      break;
    }
    case 'integer': {
      const n = toNumber(x);
      if (!Number.isFinite(n)) return bad(out, `cannot cast ${describeValue(x)} to integer`);
      x = Math.sign(n) * Math.round(Math.abs(n)); // nearest, half away from zero
      if (Object.is(x, -0)) x = 0;
      break;
    }
    case 'boolean': {
      if (typeof x === 'boolean') break;
      if (typeof x === 'number' && Number.isFinite(x)) {
        x = x !== 0;
        break;
      }
      const k = typeof x === 'string' ? x.trim().toLowerCase() : null;
      if (k !== null && Object.hasOwn(BOOL_STRINGS, k)) {
        x = BOOL_STRINGS[k];
        break;
      }
      return bad(out, `cannot cast ${describeValue(x)} to boolean`);
    }
    case 'string':
      x = typeof x === 'object' ? JSON.stringify(x) : String(x);
      break;
    default:
      break;
  }
  out.v = x;
  return out;
}

function bad(out, reason) {
  out.v = null;
  out.q = 0;
  out.r = reason;
  return out;
}

/** The published representation of a value: precision rounding, then states 'replace'. */
function formatValue(tag, v) {
  if (!tag) return v;
  if (tag.labels && tag.statesMode === 'replace' && v !== null && v !== undefined) {
    const l = tag.labels.get(String(v));
    if (l !== undefined) return l;
  }
  if (tag.precision !== undefined && typeof v === 'number' && Number.isFinite(v)) return Number(v.toFixed(tag.precision));
  return v;
}

/** The `label` for a value in 'label-field' mode, or undefined. */
function labelOf(tag, v) {
  if (!tag?.labels || tag.statesMode === 'replace' || v === null || v === undefined) return undefined;
  return tag.labels.get(String(v));
}

/**
 * Envelope (topic-per-tag) or object member built from a field list. `ts` is
 * only used for 't'. A `label` follows `v` when the tag has states in
 * 'label-field' mode; `reason` is appended when a transform failed.
 */
function buildFields(fields, tag, value, ts, q, reason) {
  const p = {};
  for (const f of fields) {
    switch (f) {
      case 'v': {
        p.v = formatValue(tag, value);
        const l = labelOf(tag, value);
        if (l !== undefined) p.label = l;
        break;
      }
      case 't':
        p.t = ts;
        break;
      case 'q':
        p.q = q;
        break;
      case 'u':
        if (tag?.meta?.unit) p.u = tag.meta.unit;
        break;
      case 'name':
        p.name = tag ? tag.name : undefined;
        break;
      case 'src':
        p.src = tag ? tag.address : undefined;
        break;
      case 'ctx':
        if (tag?.ctx) p.ctx = tag.ctx;
        break;
      default:
        break;
    }
  }
  if (reason !== undefined) p.reason = reason;
  return p;
}

// ---- sizing ---------------------------------------------------------------------

/** Worst-case JSON bytes of one field-list payload/member (no surrounding name). */
function fieldBytes(fields, tag, valueBytes) {
  let n = 2;
  const typeBytes = valueBytes(tag?.outType || tag?.meta?.type);
  let maxLabel = 0;
  if (tag?.labels) for (const l of tag.labels.values()) maxLabel = Math.max(maxLabel, JSON.stringify(l).length);
  for (const f of fields) {
    if (f === 'v') {
      n += 5 + (tag?.labels && tag.statesMode === 'replace' ? Math.max(typeBytes, maxLabel) : typeBytes);
      if (tag?.labels && tag.statesMode !== 'replace') n += maxLabel + 9;
    } else if (f === 't') n += 18;
    else if (f === 'q') n += 8;
    else if (f === 'u') n += tag?.meta?.unit ? JSON.stringify(String(tag.meta.unit)).length + 5 : 0;
    else if (f === 'name') n += JSON.stringify(String(tag?.name ?? '')).length + 8;
    else if (f === 'src') n += JSON.stringify(String(tag?.address ?? '')).length + 7;
    else if (f === 'ctx') n += tag?.ctx ? bytesOf(tag.ctx) + 7 : 0;
  }
  if (tag?.plan) n += REASON_BYTES;
  return n;
}

// ---- names (suggest) -----------------------------------------------------------------

// Address shapes beyond unsLint's: Modbus area prefixes with a number, S7
// absolute addresses (%IX0.0, MW10, I0.1), Logix bracket-only names, OPC UA numeric ids.
const EXTRA_RAW_RES = [
  /^(holding|input|inputs?|coils?|discrete|hr|ir|di|co|register|reg)[:_.\-\s]?\d+([:.]\d+)?$/i,
  /^%?[IQM][XBWD]?\d+(\.\d+)?$/i,
  /^%?DB\d+([.,]DB[XBWD]?\d+(\.\d+)?)?$/i,
  /^(i|g|b)=\d+$/i,
  /^\d+$/
];

const isAddressLike = (s) => looksLikeRawAddress(s) || EXTRA_RAW_RES.some((re) => re.test(s));

/** camelCase from separators and case: "Motor_Speed" -> motorSpeed, "TT101_PV" -> tt101Pv. */
function camelCase(s) {
  const words = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      const lower = /^[A-Z0-9]+$/.test(w) ? w.toLowerCase() : w;
      return i === 0 ? lower.charAt(0).toLowerCase() + lower.slice(1) : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * Suggested published name for one tag -> { name, basis, reason? }.
 * property wins; else a cleaned form of the key (address-like prefixes
 * stripped, camelCase). Raw addresses get no suggestion: nothing is invented.
 */
function suggestName(tag) {
  if (tag.property) return { name: String(tag.property), basis: 'property' };
  const key = String(tag.key ?? tag.address ?? '');
  // OPC UA string node ids carry a browse path (ns=2;s=Line1.Motor.RPM); numeric ids do not.
  if (/^ns=\d+;s=./i.test(key)) {
    const last = key.replace(/^ns=\d+;s=/i, '').split(/[./]/).filter(Boolean).pop() || '';
    const name = last && !isAddressLike(last) ? camelCase(last) : '';
    return name && !/^\d/.test(name) ? { name, basis: 'key' } : { name: null, basis: 'none', reason: 'raw-address' };
  }
  if (!key || isAddressLike(key)) return { name: null, basis: 'none', reason: 'raw-address' };
  const stripped = key
    .replace(/^%?DB\d+[._]/i, '')
    .replace(/^(holding|input|coil|discrete|hr|ir|di|co)[_:.-]?\d*[_:.-]+(?=[A-Za-z])/i, '');
  if (!stripped || isAddressLike(stripped)) return { name: null, basis: 'none', reason: 'raw-address' };
  const name = camelCase(stripped);
  if (!name) return { name: null, basis: 'none', reason: 'no-letters' };
  if (/^\d/.test(name)) return { name: null, basis: 'none', reason: 'starts-with-digit' };
  return { name, basis: 'key' };
}

// ---- schema ---------------------------------------------------------------------

/** GET /api/tags/bindings/schema: the server's truth for the mapping forms. */
function bindingSchema({ defaultObjectCap, minObjectCap, maxObjectCap, previewMaxTags }) {
  const text = (maxLength, description) => ({ type: 'string', maxLength, description });
  return {
    version: 1,
    sourceTypes: ['device', 'device-profile', 'opcua', 'sparkplug', 'mqtt'],
    mqttSource: {
      description: 'An MQTT topic tree as a source: each entry reads one value from a topic payload',
      fields: {
        brokerId: { type: 'string', required: true },
        tags: { type: 'array | "all"', description: '[{ address: <topic>, name?, field?, staleAfterMs?, ...overrides }] or "all" with filter' },
        filter: { type: 'mqtt filter', description: 'tags: "all": every topic matching it, including topics that appear later (at most 2000)' },
        field: { type: 'dot path', description: 'Where the value is in a JSON payload (default: the payload; value/time/quality envelopes are read automatically)' },
        staleAfterMs: { type: 'integer', min: 1000, max: 86400000, description: 'No message for this long: Bad with reason "stale" once; the next message is Good again' }
      },
      envelopes: ['{ v, t?, q?, u? }', '{ value, timestamp?, quality?, unit? }'],
      select: ['include', 'exclude']
    },
    tagEntry: {
      description: 'An item of source.tags: a string (address) or this object. Disabled entries are kept but not monitored, published, counted or listed in _meta.',
      fields: {
        address: { type: 'string', required: true, description: 'Device tag key / profile tag key / OPC UA node id' },
        enabled: { type: 'boolean', default: true }
      },
      overrides: 'all keys of `overrides`'
    },
    overrides: {
      name: { ...text(MAX_NAME, 'Published property name (topic segment / object member / _meta key)'), fallback: 'tag property, else tag key' },
      displayName: { ...text(MAX_DISPLAY_NAME, 'Human-readable name (metadata only)'), fallback: 'device tag displayName' },
      description: { ...text(MAX_META_TEXT, 'Description'), fallback: 'device tag description' },
      unit: { ...text(MAX_META_TEXT, 'Engineering unit (u in payloads)'), fallback: 'device tag unit' },
      range: { type: 'object', shape: { min: 'number', max: 'number' }, rule: 'finite, min < max; engineering units after scale/offset', fallback: 'device tag range' },
      dataType: { type: 'enum', values: DATA_TYPES, description: 'Cast applied to the published value; a failed cast publishes q 0 with a reason, never a wrong value' },
      scale: { type: 'number', rule: 'finite, non-zero', description: 'value * scale + offset, applied before the cast and the deadband' },
      offset: { type: 'number', rule: 'finite' },
      precision: { type: 'integer', min: 0, max: MAX_PRECISION, description: 'Decimal places, publishing only (change detection uses the unrounded value)' },
      states: { type: 'map', keyMaxLength: MAX_STATE_KEY, valueMaxLength: MAX_STATE_LABEL, maxEntries: MAX_STATES, description: '{ "<raw value as string>": "<label>" }', fallback: 'device tag states' },
      statesMode: { type: 'enum', values: STATES_MODES, default: 'label-field', description: 'label-field: raw value + `label`; replace: the label is the value' },
      limits: { type: 'object', keys: LIMIT_KEYS, rule: 'finite numbers, lolo <= lo <= hi <= hihi', description: 'Metadata only; there is no alarm engine', fallback: 'device tag limits' },
      deadband: { type: 'number | { type: "absolute"|"percent", value }', description: 'Per-tag report-by-exception band; 0 disables the binding band for this tag', fallback: 'binding rbe.deadband' },
      context: { type: 'context', description: 'Free-form key/values merged over the device tag context (mapping wins key by key)' },
      enabled: { type: 'boolean', default: true }
    },
    select: {
      appliesTo: 'source.tags === "all" on device and device-profile sources',
      fields: {
        include: { type: 'array', items: 'glob', maxItems: MAX_PATTERNS },
        exclude: { type: 'array', items: 'glob', maxItems: MAX_PATTERNS },
        pollGroups: { type: 'array', items: 'string', maxItems: MAX_PATTERNS },
        types: { type: 'array', items: 'string', maxItems: MAX_PATTERNS, description: 'Device tag types, case-insensitive' },
        withProperty: { type: 'boolean', description: 'true: only tags with a property name; false: only tags without' }
      },
      glob: '* any run, ? one character; case-insensitive; matched against the tag key AND its property',
      order: ['include', 'pollGroups', 'types', 'withProperty', 'exclude'],
      overrides: 'source.overrides = { <tagKey>: overrides } (enabled:false deselects a rule-matched tag)'
    },
    target: {
      fields: {
        options: FIELD_OPTIONS,
        required: ['v'],
        default: DEFAULT_FIELDS,
        objectMemberDefault: DEFAULT_MEMBER_FIELDS,
        appliesTo: 'mqtt envelope format and object-per-asset members (plain payloads are the bare value)',
        descriptions: {
          v: 'value', t: 'timestamp (ms)', q: 'quality (192 good, 0 bad)', u: 'engineering unit (when the tag has one)',
          name: 'published property name', src: 'source address (tag key / node id)', ctx: 'merged asset + tag context'
        },
        warnWithout: { q: 'consumers cannot tell a dead value from a live one' }
      },
      metaFields: { options: META_FIELD_OPTIONS, default: META_FIELD_OPTIONS },
      contextMode: { values: CONTEXT_MODES, default: 'meta' },
      context: { type: 'context', description: 'Asset-level context; string values may use placeholders' }
    },
    placeholders: {
      device: DEVICE_PLACEHOLDERS.map((p) => `{${p}}`),
      'device-profile': [...DEVICE_PLACEHOLDERS.map((p) => `{${p}}`), '{param:<name>}'],
      opcua: [],
      sparkplug: [],
      mqtt: [],
      descriptions: { '{device}': 'device name', '{deviceId}': 'device id', '{protocol}': 'driver protocol', '{host}': 'device host', '{param:<name>}': 'profile parameter of the instance' }
    },
    limits: {
      contextKeyPattern: CONTEXT_KEY_RE.source,
      maxContextKeys: MAX_CONTEXT_KEYS,
      maxContextKeyLength: 64,
      maxContextValueLength: MAX_CONTEXT_VALUE,
      maxContextBytes: MAX_CONTEXT_BYTES,
      maxPayloadContextBytes: MAX_PAYLOAD_CONTEXT_BYTES,
      maxStates: MAX_STATES,
      maxNameLength: MAX_NAME,
      maxPrecision: MAX_PRECISION,
      maxSelectPatterns: MAX_PATTERNS,
      maxObjectBytes: { default: defaultObjectCap, min: minObjectCap, max: maxObjectCap },
      previewMaxTags: previewMaxTags
    },
    statesModes: STATES_MODES,
    dataTypes: DATA_TYPES,
    contextModes: CONTEXT_MODES,
    valuePipeline: ['read', 'device decode', 'scale/offset', 'cast (dataType)', 'deadband / report by exception', 'precision + states (published form only)', 'publish'],
    origins: ['device', 'server', 'mapping', 'default']
  };
}

module.exports = {
  FIELD_OPTIONS,
  DEFAULT_FIELDS,
  DEFAULT_MEMBER_FIELDS,
  META_FIELD_OPTIONS,
  CONTEXT_MODES,
  STATES_MODES,
  DATA_TYPES,
  LIMIT_KEYS,
  OVERRIDE_KEYS,
  OUT_TYPES,
  CONTEXT_KEY_RE,
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE,
  MAX_CONTEXT_BYTES,
  MAX_PAYLOAD_CONTEXT_BYTES,
  SPARKPLUG_STANDARD_PROPS,
  isPlainObject,
  bytesOf,
  contextError,
  contextPlaceholders,
  allowedPlaceholders,
  resolveContext,
  contextVars,
  sanitizeDeviceContext,
  credentialLikeKeys,
  globToRegExp,
  compileSelect,
  selectTag,
  selectError,
  overrideError,
  validDeviceField,
  normDeadband,
  transformPlan,
  applyTransform,
  formatValue,
  labelOf,
  buildFields,
  fieldBytes,
  suggestName,
  isAddressLike,
  camelCase,
  bindingSchema
};
