'use strict';

/**
 * Read planning (pure). Tags become ReadPropertyMultiple requests sized so that BOTH the request
 * and the worst-case reply fit in one APDU of the negotiated size (this client never accepts a
 * segmented reply), or one ReadProperty request per tag when the device does not do RPM.
 *
 * Item: { key, objectType, instance, property, index?, withStatus }
 * Request: { id, kind:'rpm'|'rp', items:[item] }
 */

const { PROP } = require('./address');

const ACK_HEADER = 3; // ComplexACK: type, invoke id, service
const REQ_HEADER = 4; // Confirmed-Request: type, max-apdu, invoke id, service
const MARGIN = 6;

// Worst-case encoded value sizes for properties whose size is not obvious from the object type.
const VALUE_ESTIMATE = {
  [PROP.OBJECT_NAME]: 66,
  [PROP.DESCRIPTION]: 130,
  [PROP.MODEL_NAME]: 66,
  [PROP.VENDOR_NAME]: 66,
  [PROP.FIRMWARE_REVISION]: 34,
  [PROP.APPLICATION_SOFTWARE_VERSION]: 34,
  [PROP.ACTIVE_TEXT]: 34,
  [PROP.INACTIVE_TEXT]: 34,
  [PROP.PRIORITY_ARRAY]: 16 * 10,
  [PROP.STATE_TEXT]: 400,
  [PROP.OBJECT_LIST]: 1200,
  [PROP.PROPERTY_LIST]: 400,
  [PROP.STATUS_FLAGS]: 4,
  [PROP.RELIABILITY]: 2,
  [PROP.OUT_OF_SERVICE]: 1,
  [PROP.UNITS]: 3,
  [PROP.PRESENT_VALUE]: 10,
};
const ARRAY_PROPS = new Set([PROP.OBJECT_LIST, PROP.STATE_TEXT, PROP.PRIORITY_ARRAY, PROP.PROPERTY_LIST]);

/** Status properties read with present-value (in this order) so quality can be derived. */
const STATUS_PROPS = [PROP.STATUS_FLAGS, PROP.RELIABILITY, PROP.OUT_OF_SERVICE];

function uintLen(v) {
  return v < 0x100 ? 1 : v < 0x10000 ? 2 : v < 0x1000000 ? 3 : 4;
}

function refSize(property, index) {
  return 1 + uintLen(property) + (index !== undefined ? 1 + uintLen(index) : 0);
}

/** Estimated reply bytes for one property result (header + value or error). */
function replyRefSize(property, index) {
  let value = VALUE_ESTIMATE[property] ?? 24;
  if (index !== undefined && ARRAY_PROPS.has(property)) value = property === PROP.STATE_TEXT ? 66 : 10;
  return refSize(property, index) + 2 + Math.max(value, 6);
}

/** Property references one item contributes to an RPM. */
function refsOf(item) {
  const refs = [{ property: item.property, index: item.index }];
  if (item.withStatus) for (const p of STATUS_PROPS) refs.push({ property: p });
  return refs;
}

function itemCost(item) {
  let req = 0;
  let rep = 0;
  for (const r of refsOf(item)) {
    req += refSize(r.property, r.index);
    rep += replyRefSize(r.property, r.index);
  }
  return { req, rep, props: refsOf(item).length };
}

const OBJECT_OVERHEAD = 5 + 2; // object id tag + opening/closing

function requestId(kind, items) {
  return `${kind}:${items.map((i) => i.key).join('|')}`;
}

/**
 * Group items (same object together) into RPM requests.
 * @param {Array} items
 * @param {{maxApdu:number, maxProperties:number}} limits
 */
function planRpm(items, { maxApdu, maxProperties }) {
  const sorted = [...items].sort((a, b) => a.objectType - b.objectType || a.instance - b.instance);
  const budget = maxApdu - ACK_HEADER - MARGIN;
  const reqBudget = maxApdu - REQ_HEADER - MARGIN;
  const out = [];
  let cur = [];
  let req = 0;
  let rep = 0;
  let props = 0;
  let lastObj = null;
  const flush = () => {
    if (cur.length) out.push({ id: requestId('rpm', cur), kind: 'rpm', items: cur });
    cur = [];
    req = rep = props = 0;
    lastObj = null;
  };
  for (const item of sorted) {
    const c = itemCost(item);
    const objKey = `${item.objectType}:${item.instance}`;
    const extra = objKey === lastObj ? 0 : OBJECT_OVERHEAD;
    if (cur.length && (rep + c.rep + extra > budget || req + c.req + extra > reqBudget || props + c.props > maxProperties)) flush();
    const extra2 = objKey === lastObj ? 0 : OBJECT_OVERHEAD;
    cur.push(item);
    req += c.req + extra2;
    rep += c.rep + extra2;
    props += c.props;
    lastObj = objKey;
  }
  flush();
  return out;
}

function planRp(items) {
  return items.map((item) => ({ id: requestId('rp', [item]), kind: 'rp', items: [item] }));
}

/** RPM object specs for a request (consecutive items of the same object share one spec). */
function rpmSpecs(items) {
  const specs = [];
  for (const item of items) {
    const last = specs[specs.length - 1];
    const refs = refsOf(item);
    if (last && last.objectType === item.objectType && last.instance === item.instance) last.refs.push(...refs);
    else specs.push({ objectType: item.objectType, instance: item.instance, refs: [...refs] });
  }
  return specs;
}

/**
 * Split a failed request. When `failed` names the items whose own error caused the failure, the
 * healthy items stay together and each failed one is isolated (so it can be quarantined alone);
 * otherwise the request is halved.
 * @returns {Array|null} null when it cannot be split further
 */
function bisect(request, failed = null) {
  const items = request.items;
  if (items.length <= 1) return null;
  if (failed && failed.size && failed.size < items.length) {
    const good = items.filter((i) => !failed.has(i.key));
    const bad = items.filter((i) => failed.has(i.key));
    return [{ id: requestId(request.kind, good), kind: request.kind, items: good }, ...bad.map((i) => ({ id: requestId(request.kind, [i]), kind: request.kind, items: [i] }))];
  }
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)].map((part) => ({ id: requestId(request.kind, part), kind: request.kind, items: part }));
}

module.exports = { planRpm, planRp, rpmSpecs, refsOf, bisect, STATUS_PROPS, itemCost, replyRefSize };
