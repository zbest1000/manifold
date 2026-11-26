import { useEffect, useMemo, useState } from 'react';
import { Crosshair } from 'lucide-react';
import clsx from 'clsx';
import { searchNodes } from '@/lib/nodeSearch';
import { IconButton } from '@/components/ui';
import SearchPick from './SearchPick';

/**
 * Search for a node graph. As the user types, it reports the set of matching
 * node ids (for highlight/dim) and lists the matches to pick from (arrows,
 * Enter, Escape; see SearchPick). Picking a node calls `onPick(node)` (select
 * and reveal it) or, without `onPick`, frames that node. The crosshair frames
 * every match. MQTT wildcards (+, #) match against the topic path.
 *
 * `inline` renders it as a toolbar item; otherwise it floats over the canvas
 * (top-left), as on the OPC UA and i3X pages.
 */
export default function GraphSearch({ nodes, onMatches, onFit, onPick, inline = false, className }) {
  const [query, setQuery] = useState('');

  const items = useMemo(
    () => nodes.map((n) => ({ id: n.id, label: String(n.label ?? n.id), path: n.meta?.fullTopic || n.meta?.nodeId || n.meta?.elementId || '', node: n })),
    [nodes]
  );
  const matchIds = useMemo(() => {
    if (!query.trim()) return null;
    return new Set(searchNodes(items, query, { limit: Infinity }).results.map((r) => r.id));
  }, [query, items]);

  useEffect(() => {
    onMatches(matchIds);
  }, [matchIds, onMatches]);

  const pick = (item) => {
    if (onPick) onPick(item.node);
    else onFit(new Set([item.id]));
  };

  return (
    <div role="search" aria-label="Search graph nodes" className={clsx('pointer-events-auto flex min-w-0 items-center gap-1', !inline && 'absolute left-4 top-4 z-10 rounded-md bg-panel shadow-overlay', className)}>
      <SearchPick items={items} onPick={pick} onQuery={(q) => setQuery(q)} onEnterNoPick={(ids) => ids.size && onFit(ids)} label="Search nodes" placeholder="Search nodes or topic/#" className="flex-1" testId="graph-search" />
      {matchIds?.size > 0 && <IconButton icon={Crosshair} size={14} label="Zoom to matches" className="h-8 w-8 shrink-0" onClick={() => onFit(matchIds)} />}
    </div>
  );
}
