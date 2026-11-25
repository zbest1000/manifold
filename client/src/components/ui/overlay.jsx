import { useId, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, X } from 'lucide-react';
import clsx from 'clsx';
import { Button, IconButton } from './controls';

/**
 * Modal — the portaled overlay every dialog and drawer is built on. Renders
 * through document.body, owns Esc, backdrop click, focus trap and focus
 * restore. Prefer <Dialog> (titled, with footer) or <Drawer>; use Modal
 * directly only for custom layouts (`className` sets size and padding).
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const modalStack = []; // topmost modal owns Esc and Tab (nested dialogs)

export function Modal({ id, title, onClose, children, className, labelledBy, describedBy, placement = 'center' }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // A layout effect: the Esc handler and the focus move are in place before the overlay is first
  // painted, so an Esc pressed the moment it appears (a person, or a test) is never lost.
  useLayoutEffect(() => {
    const el = ref.current;
    const token = {};
    modalStack.push(token);
    const previouslyFocused = document.activeElement;
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
        'fixed inset-0 z-[100] bg-[rgb(var(--scrim))]',
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
          'overflow-y-auto border-line-strong bg-overlay text-fg shadow-overlay focus:outline-none',
          drawer
            ? clsx('h-full', placement === 'right' ? 'border-l drawer-in-right' : 'border-r drawer-in-left', className || 'w-full max-w-md')
            : clsx('dialog-in max-h-[90vh] w-full rounded-lg border', className || 'max-w-lg p-6')
        )}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

const DIALOG_SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

/**
 * Dialog — the standard form/confirm dialog: header (title, optional one-line
 * description, close), scrolling body, footer with actions right-aligned
 * (secondary first, primary last). Wrap the body + footer in a <form> by
 * passing `onSubmit`; the primary button then uses type="submit".
 */
export function Dialog({ title, description, onClose, footer, size = 'md', onSubmit, children, className, bodyClassName }) {
  const titleId = useId();
  const descId = useId();
  const Body = onSubmit ? 'form' : 'div';
  return (
    <Modal
      title={title}
      labelledBy={titleId}
      describedBy={description ? descId : undefined}
      onClose={onClose}
      className={clsx('relative flex w-full flex-col overflow-hidden p-0', DIALOG_SIZES[size] || size, className)}
    >
      <div className="shrink-0 border-b border-line py-3.5 pl-5 pr-14">
        <h2 id={titleId} className="text-base font-medium text-fg">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-0.5 text-sm text-muted">
            {description}
          </p>
        )}
      </div>
      <Body
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={
          onSubmit
            ? (e) => {
                e.preventDefault();
                onSubmit(e);
              }
            : undefined
        }
      >
        <div className={clsx('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </Body>
      {/* Last in DOM order so focus starts on the first field, first visually. */}
      <div className="absolute right-3 top-3">
        <IconButton icon={X} label="Close" side="left" onClick={onClose} />
      </div>
    </Modal>
  );
}

/** Drawer — a side sheet for details and secondary editing (right by default). */
export function Drawer({ title, onClose, side = 'right', width = 'max-w-md', footer, children, actions }) {
  const titleId = useId();
  return (
    <Modal title={title} labelledBy={titleId} onClose={onClose} placement={side} className={clsx('flex w-full flex-col', width)}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <h2 id={titleId} className="truncate text-sm font-medium text-fg">
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {actions}
          <IconButton icon={X} label="Close" side="left" onClick={onClose} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
    </Modal>
  );
}

/**
 * HelpButton — a "?" control that opens a dialog explaining how a feature
 * works. Put one in a page header; pass the explanation as children (JSX).
 */
export function HelpButton({ title = 'How this works', children, label = 'How this works' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon={HelpCircle} label={label} side="left" size={16} onClick={() => setOpen(true)} />
      {open && (
        <Dialog title={title} onClose={() => setOpen(false)}>
          <div className="space-y-3 text-sm leading-relaxed text-muted [&_b]:font-medium [&_b]:text-fg [&_code]:mono [&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-raised [&_code]:px-1 [&_code]:py-px [&_code]:text-xs [&_code]:text-fg">
            {children}
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * ConfirmDialog — replaces window.confirm. Destructive actions pass `danger`.
 * Focus lands on Cancel so Enter never confirms by accident.
 */
export function ConfirmDialog({ title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, busy = false, onConfirm, onCancel }) {
  const titleId = useId();
  return (
    <Modal title={title} labelledBy={titleId} onClose={onCancel} className="max-w-md p-5">
      <h2 id={titleId} className="text-base font-medium text-fg">
        {title}
      </h2>
      <div className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-muted">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" data-autofocus onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
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
