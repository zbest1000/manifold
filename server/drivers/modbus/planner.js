'use strict';

/**
 * Pure read planner: packs tag ranges into the fewest requests that respect
 * the device limits and never read across a declared unmapped range.
 */

const TABLE_ORDER = ['coil', 'discrete', 'holding', 'input'];
const FC = { coil: 1, discrete: 2, holding: 3, input: 4 };

function validate(t, { maxRegisters, maxBits }) {
  if (!FC[t.table]) throw new Error(`tag ${t.id}: unknown table "${t.table}"`);
  const max = t.table === 'coil' || t.table === 'discrete' ? maxBits : maxRegisters;
  if (!Number.isInteger(t.offset) || !Number.isInteger(t.count) || t.offset < 0 || t.count < 1 || t.offset + t.count > 0x10000) {
    throw new Error(`tag ${t.id}: invalid range offset=${t.offset} count=${t.count}`);
  }
  if (t.count > max) {
    throw new Error(
      `tag ${t.id} spans ${t.count} ${t.table} units, more than the ${max} one request can read; it cannot be read atomically`
    );
  }
}

function canExtend(block, tag, end, max, maxGap, holes) {
  if (Math.max(block.end, end) - block.start > max) return false;
  const gap = tag.offset - block.end;
  if (gap <= 0) return true;
  // The bridged span is [block.end, tag.offset - 1].
  return gap <= maxGap && !holes.some((h) => h.from < tag.offset && h.to >= block.end);
}

function toRequest(table, block) {
  return {
    fc: FC[table],
    table,
    address: block.start,
    quantity: block.end - block.start,
    items: block.tags.map((t) => ({ id: t.id, start: t.offset - block.start, count: t.count })),
  };
}

/**
 * @param {{id:string, table:string, offset:number, count:number}[]} tags
 * @param {{maxRegisters?:number, maxBits?:number, maxGap?:number,
 *   unmapped?:{table:string, from:number, to:number}[]}} [limits] unmapped ranges are inclusive
 * @returns {{fc:number, table:string, address:number, quantity:number,
 *   items:{id:string, start:number, count:number}[]}[]}
 * @throws {Error} when a tag is invalid or larger than the per-request maximum
 */
function planReads(tags, { maxRegisters = 125, maxBits = 2000, maxGap = 0, unmapped = [] } = {}) {
  tags.forEach((t) => validate(t, { maxRegisters, maxBits }));
  const requests = [];
  for (const table of TABLE_ORDER) {
    const max = table === 'coil' || table === 'discrete' ? maxBits : maxRegisters;
    const holes = unmapped.filter((u) => u.table === table);
    const group = tags.filter((t) => t.table === table);
    group.sort((a, b) => a.offset - b.offset || b.count - a.count);

    let block = null;
    for (const tag of group) {
      const end = tag.offset + tag.count;
      if (block && canExtend(block, tag, end, max, maxGap, holes)) {
        block.end = Math.max(block.end, end);
      } else {
        if (block) requests.push(toRequest(table, block));
        block = { start: tag.offset, end, tags: [] };
      }
      block.tags.push(tag);
    }
    if (block) requests.push(toRequest(table, block));
  }
  return requests;
}

/**
 * Split a request's items roughly in half (to isolate an exception-02
 * culprit). Each half is re-based to the span its own items need.
 * @param {ReturnType<typeof planReads>[number]} request
 * @returns {[object, object]|null} null when the request holds a single item
 */
function bisect(request) {
  if (request.items.length < 2) return null;
  const mid = Math.ceil(request.items.length / 2);
  const half = (items) => {
    const first = Math.min(...items.map((i) => i.start));
    const end = Math.max(...items.map((i) => i.start + i.count));
    return {
      fc: request.fc,
      table: request.table,
      address: request.address + first,
      quantity: end - first,
      items: items.map((i) => ({ id: i.id, start: i.start - first, count: i.count })),
    };
  };
  return [half(request.items.slice(0, mid)), half(request.items.slice(mid))];
}

module.exports = { planReads, bisect };
