import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import { cellCls } from './FormControls';
import { blankParam, paramDeclErrors } from '@/lib/deviceProfiles';

/**
 * Declared parameters of a profile: name, default and description. A tag may use
 * {name} in its key, address and UNS property; each device instance supplies the value.
 */
export default function ParamsEditor({ params, onChange, undeclared = [] }) {
  const errs = paramDeclErrors(params);
  const set = (i, patch) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const missing = [...new Set(undeclared.flatMap((u) => u.names))];
  return (
    <div className="space-y-2">
      {missing.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>
            Used in tags but not declared:{' '}
            {missing.map((n) => (
              <span key={n} className="mono mr-1 rounded bg-rose-500/20 px-1">{`{${n}}`}</span>
            ))}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...params.filter((p) => p.name), ...missing.map((name) => ({ ...blankParam(), name }))])}>
            Declare {missing.length === 1 ? 'it' : 'them'}
          </Button>
        </div>
      )}
      {params.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Profile parameters</caption>
            <thead className="bg-white/[0.03] text-2xs uppercase tracking-wide text-slate-400">
              <tr>
                <th scope="col" className="min-w-[8rem] px-2 py-2 font-medium">Name</th>
                <th scope="col" className="min-w-[8rem] px-2 py-2 font-medium">Default</th>
                <th scope="col" className="min-w-[12rem] px-2 py-2 font-medium">Description</th>
                <th scope="col" className="w-10 px-1 py-2"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {params.map((p, i) => (
                <tr key={i} className="align-top">
                  <td className="px-1 py-1.5">
                    <input className={`${cellCls} mono`} aria-label={`Parameter name, row ${i + 1}`} aria-invalid={errs[i] ? true : undefined} value={p.name} placeholder="base" onChange={(e) => set(i, { name: e.target.value.trim() })} />
                    {errs[i] && <p role="alert" className="mt-1 text-2xs text-rose-300">{errs[i]}</p>}
                  </td>
                  <td className="px-1 py-1.5">
                    <input className={cellCls} aria-label={`Default value, row ${i + 1}`} value={p.default ?? ''} placeholder="required per device" onChange={(e) => set(i, { default: e.target.value })} />
                  </td>
                  <td className="px-1 py-1.5">
                    <input className={cellCls} aria-label={`Description, row ${i + 1}`} value={p.description ?? ''} placeholder="What the value means" onChange={(e) => set(i, { description: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <IconButton icon={Trash2} side="left" label={`Remove parameter ${p.name || i + 1}`} onClick={() => onChange(params.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...params, blankParam()])}>
        <Plus size={14} /> Add parameter
      </Button>
    </div>
  );
}
