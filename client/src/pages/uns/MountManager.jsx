import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { HelpButton } from '@/components/ui';

export default function MountManager({ mounts, brokers = [], opcua, i3xStatus, onChanged, onClose }) {
  const [type, setType] = useState('opcua');
  const [connectionId, setConnectionId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const connectedOpcua = opcua.filter((c) => c.status === 'connected');

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addMount({ type, connectionId: type === 'opcua' ? connectionId || connectedOpcua[0]?.id : null, label: label || null });
      setLabel('');
      onChanged();
    } catch (e) {
      setError(e?.message || 'Could not mount the source');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api.removeMount(id);
      onChanged();
    } catch (e) {
      setError(e?.message || 'Could not remove the mount');
    }
  };

  return (
    <div className="absolute right-4 top-4 z-20 w-80 max-w-[calc(100%-2rem)] rounded-xl border border-white/10 bg-surface-900/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100">UNS sources</span>
        <span className="flex items-center gap-1">
          <HelpButton title="What feeds the Unified Namespace?" label="About UNS sources">
            <p>
              The namespace is one shared tree that several sources feed at once. They fall into two groups.
            </p>
            <p><b>Live sources</b> stream real values into the namespace:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>MQTT</b>: every connected broker&apos;s topic tree shows up as a live branch. This is the backbone of the
                namespace, so brokers are always here. You add and remove them on the <b>MQTT Brokers</b> page.
              </li>
              <li>
                <b>Sparkplug</b>: when a broker carries Sparkplug B traffic, Manifold decodes it automatically and shows the
                Group, Edge Node, Device, and metric structure inside that broker&apos;s branch. It is not a separate
                connection.
              </li>
            </ul>
            <p><b>Mounted sources</b> graft in <b>structure only</b>. They map out what exists but do not stream values:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>OPC UA</b>: a server&apos;s address space, browsed like an OPC UA client would show it, for example
                <code>Objects/DeviceSet/Robot1</code>.
              </li>
              <li>
                <b>i3X</b>: the connected i3X object graph, as one branch.
              </li>
            </ul>
            <p>
              <b>How they connect.</b> Every source lands in the same ISA-95 hierarchy, side by side, so you see the whole
              plant in one place. To carry a value from one source into another, build a <b>Pipeline</b> route or a <b>Tag</b>
              binding. For example, mount an OPC UA server to find the node you want, then route it into
              <code>uns/plant1/line1</code> on your broker so it becomes a live topic that others can subscribe to.
            </p>
            <p className="text-slate-400">
              Mounted sources re-browse every 60 seconds. Press <b>Refresh</b> to update now.
            </p>
          </HelpButton>
          <button
            onClick={onChanged}
            title="Re-browse mounted sources now (also refreshes every 60s)"
            className="rounded px-1.5 py-0.5 text-xs text-accent-300 hover:bg-white/10"
          >
            Refresh
          </button>
          <button aria-label="Close UNS sources" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
            <X size={14} />
          </button>
        </span>
      </div>
      <p className="mb-2 text-xs leading-snug text-slate-400">
        Everything below feeds one namespace. MQTT brokers (and any Sparkplug traffic on them) stream live; OPC UA and
        i3X graft in structure only. To carry values across sources, use a Pipeline route or a Tag binding.
      </p>

      {/* Live sources: MQTT brokers (Sparkplug is decoded within them) — managed on the Brokers page */}
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Live sources</p>
      <div className="mb-3 space-y-1">
        {brokers.length === 0 ? (
          <p className="text-xs text-slate-400">
            No brokers connected. Add one on the <b className="text-slate-400">MQTT Brokers</b> page.
          </p>
        ) : (
          brokers.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1.5 text-xs">
              <span className="truncate text-slate-300">
                <span className="mr-1.5 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-xs uppercase text-emerald-300">mqtt</span>
                {b.name || `${b.host}:${b.port}`}
              </span>
              <span className="text-xs text-emerald-400">live</span>
            </div>
          ))
        )}
      </div>

      {/* Mounted sources: OPC UA / i3X, structure only */}
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Mounted sources</p>
      {mounts.length > 0 && (
        <div className="mb-2 space-y-1">
          {mounts.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-lg bg-black/20 px-2 py-1.5 text-xs">
              <span className="truncate text-slate-300">
                <span className="mr-1.5 rounded bg-white/10 px-1 py-0.5 font-mono text-xs uppercase">{m.type}</span>
                {m.label || m.connectionId || 'i3X namespace'}
              </span>
              <button aria-label="Remove mount" onClick={() => remove(m.id)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-red-400">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <select
            aria-label="Source type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:outline-none"
          >
            <option value="opcua">OPC UA</option>
            <option value="i3x">i3X</option>
          </select>
          {type === 'opcua' && (
            <select
              aria-label="OPC UA connection to mount"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 focus:outline-none"
            >
              {connectedOpcua.length === 0 && <option value="">no connections</option>}
              {connectedOpcua.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.endpointUrl}
                </option>
              ))}
            </select>
          )}
        </div>
        <input
          aria-label="Mount label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-full rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-400 focus:border-accent-500/60 focus:outline-none"
        />
        <button
          onClick={add}
          disabled={busy || (type === 'opcua' && connectedOpcua.length === 0) || (type === 'i3x' && !i3xStatus?.configured)}
          className="w-full rounded-lg bg-accent-500/20 px-2.5 py-1.5 text-xs font-medium text-accent-200 hover:bg-accent-500/30 disabled:opacity-40"
        >
          Mount source
        </button>
        {error && (
          <p role="alert" className="text-xs text-rose-300">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

