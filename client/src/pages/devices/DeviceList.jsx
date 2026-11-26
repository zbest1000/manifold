import { memo, useMemo, useState } from 'react';
import { Pencil, Trash2, Waypoints, Search } from 'lucide-react';
import { Input, Select, SegmentedControl, StatusText, Timestamp, IconButton, Toggle, Table, THead, TableSort, Th, Tr, Td, EmptyState, Button } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { nextSort, sortRows } from '@/lib/sortRows';
import { deviceStateView, lastErrorInfo, pollSummary, cycleLevelText, formatMs, quarantineList, hostFor } from '@/lib/deviceStatus';
import { CycleMeter } from './PollHealth';
import { ExperimentalBadge } from './FormControls';

const SORTS = {
  name: (r) => r.d.name,
  state: (r) => r.view.rank,
  protocol: (r) => r.protocolLabel,
  tags: (r) => r.tagCount,
  polling: (r) => (r.poll ? r.poll.ratio + (r.poll.level === 'slowed' ? 10 : r.poll.level === 'overrun' ? 5 : 0) : null),
  quarantined: (r) => r.quarantined,
  error: (r) => (r.error ? Date.parse(r.error.at) || r.error.at || 1 : null)
};

/** Everything the table needs about one device, computed once per render of the list. */
function toRow(d, live, host, labels) {
  const st = { ...(d.status || {}), ...(live || {}) };
  const view = deviceStateView(d, d.status, live, host);
  return {
    d,
    view,
    protocolLabel: labels[d.protocol] || d.protocol,
    tagCount: d.tags?.length ?? d.status?.tagCount ?? 0,
    poll: d.enabled !== false && view.key === 'online' ? pollSummary(st) : null,
    quarantined: quarantineList(d.status).length,
    error: lastErrorInfo(d.status)
  };
}

const matches = (r, text) => {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return `${r.d.name} ${r.d.host}:${r.d.port} ${r.protocolLabel} ${r.view.label}`.toLowerCase().includes(t);
};

const FILTERS = [
  ['all', 'All', () => true],
  ['online', 'Online', (r) => r.view.key === 'online'],
  ['problems', 'Problems', (r) => r.view.key !== 'online' && r.view.key !== 'disabled'],
  ['disabled', 'Disabled', (r) => r.view.key === 'disabled']
];

const RowImpl = memo(function Row({ r, selected, experimental, profileName, busy, readOnly, onOpen, onEdit, onMap, onDelete, onToggle }) {
  const { d, view, poll } = r;
  const why = readOnly ? READ_ONLY_REASON : undefined;
  const nameOf = d.name;
  const endpoint = `${d.host}:${d.port}`;
  const extra = d.unitId !== undefined ? `unit ${d.unitId}` : d.rack !== undefined && d.slot !== undefined ? `rack ${d.rack} / slot ${d.slot}` : d.protocol === 'ethernet-ip' && d.slot !== undefined ? `slot ${d.slot}` : d.protocol === 'bacnet-ip' && d.deviceInstance !== undefined ? `device ${d.deviceInstance}${d.network ? ` · net ${d.network}` : ''}` : d.protocol === 'snmp' ? `SNMP v${d.version || '2c'}` : '';
  return (
    <Tr highlight={selected} className="cursor-pointer" onClick={(e) => !e.target.closest('a,button,input,label') && onOpen(d)} data-device={d.id}>
      <Td header className="max-w-[9.5rem] md:max-w-[14rem]">
        <button type="button" onClick={() => onOpen(d)} className="block max-w-full truncate rounded text-left text-sm font-medium text-fg hover:text-accent-text" title={nameOf}>
          {nameOf}
        </button>
        <span className="mono block truncate text-xs text-muted" title={endpoint}>
          {endpoint}
          {extra && <span className="text-subtle"> · {extra}</span>}
        </span>
      </Td>
      <Td className="max-w-[10rem]">
        <StatusText tone={view.tone}>{view.label}</StatusText>
        {view.reason && view.key === 'stopped' && (
          <span className="mono block truncate text-xs text-subtle" title={view.reason}>
            {view.reason}
          </span>
        )}
      </Td>
      <Td className="hidden lg:table-cell">
        <span className="block whitespace-nowrap text-sm text-fg">{r.protocolLabel}</span>
        {experimental && <ExperimentalBadge className="mt-0.5" />}
        {profileName && <span className="block max-w-[10rem] truncate text-xs text-subtle">from {profileName}</span>}
      </Td>
      <Td align="right" className="hidden tabular-nums lg:table-cell">{r.tagCount.toLocaleString()}</Td>
      <Td className="hidden xl:table-cell">
        {poll ? (
          <div data-health={poll.level}>
            <div className="flex items-center gap-2">
              <CycleMeter h={poll} label={`Poll cycle of ${nameOf} against its interval`} className="w-14 shrink-0" />
              <span className="whitespace-nowrap text-xs tabular-nums text-muted">
                {formatMs(poll.avg)} / {formatMs(poll.effective)}
              </span>
            </div>
            {poll.level !== 'ok' && <span className="block text-xs text-warn">{cycleLevelText(poll)}</span>}
          </div>
        ) : (
          <span className="text-xs text-faint">{d.enabled === false ? '—' : view.key === 'online' ? 'No cycles yet' : 'Not polling'}</span>
        )}
      </Td>
      <Td align="right" className="hidden lg:table-cell">
        <span className="inline-block pl-6">
        {r.quarantined > 0 ? (
          <button type="button" onClick={() => onOpen(d, { tab: 'tags', chip: 'quarantined' })} aria-label={`${r.quarantined} quarantined tags on ${nameOf}, show them`} className="rounded px-1 tabular-nums text-warn underline decoration-dotted underline-offset-2 hover:bg-warn/10">
            {r.quarantined.toLocaleString()}
          </button>
        ) : (
          <span className="tabular-nums text-faint">0</span>
        )}
        </span>
      </Td>
      <Td className="hidden max-w-[13rem] min-[1400px]:table-cell">
        {r.error ? (
          <>
            <span className="block truncate text-xs text-bad" title={r.error.message}>
              {r.error.message}
            </span>
            {r.error.at && (
              <span className="block text-xs text-subtle">
                <Timestamp value={r.error.at} />
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-faint">—</span>
        )}
      </Td>
      <Td align="right" className="whitespace-nowrap">
        <span className="inline-flex items-center justify-end gap-0.5">
          <span title={why} className="mr-1.5 inline-flex">
            <Toggle
              checked={d.enabled}
              disabled={busy || readOnly}
              onChange={() => onToggle(d)}
              label={`Poll ${nameOf}`}
              className="[&>span:last-child]:sr-only"
            />
          </span>
          <span className="hidden items-center gap-0.5 md:inline-flex">
            <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} ${nameOf}`} size={14} onClick={() => onEdit(d)} />
            <IconButton icon={Waypoints} label={`Map ${nameOf} to UNS`} size={14} onClick={() => onMap(d)} />
            <IconButton icon={Trash2} label={`Delete ${nameOf}`} size={14} className="hover:bg-bad/10 hover:text-bad" onClick={() => onDelete(d)} disabled={busy || readOnly} title={why} />
          </span>
        </span>
      </Td>
    </Tr>
  );
});

/**
 * The device table (docs/design/ui-design-system.md, Page patterns): sortable, filterable, dense. State,
 * poll health, quarantined tags and the last error scan down the page; a row opens the detail.
 */
export default function DeviceList({ devices, hosts, deviceStates, labels, experimental, profileById, selectedId, busyId, readOnly, onOpen, onEdit, onDelete, onToggle, onMap }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('all');
  const [protocol, setProtocol] = useState('');

  const rows = useMemo(() => devices.map((d) => toRow(d, deviceStates[d.id], hostFor(d, hosts), labels)), [devices, deviceStates, hosts, labels]);
  const protocolsHere = useMemo(() => [...new Set(devices.map((d) => d.protocol))], [devices]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([id, , fn]) => [id, rows.filter(fn).length])), [rows]);
  const shown = useMemo(() => {
    const pass = FILTERS.find((f) => f[0] === filter)[2];
    return sortRows(rows.filter((r) => pass(r) && matches(r, text) && (!protocol || r.d.protocol === protocol)), sort, SORTS);
  }, [rows, filter, text, protocol, sort]);
  const filtering = Boolean(text.trim() || filter !== 'all' || protocol);
  const showToolbar = devices.length > 4;

  return (
    <div className="space-y-3">
      {showToolbar && (
        <div role="toolbar" aria-label="Filter devices" className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input aria-label="Filter devices" placeholder="Filter by name, host or state" value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
          </div>
          {protocolsHere.length > 1 && (
            <Select aria-label="Protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)} wrapperClassName="w-44">
              <option value="">All protocols</option>
              {protocolsHere.map((p) => (
                <option key={p} value={p}>
                  {labels[p] || p}
                </option>
              ))}
            </Select>
          )}
          <SegmentedControl label="State" value={filter} onChange={setFilter} options={FILTERS.map(([id, label]) => ({ value: id, label: `${label} ${counts[id]}` }))} />
          <span className="ml-auto text-xs tabular-nums text-subtle" aria-live="polite">
            {filtering ? `${shown.length} of ${rows.length} devices` : `${rows.length} devices`}
          </span>
        </div>
      )}

      <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
        <Table caption="Devices" className="!min-w-0 md:!min-w-[48rem] [&_td]:px-2 [&_th]:px-2">
          <THead>
            <Th sortKey="name">Device</Th>
            <Th sortKey="state">State</Th>
            <Th sortKey="protocol" className="hidden lg:table-cell">Protocol</Th>
            <Th sortKey="tags" align="right" className="hidden lg:table-cell">Tags</Th>
            <Th sortKey="polling" className="hidden xl:table-cell">Poll cycle</Th>
            <Th sortKey="quarantined" align="right" className="hidden lg:table-cell">Quarantined</Th>
            <Th sortKey="error" className="hidden min-[1400px]:table-cell">Last error</Th>
            <Th srOnly align="right">Actions</Th>
          </THead>
          <tbody>
            {shown.map((r) => (
              <RowImpl
                key={r.d.id}
                r={r}
                selected={selectedId === r.d.id}
                experimental={experimental.has(r.d.protocol)}
                profileName={r.d.profileId ? profileById[r.d.profileId]?.name || r.d.profileId : ''}
                busy={busyId === r.d.id}
                readOnly={readOnly}
                onOpen={onOpen}
                onEdit={onEdit}
                onMap={onMap}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title="No devices match"
                    hint="Nothing fits the current filter."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setText('');
                          setFilter('all');
                          setProtocol('');
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableSort>
    </div>
  );
}
