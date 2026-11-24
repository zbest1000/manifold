import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { Input, Field } from '@/components/ui';
import AssetPathField from './AssetPathField';
import { ProfileSource, ProfileDestination } from './ProfileParts';
import { SELECT_CLS } from './wizardModel';

const help = 'text-xs leading-snug text-slate-400';

export function FieldError({ errors }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="mt-2 space-y-1">
      {[...new Set(errors.map((e) => e.message))].map((m) => (
        <li key={m} className="text-xs text-rose-300">{m}</li>
      ))}
    </ul>
  );
}

const LAYOUTS = [
  { v: 'topic-per-tag', t: 'One topic per tag', d: 'Each tag has its own topic, so a subscriber can follow a single value. Costs one message and one topic per tag.' },
  { v: 'object-per-asset', t: 'One object per asset', d: 'One JSON object on the asset path with every tag and its quality. One message gives a consistent snapshot, but it is resent whenever any tag changes and is capped in size.' }
];

/** Step 1: name, broker, how to publish, where (asset path / profile template) and the layout. */
export default function TargetStep({ name, setName, mode, setMode, form, set, brokers, srcType, rows, errors, pc }) {
  const destErrors = errors.filter((e) => e.field === 'dest');
  const otherErrors = errors.filter((e) => e.field !== 'dest');
  const isProfile = srcType === 'device-profile';
  return (
    <section aria-label="Target" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Binding name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="line1 motor tags" />
        </Field>
        <Field label="Target broker">
          <select value={form.brokerId} onChange={(e) => set({ brokerId: e.target.value })} className={SELECT_CLS}>
            {brokers.length === 0 && <option value="">no connected brokers</option>}
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Publish as" className="sm:col-span-2">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={SELECT_CLS} disabled={srcType === 'mqtt'}>
            <option value="mqtt">Plain MQTT topics (UNS)</option>
            {srcType !== 'mqtt' && <option value="sparkplug">Sparkplug B device (NBIRTH/DDATA)</option>}
          </select>
        </Field>
      </div>

      {isProfile && <ProfileSource {...pc.source} />}

      {mode === 'mqtt' && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">Destination</h4>
          {isProfile ? (
            <ProfileDestination
              profile={pc.profile}
              devices={pc.devices}
              devicesError={pc.devicesError}
              onRetryDevices={pc.retryDevices}
              form={form}
              set={set}
              error={destErrors[0]?.message}
            />
          ) : (
            <AssetPathField form={form} set={set} mqttSource={srcType === 'mqtt'} error={destErrors[0]?.message} />
          )}
        </div>
      )}

      {mode === 'mqtt' && srcType !== 'mqtt' && (
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Layout</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {LAYOUTS.map((o) => (
              <label key={o.v} className={clsx('flex cursor-pointer items-start gap-2 rounded-xl border p-3', form.layout === o.v ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/10 hover:bg-white/5')}>
                <input type="radio" name="layout" value={o.v} checked={form.layout === o.v} onChange={() => set({ layout: o.v })} className="mt-0.5 accent-accent-500" />
                <span className="text-sm text-slate-100">
                  {o.t}
                  <span className={clsx(help, 'block')}>{o.d}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {mode === 'sparkplug' && (
        <p className={help}>Sparkplug output uses a dedicated session with a proper NBIRTH/NDEATH lifecycle. Group, edge node and device are set in the next step.</p>
      )}
      {srcType === 'mqtt' && (
        <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-100">
          <b>This creates a pipeline route, not a binding.</b> The topics are re-published under your base path by the pipeline engine, so deadband, heartbeat, per-tag names and units, Sparkplug
          output and a direct historian target are not available, and the result is managed under <Link to="/pipelines" className="underline">Pipelines, Routes</Link> (not in the Bindings table).
        </p>
      )}
      {!isProfile && <p className={help}>{rows.length} selected.</p>}
      <FieldError errors={otherErrors} />
    </section>
  );
}
