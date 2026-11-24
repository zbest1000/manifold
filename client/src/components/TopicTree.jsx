import { useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Pin, ArrowDownAZ, Hash, Clock } from 'lucide-react';
import clsx from 'clsx';
import { topicMatches } from '@/lib/mqtt';

const ROW_H = 26; // fixed row height enables windowing
const OVERSCAN = 8;

/**
 * MQTT-Explorer-style collapsible topic tree, virtualized so it stays smooth
 * from a handful of topics up to ~1M: the expanded rows are flattened into a
 * linear list and only the rows in the viewport are rendered. Shows per-topic
 * message count, retained flag, live value with a flash on change, plus sort and
 * filter.
 */
export default function TopicTree({ topics, selectedTopic, onSelect, filter = '' }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('name');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const scrollerRef = useRef(null);
  const [focusIdx, setFocusIdx] = useState(0); // keyboard cursor (row index)
  const uid = useId();

  const root = useMemo(() => buildTree(topics), [topics]);

  const visiblePaths = useMemo(() => {
    const q = filter.trim();
    if (!q) return null;
    const keep = new Set();
    for (const t of topics) {
      if (!topicMatches(q, t.topic)) continue;
      let acc = '';
      for (const s of t.topic.split('/')) {
        acc = acc ? `${acc}/${s}` : s;
        keep.add(acc);
      }
    }
    return keep;
  }, [filter, topics]);

  const expandedKey = useMemo(() => [...expanded].sort().join('|'), [expanded]);

  // Flatten expanded (or filter-forced) rows into a linear list for windowing.
  const rows = useMemo(() => {
    const out = [];
    const forced = Boolean(visiblePaths);
    const cmp =
      sortBy === 'messages'
        ? (a, b) => (b.stat?.messageCount || 0) - (a.stat?.messageCount || 0)
        : sortBy === 'recent'
          ? (a, b) => new Date(b.stat?.lastActivity || 0) - new Date(a.stat?.lastActivity || 0)
          : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

    const walk = (node, depth) => {
      let children = [...node.children.values()];
      if (visiblePaths) children = children.filter((c) => visiblePaths.has(c.path));
      children.sort(cmp);
      for (const c of children) {
        const hasChildren = c.children.size > 0;
        const open = forced || expanded.has(c.path);
        out.push({ c, depth, hasChildren, open });
        if (hasChildren && open) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandedKey is the stable string form of `expanded`
  }, [root, expandedKey, visiblePaths, sortBy]);

  const toggle = (path) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const total = rows.length;
  const cursor = Math.min(focusIdx, Math.max(total - 1, 0));
  const rowId = (i) => `${uid}-row-${i}`;

  // Keep the keyboard cursor row inside the scroll viewport.
  const reveal = (i) => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    setScrollTop(el.scrollTop);
    setViewH(el.clientHeight);
  };
  const moveTo = (i) => {
    const n = Math.max(0, Math.min(total - 1, i));
    setFocusIdx(n);
    reveal(n);
  };

  // WAI-ARIA tree keys: Up/Down move, Right expands or enters, Left collapses
  // or goes to the parent, Enter/Space selects (or toggles a branch), Home/End jump.
  const onKeyDown = (e) => {
    if (!total) return;
    const row = rows[cursor];
    if (!row) return;
    const { c, depth, hasChildren, open } = row;
    let handled = true;
    if (e.key === 'ArrowDown') moveTo(cursor + 1);
    else if (e.key === 'ArrowUp') moveTo(cursor - 1);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(total - 1);
    else if (e.key === 'ArrowRight') {
      if (hasChildren && !open) toggle(c.path);
      else if (hasChildren && open) moveTo(cursor + 1);
    } else if (e.key === 'ArrowLeft') {
      if (hasChildren && open && !visiblePaths) toggle(c.path);
      else {
        for (let i = cursor - 1; i >= 0; i--) {
          if (rows[i].depth < depth) {
            moveTo(i);
            break;
          }
        }
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (c.stat) onSelect(c);
      else if (hasChildren) toggle(c.path);
    } else handled = false;
    if (handled) e.preventDefault();
  };

  // Pointer activation is delegated to the tree (the keyboard path is onKeyDown),
  // so rows stay plain presentational treeitems under aria-activedescendant.
  const onTreeClick = (e) => {
    const el = e.target.closest?.('[data-row]');
    if (!el) return;
    const i = Number(el.dataset.row);
    const row = rows[i];
    if (!row) return;
    setFocusIdx(i);
    if (row.c.stat) onSelect(row.c);
    else if (row.hasChildren) toggle(row.c.path);
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);

  // MQTT 5 properties of the selected topic's latest message (v5 sessions
  // only). Memoized on selection/topic-set changes so scrolling never rescans.
  const selectedProps = useMemo(() => {
    if (!selectedTopic) return null;
    for (const t of topics) {
      if (t.topic === selectedTopic) return t.properties || null;
    }
    return null;
  }, [topics, selectedTopic]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-2 text-xs text-slate-400">
        <span className="mr-auto">{total.toLocaleString()} rows</span>
        <SortBtn active={sortBy === 'name'} onClick={() => setSortBy('name')} icon={ArrowDownAZ} label="Name" />
        <SortBtn active={sortBy === 'messages'} onClick={() => setSortBy('messages')} icon={Hash} label="Msgs" />
        <SortBtn active={sortBy === 'recent'} onClick={() => setSortBy('recent')} icon={Clock} label="Recent" />
      </div>
      <div
        ref={scrollerRef}
        role="tree"
        aria-label="Topic tree"
        aria-activedescendant={total ? rowId(cursor) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={onTreeClick}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewH(e.currentTarget.clientHeight);
        }}
        className="relative flex-1 overflow-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400/70"
      >
        {total === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-400">No topics match. Clear the filter to see everything.</p>
        ) : (
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {slice.map((row, i) => {
              const { c, depth, hasChildren, open } = row;
              const isSelected = c.stat && c.path === selectedTopic;
              return (
                <div
                  key={c.path}
                  id={rowId(start + i)}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={hasChildren ? open : undefined}
                  aria-selected={Boolean(isSelected)}
                  data-row={start + i}
                  className={clsx(
                    'absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 pr-2 text-sm hover:bg-white/5',
                    isSelected && 'bg-accent-500/15',
                    start + i === cursor && 'outline outline-1 -outline-offset-1 outline-accent-400/60'
                  )}
                  style={{ top: (start + i) * ROW_H, height: ROW_H, paddingLeft: `${depth * 14 + 8}px` }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={open ? `Collapse ${c.name}` : `Expand ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (hasChildren) toggle(c.path);
                    }}
                    className={clsx('shrink-0 text-slate-400', !hasChildren && 'invisible')}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>

                  <span className={clsx('truncate', c.stat ? 'text-slate-200' : 'font-medium text-slate-300')}>
                    {c.name}
                  </span>

                  {c.stat?.retain && <Pin size={10} className="shrink-0 text-amber-400" />}

                  {hasChildren && (
                    <span className="shrink-0 rounded bg-white/5 px-1.5 text-xs text-slate-400">
                      {c.descendants.toLocaleString()}
                    </span>
                  )}

                  {c.stat && (
                    <span className="ml-auto flex min-w-0 items-center gap-2">
                      <span key={c.stat.lastActivity} className="valueflash mono truncate text-xs text-accent-200" style={{ maxWidth: 150 }}>
                        {formatValue(c.stat.payload)}
                      </span>
                      <span className="shrink-0 text-xs text-slate-400">{c.stat.messageCount}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedProps && (
        <div className="border-t border-white/5 px-3 py-2 text-xs">
          <p className="mb-1 font-medium uppercase tracking-wide text-slate-400">MQTT 5 properties</p>
          <div className="space-y-0.5">
            {selectedProps.contentType && <PropRow name="contentType" value={selectedProps.contentType} />}
            {selectedProps.responseTopic && <PropRow name="responseTopic" value={selectedProps.responseTopic} />}
            {selectedProps.correlationData && <PropRow name="correlationData" value={selectedProps.correlationData} />}
            {selectedProps.userProperties &&
              Object.entries(selectedProps.userProperties).map(([k, v]) => (
                <PropRow key={k} name={k} value={String(v)} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PropRow({ name, value }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-slate-400">{name}</span>
      <span className="mono min-w-0 truncate text-slate-300" title={value}>
        {value}
      </span>
    </div>
  );
}

function SortBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex items-center gap-1 rounded px-1.5 py-0.5 transition',
        active ? 'bg-accent-500/20 text-accent-200' : 'hover:bg-white/5 hover:text-slate-200'
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
      let child = node.children.get(segs[i]);
      if (!child) {
        child = { name: segs[i], path: acc, children: new Map(), stat: null, descendants: 0 };
        node.children.set(segs[i], child);
      }
      node = child;
      if (i === segs.length - 1) node.stat = t;
    }
  }
  countDescendants(root);
  return root;
}

function countDescendants(node) {
  let total = 0;
  for (const c of node.children.values()) total += countDescendants(c) + (c.stat ? 1 : 0);
  node.descendants = total;
  return total;
}

function formatValue(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}
