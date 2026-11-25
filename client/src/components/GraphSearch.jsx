import { useEffect, useMemo, useState } from 'react';
import { Search, X, Crosshair } from 'lucide-react';
import clsx from 'clsx';
import { topicMatches, isWildcard } from '@/lib/mqtt';
import { IconButton } from '@/components/ui';

/**
 * Search for a node graph. As the user types, it reports the set of matching
 * node ids (for highlight/dim) and can zoom-to-fit them. Purely presentational:
 * the parent owns the graph and applies the match set. MQTT wildcards (+, #)
 * match against the topic path.
 *
 * `inline` renders it as a toolbar item; otherwise it floats over the canvas
 * (top-left), as on the OPC UA and i3X pages.
 */
export default function GraphSearch({ nodes, onMatches, onFit, inline = false, className }) {
  const [query, setQuery] = useState('');

  const matchIds = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const wild = isWildcard(q);
    const lower = q.toLowerCase();
    const ids = new Set();
    for (const n of nodes) {
      const topic = n.meta?.fullTopic;
      if (wild) {
        // Wildcard queries match against the topic path
        if (topic && topicMatches(q, topic)) ids.add(n.id);
      } else {
        const hay = `${n.label} ${topic || ''} ${n.meta?.nodeId || ''} ${n.meta?.elementId || ''}`.toLowerCase();
        if (hay.includes(lower)) ids.add(n.id);
      }
    }
    return ids;
  }, [query, nodes]);

  useEffect(() => {
    onMatches(matchIds);
  }, [matchIds, onMatches]);

  const count = matchIds ? matchIds.size : 0;

  return (
    <div
      role="search"
      aria-label="Search graph nodes"
      className={clsx(
        'pointer-events-auto flex h-8 min-w-0 items-center gap-1 rounded-md border border-line-strong bg-field pl-2 pr-0.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent',
        !inline && 'absolute left-4 top-4 z-10 shadow-overlay',
        className
      )}
    >
      <Search size={14} className="shrink-0 text-subtle" aria-hidden="true" />
      <input
        type="search"
        aria-label="Search nodes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matchIds?.size) onFit(matchIds);
          if (e.key === 'Escape') setQuery('');
        }}
        placeholder="Search nodes or topic/#"
        className="w-36 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-hidden sm:w-44"
      />
      {query && (
        <>
          <span role="status" aria-label={`${count} matching ${count === 1 ? 'node' : 'nodes'}`} className={clsx('px-1 text-xs tabular-nums', count ? 'text-accent-text' : 'text-subtle')}>
            {count.toLocaleString()}
          </span>
          <IconButton icon={Crosshair} size={14} label="Zoom to matches" className="h-7 w-7" onClick={() => matchIds?.size && onFit(matchIds)} />
          <IconButton icon={X} size={14} label="Clear search" className="h-7 w-7" onClick={() => setQuery('')} />
        </>
      )}
    </div>
  );
}
