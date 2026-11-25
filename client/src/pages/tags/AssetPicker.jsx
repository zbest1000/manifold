import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import clsx from 'clsx';
import { Dialog, Button, Input, Banner, Spinner } from '@/components/ui';
import { topicChildren } from './tagsApi';
import { validateAssetPath, normalizeAssetPath, visibleRows } from './assetPath';

/**
 * Dialog to choose an existing branch of the UNS (lazy, one level per request, via the same
 * topic-tree API the Flows view uses) or type a new path. Keyboard: arrows move, Right/Left
 * expand/collapse, Enter or Space picks a branch; the text field accepts a brand-new path.
 */
export default function AssetPicker({ brokerId, value, onPick, onClose }) {
  const [childrenOf, setChildrenOf] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(() => new Set());
  const [errors, setErrors] = useState({});
  const [draft, setDraft] = useState(normalizeAssetPath(value));
  const pathId = useId();
  const [focusPath, setFocusPath] = useState('');
  const refs = useRef(new Map());

  const load = useCallback(
    async (prefix) => {
      setLoading((s) => new Set(s).add(prefix));
      try {
        const res = await topicChildren(brokerId, prefix);
        // $-prefixed segments ($SYS) are reserved broker topics, never an asset.
        const kids = (res?.children || []).filter((c) => !c.segment.startsWith('$')).sort((a, b) => a.segment.localeCompare(b.segment));
        setChildrenOf((m) => new Map(m).set(prefix, kids));
        setErrors((e) => ({ ...e, [prefix]: null }));
      } catch (e) {
        setErrors((x) => ({ ...x, [prefix]: e.message }));
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(prefix);
          return n;
        });
      }
    },
    [brokerId]
  );

  useEffect(() => {
    if (brokerId) load('');
  }, [brokerId, load]);

  const rows = useMemo(() => visibleRows(childrenOf, expanded), [childrenOf, expanded]);
  // A node that is a topic with no deeper topics is data, not a branch to publish under.
  const isLeaf = (r) => r.isTopic && r.subtreeCount <= 1;
  const focusRow = (path) => {
    setFocusPath(path);
    refs.current.get(path)?.focus();
  };
  const expand = (r) => {
    if (isLeaf(r)) return;
    setExpanded((s) => new Set(s).add(r.path));
    if (!childrenOf.has(r.path)) load(r.path);
  };
  const collapse = (r) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.delete(r.path);
      return n;
    });

  const onKey = (e, r, i) => {
    const move = (j) => rows[j] && (e.preventDefault(), focusRow(rows[j].path));
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (expanded.has(r.path)) move(i + 1);
      else expand(r);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (expanded.has(r.path)) collapse(r);
      else {
        const parent = r.path.split('/').slice(0, -1).join('/');
        if (parent) focusRow(parent);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && !isLeaf(r)) {
      e.preventDefault();
      setDraft(r.path);
    }
  };

  const err = draft ? validateAssetPath(normalizeAssetPath(draft)) : null;
  const rootError = errors[''];
  const tabbable = rows.some((r) => r.path === focusPath) ? focusPath : rows[0]?.path;

  return (
    <Dialog
      title="Choose an asset path"
      description="Pick an existing branch of the namespace, then add segments if the asset does not exist yet."
      onClose={onClose}
      size="md"
      onSubmit={() => !err && draft && onPick(normalizeAssetPath(draft))}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!draft || Boolean(err)}>
            Use this path
          </Button>
        </>
      }
    >
      {rootError && (
        <Banner variant="error" title="Could not load the namespace" onRetry={() => load('')} className="mb-2">
          {rootError}
        </Banner>
      )}
      <div role="tree" aria-label="UNS branches" className="h-64 overflow-auto rounded-md border border-line bg-app p-1">
        {!rootError && loading.has('') && (
          <p className="flex items-center gap-2 p-2 text-sm text-muted">
            <Spinner size={12} /> Loading…
          </p>
        )}
        {!rootError && !loading.has('') && rows.length === 0 && <p className="p-2 text-sm text-muted">No topics seen on this broker yet. Type a new path below.</p>}
        {rows.map((r, i) => {
          const open = expanded.has(r.path);
          const leaf = isLeaf(r);
          return (
            <div key={r.path}>
              <div
                ref={(el) => (el ? refs.current.set(r.path, el) : refs.current.delete(r.path))}
                role="treeitem"
                tabIndex={r.path === tabbable ? 0 : -1}
                aria-level={r.level}
                aria-expanded={leaf ? undefined : open}
                aria-selected={draft === r.path}
                aria-disabled={leaf || undefined}
                onFocus={() => setFocusPath(r.path)}
                onKeyDown={(e) => onKey(e, r, i)}
                onClick={() => !leaf && setDraft(r.path)}
                style={{ paddingLeft: `${(r.level - 1) * 14 + 4}px` }}
                className={clsx(
                  'flex h-7 cursor-pointer items-center gap-1 rounded pr-2 text-sm',
                  draft === r.path ? 'bg-accent/[0.1] text-fg shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'text-fg hover:bg-raised',
                  leaf && 'cursor-default text-subtle hover:bg-transparent'
                )}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (open) collapse(r);
                    else expand(r);
                  }}
                  className={clsx('grid h-5 w-5 place-items-center rounded text-subtle', leaf && 'invisible')}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {leaf ? <FileText size={12} aria-hidden="true" className="text-faint" /> : <Folder size={12} aria-hidden="true" className="text-subtle" />}
                <span className="min-w-0 truncate font-mono text-xs">{r.segment}</span>
                <span className="ml-auto shrink-0 font-mono text-2xs text-subtle">{leaf ? 'data' : r.subtreeCount}</span>
              </div>
              {open && errors[r.path] && (
                <div style={{ paddingLeft: `${r.level * 14 + 4}px` }} className="py-1 pr-1">
                  <Banner variant="error" title="Could not load this branch" onRetry={() => load(r.path)}>
                    {errors[r.path]}
                  </Banner>
                </div>
              )}
              {open && loading.has(r.path) && (
                <p style={{ paddingLeft: `${r.level * 14 + 24}px` }} className="py-1 text-xs text-muted">
                  Loading…
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-1.5">
        <label htmlFor={pathId} className="block text-xs font-medium text-muted">
          Asset path
        </label>
        <Input id={pathId} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="acme/dallas/line4/filler" className="mono" aria-invalid={Boolean(err) || undefined} />
      </div>
      {err && (
        <p role="alert" className="mt-1.5 text-xs text-bad">
          {err}
        </p>
      )}
    </Dialog>
  );
}
