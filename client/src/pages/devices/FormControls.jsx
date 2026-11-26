import { useId } from 'react';
import clsx from 'clsx';
import { FlaskConical, Lock } from 'lucide-react';
import { Input, Select, Checkbox, SegmentedControl, Badge } from '@/components/ui';

/** Compact input / select for table cells; always labelled with aria-label. 28px tall, same tokens as Input. */
export const cellCls =
  'h-7 w-full min-w-0 rounded border border-line-strong bg-field px-2 text-xs text-fg placeholder:text-faint transition-colors duration-150 ' +
  'hover:border-line-stronger focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-bad';

/** A labelled control with optional help text and error, wired with htmlFor / aria-describedby. */
export function FormField({ label, help, error, className, children }) {
  const id = useId();
  const descId = `${id}-d`;
  const describedBy = error || help ? descId : undefined;
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {(error || help) && (
        <p id={descId} role={error ? 'alert' : undefined} className={clsx('text-xs', error ? 'text-bad' : 'text-subtle')}>
          {error || help}
        </p>
      )}
    </div>
  );
}

/** A group inside a dialog: 13px heading, optional one-line hint, then the fields. */
export function FormSection({ title, hint, children, className }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={clsx('space-y-3', className)}>
      <div>
        <h3 id={id} className="text-sm font-medium text-fg">
          {title}
        </h3>
        {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const optValue = (o) => (typeof o === 'object' ? o.value : o);
const optLabel = (o) => (typeof o === 'object' ? o.label ?? o.value : o);

/** Renders one protocol-descriptor field (number | select | text | password | boolean). */
export function DescriptorField({ field, value, onChange, error, disabled }) {
  const v = value ?? field.default ?? '';
  const label = `${field.label || field.name}${field.optional ? ' (optional)' : ''}`;
  if (field.type === 'boolean') {
    return (
      <div className="space-y-1.5 self-end pb-1">
        <Checkbox label={label} description={error || field.help} checked={Boolean(value ?? field.default)} disabled={disabled} onChange={onChange} />
      </div>
    );
  }
  return (
    <FormField label={label} help={field.help} error={error}>
      {(a) =>
        field.type === 'select' ? (
          <Select {...a} value={String(v)} disabled={disabled} onChange={(e) => onChange(coerceSelect(field, e.target.value))}>
            {(field.options || []).map((o) => (
              <option key={String(optValue(o))} value={String(optValue(o))}>
                {String(optLabel(o))}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            {...a}
            type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'}
            autoComplete={field.type === 'password' ? 'new-password' : undefined}
            min={field.min}
            max={field.max}
            disabled={disabled}
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

// A field with `showWhen: { name, in: [...] }` is shown only while another field has one of those values
// (the HTTP drivers show the user name only for basic authentication, for example).
const shown = (f, values) => {
  const w = f.showWhen;
  if (!w) return true;
  const v = values?.[w.name];
  return (w.in || []).includes(v);
};

/** A grid of descriptor fields writing into `values`. */
export function DescriptorFields({ fields, values, onChange, errors = {}, disabled, siblings }) {
  if (!fields?.length) return null;
  const lookup = { ...Object.fromEntries((siblings || fields).filter((f) => f.default !== undefined).map((f) => [f.name, f.default])), ...values };
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {fields.filter((f) => shown(f, lookup)).map((f) => (
        <DescriptorField key={f.name} field={f} value={values?.[f.name]} onChange={(v) => onChange(f.name, v)} error={errors[f.name]} disabled={disabled} />
      ))}
    </div>
  );
}

/** One-click value sets from the descriptor (e.g. S7 rack/slot per CPU family). */
export function PresetButtons({ presets, isActive, onApply, disabled }) {
  if (!presets?.length) return null;
  const active = presets.find((p) => isActive(p));
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted">Presets</span>
      <SegmentedControl
        label="Presets"
        size="sm"
        className={clsx('flex-wrap', disabled && 'pointer-events-none opacity-50')}
        options={presets.map((p) => ({ value: p.label, label: p.label }))}
        value={active?.label ?? ''}
        onChange={(label) => onApply(presets.find((p) => p.label === label))}
      />
    </div>
  );
}

/** Driver status of the protocol: shown quietly next to a name. */
export function ExperimentalBadge({ className }) {
  return (
    <Badge tone="warn" className={className}>
      <FlaskConical size={11} aria-hidden="true" /> Experimental
    </Badge>
  );
}

/** Marks a tag or device that comes from a device profile (read-only there). */
export function FromProfileBadge({ className }) {
  return (
    <span title="Defined by the device profile; edit the profile to change it" className="inline-flex">
      <Badge className={className}>
        <Lock size={10} aria-hidden="true" /> Profile
      </Badge>
    </span>
  );
}
