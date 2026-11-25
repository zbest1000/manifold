import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Dialog, Button, Banner } from '@/components/ui';
import { deleteProfile } from './devicesApi';

const linkCls = 'text-accent-text underline underline-offset-2';

/**
 * Delete a profile. The server refuses (409) while device instances or UNS
 * bindings still use it; the dialog then names every blocker with a link.
 */
export default function DeleteProfileDialog({ profile, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null); // { message, instances, bindings }
  const [error, setError] = useState('');
  const used = profile.instances?.length || 0;

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await deleteProfile(profile.id);
      toast.success(`Deleted profile ${profile.name}`);
      onDeleted();
    } catch (e) {
      if (e.status === 409) setBlocked({ message: e.message, instances: e.instances || [], bindings: e.bindings || [] });
      else setError(e.message || 'Could not delete the profile');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Delete profile ${profile.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button variant="danger" onClick={remove} loading={busy}>
              Delete profile
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {!blocked && (
          <p className="text-sm text-muted">
            {used > 0
              ? `${used} device${used === 1 ? ' uses' : 's use'} this profile, so the server will refuse the delete until they are removed.`
              : 'The profile and its tag templates are removed. No device uses it.'}
          </p>
        )}
        {blocked && (
          <Banner variant="error" title="The profile cannot be deleted while it is in use">
            <p>{blocked.message}</p>
            {blocked.instances.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-fg">Devices that use it ({blocked.instances.length}): delete or change them first</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {blocked.instances.map((i) => (
                    <li key={i.id}>
                      <Link className={linkCls} to={`/devices?device=${encodeURIComponent(i.id)}`}>
                        {i.name || i.id}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {blocked.bindings.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-fg">
                  UNS bindings that use it ({blocked.bindings.length}): delete them on the{' '}
                  <Link className={linkCls} to="/tags">
                    Tags page
                  </Link>
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {blocked.bindings.map((b) => (
                    <li key={b.id}>
                      <Link className={linkCls} to="/tags">
                        {b.name || b.id}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Banner>
        )}
        {error && <Banner variant="error">{error}</Banner>}
      </div>
    </Dialog>
  );
}
