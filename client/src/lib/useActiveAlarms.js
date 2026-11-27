import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { usePolled } from '@/lib/usePolled';

/**
 * The server's active alarms (GET /api/alerts/active), kept fresh: polled every `interval` ms and
 * reloaded (at most once a second) when the server pushes an alert event or a rule state change, and on
 * socket reconnect. `offset` is server clock minus browser clock at the time of the answer, so a duration
 * ticking in the browser stays anchored to the server's `since`.
 */
export function useActiveAlarms({ interval = 10_000 } = {}) {
  const q = usePolled(
    async () => {
      const sent = Date.now();
      const body = await api.activeAlarms();
      const received = Date.now();
      return { ...body, offset: Number.isFinite(body.serverTime) ? body.serverTime - Math.round((sent + received) / 2) : 0 };
    },
    { interval }
  );
  const { reload } = q;
  const pending = useRef(null);
  useEffect(() => {
    const soon = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        reload();
      }, 1000);
    };
    socket.on('alert', soon);
    socket.on('alert-state', soon);
    socket.on('connect', soon);
    return () => {
      socket.off('alert', soon);
      socket.off('alert-state', soon);
      socket.off('connect', soon);
      clearTimeout(pending.current);
      pending.current = null;
    };
  }, [reload]);
  return q;
}

/** A clock that ticks every `ms` while `active` (durations move without refetching). */
export function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
