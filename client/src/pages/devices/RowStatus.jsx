import { StatusDot, Spinner } from '@/components/ui';
import clsx from 'clsx';

const STYLES = {
  created: ['good', 'Created'],
  error: ['bad', 'Failed'],
  invalid: ['bad', 'Problem'],
  running: ['neutral', 'Creating…'],
  ready: ['neutral', 'Ready']
};

/** Result of one row of a bulk create: dot + word (never colour alone) + the server's message. */
export default function RowStatus({ status, message }) {
  const [tone, label] = STYLES[status] || STYLES.ready;
  return (
    <span className="flex items-start gap-1.5 text-sm">
      {status === 'running' ? <Spinner size={12} className="mt-1 text-muted" /> : <StatusDot tone={tone} className="mt-[7px]" />}
      <span className="min-w-0 break-words">
        <span className={clsx('font-medium', tone === 'bad' ? 'text-bad' : 'text-fg')}>{label}</span>
        {message ? <span className="text-muted">: {message}</span> : null}
      </span>
    </span>
  );
}

/** One plain summary line for a finished bulk run. */
export function runSummary(statuses) {
  const created = statuses.filter((s) => s === 'created').length;
  const failed = statuses.filter((s) => s === 'error').length;
  const skipped = statuses.filter((s) => s === 'invalid').length;
  return { created, failed, skipped, text: `${created} created, ${failed} failed${skipped ? `, ${skipped} not sent (invalid row)` : ''}.` };
}
