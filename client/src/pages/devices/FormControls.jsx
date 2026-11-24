import { useId } from 'react';
import clsx from 'clsx';
import { Input } from '@/components/ui';

export const selectCls =
  'w-full rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-100 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20';

/** Compact input/select for table cells; always labelled via aria-label. */
export const cellCls =
  'w-full min-w-0 rounded-md border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-600 focus:border-accent-500/60 focus:outline-none focus:ring-2 focus:ring-accent-500/20';

/** A labelled control with optional help text and error, wired with htmlFor / aria-describedby. */
export function FormField({ label, help, error, className, children }) {
  const id = useId();
  const descId = `${id}-d`;
  const describedBy = error || help ? descId : undefined;
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {(error || help) && (
        <p id={descId} className={clsx('text-2xs', error ? 'text-rose-300' : 'text-slate-500')}>
          {error || help}
        </p>
      )}
    </div>
  );
}

const optValue = (o) => (typeof o === 'object' ? o.value : o);
const optLabel = (o) => (typeof o === 'object' ? o.label ?? o.value : o);

/** Renders one protocol-descriptor field (number | select | text | boolean). */
export function DescriptorField({ field, value, onChange, error }) {
  const v = value ?? field.default ?? '';
  const label = `${field.label || field.name}${field.optional ? ' (optional)' : ''}`;
  if (field.type === 'boolean') {
    return (
      <FormField label={label} help={field.help} error={error}>
        {(a) => (
          <label className="flex h-[38px] items-center gap-2 text-sm text-slate-200">
            <input {...a} type="checkbox" className="h-4 w-4 accent-sky-500" checked={Boolean(value ?? field.default)} onChange={(e) => onChange(e.target.checked)} />
            {value ?? field.default ? 'On' : 'Off'}
          </label>
        )}
      </FormField>
    );
  }
  return (
    <FormField label={label} help={field.help} error={error}>
      {(a) =>
        field.type === 'select' ? (
          <select {...a} className={selectCls} value={String(v)} onChange={(e) => onChange(coerceSelect(field, e.target.value))}>
            {(field.options || []).map((o) => (
              <option key={String(optValue(o))} value={String(optValue(o))}>
                {String(optLabel(o))}
              </option>
            ))}
          </select>
        ) : (
          <Input
            {...a}
            type={field.type === 'number' ? 'number' : 'text'}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder ?? (field.optional ? 'not set' : undefined)}
            value={v}
            onChange={(e) => onChange(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          />
        )
      }
    </FormField>
  );
}

// Select option values are strings in the DOM; give back the original type (0|1 vs 'big').
function coerceSelect(field, raw) {
  const match = (field.options || []).find((o) => String(optValue(o)) === raw);
  return match === undefined ? raw : optValue(match);
}

/** A grid of descriptor fields writing into `values`. */
export function DescriptorFields({ fields, values, onChange, errors = {} }) {
  if (!fields?.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((f) => (
        <DescriptorField key={f.name} field={f} value={values?.[f.name]} onChange={(v) => onChange(f.name, v)} error={errors[f.name]} />
      ))}
    </div>
  );
}

/** One-click value sets from the descriptor (e.g. S7 rack/slot per CPU family). */
export function PresetButtons({ presets, isActive, onApply }) {
  if (!presets?.length) return null;
  return (
    <div role="group" aria-label="Presets" className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-400">Presets:</span>
      {presets.map((p) => (
        <button
          key={p.label}
          type="button"
          aria-pressed={isActive(p)}
          onClick={() => onApply(p)}
          className={clsx(
            'rounded-lg border px-2.5 py-1 text-xs font-medium transition',
            isActive(p) ? 'border-accent-500/60 bg-accent-500/15 text-accent-200' : 'border-white/10 text-slate-200 hover:bg-white/5'
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
