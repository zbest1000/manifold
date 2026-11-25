import { Button } from '@/components/ui';
import { formatDuration } from '@/lib/discoveryDevices';

/** Live progress of a running scan: probes done, found so far, time left, and Cancel. */
export default function ScanProgress({ progress, range, onCancel, cancelling, readOnlyProps = {} }) {
  const total = progress?.total ?? progress?.totalProbes ?? 0;
  const done = Math.min(progress?.completed ?? 0, total || Infinity);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const eta = progress?.etaMs;
  return (
    <section aria-label="Scan progress" className="rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div aria-live="polite" className="min-w-0 text-sm text-fg">
          <span className="font-medium">Scanning {range || 'the network'}</span>
          <span className="text-muted">
            {' '}
            · <span className="tabular-nums">{done.toLocaleString()}</span> of <span className="tabular-nums">{total.toLocaleString()}</span> probes · <span className="tabular-nums">{progress?.found ?? 0}</span> found
            {typeof eta === 'number' && done < total ? ` · about ${formatDuration(eta)} left` : ''}
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={onCancel} loading={cancelling} {...readOnlyProps}>
          Cancel scan
        </Button>
      </div>
      <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% done`} className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}
