import { useId } from 'react';
import { Input } from '@/components/ui';
import { SCAN_PROTOCOLS, parsePorts } from '@/lib/discoveryDevices';

/**
 * "Find devices" options: one checkbox per protocol with its port list. Unticked
 * protocols are not probed (the server only scans devices when asked to).
 * `value` maps protocol id -> ports text, absent = off.
 */
export default function ScanOptions({ value, onChange, disabled }) {
  const legend = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend id={legend} className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Also find PLCs and meters (optional)</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {SCAN_PROTOCOLS.map((p) => {
          const on = value[p.id] !== undefined;
          const bad = on ? parsePorts(value[p.id]).bad : [];
          return (
            <div key={p.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-200">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-sky-500"
                  checked={on}
                  onChange={(e) => {
                    const next = { ...value };
                    if (e.target.checked) next[p.id] = String(p.port);
                    else delete next[p.id];
                    onChange(next);
                  }}
                />
                {p.label}
              </label>
              <div className="mt-2">
                <label className="block text-2xs text-slate-500" htmlFor={`${legend}-${p.id}`}>Port(s), default {p.port}</label>
                <Input
                  id={`${legend}-${p.id}`}
                  className="mono mt-1"
                  value={on ? value[p.id] : String(p.port)}
                  disabled={!on}
                  aria-invalid={bad.length ? true : undefined}
                  onChange={(e) => onChange({ ...value, [p.id]: e.target.value })}
                />
                {bad.length > 0 && <p role="alert" className="mt-1 text-2xs text-rose-300">Not a port: {bad.join(', ')}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
