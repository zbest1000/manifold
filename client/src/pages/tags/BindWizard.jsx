import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, Check, ArrowLeft, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Modal, Button } from '@/components/ui';
import ErrorBanner from './Banner';
import TargetStep from './TargetStep';
import NamingStep from './NamingStep';
import OptionsStep from './OptionsStep';
import { saveBinding, savePipeline } from './tagsApi';
import { usePreview } from './usePreview';
import { useWizardData } from './useWizardData';
import { validateWizard, mqttSourceTopics } from './wizardModel';
import { buildBinding, formFromBinding, rowsFromBinding, rowsFromSelection, profileRowsFor, renameRow } from './bindingForm';

const STEPS = ['Target', 'Naming', 'Options'];
const help = 'text-xs leading-snug text-slate-400';

/**
 * Three-step bind wizard inside the shared Modal: target (where) -> naming (names + server preview) -> options.
 * Sources: a Tags-page selection, a device-profile (`profileMode`), or a stored binding (`editing`, which keeps
 * whichever destination form it was stored with). Saving returns the binding plus non-blocking `warnings`.
 */
export default function BindWizard({ source, selection, brokers, profiles = [], profileMode = false, profileId: initialProfileId = null, editing = null, onClose, onDone }) {
  const srcType = editing ? editing.source.type : profileMode ? 'device-profile' : source.type;
  const isProfile = srcType === 'device-profile';
  const [step, setStep] = useState(0);
  const [name, setName] = useState(editing?.name || '');
  const [mode, setMode] = useState(editing?.target?.mode || 'mqtt');
  const [form, setForm] = useState(() => formFromBinding(editing, { brokers, srcType }));
  const [profileId, setProfileId] = useState(editing?.source?.profileId || initialProfileId || profiles[0]?.id || '');
  const profile = useMemo(() => profiles.find((p) => p.id === profileId) || null, [profiles, profileId]);
  const [rows, setRows] = useState(() => (isProfile ? [] : editing ? rowsFromBinding(editing) : rowsFromSelection(selection, srcType)));
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const data = useWizardData({ srcType, editing });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Profile source: every profile tag is a row; the stored binding overlays names and selection.
  useEffect(() => {
    if (!isProfile || !profile) return;
    const r = profileRowsFor(profile, editing && editing.source.profileId === profile.id ? editing : null);
    setRows(r.rows);
    setSelected(r.selected);
  }, [isProfile, profile, editing]);

  // Editing a device binding: names/units come from the device's effective tags.
  useEffect(() => {
    if (!editing || srcType !== 'device' || !data.meta.map) return;
    if (editing.source.tags === 'all') setRows(rowsFromBinding(editing, data.meta.map));
    else {
      setRows((rs) => rs.map((r) => {
        const meta = data.meta.map[r.address] || r.meta;
        const defaultName = meta.property || r.address;
        return { ...r, meta, defaultName, name: r.explicit ? r.name : defaultName };
      }));
    }
  }, [editing, srcType, data.meta.map]);

  const effRows = useMemo(() => (isProfile ? rows.filter((r) => selected.has(r.key)) : rows), [isProfile, rows, selected]);
  const allTags = isProfile ? selected.size === rows.length : editing?.source?.tags === 'all';
  const devicesList = data.devices.list;
  const rename = (key, value) => setRows((rs) => rs.map((r) => (r.key === key ? renameRow(r, value, srcType === 'opcua') : r)));
  const renameable = srcType === 'opcua' || srcType === 'device' || isProfile;

  const draftArgs = { name, mode, form, rows: effRows, srcType, source, editing, allTags, profileId, devices: devicesList };
  const draft = useMemo(() => (srcType === 'mqtt' ? null : buildBinding(draftArgs)), [name, mode, form, effRows, srcType, source, editing, allTags, profileId, devicesList]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowEmpty = srcType === 'sparkplug' && Boolean(editing) && !editing.source.metrics;
  const base = useMemo(() => validateWizard({ srcType, mode, form, rows: effRows, brokers, profile, devices: devicesList, allowEmpty }), [srcType, mode, form, effRows, brokers, profile, devicesList, allowEmpty]);
  const previewOn = step >= 1 && srcType !== 'mqtt' && !base.errors.some((e) => e.step === 0 || (e.step === 1 && e.message.startsWith('Every'))) && effRows.length > 0;
  const preview = usePreview(draft, previewOn);
  const { errors, resolved, collisions } = useMemo(
    () => validateWizard({ srcType, mode, form, rows: effRows, brokers, profile, devices: devicesList, preview, allowEmpty }),
    [srcType, mode, form, effRows, brokers, profile, devicesList, preview, allowEmpty]
  );
  const stepErrors = errors.filter((e) => e.step === step);
  const firstError = errors[0];
  const lastStep = step === STEPS.length - 1;
  const checking = srcType !== 'mqtt' && (preview.status === 'loading' || preview.status === 'error' || preview.status === 'idle');
  const submitBlocked = firstError ? `Step ${firstError.step + 1} (${STEPS[firstError.step]}): ${firstError.message}` : checking ? (preview.status === 'error' ? 'The server preview failed. Retry it on the Naming step before saving.' : 'Waiting for the server to check this binding.') : null;

  const submit = async () => {
    setBusy(true);
    try {
      if (srcType === 'mqtt' && !editing) {
        const m = mqttSourceTopics(effRows, form.pathTemplate);
        const segCount = m.prefix ? m.prefix.split('/').filter(Boolean).length : 0;
        await savePipeline({
          name: name || `tags -> ${m.base}`,
          source: { brokerId: source.id, filter: effRows.length === 1 ? effRows[0].address : `${m.prefix}#` },
          transforms: [{ type: 'repath', to: `${m.base}/{${segCount + 1}-}` }, ...(form.format === 'envelope' ? [{ type: 'envelope' }] : [])],
          target: { type: 'mqtt', brokerId: form.brokerId, retain: form.retain, qos: Number(form.qos) || 0 }
        });
        toast.success('Created a pipeline route (see Pipelines, Routes)');
        onDone(null);
        return;
      }
      const saved = await saveBinding(draft);
      toast.success(editing ? 'Binding saved' : 'Binding created');
      onDone(saved);
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };

  const toggleKey = (k) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pc = {
    profile,
    devices: devicesList,
    devicesError: data.devices.error,
    retryDevices: data.loadDevices,
    source: {
      profiles, profile, rows, selectedKeys: selected, locked: Boolean(editing), onToggle: toggleKey,
      onPickProfile: setProfileId,
      onToggleAll: () => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.key)))
    }
  };

  const title = editing
    ? `Edit binding ${editing.name || editing.id.slice(0, 8)}`
    : isProfile ? 'Map a device profile to the UNS' : `Add ${rows.length} ${srcType === 'sparkplug' ? 'Sparkplug metric' : 'tag'}${rows.length === 1 ? '' : 's'} to the UNS`;

  return (
    <Modal title={title} onClose={onClose} className="max-w-3xl p-4 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <ol className="mb-4 flex flex-wrap gap-2" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}>
            <button
              type="button"
              onClick={() => i <= step && setStep(i)}
              className={clsx(
                'flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
                i === step ? 'bg-accent-500/20 text-accent-200 ring-accent-500/40' : i < step ? 'text-slate-200 ring-white/15 hover:bg-white/5' : 'cursor-default text-slate-400 ring-white/10'
              )}
            >
              <span className="grid h-4 w-4 place-items-center rounded-full bg-white/10 text-xs">{i < step ? <Check size={10} aria-hidden="true" /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      {data.meta.error && <div className="mb-3"><ErrorBanner title="Could not read the device's tag metadata" message={data.meta.error} onRetry={data.loadMeta} /></div>}
      {step === 0 && <TargetStep {...{ name, setName, mode, setMode, form, set, brokers, srcType, rows: effRows, pc, errors: stepErrors }} />}
      {step === 1 && <NamingStep {...{ mode, srcType, form, set, resolved, collisions, rows: effRows, rename, renameable, errors: stepErrors, preview, isProfile }} />}
      {step === 2 && <OptionsStep {...{ mode, srcType, form, set, errors: stepErrors, hist: data.hist }} />}

      <p className={clsx(help, 'mt-4')}>Bindings are read-only: Manifold monitors the source and republishes. It never writes to a device.</p>

      <div className="sticky -bottom-4 z-10 -mx-4 mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-white/5 bg-surface-900 px-4 py-3 sm:-bottom-5 sm:-mx-5 sm:px-5">
        {lastStep && submitBlocked && (
          <p role="status" className="mr-auto flex min-w-0 items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{submitBlocked}</span>
          </p>
        )}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {step > 0 && (
          <Button variant="outline" onClick={() => setStep(step - 1)}>
            <ArrowLeft size={14} aria-hidden="true" /> Back
          </Button>
        )}
        {!lastStep ? (
          <Button onClick={() => setStep(step + 1)} disabled={Boolean(stepErrors[0])} title={stepErrors[0]?.message}>
            Next <ArrowRight size={14} aria-hidden="true" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={busy || Boolean(submitBlocked)}>
            {editing ? 'Save changes' : 'Create binding'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
