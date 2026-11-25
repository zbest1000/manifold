import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Dialog, Button, Banner } from '@/components/ui';
import { api } from '@/lib/api';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';

/**
 * Delete a device. The server refuses to delete a device that bindings still read from, so the
 * dialog says so BEFORE the click, names the bindings and links to where they are removed.
 */
export default function DeleteDeviceDialog({ device, busy, error, onCancel, onConfirm }) {
  const readOnly = useReadOnly();
  const [bindings, setBindings] = useState(null); // null = loading, [] = none
  useEffect(() => {
    let live = true;
    api.listBindings().then(
      (r) => live && setBindings(r.bindings || []),
      () => live && setBindings([])
    );
    return () => {
      live = false;
    };
  }, []);
  const used = (bindings || []).filter((b) => b.source?.type === 'device' && b.source.deviceId === device.id);
  const own = device.profileId ? `${device.ownTags?.length || 0} own tag definitions` : `${device.tags?.length || 0} tag definitions`;
  return (
    <Dialog
      title={`Delete ${device.name}?`}
      size="md"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <span title={readOnly ? READ_ONLY_REASON : used.length ? 'Delete the bindings that use this device first' : undefined}>
            <Button variant="danger" onClick={onConfirm} loading={busy} disabled={used.length > 0 || readOnly}>
              Delete device
            </Button>
          </span>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Polling stops and its {own} are removed{device.profileId ? ' (the profile stays)' : ''}. This cannot be undone.
        </p>
        {used.length > 0 && (
          <Banner variant="error" title="This device cannot be deleted yet">
            {used.length} binding{used.length === 1 ? '' : 's'} read{used.length === 1 ? 's' : ''} from it ({used.slice(0, 5).map((b) => b.name || b.id.slice(0, 8)).join(', ')}
            {used.length > 5 ? `, and ${used.length - 5} more` : ''}). Delete {used.length === 1 ? 'it' : 'them'} on the{' '}
            <Link to={`/tags?source=device:${encodeURIComponent(device.id)}`} className="text-accent-text underline underline-offset-2">
              Tags page
            </Link>{' '}
            first.
          </Banner>
        )}
        {error && (
          <Banner variant="error" title="Could not delete">
            {error}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
