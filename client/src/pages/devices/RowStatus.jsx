import { CheckCircle2, XCircle, Loader2, CircleDashed } from 'lucide-react';

const STYLES = {
  created: ['text-emerald-300', CheckCircle2, 'Created'],
  error: ['text-rose-300', XCircle, 'Failed'],
  invalid: ['text-rose-300', XCircle, 'Not sent'],
  running: ['text-sky-300', Loader2, 'Creating…'],
  ready: ['text-slate-400', CircleDashed, 'Ready']
};

/** Result of one row of a bulk create: icon + word (never colour alone) + the server's message. */
export default function RowStatus({ status, message }) {
  const [cls, Icon, label] = STYLES[status] || STYLES.ready;
  return (
    <span className={`flex items-start gap-1.5 text-xs ${cls}`}>
      <Icon size={13} className={`mt-0.5 shrink-0 ${status === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 break-words"><span className="font-medium">{label}</span>{message ? `: ${message}` : ''}</span>
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
