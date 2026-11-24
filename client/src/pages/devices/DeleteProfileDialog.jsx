import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal, Button } from '@/components/ui';
import { deleteProfile } from './devicesApi';

/**
 * Delete a profile. The server refuses (409) while device instances or UNS
 * bindings still use it; the dialog then names every blocker with a link.
 */
export default function DeleteProfileDialog({ profile, onClose, onDeleted }) {
  const id = useId();
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
    <Modal title="Delete profile" labelledBy={id} onClose={onClose}>
      <h3 id={id} className="text-base font-semibold text-slate-100">Delete profile {profile.name}?</h3>
      {!blocked && (
        <p className="mt-2 text-sm text-slate-400">
          {used > 0
            ? `${used} device${used === 1 ? ' uses' : 's use'} this profile, so the server will refuse the delete until they are removed.`
            : 'The profile and its tag templates are removed. No device uses it.'}
        </p>
      )}
      {blocked && (
        <div role="alert" className="mt-3 space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          <p className="font-medium">The profile cannot be deleted while it is in use.</p>
          <p className="text-xs text-rose-100/80">{blocked.message}</p>
          {blocked.instances.length > 0 && (
            <div>
              <p className="text-xs font-semibold">Devices that use it ({blocked.instances.length}): delete or change them first</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {blocked.instances.map((i) => (
                  <li key={i.id}><Link className="underline underline-offset-2" to={`/devices?device=${encodeURIComponent(i.id)}`}>{i.name || i.id}</Link></li>
                ))}
              </ul>
            </div>
          )}
          {blocked.bindings.length > 0 && (
            <div>
              <p className="text-xs font-semibold">UNS bindings that use it ({blocked.bindings.length}): delete them on the <Link className="underline underline-offset-2" to="/tags">Tags page</Link></p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {blocked.bindings.map((b) => <li key={b.id}><Link className="underline underline-offset-2" to="/tags">{b.name || b.id}</Link></li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} data-autofocus>{blocked ? 'Close' : 'Cancel'}</Button>
        {!blocked && (
          <Button variant="danger" onClick={remove} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />} Delete profile
          </Button>
        )}
      </div>
    </Modal>
  );
}
