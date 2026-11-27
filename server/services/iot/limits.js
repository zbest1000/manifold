'use strict';

/**
 * Bounds and small safe helpers shared by the IoT-over-MQTT conventions.
 *
 * Everything here treats payloads as hostile: no recursion without a depth bound, own-property
 * reads only (a payload key such as "__proto__" never reaches a prototype), and strings and
 * structured values are capped before they are kept.
 */

const LIMITS = Object.freeze({
  maxDevicesPerBroker: Number(process.env.MANIFOLD_IOT_MAX_DEVICES) || 2000,
  maxTagsPerDevice: 400,
  maxTagsPerBroker: Number(process.env.MANIFOLD_IOT_MAX_TAGS) || 50_000,
  maxPayloadBytes: 256 * 1024, // the topic store truncates above this anyway ('large')
  maxJsonDepth: 24, // deeper payloads are refused whole
  maxWalkDepth: 8, // how deep a JSON payload is walked to derive tags (Tasmota SENSOR, LoRaWAN objects)
  maxStringValue: 4096,
  maxStructuredBytes: 16 * 1024,
  maxNameLength: 200,
  maxSuggestions: 20
});

const BAD = 0;
const UNCERTAIN = 64;
const GOOD = 192;

/** Depth of a JSON value, stopping (and returning limit + 1) as soon as `limit` is exceeded. Iterative. */
function jsonDepth(value, limit = LIMITS.maxJsonDepth) {
  if (value === null || typeof value !== 'object') return 0;
  const stack = [[value, 1]];
  let max = 1;
  let visited = 0;
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > max) max = d;
    if (max > limit) return limit + 1;
    if (++visited > 200_000) return limit + 1; // absurdly wide: refuse rather than spin
    const vals = Array.isArray(v) ? v : Object.values(v);
    for (const c of vals) if (c !== null && typeof c === 'object') stack.push([c, d + 1]);
  }
  return max;
}

/** Own-property path read: path is an array of keys/indexes. undefined when a level is missing. */
function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const i = typeof k === 'number' ? k : /^\d+$/.test(String(k)) ? Number(k) : NaN;
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else {
      if (!Object.hasOwn(cur, k)) return undefined;
      cur = cur[k];
    }
  }
  return cur;
}

/** Cap a value before it is stored or emitted: long strings are cut, large structures replaced. */
function capValue(v) {
  if (typeof v === 'string') return v.length > LIMITS.maxStringValue ? v.slice(0, LIMITS.maxStringValue) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || typeof v !== 'object') return v === undefined ? null : v;
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    return null;
  }
  if (s.length > LIMITS.maxStructuredBytes) return `[structured value of ${s.length} bytes not kept]`;
  return JSON.parse(s); // detached copy: later payload mutation cannot reach it
}

/** A display string from untrusted input (names, models): text only, bounded, no control characters. */
function text(v, max = LIMITS.maxNameLength) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** A finite number or undefined. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Value type name used in tag metadata (the binding engine's vocabulary). */
function typeOf(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int64' : 'float64';
  if (typeof v === 'string') return 'string';
  if (v && typeof v === 'object') return 'json';
  return 'unknown';
}

/**
 * Source timestamp from a payload field: ISO string with a zone, epoch ms, or epoch seconds.
 * Anything implausible (before 2000, more than a day in the future, local time without a zone)
 * gives undefined: the arrival time is used instead.
 */
function sourceTime(v, { seconds = false } = {}) {
  let ms;
  if (typeof v === 'number' && Number.isFinite(v)) ms = seconds || v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && v) {
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v.trim())) return undefined; // no zone: cannot be placed in time
    ms = Date.parse(v);
  } else return undefined;
  if (!Number.isFinite(ms)) return undefined;
  if (ms < 946_684_800_000 || ms > Date.now() + 86_400_000) return undefined;
  return Math.round(ms);
}

/** Registry-safe id part: no whitespace or separators the binding engine uses. */
function idPart(s) {
  return encodeURIComponent(String(s)).slice(0, 300);
}

/** Bytes to lowercase hex (base64 input), bounded. */
function base64ToHex(b64, maxBytes = 256) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=_-]*$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.subarray(0, maxBytes).toString('hex');
}

module.exports = { LIMITS, BAD, UNCERTAIN, GOOD, jsonDepth, getPath, capValue, text, num, typeOf, sourceTime, idPart, base64ToHex };
