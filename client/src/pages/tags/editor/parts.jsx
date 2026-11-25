import { cloneElement, useId, useRef, useState } from 'react';
import { X, RotateCcw, Plus } from 'lucide-react';
import clsx from 'clsx';
import { Input, IconButton, Button, Tooltip, Select } from '@/components/ui';

/*
 * Small building blocks of the mapping editor that the design system does not have yet.
 * They follow its rules (tokens only, 6px controls, 4px chips, sentence case) and are
 * candidates for promotion to components/ui:
 *   EditorSection  a titled section of a long form (13px heading, hairline between sections)
 *   MiniSwitch     a label-less switch for table cells (aria-label instead of visible text)
 *   PatternInput   a list of short tokens (globs, poll groups) edited as removable chips
 *   KeyValueEditor key/value rows with an optional type per value
 *   NumberInput    a number field that keeps partial input ("-", "0.") while typing
 *   OriginLabel    "device" / "mapping" marker with a one-click reset
 */

/** A section of the editor: heading row with an optional count and actions, then the body. */
export function EditorSection({ id, title, description, count, actions, children, className }) {
  const hid = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={hid} className={clsx('scroll-mt-12 border-b border-line px-4 py-5 sm:px-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 id={hid} className="flex items-baseline gap-2 text-sm font-medium text-fg">
            {title}
            {count != null && <span className="font-mono text-xs font-normal text-subtle">{count}</span>}
          </h3>
          {description && <p className="mt-0.5 max-w-2xl text-xs text-subtle">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A 12px medium heading inside a section. */
export function SubHeading({ children, className }) {
  return <h4 className={clsx('text-xs font-medium text-muted', className)}>{children}</h4>;
}

/** Inline error under a control. */
export function ErrorText({ children, id }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-bad">
      {children}
    </p>
  );
}

/** Switch without visible text, for table cells. Same visual as the Toggle primitive. */
export function MiniSwitch({ checked, onChange, label, disabled = false, title }) {
  return (
    <Tooltip label={title}>
      <label className={clsx('relative inline-flex items-center', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
        <input type="checkbox" role="switch" aria-label={label} className="peer sr-only" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
        <span
          aria-hidden="true"
          className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-control-off transition-colors duration-150 peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[rgb(var(--focus))] peer-checked:[&>span]:translate-x-3"
        >
          <span className="ml-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-150" />
        </span>
      </label>
    </Tooltip>
  );
}

/** Where a value comes from, with a reset for mapping values. */
export function OriginLabel({ origin, onReset, field, deviceValue }) {
  if (origin === 'mapping') {
    return (
      <span className="inline-flex items-center gap-0.5 text-2xs text-accent-text">
        mapping
        {onReset && (
          <IconButton
            icon={RotateCcw}
            size={12}
            className="h-5 w-5"
            label={deviceValue !== undefined && deviceValue !== null && deviceValue !== '' ? `Reset ${field} to the device value (${typeof deviceValue === 'object' ? 'set on the device' : deviceValue})` : `Clear the ${field} set by this mapping`}
            onClick={onReset}
          />
        )}
      </span>
    );
  }
  if (origin === 'device') return <span className="text-2xs text-subtle">device</span>;
  // OPC UA: EngineeringUnits / EURange / Description / DataType as the server publishes them.
  if (origin === 'server') return <span className="text-2xs text-subtle">from server</span>;
  return null;
}

/** A label row with the origin marker on the right. Wraps the control like Field (accessible name). */
export function OverrideField({ label, origin, onReset, deviceValue, error, help, children, className }) {
  const id = useId();
  const errId = useId();
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="mb-1.5 flex h-5 items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>
        <OriginLabel origin={origin} onReset={onReset} field={label.toLowerCase()} deviceValue={deviceValue} />
      </div>
      {cloneElement(children, { id, 'aria-describedby': error ? errId : undefined, 'aria-invalid': error ? true : children.props['aria-invalid'] })}
      {help && !error && <p className="helper mt-1">{help}</p>}
      <ErrorText id={errId}>{error}</ErrorText>
    </div>
  );
}

const fmtNum = (v) => (v === undefined || v === null || Number.isNaN(v) ? '' : String(v));

/**
 * Number input that keeps what the user typed while it is not a number yet. Calls onChange with a
 * finite number, or undefined when cleared. `integer` rejects fractions.
 */
export function NumberInput({ value, onChange, integer = false, className, placeholder, 'aria-invalid': ariaInvalid, ...rest }) {
  const [text, setText] = useState(fmtNum(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value && !(Number.isNaN(seen) && Number.isNaN(value))) {
    setSeen(value);
    if (Number(text) !== value || text === '') setText(fmtNum(value));
  }
  const parsed = text.trim() === '' ? undefined : Number(text);
  const invalid = text.trim() !== '' && (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)));
  return (
    <Input
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid || ariaInvalid || undefined}
      className={clsx('mono tabular-nums', className)}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const n = t.trim() === '' ? undefined : Number(t);
        if (n === undefined) onChange(undefined);
        else if (Number.isFinite(n) && (!integer || Number.isInteger(n))) onChange(n);
      }}
      {...rest}
    />
  );
}

/** Removable chips plus an input; Enter or comma adds the typed token. */
export function PatternInput({ label, values, onChange, placeholder, suggestions = [], help, mono = true, max = 64 }) {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const listId = useId();
  const add = (raw) => {
    const parts = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    onChange(next);
    setDraft('');
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-muted">
        {label}
      </label>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line-strong bg-field px-1.5 py-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        {values.map((v) => (
          <span key={v} className={clsx('inline-flex h-6 items-center gap-1 rounded border border-line bg-raised pl-1.5 text-xs text-fg', mono && 'font-mono')}>
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="grid h-6 w-5 place-items-center rounded text-muted hover:text-fg">
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={draft}
          list={suggestions.length ? listId : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v.endsWith(',')) add(v.slice(0, -1));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={values.length ? '' : placeholder}
          className={clsx('h-6 min-w-[6rem] flex-1 bg-transparent px-1 text-sm text-fg placeholder:text-faint focus:outline-none', mono && 'font-mono text-xs')}
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {help && <p className="helper">{help}</p>}
    </div>
  );
}

const TYPE_OPTIONS = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' }
];

/**
 * Key/value rows: [{ id, key, value, type? }]. `typed` adds a value type select. `inherited`
 * ([{ key, value, origin }]) lists read-only values a row with the same key overrides.
 * `onValueFocus(id, el)` lets a parent insert placeholders at the caret.
 */
export function KeyValueEditor({ rows, onChange, typed = false, keyLabel = 'Key', valueLabel = 'Value', addLabel = 'Add key', errors = [], inherited = [], keyPlaceholder = 'key', valuePlaceholder = 'value', onValueFocus, max = 64, monoKeys = true }) {
  const counter = useRef(0);
  const idBase = useId();
  const set = (id, patch) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (preset = {}) => {
    counter.current += 1;
    onChange([...rows, { id: `${idBase}${counter.current}`, key: '', value: '', type: 'string', ...preset }]);
  };
  const errOf = (id, field) => errors.find((e) => e.id === id && e.field === field)?.message;
  const overridden = new Set(rows.map((r) => String(r.key).trim()));
  const shownInherited = inherited.filter((i) => !overridden.has(i.key));
  return (
    <div className="space-y-1.5">
      {(rows.length > 0 || shownInherited.length > 0) && (
        <div className={clsx('grid items-center gap-x-2 gap-y-1.5 text-xs font-medium text-muted', typed ? 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6.5rem_2rem]' : 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2rem]')} aria-hidden="true">
          <span>{keyLabel}</span>
          <span>{valueLabel}</span>
          {typed && <span>Type</span>}
          <span />
        </div>
      )}
      {shownInherited.map((i) => (
        <div key={`inh-${i.key}`} className={clsx('grid items-center gap-x-2 text-sm', typed ? 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6.5rem_2rem]' : 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2rem]')}>
          <span className="truncate px-2.5 font-mono text-xs text-muted" title={i.key}>
            {i.key}
          </span>
          <span className="flex min-w-0 items-center gap-2 px-2.5">
            <span className="truncate font-mono text-xs text-muted" title={String(i.value)}>
              {String(i.value)}
            </span>
            <span className="shrink-0 text-2xs text-subtle">{i.origin}</span>
          </span>
          {typed && <span />}
          <IconButton icon={Plus} size={14} label={`Override ${i.key}`} onClick={() => add({ key: i.key, value: String(i.value), type: typeof i.value === 'number' ? 'number' : typeof i.value === 'boolean' ? 'boolean' : 'string' })} />
        </div>
      ))}
      {rows.map((r) => {
        const kErr = errOf(r.id, 'key');
        const vErr = errOf(r.id, 'value');
        return (
          <div key={r.id}>
            <div className={clsx('grid items-center gap-x-2', typed ? 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6.5rem_2rem]' : 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2rem]')}>
              <Input value={r.key} onChange={(e) => set(r.id, { key: e.target.value })} aria-label={`${keyLabel} ${r.key || '(new)'}`} aria-invalid={Boolean(kErr) || undefined} placeholder={keyPlaceholder} className={clsx('h-8', monoKeys && 'mono text-xs')} />
              {typed && r.type === 'boolean' ? (
                <Select value={r.value === 'true' ? 'true' : 'false'} onChange={(e) => set(r.id, { value: e.target.value })} aria-label={`${valueLabel} of ${r.key || 'new key'}`} options={['true', 'false']} />
              ) : (
                <Input
                  value={r.value}
                  onChange={(e) => set(r.id, { value: e.target.value })}
                  onFocus={(e) => onValueFocus?.(r.id, e.currentTarget)}
                  aria-label={`${valueLabel} of ${r.key || 'new key'}`}
                  aria-invalid={Boolean(vErr) || undefined}
                  placeholder={valuePlaceholder}
                  className="mono h-8 text-xs"
                />
              )}
              {typed && (
                <Select
                  value={r.type || 'string'}
                  onChange={(e) => set(r.id, { type: e.target.value, value: e.target.value === 'boolean' ? (r.value === 'true' ? 'true' : 'false') : r.value })}
                  aria-label={`Type of ${r.key || 'new key'}`}
                  options={TYPE_OPTIONS}
                />
              )}
              <IconButton icon={X} size={14} label={`Remove ${r.key || 'this row'}`} className="hover:bg-bad/10 hover:text-bad" onClick={() => onChange(rows.filter((x) => x.id !== r.id))} />
            </div>
            {(kErr || vErr) && <ErrorText>{kErr || vErr}</ErrorText>}
          </div>
        );
      })}
      <Button size="sm" variant="ghost" className="-ml-2" onClick={() => add()} disabled={rows.length >= max}>
        <Plus size={12} aria-hidden="true" /> {addLabel}
      </Button>
    </div>
  );
}

/** A placeholder chip that inserts its token. */
export function TokenChip({ token, onInsert, label }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault() /* keep the caret in the field being edited */}
      onClick={() => onInsert(token)}
      aria-label={label || `Insert ${token}`}
      className="inline-flex h-6 items-center rounded border border-line bg-raised px-1.5 font-mono text-xs text-fg transition-colors hover:border-line-strong hover:bg-[rgb(var(--tint)/0.08)]"
    >
      {token}
    </button>
  );
}
