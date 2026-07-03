import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Pin, ArrowDownAZ, Hash, Clock } from 'lucide-react';
import clsx from 'clsx';

/**
 * Classic MQTT-Explorer-style collapsible topic tree. Builds a hierarchy from
 * the flat topic list, renders only expanded rows (fast at thousands of topics),
 * and shows per-topic message count, retained flag, live value and a flash on
 * change. Sorting and filtering are built in.
 */
export default function TopicTree({ topics, selectedTopic, onSelect, filter = '' }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('name');

  const root = useMemo(() => buildTree(topics), [topics]);

  // Filter: keep leaves matching the query plus all their ancestors.
  const visiblePaths = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set();
    for (const t of topics) {
      if (!t.topic.toLowerCase().includes(q)) continue;
      const segs = t.topic.split('/');
      let acc = '';
      for (const s of segs) {
        acc = acc ? `${acc}/${s}` : s;
        keep.add(acc);
      }
    }
    return keep;
  }, [filter, topics]);

  // Auto-expand ancestors of matches while filtering.
  const effectiveExpanded = visiblePaths || expanded;

  const toggle = (path) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2 text-[11px] text-slate-500">
        <span className="mr-auto">Sort</span>
        <SortBtn active={sortBy === 'name'} onClick={() => setSortBy('name')} icon={ArrowDownAZ} label="Name" />
        <SortBtn active={sortBy === 'messages'} onClick={() => setSortBy('messages')} icon={Hash} label="Msgs" />
        <SortBtn active={sortBy === 'recent'} onClick={() => setSortBy('recent')} icon={Clock} label="Recent" />
      </div>
      <div className="flex-1 overflow-auto py-1">
        {root.children.size === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-slate-500">No topics yet.</p>
        ) : (
          <TreeLevel
            node={root}
            depth={0}
            expanded={effectiveExpanded}
            forced={Boolean(visiblePaths)}
            visiblePaths={visiblePaths}
            toggle={toggle}
            sortBy={sortBy}
            selectedTopic={selectedTopic}
            onSelect={onSelect}
          />
        )}
      </div>
    </div>
  );
}

function TreeLevel({ node, depth, expanded, forced, visiblePaths, toggle, sortBy, selectedTopic, onSelect }) {
  const children = useMemo(() => {
    let arr = [...node.children.values()];
    if (visiblePaths) arr = arr.filter((c) => visiblePaths.has(c.path));
    arr.sort((a, b) => {
      if (sortBy === 'messages') return (b.stat?.messageCount || 0) - (a.stat?.messageCount || 0);
      if (sortBy === 'recent') return new Date(b.stat?.lastActivity || 0) - new Date(a.stat?.lastActivity || 0);
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    return arr;
  }, [node, sortBy, visiblePaths]);

  return (
    <>
      {children.map((c) => {
        const hasChildren = c.children.size > 0;
        const isOpen = forced ? true : expanded.has(c.path);
        const isSelected = c.stat && c.path === selectedTopic;
        return (
          <div key={c.path}>
            <div
              onClick={() => (c.stat ? onSelect(c) : hasChildren && toggle(c.path))}
              className={clsx(
                'group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-sm hover:bg-white/5',
                isSelected && 'bg-accent-500/15'
              )}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) toggle(c.path);
                }}
                className={clsx('shrink-0 text-slate-500', !hasChildren && 'invisible')}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>

              <span className={clsx('truncate', c.stat ? 'text-slate-200' : 'font-medium text-slate-300')}>
                {c.name}
              </span>

              {c.stat?.retain && <Pin size={10} className="shrink-0 text-amber-400" title="Retained" />}

              {hasChildren && (
                <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] text-slate-500">{c.descendants}</span>
              )}

              {c.stat && (
                <span className="ml-auto flex min-w-0 items-center gap-2">
                  <span key={c.stat.lastActivity} className="valueflash mono truncate text-xs text-accent-200" style={{ maxWidth: 160 }}>
                    {formatValue(c.stat.payload)}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-600">{c.stat.messageCount}</span>
                </span>
              )}
            </div>

            {hasChildren && isOpen && (
              <TreeLevel
                node={c}
                depth={depth + 1}
                expanded={expanded}
                forced={forced}
                visiblePaths={visiblePaths}
                toggle={toggle}
                sortBy={sortBy}
                selectedTopic={selectedTopic}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function SortBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1 rounded px-1.5 py-0.5 transition',
        active ? 'bg-accent-500/20 text-accent-200' : 'hover:bg-white/5 hover:text-slate-300'
      )}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function buildTree(topics) {
  const root = { name: '', path: '', children: new Map(), stat: null, descendants: 0 };
  for (const t of topics) {
    const segs = t.topic.split('/').filter(Boolean);
    let node = root;
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      if (!node.children.has(segs[i])) {
        node.children.set(segs[i], { name: segs[i], path: acc, children: new Map(), stat: null, descendants: 0 });
      }
      node = node.children.get(segs[i]);
      if (i === segs.length - 1) node.stat = t;
    }
  }
  countDescendants(root);
  return root;
}

function countDescendants(node) {
  let total = 0;
  for (const c of node.children.values()) {
    total += countDescendants(c) + (c.stat ? 1 : 0);
  }
  node.descendants = total;
  return total;
}

function formatValue(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}
