import { useEffect, useId, useState } from 'react';

const CHANNEL = 'manifold-mapping-editor';

/**
 * Is the same mapping open in another tab of this browser? Cheap BroadcastChannel presence: each
 * editor announces itself and answers others; returns the number of other open editors for `id`.
 * No-op where BroadcastChannel is unavailable or for a mapping without an id (a new one).
 */
export function useEditPresence(id) {
  const me = useId();
  const [others, setOthers] = useState(() => new Set());
  useEffect(() => {
    if (!id || typeof BroadcastChannel === 'undefined') return undefined;
    const tab = `${me}-${Math.random().toString(36).slice(2)}`;
    const ch = new BroadcastChannel(CHANNEL);
    const update = (fn) => setOthers((s) => fn(new Set(s)));
    ch.onmessage = (e) => {
      const m = e.data || {};
      if (m.id !== id || m.tab === tab) return;
      if (m.type === 'open') {
        update((s) => s.add(m.tab));
        ch.postMessage({ type: 'here', id, tab });
      } else if (m.type === 'here') update((s) => s.add(m.tab));
      else if (m.type === 'closed')
        update((s) => {
          s.delete(m.tab);
          return s;
        });
    };
    ch.postMessage({ type: 'open', id, tab });
    const bye = () => ch.postMessage({ type: 'closed', id, tab });
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('pagehide', bye);
      bye();
      ch.close();
    };
  }, [id, me]);
  return others.size;
}
