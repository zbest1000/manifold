import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';

/**
 * Edit the poll groups: an id and an interval each, with how many tags use the group. A group that
 * tags use cannot be removed. At least one group must remain (unless `allowEmpty`, for profile overrides).
 */
export default function PollGroupsEditor({ groups, onChange, usage = {}, errors = {}, allowEmpty = false, disabled = false }) {
  const set = (i, patch) => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const add = () => {
    let n = groups.length + 1;
    while (groups.some((g) => g.id === `group${n}`)) n++;
    onChange([...groups, { id: `group${n}`, intervalMs: 1000 }]);
  };
  return (
    <div className="space-y-2">
      {groups.length > 0 && (
        <div role="group" aria-label="Poll groups" className="max-w-xl space-y-2">
          <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_2rem] gap-2 text-xs font-medium text-muted">
            <span>Group id</span>
            <span>Interval (ms)</span>
            <span className="text-right">Tags</span>
            <span />
          </div>
          {groups.map((g, i) => {
            const dup = groups.some((o, j) => j < i && o.id === g.id);
            const used = usage[g.id] || 0;
            const err = dup ? 'Duplicate id' : errors[i];
            return (
              <div key={i}>
                <div className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_2rem] items-center gap-2">
                  <Input aria-label={`Poll group id, row ${i + 1}`} aria-invalid={err ? true : undefined} className="mono" value={g.id} disabled={disabled} onChange={(e) => set(i, { id: e.target.value.trim() })} />
                  <Input aria-label={`Poll interval in ms, row ${i + 1}`} type="number" min={10} step={10} value={g.intervalMs} disabled={disabled} onChange={(e) => set(i, { intervalMs: e.target.value === '' ? '' : Number(e.target.value) })} />
                  <span className="text-right text-sm tabular-nums text-muted">{used.toLocaleString()}</span>
                  <IconButton
                    icon={Trash2}
                    side="left"
                    size={14}
                    className="hover:bg-bad/10 hover:text-bad"
                    label={used ? `Cannot remove ${g.id}: tags use it` : `Remove poll group ${g.id}`}
                    disabled={disabled || (!allowEmpty && groups.length <= 1) || used > 0}
                    onClick={() => onChange(groups.filter((_, j) => j !== i))}
                  />
                </div>
                {err && (
                  <p role="alert" className="mt-1 text-xs text-bad">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} aria-hidden="true" /> Add poll group
      </Button>
    </div>
  );
}
