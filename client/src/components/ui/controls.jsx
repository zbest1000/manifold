import { useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { Tooltip } from './tooltip';

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/** Spinner — a 12-16px activity indicator for buttons and inline loading. */
export function Spinner({ size = 14, className, label }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={clsx('shrink-0 animate-spin', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--focus))] ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress';

const BUTTON_SIZES = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-9 px-4 text-sm'
};

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border border-line-strong bg-panel text-fg hover:border-line-stronger hover:bg-raised',
  outline: 'border border-line-strong bg-panel text-fg hover:border-line-stronger hover:bg-raised',
  ghost: 'text-muted hover:bg-raised hover:text-fg',
  subtle: 'bg-raised text-fg hover:bg-[rgb(var(--tint)/0.08)]',
  danger: 'bg-danger text-danger-fg hover:bg-danger-hover',
  'danger-ghost': 'text-bad hover:bg-bad/10'
};

/**
 * Button. Variants: primary (solid accent, one per view), secondary / outline
 * (bordered, the default for everything else), ghost (toolbars, dismiss),
 * subtle, danger (destructive confirm), danger-ghost. Sizes sm (28px) / md
 * (32px) / lg (36px). `loading` shows a spinner, disables it and sets aria-busy.
 */
export function Button({ variant = 'primary', size = 'md', loading = false, className, children, disabled, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={clsx(BUTTON_BASE, BUTTON_SIZES[size] || BUTTON_SIZES.md, BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size={size === 'sm' ? 12 : 14} />}
      {children}
    </button>
  );
}

/** Class string of a Button, for elements that must look like one (links, file inputs). */
export const buttonClass = (variant = 'primary', size = 'md') => clsx(BUTTON_BASE, BUTTON_SIZES[size] || BUTTON_SIZES.md, BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary);

/** ButtonLink — a router link that looks like a Button (navigation, not an action). */
export function ButtonLink({ to, variant = 'secondary', size = 'md', className, children, ...rest }) {
  return (
    <Link to={to} className={clsx(buttonClass(variant, size), className)} {...rest}>
      {children}
    </Link>
  );
}

/**
 * IconButton — a square icon control that is ALWAYS labelled: `label` drives
 * both the tooltip and aria-label. `active` marks a pressed/selected tool.
 */
export function IconButton({ icon: Icon, label, side = 'top', size = 16, active = false, className, ...rest }) {
  return (
    <Tooltip label={label} side={side}>
      <button
        type="button"
        aria-label={label}
        className={clsx(
          'inline-grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
          active ? 'bg-accent/15 text-accent-text' : 'text-muted hover:bg-raised hover:text-fg',
          className
        )}
        {...rest}
      >
        <Icon size={size} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

const CONTROL_BASE =
  'rounded-md border border-line-strong bg-field px-2.5 py-[5px] text-sm text-fg placeholder:text-faint transition-colors duration-150 ' +
  'hover:border-line-stronger focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-bad';

// An explicit w-*/min-w-*/max-w-* in className replaces the default full width.
const hasWidth = (cls) => /(^|\s)(w|min-w|max-w)-/.test(cls || '');

/** Text input. Always give it a visible <Field label> or an `aria-label`. */
export function Input({ className, ...rest }) {
  return <input className={clsx(CONTROL_BASE, hasWidth(className) ? '' : 'w-full', className)} {...rest} />;
}

/** Multi-line text input with the same look as Input. */
export function Textarea({ className, ...rest }) {
  return <textarea className={clsx(CONTROL_BASE, 'py-1.5 leading-5', hasWidth(className) ? '' : 'w-full', className)} {...rest} />;
}

/**
 * Field — a labelled form control. Wraps its child in a <label>, so the text is
 * the control's accessible name. `help` renders helper text under the control,
 * `error` renders an alert. `hideLabel` keeps the name for screen readers only.
 */
export function Field({ label, help, error, hideLabel = false, children, className }) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      <span className={clsx(hideLabel ? 'sr-only' : 'block text-xs font-medium text-muted')}>{label}</span>
      {children}
      {help && <span className="helper block">{help}</span>}
      {error && (
        <span role="alert" className="block text-xs text-bad">
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
      <select className={clsx(CONTROL_BASE, 'w-full appearance-none pr-8', className)} {...rest}>
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
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle" />
    </span>
  );
  if (!label) return control;
  return (
    <Field label={label} help={help} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {control}
    </Field>
  );
}

/** Toggle — an on/off switch (native checkbox with role="switch"). Alias: Switch. */
export function Toggle({ checked, onChange, label, description, disabled = false, className }) {
  return (
    <label className={clsx('flex items-start gap-2.5', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
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
        className="relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-control-off transition-colors duration-150 peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[rgb(var(--focus))] peer-checked:[&>span]:translate-x-3"
      >
        <span className="ml-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-150" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {description && <span className="helper block">{description}</span>}
      </span>
    </label>
  );
}
export const Switch = Toggle;

/** Checkbox with an inline label. */
export function Checkbox({ checked, onChange, label, description, disabled = false, className }) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm text-fg', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded-sm accent-accent"
      />
      <span className="min-w-0">
        {label}
        {description && <span className="helper block">{description}</span>}
      </span>
    </label>
  );
}

/** Radio with an inline label. Group several with the same `name` inside a <fieldset>. */
export function Radio({ name, value, checked, onChange, label, description, disabled = false, className }) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm text-fg', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={() => onChange?.(value)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        {label}
        {description && <span className="helper block">{description}</span>}
      </span>
    </label>
  );
}

/**
 * SegmentedControl — 2-5 mutually exclusive views or modes in one compact
 * control (radiogroup semantics, arrow keys move). options: [{ value, label, icon? }].
 */
export function SegmentedControl({ options, value, onChange, label, size = 'md', className }) {
  const refs = useRef([]);
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const onKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = (idx + dir + options.length) % options.length;
    onChange?.(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={clsx('inline-flex rounded-md border border-line bg-app p-0.5', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange?.(o.value)}
            onKeyDown={onKey}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-[4px] font-medium transition-colors duration-150',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
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

/**
 * Tabs — a tablist with an accent underline on the selected tab. Pass
 * `idPrefix` and render each panel with id `${idPrefix}-panel-${id}` and
 * aria-labelledby `${idPrefix}-tab-${id}` (see TabPanel).
 * tabs: [{ id, label, count? }].
 */
export function Tabs({ tabs, value, onChange, label, idPrefix, className }) {
  const auto = useId();
  const prefix = idPrefix || auto;
  const refs = useRef([]);
  const idx = Math.max(
    0,
    tabs.findIndex((t) => t.id === value)
  );
  const onKey = (e) => {
    const map = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(e.key in map)) return;
    e.preventDefault();
    const n = tabs.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (idx + map[e.key] + n) % n;
    onChange?.(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={clsx('flex gap-4 overflow-x-auto border-b border-line', className)}>
      {tabs.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => (refs.current[i] = el)}
            id={`${prefix}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`${prefix}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange?.(t.id)}
            onKeyDown={onKey}
            className={clsx(
              '-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-sm font-medium transition-colors duration-150',
              on ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
            )}
          >
            {t.label}
            {t.count != null && <span className="font-mono text-xs text-subtle">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** TabPanel — the region a Tabs entry controls. */
export function TabPanel({ idPrefix, id, children, className }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>
      {children}
    </div>
  );
}

/** Shared class string for native <select>s that cannot use <Select>. */
export const selectClass = `w-full ${CONTROL_BASE}`;
export const controlClass = CONTROL_BASE;
