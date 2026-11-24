import { useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { groupColor } from '@/graph/buildGraph';
import { resolveGraphStyle } from '@/graph/graphStyles';
import { useCanvasTokens } from '@/graph/canvasTokens';

const ROW_H = 26;
const OVERSCAN = 8;

/**
 * Generic collapsible tree for any parent→child graph ({nodes, links}). Used by
 * the OPC UA and i3X views to offer the same tree/graph duality as MQTT. For
 * lazily-loaded sources (OPC UA), expanding a branch calls `onExpandNode` so the
 * page can browse deeper. Virtualized for large address spaces.
 */
export default function GraphTree({ nodes, links, selectedId, onSelect, onExpandNode, valueMap, filter = '' }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [cursor, setCursor] = useState(0); // roving tabindex: the one row in the tab order
  const scrollerRef = useRef(null);

  const { childrenOf, roots, byId } = useMemo(() => {
    const childrenOf = new Map();
    const incoming = new Set();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of links) {
      if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
      childrenOf.get(l.source).push(l.target);
      incoming.add(l.target);
    }
    const roots = nodes.filter((n) => !incoming.has(n.id));
    return { childrenOf, roots, byId };
  }, [nodes, links]);

  const matchIds = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set();
    // Keep matches and all their ancestors
    const parentOf = new Map();
    for (const l of links) parentOf.set(l.target, l.source);
    for (const n of nodes) {
      if (!n.label.toLowerCase().includes(q)) continue;
      let cur = n.id;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        keep.add(cur);
        guard.add(cur);
        cur = parentOf.get(cur);
      }
    }
    return keep;
  }, [filter, nodes, links]);

  const expandedKey = [...expanded].sort().join('|');
  const rows = useMemo(() => {
    const out = [];
    const forced = Boolean(matchIds);
    const walk = (id, depth, seen) => {
      const n = byId.get(id);
      if (!n || seen.has(id)) return;
      seen.add(id);
      let kids = childrenOf.get(id) || [];
      if (matchIds) kids = kids.filter((k) => matchIds.has(k));
      const hasChildren = kids.length > 0;
      const open = forced || expanded.has(id);
      out.push({ n, depth, hasChildren, open });
      if (hasChildren && open) {
        const sorted = kids.slice().sort((a, b) => (byId.get(a)?.label || '').localeCompare(byId.get(b)?.label || ''));
        for (const k of sorted) walk(k, depth + 1, seen);
      }
    };
    const seen = new Set();
    let rootList = roots;
    if (matchIds) rootList = roots.filter((r) => matchIds.has(r.id));
    for (const r of rootList.slice().sort((a, b) => a.label.localeCompare(b.label))) walk(r.id, 0, seen);
    return out;
    // expandedKey is the stable string form of `expanded` (cheaper to compare than the Set itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandedKey is the stable string form of `expanded`
  }, [byId, childrenOf, roots, expandedKey, matchIds]);

  const toggle = (n) => {
    if (onExpandNode && !expanded.has(n.id) && !(childrenOf.get(n.id) || []).length) onExpandNode(n);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
  };

  const style = resolveGraphStyle('standard', useCanvasTokens());
  const total = rows.length;
  const tabRow = Math.min(cursor, Math.max(total - 1, 0));

  // Move keyboard focus to another row, scrolling it into the virtual window first.
  const focusRow = (i) => {
    const n = Math.max(0, Math.min(total - 1, i));
    setCursor(n);
    const el = scrollerRef.current;
    if (!el) return;
    const top = n * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    setScrollTop(el.scrollTop);
    setViewH(el.clientHeight);
    // The row may not be rendered until the window updates.
    requestAnimationFrame(() => el.querySelector(`[data-row="${n}"]`)?.focus());
  };
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 py-2 text-xs tabular-nums text-subtle">{total.toLocaleString()} rows</div>
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewH(e.currentTarget.clientHeight);
        }}
        role="tree"
        aria-label="Nodes"
        className="relative flex-1 overflow-auto"
      >
        {total === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-subtle">Nothing to show.</p>
        ) : (
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {slice.map((row, i) => {
              const { n, depth, hasChildren, open } = row;
              const expandable = hasChildren || (onExpandNode && n.meta?.nodeClass === 'Object');
              const value = valueMap?.[n.id];
              return (
                <div
                  key={n.id}
                  role="treeitem"
                  data-row={start + i}
                  tabIndex={start + i === tabRow ? 0 : -1}
                  onFocus={() => setCursor(start + i)}
                  aria-selected={n.id === selectedId}
                  aria-level={depth + 1}
                  aria-expanded={expandable ? open : undefined}
                  onClick={() => onSelect(n)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(n);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                      e.preventDefault();
                      focusRow(e.key === 'Home' ? 0 : e.key === 'End' ? total - 1 : start + i + (e.key === 'ArrowDown' ? 1 : -1));
                    } else if (expandable && ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open))) {
                      e.preventDefault();
                      toggle(n);
                    }
                  }}
                  className={clsx(
                    'absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 pr-2 text-sm hover:bg-raised',
                    n.id === selectedId && 'bg-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))]'
                  )}
                  style={{ top: (start + i) * ROW_H, height: ROW_H, paddingLeft: `${depth * 14 + 8}px` }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={open ? `Collapse ${n.label}` : `Expand ${n.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (expandable) toggle(n);
                    }}
                    className={clsx('shrink-0 text-subtle', !expandable && 'invisible')}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: groupColor(n.group, style.palette) }}
                  />
                  <span className="truncate text-fg">{n.label}</span>
                  {value?.text != null && (
                    <span key={value.key} className="valueflash mono ml-auto truncate text-xs text-muted" style={{ maxWidth: 150 }}>
                      {value.text}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
