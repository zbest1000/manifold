import { useEffect } from 'react';
import { socket } from '@/lib/socket';

/** Live engine metrics pushed by the server every 2s over the shared socket. */
export function useEngineMetrics(onMetrics) {
  useEffect(() => {
    socket.on('engine-metrics', onMetrics);
    return () => socket.off('engine-metrics', onMetrics);
  }, [onMetrics]);
}
