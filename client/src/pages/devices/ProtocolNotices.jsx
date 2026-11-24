import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Banner } from '@/components/ui';
import { ExperimentalBadge } from './FormControls';

export { ExperimentalBadge };

/**
 * What to know before the first connect: the driver's `prerequisites` text, shown in full (it can
 * carry a security warning) behind a quiet disclosure, open by default while creating a device.
 * Lines that start with "Warning" become a warning banner. The experimental status is one line.
 */
export default function ProtocolNotices({ descriptor, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  if (!descriptor) return null;
  const lines = String(descriptor.prerequisites || '').split('\n').filter(Boolean);
  return (
    <div className="space-y-2">
      {descriptor.experimental && (
        <p role="note" className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <ExperimentalBadge />
          Verified only against a simulator. Check it on your own hardware before relying on it.
        </p>
      )}
      {lines.length > 0 && (
        <section aria-label={`Before you connect: ${descriptor.label}`}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-fg transition-colors hover:text-accent-text"
          >
            <ChevronRight size={14} aria-hidden="true" className={clsx('text-subtle transition-transform duration-150', open && 'rotate-90')} />
            On the {descriptor.label} side
            <span className="hidden font-normal text-subtle sm:inline">what to enable before the first connect</span>
          </button>
          {open && (
            <div id={bodyId} className="mt-2 space-y-2 border-l-2 border-line pl-4 text-sm leading-relaxed text-muted">
              {lines.map((line, i) =>
                /^warning/i.test(line) ? (
                  <Banner key={i} variant="warn">
                    {line}
                  </Banner>
                ) : (
                  <p key={i}>{line}</p>
                )
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
