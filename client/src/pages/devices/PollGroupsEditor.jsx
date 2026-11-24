import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';
import { FormField } from './FormControls';

/** Edit the device's poll groups: an id and an interval each. At least one group must remain. */
export default function PollGroupsEditor({ groups, onChange, usedIds = new Set(), errors = {}, allowEmpty = false }) {
  const set = (i, patch) => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const add = () => {
    let n = groups.length + 1;
    while (groups.some((g) => g.id === `group${n}`)) n++;
    onChange([...groups, { id: `group${n}`, intervalMs: 1000 }]);
  };
  return (
    <div className="space-y-2">
      {groups.map((g, i) => {
        const dup = groups.some((o, j) => j < i && o.id === g.id);
        return (
          <div key={i} className="flex items-end gap-2">
            <FormField label="Group id" className="min-w-0 flex-1" error={dup ? 'Duplicate id' : errors[i]}>
              {(a) => <Input {...a} value={g.id} onChange={(e) => set(i, { id: e.target.value.trim() })} />}
            </FormField>
            <FormField label="Interval (ms)" className="w-32">
              {(a) => (
                <Input {...a} type="number" min={10} step={10} value={g.intervalMs} onChange={(e) => set(i, { intervalMs: e.target.value === '' ? '' : Number(e.target.value) })} />
              )}
            </FormField>
            <IconButton
              icon={Trash2}
              side="left"
              label={usedIds.has(g.id) ? `Cannot remove ${g.id}: tags use it` : `Remove poll group ${g.id}`}
              disabled={(!allowEmpty && groups.length <= 1) || usedIds.has(g.id)}
              onClick={() => onChange(groups.filter((_, j) => j !== i))}
              className="mb-0.5"
            />
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus size={14} /> Add poll group
      </Button>
    </div>
  );
}
