import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api';
import PanelHeader from './PanelHeader';

const EVENT_LABEL = {
  'topic-added': 'new topic',
  'edge-birth': 'edge online',
  'edge-death': 'edge offline',
  'device-birth': 'device online',
  'device-death': 'device offline'
};
const EVENT_COLOR = {
  'topic-added': 'text-sky-400',
  'edge-birth': 'text-emerald-400',
  'device-birth': 'text-emerald-400',
  'edge-death': 'text-red-400',
  'device-death': 'text-red-400'
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
    <aside className="flex max-h-[50%] w-full shrink-0 flex-col border-t border-white/5 bg-surface-900/40 md:max-h-none md:w-80 md:border-l md:border-t-0">
      <PanelHeader icon={History} title="Namespace events" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
            <span>{error}</span>
            <button onClick={() => setAttempt((v) => v + 1)} className="shrink-0 rounded border border-rose-400/40 px-2 py-0.5 hover:bg-rose-500/20">
              Retry
            </button>
          </div>
        )}
        {!events && !error && <p className="text-xs text-slate-400" role="status">Loading…</p>}
        {events?.length === 0 && <p className="text-xs text-slate-400">No events yet — new topics and Sparkplug BIRTH/DEATH show up here.</p>}
        {events?.map((e, i) => (
          <button
            key={i}
            onClick={() => e.topic && onJump(e.brokerId, e.topic.split('/').filter(Boolean).join('/'))}
            className="mb-1 block w-full rounded-lg bg-black/20 px-2 py-1.5 text-left text-xs hover:bg-white/5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`font-semibold ${EVENT_COLOR[e.type] || 'text-slate-300'}`}>
                {EVENT_LABEL[e.type] || e.type}
                {e.cascaded ? ' (cascade)' : ''}
              </span>
              <span className="shrink-0 text-xs text-slate-400">{formatDistanceToNow(e.ts, { addSuffix: true })}</span>
            </div>
            <div className="mt-0.5 break-all font-mono text-xs text-slate-400">
              {e.topic || [e.group, e.edgeNode, e.device].filter(Boolean).join(' / ')}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

