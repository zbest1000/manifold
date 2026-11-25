import { useEffect, useState } from 'react';
import { socket } from '@/lib/socket';
import { api } from '@/lib/api';
import { looksLikeTvq } from './helpers';

/** Live engine metrics pushed by the server every 2s over the shared socket. */
export function useEngineMetrics(onMetrics) {
  useEffect(() => {
    socket.on('engine-metrics', onMetrics);
    return () => socket.off('engine-metrics', onMetrics);
  }, [onMetrics]);
}

/**
 * While a route writes to a historian, look at the latest payloads its source filter matches (a dry run
 * with no transforms) and report a topic whose payload looks like a TVQ envelope, or null. The result is
 * stamped with the filter it answers so a stale answer is never shown for a changed filter.
 */
export function useTvqSample({ brokerId, filter, enabled }) {
  const [found, setFound] = useState({ key: '', topic: null });
  const key = `${brokerId}|${filter}`;
  useEffect(() => {
    if (!enabled || !brokerId || !filter) return undefined;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .previewPipeline({ source: { brokerId, filter }, transforms: [], target: { type: 'historian', historianId: 'preview' } }, 20)
        .then((r) => !stale && setFound({ key, topic: (r.rows || []).find((row) => looksLikeTvq(row.inPayload))?.inTopic || null }))
        .catch(() => !stale && setFound({ key, topic: null })); // a hint only: failures stay silent
    }, 500);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [enabled, brokerId, filter, key]);
  return enabled && found.key === key ? found.topic : null;
}
