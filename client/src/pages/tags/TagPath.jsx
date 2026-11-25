import clsx from 'clsx';
import { Tooltip } from '@/components/ui';

/**
 * One tag in a list: its name, plus the parent levels that tell it apart from same-named tags
 * (shortened from the start). The full address shows on hover and keyboard focus.
 *   info: an entry of shortLabels() for the tag's address.
 */
export default function TagPath({ name, info, className }) {
  const parent = info?.parent;
  return (
    <Tooltip label={info?.full} side="bottom" className={clsx('min-w-0', className)}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so keyboard users get the full address in the tooltip */}
      <span tabIndex={0} className="flex min-w-0 items-baseline gap-1.5 rounded font-mono text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--focus))]">
        <span className="shrink-0 text-fg">{name}</span>
        {parent && (
          <span className="min-w-0 truncate text-subtle" dir="ltr">
            {info.shortened ? '…/' : ''}
            {parent}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
