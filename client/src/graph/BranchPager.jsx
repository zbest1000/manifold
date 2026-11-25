import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { pagerControls, rangeLabel, stepPage } from './unsPaging';

const FILTER_DEBOUNCE_MS = 150;

/**
 * The controls of one long branch (see unsPaging.js): first / previous / next /
 * last page (first and last only with more than three pages), the range shown
 * and a filter by name for that branch. Shared by the UNS map (laid over the
 * branch's pager slot) and the UNS Tree view (a row of the tree).
 *
 * `slice` = { page, pages, total, all, from, to, filter }; `onChange({ page, filter })`.
 * Keyboard: the buttons are real buttons; in the filter field Enter applies at
 * once, Escape clears it (a second Escape closes it).
 */
export default function BranchPager({ slice, parentName, onChange, className, compact = false, size = 'md', focusFilterSignal = 0, ...rest }) {
  const ctl = pagerControls(slice);
  const [open, setOpen] = useState(Boolean(slice.filter));
  const [draft, setDraft] = useState(slice.filter || '');
  const inputRef = useRef(null);
  const wantFocus = useRef(false);
  const timer = useRef(0);
  const range = rangeLabel(slice);
  const go = (action) => onChange({ page: stepPage(slice, action), filter: slice.filter || '' });

  // Re-sync the draft when the filter changes from outside (a deep link clears it).
  const [seen, setSeen] = useState(slice.filter || '');
  if ((slice.filter || '') !== seen) {
    setSeen(slice.filter || '');
    setDraft(slice.filter || '');
    if (slice.filter) setOpen(true);
  }
  // A request from the canvas keyboard ("/") to focus this branch's filter.
  const [signalSeen, setSignalSeen] = useState(focusFilterSignal);
  if (signalSeen !== focusFilterSignal) {
    setSignalSeen(focusFilterSignal);
    if (focusFilterSignal) setOpen(true);
  }
  useEffect(() => {
    if (focusFilterSignal) inputRef.current?.focus();
  }, [focusFilterSignal]);
  useEffect(() => {
    if (open && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const apply = (value, now = false) => {
    clearTimeout(timer.current);
    const run = () => onChange({ page: 0, filter: value });
    if (now) run();
    else timer.current = setTimeout(run, FILTER_DEBOUNCE_MS);
  };
  // md: 28 px targets (40 px on touch screens); sm: 24 px, for a 26 px tree row.
  const sm = size === 'sm';
  const btn = clsx(
    'inline-grid shrink-0 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40',
    sm ? 'h-6 w-6' : 'h-7 w-7 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10'
  );
  const button = (action, Icon, label) =>
    ctl[action].shown && (
      <button type="button" className={btn} aria-label={label} title={label} disabled={!ctl[action].enabled} onClick={() => go(action)} data-pager-action={action}>
        <Icon size={15} aria-hidden="true" />
      </button>
    );

  return (
    <div
      role="group"
      aria-label={`Children of ${parentName}: ${range}, page ${slice.page + 1} of ${slice.pages}`}
      className={clsx('flex items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 text-xs text-fg shadow-overlay', className)}
      {...rest}
    >
      {button('first', ChevronFirst, 'First page')}
      {button('prev', ChevronLeft, 'Previous page')}
      {open ? (
        <input
          ref={inputRef}
          type="search"
          value={draft}
          aria-label={`Filter children of ${parentName} by name`}
          placeholder="Filter by name"
          className={clsx(
            'w-32 min-w-0 rounded border border-line-strong bg-field px-2 text-xs text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
            sm ? 'h-6' : 'h-7 [@media(pointer:coarse)]:h-10'
          )}
          onChange={(e) => {
            setDraft(e.target.value);
            apply(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing here never drives the canvas
            if (e.key === 'Enter') apply(draft, true);
            else if (e.key === 'Escape') {
              if (draft) {
                setDraft('');
                apply('', true);
              } else setOpen(false);
            }
          }}
        />
      ) : null}
      <span className={clsx('min-w-0 truncate px-1.5 tabular-nums', compact ? 'max-w-[9rem]' : 'max-w-[14rem]', slice.filter && !slice.total && 'text-warn')} aria-live="polite" data-pager-range>
        {range}
      </span>
      {button('next', ChevronRight, 'Next page')}
      {button('last', ChevronLast, 'Last page')}
      {open ? (
        <button
          type="button"
          className={btn}
          aria-label="Clear filter and close it"
          title="Clear filter"
          onClick={() => {
            setDraft('');
            setOpen(false);
            if (slice.filter) apply('', true);
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className={btn} aria-label={`Filter children of ${parentName} by name`} title="Filter by name" aria-expanded={false}
          onClick={() => {
            wantFocus.current = true;
            setOpen(true);
          }}
          data-pager-action="filter"
        >
          <Search size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
