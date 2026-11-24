import clsx from 'clsx';
import { TriangleAlert } from 'lucide-react';
import { cycleHealth, formatMs, exceptionName } from '@/lib/deviceStatus';

const BAR = { ok: 'bg-emerald-400/80', overrun: 'bg-amber-400', slowed: 'bg-rose-400' };
const TEXT = { ok: 'text-slate-300', overrun: 'text-amber-300', slowed: 'text-rose-300' };

/** One poll group: cycle time against its interval as a bar, plus slowdown / overrun callouts. */
function GroupRow({ id, group, configured, online }) {
  const h = cycleHealth(group || { intervalMs: configured });
  const pct = Math.min(100, Math.round(h.ratio * 100));
  const warn = h.level !== 'ok';
  return (
    <li className={clsx('rounded-lg px-2.5 py-1.5 text-xs', warn && online ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/25' : 'bg-white/[0.03]', !online && 'opacity-60')} data-group={id} data-health={online ? h.level : 'idle'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="mono font-medium text-slate-200">{id}</span>
        <span className="mono text-slate-400">every {formatMs(h.interval)}</span>
        {h.level === 'slowed' && (
          <span className="inline-flex items-center gap-1 font-medium text-rose-300">
            <TriangleAlert size={12} aria-hidden="true" /> slowed to {formatMs(h.effective)}
          </span>
        )}
        <span className={clsx('ml-auto', h.overruns ? 'text-amber-300' : 'text-slate-500')}>
          {h.overruns} overrun{h.overruns === 1 ? '' : 's'}
        </span>
      </div>
      {group ? (
        <div className="mt-1.5 flex items-center gap-2">
          <div role="meter" aria-label={`Cycle time of ${id} against its interval`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${formatMs(h.avg)} average of ${formatMs(h.effective)}`} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className={clsx('h-full rounded-full transition-all', BAR[h.level])} style={{ width: `${Math.max(pct, 2)}%` }} />
          </div>
          <span className={clsx('mono shrink-0', TEXT[h.level])}>
            {formatMs(h.avg)} avg / {formatMs(h.effective)} <span className="text-slate-500">· last {formatMs(h.last)}</span>
          </span>
        </div>
      ) : (
        <p className="mt-1 text-2xs text-slate-500">No cycle statistics yet.</p>
      )}
      {h.level === 'overrun' && <p className="mt-1 text-2xs text-amber-300">Cycles take longer than the interval; overlapping cycles are skipped, not queued.</p>}
    </li>
  );
}

/** Counters worth a glance: connects, requests, timeouts and device exceptions in plain language. */
export function Counters({ status, protocol }) {
  const exc = Object.entries(status?.exceptions || {});
  const stat = (label, value, warn) => (
    <span className={clsx('rounded-md px-1.5 py-0.5', warn ? 'bg-amber-500/15 text-amber-200' : 'bg-white/5 text-slate-300')}>
      {label} <span className="mono font-semibold">{value ?? 0}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-2xs" aria-label="Polling counters">
      {stat('Connects', status?.connects, (status?.connects || 0) > 3)}
      {stat('Requests', status?.requests)}
      {stat('Timeouts', status?.timeouts, (status?.timeouts || 0) > 0)}
      {exc.map(([code, n]) => (
        <span key={code} className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-200" title={`Code ${code}`}>
          {exceptionName(protocol, code)} <span className="mono font-semibold">x{n}</span>
        </span>
      ))}
    </div>
  );
}

export default function PollHealth({ device, status, online = true, offlineLabel = '' }) {
  return (
    <div className="mt-3 space-y-2">
      {!online && <p className="text-2xs text-amber-300">Not polling right now{offlineLabel ? ` (${offlineLabel})` : ''}. The figures below are from the last connection.</p>}
      <ul className="space-y-1.5" aria-label={`Poll groups of ${device.name}`}>
        {(device.pollGroups || []).map((g) => <GroupRow key={g.id} id={g.id} group={status?.groups?.[g.id]} configured={g.intervalMs} online={online} />)}
      </ul>
      <Counters status={status} protocol={device.protocol} />
    </div>
  );
}
