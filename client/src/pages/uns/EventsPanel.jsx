import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Banner, StatusText, Timestamp } from '@/components/ui';
import { SidePanel } from '@/components/CanvasChrome';

const EVENT_LABEL = {
  'topic-added': 'New topic',
  'edge-birth': 'Edge online',
  'edge-death': 'Edge offline',
  'device-birth': 'Device online',
  'device-death': 'Device offline'
};
const EVENT_TONE = {
  'topic-added': 'info',
  'edge-birth': 'good',
  'device-birth': 'good',
  'edge-death': 'bad',
  'device-death': 'bad'
};

export default function EventsPanel({ brokers, onJump, onClose }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(
        brokers.map((b) =>
          api
            .unsEvents(b.id)
            .then((r) => r.events.map((e) => ({ ...e, brokerId: b.id, brokerName: b.name })))
        )
      )
        .then((all) => {
          if (!alive) return;
          setError(null);
          setEvents(all.flat().sort((a, b) => b.ts - a.ts).slice(0, 300));
        })
        .catch((e) => alive && setError(e?.message || 'Could not load events'));
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [brokers, attempt]);

  return (
    <SidePanel title="Namespace events" label="Namespace events" onClose={onClose}>
      {error && (
        <div className="p-4">
          <Banner variant="error" title="Could not load events" onRetry={() => setAttempt((v) => v + 1)}>
            {error}
          </Banner>
        </div>
      )}
      {!events && !error && (
        <p className="p-4 text-sm text-muted" role="status">
          Loading events…
        </p>
      )}
      {events?.length === 0 && <p className="p-4 text-sm text-muted">No events yet. New topics and Sparkplug births and deaths appear here.</p>}
      {events?.length > 0 && (
        <ul className="divide-y divide-line">
          {events.map((e, i) => {
            const target = e.topic ? e.topic.split('/').filter(Boolean).join('/') : null;
            const body = (
              <>
                <span className="flex items-center justify-between gap-2">
                  <StatusText tone={EVENT_TONE[e.type] || 'neutral'} className="text-xs">
                    {EVENT_LABEL[e.type] || e.type}
                    {e.cascaded ? ' (cascade)' : ''}
                  </StatusText>
                  <Timestamp value={e.ts} className="shrink-0 text-xs text-subtle" />
                </span>
                <span className="mt-0.5 block break-all font-mono text-xs text-muted">{e.topic || [e.group, e.edgeNode, e.device].filter(Boolean).join(' / ')}</span>
              </>
            );
            return (
              <li key={i}>
                {target ? (
                  <button type="button" onClick={() => onJump(e.brokerId, target)} className="block w-full px-4 py-2 text-left transition-colors hover:bg-raised" title="Show this node on the map">
                    {body}
                  </button>
                ) : (
                  <div className="px-4 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SidePanel>
  );
}
