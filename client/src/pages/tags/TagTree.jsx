import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FolderClosed, CircleDot, Search, ListChecks, Link2, RefreshCw, Tags as TagsIcon } from 'lucide-react';
import clsx from 'clsx';
import { Button, EmptyState } from '@/components/ui';
import ErrorBanner from './Banner';
import { browse } from './tagsApi';
import { flattenVisible, treeKeyAction } from './treeNav';
import { boundFor } from './helpers';

const MAX_TAGS = 500; // bound for "select all in folder"
const MAX_CALLS = 40;

/**
 * Lazy, accessible tag tree (WAI-ARIA tree pattern, flat treeitems with aria-level).
 * selection: Map<nodeId, { id, address, name, meta }>.
 */
export default function TagTree({ source, selection, onToggle, onAddMany, boundIndex }) {
  const [nodes, setNodes] = useState({}); // browse key -> children[]
  const [loading, setLoading] = useState(() => new Set());
  const [errors, setErrors] = useState({}); // browse key -> message
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusKey, setFocusKey] = useState(null);
  const [filter, setFilter] = useState('');
  const [bulk, setBulk] = useState(null); // { busy, message }
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const inflight = useRef(new Set());
  const rowRefs = useRef(new Map());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (key, force = false) => {
      if (inflight.current.has(key)) return nodesRef.current[key];
      if (!force && nodesRef.current[key]) return nodesRef.current[key];
      inflight.current.add(key);
      setLoading((s) => new Set(s).add(key));
      setErrors((e) => {
        if (!(key in e)) return e;
        const { [key]: _drop, ...rest } = e;
        return rest;
      });
      try {
        const children = await browse(source, key);
        nodesRef.current = { ...nodesRef.current, [key]: children };
        if (alive.current) setNodes((n) => ({ ...n, [key]: children }));
        return children;
      } catch (e) {
        if (alive.current) setErrors((x) => ({ ...x, [key]: e.message }));
        return null;
      } finally {
        inflight.current.delete(key);
        if (alive.current) {
          setLoading((s) => {
            const n = new Set(s);
            n.delete(key);
            return n;
          });
        }
      }
    },
    [source]
  );

  useEffect(() => {
    load('');
  }, [load]);

  const reload = () => {
    nodesRef.current = {};
    setNodes({});
    setExpanded(new Set());
    setErrors({});
    setBulk(null);
    load('', true);
  };

  const items = useMemo(() => flattenVisible(nodes, expanded, filter), [nodes, expanded, filter]);
  const tabKey = items.some((i) => i.key === focusKey) ? focusKey : items[0]?.key;

  const focusRow = (key) => {
    setFocusKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };

  const expand = (item) => {
    setExpanded((s) => new Set(s).add(item.key));
    load(item.node.address);
  };
  const collapse = (item) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.delete(item.key);
      return n;
    });

  // Select every tag under a folder: breadth-first, bounded by MAX_TAGS / MAX_CALLS.
  const selectFolder = async (folder) => {
    setBulk({ busy: true, message: `Loading tags under ${folder.name}...` });
    const found = [];
    const queue = [folder.address];
    let calls = 0;
    let truncated = false;
    let failed = false;
    while (queue.length) {
      const key = queue.shift();
      let children = nodesRef.current[key];
      if (!children) {
        if (calls >= MAX_CALLS) {
          truncated = true;
          break;
        }
        calls++;
        children = await load(key);
        if (!children) {
          failed = true;
          continue;
        }
      }
      for (const c of children) {
        if (c.kind === 'tag') {
          if (found.length >= MAX_TAGS) {
            truncated = true;
            break;
          }
          found.push(c);
        } else queue.push(c.address);
      }
      if (found.length >= MAX_TAGS) {
        truncated = truncated || queue.length > 0;
        break;
      }
    }
    if (!alive.current) return;
    const added = onAddMany(found);
    setBulk({
      busy: false,
      message:
        `Selected ${found.length} tag${found.length === 1 ? '' : 's'} under ${folder.name}` +
        (added < found.length ? ` (${found.length - added} already selected)` : '') +
        (truncated ? `. Stopped at the limit (${MAX_TAGS} tags / ${MAX_CALLS} folders); select sub-folders to add more.` : '.') +
        (failed ? ' Some folders failed to load.' : '')
    });
  };

  const activate = (item, action) => {
    if (!action) return;
    switch (action.type) {
      case 'focus':
        focusRow(action.key);
        break;
      case 'expand':
        expand(item);
        break;
      case 'collapse':
        collapse(item);
        break;
      case 'toggle-expand':
        if (item.expanded) collapse(item);
        else expand(item);
        break;
      case 'toggle-select':
        if (item.isFolder) selectFolder(item.node);
        else onToggle(item.node);
        break;
      default:
    }
  };

  const onKeyDown = (e, item) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const action = treeKeyAction(items, item.key, e.key);
    if (!action) return;
    e.preventDefault();
    // Left/Right/Enter act on the focused row; focus actions carry their own target.
    const target = items.find((i) => i.key === action.key) || item;
    activate(target, action);
  };

  const rootErr = errors[''];
  const rootLoaded = nodes[''];
  const otherErrors = Object.entries(errors).filter(([k]) => k !== '');
  const filtering = filter.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter loaded tags"
            aria-describedby="tag-filter-note"
            placeholder="Filter loaded tags..."
            className="w-full rounded-xl border border-white/10 bg-surface-950/60 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder:text-slate-400 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
          />
        </div>
        <Button size="sm" variant="outline" onClick={reload} aria-label="Reload tree">
          <RefreshCw size={12} aria-hidden="true" /> Reload
        </Button>
      </div>
      <p id="tag-filter-note" className="text-xs text-slate-400">
        {filtering
          ? 'Showing matches among nodes already loaded. Deeper levels load when you expand a folder.'
          : 'Deeper levels load when you expand a folder. Keys: arrows move, Right/Left expand/collapse, Space selects, Enter expands.'}
      </p>
      <div aria-live="polite" className="min-h-0 text-xs text-slate-300">
        {bulk && <span role="status">{bulk.message}</span>}
      </div>

      {rootErr && <ErrorBanner title="Could not load this source's tags" message={rootErr} onRetry={() => load('', true)} busy={loading.has('')} />}
      {otherErrors.map(([k, msg]) => (
        <ErrorBanner key={k} title={`Could not load folder ${k}`} message={msg} onRetry={() => load(k, true)} busy={loading.has(k)} />
      ))}

      {!rootErr && !rootLoaded && <p className="py-2 text-xs text-slate-400">Loading...</p>}
      {rootLoaded && rootLoaded.length === 0 && (
        <div className="min-h-[12rem] flex-1">
          <EmptyState
            icon={TagsIcon}
            title="Connected, but nothing to browse yet"
            hint={
              source.type === 'sparkplug'
                ? 'No Sparkplug birth certificates seen yet. Metrics appear once an edge node publishes NBIRTH/DBIRTH on this broker.'
                : source.type === 'mqtt'
                  ? 'No topics observed on this broker yet. They appear as messages arrive.'
                  : 'This source returned no nodes. Check its configuration, then reload.'
            }
            action={<Button size="sm" variant="outline" onClick={reload}>Reload</Button>}
          />
        </div>
      )}
      {filtering && rootLoaded && rootLoaded.length > 0 && items.length === 0 && (
        <p className="py-2 text-xs text-slate-300">No loaded node matches &quot;{filter}&quot;. Expand folders to load deeper levels.</p>
      )}

      {items.length > 0 && (
        <div
          role="tree"
          aria-label={`Tags in ${source.label}`}
          aria-multiselectable="true"
          className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/5 bg-black/10 p-1"
        >
          {items.map((item) => {
            const { node } = item;
            const isTag = !item.isFolder;
            const selected = isTag && selection.has(node.id);
            const bound = isTag ? boundFor(boundIndex, source, node) : [];
            const busyRow = item.isFolder && loading.has(node.address);
            return (
              <div
                key={item.key}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.key, el);
                  else rowRefs.current.delete(item.key);
                }}
                role="treeitem"
                aria-level={item.level}
                aria-posinset={item.posInSet}
                aria-setsize={item.setSize}
                aria-expanded={item.isFolder ? item.expanded : undefined}
                aria-selected={isTag ? selected : undefined}
                aria-checked={isTag ? selected : undefined}
                aria-busy={busyRow || undefined}
                tabIndex={item.key === tabKey ? 0 : -1}
                onFocus={() => setFocusKey(item.key)}
                onKeyDown={(e) => e.target === e.currentTarget && onKeyDown(e, item)}
                onClick={() => {
                  setFocusKey(item.key);
                  if (isTag) onToggle(node);
                  else if (item.expanded) collapse(item);
                  else expand(item);
                }}
                style={{ paddingLeft: `${(item.level - 1) * 16 + 6}px` }}
                className={clsx(
                  'flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-2 text-xs outline-none',
                  'hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent-400',
                  selected && 'bg-accent-500/10'
                )}
              >
                {isTag ? (
                  <>
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={selected}
                      onChange={() => onToggle(node)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${node.name}`}
                      className="h-3.5 w-3.5 shrink-0 accent-accent-500"
                    />
                    <CircleDot size={12} className="shrink-0 text-teal-400" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    {item.expanded ? <ChevronDown size={13} className="shrink-0 text-slate-400" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-slate-400" aria-hidden="true" />}
                    <FolderClosed size={12} className="shrink-0 text-slate-400" aria-hidden="true" />
                  </>
                )}
                <span className={clsx('min-w-0 truncate', isTag ? 'font-mono text-slate-100' : 'text-slate-200')} title={node.address}>
                  {node.name}
                </span>
                {node.meta?.subtreeCount > 1 && <span className="text-xs text-slate-400">{node.meta.subtreeCount}</span>}
                {busyRow && <span className="text-xs text-slate-400">loading...</span>}
                {bound.length > 0 && (
                  <span
                    title={`Already bound: ${bound.map((b) => `${b.name} -> ${b.path}`).join('; ')}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300 ring-1 ring-inset ring-emerald-500/30"
                  >
                    <Link2 size={10} aria-hidden="true" /> bound
                  </span>
                )}
                {item.isFolder && (
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={bulk?.busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectFolder(node);
                    }}
                    aria-label={`Select all tags in ${node.name}`}
                    title="Select all tags in this folder (loads sub-folders, up to 500 tags)"
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
                  >
                    <ListChecks size={12} aria-hidden="true" /> Select all
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
