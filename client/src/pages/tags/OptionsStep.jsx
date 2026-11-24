import { useState } from 'react';
import clsx from 'clsx';
import { Input, Field } from '@/components/ui';
import HistorianSection from './HistorianSection';
import { FieldError } from './TargetStep';
import { SELECT_CLS } from './wizardModel';
import { DEADBAND_HELP } from './bindingForm';

const help = 'text-xs leading-snug text-slate-400';

/** Step 3: delivery (QoS, retain), report by exception, direct history and Advanced. */
export default function OptionsStep({ mode, srcType, form, set, errors, hist }) {
  const isMqttTarget = mode === 'mqtt';
  const [adv, setAdv] = useState(form.maxObjectBytes !== '');
  return (
    <section aria-label="Options" className="space-y-4">
      {isMqttTarget && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="QoS">
            <select value={form.qos} onChange={(e) => set({ qos: e.target.value })} className={SELECT_CLS}>
              <option value={0}>0 - at most once (default)</option>
              <option value={1}>1 - at least once</option>
              <option value={2}>2 - exactly once</option>
            </select>
          </Field>
          {srcType === 'opcua' && (
            <Field label="Sampling interval (ms)">
              <Input type="number" min={50} value={form.samplingInterval} onChange={(e) => set({ samplingInterval: e.target.value })} />
            </Field>
          )}
        </div>
      )}

      {srcType !== 'mqtt' && (
        <fieldset className="space-y-3 rounded-xl border border-white/10 px-3 py-2.5">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">Report by exception</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Deadband type">
              <select value={form.dbType} onChange={(e) => set({ dbType: e.target.value })} className={SELECT_CLS}>
                <option value="absolute">Absolute (units)</option>
                <option value="percent">Percent</option>
              </select>
            </Field>
            <Field label={form.dbType === 'percent' ? 'Deadband (%)' : 'Deadband (units)'}>
              <Input inputMode="decimal" value={form.dbValue} onChange={(e) => set({ dbValue: e.target.value })} placeholder={form.dbType === 'percent' ? '2' : '0.5'} />
            </Field>
            <Field label="Heartbeat (ms, 0 = off)">
              <Input inputMode="numeric" value={form.heartbeatMs} onChange={(e) => set({ heartbeatMs: e.target.value })} placeholder="60000" />
            </Field>
          </div>
          <p className={help}>{DEADBAND_HELP[form.dbType]}</p>
          <p className={help}>
            The heartbeat republishes an unchanged value at least this often (minimum 1000 ms), so consumers can tell &quot;unchanged&quot; from &quot;dead&quot;.
          </p>
        </fieldset>
      )}

      {isMqttTarget && (
        <label className="flex items-start gap-2 text-sm text-slate-100">
          <input type="checkbox" checked={form.retain} onChange={(e) => set({ retain: e.target.checked })} className="mt-1 accent-accent-500" />
          <span>
            Retain values
            <span className={clsx(help, 'block')}>
              Off by default. A retained message outlives a dead device, so new subscribers would see an old value as current. Turn it on
              only for slow-changing values, and keep the status topic on.
            </span>
          </span>
        </label>
      )}

      {srcType !== 'mqtt' && <HistorianSection {...hist} form={form} set={set} />}

      {isMqttTarget && form.layout === 'object-per-asset' && (
        <details open={adv} onToggle={(e) => setAdv(e.currentTarget.open)} className="rounded-xl border border-white/10 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">Advanced</summary>
          <div className="mt-2">
            <Field label="Maximum object size (bytes, optional)">
              <Input inputMode="numeric" value={form.maxObjectBytes} onChange={(e) => set({ maxObjectBytes: e.target.value })} placeholder="65536" />
            </Field>
            <p className={`${help} mt-1`}>Default 65536 (64 KB), allowed 1024 to 1048576. The server rejects a binding whose worst-case object would exceed it.</p>
          </div>
        </details>
      )}
      <FieldError errors={errors} />
    </section>
  );
}
