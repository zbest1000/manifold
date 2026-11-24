import { Select, Banner, LoadingState, Card, EmptyState } from '@/components/ui';

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
