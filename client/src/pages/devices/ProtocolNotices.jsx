import { FlaskConical, ShieldAlert } from 'lucide-react';

export function ExperimentalBadge({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-inset ring-amber-500/30 ${className}`}>
      <FlaskConical size={11} aria-hidden="true" /> Experimental
    </span>
  );
}

/**
 * What to know before the first connect: the experimental notice and the
 * driver's `prerequisites` text, shown in full (it can carry a security warning).
 * Lines starting with "Warning" are emphasised.
 */
export default function ProtocolNotices({ descriptor }) {
  if (!descriptor) return null;
  const lines = String(descriptor.prerequisites || '').split('\n').filter(Boolean);
  return (
    <div className="space-y-2">
      {descriptor.experimental && (
        <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <ExperimentalBadge className="mt-px shrink-0" />
          <p>Verified only against a simulator. Verify on your own hardware before relying on this driver.</p>
        </div>
      )}
      {lines.length > 0 && (
        <section aria-label={`Before you connect: ${descriptor.label}`} className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-xs text-sky-50">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-sky-100">
            <ShieldAlert size={15} aria-hidden="true" /> Before you connect ({descriptor.label})
          </h4>
          <div className="space-y-1.5 leading-relaxed">
            {lines.map((line, i) => (
              <p key={i} className={/^warning/i.test(line) ? 'rounded-md bg-rose-500/15 px-2 py-1.5 font-medium text-rose-100 ring-1 ring-inset ring-rose-500/30' : ''}>
                {line}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
