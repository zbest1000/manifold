import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Layers, Eraser } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import PageHeader from '@/components/PageHeader';
import { Button, EmptyState, Tooltip, Banner, Card, Tabs, TabPanel, LoadingState } from '@/components/ui';
import BindingsTable from './tags/BindingsTable';
import MapWorkspace from './tags/MapWorkspace';
import MigrationReview, { MigrationBanner } from './tags/MigrationReview';
import RetainedCleanup from './tags/RetainedCleanup';
import MappingEditor from './tags/editor/MappingEditor';
import TagsHelp from './tags/TagsHelp';
import { saveBinding, removeBinding } from './tags/tagsApi';
import { useTagsData } from './tags/useTagsData';
import { healthFallback, WARNING_LABEL } from './tags/bindingHealthView';
import { buildBoundIndex, groupSources, parseSourceParam, sourceKey } from './tags/helpers';

const NO_SELECTION = new Map();

/** Does this mapping read from the given source? */
const fromSource = (b, s) => {
  if (!s) return false;
  const src = b.source || {};
  const id = src.type === 'opcua' ? src.connectionId : src.type === 'sparkplug' || src.type === 'mqtt' ? src.brokerId : src.deviceId;
  return src.type === s.type && id === s.id;
};
const asNode = (n) => ({ id: n.id, address: n.address, name: n.name, meta: n.meta || {} });

/**
 * Tags: turn device tags and MQTT topics into a namespace. "Map tags" is a workspace (source tree,
 * selection, what already maps the source); "Mappings" lists every mapping with why it publishes
 * or not. Mappings only read: they monitor and republish, nothing writes to a device.
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

  // Selected nodes belong to one source: the map is stamped with its source key, so it reads as empty
  // as soon as the source changes (no reset effect needed).
  const { sources, sourcesLoaded, sourcesError, bindings, setBindings, bindingsLoaded, bindingsError, profiles, historians, migrations, loadSources, loadBindings, loadExtras } = useTagsData();
  const [picked, setPicked] = useState({ key: '', nodes: NO_SELECTION });
  const [editor, setEditor] = useState(null); // spec for MappingEditor
  const [dialog, setDialog] = useState(null); // 'migrate' | 'cleanup'
  const [warnings, setWarnings] = useState({ name: '', list: [] }); // non-blocking warnings from the last save
  const [busyId, setBusyId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);

  const wanted = useMemo(() => parseSourceParam(wantedParam), [wantedParam]);
  const source = useMemo(() => (wanted && sources.find((s) => s.type === wanted.type && s.id === wanted.id)) || sources[0] || null, [wanted, sources]);
  const currentKey = sourceKey(source);
  const selection = picked.key === currentKey ? picked.nodes : NO_SELECTION;
  const setSelection = useCallback((update) => setPicked((prev) => ({ key: currentKey, nodes: update(prev.key === currentKey ? prev.nodes : NO_SELECTION) })), [currentKey]);


  const wantedMissing = Boolean(wantedParam) && sourcesLoaded && !sourcesError && !sources.some((s) => sourceKey(s) === wantedParam);
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const setView = (v) => setParam('view', v === 'mappings' ? 'mappings' : '');

  const toggleTag = useCallback(
    (node) =>
      setSelection((prev) => {
        const next = new Map(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.set(node.id, asNode(node));
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
        for (const n of nodes) if (!next.has(n.id)) next.set(n.id, asNode(n));
        return next;
      });
      return fresh.length;
    },
    [setSelection]
  );

  const withBusy = async (b, fn) => {
    setBusyId(b.id);
    try {
      await fn();
      await loadBindings();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };
  const toggleEnabled = (b) =>
    withBusy(b, async () => {
      const { warnings: _w, ...stored } = b;
      const saved = await saveBinding({ ...stored, enabled: b.enabled === false });
      setWarnings({ name: b.name || '', list: saved?.warnings || [] });
    });
  const deleteBinding = (b) =>
    withBusy(b, async () => {
      await removeBinding(b.id);
      toast.success('Mapping deleted');
    });

  const all = bindings.bindings;
  const statusOf = bindings.status || {};
  const health = useMemo(() => Object.fromEntries(all.map((b) => [b.id, healthFallback(b, bindings.status || {}, bindings.health || {})])), [all, bindings.status, bindings.health]);
  const publishing = all.filter((b) => health[b.id]?.state === 'publishing').length;
  const failing = all.filter((b) => ['problem', 'source-missing'].includes(health[b.id]?.state)).length;
  const groups = useMemo(() => groupSources(sources), [sources]);
  const mine = useMemo(() => all.filter((b) => fromSource(b, source)), [all, source]);
  const boundIndex = useMemo(() => buildBoundIndex(all), [all]);
  const noneSelected = selection.size === 0;
  const addLabel = 'Add to UNS';
  const addDisabledReason = readOnly ? READ_ONLY_REASON : noneSelected ? 'Select at least one tag in the tree first' : null;

  const openNew = () => setEditor({ srcType: source.type, source, picked: [...selection.values()], selectMode: 'list' });
  const onSaved = (saved) => {
    const fromSelection = editor && !editor.binding && editor.selectMode === 'list';
    setEditor(null);
    if (fromSelection) setSelection(() => NO_SELECTION);
    if (saved) {
      setWarnings({ name: saved.name || '', list: saved.warnings || [] });
      setHighlightId(saved.id);
      setView('mappings');
    }
    loadBindings();
  };
  const page = {
    sources, sourcesLoaded, sourcesError, loadSources, wantedParam, wantedMissing, source, groups, boundIndex, mine, health, brokers,
    pickSource: (key) => setParam('source', sources.some((x) => sourceKey(x) === key) ? key : ''),
    sparkplug: bindings.sparkplug,
    onSparkplug: (sparkplug) => setBindings((prev) => ({ ...prev, sparkplug }))
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader
        title="Tags"
        subtitle={all.length ? `${all.length} mapping${all.length === 1 ? '' : 's'} · ${publishing} publishing${failing ? ` · ${failing} not publishing` : ''}` : 'Map device tags and topics into the namespace'}
        actions={
          <>
            <TagsHelp />
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
        {migrations.length > 0 && <MigrationBanner count={migrations.length} onReview={() => setDialog('migrate')} />}

        <TabPanel idPrefix="tags-view" id="map" className={view === 'map' ? 'space-y-4' : 'hidden'}>
          {view === 'map' && <MapWorkspace page={page} selection={selection} setSelection={setSelection} onToggle={toggleTag} onAddMany={addMany} onEdit={setEditor} readOnly={readOnly} addLabel={addLabel} />}
        </TabPanel>
        <TabPanel idPrefix="tags-view" id="mappings" className={view === 'mappings' ? 'space-y-4' : 'hidden'}>
          {view === 'mappings' && (
            <>
              {bindingsError && (
                <Banner variant="error" title="Could not load mappings" onRetry={loadBindings}>
                  {bindingsError}
                </Banner>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setDialog('cleanup')}>
                  <Eraser size={12} aria-hidden="true" /> Clear orphaned retained topics
                </Button>
              </div>
              {!bindingsLoaded && !bindingsError ? (
                <LoadingState label="mappings" rows={3} />
              ) : all.length === 0 ? (
                !bindingsError && (
                  <Card>
                    <EmptyState
                      title="No mappings yet"
                      hint="A mapping publishes device tags or MQTT topics under an asset path in your namespace. Pick a source, tick tags in the tree, then add them to the UNS."
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
                  health={health}
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
          key={editor.binding ? `${editor.binding.id}-${editor.nonce || 0}` : `${editor.srcType}-${editor.selectMode || ''}`}
          spec={editor}
          brokers={brokers}
          profiles={profiles}
          sources={sources}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
          onReload={(current) => setEditor({ binding: current, nonce: Date.now() })}
        />
      )}
      {dialog === 'migrate' && (
        <MigrationReview
          candidates={migrations}
          readOnly={readOnly}
          onClose={() => setDialog(null)}
          onDone={() => {
            loadExtras();
            loadBindings();
          }}
        />
      )}
      {dialog === 'cleanup' && <RetainedCleanup readOnly={readOnly} onClose={() => setDialog(null)} />}
    </div>
  );
}
