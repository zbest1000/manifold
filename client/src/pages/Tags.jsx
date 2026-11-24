import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Upload, X, Layers, ListFilter, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import PageHeader from '@/components/PageHeader';
import {
  Button, ButtonLink, EmptyState, HelpButton, Tooltip, Banner, Panel, Card, Tabs, TabPanel, LoadingState, Select, IconButton, StatusText, Kbd
} from '@/components/ui';
import TagTree from './tags/TagTree';
import BindingsTable from './tags/BindingsTable';
import HostStatePanel from './tags/HostStatePanel';
import CsvImport from './tags/CsvImport';
import MappingEditor from './tags/editor/MappingEditor';
import { fetchSources, fetchBindings, saveBinding, removeBinding, fetchProfiles, fetchHistorians } from './tags/tagsApi';
import { buildBoundIndex, groupSources, parseSourceParam, sourceKey } from './tags/helpers';

const NO_SELECTION = new Map();
const clearSelection = () => NO_SELECTION;
const WARNING_LABEL = { 'raw-address': 'Raw address', collision: 'Topic collision', 'asset-path': 'Asset path', 'no-quality': 'No quality', 'credential-like-context': 'Credential-like context', 'no-tags': 'Nothing published' };

/** Does this mapping read from the given source? */
const fromSource = (b, s) => {
  if (!s) return false;
  const src = b.source || {};
  const id = src.type === 'opcua' ? src.connectionId : src.type === 'sparkplug' ? src.brokerId : src.deviceId;
  return src.type === s.type && id === s.id;
};

/**
 * Tags: turn device tags into a namespace. The "Map tags" view is a workspace (source tree on the
 * left, the selection and what already maps this source on the right); "Mappings" lists every
 * mapping with its state. Mappings only read: they monitor and republish, nothing writes to a device.
 * `?source=<type>:<id>` preselects a source (the Devices page links here with device:<id>);
 * `?view=mappings` opens the list.
 */
export default function Tags() {
  const allBrokers = useStore((s) => s.brokers);
  const readOnly = useReadOnly();
  const brokers = useMemo(() => allBrokers.filter((b) => b.status === 'connected'), [allBrokers]);
  const [params, setParams] = useSearchParams();
  const wantedParam = params.get('source');
  const view = params.get('view') === 'mappings' ? 'mappings' : 'map';

  const [sources, setSources] = useState([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesError, setSourcesError] = useState(null);
  // Selected nodes belong to one source: the map is stamped with its source key, so it reads as empty
  // as soon as the source changes (no reset effect needed).
  const [picked, setPicked] = useState({ key: '', nodes: NO_SELECTION });
  const [bindings, setBindings] = useState({ bindings: [], status: {}, sparkplug: null });
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [bindingsError, setBindingsError] = useState(null);
  const [editor, setEditor] = useState(null); // spec for MappingEditor
  const [csvOpen, setCsvOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [historians, setHistorians] = useState([]);
  const [warnings, setWarnings] = useState({ name: '', list: [] }); // non-blocking warnings from the last save
  const [busyId, setBusyId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);

  const wanted = useMemo(() => parseSourceParam(wantedParam), [wantedParam]);
  const source = useMemo(() => (wanted && sources.find((s) => s.type === wanted.type && s.id === wanted.id)) || sources[0] || null, [wanted, sources]);
  const currentKey = sourceKey(source);
  const selection = picked.key === currentKey ? picked.nodes : NO_SELECTION;
  const setSelection = useCallback((update) => setPicked((prev) => ({ key: currentKey, nodes: update(prev.key === currentKey ? prev.nodes : NO_SELECTION) })), [currentKey]);

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
  // Profiles and historians decorate the page; failures surface inside the editor that needs them.
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

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const pickSource = (key) => setParam('source', sources.some((x) => sourceKey(x) === key) ? key : '');
  const setView = (v) => setParam('view', v === 'mappings' ? 'mappings' : '');

  const boundIndex = useMemo(() => buildBoundIndex(bindings.bindings), [bindings.bindings]);

  const toggleTag = useCallback(
    (node) =>
      setSelection((prev) => {
        const next = new Map(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.set(node.id, { id: node.id, address: node.address, name: node.name, meta: node.meta || {} });
        return next;
      }),
    [setSelection]
  );

  // Returns how many nodes were not already selected (counted against the last committed render).
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const addMany = useCallback(
    (nodes) => {
      const fresh = nodes.filter((n) => !selectionRef.current.has(n.id));
      setSelection((prev) => {
        const next = new Map(prev);
        for (const n of nodes) if (!next.has(n.id)) next.set(n.id, { id: n.id, address: n.address, name: n.name, meta: n.meta || {} });
        return next;
      });
      return fresh.length;
    },
    [setSelection]
  );

  const toggleEnabled = async (b) => {
    setBusyId(b.id);
    try {
      const { warnings: _w, ...stored } = b;
      const saved = await saveBinding({ ...stored, enabled: b.enabled === false });
      setWarnings({ name: b.name || '', list: saved?.warnings || [] });
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
      toast.success('Mapping deleted');
      await loadBindings();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const groups = useMemo(() => groupSources(sources), [sources]);
  const selectionList = [...selection.values()];
  const noneSelected = selection.size === 0;
  const mqttSource = source?.type === 'mqtt';
  const mine = useMemo(() => bindings.bindings.filter((b) => fromSource(b, source)), [bindings.bindings, source]);
  const statusOf = bindings.status || {};
  const all = bindings.bindings;
  const publishing = all.filter((b) => b.enabled !== false && statusOf[b.id]?.sourceState?.state === 'online').length;
  const failing = all.filter((b) => b.enabled !== false && statusOf[b.id]?.lastError).length;
  const addLabel = mqttSource ? 'Create pipeline route' : 'Add to UNS';
  const addDisabledReason = readOnly ? READ_ONLY_REASON : noneSelected ? 'Select at least one tag in the tree first' : null;

  const openNew = () => setEditor({ srcType: source.type, source, picked: selectionList, selectMode: 'list' });
  const onSaved = (saved) => {
    const fromSelection = editor && !editor.binding && editor.selectMode === 'list';
    setEditor(null);
    if (fromSelection) setSelection(clearSelection);
    if (saved) {
      setWarnings({ name: saved.name || '', list: saved.warnings || [] });
      setHighlightId(saved.id);
      setView('mappings');
    }
    loadBindings();
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader
        title="Tags"
        subtitle={all.length ? `${all.length} mapping${all.length === 1 ? '' : 's'} · ${publishing} publishing${failing ? ` · ${failing} with errors` : ''}` : 'Map device tags into the namespace'}
        actions={
          <>
            <HelpButton title="Mapping tags into the UNS">
              <p>
                A <b>tag</b> is one data point on a device: a reading, a setpoint, a status. A <b>mapping</b> publishes tags under an asset path in your namespace, with the names, units and context you give them.
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  <b>Devices</b>: tags configured on the Devices page. Map a pick list, or every tag that matches rules (new tags are picked up automatically).
                </li>
                <li>
                  <b>OPC UA</b>: the address space of a connected server. <b>Sparkplug</b>: metrics from BIRTH certificates on a broker.
                </li>
                <li>
                  <b>MQTT topics</b> become a pipeline route, not a mapping.
                </li>
              </ul>
              <p>
                In the editor, the table holds one row per tag: rename, set units and descriptions inline, paste a column from a spreadsheet, or select rows for bulk changes. The preview on the right is the server&apos;s answer: topics, example payloads, the <code>_meta</code> document and warnings.
              </p>
              <p>Mappings only read. Manifold never writes to a device.</p>
              <p className="text-subtle">
                Tree keys: arrows move, Right and Left expand and collapse, <Kbd>Space</Kbd> selects, <Kbd>Enter</Kbd> expands. Editor: <Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> saves.
              </p>
            </HelpButton>
            {profiles.length > 0 && (
              <Button variant="secondary" onClick={() => setEditor({ srcType: 'device-profile', profileId: profiles[0].id })} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                <Layers size={14} aria-hidden="true" /> Map a device profile
              </Button>
            )}
            <Tooltip label={addDisabledReason} side="bottom">
              <Button onClick={openNew} disabled={Boolean(addDisabledReason) || !source} title={addDisabledReason || undefined}>
                <Plus size={14} aria-hidden="true" /> {addLabel}
                {!noneSelected && ` (${selection.size})`}
              </Button>
            </Tooltip>
          </>
        }
      />

      <div className="shrink-0 px-4 sm:px-6">
        <Tabs
          label="Tags views"
          idPrefix="tags-view"
          value={view}
          onChange={setView}
          tabs={[
            { id: 'map', label: 'Map tags' },
            { id: 'mappings', label: 'Mappings', count: bindingsLoaded ? all.length : undefined }
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <ReadOnlyNote className="" />
          {warnings.list.length > 0 && (
            <Banner variant="warn" title={`Saved ${warnings.name || 'the mapping'} with ${warnings.list.length} warning${warnings.list.length === 1 ? '' : 's'}`} onDismiss={() => setWarnings({ name: '', list: [] })}>
              <ul className="mt-1 space-y-0.5">
                {warnings.list.slice(0, 6).map((w, i) => (
                  <li key={`${w.type}-${i}`}>
                    <span className="font-medium text-fg">{WARNING_LABEL[w.type] || w.type}:</span> {w.message}
                  </li>
                ))}
                {warnings.list.length > 6 && <li>and {warnings.list.length - 6} more.</li>}
              </ul>
            </Banner>
          )}

          <TabPanel idPrefix="tags-view" id="map" className={view === 'map' ? 'space-y-4' : 'hidden'}>
            {view === 'map' && (
            <>
              {sourcesError && (
                <Banner variant="error" title="Could not load the list of sources" onRetry={loadSources}>
                  {sourcesError}
                </Banner>
              )}
              {wantedMissing && (
                <Banner variant="warn" title="That source is not connected">
                  The link names <span className="mono">{wantedParam}</span>, which is not online right now. Showing another source; check that the device or connection is up.
                </Banner>
              )}
              {!source ? (
                sourcesLoaded ? (
                  !sourcesError && (
                    <Card>
                      <EmptyState
                        title="No sources connected"
                        hint="Tags come from live connections. Add a device, connect an OPC UA server, or connect a broker (Sparkplug devices appear automatically)."
                        action={
                          <div className="flex flex-wrap justify-center gap-2">
                            <ButtonLink to="/devices" variant="secondary">
                              Devices
                            </ButtonLink>
                            <ButtonLink to="/opcua" variant="secondary">
                              OPC UA
                            </ButtonLink>
                            <ButtonLink to="/brokers" variant="secondary">
                              Brokers
                            </ButtonLink>
                          </div>
                        }
                      />
                    </Card>
                  )
                ) : (
                  <LoadingState label="sources" rows={3} />
                )
              ) : (
                <div className="grid min-w-0 gap-4 lg:h-[calc(100dvh-12.5rem)] lg:min-h-[30rem] lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <section aria-label="Tag browser" className="flex h-[32rem] min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel lg:h-auto">
                    <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
                      <Select label="Source" id="tag-source" fieldClassName="min-w-0 flex-1 basis-60" value={sourceKey(source)} onChange={(e) => pickSource(e.target.value)} disabled={sources.length === 0}>
                        {groups.map((g) => (
                          <optgroup key={g.type} label={g.label}>
                            {g.items.map((s) => (
                              <option key={sourceKey(s)} value={sourceKey(s)}>
                                {s.label}
                                {s.state && s.state !== 'online' ? ` (${s.state})` : ''}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </Select>
                      {source.type === 'opcua' && (
                        <Button variant="secondary" onClick={() => setCsvOpen(true)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                          <Upload size={14} aria-hidden="true" /> Import CSV
                        </Button>
                      )}
                    </div>
                    <TagTree key={sourceKey(source)} source={source} selection={selection} onToggle={toggleTag} onAddMany={addMany} boundIndex={boundIndex} />
                  </section>

                  <aside aria-label="Selection and existing mappings" className="flex min-w-0 flex-col gap-4 lg:overflow-y-auto">
                    {mqttSource && (
                      <Banner variant="info" title="MQTT topics are mapped with a pipeline route, not a binding">
                        A route re-publishes the topics under your path, without deadband, heartbeat, per-tag names or units, Sparkplug output or direct history, and it is listed under{' '}
                        <Link to="/pipelines" className="text-accent-text underline">
                          Pipelines, Routes
                        </Link>
                        . For those features, map tags from a device, OPC UA or Sparkplug source.
                      </Banner>
                    )}
                    <Panel
                      title={<span id="selection-heading">Selected tags</span>}
                      count={<span aria-live="polite">{selection.size}</span>}
                      actions={
                        !noneSelected && (
                          <Button size="sm" variant="ghost" onClick={() => setSelection(clearSelection)}>
                            Clear
                          </Button>
                        )
                      }
                      flush
                    >
                      {noneSelected ? (
                        <p className="px-4 py-3 text-sm text-muted">Tick tags in the tree, or use Select all on a folder, then {addLabel.toLowerCase()}.</p>
                      ) : (
                        <ul className="max-h-60 divide-y divide-line overflow-y-auto" aria-labelledby="selection-heading">
                          {selectionList.map((t) => (
                            <li key={t.id} className="flex h-8 items-center justify-between gap-2 pl-4 pr-1">
                              <span className="min-w-0 truncate font-mono text-xs text-fg" title={t.address}>
                                {t.name}
                              </span>
                              <IconButton
                                icon={X}
                                size={12}
                                className="h-6 w-6"
                                label={`Remove ${t.name} from selection`}
                                onClick={() =>
                                  setSelection((p) => {
                                    const n = new Map(p);
                                    n.delete(t.id);
                                    return n;
                                  })
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </Panel>

                    {source.type === 'device' && (
                      <Card className="p-4">
                        <p className="text-sm font-medium text-fg">Every tag of this device</p>
                        <p className="mt-0.5 text-xs text-subtle">Map all tags, or those matching include and exclude rules. Tags added to the device later are picked up when they match.</p>
                        <Button size="sm" variant="secondary" className="mt-3" disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} onClick={() => setEditor({ srcType: 'device', source, selectMode: 'rules' })}>
                          <ListFilter size={12} aria-hidden="true" /> Map by rule
                        </Button>
                      </Card>
                    )}

                    {!mqttSource && (
                      <Panel title="Mappings of this source" count={mine.length} flush>
                        {mine.length === 0 ? (
                          <p className="px-4 py-3 text-sm text-muted">Nothing from this source is mapped yet.</p>
                        ) : (
                          <ul className="divide-y divide-line">
                            {mine.map((b) => {
                              const s = statusOf[b.id] || {};
                              const label = b.name || b.id.slice(0, 8);
                              return (
                                <li key={b.id} className="flex items-center gap-2 py-1.5 pl-4 pr-1">
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-fg">{label}</span>
                                    {b.enabled === false ? (
                                      <StatusText tone="neutral" className="text-xs">
                                        Disabled
                                      </StatusText>
                                    ) : (
                                      <StatusText tone={s.lastError ? 'bad' : s.sourceState?.state === 'online' ? 'good' : 'neutral'} className="text-xs">
                                        {s.lastError ? 'Error' : s.sourceState?.state === 'online' ? 'Publishing' : 'Waiting'}
                                      </StatusText>
                                    )}
                                  </span>
                                  <IconButton icon={Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} mapping ${label}`} onClick={() => setEditor({ binding: b })} />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </Panel>
                    )}

                    <Card className="p-4">
                      <HostStatePanel brokers={brokers} hosts={bindings.sparkplug?.hosts || {}} onStatus={(sparkplug) => setBindings((prev) => ({ ...prev, sparkplug }))} />
                    </Card>
                  </aside>
                </div>
              )}
            </>
            )}
          </TabPanel>
          <TabPanel idPrefix="tags-view" id="mappings" className={view === 'mappings' ? 'space-y-4' : 'hidden'}>
            {view === 'mappings' && (
            <>
              {bindingsError && (
                <Banner variant="error" title="Could not load mappings" onRetry={loadBindings}>
                  {bindingsError}
                </Banner>
              )}
              {!bindingsLoaded && !bindingsError ? (
                <LoadingState label="mappings" rows={3} />
              ) : all.length === 0 ? (
                !bindingsError && (
                  <Card>
                    <EmptyState
                      title="No mappings yet"
                      hint="A mapping publishes device tags under an asset path in your namespace. Pick a source, tick tags in the tree, then add them to the UNS."
                      action={
                        <Button variant="secondary" onClick={() => setView('map')}>
                          Map tags
                        </Button>
                      }
                    />
                  </Card>
                )
              ) : (
                <BindingsTable
                  bindings={all}
                  status={statusOf}
                  sources={sources}
                  profiles={profiles}
                  historians={historians}
                  editingId={editor?.binding?.id}
                  highlightId={highlightId}
                  busyId={busyId}
                  onEdit={(b) => setEditor({ binding: b })}
                  onToggleEnabled={toggleEnabled}
                  onDelete={deleteBinding}
                  readOnly={readOnly}
                />
              )}
            </>
            )}
          </TabPanel>
      </div>

      {editor && (
        <MappingEditor
          key={editor.binding?.id || `${editor.srcType}-${editor.selectMode || ''}`}
          spec={editor}
          brokers={brokers}
          profiles={profiles}
          sources={sources}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      )}
      {csvOpen && source?.type === 'opcua' && (
        <CsvImport
          onClose={() => setCsvOpen(false)}
          onImport={(tags) => {
            const nodes = tags.map((t) => ({ id: t.address, address: t.address, name: t.name, meta: {} }));
            addMany(nodes);
            setCsvOpen(false);
            const merged = new Map(selection);
            for (const n of nodes) if (!merged.has(n.id)) merged.set(n.id, n);
            setEditor({ srcType: 'opcua', source, picked: [...merged.values()], selectMode: 'list' });
          }}
        />
      )}
    </div>
  );
}
