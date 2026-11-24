import { useMemo } from 'react';
import { Input, Field } from '@/components/ui';
import clsx from 'clsx';
import ErrorBanner from './Banner';
import { SELECT_CLS } from './wizardModel';
import { instanceRows } from './profileModel';

const help = 'text-xs leading-snug text-slate-400';

/** Profile picker + which profile tags the binding covers. */
export function ProfileSource({ profiles, profile, onPickProfile, rows, selectedKeys, onToggle, onToggleAll, locked }) {
  return (
    <div className="space-y-3">
      <Field label="Device profile">
        <select value={profile?.id || ''} onChange={(e) => onPickProfile(e.target.value)} disabled={locked} className={SELECT_CLS}>
          {!profile && <option value="">choose a profile</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.instances?.length || 0} instance{p.instances?.length === 1 ? '' : 's'})</option>
          ))}
        </select>
      </Field>
      {profile && (
        <fieldset>
          <legend className="mb-1.5 flex w-full items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-400">
            <span>Profile tags ({selectedKeys.size} of {rows.length})</span>
            <button type="button" onClick={onToggleAll} className="rounded px-1.5 py-0.5 normal-case text-accent-300 hover:bg-white/10">
              {selectedKeys.size === rows.length ? 'Clear all' : 'Select all'}
            </button>
          </legend>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-white/5 p-1">
            {rows.map((r) => (
              <li key={r.key}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/5">
                  <input type="checkbox" checked={selectedKeys.has(r.key)} onChange={() => onToggle(r.key)} className="accent-accent-500" />
                  <span className="min-w-0 truncate font-mono text-slate-100">{r.defaultName}</span>
                  <span className="ml-auto shrink-0 text-slate-400">{[r.meta.type, r.meta.unit].filter(Boolean).join(' · ')}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className={`${help} mt-1`}>Tags added to the profile later are picked up automatically when all tags are selected.</p>
        </fieldset>
      )}
    </div>
  );
}

/** assetPathTemplate with placeholder chips, the per-instance preview table and optional per-instance overrides. */
export function ProfileDestination({ profile, devices, devicesError, onRetryDevices, form, set, error }) {
  const params = (profile?.params || []).map((p) => p.name);
  const chips = ['{device}', '{deviceId}', ...params.map((n) => `{${n}}`)];
  const rows = useMemo(
    () => instanceRows({ profile, devices, template: form.assetPathTemplate, overrides: form.assetPaths }),
    [profile, devices, form.assetPathTemplate, form.assetPaths]
  );
  const setOverride = (id, value) => set({ assetPaths: { ...form.assetPaths, [id]: value } });
  return (
    <div className="space-y-2">
      <Field label="Asset path template">
        <Input
          id="asset-path-template"
          value={form.assetPathTemplate}
          onChange={(e) => set({ assetPathTemplate: e.target.value })}
          placeholder="acme/dallas/{device}"
          className="font-mono"
          aria-invalid={Boolean(error) || undefined}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <span className={help}>Insert:</span>
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => set({ assetPathTemplate: `${form.assetPathTemplate.replace(/\/+$/, '')}${form.assetPathTemplate ? '/' : ''}${c}` })}
            aria-label={`Append ${c} to the template`}
            className="rounded-full bg-white/5 px-2.5 py-0.5 font-mono text-xs text-accent-200 ring-1 ring-inset ring-white/10 hover:bg-white/10"
          >
            {c}
          </button>
        ))}
      </div>
      <p className={help}>{'{device}'} is the device name, {'{deviceId}'} its id; other placeholders are the profile's parameters. Values are cleaned the same way tag names are.</p>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      {devicesError && <ErrorBanner title="Could not load the profile's instances" message={devicesError} onRetry={onRetryDevices} />}
      {devices && rows.length === 0 && <p className="text-xs text-amber-300">This profile has no instances yet. The binding will start publishing for each one you add on the Devices page.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/5">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Resolved asset path per instance</caption>
            <thead className="bg-surface-900 text-slate-400">
              <tr>
                <th scope="col" className="px-2.5 py-1.5 font-medium">Instance</th>
                <th scope="col" className="px-2.5 py-1.5 font-medium">Resolved asset path</th>
                <th scope="col" className="px-2.5 py-1.5 font-medium">Override (optional)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.deviceId}>
                  <th scope="row" className="px-2.5 py-1.5 font-medium text-slate-100">{r.name}</th>
                  <td className={clsx('px-2.5 py-1.5 font-mono', r.error ? 'text-rose-300' : 'text-slate-100')}>
                    <span className="break-all">{r.path || '-'}</span>
                    {r.error && <span className="block text-rose-300">{r.error}</span>}
                  </td>
                  <td className="px-2.5 py-1">
                    <input
                      value={form.assetPaths[r.deviceId] || ''}
                      onChange={(e) => setOverride(r.deviceId, e.target.value)}
                      aria-label={`Asset path override for ${r.name}`}
                      placeholder="use template"
                      className="w-full min-w-[9rem] rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent-500/30"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
