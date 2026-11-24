/** Pure helpers for sortable tables. */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Cycle asc -> desc -> asc on repeated clicks; a new key starts ascending. */
export function nextSort(sort, key) {
  if (sort && sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/**
 * Return a sorted copy of `rows`. `accessors[key]` maps a row to its sort value
 * (defaults to row[key]). Numbers compare numerically, strings naturally
 * ("pump2" < "pump10"); null/undefined always sort last regardless of direction.
 */
export function sortRows(rows, sort, accessors = {}) {
  if (!sort || !sort.key) return rows;
  const get = accessors[sort.key] || ((r) => r?.[sort.key]);
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || a.v === '';
      const bn = b.v === null || b.v === undefined || b.v === '';
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      let c;
      if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
      else if (typeof a.v === 'boolean' && typeof b.v === 'boolean') c = Number(a.v) - Number(b.v);
      else c = collator.compare(String(a.v), String(b.v));
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/** Value for the aria-sort attribute. */
export function ariaSort(sort, key) {
  if (!sort || sort.key !== key) return 'none';
  return sort.dir === 'asc' ? 'ascending' : 'descending';
}
