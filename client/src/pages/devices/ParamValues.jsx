import { Input } from '@/components/ui';
import { FormField } from './FormControls';

/** One input per declared profile parameter; the default shows as the placeholder and applies when left empty. */
export default function ParamValues({ params, values, onChange }) {
  if (!params?.length) return <p className="text-xs text-slate-500">This profile declares no parameters.</p>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {params.map((p) => {
        const hasDefault = p.default !== undefined && p.default !== null && p.default !== '';
        const empty = values?.[p.name] === undefined || values?.[p.name] === '';
        return (
          <FormField
            key={p.name}
            label={`${p.name}${hasDefault ? '' : ' (required)'}`}
            help={p.description || (hasDefault ? `Default: ${p.default}` : undefined)}
            error={!hasDefault && empty ? 'Required: this profile gives no default' : undefined}
          >
            {(a) => <Input {...a} className="mono" value={values?.[p.name] ?? ''} placeholder={hasDefault ? String(p.default) : ''} onChange={(e) => onChange(p.name, e.target.value)} />}
          </FormField>
        );
      })}
    </div>
  );
}
