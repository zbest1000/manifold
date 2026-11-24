import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { FormField, selectCls, DescriptorFields, PresetButtons } from './FormControls';
import PollGroupsEditor from './PollGroupsEditor';
import TagTable, { newTagId } from './TagTable';
import ProbePanel from './ProbePanel';
import ProtocolNotices from './ProtocolNotices';
import ConnectionTest from './ConnectionTest';
import { useTagValidation, useDeviceValues } from './hooks';
import { localTagErrors, ORDER_CODES } from '@/lib/deviceTags';
import { blankDevice, toPayload, applyPreset, presetActive, browseBlockedReason } from './model';

const LIMIT_FIELDS = [
  ['requestDeadlineMs', 'Request deadline (ms)', 'A read that takes longer is abandoned and counted as a timeout.'],
  ['connectTimeoutMs', 'Connect timeout (ms)', ''],
  ['interRequestDelayMs', 'Delay between requests (ms)', 'Raise for slow gateways that choke on back-to-back requests.']
];

const withIds = (d) => ({ ...d, tags: (d.tags || []).map((t) => ({ ...t, _id: t._id || newTagId() })) });

function Section({ title, hint, children }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-white/5 pt-4">
      <div>
        <h4 id={id} className="text-sm font-semibold text-slate-100">{title}</h4>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export default function DeviceForm({ device, protocols, live, onClose, onSaved }) {
  const editing = !!device?.id;
  const titleId = useId();
  const [draft, setDraft] = useState(() => withIds(device || blankDevice(protocols[0])));
  const initial = useRef(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // { message, details }
  const [selectedId, setSelectedId] = useState(null);

  const descriptor = protocols.find((p) => p.id === draft.protocol) || protocols[0];
  const payload = useCallback((d = draft) => toPayload(d, descriptor), [draft, descriptor]);
  if (initial.current === null) initial.current = JSON.stringify(payload());
  const setField = (name, v) => setDraft((d) => ({ ...d, [name]: v }));
  const setOption = (name, v) => setDraft((d) => ({ ...d, options: { ...d.options, [name]: v } }));
  const setTags = useCallback((upd) => setDraft((d) => ({ ...d, tags: typeof upd === 'function' ? upd(d.tags) : upd })), []);

  const validation = useTagValidation(draft.protocol, draft.options, draft.tags);
  const { values, error: valuesError, retry: retryValues } = useDeviceValues(editing ? device.id : null);

  const serverErrs = useMemo(() => Object.fromEntries((saveError?.details || []).map((d) => [d.key, d.error])), [saveError]);
  const localErrors = useMemo(() => {
    const errs = localTagErrors(draft.tags);
    draft.tags.forEach((t, i) => {
      if (!errs[i] && serverErrs[t.key]) errs[i] = serverErrs[t.key];
    });
    return errs;
  }, [draft.tags, serverErrs]);
  const usedGroups = useMemo(() => new Set(draft.tags.map((t) => t.pollGroup).filter(Boolean)), [draft.tags]);
  const selectedTag = draft.tags.find((t) => t._id === selectedId);

  const requestClose = () => {
    const dirty = JSON.stringify(payload()) !== initial.current;
    if (!dirty || window.confirm('Discard your unsaved changes to this device?')) onClose();
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
    const badRow = Object.keys(localErrors).length;
    if (!draft.name.trim()) return setSaveError({ message: 'Give the device a name.' });
    if (!draft.host.trim()) return setSaveError({ message: 'Enter the host name or IP address.' });
    if (badRow) return setSaveError({ message: `${badRow} tag row${badRow === 1 ? ' has' : 's have'} problems. Fix the highlighted rows.` });
    // While a re-check is pending the results may describe rows that no longer exist; the server re-validates on save anyway.
    const rejected = validation.pending ? 0 : draft.tags.filter((t) => validation.results[t.key]?.ok === false).length;
    if (rejected) return setSaveError({ message: `${rejected} tag address${rejected === 1 ? ' is' : 'es are'} invalid. Fix the highlighted rows.` });
    setSaving(true);
    setSaveError(null);
    try {
      const body = payload();
      const saved = editing ? await api.updateDevice(device.id, body) : await api.createDevice(body);
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

  const fieldErrs = serverErrs;
  const quarantined = useMemo(() => new Set(live?.quarantined || []), [live?.quarantined]);
  const effective = useMemo(() => Object.fromEntries(Object.entries(live?.groups || {}).map(([id, g]) => [id, g.effectiveIntervalMs])), [live?.groups]);
  const browse = {
    supported: Boolean(descriptor.capabilities?.browse),
    device,
    reason: browseBlockedReason(editing, draft, live)
  };
  return (
    <Modal title={editing ? `Edit ${device.name}` : 'Add device'} labelledBy={titleId} onClose={requestClose} className="max-w-6xl p-0">
      <form onSubmit={save} noValidate>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          <h3 id={titleId} className="text-base font-semibold text-slate-100">{editing ? `Edit ${device.name}` : 'Add device'}</h3>
          <IconButton icon={X} side="left" label="Close" onClick={requestClose} />
        </div>

        <div className="space-y-5 px-5 py-4 sm:px-6">
          <section aria-label="Connection" className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Name" error={fieldErrs.name}>
                {(a) => <Input {...a} data-autofocus value={draft.name} onChange={(e) => setField('name', e.target.value)} placeholder="Boiler house meter" />}
              </FormField>
              <FormField label="Protocol" help={editing ? 'Fixed once created' : undefined}>
                {(a) => (
                  <select {...a} className={selectCls} value={draft.protocol} disabled={editing} onChange={(e) => changeProtocol(e.target.value)}>
                    {protocols.map((p) => <option key={p.id} value={p.id}>{p.label}{p.experimental ? ' (experimental)' : ''}</option>)}
                  </select>
                )}
              </FormField>
            </div>

            <ProtocolNotices descriptor={descriptor} />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormField label="Host" error={fieldErrs.host} className="lg:col-span-2">
                {(a) => <Input {...a} value={draft.host} onChange={(e) => setField('host', e.target.value)} placeholder="192.168.1.20" />}
              </FormField>
              <FormField label="Port" error={fieldErrs.port}>
                {(a) => <Input {...a} type="number" min={1} max={65535} value={draft.port} onChange={(e) => setField('port', e.target.value === '' ? '' : Number(e.target.value))} />}
              </FormField>
            </div>
            <PresetButtons presets={descriptor.presets} isActive={(p) => presetActive(draft, p)} onApply={(p) => setDraft((d) => applyPreset(d, p))} />
            <DescriptorFields fields={descriptor.deviceFields} values={draft} onChange={setField} errors={fieldErrs} />
            <label className="inline-flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="accent-sky-500" checked={draft.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
              Enabled (poll this device)
            </label>
            <ConnectionTest buildConfig={payload} disabled={!draft.host.trim()} />
          </section>

          <Section title="Protocol options" hint="Defaults for every tag on this device.">
            <DescriptorFields fields={descriptor.optionFields} values={draft.options} onChange={setOption} errors={fieldErrs} />
          </Section>

          <Section title="Limits" hint="Protect slow devices and gateways.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {LIMIT_FIELDS.map(([k, label, help]) => (
                <FormField key={k} label={label} help={help}>
                  {(a) => <Input {...a} type="number" min={0} value={draft.limits?.[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: e.target.value === '' ? '' : Number(e.target.value) } }))} />}
                </FormField>
              ))}
            </div>
          </Section>

          <Section title="Poll groups" hint="Tags in the same group are read together at the group's interval.">
            <PollGroupsEditor groups={draft.pollGroups} onChange={(g) => setField('pollGroups', g)} usedIds={usedGroups} />
          </Section>

          <Section title="Tags" hint="Paste a block from a spreadsheet into any cell, or import a CSV. Addresses are checked as you type.">
            {editing && valuesError && (
              <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <span>Live values unavailable: {valuesError}</span>
                <Button type="button" size="sm" variant="outline" onClick={retryValues}>Retry</Button>
              </div>
            )}
            <TagTable
              tags={draft.tags}
              setTags={setTags}
              descriptor={descriptor}
              pollGroups={draft.pollGroups}
              validation={validation}
              localErrors={localErrors}
              values={values}
              showLive={editing}
              selectedId={selectedId}
              onSelect={setSelectedId}
              deviceName={draft.name}
              quarantined={quarantined}
              effective={effective}
              browse={browse}
            />
          </Section>

          <Section title="Probe" hint={draft.protocol === 'modbus-tcp' ? 'Read raw registers and compare the four byte/word orders to find the right one.' : 'Read raw bytes from the device and see every way they decode.'}>
            <ProbePanel key={draft.protocol} deviceId={editing ? device.id : null} protocol={draft.protocol} defaultUnitId={draft.unitId} selectedTag={selectedTag} onApply={applyOrder} addressHelp={descriptor.addressHelp} />
          </Section>
        </div>

        <div className="sticky bottom-0 z-10 space-y-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          {saveError && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <p className="font-medium">{saveError.message}</p>
              {saveError.details?.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {saveError.details.map((d, i) => <li key={i}><span className="mono">{d.key}</span>: {d.error}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={requestClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save changes' : 'Create device'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
