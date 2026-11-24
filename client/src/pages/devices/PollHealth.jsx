import { Meter, Stat, StatGroup, StatusText, Table, THead, Th, Tr, Td } from '@/components/ui';
import { cycleHealth, cycleLevelText, formatMs, exceptionName } from '@/lib/deviceStatus';

const METER_TONE = { ok: undefined, overrun: 'warn', slowed: 'warn' };

/**
 * One cycle as a compact gauge: average cycle time against the interval it must fit in. Shared by the
 * list (worst group) and the detail (every group). `h` is `cycleHealth()`.
 */
export function CycleMeter({ h, label, className }) {
  return <Meter value={h.avg} max={h.effective || h.interval || 1} warnAt={0.8} badAt={1} tone={METER_TONE[h.level]} label={label} className={className} />;
}

/** Poll groups of one device: interval, cycle time against it, overruns and a plain status. */
export default function PollGroupsHealth({ device, status, online }) {
  const groups = device.pollGroups || [];
  if (!groups.length) return <p className="text-sm text-muted">This device has no poll groups.</p>;
  return (
    <Table caption={`Poll groups of ${device.name}`} className="min-w-[36rem]">
      <THead>
        <Th>Group</Th>
        <Th align="right">Interval</Th>
        <Th className="w-56">Cycle time</Th>
        <Th align="right">Last</Th>
        <Th align="right">Overruns</Th>
        <Th>Status</Th>
      </THead>
      <tbody>
        {groups.map((g) => {
          const live = status?.groups?.[g.id];
          const h = cycleHealth(live || { intervalMs: g.intervalMs });
          const text = cycleLevelText(h);
          return (
            <Tr key={g.id} data-group={g.id} data-health={online ? h.level : 'idle'}>
              <Td header className="mono text-xs text-fg">{g.id}</Td>
              <Td align="right" className="tabular-nums">{formatMs(h.interval)}</Td>
              <Td>
                {live ? (
                  <div className="flex items-center gap-2">
                    <CycleMeter h={h} label={`Cycle time of ${g.id} against its interval`} className="min-w-0 flex-1" />
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {formatMs(h.avg)} <span className="text-subtle">avg</span>
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-subtle">No cycles yet</span>
                )}
              </Td>
              <Td align="right" className="tabular-nums text-muted">{live ? formatMs(h.last) : '—'}</Td>
              <Td align="right" className="tabular-nums">{h.overruns.toLocaleString()}</Td>
              <Td>
                {!online ? <span className="text-xs text-subtle">Not polling</span> : text ? <StatusText tone="warn" className="text-xs">{text}</StatusText> : live ? <span className="text-xs text-muted">On time</span> : null}
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Connects, requests and timeouts as one strip, then every device exception in plain words. */
export function Counters({ status, protocol }) {
  const exc = Object.entries(status?.exceptions || {});
  return (
    <div className="space-y-3">
      <StatGroup label="Polling counters" className="grid-cols-3">
        <Stat label="Connects" value={(status?.connects ?? 0).toLocaleString()} sub={(status?.connects || 0) > 3 ? 'reconnecting often' : undefined} tone={(status?.connects || 0) > 3 ? 'warn' : undefined} />
        <Stat label="Requests" value={(status?.requests ?? 0).toLocaleString()} />
        <Stat label="Timeouts" value={(status?.timeouts ?? 0).toLocaleString()} tone={(status?.timeouts || 0) > 0 ? 'warn' : undefined} />
      </StatGroup>
      {exc.length > 0 ? (
        <ul aria-label="Device exceptions" className="divide-y divide-line rounded-lg border border-line">
          {exc.map(([code, n]) => (
            <li key={code} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="text-fg">{exceptionName(protocol, code)}</span>
                <span className="ml-2 font-mono text-xs text-subtle">code {code}</span>
              </span>
              <span className="shrink-0 tabular-nums text-warn">{Number(n).toLocaleString()} time{n === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">The device has not answered with an exception.</p>
      )}
    </div>
  );
}
