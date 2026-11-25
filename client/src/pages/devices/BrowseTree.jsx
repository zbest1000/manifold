import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FolderClosed, CircleDot, Loader2, Ban } from 'lucide-react';
import clsx from 'clsx';
import { Banner, Badge } from '@/components/ui';
import { treeKeyAction } from '@/pages/tags/treeNav';
import { browseDevice } from './devicesApi';
import { flattenTree, nodeDisabledReason } from './model';

/**
 * Lazy WAI-ARIA tree over GET /devices/:id/browse. Nodes are keyed by their
 * `id` (folder ids such as "controller" are what the endpoint takes as `node`;
 * addresses are not unique across folders). Tags with `meta.hasChildren` (UDTs)
 * are selectable AND expandable. `selection` is a Map<id, node>.
 */
export default function BrowseTree({ deviceId, selection, onToggle, takenAddresses }) {
  const [nodes, setNodes] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(() => new Set());
  const [errors, setErrors] = useState({});
  const [focusKey, setFocusKey] = useState(null);
  const loaded = useRef({});
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
      if (!force && loaded.current[key]) return;
      setLoading((s) => new Set(s).add(key));
      setErrors((e) => ({ ...e, [key]: undefined }));
      try {
        const children = await browseDevice(deviceId, key);
        loaded.current[key] = children;
        if (alive.current) setNodes((n) => ({ ...n, [key]: children }));
      } catch (e) {
        if (alive.current) setErrors((x) => ({ ...x, [key]: e.message }));
      } finally {
        if (alive.current)
          setLoading((s) => {
            const n = new Set(s);
            n.delete(key);
            return n;
          });
      }
    },
    [deviceId]
  );

  useEffect(() => {
    load('');
  }, [load]);

  const items = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const tabKey = items.some((i) => i.key === focusKey) ? focusKey : items[0]?.key;

  const setOpen = (item, open) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (open) n.add(item.key);
      else n.delete(item.key);
      return n;
    });
    if (open) load(item.node.id);
  };
  const focusRow = (key) => {
    setFocusKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };
  const select = (item) => {
    const reason = nodeDisabledReason(item.node, takenAddresses);
    if (item.node.kind === 'tag' && !reason) onToggle(item.node);
    else if (item.isFolder) setOpen(item, !item.expanded);
  };

  const onKeyDown = (e, item) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target !== e.currentTarget) return;
    const action = treeKeyAction(items, item.key, e.key);
    if (!action) return;
    e.preventDefault();
    const target = items.find((i) => i.key === action.key) || item;
    if (action.type === 'focus') focusRow(action.key);
    else if (action.type === 'expand') setOpen(target, true);
    else if (action.type === 'collapse') setOpen(target, false);
    else if (action.type === 'toggle-expand') setOpen(target, !target.expanded);
    else if (action.type === 'toggle-select') select(target);
  };

  const failed = Object.entries(errors).filter(([, m]) => m);
  return (
    <div className="min-h-0 flex-1 space-y-2">
      <p className="helper">Keys: arrows move, Right/Left expand or collapse, Space selects, Enter expands. Folders and UDTs load when opened.</p>
      {failed.map(([k, msg]) => (
        <Banner key={k || 'root'} variant="error" title={`Could not load ${k ? `"${k}"` : 'the controller'}`} onRetry={() => load(k, true)}>
          {msg}
        </Banner>
      ))}
      {!nodes[''] && !errors[''] && (
        <p className="flex items-center gap-2 py-3 text-sm text-muted">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Reading the controller's tag list…
        </p>
      )}
      {nodes[''] && nodes[''].length === 0 && <p className="py-3 text-sm text-muted">The controller reported no tags.</p>}
      {items.length > 0 && (
        <div role="tree" aria-label="Controller tags" aria-multiselectable="true" className="max-h-[48vh] overflow-y-auto rounded-lg border border-line bg-app p-1">
          {items.map((item) => {
            const { node } = item;
            const isTag = node.kind === 'tag';
            const reason = nodeDisabledReason(node, takenAddresses);
            const selected = isTag && selection.has(node.id);
            const m = node.meta || {};
            return (
              <div
                key={item.key}
                ref={(el) => (el ? rowRefs.current.set(item.key, el) : rowRefs.current.delete(item.key))}
                role="treeitem"
                aria-level={item.level}
                aria-posinset={item.posInSet}
                aria-setsize={item.setSize}
                aria-expanded={item.isFolder ? item.expanded : undefined}
                aria-selected={isTag ? selected : undefined}
                aria-disabled={reason ? true : undefined}
                tabIndex={item.key === tabKey ? 0 : -1}
                onFocus={() => setFocusKey(item.key)}
                onKeyDown={(e) => onKeyDown(e, item)}
                onClick={() => {
                  setFocusKey(item.key);
                  if (isTag && !reason) onToggle(node);
                  else if (item.isFolder) setOpen(item, !item.expanded);
                }}
                style={{ paddingLeft: `${(item.level - 1) * 16 + 6}px` }}
                title={reason || node.address}
                className={clsx(
                  'flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--focus))]',
                  reason ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-raised',
                  selected && 'bg-accent/[0.08]'
                )}
              >
                {item.isFolder ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={item.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(item, !item.expanded);
                    }}
                    className="shrink-0 rounded p-0.5 text-subtle hover:bg-raised hover:text-fg"
                  >
                    {loading.has(node.id) ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : item.expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  </button>
                ) : (
                  <span className="w-[17px] shrink-0" />
                )}
                {isTag ? (
                  <>
                    <input type="checkbox" tabIndex={-1} checked={selected} disabled={Boolean(reason)} onChange={() => onToggle(node)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${node.name}`} className="h-3.5 w-3.5 shrink-0 accent-accent" />
                    {reason ? <Ban size={12} className="shrink-0 text-bad" aria-hidden="true" /> : <CircleDot size={12} className="shrink-0 text-faint" aria-hidden="true" />}
                  </>
                ) : (
                  <FolderClosed size={12} className="shrink-0 text-faint" aria-hidden="true" />
                )}
                <span className="mono min-w-0 truncate text-xs text-fg">{node.name}</span>
                {m.dataType && (
                  <Badge className="shrink-0">
                    {m.dataType}
                    {m.dims?.length ? `[${m.dims.join(',')}]` : ''}
                  </Badge>
                )}
                {reason && <span className="min-w-0 truncate text-xs text-bad">{reason}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
