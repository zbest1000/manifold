import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Tags as TagsIcon, Plus, Upload, X, Trash2, Layers } from 'lucide-react';
import { useStore } from '@/store/store';
import PageHeader from '@/components/PageHeader';
import { Card, Button, EmptyState, HelpButton, Tooltip } from '@/components/ui';
import TagTree from './tags/TagTree';
import BindWizard from './tags/BindWizard';
import BindingsTable from './tags/BindingsTable';
import HostStatePanel from './tags/HostStatePanel';
import CsvImport from './tags/CsvImport';
import ErrorBanner, { InfoBanner, WarningsBanner } from './tags/Banner';
import { fetchSources, fetchBindings, saveBinding, removeBinding, fetchProfiles, fetchHistorians } from './tags/tagsApi';
import { buildBoundIndex, groupSources, parseSourceParam, sourceKey } from './tags/helpers';
import { SELECT_CLS } from './tags/wizardModel';
import toast from 'react-hot-toast';

const NO_SELECTION = new Map();
const clearSelection = () => NO_SELECTION;

/**
 * Tags: browse device tags across the drivers Manifold speaks (OPC UA, Sparkplug,
 * MQTT topics, devices), select them, and bind them into the UNS.
 * Bindings are read-only by design: they monitor and republish; nothing writes to a device.
 * `?source=<type>:<id>` preselects a source (the Devices page links here with device:<id>).
 */
export default function Tags() {
  const allBrokers = useStore((s) => s.brokers);
  const brokers = useMemo(() => allBrokers.filter((b) => b.status === 'connected'), [allBrokers]);
  const [params, setParams] = useSearchParams();
  const wantedParam = params.get('source');

  const [sources, setSources] = useState([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesError, setSourcesError] = useState(null);
  // Selected nodes belong to one source: the map is stamped with its source key, so it reads as empty
  // as soon as the source changes (no reset effect needed).
  const [picked, setPicked] = useState({ key: '', nodes: NO_SELECTION }); // nodes: node id -> { id, address, name, meta }
  const [bindings, setBindings] = useState({ bindings: [], status: {}, sparkplug: null });
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [bindingsError, setBindingsError] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingBinding, setEditingBinding] = useState(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [historians, setHistorians] = useState([]);
  const [warnings, setWarnings] = useState([]); // non-blocking warnings from the last save
  const [busyId, setBusyId] = useState(null);

  // The source in use is derived: the one the URL names (the picker writes its choice there, and a link
  // to ?source= while the page is open re-targets it), else the first one.
  const wanted = useMemo(() => parseSourceParam(wantedParam), [wantedParam]);
  const source = useMemo(
    () => (wanted && sources.find((s) => s.type === wanted.type && s.id === wanted.id)) || sources[0] || null,
    [wanted, sources]
  );
  const currentKey = sourceKey(source);
  const selection = picked.key === currentKey ? picked.nodes : NO_SELECTION;
  const setSelection = useCallback(
    (update) => setPicked((prev) => ({ key: currentKey, nodes: update(prev.key === currentKey ? prev.nodes : NO_SELECTION) })),
    [currentKey]
  );

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

  // Profiles and historians only decorate the page (entry point, table columns); failures stay quiet here and
  // surface, with a Retry, inside the wizard that actually needs them.
  const loadExtras = useCallback(
    () =>
      Promise.allSettled([fetchProfiles(), fetchHistorians()]).then(([p, h]) => {
        if (p.status === 'fulfilled') setProfiles(p.value);
        if (h.status === 'fulfilled') setHistorians(h.value);
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

  const wantedMissing = Boolean(wantedParam) && sourcesLoaded && !sourcesError && !sources.some((s) => sourceKey(s) === wantedParam);

  const pickSource = (key) => {
    const s = sources.find((x) => sourceKey(x) === key) || null;
    const next = new URLSearchParams(params);
    if (s) next.set('source', sourceKey(s));
    else next.delete('source');
    setParams(next, { replace: true });
  };

  const boundIndex = useMemo(() => buildBoundIndex(bindings.bindings), [bindings.bindings]);

  const toggleTag = useCallback(
    (node) => {
      setSelection((prev) => {
        const next = new Map(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.set(node.id, { id: node.id, address: node.address, name: node.name, meta: node.meta || {} });
        return next;
      });
    },
    [setSelection]
  );

  // Returns how many nodes were not already selected (count is from the last committed render).
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const addMany = useCallback(
    (nodes) => {
      const fresh = nodes.filter((n) => !selectionRef.current.has(n.id));
      setSelection((prev) => {
        const next = new Map(prev);
        for (const n of nodes) {
          if (!next.has(n.id)) next.set(n.id, { id: n.id, address: n.address, name: n.name, meta: n.meta || {} });
        }
        return next;
      });
      return fresh.length;
    },
    [setSelection]
  );

  const toggleEnabled = async (b) => {
    setBusyId(b.id);
    try {
      const saved = await saveBinding({ id: b.id, name: b.name || null, enabled: b.enabled === false, source: b.source, target: b.target, ...(b.rbe ? { rbe: b.rbe } : {}) });
      setWarnings(saved?.warnings || []);
      await loadBindings();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const deleteBinding = async (b) => {
    setBusyId(b.id);
    try {
      await removeBinding(b.id);
      toast.success('Binding deleted');
      await loadBindings();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const groups = useMemo(() => groupSources(sources), [sources]);
  const noneSelected = selection.size === 0;
  const selectionList = [...selection.values()];

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader
        title="Tags"
        subtitle="Browse tags from devices, OPC UA and Sparkplug, and map them into the UNS."
        actions={
          <HelpButton title="What are Tags, and where do they come from?">
            <p>
              A <b>tag</b> is one named data point on a device, such as a sensor reading, a setpoint, or a status. This page browses the
              tags Manifold can already see, so you can bind them into your Unified Namespace.
            </p>
            <p>The <b>Source</b> picker chooses where the tags come from.</p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li><b>Devices</b>: drivers added on the Devices page. Browse their configured tags.</li>
              <li><b>OPC UA</b>: the address space of a connected OPC UA server. Connect one under <b>OPC UA</b> first.</li>
              <li><b>Sparkplug</b>: metrics of devices seen in a broker&apos;s Sparkplug B traffic, learned from BIRTH certificates.</li>
              <li><b>MQTT</b>: the plain topic tree observed on a broker, treated as tags.</li>
            </ul>
            <p>
              Tick tags, then press <b>Add to UNS</b>. Manifold monitors them and republishes into your namespace as an envelope
              (value, time, quality), a plain value, or a Sparkplug B device. Bindings are <b>read-only toward devices</b>.
            </p>
            <p className="text-slate-400">
              Keyboard: arrow keys move through the tree, Right and Left expand and collapse, Space selects, Enter expands.
            </p>
          </HelpButton>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {sourcesError && <ErrorBanner title="Could not load the list of sources" message={sourcesError} onRetry={loadSources} />}
        <WarningsBanner warnings={warnings} onDismiss={() => setWarnings([])} />
        {wantedMissing && (
          <InfoBanner>
            The source <span className="font-mono">{wantedParam}</span> from the link is not connected right now. Showing another source;
            check that the device or connection is online.
          </InfoBanner>
        )}

        {/* Toolbar */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor="tag-source" className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Source</label>
            <select
              id="tag-source"
              value={sourceKey(source)}
              onChange={(e) => pickSource(e.target.value)}
              disabled={sources.length === 0}
              className={SELECT_CLS}
            >
              {sources.length === 0 && <option value="">{sourcesLoaded ? 'no browsable sources' : 'loading sources...'}</option>}
              {groups.map((g) => (
                <optgroup key={g.type} label={g.label}>
                  {g.items.map((s) => (
                    <option key={sourceKey(s)} value={sourceKey(s)}>{s.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {source?.type === 'opcua' && (
              <Button variant="outline" onClick={() => setCsvOpen(true)}>
                <Upload size={14} aria-hidden="true" /> Import CSV
              </Button>
            )}
            {profiles.length > 0 && (
              <Button variant="outline" onClick={() => setProfileOpen(true)}>
                <Layers size={14} aria-hidden="true" /> Map a device profile
              </Button>
            )}
            <Tooltip label={noneSelected ? 'Select at least one tag in the tree first' : undefined}>
              <Button
                onClick={() => setWizardOpen(true)}
                disabled={noneSelected}
                title={noneSelected ? 'Select at least one tag in the tree first' : undefined}
              >
                <Plus size={14} aria-hidden="true" /> Add to UNS{!noneSelected && ` (${selection.size})`}
              </Button>
            </Tooltip>
          </div>
        </div>

        {/* Browse + selection */}
        {!source ? (
          sourcesLoaded && !sourcesError ? (
            <Card className="p-4">
              <div className="min-h-[16rem]">
                <EmptyState
                  icon={TagsIcon}
                  title="No sources connected"
                  hint="Tags are discovered from live connections. Connect a broker (Sparkplug devices appear automatically), an OPC UA server, or add a device."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Link to="/brokers" className="rounded-xl border border-white/10 px-3 py-1.5 text-sm text-slate-100 hover:bg-white/5">Brokers</Link>
                      <Link to="/opcua" className="rounded-xl border border-white/10 px-3 py-1.5 text-sm text-slate-100 hover:bg-white/5">OPC UA</Link>
                      <Link to="/devices" className="rounded-xl border border-white/10 px-3 py-1.5 text-sm text-slate-100 hover:bg-white/5">Devices</Link>
                    </div>
                  }
                />
              </div>
            </Card>
          ) : null
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Card className="flex h-[30rem] min-w-0 flex-col p-3 lg:h-[36rem]">
              <TagTree
                key={sourceKey(source)}
                source={source}
                selection={selection}
                onToggle={toggleTag}
                onAddMany={addMany}
                boundIndex={boundIndex}
              />
            </Card>

            <aside aria-label="Selection and advanced settings" className="flex min-w-0 flex-col gap-3">
              <Card className="p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Selected tags <span aria-live="polite" className="text-slate-100">({selection.size})</span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => setSelection(clearSelection)}
                    disabled={noneSelected}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
                  >
                    <Trash2 size={11} aria-hidden="true" /> Clear selection
                  </button>
                </div>
                {noneSelected && <p className="text-xs text-slate-400">Tick tags in the tree, or use Select all on a folder, then choose Add to UNS.</p>}
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                  {selectionList.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 rounded bg-black/20 px-2 py-1 text-xs">
                      <span className="min-w-0 truncate font-mono text-slate-200" title={t.address}>{t.name}</span>
                      <button
                        type="button"
                        onClick={() => setSelection((p) => { const n = new Map(p); n.delete(t.id); return n; })}
                        aria-label={`Remove ${t.name} from selection`}
                        className="shrink-0 rounded p-0.5 text-slate-300 hover:text-rose-300"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
              <HostStatePanel
                brokers={brokers}
                hosts={bindings.sparkplug?.hosts || {}}
                onStatus={(sparkplug) => setBindings((prev) => ({ ...prev, sparkplug }))}
              />
            </aside>
          </div>
        )}

        {/* Bindings */}
        <section aria-labelledby="bindings-heading" className="min-w-0 space-y-2">
          <h2 id="bindings-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Bindings {bindingsLoaded && `(${bindings.bindings.length})`}
          </h2>
          {bindingsError && <ErrorBanner title="Could not load bindings" message={bindingsError} onRetry={loadBindings} />}
          {bindingsLoaded && !bindingsError && bindings.bindings.length === 0 && (
            <Card className="p-4">
              <p className="text-sm font-medium text-slate-200">No bindings yet</p>
              <p className="mt-1 text-xs text-slate-400">
                A binding publishes selected tags into the UNS. Pick a source, tick tags in the tree, then choose Add to UNS.
              </p>
            </Card>
          )}
          {bindings.bindings.length > 0 && (
            <BindingsTable
              bindings={bindings.bindings}
              status={bindings.status || {}}
              sources={sources}
              profiles={profiles}
              historians={historians}
              editingId={editingBinding?.id}
              busyId={busyId}
              onEdit={setEditingBinding}
              onToggleEnabled={toggleEnabled}
              onDelete={deleteBinding}
            />
          )}
        </section>
      </div>

      {wizardOpen && source && (
        <BindWizard
          source={source}
          selection={selection}
          brokers={brokers}
          onClose={() => setWizardOpen(false)}
          onDone={(saved) => {
            setWizardOpen(false);
            setSelection(clearSelection);
            setWarnings(saved?.warnings || []);
            loadBindings();
          }}
        />
      )}
      {profileOpen && (
        <BindWizard
          profileMode
          profiles={profiles}
          brokers={brokers}
          onClose={() => setProfileOpen(false)}
          onDone={(saved) => {
            setProfileOpen(false);
            setWarnings(saved?.warnings || []);
            loadBindings();
          }}
        />
      )}
      {editingBinding && (
        <BindWizard
          editing={editingBinding}
          source={source}
          selection={selection}
          brokers={brokers}
          profiles={profiles}
          onClose={() => setEditingBinding(null)}
          onDone={(saved) => {
            setEditingBinding(null);
            setWarnings(saved?.warnings || []);
            loadBindings();
          }}
        />
      )}
      {csvOpen && source?.type === 'opcua' && (
        <CsvImport
          onClose={() => setCsvOpen(false)}
          onImport={(tags) => {
            addMany(tags.map((t) => ({ id: t.address, address: t.address, name: t.name, meta: {} })));
            setCsvOpen(false);
            setWizardOpen(true);
          }}
        />
      )}
    </div>
  );
}
