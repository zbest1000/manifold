import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Banner, Code } from '@/components/ui';
import { cellCls } from './FormControls';
import { blankParam, paramDeclErrors } from '@/lib/deviceProfiles';

const TH = 'h-8 whitespace-nowrap px-1.5 text-left align-middle text-xs font-medium text-muted';

/**
 * Declared parameters of a profile: name, default and description. A tag may use
 * {name} in its key, address and UNS property; each device instance supplies the value.
 */
export default function ParamsEditor({ params, onChange, undeclared = [] }) {
  const errs = paramDeclErrors(params);
  const set = (i, patch) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const missing = [...new Set(undeclared.flatMap((u) => u.names))];
  return (
    <div className="space-y-3">
      {missing.length > 0 && (
        <Banner
          variant="error"
          title="Used in tags but not declared"
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...params.filter((p) => p.name), ...missing.map((name) => ({ ...blankParam(), name }))])}>
              Declare {missing.length === 1 ? 'it' : 'them'}
            </Button>
          }
        >
          {missing.map((n) => (
            <Code key={n} className="mr-1">{`{${n}}`}</Code>
          ))}
        </Banner>
      )}
      {params.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Profile parameters</caption>
            <thead className="border-b border-line">
              <tr>
                <th scope="col" className={`${TH} min-w-[8rem] pl-3`}>Name</th>
                <th scope="col" className={`${TH} min-w-[8rem]`}>Default</th>
                <th scope="col" className={`${TH} min-w-[12rem]`}>Description</th>
                <th scope="col" className={`${TH} w-10`}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {params.map((p, i) => (
                <tr key={i} className="border-t border-line align-top first:border-t-0">
                  <td className="py-1.5 pl-3 pr-1.5">
                    <input className={`${cellCls} mono`} aria-label={`Parameter name, row ${i + 1}`} aria-invalid={errs[i] ? true : undefined} value={p.name} placeholder="base" onChange={(e) => set(i, { name: e.target.value.trim() })} />
                    {errs[i] && (
                      <p role="alert" className="mt-1 text-xs text-bad">
                        {errs[i]}
                      </p>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input className={cellCls} aria-label={`Default value, row ${i + 1}`} value={p.default ?? ''} placeholder="required per device" onChange={(e) => set(i, { default: e.target.value })} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input className={cellCls} aria-label={`Description, row ${i + 1}`} value={p.description ?? ''} placeholder="What the value means" onChange={(e) => set(i, { description: e.target.value })} />
                  </td>
                  <td className="px-1 py-1.5">
                    <IconButton icon={Trash2} side="left" size={14} className="h-7 w-7 hover:bg-bad/10 hover:text-bad" label={`Remove parameter ${p.name || i + 1}`} onClick={() => onChange(params.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...params, blankParam()])}>
        <Plus size={14} aria-hidden="true" /> Add parameter
      </Button>
    </div>
  );
}
