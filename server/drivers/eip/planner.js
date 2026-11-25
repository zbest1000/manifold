'use strict';

/**
 * Pure read planner for Logix tags.
 *
 * Packs Read Tag requests into Multiple Service Packets (service 0x0A on the
 * Message Router) so that both the packed request and the packed reply fit
 * the negotiated connection size, and sends values whose reply cannot fit
 * as Read Tag Fragmented (0x52). Size arithmetic follows the MSP format
 * (ODVA Vol. 1 A-4.10): request = service + path size + path(4) + count(2) +
 * 2 bytes per offset + the inner requests; reply = 4-byte reply header +
 * count(2) + 2 bytes per offset + the inner replies.
 */

const MSP_REQUEST_OVERHEAD = 2 + 4 + 2; // service, path size, 20 02 24 01, count
const MSP_REPLY_OVERHEAD = 4 + 2; // reply header, count
const SEQUENCE_BYTES = 2; // connected data item carries a sequence count

/** Bytes available for one CIP message on a connection of `connectionSize`. */
function messageBudget(connectionSize) {
  return connectionSize - SEQUENCE_BYTES;
}

/**
 * @param {{key:string, requestBytes:number, replyBytes:number}[]} items
 * @param {{connectionSize:number, packing?:boolean, maxPacketBytes?:number}} limits
 *   maxPacketBytes caps a packed reply (Omron NJ/NX fails above ~1900 bytes)
 * @returns {{id:string, kind:'single'|'multi'|'fragmented', items:{key:string}[]}[]}
 */
function planReads(items, { connectionSize, packing = true, maxPacketBytes = Infinity }) {
  if (!Number.isInteger(connectionSize) || connectionSize < 100) throw new RangeError(`connectionSize ${connectionSize} is invalid`);
  const budget = messageBudget(connectionSize);
  const packLimit = Math.min(budget, maxPacketBytes);
  const requests = [];
  let n = 0;
  const push = (kind, group) => requests.push({ id: `r${n++}`, kind, items: group.map((i) => ({ key: i.key })) });

  let group = [];
  let reqSize = MSP_REQUEST_OVERHEAD;
  let repSize = MSP_REPLY_OVERHEAD;
  const flush = () => {
    if (group.length === 1) push('single', group);
    else if (group.length > 1) push('multi', group);
    group = [];
    reqSize = MSP_REQUEST_OVERHEAD;
    repSize = MSP_REPLY_OVERHEAD;
  };

  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (item.replyBytes > budget) {
      push('fragmented', [item]);
      continue;
    }
    if (!packing) {
      push('single', [item]);
      continue;
    }
    const addReq = item.requestBytes + 2;
    const addRep = item.replyBytes + 2;
    if (group.length && (reqSize + addReq > packLimit || repSize + addRep > packLimit)) flush();
    if (MSP_REQUEST_OVERHEAD + addReq > packLimit || MSP_REPLY_OVERHEAD + addRep > packLimit) {
      push('single', [item]); // too big to share a packet but fits on its own
      continue;
    }
    group.push(item);
    reqSize += addReq;
    repSize += addRep;
  }
  flush();
  return requests;
}

/**
 * Split a request's items in half (to isolate a failing item).
 * @returns {[object, object]|null} null for a single-item request
 */
function bisect(request) {
  if (!request || request.items.length < 2) return null;
  const mid = Math.ceil(request.items.length / 2);
  const half = (items, suffix) => ({ id: `${request.id}${suffix}`, kind: items.length === 1 ? 'single' : 'multi', items });
  return [half(request.items.slice(0, mid), 'a'), half(request.items.slice(mid), 'b')];
}

module.exports = { planReads, bisect, messageBudget, MSP_REQUEST_OVERHEAD, MSP_REPLY_OVERHEAD };
