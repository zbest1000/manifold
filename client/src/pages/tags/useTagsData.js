import { useCallback, useEffect, useState } from 'react';
import { fetchSources, fetchBindings, fetchProfiles, fetchHistorians, fetchMigrations } from './tagsApi';

/**
 * The Tags page's loaders: sources, mappings (polled every 5 s while the tab is visible) and the
 * extras (profiles, historians, migratable routes), with their loading and error state.
 */
export function useTagsData() {
  const [sources, setSources] = useState([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesError, setSourcesError] = useState(null);
  const [bindings, setBindings] = useState({ bindings: [], status: {}, health: {}, sparkplug: null });
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [bindingsError, setBindingsError] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [historians, setHistorians] = useState([]);
  const [migrations, setMigrations] = useState([]);
  // The loaders chain promises (rather than async/await) so their setState calls sit in callbacks.
  const loadSources = useCallback(
    () =>
      fetchSources()
        .then((list) => {
          setSources(list);
          setSourcesError(null);
        })
        .catch((e) => setSourcesError(e.message))
        .finally(() => setSourcesLoaded(true)),
    []
  );
  const loadBindings = useCallback(
    () =>
      fetchBindings()
        .then((b) => {
          setBindings(b);
          setBindingsError(null);
        })
        .catch((e) => setBindingsError(e.message))
        .finally(() => setBindingsLoaded(true)),
    []
  );
  // Profiles, historians and migratable routes decorate the page; failures surface where they are needed.
  const loadExtras = useCallback(
    () =>
      Promise.allSettled([fetchProfiles(), fetchHistorians(), fetchMigrations()]).then(([p, h, m]) => {
        if (p.status === 'fulfilled') setProfiles(p.value);
        if (h.status === 'fulfilled') setHistorians(h.value);
        if (m.status === 'fulfilled') setMigrations(m.value.candidates || []);
      }),
    []
  );

  useEffect(() => {
    loadSources();
    loadBindings();
    loadExtras();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') loadBindings();
    }, 5000);
    return () => clearInterval(t);
  }, [loadSources, loadBindings, loadExtras]);
  return { sources, sourcesLoaded, sourcesError, bindings, setBindings, bindingsLoaded, bindingsError, profiles, historians, migrations, loadSources, loadBindings, loadExtras };
}
