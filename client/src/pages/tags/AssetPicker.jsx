import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText, X } from 'lucide-react';
import clsx from 'clsx';
import { Modal, Button, Input } from '@/components/ui';
import ErrorBanner from './Banner';
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
  const [focusPath, setFocusPath] = useState('');
  const refs = useRef(new Map());

  const load = useCallback(async (prefix) => {
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
  }, [brokerId]);

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
  const collapse = (r) => setExpanded((s) => { const n = new Set(s); n.delete(r.path); return n; });

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
    <Modal title="Choose an asset path" onClose={onClose} className="max-w-xl p-4 sm:p-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-100">Choose an asset path</h3>
        <button type="button" onClick={onClose} aria-label="Close asset picker" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="mb-2 text-xs text-slate-400">Pick an existing branch of the namespace, then add new segments below if the asset does not exist yet.</p>

      {rootError && <ErrorBanner title="Could not load the namespace" message={rootError} onRetry={() => load('')} />}
      <div
        role="tree"
        aria-label="UNS branches"
        className="mt-2 h-64 overflow-auto rounded-xl border border-white/10 bg-black/20 p-1"
      >
        {!rootError && loading.has('') && <p className="p-2 text-xs text-slate-400">Loading...</p>}
        {!rootError && !loading.has('') && rows.length === 0 && (
          <p className="p-2 text-xs text-slate-400">No topics observed on this broker yet. Type a new path below.</p>
        )}
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
                  'flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent-500/60',
                  draft === r.path ? 'bg-accent-500/20 text-accent-100' : 'text-slate-200 hover:bg-white/5',
                  leaf && 'cursor-default text-slate-500 hover:bg-transparent'
                )}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={(e) => { e.stopPropagation(); if (open) collapse(r); else expand(r); }}
                  className={clsx('grid h-5 w-5 place-items-center rounded', leaf && 'invisible')}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {leaf ? <FileText size={12} aria-hidden="true" /> : <Folder size={12} aria-hidden="true" />}
                <span className="min-w-0 truncate font-mono">{r.segment}</span>
                <span className="ml-auto shrink-0 text-slate-500">{leaf ? 'data' : r.subtreeCount}</span>
              </div>
              {open && errors[r.path] && (
                <div style={{ paddingLeft: `${r.level * 14 + 4}px` }} className="py-1 pr-1">
                  <ErrorBanner title="Could not load this branch" message={errors[r.path]} onRetry={() => load(r.path)} />
                </div>
              )}
              {open && loading.has(r.path) && <p style={{ paddingLeft: `${r.level * 14 + 24}px` }} className="py-1 text-xs text-slate-400">Loading...</p>}
            </div>
          );
        })}
      </div>

      <label className="mt-3 block space-y-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Asset path</span>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="acme/dallas/line4/filler" className="font-mono" aria-invalid={Boolean(err) || undefined} />
      </label>
      {err && <p role="alert" className="mt-1.5 text-xs text-rose-300">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onPick(normalizeAssetPath(draft))} disabled={!draft || Boolean(err)}>Use this path</Button>
      </div>
    </Modal>
  );
}
