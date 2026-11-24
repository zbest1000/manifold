import { useEffect, useState } from 'react';
import { useStore, onMessageActivity } from '@/store/store';
import { createRateWindow, sumBrokerCounter } from './rateWindow';

/**
 * Live message rate (msgs/s) for the brokers in `ids` (all when null), driven by
 * the server's exact `messagesReceived` counter over a sliding window; falls back
 * to counting bus events over the same window when the counter is unavailable.
 * Publishes at most once a second and does nothing while the tab is hidden.
 */
export default function useIngestRate(ids = null, windowMs = 10_000) {
  const [rate, setRate] = useState(0);
  const key = ids ? ids.join('|') : '*';
  useEffect(() => {
    const scope = ids;
    const server = createRateWindow(windowMs);
    const bus = createRateWindow(windowMs);
    let busCount = 0;
    const sample = () => {
      const c = sumBrokerCounter(useStore.getState().brokers, scope);
      if (c != null) server.push(Date.now(), c);
    };
    sample();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.brokers !== prev.brokers) sample();
    });
    const off = onMessageActivity(() => {
      busCount++;
    });
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      bus.push(Date.now(), busCount);
      const r = server.rate() ?? bus.rate() ?? 0;
      setRate((prev) => (Math.abs(prev - r) < 0.05 ? prev : r));
    }, 1000);
    return () => {
      unsub();
      off?.();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, windowMs]);
  return rate;
}
