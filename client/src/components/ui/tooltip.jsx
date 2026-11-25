import { useId, useState } from 'react';
import clsx from 'clsx';

/**
 * Tooltip — a styled, keyboard-and-touch-aware replacement for the native
 * `title=` attribute. Wrap any control; the label appears on hover and focus.
 * `side` positions it (default 'top'). Purely CSS-positioned, no portal.
 */
export function Tooltip({ label, side = 'top', block = false, className, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!label) return children;
  const pos = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5'
  };
  return (
    <span
      className={clsx('relative', block ? 'flex w-full' : 'inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      <span
        role="tooltip"
        id={id}
        className={clsx(
          'pointer-events-none absolute z-[100] whitespace-nowrap rounded border border-line-strong bg-overlay px-2 py-1 text-xs font-normal text-fg shadow-overlay transition-opacity duration-100',
          pos[side],
          open ? 'visible opacity-100' : 'invisible opacity-0'
        )}
      >
        {label}
      </span>
    </span>
  );
}
