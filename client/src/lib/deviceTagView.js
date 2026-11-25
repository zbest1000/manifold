// Pure helpers behind the live tag table on the device detail: build rows from the device's tags
// and the live values, filter, sort. Kept out of the component so 2,000 tags stay cheap and testable.
import { qualityInfo, isStale, formatReading, quarantineReasonText } from './deviceStatus';

/** Quality order for sorting: worst first when ascending. */
const QUALITY_RANK = { bad: 0, uncertain: 1, good: 2 };

/**
 * One row per tag: the definition merged with its latest sample.
 * `quarantineReasons` maps key -> { code, message, since }; `intervalOf` maps pollGroup -> effective ms.
 */
export function buildLiveRows(tags, values, quarantineReasons, intervalOf, now = Date.now()) {
  const q = quarantineReasons || {};
  return tags.map((t) => {
    const s = values?.[t.key];
    const quality = s ? qualityInfo(s.q) : null;
    const quarantined = Object.prototype.hasOwnProperty.call(q, t.key);
    return {
      key: t.key,
      address: t.address,
      type: t.type || (s && s.type) || '',
      unit: t.unit || '',
      pollGroup: t.pollGroup || '',
      origin: t.origin === 'profile' ? 'profile' : 'own',
      sample: s || null,
      quality: quality ? quality.key : 'none',
      qualityLabel: quality ? quality.label : 'No data',
      reason: s && s.qReason ? String(s.qReason) : '',
      quarantined,
      quarantineText: quarantined ? quarantineReasonText(q[t.key]) || 'rejected by the device' : '',
      // A Bad sample is already as loud as it gets; 'stale' is for values that look fine but stopped updating.
      stale: Boolean(s) && quality.key !== 'bad' && isStale(s, intervalOf?.[t.pollGroup] || 1000, now),
      ageMs: s && s.tRead ? Math.max(0, now - s.tRead) : null,
      display: s ? formatReading(s.v) : '—'
    };
  });
}

/** Filter by text (key, address, unit, reason) and a chip: all | problems | bad | stale | quarantined. */
export function filterLiveRows(rows, text, chip = 'all') {
  const needle = String(text || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (chip === 'bad' && r.quality !== 'bad') return false;
    if (chip === 'stale' && !r.stale) return false;
    if (chip === 'quarantined' && !r.quarantined) return false;
    if (chip === 'problems' && r.quality === 'good' && !r.stale && !r.quarantined) return false;
    if (!needle) return true;
    return `${r.key} ${r.address} ${r.unit} ${r.reason} ${r.quarantineText}`.toLowerCase().includes(needle);
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Stable sort by a column key; missing values always last. */
export function sortLiveRows(rows, sort) {
  if (!sort || !sort.key) return rows;
  const sign = sort.dir === 'desc' ? -1 : 1;
  const get = {
    key: (r) => r.key,
    value: (r) => (r.sample && typeof r.sample.v === 'number' ? r.sample.v : r.sample ? String(r.sample.v) : null),
    quality: (r) => (r.quality === 'none' ? null : QUALITY_RANK[r.quality] - (r.stale ? 0.5 : 0)),
    unit: (r) => r.unit || null,
    age: (r) => r.ageMs,
    quarantine: (r) => (r.quarantined ? r.quarantineText : null)
  }[sort.key];
  if (!get) return rows;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined;
      const bn = b.v === null || b.v === undefined;
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v));
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/** Counts for the filter chips. */
export function liveCounts(rows) {
  let bad = 0;
  let stale = 0;
  let quarantined = 0;
  let problems = 0;
  for (const r of rows) {
    if (r.quality === 'bad') bad++;
    if (r.stale) stale++;
    if (r.quarantined) quarantined++;
    if (r.quality !== 'good' || r.stale || r.quarantined) problems++;
  }
  return { all: rows.length, bad, stale, quarantined, problems };
}

/** The window of a virtualised list: rows [start, end) to render for a scroll offset. */
export function visibleWindow({ total, rowHeight, viewport, scrollTop, overscan = 8 }) {
  const first = Math.floor(scrollTop / rowHeight);
  const count = Math.ceil(viewport / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + count + overscan);
  return { start, end };
}
