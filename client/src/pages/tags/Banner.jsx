import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

/** Visible, announced error with an optional Retry. Replaces silent .catch(() => {}). */
export default function ErrorBanner({ title, message, onRetry, busy = false }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-200">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {message && <p className="mt-0.5 break-words text-rose-200/90">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </Button>
      )}
    </div>
  );
}

const WARNING_LABEL = { 'raw-address': 'Looks like a raw address', collision: 'Topic collision', 'asset-path': 'Asset path' };

/** Non-blocking server warnings returned by a save. Dismissible; never prevents anything. */
export function WarningsBanner({ title = 'Saved with warnings', warnings, onDismiss }) {
  if (!warnings?.length) return null;
  return (
    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-100">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">{title} ({warnings.length})</p>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="rounded-md px-1.5 py-0.5 text-amber-200 hover:bg-white/10">
            Dismiss
          </button>
        )}
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {warnings.slice(0, 8).map((w, i) => (
          <li key={`${w.type}-${w.topic || i}-${i}`} className="break-words">
            <span className="font-medium">{WARNING_LABEL[w.type] || w.type}:</span> {w.message}
          </li>
        ))}
      </ul>
      {warnings.length > 8 && <p className="mt-1 text-amber-200/80">and {warnings.length - 8} more.</p>}
    </div>
  );
}

export function InfoBanner({ children }) {
  return (
    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      {children}
    </div>
  );
}
