import { useEffect, useRef } from 'react';
import { saveBinding } from '../tagsApi';
import { isStale } from './staleEdit';

/**
 * Saving a mapping: validate what is on screen, wait for the server check of the latest edit when
 * it is still running (then save on its answer), refuse-as-stale opens the conflict dialog, and
 * Ctrl/Cmd+S saves while the editor is open. Returns { save, submit(body) }.
 */
export function useSaveFlow({ current, validate, draft, preview, busy, readOnly, saveQueued, setSaveQueued, setBusy, setAttempted, setSaveError, setNotice, setConflict, jumpTo, onSaved }) {
  const submit = async (body) => {
    setBusy(true);
    try {
      const saved = await saveBinding(body);
      setConflict(null);
      onSaved(saved);
    } catch (e) {
      // Someone saved after this editor loaded: the edits stay here whatever the user picks.
      if (isStale(e)) setConflict({ mine: body, theirs: e.body.current || null });
      else setSaveError(e.message);
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || readOnly) return;
    setAttempted(true);
    setSaveError(null);
    // Save what is on screen now, not the deferred copy the preview follows.
    const body = current();
    const liveErrors = validate();
    if (liveErrors.length) {
      jumpTo(liveErrors[0]);
      return;
    }
    if (preview.status !== 'ok' || JSON.stringify(body) !== JSON.stringify(draft)) {
      // The server is still checking the latest edit: save as soon as it has answered.
      if (preview.status === 'error') setNotice('The server check failed. Retry it in the preview before saving.');
      else {
        setNotice('Saving once the server has checked the latest change…');
        setSaveQueued(true);
      }
      return;
    }
    await submit(body);
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  // A save asked for while the check was running goes ahead once the check answered (or stops on a refusal).
  const checked = saveQueued && preview.status === 'ok' && JSON.stringify(draft) === JSON.stringify(current());
  useEffect(() => {
    if (!saveQueued || (!checked && preview.status !== 'error')) return;
    queueMicrotask(() => {
      setSaveQueued(false);
      if (checked) saveRef.current();
    });
  }, [saveQueued, checked, preview.status, setSaveQueued]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { save, submit };
}
