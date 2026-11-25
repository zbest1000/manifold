import { useState } from 'react';
import { Waypoints } from 'lucide-react';
import { useStore } from '@/store/store';
import FlowsView, { FlowsPerspective } from '@/components/FlowsView';
import PageHeader from '@/components/PageHeader';
import { ButtonLink, EmptyState, Select } from '@/components/ui';

/**
 * Flows — top-level workspace for producer → topic → consumer visibility.
 * Producers: Sparkplug device topology + $SYS health (observed traffic).
 * Consumers: per-client subscriptions from a broker admin API, wildcard-resolved
 * against the observed topic set.
 */
export default function Flows() {
  const brokers = useStore((s) => s.brokers);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('producers');
  const connected = brokers.filter((b) => b.status === 'connected');
  // Follow the user's pick while that broker exists; otherwise the first connected one.
  const brokerId = selectedId && brokers.some((b) => b.id === selectedId) ? selectedId : connected[0]?.id || null;

  const broker = brokers.find((b) => b.id === brokerId);

  if (!connected.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Flows" />
        <EmptyState
          icon={Waypoints}
          title="No connected brokers"
          hint="Connect to an MQTT broker to map its producers (Sparkplug devices) and consumers (per-client subscriptions, wildcards resolved)."
          action={
            <ButtonLink to="/brokers" variant="primary">
              Connect a broker
            </ButtonLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Flows"
        subtitle={tab === 'producers' ? 'Who publishes, from Sparkplug births and deaths' : 'Who receives, from the broker admin API'}
        actions={
          <Select aria-label="Broker" value={brokerId || ''} onChange={(e) => setSelectedId(e.target.value)} className="w-auto max-w-[14rem]">
            {connected.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />
      <div role="toolbar" aria-label="Flows view" className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-4 py-1.5 sm:px-6">
        <FlowsPerspective value={tab} onChange={setTab} />
      </div>
      <div className="min-h-0 flex-1">{broker && <FlowsView broker={broker} tab={tab} />}</div>
    </div>
  );
}
