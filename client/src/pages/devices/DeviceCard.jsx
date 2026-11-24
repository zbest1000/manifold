import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, Waypoints, AlertTriangle, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { Card, Badge, IconButton } from '@/components/ui';
import { deviceBadge, cycleHealth, formatMs } from '@/lib/deviceStatus';

const HEALTH_STYLE = {
  ok: 'text-slate-300',
  overrun: 'text-amber-300',
  slowed: 'text-rose-300'
};

function GroupRow({ id, group, configured }) {
  const h = cycleHealth(group || { intervalMs: configured });
  const warn = h.level !== 'ok';
  const text =
    h.level === 'slowed'
      ? `Slowed: running every ${formatMs(h.effective)} instead of ${formatMs(h.interval)}`
      : h.level === 'overrun'
        ? `Overrunning: cycles take longer than ${formatMs(h.interval)}`
        : 'Keeping up';
  return (
    <li className={clsx('flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1 text-xs', warn ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/25' : 'bg-white/[0.03]')}>
      <span className="mono font-medium text-slate-200">{id}</span>
      <span className={clsx('mono', HEALTH_STYLE[h.level])}>
        {group ? `${formatMs(h.avg)} avg / ${formatMs(h.effective)}` : `every ${formatMs(h.interval)}`}
      </span>
      {group && <span className="text-slate-500">last {formatMs(h.last)}</span>}
      <span className={clsx('inline-flex items-center gap-1', h.overruns ? 'text-amber-300' : 'text-slate-500')}>
        {h.overruns} overrun{h.overruns === 1 ? '' : 's'}
      </span>
      {warn && (
        <span className={clsx('inline-flex items-center gap-1 font-medium', HEALTH_STYLE[h.level])}>
          <TriangleAlert size={12} aria-hidden="true" /> {text}
        </span>
      )}
    </li>
  );
}

function DeviceCardImpl({ device, live, host, protocolLabel, onEdit, onDelete, onToggle, busy }) {
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
          </div>
          <p className="mono mt-1 text-xs text-slate-400">
            {device.host}:{device.port}
            {device.unitId !== undefined && <span className="text-slate-500"> · unit {device.unitId}</span>}
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

      {device.enabled && (
        <ul className="mt-3 space-y-1.5" aria-label={`Poll groups of ${device.name}`}>
          {(device.pollGroups || []).map((g) => (
            <GroupRow key={g.id} id={g.id} group={device.status?.groups?.[g.id]} configured={g.intervalMs} />
          ))}
        </ul>
      )}

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
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export default memo(DeviceCardImpl);
