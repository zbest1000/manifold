import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Network, Radio, Cpu, Boxes, X, Activity, ListTree, Share2, Search, Pencil } from 'lucide-react';
import { useStore, onMessageActivity } from '@/store/store';
import { api } from '@/lib/api';
import UnsTopology, { buildUnsTree, levelName, levelColor, lastActive, DEFAULT_LEVELS } from '@/graph/UnsTopology';
import { resolveIconName, getIconImage } from '@/graph/unsIcons';
import PageHeader from '@/components/PageHeader';
import GraphTree from '@/components/GraphTree';
import ViewTab from '@/components/ViewTab';
import { Button, EmptyState } from '@/components/ui';
import { formatDistanceToNow } from 'date-fns';

// Icon picker pulls the full Lucide set — its own chunk, loaded on demand.
const UnsIconPicker = lazy(() => import('@/components/UnsIconPicker'));

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
  const [view, setView] = useState('topology'); // 'topology' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [iconTick, setIconTick] = useState(0); // bump after a pick so previews refresh
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

  // Flat {nodes, links} projection of the same forest for the Tree view, plus an
  // id -> UNS-node index so tree selection drives the same detail panel.
  const flat = useMemo(() => {
    const nodes = [];
    const links = [];
    const byId = new Map();
    const walk = (n, parentId) => {
      nodes.push({ id: n.id, label: n.name, group: 'topic', kind: 'uns', meta: { level: levelName(n.depth) } });
      byId.set(n.id, n);
      if (parentId) links.push({ source: parentId, target: n.id });
      for (const c of n.children.values()) walk(c, n.id);
    };
    for (const r of roots) walk(r, null);
    return { nodes, links, byId };
  }, [roots]);

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
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'topology'} onClick={() => setView('topology')} icon={Share2} label="Topology" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
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
          </div>
        }
      />

      <div className="relative min-h-0 flex-1">
        {/* Source + rate chips, in the reference style (topology surface only) */}
        {view === 'topology' && (
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
        )}

        <div className="flex h-full w-full">
          {view === 'tree' ? (
            <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                <Search size={14} className="text-slate-500" />
                <input
                  value={treeFilter}
                  onChange={(e) => setTreeFilter(e.target.value)}
                  placeholder="Filter namespace…"
                  className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
                />
              </div>
              <GraphTree
                nodes={flat.nodes}
                links={flat.links}
                selectedId={selected?.id || null}
                onSelect={(n) => setSelected(flat.byId.get(n.id) || null)}
                filter={treeFilter}
              />
            </div>
          ) : (
          <div className="relative min-w-0 flex-1">
            <UnsTopology roots={roots} selectedId={selected?.id || null} onSelect={setSelected} />
          </div>
          )}
          {/* Docked detail column — never overlays the canvas, so it can't block
              nodes, labels, or the second click of a double-click. */}
          {selected && (
            <aside className="w-72 shrink-0 overflow-y-auto border-l border-white/5 bg-surface-900/40 p-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">{selected.name}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: levelColor(selected.depth) }}>
                    {levelName(selected.depth)}
                  </div>
                </div>
                <button aria-label="Close details" onClick={() => setSelected(null)} className="rounded p-1 text-slate-400 hover:bg-white/10">
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                {selected.path && (
                  <div className="truncate font-mono text-[11px] text-slate-300" title={selected.path}>
                    {selected.path}
                  </div>
                )}
                <Row k="Topics in branch" v={selected.topicCount.toLocaleString()} />
                <Row k="Direct children" v={selected.children.size.toLocaleString()} />
                <LiveRow node={selected} />
                <IconRow key={iconTick} node={selected} onChange={() => setPickerOpen(true)} />
              </div>
            </aside>
          )}
        </div>

        {pickerOpen && selected && (
          <Suspense fallback={null}>
            <UnsIconPicker node={selected} onClose={() => setPickerOpen(false)} onPicked={() => setIconTick((v) => v + 1)} />
          </Suspense>
        )}

        {/* Legend, matching the visual language (topology surface only) */}
        {view === 'topology' && (
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
        )}

      </div>
    </div>
  );
}

function IconRow({ node, onChange }) {
  const name = resolveIconName(node);
  const img = getIconImage(name, '#cbd5e1', 40);
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1.5">
      <span className="flex items-center gap-2 text-slate-400">
        {img && <img src={img.src} alt="" className="h-4 w-4" />}
        <span className="font-mono text-[11px]">{name}</span>
      </span>
      <button onClick={onChange} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent-300 hover:bg-white/10">
        <Pencil size={11} /> change
      </button>
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
  const ts = lastActive(node);
  return ts ? <Row k="Last activity" v={formatDistanceToNow(ts, { addSuffix: true })} /> : <Row k="Last activity" v="—" />;
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{k}</span>
      <span className="font-medium text-slate-200">{v}</span>
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
