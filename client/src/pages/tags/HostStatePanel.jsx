import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Button, Input, Select, Field, StatusText } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { setHostState } from './tagsApi';

const HOST_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Manifold as a Sparkplug primary host: a dedicated session publishing retained
 * { online, timestamp } on spBv1.0/STATE/{hostId} with a matching will. Collapsed by default.
 */
export default function HostStatePanel({ brokers, hosts, onStatus }) {
  const [open, setOpen] = useState(false);
  const [brokerId, setBrokerId] = useState('');
  const [hostId, setHostId] = useState('manifold_host');
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const active = Object.values(hosts || {});
  const hostError = hostId && !HOST_RE.test(hostId) ? 'Use 1 to 64 letters, digits, _ or -.' : null;

  const toggle = async (bId, hId, enabled) => {
    setBusy(true);
    try {
      const r = await setHostState({ brokerId: bId, hostId: hId, enabled });
      onStatus(r.sparkplug);
      toast.success(enabled ? `Host state online: ${hId}` : `Host state stopped: ${hId}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="sparkplug-host-state"
        className="-ml-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm font-medium text-fg transition-colors hover:text-accent-text"
      >
        <ChevronRight size={14} aria-hidden="true" className={clsx('shrink-0 text-subtle transition-transform duration-150', open && 'rotate-90')} />
        Sparkplug primary host
        {active.length > 0 && <span className="ml-auto font-mono text-xs font-normal text-subtle">{active.length} active</span>}
      </button>
      {open && (
        <div id="sparkplug-host-state" className="mt-2 space-y-3 border-l-2 border-line pl-3">
          <p className="text-xs text-subtle">
            Publishes retained <span className="mono">spBv1.0/STATE/&lt;host&gt;</span> so edge nodes see Manifold as a host application. The will announces offline.
          </p>
          <Select label="Broker" value={brokerId || brokers[0]?.id || ''} onChange={(e) => setBrokerId(e.target.value)}>
            {brokers.length === 0 && <option value="">No connected broker</option>}
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <div className="flex items-start gap-2">
            <Field label="Host ID" error={hostError} className="min-w-0 flex-1">
              <Input value={hostId} onChange={(e) => setHostId(e.target.value)} className="mono" aria-invalid={Boolean(hostError) || undefined} />
            </Field>
            <Button
              variant="secondary"
              className="mt-[22px]"
              loading={busy}
              disabled={!hostId || Boolean(hostError) || brokers.length === 0 || readOnly}
              title={readOnly ? READ_ONLY_REASON : undefined}
              onClick={() => toggle(brokerId || brokers[0]?.id, hostId, true)}
            >
              Enable
            </Button>
          </div>
          {active.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line">
              {active.map((h) => (
                <li key={`${h.brokerId} ${h.hostId}`} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs text-fg" title={`spBv1.0/STATE/${h.hostId}`}>
                      {h.hostId}
                    </span>
                    <StatusText status={h.online ? 'online' : 'connecting'} className="text-xs" />
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy || readOnly} title={readOnly ? READ_ONLY_REASON : undefined} onClick={() => toggle(h.brokerId, h.hostId, false)}>
                    Stop
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
