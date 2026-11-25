import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, HelpButton, IconButton, Input, Select, StatusText } from '@/components/ui';
import { PanelSection, SidePanel } from '@/components/CanvasChrome';

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

  const canAdd = !busy && !(type === 'opcua' && connectedOpcua.length === 0) && !(type === 'i3x' && !i3xStatus?.configured);
  return (
    <SidePanel
      title="Namespace sources"
      label="Namespace sources"
      onClose={onClose}
      actions={
        <>
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
            <p className="text-subtle">
              Mounted sources re-browse every 60 seconds. Press <b>Refresh</b> to update now.
            </p>
          </HelpButton>
          <IconButton icon={RefreshCw} size={14} label="Re-browse mounted sources now (also every 60 s)" side="left" onClick={onChanged} />
        </>
      }
    >
      <PanelSection>
        <p className="text-sm text-muted">
          Everything here feeds one namespace. MQTT brokers, and any Sparkplug traffic on them, stream live. OPC UA and i3X add structure only. To carry values across sources, use a Pipeline route or a Tag binding.
        </p>
      </PanelSection>
      <PanelSection title="Live sources">
        {brokers.length === 0 ? (
          <p className="text-sm text-muted">No brokers connected. Add one on the MQTT Brokers page.</p>
        ) : (
          <ul className="divide-y divide-line">
            {brokers.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge>MQTT</Badge>
                  <span className="truncate text-sm text-fg">{b.name || `${b.host}:${b.port}`}</span>
                </span>
                <StatusText tone="good" className="text-xs">
                  Live
                </StatusText>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <PanelSection title="Mounted sources">
        {mounts.length > 0 && (
          <ul className="mb-3 divide-y divide-line">
            {mounts.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge>{m.type === 'opcua' ? 'OPC UA' : 'i3X'}</Badge>
                  <span className="truncate text-sm text-fg">{m.label || m.connectionId || 'i3X namespace'}</span>
                </span>
                <IconButton icon={Trash2} size={14} label={`Remove ${m.label || m.connectionId || 'i3X namespace'}`} side="left" className="hover:bg-bad/10 hover:text-bad" onClick={() => remove(m.id)} />
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3">
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Select aria-label="Source type" value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
              <option value="opcua">OPC UA</option>
              <option value="i3x">i3X</option>
            </Select>
            {type === 'opcua' ? (
              <Select aria-label="OPC UA connection to mount" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {connectedOpcua.length === 0 && <option value="">No connections</option>}
                {connectedOpcua.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.endpointUrl}
                  </option>
                ))}
              </Select>
            ) : (
              <span />
            )}
          </div>
          <Input aria-label="Mount label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
          <Button variant="secondary" className="w-full" onClick={add} loading={busy} disabled={!canAdd}>
            Mount source
          </Button>
          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}
        </div>
      </PanelSection>
    </SidePanel>
  );
}
