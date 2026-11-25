import { useMemo } from 'react';
import { rawName } from '../mappingModel';

const FILTERS_BASE = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'Published' },
  { value: 'off', label: 'Off' }
];

/** The per-tag table's view: problems by row, the filtered rows and the filter choices. */
export function useTagView({ rows, selectMode, verdicts, shown, filter, query }) {
  const problemsByRow = useMemo(() => {
    const m = new Map();
    for (const e of shown) if (e.rowKey) m.set(e.rowKey, [...(m.get(e.rowKey) || []), e]);
    return m;
  }, [shown]);
  const q = query.trim().toLowerCase();
  const viewRows = useMemo(
    () =>
      rows.filter((r) => {
        const v = verdicts.get(r.key);
        if (filter === 'on' && !(r.enabled && v.matched)) return false;
        if (filter === 'off' && (r.enabled || !v.matched)) return false;
        if (filter === 'excluded' && v.matched) return false;
        if (filter === 'attention' && !(problemsByRow.has(r.key) || rawName(r.name))) return false;
        if (q && !`${r.address} ${r.name} ${r.def.property || ''} ${r.ov.description ?? r.def.description ?? ''}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [rows, verdicts, filter, q, problemsByRow]
  );
  const attentionCount = useMemo(() => rows.filter((r) => problemsByRow.has(r.key) || rawName(r.name)).length, [rows, problemsByRow]);
  const filters = [
    ...FILTERS_BASE,
    ...(selectMode === 'rules' ? [{ value: 'excluded', label: 'Excluded' }] : []),
    ...(attentionCount ? [{ value: 'attention', label: `Needs attention ${attentionCount}` }] : [])
  ];
  const currentFilter = filters.some((f) => f.value === filter) ? filter : 'all';
  return { problemsByRow, viewRows, filters, currentFilter };
}
