import { useId, useState } from 'react';
import { Modal, Button } from '@/components/ui';
import { FormField, selectCls } from './FormControls';

/** Choose which profile a new device is created from. */
export default function PickProfileDialog({ profiles, labels, onClose, onPick }) {
  const id = useId();
  const [sel, setSel] = useState(profiles[0]?.id || '');
  const profile = profiles.find((p) => p.id === sel);
  return (
    <Modal title="New device from profile" labelledBy={id} onClose={onClose}>
      <h3 id={id} className="text-base font-semibold text-slate-100">New device from a profile</h3>
      {profiles.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">There are no profiles yet. Create one on the Profiles tab first.</p>
      ) : (
        <div className="mt-3">
          <FormField label="Profile">
            {(a) => (
              <select {...a} data-autofocus className={selectCls} value={sel} onChange={(e) => setSel(e.target.value)}>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({labels[p.protocol] || p.protocol})</option>)}
              </select>
            )}
          </FormField>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onPick(profile)} disabled={!profile}>Continue</Button>
      </div>
    </Modal>
  );
}
