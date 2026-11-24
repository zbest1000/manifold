import { useId } from 'react';
import clsx from 'clsx';

/**
 * A settings section: the title and a short explanation on the left, the controls on the right.
 * Sections are separated by hairlines, not boxed in cards. `tone="danger"` marks the danger zone.
 */
export default function Section({ title, description, tone, children, className }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={clsx('grid gap-x-10 gap-y-3 border-t py-6 first:border-t-0 first:pt-1 lg:grid-cols-[15rem_minmax(0,1fr)]', tone === 'danger' ? 'border-bad/40' : 'border-line', className)}>
      <div>
        <h2 id={id} className={clsx('text-sm font-medium', tone === 'danger' ? 'text-bad' : 'text-fg')}>
          {title}
        </h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-subtle">{description}</p>}
      </div>
      <div className="min-w-0 max-w-3xl space-y-3">{children}</div>
    </section>
  );
}
