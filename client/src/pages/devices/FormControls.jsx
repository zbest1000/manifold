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

/**
 * A descriptor field's label with "optional" added: "Port (optional)", and one parenthesis for a label
 * that already ends in one ("Local TSAP (advanced)" -> "Local TSAP (advanced, optional)").
 */
export function descriptorLabel(field) {
  const base = String(field.label || field.name);
  if (!field.optional) return base;
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(base);
  return m ? `${m[1]} (${m[2]}, optional)` : `${base} (optional)`;
}

/**
 * Renders one protocol-descriptor field (number | select | text | password | boolean).
 * A password field never shows a stored value: the server sends it as null, the input
 * stays empty, and leaving it empty keeps what is stored.
 */
export function DescriptorField({ field, value, onChange, error, disabled }) {
  if (field.type === 'password') return <SecretField field={field} value={value} onChange={onChange} error={error} disabled={disabled} />;
  const v = value ?? field.default ?? '';
  const label = descriptorLabel(field);
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

function SecretField({ field, value, onChange, error, disabled }) {
  const stored = value === null; // the server has one; it is never sent to the browser
  return (
    <FormField label={field.label || field.name} help={field.help} error={error}>
      {(a) => (
        <Input
          {...a}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          placeholder={stored ? 'stored, leave blank to keep' : field.placeholder ?? (field.optional ? 'not set' : undefined)}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' && stored ? null : e.target.value)}
        />
      )}
    </FormField>
  );
}

/** A field with `showWhen: { other: [values] }` is only shown (and sent) while every listed field has one of its values. */
export function fieldVisible(field, values) {
  const when = field?.showWhen;
  if (!when) return true;
  return Object.entries(when).every(([name, allowed]) => {
    const v = values?.[name];
    return allowed.map(String).includes(String(v === undefined || v === null || v === '' ? '' : v));
  });
}

// Select option values are strings in the DOM; give back the original type (0|1 vs 'big').
function coerceSelect(field, raw) {
  const match = (field.options || []).find((o) => String(optValue(o)) === raw);
  return match === undefined ? raw : optValue(match);
}

/**
 * A grid of descriptor fields writing into `values`. A field with `showWhen` is shown only while its
 * conditions hold (fieldVisible); a condition reads the current value, or the field's default while
 * none is set. `visibleWith` / `siblings` supply the values and fields a condition refers to when they
 * live outside this grid.
 */
export function DescriptorFields({ fields, values, onChange, errors = {}, disabled, siblings, visibleWith }) {
  const set = Object.entries(visibleWith || values || {}).filter(([, v]) => v !== undefined);
  const defaults = (siblings || fields || []).filter((f) => f.default !== undefined).map((f) => [f.name, f.default]);
  const lookup = { ...Object.fromEntries(defaults), ...Object.fromEntries(set) };
  const shown = (fields || []).filter((f) => fieldVisible(f, lookup));
  if (!shown.length) return null;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((f) => (
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
