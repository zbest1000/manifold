import { Pencil, Trash2 } from 'lucide-react';
import { Select, Banner, LoadingState, EmptyState, IconButton, Tooltip } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';

/** Spread onto a mutating control: disabled with the reason as its tooltip for a viewer session. */
export function useRo() {
  const readOnly = useReadOnly();
  return readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};
}

/** Edit (shown as View for a viewer) + delete icon buttons for a table row; delete is disabled for viewers. */
export function RowButtons({ what, onEdit, onDelete, children }) {
  const readOnly = useReadOnly();
  return (
    <span className="inline-flex items-center justify-end gap-0.5">
      {children}
      {onEdit && <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} ${what}`} size={14} onClick={onEdit} />}
      {onDelete && (
        <IconButton icon={Trash2} label={`Delete ${what}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={onDelete} {...(readOnly ? { disabled: true, title: READ_ONLY_REASON } : {})} />
      )}
    </span>
  );
}

/** Broker <select>; give `label` for a visible label or `aria-label` when inline. */
export function BrokerSelect({ brokers, value, onChange, label, ...rest }) {
  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {brokers.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
      {brokers.length === 0 && <option value="">no connected brokers</option>}
    </Select>
  );
}

/**
 * Standard loading / error / empty handling for a tab's list. Renders a
 * skeleton on first load, a visible error with Retry when the first load fails
 * (a failed *refresh* keeps the stale data and shows a smaller banner), and the
 * guided empty state when there is nothing yet.
 */
export function ListState({ loading, error, reload, count, label, empty, children }) {
  if (loading && count === 0 && !error) return <LoadingState label={label} rows={2} />;
  return (
    <>
      {error && (
        <Banner variant="error" title={count === 0 ? `Could not load ${label}` : `Could not refresh ${label}`} onRetry={reload}>
          {error.message}
        </Banner>
      )}
      {count === 0 && !error && empty && (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState {...empty} />
        </div>
      )}
      {count > 0 && children}
    </>
  );
}

/** The row above a tab's table: a one-line summary on the left, the tab's single primary action on the right. */
export function TabToolbar({ summary, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm text-muted">{summary}</p>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A column header with a plain-language explanation on hover and focus (dotted underline marks it). */
export function HeadHint({ hint, children }) {
  return (
    <Tooltip label={hint} side="bottom">
      <button type="button" className="cursor-help border-b border-dotted border-line-stronger font-medium">
        {children}
      </button>
    </Tooltip>
  );
}

/** A right-aligned, tabular count; zero reads quietly, `tone` colours a non-zero value. */
export function Count({ value, tone }) {
  const n = Number(value) || 0;
  const cls = n === 0 ? 'text-subtle' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg';
  return <span className={`tabular-nums ${cls}`}>{n.toLocaleString()}</span>;
}
