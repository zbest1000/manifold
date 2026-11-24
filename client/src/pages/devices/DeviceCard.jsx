import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, Waypoints, AlertTriangle } from 'lucide-react';
import { Card, Badge, IconButton } from '@/components/ui';
import { deviceBadge } from '@/lib/deviceStatus';
import PollHealth from './PollHealth';
import { ExperimentalBadge } from './ProtocolNotices';

function DeviceCardImpl({ device, live, host, protocolLabel, experimental, onEdit, onDelete, onToggle, busy }) {
  const b = deviceBadge(device, device.status, live, host);
  const st = { ...(device.status || {}), ...(live || {}) };
  const quarantined = device.status?.quarantined || [];
  const le = device.status?.lastError;
  const lastError = le && typeof le === 'object' ? le.message || JSON.stringify(le) : le;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
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
            <span className="text-slate-500"> · {device.tags?.length ?? device.status?.tagCount ?? 0} tags</span>
          </p>
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

      {(quarantined.length > 0 || lastError) && (
        <div className="mt-3 space-y-1 text-xs">
          {quarantined.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-amber-300">
              <AlertTriangle size={13} aria-hidden="true" />
              <span className="font-medium">{quarantined.length} quarantined tag{quarantined.length === 1 ? '' : 's'}</span>
              <span className="mono break-all text-slate-400">{quarantined.join(', ')}</span>
            </p>
          )}
          {lastError && (
            <p className="break-words text-rose-300">
              <span className="font-medium">Last error: </span>
              {lastError}
              {st.since && st.state !== 'online' && <span className="text-rose-300/60"> (offline since {new Date(st.since).toLocaleTimeString()})</span>}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export default memo(DeviceCardImpl);
