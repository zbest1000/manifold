import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Dialog, Button, Input, Checkbox, Banner } from '@/components/ui';
import { FormField, FormSection, DescriptorFields, PresetButtons } from './FormControls';
import ParamValues from './ParamValues';
import EffectiveTagsTable from './EffectiveTagsTable';
import { instantiateProfile } from './devicesApi';
import { fieldDefaults, cleanFields, applyPreset, presetActive } from './model';
import { previewInstance } from '@/lib/deviceProfiles';

/** "New device from profile": connection + parameter values, a live preview of the effective tags, server errors per tag. */
export default function InstantiateDialog({ profile, protocols, onClose, onCreated }) {
  const descriptor = protocols.find((p) => p.id === profile.protocol);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(descriptor?.defaultPort ?? '');
  const [fields, setFields] = useState(() => fieldDefaults(descriptor?.deviceFields));
  const [params, setParams] = useState({});
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const given = useMemo(() => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '')), [params]);
  const preview = useMemo(() => previewInstance(profile, given), [profile, given]);
  const serverErrs = useMemo(() => Object.fromEntries((error?.details || []).filter((d) => d.key).map((d) => [d.key, d.error])), [error]);
  const rowErrs = useMemo(() => ({ ...Object.fromEntries(preview.errors.filter((e) => e.key).map((e) => [e.key, e.error])), ...serverErrs }), [preview, serverErrs]);
  const generic = [...preview.errors.filter((e) => !e.key).map((e) => e.error), ...(error?.details || []).filter((d) => !d.key).map((d) => d.error)];

  const submit = async () => {
    setSubmitted(true);
    // The fields show what is wrong inline (only now, after the attempt); nothing is sent.
    if (!name.trim() || !host.trim() || preview.errors.length) {
      requestAnimationFrame(() => document.querySelector('[role="dialog"] [aria-invalid="true"]')?.focus());
      return;
    }
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
    <Dialog
      title={`New device from profile "${profile.name}"`}
      description="Connection and parameter values; the tags come from the profile."
      size="xl"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && (
            <div className="basis-full">
              <Banner variant="error" title={error.message}>
                {error.details?.length > 0 && (
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                    {error.details.map((d, i) => (
                      <li key={i}>
                        {d.key ? <span className="mono">{d.key}: </span> : null}
                        {d.error}
                      </li>
                    ))}
                  </ul>
                )}
              </Banner>
            </div>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Create device
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section aria-label="Connection" className="space-y-3">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Name" className="lg:col-span-2" error={submitted && !name.trim() ? 'Give the device a name' : undefined}>
              {(a) => <Input {...a} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Line 2 meter" />}
            </FormField>
            <FormField label="Host" error={submitted && !host.trim() ? 'Enter the host or IP' : undefined}>
              {(a) => <Input {...a} className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.21" />}
            </FormField>
            <FormField label="Port">{(a) => <Input {...a} className="mono" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))} />}</FormField>
          </div>
          <PresetButtons presets={descriptor?.presets} isActive={(p) => presetActive(fields, p)} onApply={(p) => setFields((f) => applyPreset(f, p))} />
          <DescriptorFields fields={descriptor?.deviceFields} values={fields} onChange={(n, v) => setFields((f) => ({ ...f, [n]: v }))} />
          <Checkbox label="Enabled" description="Manifold polls this device while it is enabled." checked={enabled} onChange={setEnabled} />
        </section>
        <FormSection className="border-t border-line pt-5" title="Parameter values" hint="These replace {placeholders} in the profile's tags.">
          <ParamValues params={profile.params} values={params} onChange={(n, v) => setParams((p) => ({ ...p, [n]: v }))} showErrors={submitted} />
        </FormSection>
        <FormSection className="border-t border-line pt-5" title="Preview: the tags this device will have" hint="Placeholders substituted exactly as the server will. Poll groups and options come from the profile.">
          {generic.length > 0 && (
            <Banner variant="error">
              <ul className="list-disc space-y-0.5 pl-4">
                {generic.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </Banner>
          )}
          <EffectiveTagsTable tags={preview.tags} errors={rowErrs} caption="Preview of effective tags" empty={preview.errors.length ? 'Fix the parameter values to see the tags.' : 'The profile has no tags.'} />
        </FormSection>
      </div>
    </Dialog>
  );
}
