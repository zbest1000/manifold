import { X } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from '@/components/ui';

/**
 * Chrome for the canvas pages (Topics, UNS, Flows), built on the design
 * system's tokens and rules (docs/design/ui-design-system.md, "Canvas page with
 * floating toolbars"). These are the pieces the shared primitives do not cover:
 *
 *   SidePanel     a docked, NON-modal detail panel beside a canvas (the system's
 *                 Drawer is modal: it would trap focus and block the canvas).
 *                 Right column from md up, a bottom sheet on phones.
 *   FloatingBar   a solid floating control group over a canvas (bg-panel,
 *                 hairline, 6px radius, overlay shadow).
 *   ToolToggle    a labelled on/off tool button (aria-pressed) for a FloatingBar
 *                 or a toolbar row.
 *   PressedGroup  SegmentedControl look for 2-3 views whose buttons must stay
 *                 buttons (aria-pressed), e.g. where tests and users address
 *                 them by button role.
 *   CanvasNote    a short inline note centred over a canvas (empty / not found).
 */

export function SidePanel({ title, subtitle, onClose, closeLabel, actions, children, footer, className, label, width = 'md:w-80', ...rest }) {
  return (
    <aside
      aria-label={label || title}
      className={clsx(
        'flex max-h-[50%] w-full shrink-0 flex-col border-t border-line bg-panel md:max-h-none md:border-l md:border-t-0',
        width,
        className
      )}
      {...rest}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-line py-2 pl-4 pr-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{title}</h2>
          {subtitle && <div className="truncate text-xs text-subtle">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {onClose && <IconButton icon={X} label={closeLabel || `Close ${String(title).toLowerCase()}`} side="left" onClick={onClose} />}
        </div>
      </div>
      {/* Focusable so keyboard users can scroll a long panel (WCAG 2.1.1). */}
      <div role="region" aria-label={`${label || title} content`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-offset-[-2px]">
        {children}
      </div>
      {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
    </aside>
  );
}

/** A section inside a SidePanel: 13px heading, hairline above (not a nested card). */
export function PanelSection({ title, aside, children, className }) {
  return (
    <section className={clsx('border-t border-line px-4 py-3 first:border-t-0', className)}>
      {(title || aside) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && <h3 className="text-sm font-medium text-fg">{title}</h3>}
          {aside && <div className="flex shrink-0 items-center gap-1 text-xs text-subtle">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function FloatingBar({ children, className, label, role = 'toolbar', ...rest }) {
  return (
    <div role={role} aria-label={label} className={clsx('pointer-events-auto flex items-center gap-1 rounded-md border border-line bg-panel p-0.5 shadow-overlay', className)} {...rest}>
      {children}
    </div>
  );
}

export function BarDivider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-line" />;
}

export function ToolToggle({ pressed, onClick, icon: Icon, label, showLabel = 'lg', disabled, title, className }) {
  const labelCls = showLabel === true ? '' : showLabel === false ? 'sr-only' : { sm: 'sr-only sm:not-sr-only', md: 'sr-only md:not-sr-only', lg: 'sr-only lg:not-sr-only' }[showLabel];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className={clsx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        pressed ? 'bg-raised text-fg shadow-[inset_0_0_0_1px_rgb(var(--border-strong))]' : 'text-muted hover:bg-raised hover:text-fg',
        className
      )}
    >
      {Icon && <Icon size={15} aria-hidden="true" className={pressed ? 'text-accent-text' : undefined} />}
      <span className={labelCls}>{label}</span>
    </button>
  );
}

export function PressedGroup({ options, value, onChange, label, className }) {
  return (
    <div role="group" aria-label={label} className={clsx('inline-flex rounded-md border border-line bg-app p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-sm font-medium transition-colors duration-150',
              on ? 'bg-raised text-fg shadow-[inset_0_0_0_1px_rgb(var(--border-strong))]' : 'text-muted hover:text-fg'
            )}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function CanvasNote({ children, className, role = 'status' }) {
  return (
    <div role={role} className={clsx('pointer-events-auto mx-auto w-fit max-w-[min(28rem,calc(100%-2rem))] rounded-md border border-line bg-panel px-3 py-2 text-sm text-muted shadow-overlay', className)}>
      {children}
    </div>
  );
}
