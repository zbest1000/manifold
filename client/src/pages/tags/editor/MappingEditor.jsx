import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Modal, Button, IconButton, SegmentedControl, Banner, LoadingState, EmptyState, Input, useConfirm } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { EditorSection } from './parts';
import { SetupSection } from './WhereSection';
import WhereSection from './WhereSection';
import WhatSection from './WhatSection';
import TagTable, { ROW_H } from './TagTable';
import TagInspector from './TagInspector';
import BulkBar from './BulkBar';
import ContextSection from './ContextSection';
import { PayloadSection, DeliverySection } from './PayloadSection';
import PreviewPane from './PreviewPane';
import { useEditorData, tagDefsFor } from './useEditorData';
import { usePreview } from '../usePreview';
import { saveBinding, savePipeline } from '../tagsApi';
import {
  stateFromBinding, newState, withTagDefs, switchSelectMode, buildMapping, focusDraft, rowVerdict, publishingRows, validateMapping, visibleErrors,
  computeTopics, diffTopics, suggestionMap, supportsOverrides, renameable as canRename, mqttSourceTopics, pipelineFor, rawName
} from '../mappingModel';

const SECTIONS = [
  { id: 'setup', label: 'Mapping' },
  { id: 'what', label: 'What' },
  { id: 'where', label: 'Where' },
  { id: 'tags', label: 'Tags' },
  { id: 'context', label: 'Context' },
  { id: 'payload', label: 'Payload' },
  { id: 'delivery', label: 'Delivery' }
];
const SECTION_OF = { setup: 'setup', what: 'what', where: 'where', tags: 'tags', context: 'context', payload: 'payload', delivery: 'delivery', server: 'tags' };
const FILTERS_BASE = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'Published' },
  { value: 'off', label: 'Off' }
];

/**
 * The mapping editor: one full-height sheet instead of a step wizard. The left column is the form
 * (what to map, where, the per-tag table, context, payload, delivery); the right column is the
 * live server preview. An experienced user edits 200 tags in the table without opening a dialog
 * per tag; the active tag's details open under the table.
 *
 * spec: { binding } to edit, or { srcType, source, picked, selectMode, profileId } to create.
 */
export default function MappingEditor({ spec, brokers, profiles = [], sources = [], onClose, onSaved }) {
  const readOnly = useReadOnly();
  const titleId = useId();
  const editing = spec.binding || null;
  const srcType = editing ? editing.source.type : spec.srcType;
  const isProfile = srcType === 'device-profile';
  const [profileId, setProfileId] = useState(editing?.source?.profileId || spec.profileId || profiles[0]?.id || '');
  const profile = useMemo(() => profiles.find((p) => p.id === profileId) || null, [profiles, profileId]);
  const deviceId = srcType === 'device' ? (editing ? editing.source.deviceId : spec.source?.id) : null;
  const opcuaTags = srcType === 'opcua' && !editing ? (spec.picked || []).map((p) => ({ address: p.address })) : null;
  const data = useEditorData({ srcType, deviceId, profileId, opcuaTags });
  const devices = data.devices.data;
  const schema = data.schema.data;
  const tagDefs = useMemo(() => tagDefsFor({ srcType, deviceId, profile, devices }), [srcType, deviceId, profile, devices]);
  const device = useMemo(() => (devices || []).find((d) => d.id === deviceId) || null, [devices, deviceId]);
  const suggestions = useMemo(() => (data.suggest.data ? suggestionMap(data.suggest.data.tags) : null), [data.suggest.data]);

  const [state, setState] = useState(() =>
    editing
      ? stateFromBinding(editing, { brokers })
      : newState({
          srcType,
          ref: srcType === 'device' ? { deviceId } : srcType === 'opcua' ? { connectionId: spec.source?.id } : srcType === 'device-profile' ? { profileId } : srcType === 'sparkplug' ? spSource(spec) : {},
          picked: spec.picked || [],
          brokers,
          selectMode: isProfile ? 'rules' : spec.selectMode || 'list'
        })
  );
  const [baseline, setBaseline] = useState(null); // JSON of the request right after loading: dirty = differs
  const [snapshot, setSnapshot] = useState(null); // state right after loading (for the topic diff)
  const [seeded, setSeeded] = useState(null);
  const devicesForTarget = isProfile ? devices : null;

  // Fold in the device definitions and suggestions once they arrive (adjusted while rendering,
  // once per profile, rather than in an effect).
  const needsDefs = srcType === 'device' || isProfile;
  const ready = (!needsDefs || tagDefs !== null) && data.suggest.status !== 'loading' && (!isProfile || data.devices.status !== 'loading');
  const seedKey = ready ? `${profileId}` : null;
  if (seedKey !== null && seeded !== seedKey) {
    let next;
    if (isProfile && !editing) {
      next = { ...newState({ srcType, ref: { profileId }, tagDefs, suggestions, brokers, selectMode: 'rules' }), name: state.name, form: state.form };
    } else next = needsDefs ? withTagDefs(state, tagDefs, editing ? null : suggestions) : { ...state, tagsLoaded: true };
    setSeeded(seedKey);
    setState(next);
    setSnapshot(next);
    setBaseline(srcType === 'mqtt' ? JSON.stringify(next.rows.map((r) => r.enabled)) + JSON.stringify(next.form) : JSON.stringify(buildMapping(next, { devices: devicesForTarget })));
  }

  const patch = useCallback((p) => setState((s) => ({ ...s, form: { ...s.form, ...p } })), []);
  const setRows = useCallback((fn) => setState((s) => ({ ...s, rows: fn(s.rows) })), []);
  const set = { form: state.form, patch };

  // Typing must stay instant with 500 rows: the table renders from `state`, while the request body,
  // validation, topics and the preview follow a deferred copy React computes at lower priority.
  const deferred = useDeferredValue(state);
  const draft = useMemo(() => (srcType === 'mqtt' || !deferred.tagsLoaded ? null : buildMapping(deferred, { devices: devicesForTarget })), [srcType, deferred, devicesForTarget]);
  const { rows: stateRows, rules: stateRules, selectMode } = state;
  const verdicts = useMemo(() => new Map(stateRows.map((r) => [r.key, rowVerdict({ rules: stateRules, selectMode }, r)])), [stateRows, stateRules, selectMode]);
  const pub = useMemo(() => publishingRows(state), [state]);
  const baseErrors = useMemo(() => validateMapping(deferred, { brokers, profile, devices, schema }), [deferred, brokers, profile, devices, schema]);
  const previewOn = Boolean(draft) && !baseErrors.some((e) => e.section === 'setup' || e.section === 'what' || (e.section === 'where' && e.field === 'dest'));
  const preview = usePreview(draft, previewOn);
  const errors = useMemo(() => validateMapping(deferred, { brokers, profile, devices, schema, preview }), [deferred, brokers, profile, devices, schema, preview]);
  const [attempted, setAttempted] = useState(false);
  const shown = visibleErrors(errors, attempted);
  const warnings = preview.data?.valid ? preview.data.warnings || [] : [];

  // Active row (details + focused payload), table filter, bulk selection.
  const [activeKey, setActiveKey] = useState(null);
  const [inspector, setInspector] = useState(false);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [scrollReq, setScrollReq] = useState(null);
  const [view, setView] = useState('edit'); // narrow screens: edit | preview
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');
  const editorRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  const activeRow = state.rows.find((r) => r.key === activeKey) || null;
  const deferredActive = deferred.rows.find((r) => r.key === activeKey) || null;
  const focusBody = useMemo(() => (deferredActive && previewOn ? focusDraft(deferred, deferredActive, devicesForTarget) : null), [deferredActive, previewOn, deferred, devicesForTarget]);
  const focus = usePreview(focusBody, Boolean(focusBody), 250);

  const problemsByRow = useMemo(() => {
    const m = new Map();
    for (const e of shown) if (e.rowKey) m.set(e.rowKey, [...(m.get(e.rowKey) || []), e]);
    return m;
  }, [shown]);

  const q = query.trim().toLowerCase();
  const viewRows = useMemo(
    () =>
      state.rows.filter((r) => {
        const v = verdicts.get(r.key);
        if (filter === 'on' && !(r.enabled && v.matched)) return false;
        if (filter === 'off' && (r.enabled || !v.matched)) return false;
        if (filter === 'excluded' && v.matched) return false;
        if (filter === 'attention' && !(problemsByRow.has(r.key) || rawName(r.name))) return false;
        if (q && !`${r.address} ${r.name} ${r.def.property || ''} ${r.ov.description ?? r.def.description ?? ''}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [state.rows, verdicts, filter, q, problemsByRow]
  );
  const attentionCount = useMemo(() => state.rows.filter((r) => problemsByRow.has(r.key) || rawName(r.name)).length, [state.rows, problemsByRow]);
  const filters = [
    ...FILTERS_BASE,
    ...(state.selectMode === 'rules' ? [{ value: 'excluded', label: 'Excluded' }] : []),
    ...(attentionCount ? [{ value: 'attention', label: `Needs attention ${attentionCount}` }] : [])
  ];
  const currentFilter = filters.some((f) => f.value === filter) ? filter : 'all';

  const topics = useMemo(() => computeTopics(deferred, { profile, devices }), [deferred, profile, devices]);
  const mqttTopics = useMemo(() => (srcType === 'mqtt' ? mqttSourceTopics(state.rows.filter((r) => r.enabled), state.form.pathTemplate).rows : []), [srcType, state.rows, state.form.pathTemplate]);
  const diff = useMemo(() => (editing && snapshot ? diffTopics(computeTopics(snapshot, { profile, devices }), topics) : null), [editing, snapshot, topics, profile, devices]);

  const dirtyOf = (s, body) => baseline !== null && (srcType === 'mqtt' ? JSON.stringify(s.rows.map((r) => r.enabled)) + JSON.stringify(s.form) !== baseline || s.name !== '' : JSON.stringify(body) !== baseline);
  const dirty = dirtyOf(deferred, draft); // for the footer; closing checks the live state

  const activate = useCallback(
    (key, { scroll = false, open = false, focusName = false } = {}) => {
      setActiveKey(key);
      if (open) setInspector(true);
      if (scroll) {
        setFilter('all');
        setView('edit');
        document.getElementById('map-tags')?.scrollIntoView({ block: 'start' });
        setScrollReq({ key, focusName, n: Date.now() });
      }
    },
    []
  );

  const jumpTo = (e) => {
    const section = SECTION_OF[e.section] || 'setup';
    setView('edit');
    if (e.rowKey) activate(e.rowKey, { scroll: true, open: e.field && !['name', 'unit', 'description'].includes(e.field), focusName: e.field === 'name' || e.collision });
    else {
      document.getElementById(`map-${section}`)?.scrollIntoView({ block: 'start' });
      const target = e.field === 'dest' ? document.getElementById(isProfile ? 'asset-path-template' : 'asset-path') : null;
      requestAnimationFrame(() => target?.focus());
    }
  };

  const requestClose = async () => {
    if (busy) return;
    const live = srcType === 'mqtt' || !state.tagsLoaded ? null : buildMapping(state, { devices: devicesForTarget });
    if (dirtyOf(state, live) && !readOnly) {
      const ok = await confirm({ title: 'Discard changes?', message: 'What you changed in this mapping will be lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true });
      if (!ok) return;
    }
    onClose();
  };

  const save = async () => {
    if (busy || readOnly) return;
    setAttempted(true);
    setSaveError(null);
    // Save what is on screen now, not the deferred copy the preview follows.
    const body = srcType === 'mqtt' ? null : buildMapping(state, { devices: devicesForTarget });
    const liveErrors = validateMapping(state, { brokers, profile, devices, schema, preview });
    if (liveErrors.length) {
      jumpTo(liveErrors[0]);
      return;
    }
    if (srcType !== 'mqtt' && (preview.status !== 'ok' || JSON.stringify(body) !== JSON.stringify(draft))) {
      setNotice(preview.status === 'error' ? 'The server check failed. Retry it in the preview before saving.' : 'Waiting for the server to check this mapping… press save again in a moment.');
      return;
    }
    setBusy(true);
    try {
      if (srcType === 'mqtt') {
        await savePipeline(pipelineFor(state, spec.source.id));
        toast.success(
          (t) => (
            <span>
              Created a pipeline route.{' '}
              <Link to="/pipelines" onClick={() => toast.dismiss(t.id)} className="underline">
                Open Pipelines, Routes
              </Link>
            </span>
          ),
          { duration: 8000 }
        );
        onSaved(null);
        return;
      }
      const saved = await saveBinding(body);
      toast.success(editing ? 'Mapping saved' : 'Mapping created');
      onSaved(saved);
    } catch (e) {
      setSaveError(e.message);
      setBusy(false);
    }
  };

  // Ctrl/Cmd+S saves while the editor is open.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sourceLabel = useMemo(() => {
    if (isProfile) return profile ? `Device profile ${profile.name} · ${profile.instances?.length || 0} instance${profile.instances?.length === 1 ? '' : 's'}` : 'Device profile';
    const s = editing?.source || {};
    const id = srcType === 'device' ? deviceId : srcType === 'opcua' ? s.connectionId || spec.source?.id : s.brokerId || spec.source?.id;
    const found = sources.find((x) => x.type === srcType && x.id === id);
    return found?.label || spec.source?.label || id || '';
  }, [isProfile, profile, editing, srcType, deviceId, spec.source, sources]);

  const n = state.rows.length;
  const title = editing
    ? `Edit ${editing.name || 'mapping'}`
    : isProfile
      ? 'Map a device profile'
      : srcType === 'mqtt'
        ? `Create a pipeline route for ${n} topic${n === 1 ? '' : 's'}`
        : state.selectMode === 'rules'
          ? `Map tags of ${sourceLabel.split(' · ')[0] || 'the device'} by rule`
          : `Add ${n} ${srcType === 'sparkplug' ? 'metric' : 'tag'}${n === 1 ? '' : 's'} to the UNS`;

  const sectionProblems = (id) => shown.filter((e) => (SECTION_OF[e.section] || 'setup') === id).length;
  const flags = { renameable: canRename(srcType), overrides: supportsOverrides(srcType), list: state.selectMode === 'list' };
  const activeIndex = viewRows.findIndex((r) => r.key === activeKey);
  const savingDisabledReason = readOnly ? READ_ONLY_REASON : null;
  const firstShown = shown[0];
  const status = saveError
    ? null
    : attempted && firstShown
      ? { tone: 'bad', text: `${shown.length} problem${shown.length === 1 ? '' : 's'}: ${firstShown.message}` }
      : notice && preview.status !== 'ok'
        ? { tone: 'muted', text: notice }
        : dirty
          ? { tone: 'muted', text: 'Unsaved changes' }
          : null;

  return (
    <Modal labelledBy={titleId} onClose={requestClose} placement="right" className="flex w-full max-w-[1480px] flex-col">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 py-2">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-medium text-fg">
              {title}
            </h2>
            <p className="truncate text-xs text-muted">
              {sourceLabel}
              {readOnly && ' · read-only'}
            </p>
          </div>
          <SegmentedControl size="sm" className="hidden sm:inline-flex xl:hidden" label="Show" value={view} onChange={setView} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />
          <IconButton icon={X} label="Close" side="left" onClick={requestClose} />
        </header>
        <div className="flex shrink-0 border-b border-line px-4 py-1.5 sm:hidden">
          <SegmentedControl size="sm" className="w-full [&>button]:flex-1 [&>button]:justify-center" label="Show" value={view} onChange={setView} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />
        </div>

        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_27rem]">
          <div ref={editorRef} className={clsx('min-h-0 overflow-y-auto', view === 'preview' && 'hidden xl:block')}>
            <nav aria-label="Sections" className="sticky top-0 z-20 flex gap-1 overflow-x-auto border-b border-line bg-overlay px-3 py-1.5 sm:px-4">
              {SECTIONS.filter((s) => s.id !== 'context' || srcType !== 'mqtt').map((s) => {
                const p = sectionProblems(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => document.getElementById(`map-${s.id}`)?.scrollIntoView({ block: 'start' })}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
                    aria-label={p ? `${s.label}, ${p} problem${p === 1 ? '' : 's'}` : undefined}
                  >
                    {s.label}
                    {s.id === 'tags' && <span className="font-mono text-2xs text-subtle">{pub.length}</span>}
                    {p > 0 && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bad" />}
                  </button>
                );
              })}
            </nav>

            {readOnly && (
              <div className="px-4 pt-4 sm:px-5">
                <Banner variant="info" title="Read-only session">You can look at this mapping, but saving is disabled. Sign in with the admin token to make changes.</Banner>
              </div>
            )}
            {saveError && (
              <div className="px-4 pt-4 sm:px-5">
                <Banner variant="error" title="Could not save the mapping" onDismiss={() => setSaveError(null)}>
                  {saveError}
                </Banner>
              </div>
            )}
            {data.schema.status === 'error' && (
              <div className="px-4 pt-4 sm:px-5">
                <Banner variant="error" title="Could not load the mapping options" onRetry={data.schema.retry}>
                  {data.schema.error}. Field lists fall back to what this page knows.
                </Banner>
              </div>
            )}
            {data.devices.status === 'error' && !isProfile && (
              <div className="px-4 pt-4 sm:px-5">
                <Banner variant="error" title="Could not read the device's tags" onRetry={data.devices.retry}>
                  {data.devices.error}
                </Banner>
              </div>
            )}

            <SetupSection state={state} setState={setState} set={set} brokers={brokers} errors={shown} readOnly={readOnly} />
            <WhatSection
              state={state}
              setState={setState}
              onSwitchMode={(m) => setState((s) => switchSelectMode(s, m, tagDefs))}
              tagDefs={tagDefs}
              device={device}
              profiles={profiles}
              profile={profile}
              onPickProfile={setProfileId}
              verdicts={verdicts}
              selection={preview.data?.valid ? preview.data.selection : null}
              schema={schema}
              suggestions={suggestions}
              readOnly={readOnly}
              onShowExcluded={() => {
                setFilter('excluded');
                document.getElementById('map-tags')?.scrollIntoView({ block: 'start' });
              }}
            />
            <WhereSection state={state} set={set} errors={shown} profile={profile} devices={data.devices} readOnly={readOnly} />

            <EditorSection
              id="map-tags"
              title="Tags"
              count={`${pub.length.toLocaleString()} published${n !== pub.length ? ` of ${n.toLocaleString()}` : ''}`}
              actions={
                <>
                  <div className="relative w-48">
                    <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter tags by name, key or description" className="h-7 py-0 pl-8 text-xs" />
                  </div>
                  <SegmentedControl size="sm" label="Show tags" value={currentFilter} onChange={setFilter} options={filters} />
                </>
              }
            >
              {selected.size > 0 && (
                <BulkBar
                  selected={selected}
                  rows={state.rows}
                  onRows={setRows}
                  flags={flags}
                  onClear={() => setSelected(new Set())}
                  onDone={(msg) => setNotice(msg)}
                />
              )}
              {!state.tagsLoaded ? (
                <LoadingState label="tags" rows={4} />
              ) : n === 0 ? (
                <div className="rounded-lg border border-line">
                  <EmptyState title={state.selectMode === 'rules' ? 'The device has no tags yet' : 'No tags in this mapping'} hint={state.selectMode === 'rules' ? 'Tags added on the Devices page are picked up automatically when they match the rules.' : 'Add tags under What to map, or pick them in the tree on the Tags page.'} />
                </div>
              ) : viewRows.length === 0 ? (
                <div className="rounded-lg border border-line">
                  <EmptyState title="No tag matches this filter" action={<Button size="sm" variant="secondary" onClick={() => { setFilter('all'); setQuery(''); }}>Show all tags</Button>} />
                </div>
              ) : (
                <TagTableWithScroll
                  rows={viewRows}
                  verdicts={verdicts}
                  selected={selected}
                  onSelect={setSelected}
                  activeKey={activeKey}
                  onActivate={activate}
                  onRows={setRows}
                  problems={problemsByRow}
                  flags={flags}
                  readOnly={readOnly}
                  caption={`Tags in this mapping, ${viewRows.length} shown`}
                  scrollReq={scrollReq}
                  onPasted={(lines, count) => setNotice(`Pasted ${lines} line${lines === 1 ? '' : 's'} into ${count} tag${count === 1 ? '' : 's'}.`)}
                />
              )}
              <p className="helper mt-2" aria-live="polite">
                {notice || 'Paste a column from a spreadsheet into names, units or descriptions to fill many tags at once. Up and down arrows move between rows; shift-click selects a range.'}
              </p>
              {inspector && activeRow && flags.overrides && (
                <TagInspector
                  key={activeRow.key}
                  state={state}
                  row={activeRow}
                  index={Math.max(0, activeIndex)}
                  total={viewRows.length}
                  onRow={(fn) => setRows((rs) => rs.map((r) => (r.key === activeRow.key ? fn(r) : r)))}
                  onMove={(d) => {
                    const next = viewRows[activeIndex + d];
                    if (next) activate(next.key, { scroll: false });
                    if (next) setScrollReq({ key: next.key, n: Date.now() });
                  }}
                  onClose={() => setInspector(false)}
                  problems={problemsByRow.get(activeRow.key) || []}
                  schema={schema}
                  readOnly={readOnly}
                />
              )}
              {flags.list && selected.size > 0 && !readOnly && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => {
                      setRows((rs) => rs.filter((r) => !selected.has(r.key)));
                      setNotice(`${selected.size} tag${selected.size === 1 ? '' : 's'} removed from the mapping.`);
                      setSelected(new Set());
                    }}
                  >
                    Remove {selected.size} selected from the mapping
                  </Button>
                </div>
              )}
            </EditorSection>

            {srcType !== 'mqtt' && <ContextSection state={state} set={set} schema={schema} profile={profile} preview={preview.data?.valid ? preview.data : null} suggested={data.suggest.data?.context?.suggested} errors={shown} readOnly={readOnly} />}
            <PayloadSection state={state} set={set} schema={schema} preview={preview.data?.valid ? preview.data : null} readOnly={readOnly} />
            <DeliverySection state={state} set={set} errors={shown} schema={schema} historians={data.historians} readOnly={readOnly} />
            <p className="px-4 py-4 text-xs text-subtle sm:px-5">Mappings only read: Manifold monitors the source and republishes. It never writes to a device.</p>
          </div>

          <aside aria-label="Preview" className={clsx('min-h-0 overflow-y-auto border-line bg-panel xl:border-l', view === 'edit' && 'hidden xl:block')}>
            <PreviewPane
              state={deferred}
              topics={topics}
              mqttTopics={mqttTopics}
              preview={preview}
              focus={focus}
              activeRow={activeRow}
              onActivate={activate}
              errors={errors.filter((e) => e.section === 'server')}
              warnings={warnings}
              diff={diff}
              editing={Boolean(editing)}
            />
          </aside>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          {status && (
            <p role="status" className={clsx('mr-auto min-w-0 flex-1 basis-full truncate text-xs sm:basis-64', status.tone === 'bad' ? 'text-bad' : 'text-muted')}>
              {status.tone === 'bad' && firstShown ? (
                <button type="button" className="max-w-full truncate text-left underline-offset-2 hover:underline" onClick={() => jumpTo(firstShown)}>
                  {status.text}
                </button>
              ) : (
                status.text
              )}
            </p>
          )}
          <Button variant="secondary" onClick={requestClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={save} loading={busy} disabled={Boolean(savingDisabledReason)} title={savingDisabledReason || 'Ctrl+S'}>
            {editing ? 'Save changes' : srcType === 'mqtt' ? 'Create pipeline route' : 'Create mapping'}
          </Button>
        </footer>
      </div>
      {confirmDialog}
    </Modal>
  );
}

function spSource(spec) {
  const meta = spec.picked?.[0]?.meta || {};
  return { brokerId: spec.source?.id, group: meta.group, edge: meta.edge, device: meta.device ?? null };
}

/** TagTable plus "scroll to this row" requests from outside (preview links, problem jumps). */
function TagTableWithScroll({ scrollReq, ...props }) {
  const holder = useRef(null);
  const rowsRef = useRef(props.rows);
  useEffect(() => {
    rowsRef.current = props.rows;
  });
  useEffect(() => {
    if (!scrollReq) return undefined;
    const index = rowsRef.current.findIndex((r) => r.key === scrollReq.key);
    if (index < 0) return undefined;
    const id = requestAnimationFrame(() => {
      const el = holder.current?.querySelector('[role="region"]');
      if (!el) return;
      const top = index * ROW_H;
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 2 * ROW_H) el.scrollTop = Math.max(0, top - 2 * ROW_H);
      // The scroll event re-renders the window; focus once the row is in the DOM.
      requestAnimationFrame(() => {
        if (scrollReq.focusName) el.querySelector(`[data-cell="${index}:name"]`)?.focus();
      });
    });
    return () => cancelAnimationFrame(id);
  }, [scrollReq]);
  return (
    <div ref={holder}>
      <TagTable {...props} />
    </div>
  );
}
