import { useState } from 'react';
import { Dialog, Button, Select } from '@/components/ui';
import { FormField } from './FormControls';

/** Pick a device whose OWN tags become the new profile's tags (then review it in the profile editor). */
export default function FromDeviceDialog({ devices, onClose, onPick }) {
  const choices = devices.filter((d) => (d.ownTags || d.tags || []).some((t) => t.origin !== 'profile'));
  const [sel, setSel] = useState(choices[0]?.id || '');
  const device = choices.find((d) => d.id === sel);
  return (
    <Dialog
      title="Create a profile from a device"
      description={choices.length ? "The device's own tags, poll groups and protocol options are copied into a new profile. The device itself is not changed." : undefined}
      onClose={onClose}
      onSubmit={() => device && onPick(device)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!device}>
            Continue
          </Button>
        </>
      }
    >
      {choices.length === 0 ? (
        <p className="text-sm text-muted">No device has tags of its own yet. Add tags to a device first, then turn them into a reusable profile.</p>
      ) : (
        <div className="space-y-3">
          <FormField label="Device" help={'You can add {param} placeholders before saving.'}>
            {(a) => (
              <Select {...a} data-autofocus value={sel} onChange={(e) => setSel(e.target.value)}>
                {choices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({(d.ownTags || d.tags).filter((t) => t.origin !== 'profile').length} tags)
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      )}
    </Dialog>
  );
}
