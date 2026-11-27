'use strict';

/**
 * Request planning: pack varbinds into Get PDUs.
 *
 *  - at most `maxVarbinds` per PDU (option, default 20; lowered when an agent says tooBig);
 *  - the ESTIMATED response must fit `maxBytes` (option maxMessageSize, capped by the
 *    agent's own v3 msgMaxSize): request varbinds are tiny, it is the answer that
 *    overflows. A value's size is learned from earlier answers; until then a
 *    per-type guess is used (OctetString 64 bytes);
 *  - the same OID requested by several tags is fetched once;
 *  - OIDs are sent in MIB order, which some agents answer faster.
 */

const { encodeOidContent } = require('./ber');
const { compareOids } = require('./oids');

const VALUE_GUESS = { Integer32: 6, Counter32: 7, Gauge32: 7, TimeTicks: 7, Counter64: 11, IpAddress: 6, OID: 24, Opaque: 16, OctetString: 64 };
const DEFAULT_VALUE_GUESS = 32;

/** Encoded size of one varbind with a value of `valueBytes` content bytes. */
function varbindSize(oid, valueBytes) {
  const oidLen = encodeOidContent(oid.split('.').map(Number)).length;
  const tl = (n) => 1 + (n < 0x80 ? 1 : n < 0x100 ? 2 : 3);
  const inner = tl(oidLen) + oidLen + tl(valueBytes) + valueBytes;
  return tl(inner) + inner;
}

/** Fixed response overhead: message, PDU header and (v3) security parameters. */
function overhead({ version, communityLength = 6, authLength = 12, contextLength = 0 }) {
  if (version === '3') return 64 + 32 /* engine id */ + 32 /* user */ + authLength + 8 /* priv salt */ + 16 /* AES/DES pad */ + contextLength;
  return 24 + communityLength;
}

/**
 * @param {Array<{oid:string, kind?:string}>} items unique OIDs to read
 * @param {object} o
 * @param {number} o.maxVarbinds
 * @param {number} o.maxBytes
 * @param {number} o.overheadBytes
 * @param {Map<string,number>} [o.learned] oid -> last value content length
 * @param {string[]} [o.prefix] OIDs every PDU must carry first (sysUpTime for rate tags)
 * @returns {string[][]} OID lists, one per PDU
 */
function planBatches(items, o) {
  const learned = o.learned || new Map();
  const prefix = o.prefix || [];
  const sizeOf = (it) => varbindSize(it.oid, learned.has(it.oid) ? learned.get(it.oid) : VALUE_GUESS[it.kind] || DEFAULT_VALUE_GUESS);
  const prefixBytes = prefix.reduce((n, oid) => n + varbindSize(oid, 7), 0);
  const seen = new Set(prefix);
  const unique = [];
  for (const it of items) {
    if (seen.has(it.oid)) continue;
    seen.add(it.oid);
    unique.push(it);
  }
  const sorted = unique.sort((a, b) => compareOids(a.oid, b.oid));
  const budget = Math.max(64, o.maxBytes - o.overheadBytes);
  const max = Math.max(1, o.maxVarbinds);
  const out = [];
  let cur = [];
  let bytes = prefixBytes;
  for (const it of sorted) {
    const s = sizeOf(it);
    if (cur.length && (cur.length + prefix.length >= max || bytes + s > budget)) {
      out.push([...prefix, ...cur.map((x) => x.oid)]);
      cur = [];
      bytes = prefixBytes;
    }
    cur.push(it);
    bytes += s;
  }
  if (cur.length) out.push([...prefix, ...cur.map((x) => x.oid)]);
  if (!out.length && prefix.length) out.push([...prefix]);
  return out;
}

/** Split an OID list in two halves (prefix kept on both), or null when it cannot shrink. */
function splitOids(oids, prefixCount = 0) {
  const prefix = oids.slice(0, prefixCount);
  const body = oids.slice(prefixCount);
  if (body.length < 2) return null;
  const mid = Math.ceil(body.length / 2);
  return [
    [...prefix, ...body.slice(0, mid)],
    [...prefix, ...body.slice(mid)],
  ];
}

module.exports = { planBatches, splitOids, varbindSize, overhead, VALUE_GUESS };
