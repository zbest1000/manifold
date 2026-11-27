import { useCallback, useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Modal, useConfirm } from '@/components/ui';
import { useReadOnly } from '@/store/selectors';
import { SetupSection } from './WhereSection';
import WhereSection from './WhereSection';
import WhatSection from './WhatSection';
import TagsSection from './TagsSection';
import ContextSection from './ContextSection';
import { PayloadSection, DeliverySection } from './PayloadSection';
import PreviewPane from './PreviewPane';
import { EditorHeader, EditorFooter, EditorNotices, SectionNav } from './EditorChrome';
import { useTagView } from './useTagView';
import StaleEditDialog from './StaleEditDialog';
import { useEditPresence } from './useEditPresence';
import { overwriteBody } from './staleEdit';
import { useSaveFlow } from './useSaveFlow';
import { useEditorData, tagDefsFor } from './useEditorData';
import { useIotTagDefs } from '../../devices/iotHooks';
import { usePreview } from '../usePreview';
import {
  stateFromBinding, newState, withTagDefs, switchSelectMode, buildMapping, focusDraft, rowVerdict, publishingRows, validateMapping, visibleErrors,
  computeTopics, diffTopics, suggestionMap, supportsOverrides, renameable as canRename, tagDefsFromSuggest
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

/**
 * The mapping editor: one full-height sheet instead of a step wizard. The left column is the form
 * (what to map, where, the per-tag table, context, payload, delivery); the right column is the
 * live server preview. An experienced user edits 200 tags in the table without opening a dialog
 * per tag; the active tag's details open under the table.
 *
 * spec: { binding } to edit, or { srcType, source, picked, selectMode, profileId } to create.
 */
export default function MappingEditor({ spec, brokers, profiles = [], sources = [], onClose, onSaved, onReload }) {
  const readOnly = useReadOnly();
  const titleId = useId();
  const editing = spec.binding || null;
  const srcType = editing ? editing.source.type : spec.srcType;
  const isProfile = srcType === 'device-profile';
  const [profileId, setProfileId] = useState(editing?.source?.profileId || spec.profileId || profiles[0]?.id || '');
  const profile = useMemo(() => profiles.find((p) => p.id === profileId) || null, [profiles, profileId]);
  const deviceId = srcType === 'device' ? (editing ? editing.source.deviceId : spec.source?.id) : null;
  const opcuaTags = srcType === 'opcua' && !editing ? (spec.picked || []).map((p) => ({ address: p.address })) : null;
  const [state, setState] = useState(() =>
    editing
      ? stateFromBinding(editing, { brokers })
      : newState({
          srcType,
          ref:
            srcType === 'device'
              ? { deviceId }
              : srcType === 'opcua'
                ? { connectionId: spec.source?.id }
                : srcType === 'device-profile'
                  ? { profileId }
                  : srcType === 'sparkplug'
                    ? spSource(spec)
                    : srcType === 'iot'
                      ? { brokerId: spec.source?.brokerId, deviceId: spec.source?.deviceId }
                      : { brokerId: spec.source?.id, ...(spec.filter ? { filter: spec.filter } : {}) },
          picked: spec.picked || [],
          brokers,
          selectMode: isProfile ? 'rules' : spec.selectMode || 'list'
        })
  );
  // An MQTT-topic source "by filter" lists the topics the server has seen under the filter.
  const filterRules = srcType === 'mqtt' && state.selectMode === 'rules';
  const { brokerId: srcBroker, filter: srcFilter } = state.ref;
  const mqttFilter = useMemo(() => (filterRules ? { brokerId: srcBroker, filter: String(srcFilter || '').trim() } : null), [filterRules, srcBroker, srcFilter]);
  const data = useEditorData({ srcType, deviceId, profileId, opcuaTags, mqttFilter });
  // An IoT device: its tags (with the metadata the convention derived) are the tag definitions.
  const iotDefs = useIotTagDefs(srcType === 'iot' ? state.ref : null);
  const devices = data.devices.data;
  const schema = data.schema.data;
  const mqttDefs = useMemo(() => (mqttFilter && data.suggest.status === 'ok' ? tagDefsFromSuggest(data.suggest.data) : null), [mqttFilter, data.suggest.status, data.suggest.data]);
  const tagDefs = useMemo(() => (srcType === 'mqtt' ? mqttDefs : srcType === 'iot' ? iotDefs : tagDefsFor({ srcType, deviceId, profile, devices })), [srcType, mqttDefs, iotDefs, deviceId, profile, devices]);
  const device = useMemo(() => (devices || []).find((d) => d.id === deviceId) || null, [devices, deviceId]);
  const suggestions = useMemo(() => (data.suggest.data && srcType !== 'mqtt' ? suggestionMap(data.suggest.data.tags) : null), [data.suggest.data, srcType]);

  const [baseline, setBaseline] = useState(null); // JSON of the request right after loading: dirty = differs
  const [snapshot, setSnapshot] = useState(null); // state right after loading (for the topic diff)
  const [seeded, setSeeded] = useState(null);
  const devicesForTarget = isProfile ? devices : null;

  // Fold in the device definitions and suggestions once they arrive (adjusted while rendering,
  // once per profile, rather than in an effect).
  const needsDefs = srcType === 'device' || srcType === 'iot' || isProfile || Boolean(mqttFilter);
  const ready = (!needsDefs || tagDefs !== null) && (data.suggest.status !== 'loading' || srcType === 'mqtt') && (!isProfile || data.devices.status !== 'loading');
  const seedKey = ready ? `${profileId}` : null;
  // The topics under an MQTT filter change with the filter: fold each new list in (rows keep their settings).
  const [foldedDefs, setFoldedDefs] = useState(null);
  if (mqttFilter && seeded !== null && tagDefs && foldedDefs !== tagDefs) {
    setFoldedDefs(tagDefs);
    setState((s) => withTagDefs(s, tagDefs));
  }
  if (seedKey !== null && seeded !== seedKey) {
    let next;
    if (isProfile && !editing) {
      next = { ...newState({ srcType, ref: { profileId }, tagDefs, suggestions, brokers, selectMode: 'rules' }), name: state.name, form: state.form };
    } else next = needsDefs ? withTagDefs(state, tagDefs, editing ? null : suggestions) : { ...state, tagsLoaded: true };
    setSeeded(seedKey);
    setState(next);
    setSnapshot(next);
    if (mqttFilter) setFoldedDefs(tagDefs);
    setBaseline(JSON.stringify(buildMapping(next, { devices: devicesForTarget })));
  }

  const patch = useCallback((p) => setState((s) => ({ ...s, form: { ...s.form, ...p } })), []);
  const setRows = useCallback((fn) => setState((s) => ({ ...s, rows: fn(s.rows) })), []);
  const set = { form: state.form, patch };

  // Typing must stay instant with 500 rows: the table renders from `state`, while the request body,
  // validation, topics and the preview follow a deferred copy React computes at lower priority.
  const deferred = useDeferredValue(state);
  const draft = useMemo(() => (!deferred.tagsLoaded ? null : buildMapping(deferred, { devices: devicesForTarget })), [deferred, devicesForTarget]);
  const { rows: stateRows, rules: stateRules, selectMode } = state;
  const verdicts = useMemo(() => new Map(stateRows.map((r) => [r.key, rowVerdict({ rules: stateRules, selectMode, srcType }, r)])), [stateRows, stateRules, selectMode, srcType]);
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
  const [saveQueued, setSaveQueued] = useState(false);
  const [conflict, setConflict] = useState(null); // { mine, theirs } after a 409 stale
  const otherTabs = useEditPresence(editing?.id);

  const activeRow = state.rows.find((r) => r.key === activeKey) || null;
  const deferredActive = deferred.rows.find((r) => r.key === activeKey) || null;
  const focusBody = useMemo(() => (deferredActive && previewOn ? focusDraft(deferred, deferredActive, devicesForTarget) : null), [deferredActive, previewOn, deferred, devicesForTarget]);
  const focus = usePreview(focusBody, Boolean(focusBody), 250);

  const { problemsByRow, viewRows, filters, currentFilter } = useTagView({ rows: state.rows, selectMode: state.selectMode, verdicts, shown, filter, query });

  const topics = useMemo(() => computeTopics(deferred, { profile, devices }), [deferred, profile, devices]);
  const diff = useMemo(() => (editing && snapshot ? diffTopics(computeTopics(snapshot, { profile, devices }), topics) : null), [editing, snapshot, topics, profile, devices]);

  const dirtyOf = (s, body) => baseline !== null && JSON.stringify(body) !== baseline;
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
    const live = !state.tagsLoaded ? null : buildMapping(state, { devices: devicesForTarget });
    if (dirtyOf(state, live) && !readOnly) {
      const ok = await confirm({ title: 'Discard changes?', message: 'What you changed in this mapping will be lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true });
      if (!ok) return;
    }
    onClose();
  };

  const { save, submit } = useSaveFlow({
    current: () => buildMapping(state, { devices: devicesForTarget }),
    validate: () => validateMapping(state, { brokers, profile, devices, schema, preview }),
    draft, preview, busy, readOnly, saveQueued, setSaveQueued, setBusy, setAttempted, setSaveError, setNotice, setConflict, jumpTo,
    onSaved: (saved) => {
      toast.success(editing ? 'Mapping saved' : 'Mapping created');
      onSaved(saved);
    }
  });

  const sourceLabel = useMemo(() => {
    if (isProfile) return profile ? `Device profile ${profile.name} · ${profile.instances?.length || 0} instance${profile.instances?.length === 1 ? '' : 's'}` : 'Device profile';
    const s = editing?.source || {};
    const id = srcType === 'device' ? deviceId : srcType === 'opcua' ? s.connectionId || spec.source?.id : srcType === 'iot' ? (s.brokerId ? `${s.brokerId}|${s.deviceId}` : spec.source?.id) : s.brokerId || spec.source?.id;
    const found = sources.find((x) => x.type === srcType && x.id === id);
    return found?.label || spec.source?.label || id || '';
  }, [isProfile, profile, editing, srcType, deviceId, spec.source, sources]);

  const n = state.rows.length;
  const title = editing
    ? `Edit ${editing.name || 'mapping'}`
    : isProfile
      ? 'Map a device profile'
      : state.selectMode === 'rules'
        ? srcType === 'mqtt'
          ? `Map topics under ${state.ref.filter || 'a filter'}`
          : `Map tags of ${sourceLabel.split(' · ')[0] || 'the device'} by rule`
        : `Add ${n} ${srcType === 'sparkplug' ? 'metric' : srcType === 'mqtt' ? 'topic' : 'tag'}${n === 1 ? '' : 's'} to the UNS`;

  const sectionProblems = (id) => shown.filter((e) => (SECTION_OF[e.section] || 'setup') === id).length;
  const flags = { renameable: canRename(srcType), overrides: supportsOverrides(srcType), list: state.selectMode === 'list' };
  const activeIndex = viewRows.findIndex((r) => r.key === activeKey);
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
        <EditorHeader titleId={titleId} title={title} subtitle={`${sourceLabel}${readOnly ? ' · read-only' : ''}`} view={view} onView={setView} onClose={requestClose} />

        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_27rem]">
          <div ref={editorRef} className={clsx('min-h-0 overflow-y-auto', view === 'preview' && 'hidden xl:block')}>
            <SectionNav sections={SECTIONS} problems={sectionProblems} published={pub.length} />

            <EditorNotices otherTabs={otherTabs} readOnly={readOnly} saveError={saveError} onDismissError={() => setSaveError(null)} schema={data.schema} devices={isProfile ? null : data.devices} />

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
              errors={shown}
              topicsLoading={Boolean(mqttFilter) && data.suggest.status === 'loading'}
              onShowExcluded={() => {
                setFilter('excluded');
                document.getElementById('map-tags')?.scrollIntoView({ block: 'start' });
              }}
            />
            <WhereSection state={state} set={set} errors={shown} profile={profile} devices={data.devices} readOnly={readOnly} />

            <TagsSection
              t={{ state, setRows, viewRows, verdicts, selected, setSelected, activeKey, activate, problemsByRow, flags, readOnly, scrollReq, setScrollReq, notice, setNotice, inspector, setInspector, activeRow, activeIndex, schema, focus, query, setQuery, currentFilter, setFilter, filters, pub, n, tagDefs, csvAtStart: spec.csv && !readOnly }}
            />

            <ContextSection state={state} set={set} schema={schema} profile={profile} preview={preview.data?.valid ? preview.data : null} suggested={data.suggest.data?.context?.suggested} errors={shown} readOnly={readOnly} />
            <PayloadSection state={state} set={set} schema={schema} preview={preview.data?.valid ? preview.data : null} readOnly={readOnly} />
            <DeliverySection state={state} set={set} errors={shown} schema={schema} historians={data.historians} readOnly={readOnly} />
            <p className="px-4 py-4 text-xs text-subtle sm:px-5">Mappings only read: Manifold monitors the source and republishes. It never writes to a device.</p>
          </div>

          <aside aria-label="Preview" className={clsx('min-h-0 overflow-y-auto border-line bg-panel xl:border-l', view === 'edit' && 'hidden xl:block')}>
            <PreviewPane
              state={deferred}
              topics={topics}
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

        <EditorFooter status={status} onStatus={firstShown ? () => jumpTo(firstShown) : null} onCancel={requestClose} onSave={save} busy={busy} readOnly={readOnly} label={editing ? 'Save changes' : 'Create mapping'} />
      </div>
      {confirmDialog}
      {conflict && (
        <StaleEditDialog
          base={editing}
          mine={conflict.mine}
          theirs={conflict.theirs}
          busy={busy}
          onCancel={() => setConflict(null)}
          onKeepMine={() => submit(overwriteBody(conflict.mine, conflict.theirs))}
          onTakeTheirs={() => {
            setConflict(null);
            if (conflict.theirs) onReload?.(conflict.theirs);
          }}
        />
      )}
    </Modal>
  );
}

function spSource(spec) {
  const meta = spec.picked?.[0]?.meta || {};
  return { brokerId: spec.source?.id, group: meta.group, edge: meta.edge, device: meta.device ?? null };
}
