import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { Button, Input, Select, Checkbox, Panel, Banner, Drawer, useConfirm } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { useConflict } from '@/components/ConflictDialog';
import { FormField, DescriptorFields, PresetButtons } from './FormControls';
import PollGroupsEditor from './PollGroupsEditor';
import TagTable, { newTagId } from './TagTable';
import ProbePanel from './ProbePanel';
import AdvancedDeviceOptions from './AdvancedDeviceOptions';
import ProtocolNotices from './ProtocolNotices';
import ConnectionTest from './ConnectionTest';
import ProfileInstanceSection from './ProfileInstanceSection';
import { useTagValidation, useDeviceValues } from './hooks';
import { localTagErrors, ORDER_CODES } from '@/lib/deviceTags';
import { blankDevice, toPayload, applyPreset, presetActive, browseBlockedReason, DEFAULT_LIMITS } from './model';
import { mergeGroups } from './profileModel';
import { previewInstance } from '@/lib/deviceProfiles';

const LIMIT_FIELDS = [
  ['requestDeadlineMs', 'Request deadline (ms)', 'A read that takes longer is abandoned and counted as a timeout.'],
  ['connectTimeoutMs', 'Connect timeout (ms)', ''],
  ['interRequestDelayMs', 'Delay between requests (ms)', 'Raise for slow gateways that choke on back-to-back requests.']
];

// A profile instance edits only its OWN tags; the profile's arrive as read-only rows.
const withIds = (d) => ({ ...d, tags: (d.profileId ? d.ownTags || [] : d.tags || []).map((t) => ({ ...t, _id: t._id || newTagId() })) });

const SECTIONS = [
  ['connection', 'Connection'],
  ['options', 'Protocol options'],
  ['polling', 'Polling'],
  ['tags', 'Tags'],
  ['advanced', 'Advanced']
];

/**
 * Add or edit a device as a full-page form (too much for a dialog: it carries the tag table). Sections
 * run Connection, Protocol options, Polling, Tags, Advanced. A required field is only called out after
 * the first save attempt. Leaving with unsaved changes asks first.
 */
export default function DeviceEditor({ device, protocols, profiles = [], live, notice, openBrowse = false, onClose, onSaved }) {
  const editing = !!device?.id;
  const [draft, setDraft] = useState(() => withIds(device || blankDevice(protocols[0])));
  // What the form held when it opened: "unsaved changes" means the payload differs from this.
  const [initialJson] = useState(() => {
    const d = withIds(device || blankDevice(protocols[0]));
    return JSON.stringify(toPayload(d, protocols.find((p) => p.id === d.protocol) || protocols[0]));
  });
  const formRef = useRef(null);
  const scrollRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // { message, details, problems }
  const [submitted, setSubmitted] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [probing, setProbing] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const readOnly = useReadOnly();
  const { resolveConflict, conflictDialog } = useConflict();
  // The revision this form is based on; a save that finds a newer one stored asks before overwriting it.
  const baseRev = useRef(device?.rev);

  const descriptor = protocols.find((p) => p.id === draft.protocol) || protocols[0];
  const profile = draft.profileId ? profiles.find((p) => p.id === draft.profileId) : null;
  const groups = useMemo(() => (profile ? mergeGroups(profile.pollGroups, draft.pollGroups) : draft.pollGroups), [profile, draft.pollGroups]);
  const payload = useCallback((d = draft) => toPayload(d, descriptor), [draft, descriptor]);
  const dirty = useMemo(() => JSON.stringify(toPayload(draft, descriptor)) !== initialJson, [draft, descriptor, initialJson]);
  const setField = (name, v) => setDraft((d) => ({ ...d, [name]: v }));
  const setOption = (name, v) => setDraft((d) => ({ ...d, options: { ...d.options, [name]: v } }));
  const setTags = useCallback((upd) => setDraft((d) => ({ ...d, tags: typeof upd === 'function' ? upd(d.tags) : upd })), []);

  const validation = useTagValidation(draft.protocol, draft.options, draft.tags);
  const { values, error: valuesError, retry: retryValues } = useDeviceValues(editing ? device.id : null);

  const serverErrs = useMemo(() => Object.fromEntries((saveError?.details || []).map((d) => [d.key, d.error])), [saveError]);
  // "Key is required" and friends only after a save attempt; a duplicate key is a real mistake at once.
  const tagErrors = useMemo(() => {
    const errs = {};
    const all = localTagErrors(draft.tags);
    for (const [i, msg] of Object.entries(all)) if (submitted || msg.startsWith('Duplicate')) errs[i] = msg;
    draft.tags.forEach((t, i) => {
      if (!errs[i] && serverErrs[t.key]) errs[i] = serverErrs[t.key];
    });
    return errs;
  }, [draft.tags, serverErrs, submitted]);
  const preview = useMemo(() => (profile ? previewInstance(profile, draft.params, draft.tags) : null), [profile, draft.params, draft.tags]);
  const profileRowErrs = useMemo(() => Object.fromEntries([...(device?.profileErrors || []), ...(preview?.errors || [])].filter((e) => e.key).map((e) => [e.key, e.error])), [device, preview]);
  const usage = useMemo(() => {
    const u = {};
    for (const t of draft.tags) if (t.pollGroup) u[t.pollGroup] = (u[t.pollGroup] || 0) + 1;
    for (const t of preview?.tags || []) if (t.pollGroup) u[t.pollGroup] = (u[t.pollGroup] || 0) + 1;
    return u;
  }, [draft.tags, preview]);
  const selectedTag = draft.tags.find((t) => t._id === selectedId);

  const fieldErrs = {
    ...serverErrs,
    name: serverErrs.name || (submitted && !draft.name.trim() ? 'Give the device a name' : undefined),
    host: serverErrs.host || (submitted && !draft.host.trim() ? 'Enter the host name or IP address' : undefined)
  };

  const requestClose = async () => {
    if (!dirty) return onClose();
    const ok = await confirm({
      title: 'Discard your unsaved changes?',
      message: editing ? `Changes to ${device.name} have not been saved.` : 'This device has not been created yet.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true
    });
    if (ok) onClose();
  };

  const changeProtocol = (id) => {
    const d = protocols.find((p) => p.id === id);
    if (d) {
      setDraft((cur) => ({ ...blankDevice(d), name: cur.name, host: cur.host }));
      setSelectedId(null);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (readOnly || saving) return;
    setSubmitted(true);
    const problems = [];
    // Name and host show their problem inline; the banner below only says that something is wrong.
    const fieldProblem = !draft.name.trim() || !draft.host.trim();
    const badRows = Object.keys(localTagErrors(draft.tags)).length;
    if (badRows) problems.push(`${badRows} tag row${badRows === 1 ? ' has' : 's have'} problems. Fix the highlighted rows.`);
    // While a re-check is pending the results may describe rows that no longer exist; the server re-validates on save anyway.
    const rejected = validation.pending ? 0 : draft.tags.filter((t) => validation.results[t.key]?.ok === false).length;
    if (rejected) problems.push(`${rejected} tag address${rejected === 1 ? ' is' : 'es are'} invalid. Fix the highlighted rows.`);
    if (problems.length || fieldProblem) {
      setSaveError({ message: fieldProblem ? 'Fix the highlighted fields to save this device' : 'This device cannot be saved yet', problems });
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...payload(), ...(editing ? { rev: baseRev.current } : {}) };
      let saved;
      try {
        saved = editing ? await api.updateDevice(device.id, body) : await api.createDevice(body);
      } catch (err) {
        const choice = editing ? await resolveConflict(err, { what: 'device', mine: payload() }) : null;
        if (choice === null) throw err;
        if (choice === 'cancel') return;
        if (choice === 'theirs') {
          baseRev.current = err.current?.rev;
          if (err.current) setDraft(withIds(err.current));
          toast('Showing the saved version');
          return;
        }
        saved = await api.updateDevice(device.id, { ...body, rev: err.current?.rev });
      }
      toast.success(`Device "${saved.name}" ${editing ? 'updated' : 'created'}`);
      onSaved(saved);
    } catch (err) {
      setSaveError({ message: err.message || 'Save failed', details: err.details });
    } finally {
      setSaving(false);
    }
  };

  const applyOrder = (code, scope) => {
    const o = ORDER_CODES[code];
    if (scope === 'tag' && selectedTag) {
      setTags((ts) => ts.map((t) => (t._id === selectedId ? { ...t, byteOrder: o.byteOrder, wordOrder: o.wordOrder } : t)));
      toast.success(`${code} applied to ${selectedTag.key || 'the selected row'}. Open "Advanced columns" to see it.`);
    } else if (scope === 'device') {
      setDraft((d) => ({ ...d, options: { ...d.options, ...o } }));
      toast.success(`${code} set as the device default (byte ${o.byteOrder}, word ${o.wordOrder})`);
    }
  };

  const quarantined = useMemo(() => new Set(live?.quarantined || Object.keys(live?.quarantineReasons || {})), [live?.quarantined, live?.quarantineReasons]);
  const effective = useMemo(() => Object.fromEntries(Object.entries(live?.groups || {}).map(([id, g]) => [id, g.effectiveIntervalMs])), [live?.groups]);
  const browse = {
    supported: Boolean(descriptor.capabilities?.browse),
    device,
    reason: browseBlockedReason(editing, draft, live)
  };
  const hasOptions = Boolean(descriptor.optionFields?.length);
  const sections = SECTIONS.filter(([id]) => id !== 'options' || hasOptions);
  // Scroll only the form's own container: scrollIntoView would also move the app shell around it.
  const goTo = (id) => {
    const sc = scrollRef.current;
    const el = document.getElementById(`device-${id}`);
    if (sc && el) sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 36 });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={editing ? `Edit ${device.name}` : 'Add device'}
        subtitle={editing ? `${descriptor.label} · ${device.host}:${device.port}` : 'Connect a PLC, meter or gateway and list the tags to poll'}
        actions={
          <Button variant="ghost" onClick={requestClose}>
            <ArrowLeft size={14} aria-hidden="true" /> Back to devices
          </Button>
        }
      />
      <form ref={formRef} onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <nav aria-label="Sections" className="sticky top-0 z-10 border-b border-line bg-app">
            <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
              {sections.map(([id, label]) => (
                <button key={id} type="button" onClick={() => goTo(id)} className="-ml-2 h-9 shrink-0 rounded px-2 text-sm text-muted transition-colors first:ml-[-0.5rem] hover:text-fg">
                  {label}
                </button>
              ))}
            </div>
          </nav>
          <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 sm:px-6 sm:py-5">
            {readOnly && (
              <Banner variant="info" title="Read-only session">
                {READ_ONLY_REASON} You can inspect this device; nothing can be saved, tested or probed.
              </Banner>
            )}
            {notice && <Banner variant="info">{notice}</Banner>}

            <Panel id="device-connection" title="Connection" className="scroll-mt-12">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <FormField label="Name" error={fieldErrs.name}>
                    {(a) => <Input {...a} data-autofocus value={draft.name} onChange={(e) => setField('name', e.target.value)} placeholder="Boiler house meter" />}
                  </FormField>
                  <FormField label="Protocol" help={editing ? 'Fixed once created' : undefined}>
                    {(a) => (
                      <Select {...a} value={draft.protocol} disabled={editing} onChange={(e) => changeProtocol(e.target.value)}>
                        {protocols.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                            {p.experimental ? ' (experimental)' : ''}
                          </option>
                        ))}
                      </Select>
                    )}
                  </FormField>
                </div>

                <ProtocolNotices key={descriptor.id} descriptor={descriptor} defaultOpen={!editing} />

                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                  <FormField label="Host" error={fieldErrs.host} className="lg:col-span-2">
                    {(a) => <Input {...a} className="mono" value={draft.host} onChange={(e) => setField('host', e.target.value)} placeholder="192.168.1.20" />}
                  </FormField>
                  <FormField label="Port" error={fieldErrs.port}>
                    {(a) => <Input {...a} className="mono" type="number" min={1} max={65535} value={draft.port} onChange={(e) => setField('port', e.target.value === '' ? '' : Number(e.target.value))} />}
                  </FormField>
                </div>
                <PresetButtons presets={descriptor.presets} isActive={(p) => presetActive(draft, p)} onApply={(p) => setDraft((d) => applyPreset(d, p))} />
                <DescriptorFields fields={descriptor.deviceFields} values={draft} onChange={setField} errors={fieldErrs} />
                <Checkbox label="Enabled" description="Manifold polls this device while it is enabled." checked={draft.enabled} onChange={(v) => setField('enabled', v)} />

                <div className="border-t border-line pt-4">
                  <ConnectionTest buildConfig={payload} disabled={!draft.host.trim()} />
                </div>
              </div>
            </Panel>

            {hasOptions && (
              <Panel id="device-options" title="Protocol options" description="Defaults for every tag on this device. A tag can override them in its own row." className="scroll-mt-12">
                <DescriptorFields fields={descriptor.optionFields} values={draft.options} onChange={setOption} errors={fieldErrs} />
              </Panel>
            )}

            <Panel id="device-polling" title="Polling" description={profile ? "The profile's poll groups apply. Add a group with the same id to change its interval on this device." : "Tags in the same group are read together at the group's interval."} className="scroll-mt-12">
              <div className="space-y-5">
                <PollGroupsEditor groups={draft.pollGroups} onChange={(g) => setField('pollGroups', g)} usage={usage} allowEmpty={Boolean(profile)} />
                <div className="border-t border-line pt-4">
                  <h3 className="text-sm font-medium text-fg">Limits</h3>
                  <p className="mb-3 text-xs text-subtle">Protect slow devices and gateways.</p>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
                    {LIMIT_FIELDS.map(([k, label, help]) => (
                      <FormField key={k} label={label} help={help}>
                        {(a) => <Input {...a} type="number" min={0} placeholder={`default ${DEFAULT_LIMITS[k]}`} value={draft.limits?.[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: e.target.value === '' ? '' : Number(e.target.value) } }))} />}
                      </FormField>
                    ))}
                  </div>
                </div>
              </div>
            </Panel>

            {draft.profileId && (
              <Panel title="Device profile" className="scroll-mt-12">
                <ProfileInstanceSection
                  profile={profile}
                  profileId={draft.profileId}
                  params={draft.params || {}}
                  onParam={(n, v) => setDraft((d) => ({ ...d, params: { ...(d.params || {}), [n]: v } }))}
                  profileErrors={device?.profileErrors}
                  preview={preview || { tags: [], errors: [] }}
                  showErrors={submitted}
                />
              </Panel>
            )}

            <Panel
              id="device-tags"
              title="Tags"
              description={profile ? 'The profile’s tags are read-only. Add extra tags for this device only; their keys must differ from the profile’s.' : 'Paste a block from a spreadsheet into any cell, or import a CSV. Addresses are checked as you type.'}
              className="scroll-mt-12"
            >
              <div className="space-y-3">
                {editing && valuesError && (
                  <Banner variant="warn" title="Live values unavailable" onRetry={retryValues}>
                    {valuesError}
                  </Banner>
                )}
                <TagTable
                  tags={draft.tags}
                  setTags={setTags}
                  descriptor={descriptor}
                  pollGroups={groups}
                  validation={validation}
                  localErrors={tagErrors}
                  values={values}
                  showLive={editing}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  deviceName={draft.name}
                  quarantined={quarantined}
                  quarantineReasons={live?.quarantineReasons}
                  effective={effective}
                  browse={browse}
                  profileTags={preview?.tags || []}
                  profileErrors={profileRowErrs}
                  autoBrowse={openBrowse}
                  onProbe={() => setProbing(true)}
                />
              </div>
            </Panel>

            <div id="device-advanced" className="scroll-mt-12 px-1 pb-2">
              <AdvancedDeviceOptions descriptor={descriptor} draft={draft} onOption={setOption} onField={setField} />
            </div>
          </div>
        </div>

        <div className="shrink-0 space-y-2 border-t border-line bg-panel px-4 py-3 sm:px-6">
          {saveError && (
            <Banner variant="error" title={saveError.message}>
              {(saveError.problems?.length > 0 || saveError.details?.length > 0) && (
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                  {(saveError.problems || []).map((p, i) => (
                    <li key={`p${i}`}>{p}</li>
                  ))}
                  {(saveError.details || []).map((d, i) => (
                    <li key={`d${i}`}>
                      {d.key ? (
                        <>
                          <span className="mono">{d.key}</span>:{' '}
                        </>
                      ) : null}
                      {d.error}
                    </li>
                  ))}
                </ul>
              )}
            </Banner>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <span className="mr-auto text-xs text-subtle">Unsaved changes</span>}
            <Button type="button" variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <span title={readOnly ? READ_ONLY_REASON : undefined}>
              <Button type="submit" loading={saving} disabled={readOnly}>
                {editing ? 'Save changes' : 'Create device'}
              </Button>
            </span>
          </div>
        </div>
      </form>

      {probing && (
        <Drawer title="Probe" width="max-w-2xl" onClose={() => setProbing(false)}>
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted">{draft.protocol === 'modbus-tcp' ? 'Read raw registers and compare the four byte and word orders to find the right one.' : 'Read raw bytes from the device and see every way they decode.'}</p>
            <ProbePanel key={draft.protocol} deviceId={editing ? device.id : null} protocol={draft.protocol} defaultUnitId={draft.unitId} selectedTag={selectedTag} onApply={applyOrder} addressHelp={descriptor.addressHelp} />
          </div>
        </Drawer>
      )}
      {conflictDialog}
      {confirmDialog}
    </div>
  );
}
