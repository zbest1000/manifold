import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, Waypoints, AlertTriangle } from 'lucide-react';
import { Card, Badge, IconButton } from '@/components/ui';
import { deviceBadge, quarantineList, quarantineSummary, quarantineReasonText, relativeTime } from '@/lib/deviceStatus';
import { resolveParams } from '@/lib/deviceProfiles';
import { FromProfileBadge } from './EffectiveTagsTable';
import PollHealth from './PollHealth';
import { ExperimentalBadge } from './ProtocolNotices';

function DeviceCardImpl({ device, live, host, profile, protocolLabel, experimental, onEdit, onDelete, onToggle, busy }) {
  const b = deviceBadge(device, device.status, live, host);
  const st = { ...(device.status || {}), ...(live || {}) };
  const quarantined = quarantineList(device.status);
  const le = device.status?.lastError;
  const lastError = le && typeof le === 'object' ? le.message || JSON.stringify(le) : le;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-[14rem] flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-100">{device.name}</h2>
            <Badge status={b.status}>{b.label}</Badge>
            <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-2xs font-medium text-slate-300">{protocolLabel}</span>
            {experimental && <ExperimentalBadge />}
          </div>
          <p className="mono mt-1 text-xs text-slate-400">
            {device.host}:{device.port}
            {device.unitId !== undefined && <span className="text-slate-500"> · unit {device.unitId}</span>}
            {device.rack !== undefined && device.slot !== undefined && <span className="text-slate-500"> · rack {device.rack} / slot {device.slot}</span>}
            {device.protocol === 'ethernet-ip' && device.slot !== undefined && <span className="text-slate-500"> · slot {device.slot}</span>}
            <span className="text-slate-500"> · {device.tags?.length ?? device.status?.tagCount ?? 0} tags{device.profileId ? ` (${device.ownTags?.length || 0} own)` : ''}</span>
          </p>
          {device.profileId && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
              <FromProfileBadge />
              <Link className="text-accent-400 underline-offset-2 hover:underline" to={`/devices?tab=profiles&profile=${encodeURIComponent(device.profileId)}`}>{profile?.name || device.profileId}</Link>
              {Object.entries(profile ? resolveParams(profile, device.params).values : device.params || {}).map(([k, v]) => <span key={k} className="mono rounded bg-white/5 px-1.5 py-0.5 text-2xs text-slate-300">{k}={String(v)}</span>)}
            </p>
          )}
          {b.detail && b.key !== 'backoff' && <p className="mt-1 text-xs text-slate-500">{b.detail}</p>}
          {st.since && b.key !== 'disabled' && <p className="mt-0.5 text-2xs text-slate-600">since {new Date(st.since).toLocaleTimeString()}</p>}
        </div>
        <div className="flex items-center gap-1">
          <label className="mr-1 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" role="switch" className="h-4 w-4 accent-sky-500" checked={device.enabled} disabled={busy} onChange={() => onToggle(device)} aria-label={`${device.enabled ? 'Disable' : 'Enable'} ${device.name}`} />
            {device.enabled ? 'Enabled' : 'Disabled'}
          </label>
          <Link
            to={`/tags?source=device:${encodeURIComponent(device.id)}`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/5"
          >
            <Waypoints size={14} aria-hidden="true" /> Map to UNS
          </Link>
          <IconButton icon={Pencil} label={`Edit ${device.name}`} onClick={() => onEdit(device)} />
          <IconButton icon={Trash2} label={`Delete ${device.name}`} onClick={() => onDelete(device)} disabled={busy} />
        </div>
      </div>

      {device.enabled && <PollHealth device={device} status={st} online={b.key === 'online'} offlineLabel={b.label} />}

      {device.profileErrors?.length > 0 && (
        <div role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <p className="font-medium">This device does not match its profile, so it is not polling:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{device.profileErrors.map((e, i) => <li key={i}>{e.key ? <span className="mono">{e.key}: </span> : null}{e.error}</li>)}</ul>
        </div>
      )}

      {(quarantined.length > 0 || lastError) && (
        <div className="mt-3 space-y-1 text-xs">
          {quarantined.length > 0 && (
            quarantined.length === 1 ? (
              <p className="flex items-start gap-1.5 text-amber-300">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="font-medium">{quarantineSummary(device.status)}{quarantined[0].since ? <span className="font-normal text-slate-500"> · {relativeTime(quarantined[0].since)}</span> : null}</span>
              </p>
            ) : (
            <details className="text-amber-300">
              <summary className="flex cursor-pointer flex-wrap items-center gap-1.5">
                <AlertTriangle size={13} aria-hidden="true" />
                <span className="font-medium">{quarantineSummary(device.status)}</span>
              </summary>
              <ul className="mt-1 space-y-0.5 pl-5 text-slate-300">
                {quarantined.map((q) => (
                  <li key={q.key}><span className="mono">{q.key}</span>{quarantineReasonText(q) ? `: ${quarantineReasonText(q)}` : ''}{q.since ? <span className="text-slate-500"> ({relativeTime(q.since)})</span> : null}</li>
                ))}
              </ul>
            </details>
            )
          )}
          {lastError && (
            <p className="break-words text-rose-300">
              <span className="font-medium">Last error: </span>
              {lastError}
              {device.status?.lastErrorAt && <span className="text-rose-300/70" title={new Date(device.status.lastErrorAt).toLocaleString()}> · {relativeTime(device.status.lastErrorAt)}</span>}
              {st.since && st.state !== 'online' && <span className="text-rose-300/60"> (offline since {new Date(st.since).toLocaleTimeString()})</span>}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export default memo(DeviceCardImpl);
