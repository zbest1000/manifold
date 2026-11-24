import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { X, Plug, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { FormField, selectCls, DescriptorFields, fieldDefaults } from './FormControls';
import PollGroupsEditor from './PollGroupsEditor';
import TagTable, { newTagId } from './TagTable';
import ProbePanel from './ProbePanel';
import { useTagValidation, useDeviceValues } from './hooks';
import { cleanTag, localTagErrors, ORDER_CODES } from '@/lib/deviceTags';

const DEFAULT_LIMITS = { requestDeadlineMs: 2000, connectTimeoutMs: 5000, interRequestDelayMs: 0 };
const LIMIT_FIELDS = [
  ['requestDeadlineMs', 'Request deadline (ms)', 'A read that takes longer is abandoned and counted as a timeout.'],
  ['connectTimeoutMs', 'Connect timeout (ms)', ''],
  ['interRequestDelayMs', 'Delay between requests (ms)', 'Raise for slow gateways that choke on back-to-back requests.']
];

export function blankDevice(descriptor) {
  return {
    name: '',
    protocol: descriptor.id,
    enabled: true,
    host: '',
    port: descriptor.defaultPort,
    ...fieldDefaults(descriptor.deviceFields),
    options: fieldDefaults(descriptor.optionFields),
    limits: { ...DEFAULT_LIMITS },
    pollGroups: [{ id: 'default', intervalMs: 1000 }],
    tags: []
  };
}

const withIds = (d) => ({ ...d, tags: (d.tags || []).map((t) => ({ ...t, _id: t._id || newTagId() })) });

function toPayload(draft) {
  const { status, ...rest } = draft; // `status` is read-only, attached by the list endpoint
  return {
    ...rest,
    port: Number(draft.port),
    limits: Object.fromEntries(Object.entries(draft.limits || {}).map(([k, v]) => [k, Number(v)])),
    pollGroups: (draft.pollGroups || []).map((g) => ({ id: g.id, intervalMs: Number(g.intervalMs) })),
    tags: (draft.tags || []).map(cleanTag)
  };
}

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

export default function DeviceForm({ device, protocols, onClose, onSaved }) {
  const editing = !!device?.id;
  const titleId = useId();
  const [draft, setDraft] = useState(() => withIds(device || blankDevice(protocols[0])));
  const initial = useRef(JSON.stringify(toPayload(draft)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // { message, details }
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const descriptor = protocols.find((p) => p.id === draft.protocol) || protocols[0];
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
    const dirty = JSON.stringify(toPayload(draft)) !== initial.current;
    if (!dirty || window.confirm('Discard your unsaved changes to this device?')) onClose();
  };

  const changeProtocol = (id) => {
    const d = protocols.find((p) => p.id === id);
    if (d) setDraft((cur) => ({ ...blankDevice(d), name: cur.name, host: cur.host }));
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const { tags, ...cfg } = toPayload(draft);
      setTest(await api.testDevice(cfg));
    } catch (e) {
      setTest({ ok: false, error: e.message || 'Test request failed' });
    } finally {
      setTesting(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    const badRow = Object.keys(localErrors).length;
    if (!draft.name.trim()) return setSaveError({ message: 'Give the device a name.' });
    if (!draft.host.trim()) return setSaveError({ message: 'Enter the host name or IP address.' });
    if (badRow) return setSaveError({ message: `${badRow} tag row${badRow === 1 ? ' has' : 's have'} problems. Fix the highlighted rows.` });
    const rejected = Object.values(validation.results).filter((r) => r.ok === false).length;
    if (rejected) return setSaveError({ message: `${rejected} tag address${rejected === 1 ? ' is' : 'es are'} invalid. Fix the highlighted rows.` });
    setSaving(true);
    setSaveError(null);
    try {
      const body = toPayload(draft);
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
  return (
    <Modal title={editing ? `Edit ${device.name}` : 'Add device'} labelledBy={titleId} onClose={requestClose} className="max-w-6xl p-0">
      <form onSubmit={save} noValidate>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          <h3 id={titleId} className="text-base font-semibold text-slate-100">{editing ? `Edit ${device.name}` : 'Add device'}</h3>
          <IconButton icon={X} label="Close" onClick={requestClose} />
        </div>

        <div className="space-y-5 px-5 py-4 sm:px-6">
          <section aria-label="Connection" className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormField label="Name" error={fieldErrs.name}>
                {(a) => <Input {...a} data-autofocus value={draft.name} onChange={(e) => setField('name', e.target.value)} placeholder="Boiler house meter" />}
              </FormField>
              <FormField label="Protocol" help={editing ? 'Fixed once created' : undefined}>
                {(a) => (
                  <select {...a} className={selectCls} value={draft.protocol} disabled={editing} onChange={(e) => changeProtocol(e.target.value)}>
                    {protocols.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                )}
              </FormField>
              <FormField label="Host" error={fieldErrs.host}>
                {(a) => <Input {...a} value={draft.host} onChange={(e) => setField('host', e.target.value)} placeholder="192.168.1.20" />}
              </FormField>
              <FormField label="Port" error={fieldErrs.port}>
                {(a) => <Input {...a} type="number" min={1} max={65535} value={draft.port} onChange={(e) => setField('port', e.target.value === '' ? '' : Number(e.target.value))} />}
              </FormField>
            </div>
            <DescriptorFields fields={descriptor.deviceFields} values={draft} onChange={setField} errors={fieldErrs} />
            <label className="inline-flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="accent-sky-500" checked={draft.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
              Enabled (poll this device)
            </label>

            {descriptor.prerequisites && (
              <div className="flex gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-100/90">
                <Info size={14} className="mt-0.5 shrink-0 text-sky-300" aria-hidden="true" />
                <p><span className="font-semibold">Before you connect: </span>{descriptor.prerequisites}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={runTest} disabled={testing || !draft.host.trim()}>
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Test connection
              </Button>
              <div aria-live="polite" className="min-w-0 text-xs">
                {test?.ok && (
                  <span className="inline-flex items-center gap-1.5 text-emerald-300">
                    <CheckCircle2 size={14} /> Connected{test.latencyMs !== undefined ? ` in ${test.latencyMs} ms` : ''}
                    {test.info && <span className="text-slate-400"> · {typeof test.info === 'string' ? test.info : JSON.stringify(test.info)}</span>}
                  </span>
                )}
                {test && !test.ok && (
                  <span className="inline-flex items-start gap-1.5 text-rose-300">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span className="break-words">{test.error || 'Connection failed'}</span>
                  </span>
                )}
              </div>
            </div>
          </section>

          <Section title="Protocol options" hint="Defaults for every tag on this device; a tag can override byte and word order in its advanced columns.">
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
            />
          </Section>

          <Section title="Probe" hint="Read raw registers and compare the four byte/word orders to find the right one.">
            <ProbePanel deviceId={editing ? device.id : null} defaultUnitId={draft.unitId} selectedTag={selectedTag} onApply={applyOrder} />
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
