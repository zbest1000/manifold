import { Pencil, Trash2 } from 'lucide-react';
import { Select, Banner, LoadingState, Card, EmptyState, IconButton } from '@/components/ui';
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
    <span className="inline-flex items-center justify-end gap-1">
      {children}
      {onEdit && <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} ${what}`} size={14} onClick={onEdit} />}
      {onDelete && (
        <IconButton icon={Trash2} label={`Delete ${what}`} size={14} className="hover:bg-rose-500/10 hover:text-rose-300" onClick={onDelete} {...(readOnly ? { disabled: true, title: READ_ONLY_REASON } : {})} />
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
        <Card>
          <EmptyState {...empty} />
        </Card>
      )}
      {count > 0 && children}
    </>
  );
}
