import { useId, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal, Button, IconButton, Input } from '@/components/ui';
import { FormField, Section, DescriptorFields, PresetButtons } from './FormControls';
import ParamValues from './ParamValues';
import EffectiveTagsTable from './EffectiveTagsTable';
import { instantiateProfile } from './devicesApi';
import { fieldDefaults, cleanFields, applyPreset, presetActive } from './model';
import { previewInstance } from '@/lib/deviceProfiles';

/** "New device from profile": connection + parameter values, a live preview of the effective tags, server errors per tag. */
export default function InstantiateDialog({ profile, protocols, onClose, onCreated }) {
  const titleId = useId();
  const descriptor = protocols.find((p) => p.id === profile.protocol);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(descriptor?.defaultPort ?? '');
  const [fields, setFields] = useState(() => fieldDefaults(descriptor?.deviceFields));
  const [params, setParams] = useState({});
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const given = useMemo(() => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '')), [params]);
  const preview = useMemo(() => previewInstance(profile, given), [profile, given]);
  const serverErrs = useMemo(() => Object.fromEntries((error?.details || []).filter((d) => d.key).map((d) => [d.key, d.error])), [error]);
  const rowErrs = useMemo(() => ({ ...Object.fromEntries(preview.errors.filter((e) => e.key).map((e) => [e.key, e.error])), ...serverErrs }), [preview, serverErrs]);
  const generic = [...preview.errors.filter((e) => !e.key).map((e) => e.error), ...(error?.details || []).filter((d) => !d.key).map((d) => d.error)];

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError({ message: 'Give the device a name.' });
    if (!host.trim()) return setError({ message: 'Enter the host name or IP address.' });
    if (preview.errors.length) return setError({ message: 'Fix the parameter values first.' });
    setSaving(true);
    setError(null);
    try {
      const body = { ...cleanFields(fields, descriptor?.deviceFields), name: name.trim(), host: host.trim(), port: Number(port), enabled, params: given };
      const saved = await instantiateProfile(profile.id, body);
      toast.success(`Device "${saved.name}" created from ${profile.name}`);
      onCreated(saved);
    } catch (err) {
      setError({ message: err.message || 'Could not create the device', details: err.details });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`New device from ${profile.name}`} labelledBy={titleId} onClose={onClose} className="max-w-4xl p-0">
      <form onSubmit={submit} noValidate>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          <h3 id={titleId} className="text-base font-semibold text-slate-100">New device from profile "{profile.name}"</h3>
          <IconButton icon={X} side="left" label="Close" onClick={onClose} />
        </div>
        <div className="space-y-5 px-5 py-4 sm:px-6">
          <section aria-label="Connection" className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormField label="Name" className="lg:col-span-2">{(a) => <Input {...a} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Line 2 meter" />}</FormField>
              <FormField label="Host">{(a) => <Input {...a} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.21" />}</FormField>
              <FormField label="Port">{(a) => <Input {...a} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))} />}</FormField>
            </div>
            <PresetButtons presets={descriptor?.presets} isActive={(p) => presetActive(fields, p)} onApply={(p) => setFields((f) => applyPreset(f, p))} />
            <DescriptorFields fields={descriptor?.deviceFields} values={fields} onChange={(n, v) => setFields((f) => ({ ...f, [n]: v }))} />
            <label className="inline-flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="accent-sky-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled (poll this device)
            </label>
          </section>
          <Section title="Parameter values" hint="These replace {placeholders} in the profile's tags.">
            <ParamValues params={profile.params} values={params} onChange={(n, v) => setParams((p) => ({ ...p, [n]: v }))} />
          </Section>
          <Section title="Preview: the tags this device will have" hint="Placeholders substituted exactly as the server will. Poll groups and options come from the profile.">
            {generic.length > 0 && (
              <ul role="alert" className="list-disc space-y-0.5 rounded-lg border border-rose-500/30 bg-rose-500/10 py-2 pl-7 pr-3 text-xs text-rose-200">
                {generic.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            )}
            <EffectiveTagsTable tags={preview.tags} errors={rowErrs} caption="Preview of effective tags" empty={preview.errors.length ? 'Fix the parameter values to see the tags.' : 'The profile has no tags.'} />
          </Section>
        </div>
        <div className="sticky bottom-0 z-10 space-y-2 border-t border-white/5 bg-surface-900 px-5 py-3 sm:px-6">
          {error && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <p className="font-medium">{error.message}</p>
              {error.details?.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{error.details.map((d, i) => <li key={i}>{d.key ? <span className="mono">{d.key}: </span> : null}{d.error}</li>)}</ul>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" />} Create device</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
