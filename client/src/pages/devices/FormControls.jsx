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

/** Renders one protocol-descriptor field (number | select | text). */
export function DescriptorField({ field, value, onChange, error }) {
  const v = value ?? field.default ?? '';
  return (
    <FormField label={field.label || field.name} help={field.help} error={error}>
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

/** Defaults object from a descriptor field list. */
export function fieldDefaults(fields) {
  const out = {};
  for (const f of fields || []) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}
