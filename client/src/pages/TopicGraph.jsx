import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Share2, X, ListTree, Search, Boxes, Box, Tag, Waypoints, Loader2, Cpu, Maximize2, PanelRight, RotateCw } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useStore, onMessageActivity } from '@/store/store';
import { useGraphPrefs, useCoverage } from '@/store/selectors';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import { buildMqttGraph, collapseGraph } from '@/graph/buildGraph';
import { DEFAULT_LAYOUT } from '@/graph/graphStyles';
import { deriveTopicCount } from '@/graph/topicCount';
import GraphToolbar from '@/components/GraphToolbar';
import GraphLegend from '@/components/GraphLegend';
import GraphSearch from '@/components/GraphSearch';
import ReplayScrubber from '@/components/ReplayScrubber';
import TopicTree from '@/components/TopicTree';
import ResponsiveHeader from '@/components/ResponsiveHeader';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { Badge, Button, EmptyState } from '@/components/ui';
import ViewTab from '@/components/ViewTab';
import { formatDistanceToNow } from 'date-fns';
import TopicPanel from './topics/TopicPanel';
import Graph3DControls from './topics/Graph3DControls';
import { Segment, SegLabel, SegBtn } from './topics/Segments';
import { numericFromPayload, shortText } from './topics/topicUtils';
import { loadSavedView, saveView, resolveTopicsView, TREE_DEFAULT_THRESHOLD } from './topics/viewPref';

// Heavy renderers load on demand: three.js (3D view) and the WebGL big-graph
// renderer aren't part of the initial bundle: most sessions never open them.
const ForceGraph3D = lazy(() => import('@/graph/ForceGraph3D'));
const WebGLGraph = lazy(() => import('@/graph/WebGLGraph'));

function RendererLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-400" role="status">
      <Loader2 size={14} className="mr-2 animate-spin" /> Loading renderer…
    </div>
  );
}

const FORCE_MAX = 30000; // force-layout worker node cap
const GRAPH_MAX_NODES = 2500;

export default function TopicGraph() {
  const brokers = useStore((s) => s.brokers);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const setTopics = useStore((s) => s.setTopics);
  const { graphStyle, graphLayout, setGraphLayout, flowEnabled, activitySize, showValues, showMinimap } = useGraphPrefs();
  const { coverage, setCoverage } = useCoverage();

  const [brokerId, setBrokerId] = useState(null);
  const [spHosts, setSpHosts] = useState([]); // Sparkplug host applications (spBv1.0/STATE/*)
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Selecting a node opens its details panel; the Properties button reopens it.
  const selectNode = (n) => {
    setSelected(n);
    setPanelOpen(Boolean(n));
  };
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [matchIds, setMatchIds] = useState(null);
  const [userView, setUserView] = useState(loadSavedView); // remembered explicit choice (or null)
  const [treeFilter, setTreeFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [labelDensity, setLabelDensity] = useState(0.5); // 0 (off) .. 1 (dense)
  const [forcePositions, setForcePositions] = useState(null); // worker-computed force coords for show-all
  const [forceBusy, setForceBusy] = useState(false);
  const [topicsError, setTopicsError] = useState(null);
  const [topicsTry, setTopicsTry] = useState(0);
  // 3D look-and-feel controls (local: only the style is shared with the 2D views).
  const [nodeScale3d, setNodeScale3d] = useState(1);
  const [linkOpacity3d, setLinkOpacity3d] = useState(0.35);
  const [autoRotate3d, setAutoRotate3d] = useState(false);
  const [beautify3d, setBeautify3d] = useState(false);
  const graphRef = useRef(null);
  const graph3dRef = useRef(null);
  const nodeValuesRef = useRef(null);

  const connected = useMemo(() => brokers.filter((b) => b.status === 'connected'), [brokers]);

  // Default to the first connected broker
  useEffect(() => {
    if (!brokerId && connected.length) setBrokerId(connected[0].id);
    if (brokerId && !brokers.some((b) => b.id === brokerId)) setBrokerId(connected[0]?.id || null);
  }, [connected, brokerId, brokers]);

  // Pull the authoritative topic list when broker changes
  useEffect(() => {
    if (!brokerId) return undefined;
    let alive = true;
    api
      .brokerTopics(brokerId)
      .then((res) => {
        if (!alive) return;
        setTopicsError(null);
        setTopics(brokerId, res.topics);
      })
      .catch((e) => alive && setTopicsError(e?.message || 'Could not load the topic list'));
    return () => {
      alive = false;
    };
  }, [brokerId, setTopics, topicsTry]);

  // Sparkplug host applications (spBv1.0/STATE/*), polled from the topology
  // snapshot; the strip only shows when the broker actually carries host STATE.
  useEffect(() => {
    if (!brokerId) {
      setSpHosts([]);
      return undefined;
    }
    let alive = true;
    const load = () =>
      api
        .brokerSparkplug(brokerId)
        .then((res) => alive && setSpHosts(res.hosts || []))
        .catch(() => alive && setSpHosts([])); // optional strip: absence is the honest empty state
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

  // Read the topic list from the non-reactive index; recompute only when the
  // topic SET changes (topicVersion), not on every message.
  const brokerTopics = useMemo(
    () => useStore.getState().getTopics(brokerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brokerId, topicVersion]
  );
  // Same derivation as Overview: the larger of the client index and the server's exact count.
  const topicCount = deriveTopicCount(brokerTopics.length, broker?.metrics?.topicCount);

  const view = resolveTopicsView(userView, topicCount);
  const autoTree = userView == null && view === 'tree';
  const setView = (v) => {
    setUserView(v);
    saveView(v);
  };

  const fullGraph = useMemo(() => {
    if (!broker) return { nodes: [], links: [] };
    return buildMqttGraph(broker, brokerTopics, { maxNodes: showAll ? Infinity : GRAPH_MAX_NODES });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broker?.id, brokerTopics, showAll]);

  // Apply collapsed subtrees. Keyed on the collapsed set so toggling re-filters.
  const collapseKey = [...collapsed].sort().join('|');
  const graph = useMemo(
    () => collapseGraph(fullGraph, collapsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullGraph, collapseKey]
  );
  // Groups actually present, for the color legend.
  const groupsPresent = useMemo(() => new Set(graph.nodes.map((n) => n.group)), [graph]);

  // "Show coverage on topic map" from the Flows view: jump to the graph so the
  // painted trail is immediately visible (without overwriting the saved preference).
  useEffect(() => {
    if (coverage?.brokerId === brokerId) setUserView('graph');
  }, [coverage, brokerId]);

  // A batch force layout is a snapshot for a specific node set: drop it when the
  // graph changes so stale coordinates aren't applied to different nodes.
  useEffect(() => {
    setForcePositions(null);
  }, [graph]);

  // Big-graph force layout, computed off the main thread in a Web Worker.
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

  // Latest value + numeric sparkline per leaf topic for the on-node overlay.
  // Computed OUTSIDE React render, at the store's throttled tick, and only while
  // the 2D graph with values is actually on screen and the tab is visible; the
  // renderer reads it through a ref and is asked to repaint (no page re-render).
  const wantValues = view === 'graph' && !showAll && showValues && Boolean(brokerId);
  useEffect(() => {
    if (!wantValues) {
      nodeValuesRef.current = null;
      return undefined;
    }
    const compute = () => {
      const msgs = useStore.getState().getLiveMessages(brokerId);
      const byTopic = new Map();
      for (const m of msgs) {
        if (!byTopic.has(m.topic)) byTopic.set(m.topic, []);
        byTopic.get(m.topic).push(m);
      }
      const out = {};
      for (const [topic, list] of byTopic) {
        const series = list
          .slice()
          .reverse() // oldest to newest
          .map((m) => numericFromPayload(m.payload))
          .filter((v) => v != null);
        out[`topic:${brokerId}:${topic}`] = { text: shortText(list[0].payload), series: series.slice(-24) };
      }
      nodeValuesRef.current = out;
      graphRef.current?.redraw?.();
    };
    compute();
    return useStore.subscribe((s, prev) => {
      if (s.dataTick !== prev.dataTick && document.visibilityState === 'visible') compute();
    });
  }, [wantValues, brokerId]);

  // Feed live message activity to the graph's flow animation.
  const activitySource = useCallback(
    (pulse) =>
      onMessageActivity((msg) => {
        if (msg.brokerId !== brokerId) return;
        pulse(`topic:${brokerId}:${msg.topic}`);
      }),
    [brokerId]
  );

  // Select a topic from the tree, shaping it like a graph node so the shared
  // detail panel works for both views.
  const selectTopic = useCallback(
    (c) => {
      setSelected({
        id: `topic:${brokerId}:${c.path}`,
        label: c.name,
        kind: 'topic',
        meta: { fullTopic: c.path, isLeaf: true, messageCount: c.stat?.messageCount, type: c.stat?.type, lastActivity: c.stat?.lastActivity }
      });
      setPanelOpen(true);
    },
    [brokerId]
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

  const replayNodeId = useCallback((m) => `topic:${brokerId}:${m.topic}`, [brokerId]);
  const getReplayMessages = useCallback(() => useStore.getState().getLiveMessages(brokerId), [brokerId]);

  // Frame the whole network when Show all is toggled on.
  useEffect(() => {
    if (showAll) {
      const t = setTimeout(() => graphRef.current?.fitTo(), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [showAll]);

  if (connected.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ResponsiveHeader title="Topics" subtitle="Interactive node graph of the MQTT topic namespace" />
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

  const propertiesButton = (
    <button
      type="button"
      onClick={() => selected && setPanelOpen(true)}
      disabled={!selected}
      aria-label="Properties of the selected node"
      title={selected ? 'Show properties of the selected node' : 'Select a node first'}
      className={clsx(
        'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm backdrop-blur transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
        selected
          ? 'border-white/10 bg-surface-900/80 text-slate-300 hover:border-white/20 hover:text-slate-100'
          : 'cursor-not-allowed border-white/5 bg-surface-900/60 text-slate-400/60'
      )}
    >
      <PanelRight size={15} aria-hidden="true" />
      <span className="hidden font-medium sm:inline">Properties</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <ResponsiveHeader
        title="Topics"
        subtitle={broker ? `${topicCount.toLocaleString()} topics · ${graph.nodes.length.toLocaleString()} nodes` : 'Select a broker'}
        actions={
          <>
            <div className="flex overflow-hidden rounded-xl border border-white/10" role="group" aria-label="View">
              <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
              <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <label className="flex items-center">
              <span className="sr-only">Broker</span>
              <select
                value={brokerId || ''}
                onChange={(e) => {
                  setBrokerId(e.target.value);
                  setSelected(null);
                }}
                className="rounded-xl border border-white/10 bg-surface-950/60 px-3 py-2 text-sm text-slate-200 focus:border-accent-500/60 focus:outline-none"
              >
                {connected.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />

      {topicsError && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
          <span>Could not load the topic list: {topicsError}. Showing only topics seen live.</span>
          <button
            onClick={() => {
              setTopicsError(null);
              setTopicsTry((v) => v + 1);
            }}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-rose-400/40 px-2.5 py-1 text-xs hover:bg-rose-500/20"
          >
            <RotateCw size={12} /> Retry
          </button>
        </div>
      )}

      {autoTree && (
        <div role="status" className="border-b border-white/5 bg-surface-900/40 px-4 py-2 text-xs text-slate-300">
          Showing the Tree because this broker has {topicCount.toLocaleString()} topics (more than {TREE_DEFAULT_THRESHOLD}), where the graph gets crowded.
          Pick Graph above to switch; your choice is remembered.
        </div>
      )}

      {spHosts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-surface-900/40 px-4 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <Cpu size={12} className="text-accent-400" aria-hidden="true" /> Host applications
          </span>
          {spHosts.map((h) => (
            <span
              key={h.id}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface-950/60 px-2 py-1 text-xs"
              title={`spBv1.0/STATE/${h.id}`}
            >
              <span className={clsx('h-1.5 w-1.5 rounded-full', h.online ? 'bg-emerald-400' : h.online === false ? 'bg-rose-400' : 'bg-slate-400')} aria-hidden="true" />
              <span className="font-mono text-slate-200">{h.id}</span>
              <Badge status={h.online ? 'connected' : 'offline'}>{h.online ? 'online' : h.online === false ? 'offline' : 'unknown'}</Badge>
              {(h.timestamp || h.lastSeen) && (
                <span className="text-slate-400">{formatDistanceToNow(new Date(h.timestamp || h.lastSeen), { addSuffix: true })}</span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {view === 'tree' ? (
          <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30 max-md:max-w-none">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
              <Search size={14} className="text-slate-400" aria-hidden="true" />
              <input
                aria-label="Filter topics"
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter topics…"
                className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none"
              />
            </div>
            {brokerTopics.length === 0 ? (
              <EmptyState
                icon={ListTree}
                title="No topics yet"
                hint="Topics appear as soon as the broker publishes. If nothing shows up, check the subscribe filter on the MQTT Brokers page."
                action={
                  <Link to="/brokers">
                    <Button size="sm" variant="outline">Open MQTT Brokers</Button>
                  </Link>
                }
              />
            ) : (
              <TopicTree topics={brokerTopics} selectedTopic={selected?.meta?.fullTopic} onSelect={selectTopic} filter={treeFilter} />
            )}
          </div>
        ) : view === '3d' ? (
          <div className="relative flex-1">
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
              />
            </Suspense>
            <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
              {propertiesButton}
              <button
                type="button"
                onClick={() => graph3dRef.current?.resetView()}
                aria-label="Reset the 3D camera"
                title="Reset the camera to the default angle and zoom"
                className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-900/80 px-2.5 py-2 text-sm text-slate-300 backdrop-blur transition hover:border-white/20 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
              >
                <Maximize2 size={15} aria-hidden="true" />
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
            />
            <div className="pointer-events-none absolute bottom-4 left-4 hidden rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-slate-300 backdrop-blur sm:block">
              Drag to rotate. Scroll to zoom. Click a node for details. The style menu restyles this view too.
            </div>
            <GraphLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        ) : (
          <div className="relative flex-1">
            {!showAll && (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
                <GraphToolbar
                  showFlow
                  onFit={() => graphRef.current?.fitTo()}
                  onBeautify={() => setGraphLayout(graphLayout === 'radial' ? DEFAULT_LAYOUT : 'radial')}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `topic-graph-${brokerId}.png`)}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `topic-graph-${brokerId}.json`)}
                  onProperties={() => setPanelOpen(true)}
                  hasSelection={Boolean(selected)}
                />
              </>
            )}
            {showAll ? (
              // GPU renderer for the "show everything" view: one draw call per
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
                nodeValuesRef={showValues ? nodeValuesRef : null}
                labelDensity={labelDensity}
                matchIds={coverage?.brokerId === brokerId ? coverage.matchIds : matchIds}
                minimap={showMinimap}
              />
            )}
            <GraphLegend styleId={graphStyle} groups={groupsPresent} />
            {coverage?.brokerId === brokerId && !showAll && (
              // Coverage paint handed over from the Flows view: the highlighted
              // trail is exactly what the chosen client actually receives.
              <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-xl border border-accent-500/50 bg-accent-500/15 px-3 py-2 text-xs text-accent-200 backdrop-blur">
                <span>{coverage.label}</span>
                <button onClick={() => setCoverage(null)} aria-label="Clear coverage highlight" title="Clear coverage highlight" className="rounded p-0.5 hover:bg-white/10">
                  <X size={12} />
                </button>
              </div>
            )}
            {(graph.capped || showAll) && (
              <div className="absolute left-4 top-16 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  aria-pressed={showAll}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs backdrop-blur transition',
                    showAll
                      ? 'border-accent-500/60 bg-accent-500/15 text-accent-200'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  )}
                >
                  <Boxes size={13} aria-hidden="true" />
                  {showAll ? `Showing all ${graph.nodes.length.toLocaleString()} nodes` : `Show all ${topicCount.toLocaleString()} topics as nodes`}
                </button>

                {/* One unified control cluster for the big-graph view */}
                {showAll && (
                  <div className="flex flex-wrap items-stretch divide-x divide-white/10 overflow-hidden rounded-xl border border-white/10 bg-surface-900/80 text-xs backdrop-blur" role="group" aria-label="Big graph controls">
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
                        <Tag size={11} aria-hidden="true" /> Labels
                      </SegLabel>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={labelDensity}
                        aria-label="Label density"
                        onChange={(e) => setLabelDensity(Number(e.target.value))}
                        className="h-1 w-20 cursor-pointer accent-accent-400"
                        title="Label density"
                      />
                      <span className="w-8 tabular-nums text-slate-300">{labelDensity <= 0.001 ? 'off' : `${Math.round(labelDensity * 100)}%`}</span>
                    </Segment>
                  </div>
                )}
                {showAll && graph.nodes.length > 60000 && (
                  <span className="rounded-lg bg-surface-900/70 px-2 py-1 text-xs text-slate-300 backdrop-blur">heavy: zoom in for detail</span>
                )}
              </div>
            )}
            {topicCount === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-24 mx-auto w-fit max-w-sm rounded-xl border border-white/10 bg-surface-900/90 px-4 py-3 text-center text-sm text-slate-300">
                No topics yet. They appear as soon as the broker publishes. If nothing arrives, check the subscribe filter on the MQTT Brokers page.
              </div>
            )}
            <div className="pointer-events-none absolute bottom-4 left-4 right-4 flex flex-col gap-2 sm:right-auto">
              {!showAll && (
                <div className="pointer-events-auto w-fit max-w-full">
                  <ReplayScrubber getMessages={getReplayMessages} toNodeId={replayNodeId} graphRef={graphRef} />
                </div>
              )}
              <div className="hidden w-fit rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-slate-300 backdrop-blur sm:block">
                Drag · scroll to zoom · click for details · double-click a branch to collapse · zoom in to reveal leaf labels
              </div>
            </div>
          </div>
        )}

        {view === 'tree' && !(selected && panelOpen) && (
          <div className="hidden flex-1 place-items-center p-8 text-center text-sm text-slate-400 md:grid">
            <p className="max-w-xs">Select a topic in the tree to inspect its payload and history, or publish a test message.</p>
          </div>
        )}

        {selected && panelOpen && (
          <TopicPanel
            node={selected}
            brokerId={brokerId}
            graph={graph}
            onJump={(id) => {
              const n = graph.nodes.find((x) => x.id === id);
              if (n) setSelected(n);
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
