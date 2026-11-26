import { useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import clsx from 'clsx';
import { matchSummary, searchNodes, stepActive } from '@/lib/nodeSearch';
import { IconButton } from '@/components/ui';

/**
 * Search box with a pickable results list (ARIA combobox + listbox).
 *   type        results appear under the box (at most `limit`, ranked: see lib/nodeSearch.js)
 *   Down / Up   move through the results (the list opens if closed)
 *   Enter       pick the highlighted result (the first when none is highlighted)
 *   Escape      close the list; a second Escape clears the box
 * The number of matches and the picked node are announced in a polite live region.
 *
 * `items`: [{ id, label, path, hint? }]. `onPick(item)` selects and reveals it.
 * `onQuery(query, ids)` (optional) reports the text and every matching id, for
 * highlighting; `onEnterNoPick(ids)` (optional) runs on Enter when the list is closed.
 */
export default function SearchPick({ items, onPick, onQuery, onEnterNoPick, label = 'Search nodes', placeholder = 'Search', limit = 50, className, inputClassName, testId }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announce, setAnnounce] = useState('');
  const listId = useId();
  const inputRef = useRef(null);

  const { results, total } = useMemo(() => searchNodes(items, query, { limit }), [items, query, limit]);
  const showList = open && query.trim() !== '' && results.length > 0;
  const optionId = (i) => `${listId}-opt-${i}`;

  const change = (q) => {
    setQuery(q);
    setOpen(true);
    setActive(-1);
    const r = searchNodes(items, q, { limit: Infinity });
    setAnnounce(q.trim() ? matchSummary(Math.min(r.total, limit), r.total) : '');
    onQuery?.(q, q.trim() ? new Set(r.results.map((x) => x.id)) : null);
  };

  const pick = (item) => {
    if (!item) return;
    setOpen(false);
    setActive(-1);
    setAnnounce(`Selected ${item.path || item.label}`);
    onPick(item);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((a) => stepActive(showList ? a : -1, results.length, e.key));
    } else if (e.key === 'Enter') {
      if (!query.trim()) return;
      e.preventDefault();
      if (showList) pick(results[active >= 0 ? active : 0]);
      else if (onEnterNoPick) onEnterNoPick(new Set(searchNodes(items, query, { limit: Infinity }).results.map((x) => x.id)));
      else if (results.length) pick(results[0]);
    } else if (e.key === 'Escape') {
      if (showList) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
      } else if (query) {
        e.preventDefault();
        e.stopPropagation();
        change('');
      }
    }
  };

  return (
    <div className={clsx('relative min-w-0', className)} data-testid={testId}>
      <div className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-line-strong bg-field pl-2 pr-0.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        <Search size={14} className="shrink-0 text-subtle" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          className={clsx('w-36 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-faint focus:outline-hidden sm:w-48', inputClassName)}
        />
        {query && (
          <>
            <span aria-hidden="true" className={clsx('px-1 text-xs tabular-nums', total ? 'text-accent-text' : 'text-subtle')}>
              {total.toLocaleString()}
            </span>
            <IconButton
              icon={X}
              size={14}
              label="Clear search"
              className="h-7 w-7"
              onClick={() => {
                change('');
                inputRef.current?.focus();
              }}
            />
          </>
        )}
      </div>
      <div hidden={!showList} className="absolute left-0 right-0 top-full z-30 mt-1 min-w-[16rem] overflow-hidden rounded-md border border-line-strong bg-overlay shadow-overlay">
        <ul id={listId} role="listbox" aria-label={`${label}: results`} className="max-h-72 overflow-y-auto py-1">
          {showList &&
            results.map((r, i) => (
              <li
                key={r.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
                className={clsx('cursor-pointer px-3 py-1.5 text-xs text-fg', i === active && 'bg-raised')}
                ref={(el) => {
                  if (el && i === active) el.scrollIntoView({ block: 'nearest' });
                }}
              >
                <span className="block truncate font-medium">{r.label}</span>
                {r.path && r.path !== r.label && (
                  <span className="block truncate font-mono text-subtle">
                    {r.hint ? `${r.hint} · ` : ''}
                    {r.path}
                  </span>
                )}
              </li>
            ))}
        </ul>
        {showList && total > results.length && <p className="border-t border-line px-3 py-1 text-xs text-subtle">{(total - results.length).toLocaleString()} more: type more of the name</p>}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
