import { useEffect, useMemo, useState } from 'react';
import { previewBinding } from './tagsApi';

/**
 * Debounced server-side preview of a binding draft. status: 'idle' | 'loading' | 'ok' | 'error'.
 * While a request is in flight (or after a failure) callers fall back to the pure client helpers.
 * `data` is only kept for the exact draft it answers.
 */
export function usePreview(draft, enabled, delay = 350) {
  const key = useMemo(() => (enabled && draft ? JSON.stringify(draft) : null), [draft, enabled]);
  const [state, setState] = useState({ key: null, status: 'idle', data: null, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await previewBinding(JSON.parse(key), ctrl.signal);
        if (!ctrl.signal.aborted) setState({ key, status: 'ok', data, error: null });
      } catch (e) {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setState({ key, status: 'error', data: null, error: e.message });
      }
    }, delay);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key, nonce, delay]);

  const current = key !== null && state.key === key;
  const status = key === null ? 'idle' : current ? state.status : 'loading';
  return {
    status,
    data: current && status === 'ok' ? state.data : null,
    error: current ? state.error : null,
    retry: () => {
      setState({ key: null, status: 'idle', data: null, error: null });
      setNonce((n) => n + 1);
    }
  };
}
