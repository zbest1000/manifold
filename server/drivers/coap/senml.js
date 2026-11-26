'use strict';

/**
 * SenML (RFC 8428) record resolution for the JSON and CBOR forms.
 *
 * `parsePack(array)` takes the already-decoded array (JSON.parse output, or the
 * output of ./cbor.js whose map keys are stringified integers) and returns one
 * resolved record per measurement:
 *   { index, name, unit, kind: 'number'|'string'|'bool'|'data', value, sum, time, relative }
 * Base name/time/unit/value/sum carry forward through the pack as the RFC says;
 * the base name is prefixed to the record name and the base value is added to a
 * numeric value. `time` is the resolved Unix time in seconds (a pack time below
 * 2^28 is relative to "now" and flagged `relative`), or null.
 *
 * Fields whose label ends in an underscore must be understood (RFC 8428
 * section 4.4); a pack that uses one we do not know is refused whole.
 */

const CBOR_KEYS = { '-1': 'bver', '-2': 'bn', '-3': 'bt', '-4': 'bu', '-5': 'bv', '-6': 'bs', 0: 'n', 1: 'u', 2: 'v', 3: 'vs', 4: 'vb', 5: 's', 6: 't', 7: 'ut', 8: 'vd' };
const KNOWN = new Set(Object.values(CBOR_KEYS));
const VALUE_FIELDS = ['v', 'vs', 'vb', 'vd'];
const RELATIVE_BELOW = 2 ** 28;
const MAX_RECORDS = 5000;

class SenmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SenmlError';
  }
}

function normalizeRecord(raw, cbor, i) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SenmlError(`record ${i} is not an object`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = cbor && Object.hasOwn(CBOR_KEYS, k) ? CBOR_KEYS[k] : k;
    if (!KNOWN.has(name)) {
      if (name.endsWith('_')) throw new SenmlError(`record ${i} uses the must-understand field "${name}"`);
      continue;
    }
    out[name] = v;
  }
  return out;
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * @param {unknown} pack decoded SenML array
 * @param {{cbor?:boolean}} [opts]
 */
function parsePack(pack, { cbor = false } = {}) {
  if (!Array.isArray(pack)) throw new SenmlError('a SenML pack is an array of records');
  if (pack.length === 0) throw new SenmlError('empty SenML pack');
  if (pack.length > MAX_RECORDS) throw new SenmlError(`more than ${MAX_RECORDS} SenML records`);
  const out = [];
  let bn = '';
  let bt = null;
  let bu;
  let bv = 0;
  let bs = 0;
  pack.forEach((raw, i) => {
    const r = normalizeRecord(raw, cbor, i);
    if (r.bver !== undefined) {
      if (!isNum(r.bver)) throw new SenmlError(`record ${i}: bver is not a number`);
      if (r.bver > 10) throw new SenmlError(`SenML version ${r.bver} is not supported (this reads version 10)`);
    }
    if (r.bn !== undefined) {
      if (typeof r.bn !== 'string') throw new SenmlError(`record ${i}: bn is not a string`);
      bn = r.bn;
    }
    if (r.bt !== undefined) {
      if (!isNum(r.bt)) throw new SenmlError(`record ${i}: bt is not a number`);
      bt = r.bt;
    }
    if (r.bu !== undefined) {
      if (typeof r.bu !== 'string') throw new SenmlError(`record ${i}: bu is not a string`);
      bu = r.bu;
    }
    if (r.bv !== undefined) {
      if (!isNum(r.bv)) throw new SenmlError(`record ${i}: bv is not a number`);
      bv = r.bv;
    }
    if (r.bs !== undefined) {
      if (!isNum(r.bs)) throw new SenmlError(`record ${i}: bs is not a number`);
      bs = r.bs;
    }
    const present = VALUE_FIELDS.filter((f) => r[f] !== undefined);
    if (present.length > 1) throw new SenmlError(`record ${i} has more than one of v, vs, vb and vd`);
    if (r.n !== undefined && typeof r.n !== 'string') throw new SenmlError(`record ${i}: n is not a string`);
    if (r.u !== undefined && typeof r.u !== 'string') throw new SenmlError(`record ${i}: u is not a string`);
    if (r.t !== undefined && !isNum(r.t)) throw new SenmlError(`record ${i}: t is not a number`);
    if (r.s !== undefined && !isNum(r.s)) throw new SenmlError(`record ${i}: s is not a number`);
    if (present.length === 0 && r.s === undefined) return; // base-only record
    let kind = null;
    let value = null;
    if (present.length) {
      const f = present[0];
      kind = { v: 'number', vs: 'string', vb: 'bool', vd: 'data' }[f];
      value = r[f];
      if (f === 'v') {
        if (!isNum(value)) throw new SenmlError(`record ${i}: v is not a number`);
        value += bv;
      } else if (f === 'vs' && typeof value !== 'string') throw new SenmlError(`record ${i}: vs is not a string`);
      else if (f === 'vb' && typeof value !== 'boolean') throw new SenmlError(`record ${i}: vb is not a boolean`);
      else if (f === 'vd') {
        if (typeof value !== 'string') throw new SenmlError(`record ${i}: vd is not a string`);
        // JSON carries data as base64url, CBOR (via ./cbor.js) already as hex.
        if (!cbor) value = Buffer.from(value, 'base64url').toString('hex');
      }
    }
    let time = null;
    if (r.t !== undefined || bt !== null) time = (bt ?? 0) + (r.t ?? 0);
    out.push({
      index: out.length,
      name: bn + (r.n ?? ''),
      unit: r.u ?? bu,
      kind,
      value,
      sum: r.s !== undefined ? r.s + bs : undefined,
      time,
      relative: time !== null && Math.abs(time) < RELATIVE_BELOW
    });
  });
  return out;
}

/**
 * Pick the record a tag selector names. No selector is only valid for a pack
 * with exactly one value record. When a name repeats (a series), the record
 * with the latest absolute time wins, later records breaking ties.
 */
function selectRecord(records, selector) {
  const valued = records.filter((r) => r.kind !== null);
  if (!selector) {
    if (valued.length === 1) return valued[0];
    throw new SenmlError(`this pack has ${valued.length} records; add a selector (the record name), for example #${valued[0] ? valued[0].name : 'name'}`);
  }
  const hits = valued.filter((r) => r.name === selector);
  if (!hits.length) {
    const names = [...new Set(valued.map((r) => r.name))];
    throw new SenmlError(`no SenML record named "${selector}" (available: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''})`);
  }
  let best = hits[0];
  for (const h of hits) {
    const a = h.time === null ? -Infinity : h.time;
    const b = best.time === null ? -Infinity : best.time;
    if (a >= b) best = h;
  }
  return best;
}

module.exports = { parsePack, selectRecord, SenmlError, CBOR_KEYS };
