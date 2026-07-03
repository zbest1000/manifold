import { useEffect, useMemo, useState } from 'react';
import { Search, X, Crosshair } from 'lucide-react';
import clsx from 'clsx';

/**
 * Search overlay for a node graph. As the user types, it reports the set of
 * matching node ids (for highlight/dim) and can zoom-to-fit them. Purely
 * presentational — the parent owns the graph and applies the match set.
 */
export default function GraphSearch({ nodes, onMatches, onFit }) {
  const [query, setQuery] = useState('');

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set();
    for (const n of nodes) {
      const hay = `${n.label} ${n.meta?.fullTopic || ''} ${n.meta?.nodeId || ''} ${n.meta?.elementId || ''}`.toLowerCase();
      if (hay.includes(q)) ids.add(n.id);
    }
    return ids;
  }, [query, nodes]);

  useEffect(() => {
    onMatches(matchIds);
  }, [matchIds, onMatches]);

  const count = matchIds ? matchIds.size : 0;

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-1.5 backdrop-blur">
      <Search size={15} className="text-slate-500" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && matchIds && matchIds.size && onFit(matchIds)}
        placeholder="Search nodes…"
        className="w-40 bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
      />
      {query && (
        <>
          <span className={clsx('text-[11px]', count ? 'text-accent-300' : 'text-slate-500')}>{count}</span>
          <button
            onClick={() => matchIds && matchIds.size && onFit(matchIds)}
            title="Zoom to matches"
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"
          >
            <Crosshair size={14} />
          </button>
          <button
            onClick={() => setQuery('')}
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"
          >
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}
