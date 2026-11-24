import { useId, useState } from 'react';
import { Modal, Button } from '@/components/ui';
import { FormField, selectCls } from './FormControls';

/** Pick a device whose OWN tags become the new profile's tags (then review it in the profile editor). */
export default function FromDeviceDialog({ devices, onClose, onPick }) {
  const id = useId();
  const choices = devices.filter((d) => (d.ownTags || d.tags || []).some((t) => t.origin !== 'profile'));
  const [sel, setSel] = useState(choices[0]?.id || '');
  const device = choices.find((d) => d.id === sel);
  return (
    <Modal title="Create profile from device" labelledBy={id} onClose={onClose}>
      <h3 id={id} className="text-base font-semibold text-slate-100">Create a profile from a device</h3>
      {choices.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">No device has tags of its own yet. Add tags to a device first, then turn them into a reusable profile.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-400">The device's own tags, poll groups and protocol options are copied into a new profile. The device itself is not changed. You can add {'{param}'} placeholders before saving.</p>
          <div className="mt-3">
            <FormField label="Device">
              {(a) => (
                <select {...a} data-autofocus className={selectCls} value={sel} onChange={(e) => setSel(e.target.value)}>
                  {choices.map((d) => <option key={d.id} value={d.id}>{d.name} ({(d.ownTags || d.tags).filter((t) => t.origin !== 'profile').length} tags)</option>)}
                </select>
              )}
            </FormField>
          </div>
        </>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onPick(device)} disabled={!device}>Continue</Button>
      </div>
    </Modal>
  );
}
