import { useId, useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, X, AlertTriangle, Info, CheckCircle2, XCircle, RefreshCw, ChevronUp, ChevronDown, ChevronsUpDown, Pencil, Trash2 } from 'lucide-react';
import clsx from 'clsx';

/** Small reusable presentational primitives shared across pages. */

/**
 * Modal — a portaled dialog. ALWAYS renders through document.body so it escapes
 * any `backdrop-blur` ancestor Card (a backdrop-filter becomes the containing
 * block for position:fixed, which otherwise traps the modal inside that card
 * and paints it under its neighbours). Owns Esc + backdrop-click close. Use this
 * for every overlay instead of a bare `fixed inset-0` div.
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const modalStack = []; // topmost modal owns Esc and Tab (nested dialogs)

export function Modal({ id, title, onClose, children, className, labelledBy, placement = 'center' }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const el = ref.current;
    const token = {};
    modalStack.push(token);
    const previouslyFocused = document.activeElement;
    // Focus the first control inside the dialog (falls back to the dialog itself).
    const first = el && (el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE));
    (first || el)?.focus();

    const onKey = (e) => {
      if (modalStack[modalStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === el)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      } else if (!el.contains(document.activeElement)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus?.();
    };
  }, []);

  const drawer = placement === 'left' || placement === 'right';
  return createPortal(
    <div
      className={clsx(
        'fixed inset-0 z-[100] bg-slate-950/80',
        drawer ? clsx('flex', placement === 'right' ? 'justify-end' : 'justify-start') : 'grid place-items-center p-3 sm:p-6'
      )}
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && closeRef.current()}
    >
      <div
        id={id}
        ref={ref}
        tabIndex={-1}
        className={clsx(
          'overflow-y-auto border-white/10 bg-surface-900 shadow-2xl focus:outline-none',
          drawer
            ? clsx('h-full', placement === 'right' ? 'border-l drawer-in-right' : 'border-r drawer-in-left', className || 'w-full max-w-md')
            : clsx('max-h-[90vh] w-full rounded-2xl border', className || 'max-w-lg p-6')
        )}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

/**
 * HelpButton — a "?" control that opens a modal explaining how a feature works.
 * Put one in a page header; pass the explanation as children (JSX).
 */
export function HelpButton({ title = 'How this works', children, label = 'How this works' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon={HelpCircle} label={label} side="left" size={16} onClick={() => setOpen(true)} />
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <HelpCircle size={18} className="text-accent-400" /> {title}
            </h3>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200">
              <X size={16} />
            </button>
          </div>
          <div className="space-y-3 text-sm leading-relaxed text-slate-300 [&_b]:font-semibold [&_b]:text-slate-100 [&_code]:mono [&_code]:rounded [&_code]:bg-white/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
            {children}
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Tooltip — a styled, keyboard-and-touch-aware replacement for the native
 * `title=` attribute (which has a ~1.5s delay, is unstyled, and never shows on
 * touch or focus). Wrap any control; the label appears on hover and focus.
 * `side` positions it; default 'top'. Purely CSS-positioned, no portal.
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
          'pointer-events-none absolute z-[100] whitespace-nowrap rounded-md border border-white/10 bg-surface-800 px-2 py-1 text-2xs font-medium text-slate-100 shadow-xl transition-opacity duration-100',
          pos[side],
          open ? 'opacity-100' : 'opacity-0'
        )}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * IconButton — a square icon control that is ALWAYS labelled: the `label` drives
 * both the tooltip and aria-label, so no icon-only affordance is ever a mystery
 * (and it stays labelled when the nav collapses to icons).
 */
export function IconButton({ icon: Icon, label, side = 'top', size = 16, active = false, className, ...rest }) {
  return (
    <Tooltip label={label} side={side}>
      <button
        type="button"
        aria-label={label}
        className={clsx(
          'inline-grid h-8 w-8 place-items-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:opacity-40 disabled:cursor-not-allowed',
          active ? 'bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-500/25' : 'text-muted hover:bg-white/5 hover:text-slate-200',
          className
        )}
        {...rest}
      >
        <Icon size={size} />
      </button>
    </Tooltip>
  );
}

export function Card({ className, children, ...rest }) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-white/5 bg-surface-900/60 backdrop-blur shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_8px_30px_-12px_rgba(0,0,0,0.6)]',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Button({ variant = 'primary', size = 'md', className, children, ...rest }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]';
  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs',
    md: 'px-3.5 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm'
  };
  const variants = {
    primary: 'bg-sky-700 text-white hover:bg-sky-600 shadow-lg shadow-sky-700/20',
    ghost: 'text-slate-300 hover:bg-white/5 hover:text-white',
    outline: 'border border-white/10 text-slate-200 hover:bg-white/5 hover:border-white/20',
    danger: 'bg-rose-500/90 text-white hover:bg-rose-500',
    subtle: 'bg-white/5 text-slate-200 hover:bg-white/10'
  };
  return (
    <button className={clsx(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

const STATUS_STYLES = {
  connected: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  connecting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  reconnecting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  offline: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  disconnected: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  error: 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
};

export function StatusDot({ status }) {
  const color =
    status === 'connected'
      ? 'bg-emerald-400'
      : status === 'error'
        ? 'bg-rose-400'
        : status === 'connecting' || status === 'reconnecting'
          ? 'bg-amber-400'
          : 'bg-slate-500';
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status === 'connected' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
      )}
      <span className={clsx('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
    </span>
  );
}

export function Badge({ status, children, className }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status] || 'bg-white/5 text-slate-300 ring-white/10',
        className
      )}
    >
      {children || status}
    </span>
  );
}

const CONTROL_BASE =
  'rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-faint ' +
  'focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:opacity-50 disabled:cursor-not-allowed ' +
  'aria-[invalid=true]:border-rose-500/60';

// An explicit w-*/min-w-*/max-w-* in className replaces the default full width
// (Tailwind would otherwise resolve the conflict by stylesheet order, not by us).
const hasWidth = (cls) => /(^|\s)(w|min-w|max-w)-/.test(cls || '');

/** Text input. Always give it a visible <Field label> or an `aria-label`. */
export function Input({ className, ...rest }) {
  return <input className={clsx(CONTROL_BASE, hasWidth(className) ? '' : 'w-full', className)} {...rest} />;
}

/** Multi-line text input with the same look as Input. */
export function Textarea({ className, ...rest }) {
  return <textarea className={clsx(CONTROL_BASE, hasWidth(className) ? '' : 'w-full', className)} {...rest} />;
}

/**
 * Field — a labelled form control. Wraps its child in a <label>, so the text is
 * the control's accessible name. `help` renders helper text under the control,
 * `error` renders an alert. `hideLabel` keeps the name for screen readers only.
 */
export function Field({ label, help, error, hideLabel = false, children, className }) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      <span className={clsx(hideLabel ? 'sr-only' : 'block text-xs font-medium uppercase tracking-wide text-muted')}>{label}</span>
      {children}
      {help && <span className="helper block">{help}</span>}
      {error && (
        <span role="alert" className="block text-xs text-rose-300">
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * Select — a styled native <select>. Pass `label` to render it inside a Field
 * (preferred); without one you MUST pass `aria-label`. Children are <option>s,
 * or pass `options` as [{ value, label }] / strings.
 */
export function Select({ label, help, error, hideLabel, fieldClassName, wrapperClassName, className, options, children, ...rest }) {
  const control = (
    <span className={clsx('relative block', wrapperClassName)}>
      <select className={clsx(CONTROL_BASE, 'w-full appearance-none pr-9', className)} {...rest}>
        {options
          ? options.map((o) => {
              const opt = typeof o === 'object' ? o : { value: o, label: o };
              return (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              );
            })
          : children}
      </select>
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
  if (!label) return control;
  return (
    <Field label={label} help={help} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {control}
    </Field>
  );
}

/** Toggle — an on/off switch (native checkbox with role="switch"). */
export function Toggle({ checked, onChange, label, description, disabled = false, className }) {
  return (
    <label className={clsx('flex items-start gap-3', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-white/15 transition-colors peer-checked:bg-accent-500 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-400 peer-checked:[&>span]:translate-x-4"
      >
        <span className="ml-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-slate-200">{label}</span>
        {description && <span className="helper block">{description}</span>}
      </span>
    </label>
  );
}

/** Checkbox with an inline label. */
export function Checkbox({ checked, onChange, label, description, disabled = false, className }) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm text-slate-300', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-surface-950 accent-accent-500"
      />
      <span className="min-w-0">
        {label}
        {description && <span className="helper block">{description}</span>}
      </span>
    </label>
  );
}

export function EmptyState({ icon: Icon, title, hint, action, className }) {
  return (
    <div className={clsx('flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 px-6 py-8 text-center', className)}>
      {Icon && (
        <div className="rounded-2xl bg-white/5 p-4 text-muted ring-1 ring-inset ring-white/10">
          <Icon size={26} aria-hidden="true" />
        </div>
      )}
      <div>
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        {hint && <p className="helper mx-auto mt-1 max-w-sm text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

const BANNER_STYLES = {
  info: { box: 'border-sky-500/30 bg-sky-500/10 text-sky-100', icon: Info, iconClass: 'text-sky-300' },
  success: { box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100', icon: CheckCircle2, iconClass: 'text-emerald-300' },
  warn: { box: 'border-amber-500/30 bg-amber-500/10 text-amber-100', icon: AlertTriangle, iconClass: 'text-amber-300' },
  error: { box: 'border-rose-500/40 bg-rose-500/10 text-rose-100', icon: XCircle, iconClass: 'text-rose-300' }
};

/**
 * Banner — an inline message. Errors use role="alert" (announced immediately);
 * the rest use role="status". `onRetry` adds a Retry button, `onDismiss` a close.
 */
export function Banner({ variant = 'info', title, children, onRetry, retryLabel = 'Retry', onDismiss, action, className }) {
  const v = BANNER_STYLES[variant] || BANNER_STYLES.info;
  const Icon = v.icon;
  return (
    <div role={variant === 'error' ? 'alert' : 'status'} className={clsx('flex flex-wrap items-start gap-3 rounded-xl border px-3.5 py-2.5 text-sm', v.box, className)}>
      <Icon size={16} aria-hidden="true" className={clsx('mt-0.5 shrink-0', v.iconClass)} />
      <div className="min-w-0 flex-1 basis-48">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx('text-xs leading-relaxed opacity-90', title && 'mt-0.5')}>{children}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {action}
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw size={12} aria-hidden="true" /> {retryLabel}
          </Button>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="rounded-lg p-1 opacity-70 transition hover:bg-white/10 hover:opacity-100">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Skeleton — a pulsing placeholder block. Decorative; wrap in LoadingState for semantics. */
export function Skeleton({ className }) {
  return <div aria-hidden="true" className={clsx('animate-pulse rounded-lg bg-white/[0.07]', className || 'h-4 w-full')} />;
}

/** LoadingState — a skeleton list placeholder announced as "Loading <label>". */
export function LoadingState({ label = 'content', rows = 4, className }) {
  return (
    <div role="status" aria-busy="true" className={clsx('space-y-3', className)}>
      <span className="sr-only">Loading {label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-2xl border border-white/5 bg-surface-900/40 p-4">
          <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
        </div>
      ))}
    </div>
  );
}

/** Full-page fallback for lazy routes. */
export function PageSkeleton() {
  return (
    <div className="flex h-full flex-col" role="status" aria-busy="true">
      <span className="sr-only">Loading page…</span>
      <div className="space-y-2 border-b border-white/5 px-4 py-4 sm:px-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3.5 w-72 max-w-full" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden p-4 sm:p-6">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * ConfirmDialog — replaces window.confirm. Destructive actions pass `danger`.
 * Focus lands on the cancel button so Enter never confirms by accident.
 */
export function ConfirmDialog({ title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, busy = false, onConfirm, onCancel }) {
  const titleId = useId();
  return (
    <Modal title={title} labelledBy={titleId} onClose={onCancel} className="max-w-md p-6">
      <h3 id={titleId} className="flex items-center gap-2 text-base font-semibold text-slate-100">
        {danger && <AlertTriangle size={18} aria-hidden="true" className="text-rose-300" />} {title}
      </h3>
      <div className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" data-autofocus onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * useConfirm — promise-based confirmation. Usage:
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (await confirm({ title, message, confirmLabel, danger: true })) …
 *   return <>…{confirmDialog}</>;
 */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setState({ ...opts, resolve });
      }),
    []
  );
  const settle = (value) => {
    state?.resolve(value);
    setState(null);
  };
  const dialog = state ? (
    <ConfirmDialog
      title={state.title}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {state.message}
    </ConfirmDialog>
  ) : null;
  return [confirm, dialog];
}

/* ------------------------------------------------------------------ */
/* Table helpers: real <table> semantics with optional sortable heads. */
/* ------------------------------------------------------------------ */

/** Table — a scroll-contained, captioned table. `caption` is read by screen readers. */
export function Table({ caption, children, className, wrapperClassName }) {
  return (
    // A scrolling region must be reachable by keyboard (focusable) and named.
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={clsx('relative overflow-x-auto rounded-2xl border border-white/5 bg-surface-900/60', wrapperClassName)}
    >
      <table className={clsx('w-full min-w-[32rem] border-collapse text-left text-sm', className)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }) {
  return (
    <thead className="border-b border-white/5 bg-white/[0.02]">
      <tr>{children}</tr>
    </thead>
  );
}

const SortContext = createContext(null);

/** TableSort — provides {sort, onSort} to descendant <Th sortKey> cells. */
export function TableSort({ sort, onSort, children }) {
  return <SortContext.Provider value={{ sort, onSort }}>{children}</SortContext.Provider>;
}

/**
 * Th — column header with scope="col". Give `sortKey` (inside <TableSort>) to
 * make it a sortable button with aria-sort. `srOnly` hides the text visually
 * (for action columns) while keeping it announced.
 */
export function Th({ children, sortKey, align = 'left', srOnly = false, className }) {
  const ctx = useContext(SortContext);
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const base = clsx('px-4 py-2.5 align-middle label-xs', alignClass, className);
  if (sortKey && ctx?.onSort) {
    const active = ctx.sort?.key === sortKey;
    const dir = active ? ctx.sort.dir : null;
    const Icon = dir === 'asc' ? ChevronUp : dir === 'desc' ? ChevronDown : ChevronsUpDown;
    return (
      <th scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className={base}>
        <button
          type="button"
          onClick={() => ctx.onSort(sortKey)}
          className={clsx('inline-flex items-center gap-1 rounded uppercase tracking-[0.06em] transition hover:text-slate-100', align === 'right' && 'flex-row-reverse', active && 'text-slate-100')}
        >
          {children}
          <Icon size={12} aria-hidden="true" className={active ? 'text-accent-400' : 'opacity-60'} />
        </button>
      </th>
    );
  }
  return (
    <th scope="col" className={base}>
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

export function Tr({ children, className, highlight = false, ...rest }) {
  return (
    <tr className={clsx('border-t border-white/5 transition-colors first:border-t-0 hover:bg-white/[0.025]', highlight && 'bg-accent-500/[0.06]', className)} {...rest}>
      {children}
    </tr>
  );
}

export function Td({ children, className, align = 'left', header = false, ...rest }) {
  const Cell = header ? 'th' : 'td';
  return (
    <Cell
      {...(header ? { scope: 'row' } : {})}
      className={clsx('px-4 py-3 align-middle', align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left', header && 'font-medium', className)}
      {...rest}
    >
      {children}
    </Cell>
  );
}

/** PageBody — the scrolling content area under a PageHeader (responsive gutter). */
export function PageBody({ children, className }) {
  return <div className={clsx('min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6', className)}>{children}</div>;
}

/** Shared class string for native <select>s that cannot use <Select>. */
export const selectClass = `w-full ${CONTROL_BASE}`;

/** Edit + delete icon buttons for the last cell of a table row. `what` names the row for assistive tech. */
export function RowActions({ what, onEdit, onDelete, children }) {
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {children}
      {onEdit && <IconButton icon={Pencil} label={`Edit ${what}`} size={14} onClick={onEdit} />}
      {onDelete && <IconButton icon={Trash2} label={`Delete ${what}`} size={14} className="hover:bg-rose-500/10 hover:text-rose-300" onClick={onDelete} />}
    </span>
  );
}
