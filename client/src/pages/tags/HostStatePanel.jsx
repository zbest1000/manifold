import { useId, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Button, Input } from '@/components/ui';
import { setHostState } from './tagsApi';

// Manifold as a Sparkplug primary host: a dedicated session publishing retained
// { online, timestamp } on spBv1.0/STATE/{hostId} with a matching will.
// Lives in a collapsed "Advanced" disclosure at the bottom of the side panel.
export default function HostStatePanel({ brokers, hosts, onStatus }) {
  const [brokerId, setBrokerId] = useState('');
  const [hostId, setHostId] = useState('manifold_host');
  const [busy, setBusy] = useState(false);
  const hostFieldId = useId();
  const active = Object.values(hosts);

  const toggle = async (bId, hId, enabled) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hId)) {
      toast.error('Host ID must be 1-64 chars: letters, digits, _ or -');
      return;
    }
    setBusy(true);
    try {
      const r = await setHostState({ brokerId: bId, hostId: hId, enabled });
      onStatus(r.sparkplug);
      toast.success(enabled ? `Host STATE online: ${hId}` : `Host STATE stopped: ${hId}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="group rounded-xl border border-white/5 bg-black/10">
      <summary className="cursor-pointer select-none rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent-400">
        Advanced: Sparkplug primary host state
      </summary>
      <div className="space-y-2 px-3 pb-3 pt-1">
        <p className="text-xs leading-snug text-slate-400">
          Publish retained <span className="font-mono">spBv1.0/STATE/&lt;host&gt;</span> so edge nodes see Manifold as a Sparkplug host
          application (the will announces offline).
        </p>
        <label className="block text-xs text-slate-300">
          Broker
          <select
            value={brokerId || brokers[0]?.id || ''}
            onChange={(e) => setBrokerId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-surface-900 px-2 py-1.5 text-xs text-slate-200"
          >
            {brokers.length === 0 && <option value="">no connected brokers</option>}
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1 text-xs text-slate-300">
            <label htmlFor={hostFieldId}>Host ID</label>
            <Input id={hostFieldId} value={hostId} onChange={(e) => setHostId(e.target.value)} placeholder="host id" className="mt-1" />
          </div>
          <Button size="sm" disabled={busy || !hostId || brokers.length === 0} onClick={() => toggle(brokerId || brokers[0]?.id, hostId, true)}>
            Enable
          </Button>
        </div>
        {active.map((h) => (
          <div key={`${h.brokerId} ${h.hostId}`} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2.5 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', h.online ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden="true" />
              <span className="min-w-0 truncate font-mono text-slate-200" title={`spBv1.0/STATE/${h.hostId}`}>{h.hostId}</span>
              <span className="shrink-0 text-slate-400">{h.online ? 'online' : 'connecting'}</span>
            </span>
            <button disabled={busy} onClick={() => toggle(h.brokerId, h.hostId, false)} className="shrink-0 text-xs text-slate-300 hover:text-rose-300">
              disable
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
