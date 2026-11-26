import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Search, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { Button, EmptyState, Input, IconButton, Banner, LoadingState, Tooltip, Badge } from '@/components/ui';
import { browse } from './tagsApi';
import { flattenVisible, treeKeyAction } from './treeNav';
import { boundFor } from './helpers';

const MAX_TAGS = 500; // bound for "select all in folder"
const MAX_CALLS = 40;

/**
 * Lazy, accessible tag tree (WAI-ARIA tree pattern, flat treeitems with aria-level), laid out as
 * columns: name and address, type, unit, and whether a mapping already publishes the tag.
 * selection: Map<nodeId, { id, address, name, meta }>.
 */
export default function TagTree({ source, selection, onToggle, onAddMany, boundIndex, toolbarEnd }) {
  const [nodes, setNodes] = useState({}); // browse key -> children[]
  const [loading, setLoading] = useState(() => new Set());
  const [errors, setErrors] = useState({}); // browse key -> message
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusKey, setFocusKey] = useState(null);
  const [filter, setFilter] = useState('');
  const [bulk, setBulk] = useState(null); // { busy, message }
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  });
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

  // A device's poll-group folders open by themselves: they are few, and the tags are what you came for.
  const openGroups = useCallback(
    (children) => {
      if (source.type !== 'device' || !children) return;
      const folders = children.filter((c) => c.kind === 'folder');
      if (!folders.length || folders.length > 8) return;
      setExpanded(new Set(folders.map((f) => f.id)));
      for (const f of folders) load(f.address);
    },
    [source.type, load]
  );

  useEffect(() => {
    load('').then(openGroups);
  }, [load, openGroups]);

  const reload = () => {
    nodesRef.current = {};
    setNodes({});
    setExpanded(new Set());
    setErrors({});
    setBulk(null);
    load('', true).then(openGroups);
  };

  const items = useMemo(() => flattenVisible(nodes, expanded, filter), [nodes, expanded, filter]);
  const tabKey = items.some((i) => i.key === focusKey) ? focusKey : items[0]?.key;
  const tagItems = items.filter((i) => !i.isFolder);
  const allShownSelected = tagItems.length > 0 && tagItems.every((i) => selection.has(i.node.id));

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
    setBulk({ busy: true, message: `Loading tags under ${folder.name}…` });
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
  const showMeta = source.type === 'device' || source.type === 'opcua' || source.type === 'iot'; // OPC UA / IoT: what the server or bridge says per tag

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative min-w-0 flex-1 basis-32">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
          <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter loaded tags" aria-describedby="tag-filter-note" placeholder="Filter loaded tags" className="pl-8" />
        </div>
        {tagItems.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (allShownSelected ? tagItems.forEach((i) => selection.has(i.node.id) && onToggle(i.node)) : onAddMany(tagItems.map((i) => i.node)))}
          >
            {allShownSelected ? 'Clear shown' : `Select shown (${tagItems.length})`}
          </Button>
        )}
        <IconButton icon={RefreshCw} size={14} label="Reload tree" onClick={reload} />
        {toolbarEnd}
      </div>
      <p id="tag-filter-note" className="sr-only">
        {filtering ? 'Showing matches among nodes already loaded. Deeper levels load when you expand a folder.' : 'Arrow keys move, Right and Left expand and collapse, Space selects, Enter expands.'}
      </p>
      <div aria-live="polite" className="empty:hidden border-b border-line px-3 py-1.5 text-xs text-muted">
        {bulk && <span role="status">{bulk.message}</span>}
      </div>

      {(rootErr || otherErrors.length > 0) && (
        <div className="space-y-2 p-3">
          {rootErr && (
            <Banner variant="error" title="Could not load this source's tags" onRetry={() => load('', true)}>
              {rootErr}
            </Banner>
          )}
          {otherErrors.map(([k, msg]) => (
            <Banner key={k} variant="error" title={`Could not load folder ${k}`} onRetry={() => load(k, true)}>
              {msg}
            </Banner>
          ))}
        </div>
      )}

      {!rootErr && !rootLoaded && <LoadingState label="tags" rows={5} className="m-3" />}
      {rootLoaded && rootLoaded.length === 0 && (
        <EmptyState
          title="Connected, but nothing to browse yet"
          hint={
            source.type === 'sparkplug'
              ? 'No Sparkplug birth certificates seen yet. Metrics appear once an edge node publishes NBIRTH or DBIRTH on this broker.'
              : source.type === 'mqtt'
                ? 'No topics seen on this broker yet. They appear as messages arrive.'
                : source.type === 'iot'
                  ? 'This IoT device has no tags yet. They appear when it publishes its first values or its description.'
                : 'This source returned no tags. Add tags to the device on the Devices page, then reload.'
          }
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Reload
            </Button>
          }
        />
      )}
      {filtering && rootLoaded && rootLoaded.length > 0 && items.length === 0 && <p className="px-3 py-3 text-sm text-muted">No loaded tag matches &quot;{filter}&quot;. Expand folders to load deeper levels.</p>}

      {items.length > 0 && (
        <>
          <div aria-hidden="true" className={clsx('grid h-8 shrink-0 items-center gap-2 border-b border-line pl-9 pr-3 text-xs font-medium text-muted', showMeta ? 'grid-cols-[minmax(0,1fr)_4.5rem] sm:grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem]' : 'grid-cols-[minmax(0,1fr)_4.5rem]')}>
            <span>Tag</span>
            {showMeta && <span className="hidden sm:block">Type</span>}
            {showMeta && <span className="hidden sm:block">Unit</span>}
            <span className="text-right">Mapped</span>
          </div>
          <div role="tree" aria-label={`Tags in ${source.label}`} aria-multiselectable="true" className="min-h-0 flex-1 overflow-y-auto py-1">
            {items.map((item) => {
              const { node } = item;
              const isTag = !item.isFolder;
              const selected = isTag && selection.has(node.id);
              const bound = isTag ? boundFor(boundIndex, source, node) : [];
              const busyRow = item.isFolder && loading.has(node.address);
              const meta = node.meta || {};
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
                  className={clsx(
                    'grid h-8 cursor-pointer items-center gap-2 pr-3 text-sm outline-hidden transition-colors duration-100',
                    'hover:bg-[rgb(var(--tint)/0.035)] focus-visible:shadow-[inset_0_0_0_2px_rgb(var(--focus))]',
                    selected && 'bg-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))]',
                    showMeta ? 'grid-cols-[minmax(0,1fr)_4.5rem] sm:grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem]' : 'grid-cols-[minmax(0,1fr)_4.5rem]'
                  )}
                >
                  <span className={clsx('flex min-w-0 items-center gap-2', item.isFolder && 'col-span-full')} style={{ paddingLeft: `${(item.level - 1) * 16 + 12}px` }}>
                    {isTag ? (
                      <input
                        type="checkbox"
                        tabIndex={-1}
                        checked={selected}
                        onChange={() => onToggle(node)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${node.name}`}
                        className="h-4 w-4 shrink-0 accent-accent"
                      />
                    ) : item.expanded ? (
                      <ChevronDown size={14} className="shrink-0 text-subtle" aria-hidden="true" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-subtle" aria-hidden="true" />
                    )}
                    <span className={clsx('min-w-0 truncate', isTag ? 'font-mono text-xs text-fg' : 'font-medium text-fg')} title={node.address}>
                      {node.name}
                    </span>
                    {isTag && meta.property && node.address !== node.name && <span className="hidden min-w-0 truncate font-mono text-2xs text-subtle sm:inline">{node.address}</span>}
                    {!isTag && meta.subtreeCount > 1 && <span className="shrink-0 font-mono text-2xs text-subtle">{meta.subtreeCount}</span>}
                    {busyRow && <span className="shrink-0 text-xs text-muted">loading…</span>}
                    {item.isFolder && (
                      <Button
                        size="sm"
                        variant="ghost"
                        tabIndex={-1}
                        disabled={bulk?.busy}
                        className="ml-auto h-6 px-1.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          selectFolder(node);
                        }}
                        aria-label={`Select all tags in ${node.name}`}
                        title="Select every tag in this folder (loads sub-folders, up to 500 tags)"
                      >
                        Select all
                      </Button>
                    )}
                  </span>
                  {isTag && showMeta && <span className="hidden truncate font-mono text-2xs text-subtle sm:block">{meta.type || ''}</span>}
                  {isTag && showMeta && <span className="hidden truncate text-xs text-muted sm:block">{meta.unit || ''}</span>}
                  {isTag && (
                    <span className="flex justify-end">
                      {bound.length > 0 && (
                        <Tooltip label={`Mapped by ${bound.map((b) => b.name).join(', ')}`} side="left">
                          <Badge>{bound.length > 1 ? `${bound.length} maps` : 'mapped'}</Badge>
                        </Tooltip>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
