'use strict';

/**
 * Response bodies -> tag values: content-format handling, selection and type
 * coercion. Pure functions; nothing here touches the network.
 */

const cbor = require('./cbor');
const senml = require('./senml');
const selector = require('./selector');

const CF = {
  0: 'text/plain',
  40: 'application/link-format',
  41: 'application/xml',
  42: 'application/octet-stream',
  47: 'application/exi',
  50: 'application/json',
  60: 'application/cbor',
  110: 'application/senml+json',
  111: 'application/sensml+json',
  112: 'application/senml+cbor',
  113: 'application/sensml+cbor',
  320: 'application/senml-exi',
  11542: 'application/vnd.oma.lwm2m+tlv',
  11543: 'application/vnd.oma.lwm2m+json'
};

const CF_BY_NAME = Object.fromEntries(Object.entries(CF).map(([n, name]) => [name, Number(n)]));

const cfName = (n) => (n === undefined ? 'none' : CF[n] || `content-format ${n}`);

/** @returns {'text'|'json'|'cbor'|'senml-json'|'senml-cbor'|'link'|'octet'|'none'} */
function formatOf(cf) {
  if (cf === undefined) return 'none';
  if (cf === 0) return 'text';
  if (cf === 50) return 'json';
  if (cf === 60) return 'cbor';
  if (cf === 110) return 'senml-json';
  if (cf === 112) return 'senml-cbor';
  if (cf === 40) return 'link';
  return 'octet';
}

class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function toText(payload, label) {
  try {
    return utf8.decode(payload).replace(/^\u{FEFF}/u, '');
  } catch {
    throw new ValueError(`${label} payload is not valid UTF-8`);
  }
}

function isPrintableText(payload) {
  let text;
  try {
    text = utf8.decode(payload);
  } catch {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

/**
 * Decode a response payload by its Content-Format.
 * @returns {{format:string, cf:number|undefined, name:string, doc?:unknown, text?:string, hex?:string, records?:object[]}}
 * @throws {ValueError} (also for malformed JSON / CBOR / SenML)
 */
function parseBody(payload, cf) {
  let format = formatOf(cf);
  const base = { cf, name: cfName(cf) };
  if (format === 'none') format = payload.length === 0 || isPrintableText(payload) ? 'text' : 'octet';
  try {
    switch (format) {
      case 'text':
        return { ...base, format, text: toText(payload, 'text/plain') };
      case 'link':
        return { ...base, format, text: toText(payload, 'link-format') };
      case 'json':
        return { ...base, format, doc: JSON.parse(toText(payload, 'JSON')) };
      case 'cbor':
        return { ...base, format, doc: cbor.decode(payload) };
      case 'senml-json': {
        const doc = JSON.parse(toText(payload, 'SenML JSON'));
        return { ...base, format, doc, records: senml.parsePack(doc) };
      }
      case 'senml-cbor': {
        const doc = cbor.decode(payload);
        return { ...base, format, doc, records: senml.parsePack(doc, { cbor: true }) };
      }
      default:
        return { ...base, format: 'octet', hex: payload.toString('hex') };
    }
  } catch (err) {
    if (err instanceof ValueError) throw err;
    throw new ValueError(`${cfName(cf)}: ${err.message}`);
  }
}

/**
 * The raw value a tag selects: { value, unit?, time? }. `value` can still be an
 * object or array (coerce() turns those into JSON text for string tags).
 */
function select(body, sel) {
  try {
    switch (body.format) {
      case 'senml-json':
      case 'senml-cbor': {
        const rec = senml.selectRecord(body.records, sel);
        return { value: rec.value, unit: rec.unit, time: rec.time, kind: rec.kind };
      }
      case 'json':
      case 'cbor':
        return { value: sel ? selector.apply(body.doc, selector.parse(sel)) : body.doc };
      case 'text':
        if (sel) throw new ValueError('a selector needs a JSON, CBOR or SenML response; this one is text/plain');
        return { value: body.text, text: true };
      case 'link':
        if (sel) throw new ValueError('a selector cannot be applied to a link-format response');
        return { value: body.text };
      default:
        if (sel) throw new ValueError(`a selector cannot be applied to ${body.name}`);
        return { value: body.hex };
    }
  } catch (err) {
    if (err instanceof ValueError) throw err;
    throw new ValueError(err.message);
  }
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE = new Set(['true', '1', 'on', 'yes', 'open']);
const FALSE = new Set(['false', '0', 'off', 'no', 'closed']);

const TYPE_ALIASES = {
  number: 'number',
  float: 'number',
  float32: 'number',
  float64: 'number',
  double: 'number',
  int: 'number',
  int8: 'number',
  int16: 'number',
  int32: 'number',
  int64: 'number',
  uint8: 'number',
  uint16: 'number',
  uint32: 'number',
  uint64: 'number',
  bool: 'bool',
  boolean: 'bool',
  string: 'string',
  text: 'string'
};

/** Normalise a configured tag type to 'number' | 'bool' | 'string', or undefined for auto. */
function normalizeType(type) {
  if (type === undefined || type === null || type === '' || String(type).toLowerCase() === 'auto') return undefined;
  return TYPE_ALIASES[String(type).toLowerCase()];
}

const SAMPLE_TYPE = { number: 'float64', bool: 'bool', string: 'string' };

/**
 * Convert a selected raw value to a sample value.
 * @param {{value:unknown, text?:boolean}} raw
 * @param {'number'|'bool'|'string'|undefined} type undefined = keep the natural type
 * @param {{scale?:number, offset?:number}} [adj]
 * @returns {{v:number|boolean|string, type:'float64'|'bool'|'string'}}
 * @throws {ValueError}
 */
function coerce(raw, type, adj = {}) {
  let v = raw.value;
  if (v === undefined || v === null) throw new ValueError('the value is null');
  if (typeof v === 'object') {
    if (type && type !== 'string') throw new ValueError(`the selected value is ${Array.isArray(v) ? 'an array' : 'an object'}, not ${type === 'number' ? 'a number' : 'a boolean'}; add a selector`);
    v = JSON.stringify(v);
    type = 'string';
  }
  if (!type) {
    // Natural type; plain text is the one format where a number is just digits.
    if (typeof v === 'string' && raw.text) {
      const t = v.trim();
      if (NUMERIC.test(t)) {
        v = Number(t);
      } else if (/^(true|false)$/i.test(t)) {
        v = t.toLowerCase() === 'true';
      }
    }
    type = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'string';
  }
  if (type === 'number') {
    if (typeof v === 'boolean') v = v ? 1 : 0;
    else if (typeof v === 'string') {
      const t = v.trim();
      if (!NUMERIC.test(t)) throw new ValueError(`cannot read "${v.length > 40 ? `${v.slice(0, 40)}...` : v}" as a number`);
      v = Number(t);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValueError('the value is not a finite number');
    if (adj.scale !== undefined) v *= adj.scale;
    if (adj.offset !== undefined) v += adj.offset;
    if (!Number.isFinite(v)) throw new ValueError('the scaled value is not a finite number');
    return { v, type: 'float64' };
  }
  if (type === 'bool') {
    if (typeof v === 'number') v = v !== 0;
    else if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (TRUE.has(t)) v = true;
      else if (FALSE.has(t)) v = false;
      else throw new ValueError(`cannot read "${v.length > 40 ? `${v.slice(0, 40)}...` : v}" as a boolean`);
    }
    return { v: Boolean(v), type: 'bool' };
  }
  return { v: String(v), type: 'string' };
}

module.exports = { CF, CF_BY_NAME, cfName, formatOf, parseBody, select, coerce, normalizeType, ValueError, SAMPLE_TYPE };
