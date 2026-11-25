'use strict';

const { messageQuality, messageTime } = require('./pipelineEngine');
const { matchParts, filterProblem } = require('./mqttMatch');

/**
 * MQTT-topic sources for mappings (pure helpers; the runtime is in
 * ./tagBindings.js, the broker state in ./tagSources/mqttSource.js).
 *
 *   source: { type: 'mqtt', brokerId,
 *             tags: [{ address: <topic>, name?, field?, staleAfterMs?, ...overrides }]
 *           | tags: 'all', filter: 'raw/plant1/#', select?: { include?, exclude? },
 *             overrides?: { <topic>: { name?, field?, ...overrides } },
 *             field?: <default dot path>, staleAfterMs?: <ms> }
 *
 * Each entry reads ONE value from a topic's payload:
 *   - `field` is a dot path into a JSON payload (`a.b.0.c`);
 *   - without a field the payload itself is the value when it is a scalar;
 *   - a value/time/quality envelope ({ v, t?, q?, u? } or { value, timestamp?, quality?, unit? },
 *     nothing else in it) gives value, source time, quality and unit automatically;
 *   - any other JSON object without a field is published as a structured value.
 * Published names keep the topic hierarchy: a name may contain "/" (each level is cleaned like
 * a name), so `raw/plant1/line1/temp` under the filter `raw/plant1/#` publishes as
 * `<assetPath>/line1/temp`.
 */

const MAX_FILTER_TOPICS = 2000; // topics one filter-mode mapping may pick up
const MAX_FIELD_PATH = 256;
const ENV_V = new Set(['v', 't', 'q', 'u']);
const ENV_VALUE = new Set(['value', 'timestamp', 'quality', 'unit']);

const split = (s) => String(s).split('/');

/** Is there a topic both filters can match? (wildcards on both sides; $-rules ignored: conservative) */
function filtersOverlap(a, b) {
  const A = split(a);
  const B = split(b);
  for (let i = 0; ; i++) {
    const x = A[i];
    const y = B[i];
    if (x === '#' || y === '#') return true;
    if (x === undefined || y === undefined) return x === y;
    if (x !== '+' && y !== '+' && x !== y) return false;
  }
}

/** Does subscription filter `s` receive every topic filter `f` can match? */
function filterCovers(s, f) {
  const S = split(s);
  const F = split(f);
  for (let i = 0; ; i++) {
    const x = S[i];
    const y = F[i];
    if (x === '#') return true;
    if (x === undefined || y === undefined) return x === y;
    if (y === '#') return false;
    if (x === '+') {
      if (i === 0 && y.startsWith('$')) return false;
      continue;
    }
    if (y === '+' || x !== y) return false;
  }
}

/** The literal levels of a filter before its first wildcard. */
function filterPrefix(filter) {
  const out = [];
  for (const seg of split(filter)) {
    if (seg === '+' || seg === '#') break;
    out.push(seg);
  }
  return out;
}

/** Default published name of a topic: the levels below the filter's literal prefix, else the last level. */
function topicName(topic, prefixLen = null) {
  const segs = split(topic);
  if (prefixLen !== null && prefixLen < segs.length) return segs.slice(prefixLen).join('/');
  return segs[segs.length - 1] || topic;
}

/** Clean a hierarchical name level by level (whitespace, + and # become _; empty levels dropped). */
function slugPath(name) {
  return String(name)
    .split('/')
    .map((s) => s.trim().replace(/[\s+#]+/g, '_'))
    .filter(Boolean)
    .join('/');
}

function normQuality(q) {
  if (typeof q === 'boolean') return q ? 192 : 0;
  if (typeof q === 'string') {
    const s = q.toLowerCase();
    if (s === 'good') return 192;
    if (s === 'uncertain') return 64;
    if (s === 'bad') return 0;
    const n = Number(q);
    if (!Number.isFinite(n)) return undefined;
    q = n;
  }
  if (typeof q !== 'number' || !Number.isFinite(q) || q < 0) return undefined;
  return q >= 192 ? 192 : q >= 64 ? 64 : 0;
}

/** Envelope keys of an object: 'v' | 'value' | null. */
function envelopeKind(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  let kind = null;
  let n = 0;
  for (const k in o) {
    if (++n > 4) return null;
    if (kind === null) kind = ENV_V.has(k) ? 'v' : ENV_VALUE.has(k) ? 'value' : '';
    if (kind === 'v' ? !ENV_V.has(k) : kind === 'value' ? !ENV_VALUE.has(k) : true) return null;
  }
  if (kind === 'v' && !('v' in o)) return null;
  if (kind === 'value' && !('value' in o)) return null;
  return kind || null;
}

/** Walk a dot path (`a.b.0`); undefined when a level is missing. */
function atPath(obj, path) {
  let cur = obj;
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i < path.length && path.charCodeAt(i) !== 46) continue;
    if (cur === null || typeof cur !== 'object') return undefined;
    const key = path.slice(start, i);
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
    start = i + 1;
  }
  return cur;
}

const scratch = { sourceTimestamp: undefined, timestamp: undefined };

/**
 * Read one value from a tapped message into `out` (reused; no allocation):
 *   out = { v, q, t, u, r }  r: reason when the value could not be read (then q = 0, v = null).
 */
function readMessage(msg, field, out) {
  out.u = undefined;
  out.r = undefined;
  if (msg.payloadFormat === 'large') {
    out.v = null;
    out.q = 0;
    out.t = messageTime(msg);
    out.r = 'payload too large to read';
    return out;
  }
  let v = msg.payload;
  if (field) {
    v = v !== null && typeof v === 'object' ? atPath(v, field) : undefined;
    if (v === undefined) {
      out.v = null;
      out.q = 0;
      out.t = messageTime(msg);
      out.r = `field "${field}" not in the payload`;
      return out;
    }
  }
  let q = messageQuality(msg);
  let t;
  const kind = envelopeKind(v);
  if (kind) {
    const e = v;
    v = kind === 'v' ? e.v : e.value;
    const eq = normQuality(kind === 'v' ? e.q : e.quality);
    if (eq !== undefined) q = eq;
    t = kind === 'v' ? e.t : e.timestamp;
    const u = kind === 'v' ? e.u : e.unit;
    if (typeof u === 'string' && u) out.u = u;
  }
  if (t !== undefined) {
    scratch.sourceTimestamp = typeof t === 'string' ? Date.parse(t) : t;
    scratch.timestamp = msg.timestamp;
    out.t = messageTime(scratch);
  } else out.t = messageTime(msg);
  out.v = v === undefined ? null : v;
  out.q = q;
  return out;
}

/** Value type of a read value, for the published metadata / Sparkplug. */
function typeOfValue(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int64' : 'float64';
  if (typeof v === 'string') return 'string';
  return 'unknown';
}

// ---- loop safety (static) --------------------------------------------------------

/** Filters covering every topic a binding may publish to on its target broker. */
function publishFilters(b, units) {
  const t = b?.target || {};
  const out = new Set();
  if (t.mode === 'sparkplug') {
    out.add(`spBv1.0/${t.group || '+'}/+/${t.edge || '+'}`);
    out.add(`spBv1.0/${t.group || '+'}/+/${t.edge || '+'}/#`);
    return [...out];
  }
  const add = (base) => {
    if (!base) return;
    out.add(base);
    out.add(`${base}/#`);
  };
  const ph = (s) => String(s).replace(/\{[^}]*\}/g, '+');
  if (t.assetPath) add(String(t.assetPath).replace(/\/+$/, ''));
  else if (t.pathTemplate) {
    const tpl = String(t.pathTemplate);
    const asset = tpl
      .split('/')
      .filter((s) => s !== '{name}')
      .join('/');
    add(ph(asset).replace(/\/+$/, ''));
  }
  if (t.assetPathTemplate) add(ph(t.assetPathTemplate));
  for (const p of Object.values(t.assetPaths || {})) add(String(p));
  for (const u of units || []) if (u.base) add(u.base);
  return [...out];
}

/** The filters an mqtt-source binding reads. */
function sourceFilters(b) {
  const s = b?.source || {};
  if (s.type !== 'mqtt') return [];
  if (s.tags === 'all') return s.filter ? [String(s.filter)] : [];
  return (Array.isArray(s.tags) ? s.tags : [])
    .map((e) => (typeof e === 'string' ? e : e?.address))
    .filter((x) => typeof x === 'string' && x);
}

/** First (source filter, publish filter) pair that overlaps on the same broker, or null. */
function overlapPair(srcBroker, srcFilters, tgtBroker, pubFilters) {
  if (!srcBroker || srcBroker !== tgtBroker) return null;
  for (const s of srcFilters) for (const p of pubFilters) if (filtersOverlap(s, p)) return { source: s, target: p };
  return null;
}

/** Validation of an mqtt source -> error string or null (loop refusal included). */
function mqttSourceError(source, target, units) {
  if (!source.brokerId) return 'mqtt source needs brokerId';
  if (source.tags === 'all') {
    const p = filterProblem(source.filter);
    if (p) return `source.filter ${p}`;
  } else {
    const list = Array.isArray(source.tags) ? source.tags : [];
    if (!list.length) return 'mqtt source needs tags[] (topics) or tags: "all" with a filter';
    for (const e of list) {
      const a = typeof e === 'string' ? e : e?.address;
      if (typeof a !== 'string' || !a || /[+#]/.test(a) || a.includes('\u0000')) return `mqtt source topic "${a}" must be a concrete topic (use tags: "all" with a filter for wildcards)`;
    }
  }
  for (const [where, f] of fieldEntries(source)) {
    if (typeof f !== 'string' || !f || f.length > MAX_FIELD_PATH || /^\.|\.\.|\.$/.test(f)) return `${where}.field must be a dot path such as "data.value" (at most ${MAX_FIELD_PATH} characters)`;
  }
  for (const [where, ms] of staleEntries(source)) {
    if (!Number.isInteger(ms) || ms < 1000 || ms > 86_400_000) return `${where}.staleAfterMs must be a whole number of milliseconds from 1000 to 86400000`;
  }
  const pair = overlapPair(source.brokerId, sourceFilters({ source }), target.brokerId, publishFilters({ target }, units));
  if (pair) {
    return (
      `loop: this mapping would read what it publishes (target ${pair.target} overlaps source ${pair.source} on broker ${source.brokerId}); ` +
      'publish outside the source filter or to another broker'
    );
  }
  return null;
}

function* fieldEntries(source) {
  if (source.field !== undefined) yield ['source', source.field];
  for (const e of Array.isArray(source.tags) ? source.tags : []) if (e && typeof e === 'object' && e.field !== undefined) yield [`tag "${e.address}"`, e.field];
  for (const [k, o] of Object.entries(source.overrides || {})) if (o && typeof o === 'object' && o.field !== undefined) yield [`source.overrides["${k}"]`, o.field];
}

function* staleEntries(source) {
  if (source.staleAfterMs !== undefined && source.staleAfterMs !== null) yield ['source', source.staleAfterMs];
  for (const e of Array.isArray(source.tags) ? source.tags : []) if (e && typeof e === 'object' && e.staleAfterMs !== undefined) yield [`tag "${e.address}"`, e.staleAfterMs];
  for (const [k, o] of Object.entries(source.overrides || {})) if (o && typeof o === 'object' && o.staleAfterMs !== undefined) yield [`source.overrides["${k}"]`, o.staleAfterMs];
}

/**
 * Cross-mapping cycle risk (non-blocking): another enabled mqtt-source binding reads what this one
 * publishes AND publishes what this one reads. The runtime hop guard stops such a cycle; the
 * warning says where it is.
 */
function loopWarnings(b, others, unitsOf) {
  const out = [];
  const mine = sourceFilters(b);
  const myPub = publishFilters(b, unitsOf(b));
  for (const o of others) {
    if (o.id === b.id || o.enabled === false) continue;
    const theirs = sourceFilters(o);
    const intoThem = theirs.length && overlapPair(o.source.brokerId, theirs, b.target?.brokerId, myPub);
    if (!intoThem) continue;
    const back = mine.length && overlapPair(b.source.brokerId, mine, o.target?.brokerId, publishFilters(o, unitsOf(o)));
    if (back) {
      out.push({
        type: 'loop-risk',
        topic: null,
        bindings: [{ id: o.id, name: o.name || null }],
        message: `mapping ${o.name || o.id} reads what this one publishes and publishes what it reads; the runtime hop guard stops the cycle, but the data goes round until it does`
      });
    }
  }
  return out;
}

module.exports = {
  MAX_FILTER_TOPICS,
  filtersOverlap,
  filterCovers,
  filterPrefix,
  topicName,
  slugPath,
  normQuality,
  envelopeKind,
  atPath,
  readMessage,
  typeOfValue,
  publishFilters,
  sourceFilters,
  overlapPair,
  mqttSourceError,
  loopWarnings,
  matchParts
};
