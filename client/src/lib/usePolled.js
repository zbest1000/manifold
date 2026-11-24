import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * usePolled — load data on mount and (optionally) on an interval, tracking
 * loading and error state so pages can show a skeleton, a visible error with
 * Retry, and keep the last good data while a refresh fails.
 *
 *   const { data, error, loading, reload } = usePolled(() => api.listX(), { interval: 5000 });
 *
 * Hidden tabs do not poll. `deps` re-run the loader (e.g. when a selected id changes).
 */
export function usePolled(fetcher, { interval = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetchRef = useRef(fetcher);
  useEffect(() => {
    fetchRef.current = fetcher;
  });
  const alive = useRef(true);

  const reload = useCallback(() => {
    return Promise.resolve()
      .then(() => fetchRef.current())
      .then((data) => alive.current && setState({ data, error: null, loading: false }))
      .catch((error) => alive.current && setState((s) => ({ data: s.data, error, loading: false })));
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    let t;
    if (interval > 0) {
      t = setInterval(() => {
        if (document.visibilityState === 'visible') reload();
      }, interval);
    }
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass `deps` as a variable-length list, which the rule cannot verify
  }, [interval, reload, ...deps]);

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, reload, setData };
}
