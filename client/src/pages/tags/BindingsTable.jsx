import { Fragment, useState } from 'react';
import { ChevronRight, ChevronDown, Pencil, Trash2, Power } from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { Modal, Button, Badge, Card } from '@/components/ui';
import BindingDetail from './BindingDetail';
import { READ_ONLY_REASON } from '@/store/selectors';
import { layoutLabel, rbeLabel, instanceCount } from './bindingView';

function sourceLabel(b, sources, profiles = []) {
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

function targetLabel(b) {
  const t = b.target || {};
  return t.mode === 'sparkplug' ? `spBv1.0/${t.group}/*/${t.edge}/${t.device || '(binding name)'}` : t.assetPath || t.assetPathTemplate || t.pathTemplate || (t.assetPaths ? '(per-instance paths)' : '');
}

function tagCount(b, profiles) {
  const s = b.source || {};
  const n = Array.isArray(s.tags) ? s.tags.length : Array.isArray(s.metrics) ? s.metrics.length : 'all';
  if (s.type !== 'device-profile') return n;
  const inst = instanceCount(b, profiles);
  return `${n}${inst === null ? '' : ` x ${inst}`}`;
}

function historianName(b, historians) {
  const h = historians.find((x) => x.id === b.target.historian.historianId);
  return h ? h.name || h.id : `${b.target.historian.historianId} (missing)`;
}

function StateBadge({ state }) {
  if (!state) return <span className="text-xs text-slate-400">unknown</span>;
  const on = state.state === 'online';
  return (
    <span title={state.reason || undefined}>
      <Badge status={on ? 'connected' : 'offline'}>{on ? 'online' : 'offline'}</Badge>
    </span>
  );
}

/** Bindings as a real table. The expander row shows full source/target and the last error. */
export default function BindingsTable({ bindings, status, sources, profiles = [], historians = [], editingId, onEdit, onToggleEnabled, onDelete, busyId, readOnly = false }) {
  const [open, setOpen] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null);
  const toggleOpen = (id) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Card className="min-w-0 p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Tag bindings</caption>
          <thead className="border-b border-white/5 text-slate-400 [&_th]:whitespace-nowrap">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Name</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Source</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Target</th>
              <th scope="col" className="hidden px-3 py-2 font-medium 2xl:table-cell">Layout</th>
              <th scope="col" className="hidden px-3 py-2 font-medium 2xl:table-cell">Deadband / heartbeat</th>
              <th scope="col" className="hidden px-3 py-2 font-medium 2xl:table-cell">History</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title="Profile bindings show tags x instances">Tags</th>
              <th scope="col" className="px-3 py-2 font-medium" title="Published / suppressed / errors">Activity</th>
              <th scope="col" className="px-3 py-2 font-medium">Source state</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Last publish</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Last error</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((b) => {
              const s = status[b.id] || {};
              const src = sourceLabel(b, sources, profiles);
              const isOpen = open.has(b.id);
              const enabled = b.enabled !== false;
              const label = b.name || b.id.slice(0, 8);
              return (
                <Fragment key={b.id}>
                  <tr className={clsx('border-b border-white/5 align-top', editingId === b.id && 'bg-accent-500/5', !enabled && 'opacity-70')}>
                    <th scope="row" className="px-3 py-2 font-medium text-slate-100">
                      <button
                        type="button"
                        onClick={() => toggleOpen(b.id)}
                        aria-expanded={isOpen}
                        aria-controls={`binding-detail-${b.id}`}
                        className="flex items-center gap-1 text-left hover:text-white"
                      >
                        {isOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                        <span className="whitespace-nowrap">{label}</span>
                      </button>
                      {!enabled && <span className="ml-5 block text-xs font-normal text-amber-300">disabled</span>}
                    </th>
                    <td className="hidden max-w-[14rem] px-3 py-2 text-slate-300 md:table-cell">
                      <span className="mr-1 text-slate-400">{src.type}</span>
                      <span className="break-words">{src.label}</span>
                    </td>
                    <td className="hidden max-w-[22rem] px-3 py-2 font-mono text-slate-300 md:table-cell">
                      <span className="block truncate" title={targetLabel(b)}>{targetLabel(b)}</span>
                    </td>
                    <td className="hidden px-3 py-2 text-slate-300 2xl:table-cell">{layoutLabel(b)}</td>
                    <td className="hidden px-3 py-2 text-slate-300 2xl:table-cell">{rbeLabel(b) || 'none'}</td>
                    <td className="hidden px-3 py-2 text-slate-300 2xl:table-cell">{b.target?.historian ? historianName(b, historians) : 'none'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{tagCount(b, profiles)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-200" title="Published / suppressed / errors">
                      {s.published || 0} / {s.suppressed || 0} / <span className={s.errors ? 'text-rose-300' : ''}>{s.errors || 0}</span>
                    </td>
                    <td className="px-3 py-2"><StateBadge state={s.sourceState} /></td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-slate-300 lg:table-cell">
                      {s.lastTs ? <time dateTime={new Date(s.lastTs).toISOString()}>{formatDistanceToNow(s.lastTs, { addSuffix: true })}</time> : 'never'}
                    </td>
                    <td className="hidden max-w-[12rem] px-3 py-2 lg:table-cell">
                      {s.lastError ? (
                        <button type="button" onClick={() => toggleOpen(b.id)} className="block max-w-full truncate text-left text-amber-300 hover:underline" title="Show full error">
                          {s.lastError}
                        </button>
                      ) : (
                        <span className="text-slate-400">none</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onToggleEnabled(b)}
                          disabled={busyId === b.id || readOnly}
                          aria-pressed={enabled}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} binding ${label}`}
                          title={readOnly ? READ_ONLY_REASON : enabled ? 'Disable' : 'Enable'}
                          className={clsx('rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-40', enabled ? 'text-emerald-300' : 'text-slate-400')}
                        >
                          <Power size={14} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => onEdit(b)} aria-label={`${readOnly ? 'View' : 'Edit'} binding ${label}`} title={readOnly ? 'View (read-only session)' : 'Edit'} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-accent-300">
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => setConfirm(b)} disabled={readOnly} aria-label={`Delete binding ${label}`} title={readOnly ? READ_ONLY_REASON : 'Delete'} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-rose-300">
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={`binding-detail-${b.id}`} className="border-b border-white/5 bg-black/20">
                      <td colSpan={12} className="px-3 py-2.5">
                        <BindingDetail binding={b} status={s} src={src} historians={historians} profiles={profiles} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirm && (
        <Modal title="Delete binding" onClose={() => setConfirm(null)} className="max-w-sm p-5">
          <h3 className="text-base font-semibold text-slate-100">Delete binding?</h3>
          <p className="mt-2 text-sm text-slate-300">
            <span className="font-semibold">{confirm.name || confirm.id.slice(0, 8)}</span> stops publishing. Topics it already published are not
            removed from the broker.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const b = confirm;
                setConfirm(null);
                onDelete(b);
              }}
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
