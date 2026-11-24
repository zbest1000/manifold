import { Fragment, useState } from 'react';
import { ChevronRight, Pencil, Trash2, Eye } from 'lucide-react';
import clsx from 'clsx';
import { Table, THead, TableSort, Th, Tr, Td, IconButton, StatusText, Timestamp, Path, useConfirm } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import BindingDetail from './BindingDetail';
import { READ_ONLY_REASON } from '@/store/selectors';
import { MiniSwitch } from './editor/parts';
import { layoutLabel, instanceCount } from './bindingView';

const SOURCE_TYPE = { device: 'Device', 'device-profile': 'Profile', opcua: 'OPC UA', sparkplug: 'Sparkplug' };

export function sourceLabel(b, sources, profiles = []) {
  const s = b.source || {};
  if (s.type === 'device-profile') {
    const p = profiles.find((x) => x.id === s.profileId);
    return { type: 'profile', label: p ? p.name : s.profileId || '?', connected: Boolean(p) };
  }
  const id = s.type === 'opcua' ? s.connectionId : s.type === 'sparkplug' ? s.brokerId : s.deviceId ?? s.connectionId;
  const found = sources.find((x) => x.type === s.type && x.id === id);
  const scope = s.type === 'sparkplug' ? ` ${s.group}/${s.edge}${s.device ? `/${s.device}` : ''}` : '';
  return { type: s.type, label: `${found?.label || id || '?'}${scope}`, connected: Boolean(found) };
}

export function targetLabel(b) {
  const t = b.target || {};
  return t.mode === 'sparkplug' ? `spBv1.0/${t.group}/*/${t.edge}/${t.device || '(mapping name)'}` : t.assetPath || t.assetPathTemplate || t.pathTemplate || (t.assetPaths ? '(per-instance paths)' : '');
}

/** "24", "all", "all by rule", "12 × 3". */
function tagCount(b, profiles) {
  const s = b.source || {};
  let n;
  if (Array.isArray(s.tags)) {
    const on = s.tags.filter((t) => typeof t === 'string' || t.enabled !== false).length;
    n = on === s.tags.length ? String(on) : `${on} of ${s.tags.length}`;
  } else if (Array.isArray(s.metrics)) n = String(s.metrics.length);
  else n = s.select ? 'by rule' : 'all';
  if (s.type !== 'device-profile') return n;
  const inst = instanceCount(b, profiles);
  return inst === null ? n : `${n} × ${inst}`;
}

const SORT = {
  name: (b) => (b.name || b.id).toLowerCase(),
  state: (b, ctx) => (b.enabled === false ? 3 : ctx.status[b.id]?.lastError ? 0 : ctx.status[b.id]?.sourceState?.state === 'online' ? 2 : 1),
  published: (b, ctx) => ctx.status[b.id]?.published || 0,
  last: (b, ctx) => ctx.status[b.id]?.lastTs || 0
};

/**
 * Mappings as a sortable table: state with its reason, target, tag count, activity, last publish,
 * last error and row actions. A row expands to its full detail (resolved topics, Show in UNS).
 */
export default function BindingsTable({ bindings, status, sources, profiles = [], historians = [], editingId, highlightId, onEdit, onToggleEnabled, onDelete, busyId, readOnly = false }) {
  const [open, setOpen] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [confirm, confirmDialog] = useConfirm();
  const toggleOpen = (id) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const ctx = { status };
  const rows = sortRows(bindings, sort, Object.fromEntries(Object.entries(SORT).map(([k, f]) => [k, (b) => f(b, ctx)])));

  const remove = async (b) => {
    const label = b.name || b.id.slice(0, 8);
    const ok = await confirm({
      title: `Delete ${label}?`,
      message: 'The mapping stops publishing and its retained topics are cleared. The device is not touched.',
      confirmLabel: 'Delete mapping',
      danger: true
    });
    if (ok) onDelete(b);
  };

  return (
    <>
      <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
        <Table caption="Tag mappings" className="min-w-[54rem]">
          <THead>
            <Th sortKey="name">Mapping</Th>
            <Th sortKey="state">State</Th>
            <Th>Publishes to</Th>
            <Th align="right">Tags</Th>
            <Th sortKey="published" align="right">
              Published
            </Th>
            <Th sortKey="last" align="right">
              Last publish
            </Th>
            <Th srOnly align="right">
              Actions
            </Th>
          </THead>
          <tbody>
            {rows.map((b) => {
              const s = status[b.id] || {};
              const src = sourceLabel(b, sources, profiles);
              const isOpen = open.has(b.id);
              const enabled = b.enabled !== false;
              const label = b.name || b.id.slice(0, 8);
              const online = s.sourceState?.state === 'online';
              const errors = s.errors || 0;
              return (
                <Fragment key={b.id}>
                  <Tr highlight={editingId === b.id || highlightId === b.id} className={clsx(!enabled && 'text-muted')}>
                    <Td header className="max-w-[18rem]">
                      <button
                        type="button"
                        onClick={() => toggleOpen(b.id)}
                        aria-expanded={isOpen}
                        aria-controls={`binding-detail-${b.id}`}
                        className="-ml-1 flex max-w-full items-center gap-1 rounded px-1 text-left font-medium text-fg hover:text-accent-text"
                      >
                        <ChevronRight size={14} aria-hidden="true" className={clsx('shrink-0 text-subtle transition-transform duration-150', isOpen && 'rotate-90')} />
                        <span className="truncate">{label}</span>
                      </button>
                      <span className="block truncate pl-5 text-xs text-muted" title={src.label}>
                        {SOURCE_TYPE[b.source?.type] || b.source?.type} · {src.label}
                        {!src.connected && ' (not connected)'}
                      </span>
                    </Td>
                    <Td className="max-w-[16rem]">
                      {!enabled ? (
                        <StatusText tone="neutral">Disabled</StatusText>
                      ) : s.sourceState ? (
                        <StatusText tone={online ? 'good' : s.sourceState.reason ? 'bad' : 'neutral'}>{online ? 'Publishing' : 'Source offline'}</StatusText>
                      ) : (
                        <StatusText tone="neutral">Waiting</StatusText>
                      )}
                      {enabled && s.lastError ? (
                        <button type="button" onClick={() => toggleOpen(b.id)} className="block max-w-full truncate text-left text-xs text-bad hover:underline" title={s.lastError}>
                          {errors > 1 && <span className="font-mono">{errors.toLocaleString()} × </span>}
                          {s.lastError}
                        </button>
                      ) : (
                        enabled &&
                        !online &&
                        s.sourceState?.reason && (
                          <span className="mono block truncate text-xs text-subtle" title={s.sourceState.reason}>
                            {s.sourceState.reason}
                          </span>
                        )
                      )}
                    </Td>
                    <Td className="max-w-[18rem]">
                      <Path value={targetLabel(b)} />
                      <span className="block text-xs text-subtle">
                        {layoutLabel(b)}
                        {b.target?.mode === 'mqtt' ? ` · ${b.target.format || 'plain'}` : ''}
                        {b.target?.historian ? ' · history' : ''}
                      </span>
                    </Td>
                    <Td align="right" className="whitespace-nowrap font-mono text-xs tabular-nums">
                      {tagCount(b, profiles)}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <span className="font-mono text-xs tabular-nums">{(s.published || 0).toLocaleString()}</span>
                      {s.suppressed > 0 && <span className="block font-mono text-2xs text-subtle">{s.suppressed.toLocaleString()} held back</span>}
                    </Td>
                    <Td align="right" className="text-xs text-muted">
                      {s.lastTs ? <Timestamp value={s.lastTs} /> : 'never'}
                    </Td>
                    <Td align="right" className="w-28 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <MiniSwitch
                          checked={enabled}
                          disabled={busyId === b.id || readOnly}
                          label={`${enabled ? 'Disable' : 'Enable'} mapping ${label}`}
                          title={readOnly ? READ_ONLY_REASON : enabled ? 'Publishing is on' : 'Publishing is off'}
                          onChange={() => onToggleEnabled(b)}
                        />
                        <IconButton icon={readOnly ? Eye : Pencil} size={14} label={`${readOnly ? 'View' : 'Edit'} mapping ${label}`} onClick={() => onEdit(b)} />
                        <IconButton icon={Trash2} size={14} label={`Delete mapping ${label}`} className="hover:bg-bad/10 hover:text-bad" disabled={readOnly} onClick={() => remove(b)} />
                      </span>
                    </Td>
                  </Tr>
                  {isOpen && (
                    <tr id={`binding-detail-${b.id}`} className="border-t border-line bg-app">
                      <td colSpan={7} className="px-4 py-3">
                        <BindingDetail binding={b} status={s} src={src} historians={historians} profiles={profiles} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </TableSort>
      {confirmDialog}
    </>
  );
}

