import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Share2, X, Gauge, Clock, Hash, Send, ListTree, Search, Copy, Trash2, Boxes, Box, Tag, Waypoints, Loader2, Cpu, GitCompareArrows, Maximize2, Minimize2, PanelRight, ChevronDown, Check, Radio } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useStore, onMessageActivity } from '@/store/store';
import { Sparkline, TimeSeriesChart, fmtNum } from '@/components/charts';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';

// Heavy renderers load on demand: three.js (3D view) and the WebGL big-graph
// renderer aren't part of the initial bundle — most sessions never open them.
const ForceGraph3D = lazy(() => import('@/graph/ForceGraph3D'));
const WebGLGraph = lazy(() => import('@/graph/WebGLGraph'));

function RendererLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-500">
      <Loader2 size={14} className="mr-2 animate-spin" /> Loading renderer…
    </div>
  );
}
import { buildMqttGraph, buildAllBrokersGraph, collapseGraph } from '@/graph/buildGraph';
import { DEFAULT_LAYOUT } from '@/graph/graphStyles';
import GraphToolbar from '@/components/GraphToolbar';
import GraphLegend from '@/components/GraphLegend';
import Graph3DControls from '@/components/Graph3DControls';
import GraphSearch from '@/components/GraphSearch';
import TopicTree from '@/components/TopicTree';
import JsonView from '@/components/JsonView';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { diffPayloads, formatDiffValue } from '@/lib/payloadDiff';
import { Card, Button, Badge, EmptyState, Input } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';
import { formatDistanceToNow } from 'date-fns';

// localStorage key for the legend's hidden node groups.
const HIDDEN_GROUPS_KEY = 'tc.hiddenGroups';

function numericFromPayload(payload) {
  if (typeof payload === 'number') return payload;
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['value', 'v', 'val', 'temperature', 'temp']) {
      if (Number.isFinite(payload[key])) return payload[key];
    }
  }
  return null;
}

function shortText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}

export default function TopicGraph() {
  const brokers = useStore((s) => s.brokers);
  const dataTick = useStore((s) => s.dataTick);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const graphStyle = useStore((s) => s.graphStyle);
  const graphLayout = useStore((s) => s.graphLayout);
  const setGraphLayout = useStore((s) => s.setGraphLayout);
  const coverage = useStore((s) => s.coverage);
  const setCoverage = useStore((s) => s.setCoverage);
  const flowEnabled = useStore((s) => s.flowEnabled);
  const activitySize = useStore((s) => s.activitySize);
  const showValues = useStore((s) => s.showValues);
  const labelMode = useStore((s) => s.labelMode);
  const setShowValues = useStore((s) => s.setShowValues);
  const showMinimap = useStore((s) => s.showMinimap);
  const setTopics = useStore((s) => s.setTopics);

  // Other pages deep-link here with a broker preselected (Brokers page metric
  // tiles pass { state: { brokerId } }). Seeded once at mount; the validity
  // effect below swaps to the first connected broker if it never connects.
  const linkBrokerId = useLocation().state?.brokerId;
  const [selectedBrokers, setSelectedBrokers] = useState(() => (linkBrokerId ? [linkBrokerId] : [])); // broker ids to graph
  const [spHosts, setSpHosts] = useState([]); // Sparkplug host applications (spBv1.0/STATE/*)
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Selecting a node opens its details panel; the Properties button reopens it.
  const selectNode = (n) => {
    setSelected(n);
    setPanelOpen(Boolean(n));
  };
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Legend-as-filter: node groups hidden via the legend (persisted). Local
  // state on purpose — the shared store is being reworked in parallel.
  const [hiddenGroups, setHiddenGroups] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HIDDEN_GROUPS_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  });
  const toggleGroup = useCallback((group) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable — the filter still applies for this session.
      }
      return next;
    });
  }, []);
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph'); // 'graph' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [labelDensity, setLabelDensity] = useState(0.5); // 0 (off) .. 1 (dense)
  const [forcePositions, setForcePositions] = useState(null); // worker-computed force coords for show-all
  const [forceBusy, setForceBusy] = useState(false);
  // 3D look-and-feel controls (local — only the style is shared with the 2D views).
  const [nodeScale3d, setNodeScale3d] = useState(1);
  const [linkOpacity3d, setLinkOpacity3d] = useState(0.35);
  const [autoRotate3d, setAutoRotate3d] = useState(false);
  const [beautify3d, setBeautify3d] = useState(false);
  const [labelDensity3d, setLabelDensity3d] = useState(0.4);
  const [nodeShape3d, setNodeShape3d] = useState('sphere');
  const [flow3d, setFlow3d] = useState(false);
  const [activitySize3d, setActivitySize3d] = useState(false);
  const [beautify2d, setBeautify2d] = useState(false); // 2D visual mode: radial + bloom
  const FORCE_MAX = 30000; // force-layout worker node cap
  const graphRef = useRef(null);
  const graph3dRef = useRef(null);

  const connected = brokers.filter((b) => b.status === 'connected');
  const connectedIds = connected.map((b) => b.id).join(',');
  // Which brokers to graph. Empty = show none; 1 = single tree; 2+ = merged
  // multi-broker view. Kept in connected-order so the primary is stable.
  const activeBrokers = connected.filter((b) => selectedBrokers.includes(b.id));
  const activeIds = activeBrokers.map((b) => b.id).join(',');
  const multi = activeBrokers.length > 1;
  const brokerId = activeBrokers[0]?.id || null; // primary broker for single-broker surfaces
  const toggleBroker = (id) =>
    setSelectedBrokers((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Select a topic from the tree, shaping it like a graph node so the shared
  // detail panel works for both views.
  const selectTopic = useCallback(
    (c) => {
      setSelected({
        id: `topic:${brokerId}:${c.path}`,
        label: c.name,
        kind: 'topic',
        meta: {
          fullTopic: c.path,
          isLeaf: true,
          messageCount: c.stat?.messageCount,
          type: c.stat?.type,
          lastActivity: c.stat?.lastActivity
        }
      });
      setPanelOpen(true);
    },
    [brokerId]
  );

  // Seed with the first connected broker; prune any that disconnected; never
  // leave the selection empty while a broker is connected.
  useEffect(() => {
    if (!connected.length) return;
    setSelectedBrokers((prev) => {
      const valid = prev.filter((id) => connected.some((b) => b.id === id));
      if (valid.length) return valid.length === prev.length ? prev : valid;
      return [connected[0].id];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedIds]);

  // Pull the authoritative topic list for every active broker.
  useEffect(() => {
    activeBrokers.forEach((b) => api.brokerTopics(b.id).then((res) => setTopics(b.id, res.topics)).catch(() => {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds, setTopics]);

  // Sparkplug host applications (spBv1.0/STATE/*) — polled from the topology
  // snapshot; the strip only shows when the broker actually carries host STATE.
  useEffect(() => {
    if (!brokerId || multi) {
      setSpHosts([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .brokerSparkplug(brokerId)
        .then((res) => alive && setSpHosts(res.hosts || []))
        .catch(() => alive && setSpHosts([]));
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [brokerId]);

  const broker = brokers.find((b) => b.id === brokerId);
  const topicVersion = topicVersionMap[brokerId] || 0;
  // Combined topic-version across all connected brokers so all-mode recomputes
  // when ANY broker's topic set changes.
  const allTopicVersion = connected.reduce((s, b) => s + (topicVersionMap[b.id] || 0), 0);

  // Read the topic list from the non-reactive index; recompute only when the
  // topic SET changes (topicVersion), not on every message.
  const brokerTopics = useMemo(
    () => useStore.getState().getTopics(brokerId),
    [brokerId, topicVersion]
  );

  // Default node budget. Raised from 2,500 after the big-mode draw path got
  // bucketed point rendering + density-gated labels — 10k renders at the same
  // frame time 2,500 used to. Above ~4,000 ForceGraph switches to the
  // deterministic radial layout (no physics), which is what makes this cheap.
  const GRAPH_MAX_NODES = 10000;
  const fullGraph = useMemo(() => {
    if (!activeBrokers.length) return { nodes: [], links: [] };
    if (multi) {
      const topicsByBroker = Object.fromEntries(activeBrokers.map((b) => [b.id, useStore.getState().getTopics(b.id)]));
      return buildAllBrokersGraph(activeBrokers, topicsByBroker, { maxNodes: showAll ? Infinity : GRAPH_MAX_NODES });
    }
    return buildMqttGraph(activeBrokers[0], brokerTopics, { maxNodes: showAll ? Infinity : GRAPH_MAX_NODES });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds, multi, allTopicVersion, brokerTopics, showAll]);

  // Apply collapsed subtrees, then the legend's group filter. Keyed on the
  // collapsed/hidden sets so toggling either re-filters.
  const collapseKey = [...collapsed].sort().join('|');
  const hiddenKey = [...hiddenGroups].sort().join('|');
  const graph = useMemo(() => {
    const g = collapseGraph(fullGraph, collapsed);
    if (!hiddenGroups.size) return g;
    const hiddenIds = new Set();
    const nodes = g.nodes.filter((n) => {
      if (hiddenGroups.has(n.group)) {
        hiddenIds.add(n.id);
        return false;
      }
      return true;
    });
    const links = g.links.filter((l) => !hiddenIds.has(endId(l.source)) && !hiddenIds.has(endId(l.target)));
    return { ...g, nodes, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullGraph, collapseKey, hiddenKey]);
  // Groups present BEFORE filtering, so hidden groups stay listed in the legend
  // and can be re-enabled even when they filter down to zero visible nodes.
  const groupsPresent = useMemo(() => new Set(fullGraph.nodes.map((n) => n.group)), [fullGraph]);

  // Jump-to-node (detail-pane chips, breadcrumb): select the target AND center
  // the camera on it, like the search box does. A target hidden under a
  // collapsed branch (or a legend-hidden group) is revealed first, then
  // selected once the graph rebuild lands (pendingJumpRef bridges the render).
  const pendingJumpRef = useRef(null);
  useEffect(() => {
    const id = pendingJumpRef.current;
    if (!id) return;
    const n = graph.nodes.find((x) => x.id === id);
    if (n) {
      pendingJumpRef.current = null;
      selectNode(n);
      centerOn(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Center the active renderer's camera on a node: 2D fits the viewport to it,
  // 3D rotates the orbit so it faces the camera.
  const centerOn = (id) => {
    if (view === '3d') graph3dRef.current?.focusNode?.(id);
    else graphRef.current?.fitTo?.(new Set([id]));
  };

  const jumpToNode = (id) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (n) {
      selectNode(n);
      centerOn(id);
      return;
    }
    const inFull = fullGraph.nodes.find((x) => x.id === id);
    if (!inFull) return; // different broker / not in this graph — nothing honest to do
    pendingJumpRef.current = id;
    if (hiddenGroups.has(inFull.group)) toggleGroup(inFull.group);
    // Node ids embed the broker and full path (topic:<broker>:<path>), so a
    // simple prefix test finds every collapsed ancestor to expand.
    setCollapsed((prev) => {
      const next = new Set([...prev].filter((cid) => !(id === cid || String(id).startsWith(`${cid}/`))));
      return next.size === prev.size ? prev : next;
    });
  };

  // Toolbar collapse/expand: collapse everything below `level` (Infinity = show
  // all). Depth is a BFS from the roots of the full (uncollapsed) graph.
  // Re-frame the graph after collapse/expand changes the visible node set (the
  // one-shot auto-fit doesn't re-run, so a new layout would sit off-screen).
  const refitSoon = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => graphRef.current?.fitTo()));
  }, []);

  const expandToLevel = useCallback(
    (level) => {
      if (!Number.isFinite(level)) {
        setCollapsed(new Set());
        refitSoon();
        return;
      }
      const childrenOf = new Map();
      const incoming = new Set();
      for (const l of fullGraph.links) {
        const s = endId(l.source);
        const t = endId(l.target);
        if (!childrenOf.has(s)) childrenOf.set(s, []);
        childrenOf.get(s).push(t);
        incoming.add(t);
      }
      const depth = new Map();
      const queue = fullGraph.nodes.filter((n) => !incoming.has(n.id)).map((n) => (depth.set(n.id, 0), [n.id, 0]));
      while (queue.length) {
        const [id, d] = queue.shift();
        for (const c of childrenOf.get(id) || []) {
          if (!depth.has(c)) {
            depth.set(c, d + 1);
            queue.push([c, d + 1]);
          }
        }
      }
      const next = new Set();
      for (const n of fullGraph.nodes) {
        if ((depth.get(n.id) ?? 0) >= level && childrenOf.get(n.id)?.length) next.add(n.id);
      }
      setCollapsed(next);
      refitSoon();
    },
    [fullGraph, refitSoon]
  );

  // "Show coverage on topic map" from the Flows view: jump to the graph so the
  // painted trail is immediately visible.
  useEffect(() => {
    if (coverage?.brokerId === brokerId) setView('graph');
  }, [coverage, brokerId]);

  // A batch force layout is a snapshot for a specific node set — drop it
  // when the graph changes (new topics, collapse) so stale coordinates aren't
  // applied to different nodes; the view falls back to the radial layout.
  useEffect(() => {
    setForcePositions(null);
  }, [graph]);

  // Big-graph force layout, computed off the main thread in a Web Worker so the
  // UI stays responsive. The worker is spawned per run and terminated after it
  // posts back positions.
  const runForceLayout = useCallback(() => {
    if (graph.nodes.length > FORCE_MAX) {
      toast.error(`Force layout supports up to ${FORCE_MAX.toLocaleString()} nodes (this has ${graph.nodes.length.toLocaleString()}).`);
      return;
    }
    setForceBusy(true);
    const t = toast.loading('Computing force layout…');
    const worker = new Worker(new URL('../graph/forceLayoutWorker.js', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      setForceBusy(false);
    };
    worker.onmessage = (e) => {
      const { positions, count, error } = e.data || {};
      if (error || !positions) {
        toast.error(error || 'Layout failed', { id: t });
      } else {
        setForcePositions(positions);
        toast.success(`Force layout: ${count.toLocaleString()} nodes`, { id: t });
      }
      finish();
    };
    worker.onerror = () => {
      toast.error('Layout failed', { id: t });
      finish();
    };
    worker.postMessage({
      nodes: graph.nodes.map((n) => ({ id: n.id })),
      links: graph.links.map((l) => ({ source: l.source, target: l.target }))
    });
  }, [graph]);

  // Live buffer snapshot, refreshed at the throttled tick (not per message).
  const liveMsgs = useMemo(
    () => useStore.getState().getLiveMessages(brokerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brokerId, dataTick]
  );

  // Latest value + numeric sparkline per leaf topic, for the on-node overlay.
  const nodeValues = useMemo(() => {
    if (!brokerId) return null;
    const byTopic = new Map();
    for (const m of liveMsgs) {
      if (!byTopic.has(m.topic)) byTopic.set(m.topic, []);
      byTopic.get(m.topic).push(m);
    }
    const out = {};
    for (const [topic, msgs] of byTopic) {
      const ordered = msgs.slice().reverse(); // oldest→newest
      const series = ordered.map((m) => numericFromPayload(m.payload)).filter((v) => v != null);
      out[`topic:${brokerId}:${topic}`] = { text: shortText(msgs[0].payload), series: series.slice(-24) };
    }
    return out;
  }, [brokerId, liveMsgs]);

  // Feed live message activity to the graph's flow animation. Maps an incoming
  // message on any ACTIVE broker to its leaf node id (works in multi-broker mode
  // too, since node ids are namespaced per broker).
  const activitySource = useCallback(
    (pulse) => {
      const active = new Set(activeIds.split(',').filter(Boolean));
      return onMessageActivity((msg) => {
        if (!active.has(msg.brokerId)) return;
        pulse(`topic:${msg.brokerId}:${msg.topic}`);
      });
    },
    [activeIds]
  );

  // Double-click a branch node to collapse/expand its subtree.
  const toggleCollapse = useCallback((node) => {
    if (!node || node.meta?.isLeaf) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);


  // Frame the whole network when Show all is toggled on.
  useEffect(() => {
    if (showAll) {
      const t = setTimeout(() => graphRef.current?.fitTo(), 250);
      return () => clearTimeout(t);
    }
  }, [showAll]);

  if (connected.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Topic Graph" subtitle="Interactive node graph of the MQTT topic namespace" helpTopic="guide-explore-topics" />
        <EmptyState
          icon={Share2}
          title="No connected brokers"
          hint="Connect to an MQTT broker to visualize its live topic tree as a node graph."
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
        title="Topics"
        helpTopic="guide-explore-topics"
        subtitle={
          multi
            ? `${activeBrokers.length} brokers · ${graph.nodes.length} nodes`
            : broker
              ? `${brokerTopics.length} topics · ${graph.nodes.length} nodes`
              : 'Select a broker'
        }
        actions={
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
              <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <BrokerMultiSelect
              connected={connected}
              selected={selectedBrokers}
              onToggle={(id) => {
                toggleBroker(id);
                setSelected(null);
              }}
              onOnly={(id) => {
                setSelectedBrokers([id]);
                setSelected(null);
              }}
              onAll={() => {
                setSelectedBrokers(connected.map((b) => b.id));
                setSelected(null);
              }}
            />
          </div>
        }
      />

      {spHosts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-surface-900/40 px-4 py-2">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Cpu size={12} className="text-accent-400" /> Host applications
          </span>
          {spHosts.map((h) => (
            <span
              key={h.id}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-[11px]"
              title={`spBv1.0/STATE/${h.id}`}
            >
              <span className={clsx('h-1.5 w-1.5 rounded-full', h.online ? 'bg-emerald-400' : h.online === false ? 'bg-rose-400' : 'bg-slate-500')} />
              <span className="font-mono text-slate-200">{h.id}</span>
              <Badge status={h.online ? 'connected' : 'offline'}>{h.online ? 'online' : h.online === false ? 'offline' : 'unknown'}</Badge>
              {(h.timestamp || h.lastSeen) && (
                <span className="text-slate-500">
                  {formatDistanceToNow(new Date(h.timestamp || h.lastSeen), { addSuffix: true })}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="relative flex flex-1 overflow-hidden">
        {view === 'tree' ? (
          <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
              <Search size={14} className="text-slate-500" />
              <input
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter topics…"
                className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <TopicTree
              topics={brokerTopics}
              selectedTopic={selected?.meta?.fullTopic}
              onSelect={selectTopic}
              filter={treeFilter}
            />
          </div>
        ) : view === '3d' ? (
          <div className="relative min-w-0 flex-1">
            <Suspense fallback={<RendererLoading />}>
              <ForceGraph3D
                ref={graph3dRef}
                data={graph}
                styleId={graphStyle}
                selectedId={selected?.id || null}
                onSelect={selectNode}
                nodeScale={nodeScale3d}
                linkOpacity={linkOpacity3d}
                autoRotate={autoRotate3d}
                beautify={beautify3d}
                labelDensity={labelDensity3d}
                showValues={showValues}
                nodeValues={showValues ? nodeValues : null}
                labelMode={labelMode}
                nodeShape={nodeShape3d}
                flow={flow3d}
                activitySize={activitySize3d}
                activitySource={activitySource}
              />
            </Suspense>
            <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
              <button
                onClick={() => selected && setPanelOpen(true)}
                disabled={!selected}
                title={selected ? 'Show properties of the selected node' : 'Select a node first'}
                className={clsx(
                  'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm backdrop-blur transition',
                  selected
                    ? 'border-white/10 bg-surface-900/80 text-slate-300 hover:border-white/20 hover:text-slate-100'
                    : 'cursor-not-allowed border-white/5 bg-surface-900/60 text-slate-600'
                )}
              >
                <PanelRight size={15} />
                <span className="hidden font-medium sm:inline">Properties</span>
              </button>
              <button
                onClick={() => graph3dRef.current?.resetView()}
                title="Reset the camera to the default angle and zoom"
                className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-2 text-sm text-slate-300 backdrop-blur transition hover:border-white/20 hover:text-slate-100"
              >
                <Maximize2 size={15} />
                <span className="hidden font-medium sm:inline">Reset view</span>
              </button>
            </div>
            <Graph3DControls
              beautify={beautify3d}
              onBeautify={() => setBeautify3d((v) => !v)}
              autoRotate={autoRotate3d}
              onAutoRotate={() => setAutoRotate3d((v) => !v)}
              nodeScale={nodeScale3d}
              onNodeScale={setNodeScale3d}
              linkOpacity={linkOpacity3d}
              onLinkOpacity={setLinkOpacity3d}
              labelDensity={labelDensity3d}
              onLabelDensity={setLabelDensity3d}
              showValues={showValues}
              onShowValues={() => setShowValues(!showValues)}
              nodeShape={nodeShape3d}
              onNodeShape={setNodeShape3d}
              flow={flow3d}
              onFlow={() => setFlow3d((v) => !v)}
              activitySize={activitySize3d}
              onActivitySize={() => setActivitySize3d((v) => !v)}
            />
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
              Drag to rotate. Scroll to zoom. Click a node for details. The style dropdown up top restyles this view too.
            </div>
            <GraphLegend styleId={graphStyle} groups={groupsPresent} hiddenGroups={hiddenGroups} onToggleGroup={toggleGroup} />
          </div>
        ) : (
          <div className="relative min-w-0 flex-1">
            {!showAll && (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} onSelect={selectNode} />
                <GraphToolbar
                  showFlow
                  onFit={() => graphRef.current?.fitTo()}
                  onBeautify={() => {
                    const on = !beautify2d;
                    setBeautify2d(on);
                    setGraphLayout(on ? 'radial' : DEFAULT_LAYOUT);
                  }}
                  beautifyActive={beautify2d}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `topic-graph-${brokerId}.png`)}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `topic-graph-${brokerId}.json`)}
                  onProperties={() => setPanelOpen(true)}
                  hasSelection={Boolean(selected)}
                  onExpandLevel={expandToLevel}
                />
              </>
            )}
            {showAll ? (
              // GPU renderer for the "show everything" view — one draw call per
              // frame plus a viewport-culled label overlay stays smooth at 60k+.
              <Suspense fallback={<RendererLoading />}>
                <WebGLGraph data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={selectNode} labelDensity={labelDensity} positions={forcePositions} />
              </Suspense>
            ) : (
              <ForceGraph
                ref={graphRef}
                data={graph}
                styleId={graphStyle}
                layoutId={graphLayout}
                selectedId={selected?.id || null}
                onSelect={selectNode}
                onExpand={toggleCollapse}
                flow={flowEnabled}
                activitySource={activitySource}
                activitySize={activitySize}
                nodeValues={showValues ? nodeValues : null}
                labelMode={labelMode}
                matchIds={coverage?.brokerId === brokerId ? coverage.matchIds : matchIds}
                minimap={showMinimap}
                beautify={beautify2d}
              />
            )}
            <GraphLegend styleId={graphStyle} groups={groupsPresent} hiddenGroups={hiddenGroups} onToggleGroup={toggleGroup} />
            {coverage?.brokerId === brokerId && !showAll && (
              // Coverage paint handed over from the Flows view: the highlighted
              // trail is exactly what the chosen client actually receives.
              <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-xl border border-accent-500/50 bg-accent-500/15 px-3 py-2 text-[11px] text-accent-200 backdrop-blur">
                <span>{coverage.label}</span>
                <button onClick={() => setCoverage(null)} title="Clear coverage highlight" className="rounded p-0.5 hover:bg-white/10">
                  <X size={12} />
                </button>
              </div>
            )}
            {(graph.capped || showAll) && (
              <div className="absolute left-4 top-16 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] backdrop-blur transition',
                    showAll
                      ? 'border-accent-500/60 bg-accent-500/15 text-accent-200'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  )}
                >
                  <Boxes size={13} />
                  {showAll
                    ? `Showing all ${graph.nodes.length.toLocaleString()} nodes`
                    : `Show all ${brokerTopics.length.toLocaleString()} topics as nodes`}
                </button>

                {/* One unified control cluster for the big-graph view */}
                {showAll && (
                  <div className="flex items-stretch divide-x divide-white/10 overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 text-[11px] backdrop-blur">
                    <Segment>
                      <SegLabel>Layout</SegLabel>
                      <SegBtn active={!forcePositions} onClick={() => setForcePositions(null)} title="Deterministic radial layout">
                        Radial
                      </SegBtn>
                      <SegBtn
                        active={Boolean(forcePositions)}
                        onClick={runForceLayout}
                        disabled={forceBusy || graph.nodes.length > FORCE_MAX}
                        title={
                          graph.nodes.length > FORCE_MAX
                            ? `Force layout supports up to ${FORCE_MAX.toLocaleString()} nodes`
                            : 'Organic force-directed layout (computed in a Web Worker)'
                        }
                      >
                        {forceBusy ? <Loader2 size={12} className="animate-spin" /> : <Waypoints size={12} />}
                        Force
                      </SegBtn>
                    </Segment>

                    <Segment>
                      <SegLabel>
                        <Tag size={11} /> Labels
                      </SegLabel>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={labelDensity}
                        onChange={(e) => setLabelDensity(Number(e.target.value))}
                        className="h-1 w-20 cursor-pointer accent-accent-400"
                        title="Label density"
                      />
                      <span className="w-7 tabular-nums text-slate-500">{labelDensity <= 0.001 ? 'off' : `${Math.round(labelDensity * 100)}%`}</span>
                    </Segment>
                  </div>
                )}
                {showAll && graph.nodes.length > 60000 && (
                  <span className="rounded-lg bg-surface-900/70 px-2 py-1 text-[10px] text-slate-500 backdrop-blur">heavy — zoom in for detail</span>
                )}
              </div>
            )}
            <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
              <div className="rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
                Drag · scroll to zoom · click for details · double-click a branch to collapse · messages animate live
              </div>
            </div>
          </div>
        )}

        {selected && panelOpen && (
          <TopicPanel
            node={selected}
            brokerId={brokerId}
            messages={liveMsgs}
            graph={graph}
            onJump={jumpToNode}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}


// Segmented-toolbar primitives for the unified big-graph control cluster.
function Segment({ children }) {
  return <div className="flex items-center gap-1.5 px-2 py-1.5">{children}</div>;
}
function SegLabel({ children }) {
  return <span className="flex items-center gap-1 pr-0.5 text-[10px] uppercase tracking-wide text-slate-500">{children}</span>;
}
function SegBtn({ active, onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'flex items-center gap-1 rounded-md px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-accent-500/20 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      {children}
    </button>
  );
}

// Legend + group labels live in components/GraphLegend.jsx; the 3D look-and-feel
// controls live in components/Graph3DControls.jsx (both shared across views).

// Multi-select of connected brokers: pick one, several, or all. Selecting 2+
// merges their topic trees into one graph. Each row can toggle, or "only" it.
function BrokerMultiSelect({ connected, selected, onToggle, onOnly, onAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);
  const activeCount = connected.filter((b) => selected.includes(b.id)).length;
  const label = activeCount === 0 ? 'No brokers' : activeCount === 1 ? connected.find((b) => selected.includes(b.id))?.name : `${activeCount} brokers`;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 transition hover:border-white/20"
      >
        <Radio size={14} className="text-accent-400" />
        <span className="max-w-[180px] truncate font-medium">{label}</span>
        <ChevronDown size={14} className={clsx('text-slate-500 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-xl border border-white/10 bg-surface-900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Brokers ({connected.length})</span>
            <button onClick={onAll} className="text-2xs font-medium text-accent-300 hover:text-accent-200">
              Select all
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {connected.map((b) => {
              const on = selected.includes(b.id);
              return (
                <div key={b.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-white/5">
                  <button onClick={() => onToggle(b.id)} className="flex flex-1 items-center gap-2 text-left">
                    <span className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-accent-500 bg-accent-500/20' : 'border-white/20')}>
                      {on && <Check size={11} className="text-accent-300" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{b.name}</span>
                  </button>
                  <button
                    onClick={() => onOnly(b.id)}
                    className="rounded px-1.5 py-0.5 text-2xs font-medium text-slate-500 opacity-0 transition hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100"
                    title="Show only this broker"
                  >
                    only
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Resolve a link endpoint whether it's still an id string or a d3-mutated node object.
const endId = (e) => (e && typeof e === 'object' ? e.id : e);

// One labelled row in the Location card (Parent / Siblings / Children).
function RelRow({ label, children }) {
  return (
    <div className="mb-2 flex items-start gap-2 last:mb-0">
      <span className="mt-1 w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// A jump-to-node chip for a neighbouring topic.
function RelChip({ node, onJump }) {
  return (
    <button
      onClick={() => onJump?.(node.id)}
      title={`Jump to ${node.meta?.fullTopic || node.label}`}
      className="mono inline-flex max-w-full items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-slate-300 transition hover:border-accent-500/40 hover:bg-accent-500/10 hover:text-accent-200"
    >
      <span className="truncate">{node.label}</span>
    </button>
  );
}

function TopicPanel({ node, brokerId, messages, graph, onJump, onClose }) {
  const meta = node.meta || {};
  const fullTopic = meta.fullTopic;
  const [history, setHistory] = useState([]);
  const [publishValue, setPublishValue] = useState('');
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [diffSel, setDiffSel] = useState([]); // up to two message ids for payload diff
  const [historyOpen, setHistoryOpen] = useState(false); // full history-chart popup
  const [expanded, setExpanded] = useState(false); // blow the panel up to a large modal

  useEffect(() => {
    if (!fullTopic) return undefined;
    // alive guard: clicking topic B before A's history resolves mustn't show A's
    // messages under B. `res?.messages ?? []` guards a malformed reply.
    let alive = true;
    api
      .topicMessages(brokerId, fullTopic, 30)
      .then((res) => {
        if (alive) setHistory((res?.messages ?? []).slice().reverse());
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, [brokerId, fullTopic]);

  // Esc restores the expanded panel to its docked size.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // Merge in live messages for this exact topic
  const live = messages.filter((m) => m.topic === fullTopic);
  const merged = [...live, ...history.filter((h) => !live.some((l) => l.id === h.id))].slice(0, 40);
  const latest = merged[0];

  const publish = async () => {
    try {
      await api.publish(brokerId, fullTopic, publishValue, { qos, retain });
      toast.success(retain ? 'Published (retained)' : 'Published');
      setPublishValue('');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const deleteRetained = async () => {
    // This publishes an empty retained message to the LIVE broker — every other
    // consumer of this topic loses its retained value (device configs, Sparkplug
    // STATE, last-known values). Confirm the exact topic first.
    if (!window.confirm(`Clear the retained message on "${fullTopic}"?\n\nThis publishes an empty retained payload to the broker. Every other client subscribed to this topic will lose its retained value.`)) {
      return;
    }
    try {
      await api.publish(brokerId, fullTopic, '', { retain: true });
      toast.success('Cleared retained message');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed')
    );
  };

  // Numeric value history (oldest → newest), with timestamps for a real time
  // axis in the history popup.
  const numericPoints = merged
    .slice()
    .reverse()
    .map((m) => ({ ts: new Date(m.timestamp).getTime(), v: numericFromPayload(m.payload) }))
    .filter((p) => p.v != null && Number.isFinite(p.ts));
  const numericSeries = numericPoints.map((p) => p.v);

  // Neighbours in the topic tree, from the graph's parent→child links: the
  // parent, the siblings under it, and this node's own children. Each is
  // clickable to jump the selection there.
  const links = graph?.links || [];
  const nodeById = (id) => graph?.nodes.find((n) => n.id === id) || null;
  const parentId = links.find((l) => endId(l.target) === node.id) ? endId(links.find((l) => endId(l.target) === node.id).source) : null;
  const parentNode = parentId ? nodeById(parentId) : null;
  const siblings = parentId
    ? links.filter((l) => endId(l.source) === parentId).map((l) => endId(l.target)).filter((id) => id !== node.id).map(nodeById).filter(Boolean)
    : [];
  const children = links.filter((l) => endId(l.source) === node.id).map((l) => endId(l.target)).map(nodeById).filter(Boolean);
  const segments = fullTopic ? fullTopic.split('/') : [];

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {meta.isLeaf ? 'Topic' : node.kind === 'broker' ? 'Broker' : 'Topic branch'}
          </p>
          <div className="flex items-center gap-1.5">
            <p className="mono mt-0.5 break-all text-sm font-medium text-slate-100">{fullTopic || node.label}</p>
            {fullTopic && (
              <button onClick={() => copy(fullTopic)} title="Copy topic" className="shrink-0 text-slate-500 hover:text-slate-300">
                <Copy size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Restore panel (Esc)' : 'Expand panel to a larger view'}
            aria-label={expanded ? 'Restore panel' : 'Expand panel'}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={onClose} aria-label="Close panel" className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {meta.isLeaf && (
          <div className="grid grid-cols-3 gap-2">
            <Stat icon={Hash} label="Messages" value={meta.messageCount ?? '—'} />
            <Stat icon={Gauge} label="Type" value={<Badge>{meta.type}</Badge>} />
            <Stat
              icon={Clock}
              label="Last seen"
              value={meta.lastActivity ? formatDistanceToNow(new Date(meta.lastActivity), { addSuffix: true }) : '—'}
            />
          </div>
        )}

        {/* Location in the topic tree: a clickable breadcrumb plus the parent,
            siblings, and children as jump targets. */}
        {fullTopic && (parentNode || siblings.length > 0 || children.length > 0 || segments.length > 1) && (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Location</p>
            <div className="mb-3 flex flex-wrap items-center text-[11px]">
              {segments.map((seg, i) => {
                const last = i === segments.length - 1;
                const path = segments.slice(0, i + 1).join('/');
                return (
                  <span key={i} className="flex items-center">
                    {i > 0 && <span className="px-0.5 text-slate-600">/</span>}
                    {last ? (
                      <span className="mono font-medium text-slate-200">{seg}</span>
                    ) : (
                      <button
                        onClick={() => onJump?.(`topic:${brokerId}:${path}`)}
                        title={`Jump to ${path}`}
                        className="mono rounded px-1 py-0.5 text-slate-400 transition hover:bg-white/10 hover:text-accent-300"
                      >
                        {seg}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {parentNode && (
              <RelRow label="Parent">
                <RelChip node={parentNode} onJump={onJump} />
              </RelRow>
            )}
            {siblings.length > 0 && (
              <RelRow label={`Siblings ${siblings.length}`}>
                <div className="flex flex-wrap gap-1">
                  {siblings.slice(0, 30).map((s) => (
                    <RelChip key={s.id} node={s} onJump={onJump} />
                  ))}
                  {siblings.length > 30 && <span className="self-center text-[10px] text-slate-500">+{siblings.length - 30} more</span>}
                </div>
              </RelRow>
            )}
            {children.length > 0 && (
              <RelRow label={`Children ${children.length}`}>
                <div className="flex flex-wrap gap-1">
                  {children.slice(0, 30).map((c) => (
                    <RelChip key={c.id} node={c} onJump={onJump} />
                  ))}
                  {children.length > 30 && <span className="self-center text-[10px] text-slate-500">+{children.length - 30} more</span>}
                </div>
              </RelRow>
            )}
          </div>
        )}

        {latest && (
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Latest payload</p>
              <button
                onClick={() =>
                  copy(typeof latest.payload === 'object' ? JSON.stringify(latest.payload) : String(latest.payload))
                }
                title="Copy value"
                className="text-slate-500 hover:text-slate-300"
              >
                <Copy size={13} />
              </button>
            </div>
            {latest.sparkplug ? (
              <JsonView data={latest.sparkplug} name="sparkplug" />
            ) : typeof latest.payload === 'object' ? (
              <JsonView data={latest.payload} />
            ) : (
              <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-emerald-300">
                {String(latest.payload)}
              </pre>
            )}
            {numericSeries.length >= 2 && <PanelPlot series={numericSeries} onExpand={() => setHistoryOpen(true)} />}
          </Card>
        )}

        {historyOpen && (
          <HistoryChartModal topic={fullTopic} points={numericPoints} onClose={() => setHistoryOpen(false)} />
        )}

        {meta.isLeaf && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Publish</p>
              <div className="flex items-center gap-2">
                <select
                  value={qos}
                  onChange={(e) => setQos(Number(e.target.value))}
                  className="rounded-md border border-white/10 bg-surface-950/60 px-1.5 py-0.5 text-[11px] text-slate-300"
                  title="QoS"
                >
                  <option value={0}>QoS 0</option>
                  <option value={1}>QoS 1</option>
                  <option value={2}>QoS 2</option>
                </select>
                <label className="flex items-center gap-1 text-[11px] text-slate-400">
                  <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> retain
                </label>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                value={publishValue}
                onChange={(e) => setPublishValue(e.target.value)}
                placeholder="Payload…"
                onKeyDown={(e) => e.key === 'Enter' && publish()}
              />
              <Button onClick={publish} disabled={!publishValue}>
                <Send size={14} />
              </Button>
            </div>
            <button
              onClick={deleteRetained}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-rose-300"
            >
              <Trash2 size={12} /> Clear retained message
            </button>
          </div>
        )}

        {merged.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                History ({merged.length})
              </p>
              <span className="text-[10px] text-slate-600">
                {diffSel.length === 0 ? 'pick two to diff' : diffSel.length === 1 ? 'pick one more' : ''}
              </span>
            </div>
            <PayloadDiffCard messages={merged} sel={diffSel} onClear={() => setDiffSel([])} />
            <div className="space-y-1">
              {merged.map((m) => {
                const inDiff = diffSel.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className={clsx(
                      'rounded-lg border px-2.5 py-1.5',
                      inDiff ? 'border-accent-500/40 bg-accent-500/10' : 'border-white/5 bg-white/[0.02]'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-600">QoS {m.qos}</span>
                        <button
                          title={inDiff ? 'Remove from diff' : 'Select for diff'}
                          onClick={() =>
                            setDiffSel((prev) =>
                              prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev.slice(-1), m.id]
                            )
                          }
                          className={clsx('rounded p-0.5', inDiff ? 'text-accent-300' : 'text-slate-600 hover:text-slate-300')}
                        >
                          <GitCompareArrows size={12} />
                        </button>
                      </span>
                    </div>
                    <p className="mono mt-0.5 truncate text-xs text-slate-300">
                      {typeof m.payload === 'object' ? JSON.stringify(m.payload) : String(m.payload)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );

  // Expanded: reflow the same content into a large centered modal so the
  // decoded Sparkplug metrics and the full history list have room to breathe.
  if (expanded) {
    return (
      <div
        className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-6 backdrop-blur-sm"
        onClick={() => setExpanded(false)}
      >
        <div
          className="flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Topic detail"
        >
          {inner}
        </div>
      </div>
    );
  }
  return <aside className="flex w-96 shrink-0 flex-col border-l border-white/5 bg-surface-900/50">{inner}</aside>;
}

// Structural diff of two selected history messages (older → newer). Shows what
// actually changed between publishes — the fastest way to spot a misbehaving
// field in a fat JSON payload.
function PayloadDiffCard({ messages, sel, onClear }) {
  if (sel.length !== 2) return null;
  const pair = messages.filter((m) => sel.includes(m.id));
  if (pair.length !== 2) return null;
  const [older, newer] = pair.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const changes = diffPayloads(older.payload, newer.payload);
  const KIND_CLASS = { added: 'text-emerald-300', removed: 'text-rose-300', changed: 'text-amber-300' };
  return (
    <Card className="mb-2 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          <GitCompareArrows size={12} className="text-accent-300" /> Payload diff
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">
            {new Date(older.timestamp).toLocaleTimeString()} → {new Date(newer.timestamp).toLocaleTimeString()}
          </span>
          <button onClick={onClear} className="text-slate-500 hover:text-slate-300">
            <X size={12} />
          </button>
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="text-[11px] text-slate-500">Payloads are identical.</p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px]">
          {changes.slice(0, 100).map((c, i) => (
            <div key={i} className="flex items-baseline gap-1.5">
              <span className={`shrink-0 ${KIND_CLASS[c.kind]}`}>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '±'}</span>
              <span className="shrink-0 text-slate-400">{c.path}</span>
              <span className="truncate text-slate-500">
                {c.kind === 'added'
                  ? formatDiffValue(c.to)
                  : c.kind === 'removed'
                    ? formatDiffValue(c.from)
                    : `${formatDiffValue(c.from)} → ${formatDiffValue(c.to)}`}
              </span>
            </div>
          ))}
          {changes.length > 100 && <p className="text-slate-500">…{changes.length - 100} more changes</p>}
        </div>
      )}
    </Card>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
      <Icon size={14} className="text-slate-500" />
      <p className="mt-1.5 text-sm font-medium text-slate-200">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

// Compact value-history sparkline for the detail panel, with an expand action.
function PanelPlot({ series, onExpand }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  return (
    <div className="mt-3 rounded-lg border border-white/5 bg-surface-950/50 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wide text-slate-500">Value history</span>
        {onExpand && (
          <button onClick={onExpand} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-slate-400 transition hover:bg-white/5 hover:text-accent-300">
            <Maximize2 size={11} /> Expand
          </button>
        )}
      </div>
      <div className="cursor-pointer" onClick={onExpand}>
        <Sparkline values={series} height={72} />
      </div>
      <div className="mono mt-1 flex justify-between text-2xs text-slate-500">
        <span>min {fmtNum(min)}</span>
        <span>{series.length} pts</span>
        <span>max {fmtNum(max)}</span>
      </div>
    </div>
  );
}

// Full value-history chart in a popup — the shared Recharts time-series (grid,
// axes, hover tooltip) plus summary stats. Built from the in-memory
// recent-message ring for the topic; no historian required.
function HistoryChartModal({ topic, points, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const last = points[points.length - 1];
  const tspan = points[points.length - 1].ts - points[0].ts || 1;
  const durS = Math.max(1, Math.round(tspan / 1000));
  const durLabel = durS < 90 ? `${durS}s` : durS < 5400 ? `${Math.round(durS / 60)}m` : `${(durS / 3600).toFixed(1)}h`;
  const chartSeries = [{ tag: topic, points: points.map((p) => [p.ts, p.v]) }];

  const Stat = ({ label, value }) => (
    <div>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mono text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-surface-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Value history">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xs uppercase tracking-wide text-slate-500">Value history · last {durLabel}</p>
            <p className="mono truncate text-sm font-medium text-slate-100">{topic}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200">
            <X size={16} />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3 rounded-xl border border-white/5 bg-surface-950/40 p-3">
          <Stat label="Last" value={fmtNum(last.v)} />
          <Stat label="Min" value={fmtNum(min)} />
          <Stat label="Max" value={fmtNum(max)} />
          <Stat label="Avg" value={fmtNum(avg)} />
        </div>
        <div className="mt-3 rounded-xl border border-white/5 bg-surface-950/40 p-2">
          <TimeSeriesChart series={chartSeries} height={280} />
          <div className="mono mt-1 px-1 text-center text-2xs text-slate-500">
            {points.length} points · from the live message ring
          </div>
        </div>
      </div>
    </div>
  );
}
