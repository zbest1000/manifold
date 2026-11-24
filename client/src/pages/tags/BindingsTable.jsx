import { Fragment, useState } from 'react';
import { ChevronRight, ChevronDown, Pencil, Trash2, Power } from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { Modal, Button, Badge, Card } from '@/components/ui';

function sourceLabel(b, sources) {
  const s = b.source || {};
  const id = s.type === 'opcua' ? s.connectionId : s.type === 'sparkplug' ? s.brokerId : s.deviceId ?? s.connectionId;
  const found = sources.find((x) => x.type === s.type && x.id === id);
  const scope = s.type === 'sparkplug' ? ` ${s.group}/${s.edge}${s.device ? `/${s.device}` : ''}` : '';
  return { type: s.type, label: `${found?.label || id || '?'}${scope}`, connected: Boolean(found) };
}

function targetLabel(b) {
  const t = b.target || {};
  return t.mode === 'sparkplug' ? `spBv1.0/${t.group}/*/${t.edge}/${t.device || '(binding name)'}` : t.pathTemplate || '';
}

function tagCount(b) {
  const s = b.source || {};
  if (Array.isArray(s.tags)) return s.tags.length;
  if (Array.isArray(s.metrics)) return s.metrics.length;
  return 'all';
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
export default function BindingsTable({ bindings, status, sources, editingId, onEdit, onToggleEnabled, onDelete, busyId }) {
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
          <thead className="border-b border-white/5 text-slate-400">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Name</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Source</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Target</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Tags</th>
              <th scope="col" className="px-3 py-2 font-medium">Published / suppressed / errors</th>
              <th scope="col" className="px-3 py-2 font-medium">Source state</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Last publish</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Last error</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((b) => {
              const s = status[b.id] || {};
              const src = sourceLabel(b, sources);
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
                        <span className="break-words">{label}</span>
                      </button>
                      {!enabled && <span className="ml-5 block text-xs font-normal text-amber-300">disabled</span>}
                    </th>
                    <td className="hidden max-w-[14rem] px-3 py-2 text-slate-300 md:table-cell">
                      <span className="mr-1 text-slate-400">{src.type}</span>
                      <span className="break-words">{src.label}</span>
                    </td>
                    <td className="hidden max-w-[16rem] px-3 py-2 font-mono text-slate-300 md:table-cell">
                      <span className="break-all">{targetLabel(b)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{tagCount(b)}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-200">
                      {s.published || 0} / {s.suppressed || 0} / <span className={s.errors ? 'text-rose-300' : ''}>{s.errors || 0}</span>
                    </td>
                    <td className="px-3 py-2"><StateBadge state={s.sourceState} /></td>
                    <td className="hidden px-3 py-2 text-slate-300 lg:table-cell">
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
                          disabled={busyId === b.id}
                          aria-pressed={enabled}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} binding ${label}`}
                          title={enabled ? 'Disable' : 'Enable'}
                          className={clsx('rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-40', enabled ? 'text-emerald-300' : 'text-slate-400')}
                        >
                          <Power size={14} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => onEdit(b)} aria-label={`Edit binding ${label}`} title="Edit" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-accent-300">
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => setConfirm(b)} aria-label={`Delete binding ${label}`} title="Delete" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-rose-300">
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={`binding-detail-${b.id}`} className="border-b border-white/5 bg-black/20">
                      <td colSpan={9} className="px-3 py-2.5">
                        <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
                          <dt className="text-slate-400">Source</dt>
                          <dd className="break-all text-slate-200">{src.type}: {src.label}{!src.connected && ' (not connected)'}</dd>
                          <dt className="text-slate-400">Target</dt>
                          <dd className="break-all font-mono text-slate-200">
                            {b.target?.mode === 'mqtt' ? `${targetLabel(b)} (${b.target.format || 'plain'}${b.target.retain ? ', retained' : ''}, QoS ${b.target.qos || 0})` : targetLabel(b)}
                          </dd>
                          <dt className="text-slate-400">Last publish</dt>
                          <dd className="text-slate-200">{s.lastTs ? new Date(s.lastTs).toLocaleString() : 'never'}</dd>
                          <dt className="text-slate-400">Source state</dt>
                          <dd className="text-slate-200">
                            {s.sourceState ? `${s.sourceState.state}${s.sourceState.reason ? ` (${s.sourceState.reason})` : ''}` : 'unknown'}
                          </dd>
                          <dt className="text-slate-400">Last error</dt>
                          <dd className={clsx('break-words', s.lastError ? 'text-amber-300' : 'text-slate-400')}>{s.lastError || 'none'}</dd>
                        </dl>
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
