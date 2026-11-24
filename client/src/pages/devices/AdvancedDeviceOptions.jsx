import { useId, useState } from 'react';
import { Plus, Trash2, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Button, IconButton, Input, Select, Checkbox } from '@/components/ui';
import { FormField } from './FormControls';

const num = (v) => (v === '' ? '' : Number(v));

/** Modbus: register ranges a block read must never span (options.unmapped, inclusive 0-based wire offsets). */
function UnmappedRanges({ tables, ranges, onChange }) {
  const set = (i, patch) => onChange(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const bad = (r) => !(Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 0 && r.to <= 65535 && r.to >= r.from);
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-fg">Unmapped register ranges</h4>
        <p className="helper mt-0.5 max-w-2xl">
          Registers this device does not implement and answers with a Modbus exception (illegal data address). Manifold groups neighbouring tags into one block read and never reads across a range
          listed here, so a gap that would otherwise make the whole block fail is skipped. Offsets are 0-based wire offsets (register 40001 is offset 0), both ends included. Only needed when a tag read
          fails with “illegal data address” because of a hole between two tags.
        </p>
      </div>
      {ranges.length === 0 && <p className="text-sm text-muted">None. Block reads may span any gap up to “Max gap to bridge”.</p>}
      {ranges.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          <FormField label="Table" className="w-40">
            {(a) => (
              <Select {...a} value={r.table} onChange={(e) => set(i, { table: e.target.value })}>
                {tables.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="From offset" className="w-32" error={bad(r) ? 'Needs 0-65535, from ≤ to' : undefined}>
            {(a) => <Input {...a} type="number" min={0} max={65535} value={r.from} onChange={(e) => set(i, { from: num(e.target.value) })} />}
          </FormField>
          <FormField label="To offset" className="w-32">
            {(a) => <Input {...a} type="number" min={0} max={65535} value={r.to} onChange={(e) => set(i, { to: num(e.target.value) })} />}
          </FormField>
          <IconButton icon={Trash2} side="left" size={14} label={`Remove unmapped range ${i + 1}`} onClick={() => onChange(ranges.filter((_, j) => j !== i))} className="mb-0.5 hover:bg-bad/10 hover:text-bad" />
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...ranges, { table: tables.includes('holding') ? 'holding' : tables[0], from: 0, to: 0 }])}>
        <Plus size={14} aria-hidden="true" /> Add unmapped range
      </Button>
    </div>
  );
}

/**
 * The rarely needed device settings, behind a disclosure: Modbus unmapped ranges and per-device
 * process isolation. Open from the start when either is already set, so nothing is hidden.
 */
export default function AdvancedDeviceOptions({ descriptor, draft, onOption, onField }) {
  const isModbus = Array.isArray(descriptor?.tables) && 'unmapped' in (descriptor?.options || {});
  const ranges = Array.isArray(draft.options?.unmapped) ? draft.options.unmapped : [];
  const isolated = Boolean(draft.isolate);
  const [open, setOpen] = useState(isolated || ranges.length > 0);
  const bodyId = useId();
  return (
    <section aria-label="Advanced settings">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-fg transition-colors hover:text-accent-text"
      >
        <ChevronRight size={14} aria-hidden="true" className={clsx('text-subtle transition-transform duration-150', open && 'rotate-90')} />
        <span>Advanced settings</span>
        <span className="hidden font-normal text-subtle sm:inline">{isModbus ? 'unmapped register ranges, driver isolation' : 'driver isolation'}</span>
      </button>
      {open && (
        <div id={bodyId} className="mt-3 space-y-6 border-l-2 border-line pl-4">
          {isModbus && <UnmappedRanges tables={descriptor.tables} ranges={ranges} onChange={(r) => onOption('unmapped', r)} />}
          <div className="space-y-1">
            <Checkbox label="Run this device in its own driver process" checked={isolated} onChange={(v) => onField('isolate', v)} />
            <p className="helper max-w-2xl pl-6">
              By default every device of one protocol shares a driver process, so a device that hangs or crashes its driver stalls its neighbours too. Isolation gives this device a process of its own:
              faults stay contained, at the cost of some extra memory. Use it for a flaky or slow device, or one you are commissioning. Changing it restarts this device&apos;s polling.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
