import { useState } from 'react';
import { Dialog, Button, Select } from '@/components/ui';
import { FormField } from './FormControls';

/** Choose which profile a new device is created from. */
export default function PickProfileDialog({ profiles, labels, onClose, onPick }) {
  const [sel, setSel] = useState(profiles[0]?.id || '');
  const profile = profiles.find((p) => p.id === sel);
  return (
    <Dialog
      title="New device from a profile"
      description={profiles.length ? 'The device gets the profile’s tags, poll groups and options.' : undefined}
      onClose={onClose}
      onSubmit={() => profile && onPick(profile)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!profile}>
            Continue
          </Button>
        </>
      }
    >
      {profiles.length === 0 ? (
        <p className="text-sm text-muted">There are no profiles yet. Create one on the Profiles tab first.</p>
      ) : (
        <FormField label="Profile">
          {(a) => (
            <Select {...a} data-autofocus value={sel} onChange={(e) => setSel(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({labels[p.protocol] || p.protocol})
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
    </Dialog>
  );
}
