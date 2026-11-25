import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * usePolled — load data on mount and (optionally) on an interval, tracking
 * loading and error state so pages can show a skeleton, a visible error with
 * Retry, and keep the last good data while a refresh fails.
 *
 *   const { data, error, loading, reload } = usePolled(() => api.listX(), { interval: 5000 });
 *
 * Hidden tabs do not poll. `deps` re-run the loader (e.g. when a selected id changes).
 *
 * Only the newest load applies: a slow response that resolves after a newer one
 * (an interval tick racing a Retry, or a `deps` change such as switching the
 * selected connection) is dropped instead of overwriting fresher data.
 */
/**
 * Sequence gate for overlapping async loads: `next()` starts a load and returns
 * `isCurrent()`, true only while no newer load has started and the gate has not
 * been invalidated since.
 */
export function latestOnly() {
  let seq = 0;
  return {
    next() {
      const mine = ++seq;
      return () => mine === seq;
    },
    invalidate() {
      seq++;
    }
  };
}

export function usePolled(fetcher, { interval = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetchRef = useRef(fetcher);
  useEffect(() => {
    fetchRef.current = fetcher;
  });
  const [gate] = useState(latestOnly);

  const reload = useCallback(() => {
    const isCurrent = gate.next();
    return Promise.resolve()
      .then(() => fetchRef.current())
      .then((data) => isCurrent() && setState({ data, error: null, loading: false }))
      .catch((error) => isCurrent() && setState((s) => ({ data: s.data, error, loading: false })));
  }, [gate]);

  useEffect(() => {
    reload();
    let t;
    if (interval > 0) {
      t = setInterval(() => {
        if (document.visibilityState === 'visible') reload();
      }, interval);
    }
    return () => {
      gate.invalidate(); // unmount or deps change: drop whatever is still in flight
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass `deps` as a variable-length list, which the rule cannot verify
  }, [interval, reload, gate, ...deps]);

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, reload, setData };
}
