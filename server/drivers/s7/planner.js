'use strict';

/**
 * Pure S7 read planner.
 *
 * - Tags in the same area and DB are merged into block reads when the hole
 *   between them is at most `maxGap` bytes. Unlike Modbus, reading a few
 *   unused bytes inside a DB is harmless (it either exists or the whole read
 *   would fail anyway), so the default gap is 8 bytes.
 * - Merging never crosses areas or DBs.
 * - Every request respects the NEGOTIATED PDU size on both sides:
 *     request : 10 (header) + 2 (function, count) + 12 per item       ≤ pduSize
 *     response: 12 (header) + 2 (function, count) + Σ(4 + len + fill) ≤ pduSize
 *   where `fill` is the alignment byte after an odd-length item. It is
 *   counted for every item (also the last) to stay on the safe side.
 * - At most 20 items per Read Var request (fewer when the request itself
 *   would not fit, e.g. 19 at PDU 240).
 * - A tag larger than the largest single-item payload (pduSize - 18, rounded
 *   down to even) becomes one Request with several sequential jobs, each
 *   reading one segment. Note the segments are NOT read atomically.
 *
 * Request shape:
 *   { id, pduSize,
 *     jobs:  [{ items: [{ area, db, start, length }] }],        // wire reads, in order
 *     items: [{ key, ...tag, parts: [{ job, wire, offset, length }] }] }
 * A tag's bytes are the concatenation of its parts; `offset` is relative to
 * the start of the referenced wire item.
 */

const crypto = require('crypto');
const {
  MAX_READ_ITEMS,
  MAX_BYTE_OFFSET,
  READ_RESPONSE_OVERHEAD,
  READ_RESPONSE_ITEM_HEAD,
  readRequestSize,
} = require('./frame');

const even = (n) => n + (n % 2);

/**
 * Limits derived from a negotiated PDU size.
 * @param {number} pduSize
 * @param {number} [maxItems=20]
 * @returns {{pduSize:number, maxItems:number, maxBlock:number}}
 */
function limitsFor(pduSize, maxItems = MAX_READ_ITEMS) {
  if (!Number.isInteger(pduSize) || pduSize < 32) throw new RangeError(`pduSize must be an integer >= 32, got ${pduSize}`);
  const byRequest = Math.floor((pduSize - readRequestSize(0)) / (readRequestSize(1) - readRequestSize(0)));
  const maxBlock = pduSize - READ_RESPONSE_OVERHEAD - READ_RESPONSE_ITEM_HEAD;
  return {
    pduSize,
    maxItems: Math.max(1, Math.min(maxItems, MAX_READ_ITEMS, byRequest)),
    maxBlock: maxBlock - (maxBlock % 2),
  };
}

function validateTag(t) {
  if (typeof t.key !== 'string' || !t.key) throw new Error('every tag needs a string key');
  if (!Number.isInteger(t.areaCode)) throw new Error(`tag ${t.key}: missing areaCode`);
  if (!Number.isInteger(t.db) || t.db < 0 || t.db > 0xffff) throw new Error(`tag ${t.key}: invalid db ${t.db}`);
  if (!Number.isInteger(t.byteOffset) || t.byteOffset < 0 || t.byteOffset > MAX_BYTE_OFFSET) {
    throw new Error(`tag ${t.key}: invalid byteOffset ${t.byteOffset}`);
  }
  if (!Number.isInteger(t.length) || t.length < 1 || t.byteOffset + t.length - 1 > MAX_BYTE_OFFSET) {
    throw new Error(`tag ${t.key}: invalid length ${t.length}`);
  }
}

function requestId(jobs, items) {
  const desc = jobs
    .map((j) => j.items.map((w) => `${w.area}:${w.db}@${w.start}+${w.length}`).join(','))
    .join('|');
  const keys = items.map((i) => i.key).join('\u0000');
  return `s7-${crypto.createHash('sha1').update(desc).update('\u0001').update(keys).digest('hex').slice(0, 12)}`;
}

function finish(jobs, items, pduSize) {
  return { id: requestId(jobs, items), pduSize, jobs, items };
}

/**
 * @param {{key:string, areaCode:number, db:number, byteOffset:number, length:number}[]} tags
 *   (extra fields such as type/bitOffset are carried through onto the request items)
 * @param {{pduSize:number, maxGap?:number, maxItems?:number}} opts
 * @returns {object[]} requests, deterministic for a given tag set and options
 */
function planReads(tags, { pduSize, maxGap = 8, maxItems = MAX_READ_ITEMS } = {}) {
  const lim = limitsFor(pduSize, maxItems);
  if (!Number.isInteger(maxGap) || maxGap < 0) throw new RangeError(`maxGap must be a non-negative integer, got ${maxGap}`);
  tags.forEach(validateTag);
  const seen = new Set();
  for (const t of tags) {
    if (seen.has(t.key)) throw new Error(`duplicate tag key ${t.key}`);
    seen.add(t.key);
  }

  const sorted = [...tags].sort(
    (a, b) =>
      a.areaCode - b.areaCode ||
      a.db - b.db ||
      a.byteOffset - b.byteOffset ||
      b.length - a.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );

  // 1. ranges: merged blocks of small tags, and oversized single tags
  const blocks = [];
  const big = [];
  let cur = null;
  for (const t of sorted) {
    const end = t.byteOffset + t.length;
    if (t.length > lim.maxBlock) {
      big.push(t);
      continue;
    }
    const sameSpace = cur && cur.area === t.areaCode && cur.db === t.db;
    if (sameSpace && t.byteOffset - cur.end <= maxGap && Math.max(cur.end, end) - cur.start <= lim.maxBlock) {
      cur.end = Math.max(cur.end, end);
      cur.tags.push(t);
    } else {
      if (cur) blocks.push(cur);
      cur = { area: t.areaCode, db: t.db, start: t.byteOffset, end, tags: [t] };
    }
  }
  if (cur) blocks.push(cur);

  // 2. pack blocks into requests (first fit, in address order)
  const requests = [];
  let wires = [];
  let items = [];
  let respBytes = READ_RESPONSE_OVERHEAD;
  const flush = () => {
    if (wires.length) requests.push(finish([{ items: wires }], items, pduSize));
    wires = [];
    items = [];
    respBytes = READ_RESPONSE_OVERHEAD;
  };
  for (const b of blocks) {
    const length = b.end - b.start;
    const cost = READ_RESPONSE_ITEM_HEAD + even(length);
    if (wires.length + 1 > lim.maxItems || respBytes + cost > pduSize) flush();
    const wire = wires.length;
    wires.push({ area: b.area, db: b.db, start: b.start, length });
    respBytes += cost;
    for (const t of b.tags) {
      items.push({ ...t, parts: [{ job: 0, wire, offset: t.byteOffset - b.start, length: t.length }] });
    }
  }
  flush();

  // 3. oversized tags: one request each, one job per segment, read sequentially
  for (const t of big) {
    const jobs = [];
    const parts = [];
    for (let off = 0; off < t.length; off += lim.maxBlock) {
      const length = Math.min(lim.maxBlock, t.length - off);
      parts.push({ job: jobs.length, wire: 0, offset: 0, length });
      jobs.push({ items: [{ area: t.areaCode, db: t.db, start: t.byteOffset + off, length }] });
    }
    requests.push(finish(jobs, [{ ...t, parts }], pduSize));
  }
  return requests;
}

/**
 * Split a request's items in half to isolate a failing tag. Each half reuses
 * only the wire items its tags reference, trimmed to the bytes they need, so
 * a half never exceeds the limits the original respected.
 * @param {object} request from planReads
 * @returns {[object, object]|null} null for a single-tag or multi-job request
 */
function bisect(request) {
  if (!request || request.items.length < 2 || request.jobs.length !== 1) return null;
  const mid = Math.ceil(request.items.length / 2);
  const wires = request.jobs[0].items;
  const half = (items) => {
    const used = new Map(); // old wire index -> {min, max}
    for (const it of items) {
      for (const p of it.parts) {
        const r = used.get(p.wire) || { min: Infinity, max: -Infinity };
        r.min = Math.min(r.min, p.offset);
        r.max = Math.max(r.max, p.offset + p.length);
        used.set(p.wire, r);
      }
    }
    const order = [...used.keys()].sort((a, b) => a - b);
    const remap = new Map(order.map((w, i) => [w, i]));
    const newWires = order.map((w) => {
      const r = used.get(w);
      return { area: wires[w].area, db: wires[w].db, start: wires[w].start + r.min, length: r.max - r.min };
    });
    const newItems = items.map((it) => ({
      ...it,
      parts: it.parts.map((p) => ({ ...p, wire: remap.get(p.wire), offset: p.offset - used.get(p.wire).min })),
    }));
    return finish([{ items: newWires }], newItems, request.pduSize);
  };
  return [half(request.items.slice(0, mid)), half(request.items.slice(mid))];
}

module.exports = { planReads, bisect, limitsFor };
