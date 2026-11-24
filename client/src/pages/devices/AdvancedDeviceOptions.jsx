import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';
import { FormField, selectCls } from './FormControls';

const num = (v) => (v === '' ? '' : Number(v));

/** Modbus: register ranges a block read must never span (options.unmapped, inclusive 0-based wire offsets). */
function UnmappedRanges({ tables, ranges, onChange }) {
  const set = (i, patch) => onChange(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const bad = (r) => !(Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 0 && r.to <= 65535 && r.to >= r.from);
  return (
    <div className="space-y-2">
      <div>
        <h5 className="text-xs font-semibold text-slate-200">Unmapped register ranges</h5>
        <p className="mt-0.5 text-2xs text-slate-500">
          Registers this device does not implement and answers with a Modbus exception (illegal data address). Manifold groups neighbouring tags into one block
          read and never reads across a range listed here, so a gap that would otherwise make the whole block fail is skipped. Offsets are 0-based wire offsets
          (register 40001 is offset 0), both ends included. Only needed when a tag read fails with "illegal data address" because of a hole between two tags.
        </p>
      </div>
      {ranges.length === 0 && <p className="text-xs text-slate-500">None. Block reads may span any gap up to "Max gap to bridge".</p>}
      {ranges.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <FormField label="Table" className="w-40">
            {(a) => (
              <select {...a} className={selectCls} value={r.table} onChange={(e) => set(i, { table: e.target.value })}>
                {tables.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </FormField>
          <FormField label="From offset" className="w-32" error={bad(r) ? 'Needs 0-65535, from ≤ to' : undefined}>
            {(a) => <Input {...a} type="number" min={0} max={65535} value={r.from} onChange={(e) => set(i, { from: num(e.target.value) })} />}
          </FormField>
          <FormField label="To offset" className="w-32">
            {(a) => <Input {...a} type="number" min={0} max={65535} value={r.to} onChange={(e) => set(i, { to: num(e.target.value) })} />}
          </FormField>
          <IconButton icon={Trash2} side="left" label={`Remove unmapped range ${i + 1}`} onClick={() => onChange(ranges.filter((_, j) => j !== i))} className="mb-0.5" />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...ranges, { table: tables.includes('holding') ? 'holding' : tables[0], from: 0, to: 0 }])}>
        <Plus size={14} /> Add unmapped range
      </Button>
    </div>
  );
}

/**
 * The rarely needed device settings, collapsed by default: Modbus unmapped ranges and per-device
 * process isolation. Open automatically when either is already set so nothing is hidden.
 */
export default function AdvancedDeviceOptions({ descriptor, draft, onOption, onField }) {
  const isModbus = Array.isArray(descriptor?.tables) && 'unmapped' in (descriptor?.options || {});
  const ranges = Array.isArray(draft.options?.unmapped) ? draft.options.unmapped : [];
  const isolated = Boolean(draft.isolate);
  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.02]" open={isolated || ranges.length > 0 || undefined}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-slate-100">Advanced</summary>
      <div className="space-y-5 border-t border-white/5 px-3 py-3">
        {isModbus && <UnmappedRanges tables={descriptor.tables} ranges={ranges} onChange={(r) => onOption('unmapped', r)} />}
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" className="accent-sky-500" checked={isolated} onChange={(e) => onField('isolate', e.target.checked)} />
            Run this device in its own driver process
          </label>
          <p className="mt-1 text-2xs text-slate-500">
            By default every device of one protocol shares a driver process, so a device that hangs or crashes its driver stalls its neighbours too. Isolation gives this
            device a process of its own: faults stay contained, at the cost of some extra memory. Use it for a flaky or slow device, or one you are commissioning.
            Changing it restarts this device's polling.
          </p>
        </div>
      </div>
    </details>
  );
}
