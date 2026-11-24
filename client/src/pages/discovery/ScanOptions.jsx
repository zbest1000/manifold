import { useId } from 'react';
import { Input, Checkbox } from '@/components/ui';
import { SCAN_PROTOCOLS, parsePorts } from '@/lib/discoveryDevices';

/**
 * "Also find PLCs and meters": one row per protocol, a checkbox and its port list. Unticked protocols
 * are not probed (the server only scans devices when asked to). `value` maps protocol id -> ports text,
 * absent = off.
 */
export default function ScanOptions({ value, onChange, disabled }) {
  const legend = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium text-fg">Also find PLCs and meters</legend>
      <div className="divide-y divide-line rounded-md border border-line">
        {SCAN_PROTOCOLS.map((p) => {
          const on = value[p.id] !== undefined;
          const bad = on ? parsePorts(value[p.id]).bad : [];
          const inputId = `${legend}-${p.id}`;
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2">
              <Checkbox
                className="min-w-[11rem]"
                label={p.label}
                checked={on}
                onChange={(checked) => {
                  const next = { ...value };
                  if (checked) next[p.id] = String(p.port);
                  else delete next[p.id];
                  onChange(next);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="min-w-[9.5rem] text-xs text-muted" htmlFor={inputId}>
                  Port(s), default {p.port}
                </label>
                <Input
                  id={inputId}
                  className="mono w-36"
                  value={on ? value[p.id] : String(p.port)}
                  disabled={!on}
                  aria-invalid={bad.length ? true : undefined}
                  onChange={(e) => onChange({ ...value, [p.id]: e.target.value })}
                />
              </div>
              {bad.length > 0 && (
                <p role="alert" className="basis-full text-xs text-bad">
                  Not a port: {bad.join(', ')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
