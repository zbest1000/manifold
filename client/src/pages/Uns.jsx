import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Network, Radio, Cpu, Boxes, X, Activity } from 'lucide-react';
import { useStore, onMessageActivity } from '@/store/store';
import { api } from '@/lib/api';
import UnsTopology, { buildUnsTree, levelName, levelColor, DEFAULT_LEVELS } from '@/graph/UnsTopology';
import PageHeader from '@/components/PageHeader';
import { Card, Button, EmptyState } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

/**
 * UNS — the Unified Namespace topology. One live map of the whole namespace,
 * organized by ISA-95-style levels rather than raw topics, with data sources
 * (MQTT brokers, OPC UA, i3X) surfaced as header chips and branches lighting up
 * while data flows through them. This is the "whole plant at a glance" lens the
 * tool grows into beyond per-protocol exploration.
 */
export default function Uns() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const [scope, setScope] = useState('all'); // 'all' | brokerId
  const [selected, setSelected] = useState(null);
  const [i3xStatus, setI3xStatus] = useState(null);
  const [rate, setRate] = useState(0);
  const rateCount = useRef(0);

  const connected = brokers.filter((b) => b.status === 'connected');
  const setTopics = useStore((s) => s.setTopics);

  // Seed the topic index from the authoritative REST list — the live socket
  // stream only carries topics that publish while the page is open.
  useEffect(() => {
    for (const b of connected) {
      api
        .brokerTopics(b.id)
        .then((res) => setTopics(b.id, res.topics))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected.map((b) => b.id).join('|')]);

  // Message rate chip: count bus events, publish once a second.
  useEffect(() => {
    const off = onMessageActivity(() => {
      rateCount.current++;
    });
    const t = setInterval(() => {
      setRate(rateCount.current);
      rateCount.current = 0;
    }, 1000);
    return () => {
      off?.();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    api.i3xStatus().then(setI3xStatus).catch(() => {});
  }, []);

  const scoped = scope === 'all' ? connected : connected.filter((b) => b.id === scope);
  // Rebuild namespace trees only when the topic SET changes on a scoped broker.
  const versionKey = scoped.map((b) => `${b.id}:${topicVersionMap[b.id] || 0}`).join('|');
  const roots = useMemo(
    () => scoped.map((b) => buildUnsTree(b, useStore.getState().getTopics(b.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionKey]
  );

  if (!connected.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Unified Namespace" subtitle="Live topology of the whole namespace, by ISA-95 level" />
        <EmptyState
          icon={Network}
          title="No connected brokers"
          hint="The UNS view maps every connected data source into one live namespace topology. Connect an MQTT broker to begin."
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
        title="Unified Namespace"
        subtitle="live topology"
        actions={
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
          >
            <option value="all">All namespaces</option>
            {connected.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        }
      />

      <div className="relative min-h-0 flex-1">
        {/* Source + rate chips, in the reference style */}
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2">
          <Chip tone="live">
            <Activity size={12} /> live · {rate.toLocaleString()}/s
          </Chip>
          {scoped.map((b) => (
            <Chip key={b.id} tone="mqtt">
              <Radio size={12} /> {b.name} <Dot on />
            </Chip>
          ))}
          {opcua.filter((c) => c.status === 'connected').map((c) => (
            <Chip key={c.id} tone="opcua">
              <Cpu size={12} /> OPC-UA <Dot on />
            </Chip>
          ))}
          {i3xStatus?.configured && (
            <Chip tone="opcua">
              <Boxes size={12} /> i3X <Dot on={Boolean(i3xStatus.info)} />
            </Chip>
          )}
        </div>

        <UnsTopology roots={roots} selectedId={selected?.id || null} onSelect={setSelected} />

        {/* Legend, matching the visual language */}
        <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-300/60 bg-white/85 px-3 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur">
          {DEFAULT_LEVELS.slice(0, 4).map((lvl, i) => (
            <span key={lvl} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-white" style={{ borderColor: levelColor(i) }} />
              {lvl}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#22c55e" strokeWidth="1.6" strokeDasharray="6 4" /></svg>
            publishing
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#94a3b8" strokeWidth="1" /></svg>
            not live
          </span>
          <span className="text-slate-400">double-click / ± to expand</span>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="absolute right-4 top-4 z-10 w-72">
            <Card className="border-slate-300/70 bg-white/95 p-3 text-slate-800 shadow-lg backdrop-blur">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">{selected.name}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: levelColor(selected.depth) }}>
                    {levelName(selected.depth)}
                  </div>
                </div>
                <button onClick={() => setSelected(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-1 text-xs text-slate-500">
                {selected.path && (
                  <div className="truncate font-mono text-[11px] text-slate-600" title={selected.path}>
                    {selected.path}
                  </div>
                )}
                <Row k="Topics in branch" v={selected.topicCount.toLocaleString()} />
                <Row k="Direct children" v={selected.children.size.toLocaleString()} />
                <LiveRow node={selected} />
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveRow({ node }) {
  // Re-read liveness once a second while the panel is open.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ts = node.__lastActive; // not tracked on the tree; show via activity map fallback
  return ts ? <Row k="Last activity" v={formatDistanceToNow(ts, { addSuffix: true })} /> : null;
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{k}</span>
      <span className="font-medium text-slate-700">{v}</span>
    </div>
  );
}

function Chip({ children, tone }) {
  const tones = {
    live: 'border-emerald-300 bg-emerald-50 text-emerald-700',
    mqtt: 'border-emerald-300 bg-white text-emerald-700',
    opcua: 'border-sky-300 bg-white text-sky-700'
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium shadow-sm ${tones[tone] || tones.mqtt}`}>
      {children}
    </span>
  );
}

function Dot({ on }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300'}`} />;
}
