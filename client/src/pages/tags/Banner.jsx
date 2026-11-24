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

export function InfoBanner({ children }) {
  return (
    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      {children}
    </div>
  );
}
