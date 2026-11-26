'use strict';

/**
 * SenML (RFC 8428) resolution, for packs carried as JSON or CBOR.
 *
 * A pack is an array of records. Base fields (bn, bt, bu, bv, bs, bver) apply
 * to the record that carries them and every later record until changed. The
 * result is the RFC's resolved form (§4.6): one record per input record that
 * carries a value or a sum, each with
 *   n   the full name (base name + name)
 *   u   the unit (record unit, else base unit), when there is one
 *   v | vs | vb | vd   the value (v plus base value; vd as base64url text)
 *   s   the sum plus base sum, when present
 *   t   absolute time in seconds since the epoch (base time + time; a result
 *       below 2^28 is relative to now, per §4.5.3)
 *   ut  the update time, when present
 * Records that only set base fields produce no output.
 *
 * SenML-CBOR uses integer labels (§6): bver -1, bn -2, bt -3, bu -4, bv -5,
 * bs -6, n 0, u 1, v 2, vs 3, vb 4, s 5, t 6, ut 7, vd 8 (a byte string).
 *
 * Errors (the payload then stays undecoded): not an array; a record that is
 * not an object; a field of the wrong type; more than one value field; a
 * resolved name that is empty or not in the RFC's name charset; a record with
 * no value and no sum; a field ending in "_" (must-understand) that this
 * resolver does not know; a base version above 10.
 *
 * Not supported: the SenML XML and EXI forms, and the streaming (SenSML)
 * framing.
 */

const { CodecError } = require('./common');

const CBOR_LABELS = { '-1': 'bver', '-2': 'bn', '-3': 'bt', '-4': 'bu', '-5': 'bv', '-6': 'bs', 0: 'n', 1: 'u', 2: 'v', 3: 'vs', 4: 'vb', 5: 's', 6: 't', 7: 'ut', 8: 'vd' };
const TYPES = { bver: 'number', bn: 'string', bt: 'number', bu: 'string', bv: 'number', bs: 'number', n: 'string', u: 'string', v: 'number', vs: 'string', vb: 'boolean', s: 'number', t: 'number', ut: 'number', vd: 'string' };
const NAME_RE = /^[A-Za-z0-9][-:./A-Za-z0-9_]*$/;
const RELATIVE_LIMIT = 2 ** 28;

/** Map a CBOR pack's integer labels (decoded as string keys) to SenML names; vd bytes to base64url. */
function fromCborLabels(pack) {
  if (!Array.isArray(pack)) return pack;
  return pack.map((rec) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || Buffer.isBuffer(rec)) return rec;
    const out = {};
    for (const [k, v] of Object.entries(rec)) {
      const name = Object.hasOwn(CBOR_LABELS, k) ? CBOR_LABELS[k] : k;
      out[name] = name === 'vd' && Buffer.isBuffer(v) ? v.toString('base64url') : Buffer.isBuffer(v) ? v.toString('hex') : v;
    }
    return out;
  });
}

/** Resolve a SenML pack (array of records with string field names). `now` is ms. */
function resolveSenml(pack, { now = Date.now() } = {}) {
  if (!Array.isArray(pack)) throw new CodecError('a SenML pack must be an array of records');
  const base = { bn: '', bt: 0, bu: undefined, bv: 0, bs: 0, bver: 10 };
  const out = [];
  pack.forEach((rec, i) => {
    const where = `record ${i}`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new CodecError(`${where} is not an object`);
    let values = 0;
    for (const [k, v] of Object.entries(rec)) {
      if (Object.hasOwn(TYPES, k)) {
        if (typeof v !== TYPES[k] || (TYPES[k] === 'number' && !Number.isFinite(v))) {
          throw new CodecError(`${where}: "${k}" must be a ${TYPES[k] === 'number' ? 'finite number' : TYPES[k]}`);
        }
        if (k === 'v' || k === 'vs' || k === 'vb' || k === 'vd') values++;
      } else if (k.endsWith('_')) {
        throw new CodecError(`${where}: unsupported must-understand field "${k}"`);
      }
    }
    if (values > 1) throw new CodecError(`${where} has more than one value field`);
    for (const k of ['bn', 'bt', 'bu', 'bv', 'bs', 'bver']) if (rec[k] !== undefined) base[k] = rec[k];
    if (base.bver > 10) throw new CodecError(`${where}: SenML version ${base.bver} is newer than supported (10)`);
    const hasSum = rec.s !== undefined;
    if (!values && !hasSum) {
      if (rec.n !== undefined || rec.u !== undefined || rec.t !== undefined || rec.ut !== undefined) {
        throw new CodecError(`${where} has no value and no sum`);
      }
      return; // base fields only
    }
    const n = base.bn + (rec.n ?? '');
    if (!n || !NAME_RE.test(n)) throw new CodecError(`${where}: name "${n}" is empty or uses characters SenML does not allow`);
    const r = { n };
    const u = rec.u ?? base.bu;
    if (u !== undefined) r.u = u;
    if (rec.v !== undefined) r.v = rec.v + base.bv;
    else if (rec.vs !== undefined) r.vs = rec.vs;
    else if (rec.vb !== undefined) r.vb = rec.vb;
    else if (rec.vd !== undefined) r.vd = rec.vd;
    if (hasSum) r.s = rec.s + base.bs;
    let t = base.bt + (rec.t ?? 0);
    if (t < RELATIVE_LIMIT) t = now / 1000 + t;
    r.t = t;
    if (rec.ut !== undefined) r.ut = rec.ut;
    out.push(r);
  });
  return out;
}

/** The one source time (ms) of a resolved pack, when every record shares it; else undefined. */
function packTime(records) {
  if (!records.length) return undefined;
  const t = records[0].t;
  return records.every((r) => r.t === t) ? Math.round(t * 1000) : undefined;
}

module.exports = { resolveSenml, fromCborLabels, packTime, CBOR_LABELS };
