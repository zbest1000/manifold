import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Waypoints, Sun, Moon } from 'lucide-react';
import { useStore } from '@/store/store';
import FlowsView from '@/components/FlowsView';
import PageHeader from '@/components/PageHeader';
import { EmptyState, Button } from '@/components/ui';

/**
 * Flows — top-level workspace for producer → topic → consumer visibility.
 * Producers: Sparkplug device topology + $SYS health (observed traffic).
 * Consumers: per-client subscriptions from a broker admin API, wildcard-resolved
 * against the observed topic set.
 */
export default function Flows() {
  const brokers = useStore((s) => s.brokers);
  const [brokerId, setBrokerId] = useState(null);
  const [canvasTheme, setCanvasTheme] = useState(() => localStorage.getItem('tc.flowsTheme') || 'dark');
  const connected = brokers.filter((b) => b.status === 'connected');

  const toggleCanvasTheme = () => {
    const next = canvasTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tc.flowsTheme', next);
    setCanvasTheme(next);
  };

  useEffect(() => {
    if (!brokerId && connected.length) setBrokerId(connected[0].id);
    if (brokerId && !brokers.some((b) => b.id === brokerId)) setBrokerId(connected[0]?.id || null);
  }, [connected, brokerId, brokers]);

  const broker = brokers.find((b) => b.id === brokerId);

  if (!connected.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Flows" subtitle="Who publishes and who receives what, on a live broker" helpTopic="guide-flows" />
        <EmptyState
          icon={Waypoints}
          title="No connected brokers"
          hint="Connect to an MQTT broker to map its producers (Sparkplug devices) and consumers (per-client subscriptions, wildcard-resolved)."
          action={
            <Link to="/brokers">
              <Button>Connect a broker</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Flows"
        subtitle="Producer → topic → consumer lineage, from observed traffic + the broker admin API"
        helpTopic="guide-flows"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={toggleCanvasTheme}
              className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5"
            >
              {canvasTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              {canvasTheme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <select
              value={brokerId || ''}
              onChange={(e) => setBrokerId(e.target.value)}
              className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
            >
              {connected.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <div className="min-h-0 flex-1">{broker && <FlowsView broker={broker} theme={canvasTheme} />}</div>
    </div>
  );
}
