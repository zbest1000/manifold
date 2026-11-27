import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Share2, X, ListTree, Boxes, Box, PanelRight, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore, onMessageActivity } from '@/store/store';
import { useGraphPrefs, useCoverage } from '@/store/selectors';
import { api } from '@/lib/api';
import ForceGraph from '@/graph/ForceGraph';
import { buildMqttGraph, collapseGraph, groupColor, GROUP_ORDER } from '@/graph/buildGraph';
import { DEFAULT_LAYOUT, resolveGraphStyle } from '@/graph/graphStyles';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { deriveTopicCount } from '@/graph/topicCount';
import GraphToolbar from '@/components/GraphToolbar';
import { GROUP_LABELS } from '@/components/GraphLegend';
import GraphSearch from '@/components/GraphSearch';
import ReplayScrubber from '@/components/ReplayScrubber';
import TopicTree from '@/components/TopicTree';
import PageHeader from '@/components/PageHeader';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { Banner, Button, ButtonLink, EmptyState, IconButton, Input, SegmentedControl, Select, Spinner, StatusDot, StatusText, Timestamp } from '@/components/ui';
import { BarDivider, CanvasNote, FloatingBar, ToolToggle } from '@/components/CanvasChrome';
import TopicPanel from './topics/TopicPanel';
import Graph3DControls from './topics/Graph3DControls';
import { numericFromPayload, shortText } from './topics/topicUtils';
import { dismissNote, loadSavedView, noteDismissed, saveView, resolveTopicsView } from './topics/viewPref';

// Heavy renderers load on demand: three.js (3D view) and the WebGL big-graph
// renderer aren't part of the initial bundle: most sessions never open them.
const ForceGraph3D = lazy(() => import('@/graph/ForceGraph3D'));
const WebGLGraph = lazy(() => import('@/graph/WebGLGraph'));

function RendererLoading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
      <Spinner size={14} /> Loading renderer…
    </div>
  );
}

const FORCE_MAX = 30000; // force-layout worker node cap
const GRAPH_MAX_NODES = 2500;
const NO_HOSTS = []; // stable empty list

export default function TopicGraph() {
  const brokers = useStore((s) => s.brokers);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const setTopics = useStore((s) => s.setTopics);
  const { graphStyle, graphLayout, setGraphLayout, flowEnabled, activitySize, showValues, showMinimap } = useGraphPrefs();
  const { coverage, setCoverage } = useCoverage();

  // Deep link: /topics?broker=<id>&topic=<a/b/c> selects that topic; selections keep the URL in sync.
  const [searchParams, setSearchParams] = useSearchParams();
  const [pickedBrokerId, setBrokerId] = useState(() => searchParams.get('broker') || null);
  const [pendingTopic, setPendingTopic] = useState(() => searchParams.get('topic') || null);
  const [fitTarget, setFitTarget] = useState(null); // node id to frame once the graph has laid it out
  // Sparkplug host applications (spBv1.0/STATE/*), remembered with the broker they belong to
  const [spState, setSpState] = useState({ brokerId: null, hosts: NO_HOSTS });
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // The selection, mirrored into the URL (replaceState) so it can be shared.
  const syncUrl = useCallback(
    (topic, broker) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (topic) {
            next.set('topic', topic);
            if (broker) next.set('broker', broker);
          } else {
            next.delete('topic');
          }
          return next;
        },
        { replace: true }
      ),
    [setSearchParams]
  );
  // Selecting a node opens its details panel; the Properties button reopens it.
  const selectNode = (n) => {
    setFitTarget(null); // a newer selection wins over a pending deep-link framing
    setSelected(n);
    setPanelOpen(Boolean(n));
    setPendingTopic(null);
    syncUrl(n?.meta?.fullTopic || null, brokerIdRef.current);
  };
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [matchIds, setMatchIds] = useState(null);
  // Explicit view choices made on this page (per broker); a broker without one
  // falls back to its remembered choice (localStorage, per broker) or the size default.
  const [viewChoices, setViewChoices] = useState({});
  const [noteHidden, setNoteHidden] = useState({}); // brokers whose "showing the tree" note was dismissed now
  const [treeFilter, setTreeFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [labelDensity, setLabelDensity] = useState(0.5); // 0 (off) .. 1 (dense)
  const [forceState, setForceState] = useState(null); // { graph, positions }: worker-computed force coords for show-all
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

  // The picked broker while it still exists, otherwise the first connected one.
  const brokerId = pickedBrokerId && brokers.some((b) => b.id === pickedBrokerId) ? pickedBrokerId : connected[0]?.id || null;
  const brokerIdRef = useRef(brokerId);
  useEffect(() => {
    brokerIdRef.current = brokerId;
  }, [brokerId]);
  const spHosts = spState.brokerId === brokerId ? spState.hosts : NO_HOSTS;

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
    if (!brokerId) return undefined;
    let alive = true;
    const load = () =>
      api
        .brokerSparkplug(brokerId)
        .then((res) => alive && setSpState({ brokerId, hosts: res.hosts || NO_HOSTS }))
        .catch(() => alive && setSpState({ brokerId, hosts: NO_HOSTS })); // optional strip: absence is the honest empty state
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topicVersion signals topic-set changes; topics come from the non-reactive index
    [brokerId, topicVersion]
  );
  // Same derivation as Overview: the larger of the client index and the server's exact count.
  const topicCount = deriveTopicCount(brokerTopics.length, broker?.metrics?.topicCount);

  const userView = viewChoices[brokerId] ?? loadSavedView(brokerId);
  const view = resolveTopicsView(userView, topicCount);
  const autoTree = userView == null && view === 'tree';
  const showTreeNote = autoTree && !noteHidden[brokerId] && !noteDismissed(brokerId);
  const setView = (v) => {
    setViewChoices((prev) => ({ ...prev, [brokerId]: v }));
    saveView(v, brokerId);
  };

  const fullGraph = useMemo(() => {
    if (!broker) return { nodes: [], links: [] };
    return buildMqttGraph(broker, brokerTopics, { maxNodes: showAll ? Infinity : GRAPH_MAX_NODES });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on broker id and topic set, not on every broker field
  }, [broker?.id, brokerTopics, showAll]);

  // Apply collapsed subtrees. Keyed on the collapsed set so toggling re-filters.
  const collapseKey = [...collapsed].sort().join('|');
  const graph = useMemo(
    () => collapseGraph(fullGraph, collapsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- collapseKey is the stable string form of `collapsed`
    [fullGraph, collapseKey]
  );
  // Resolve a pending deep link once its topic exists (topics may stream in
  // after the first render). Adjusted during render, not in an effect.
  let deepLinkMiss = null;
  if (pendingTopic && brokerId) {
    const id = `topic:${brokerId}:${pendingTopic}`;
    const node = graph.nodes.find((n) => n.id === id);
    const stat = node ? null : brokerTopics.find((t) => (t.topic || t) === pendingTopic);
    if (node || stat) {
      setPendingTopic(null);
      setSelected(
        node || {
          id,
          label: pendingTopic.split('/').pop(),
          kind: 'topic',
          meta: { fullTopic: pendingTopic, isLeaf: true, messageCount: stat?.messageCount, type: stat?.type, lastActivity: stat?.lastActivity }
        }
      );
      setPanelOpen(true);
      if (node) setFitTarget(id);
    } else if (brokerTopics.length > 0) {
      deepLinkMiss = pendingTopic;
    }
  }
  // Frame a deep-linked node once it can be framed for good: the force layout
  // has settled (positions final) and the canvas size has been stable for a
  // few polls (the details panel opens with the selection and narrows it).
  // Not on a timer: under load the layout can take longer than any fixed delay.
  useEffect(() => {
    if (!fitTarget || view !== 'graph') return undefined;
    let lastSize = '';
    let stable = 0;
    let tries = 0;
    const t = setInterval(() => {
      const g = graphRef.current;
      tries += 1;
      const size = g?.size ? `${g.size().w}x${g.size().h}` : '';
      stable = size && size === lastSize ? stable + 1 : 0;
      lastSize = size;
      if ((g?.isSettled?.() && g.hasNode?.(fitTarget) && stable >= 2) || tries > 200) {
        clearInterval(t);
        if (g?.hasNode?.(fitTarget)) g.fitTo(new Set([fitTarget]));
        setFitTarget(null);
      }
    }, 100);
    return () => clearInterval(t);
  }, [fitTarget, view]);

  // Groups actually present, for the color legend.
  const groupsPresent = useMemo(() => new Set(graph.nodes.map((n) => n.group)), [graph]);

  // "Show coverage on topic map" from the Flows view: jump to the graph so the
  // painted trail is immediately visible (without overwriting the saved preference).
  // Adjusted during render (when coverage or broker changes) rather than in an effect.
  const [coverageSeen, setCoverageSeen] = useState({ coverage, brokerId });
  if (coverageSeen.coverage !== coverage || coverageSeen.brokerId !== brokerId) {
    setCoverageSeen({ coverage, brokerId });
    if (coverage?.brokerId === brokerId) setViewChoices((prev) => ({ ...prev, [brokerId]: 'graph' }));
  }

  // A batch force layout is a snapshot for a specific node set: it only applies
  // to the graph it was computed for, so stale coordinates never reach other nodes.
  const forcePositions = forceState && forceState.graph === graph ? forceState.positions : null;

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
        setForceState({ graph, positions });
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
      setPendingTopic(null);
      syncUrl(c.path, brokerId);
    },
    [brokerId, syncUrl]
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
        <PageHeader title="Topics" />
        <EmptyState
          icon={Share2}
          title="No connected brokers"
          hint="Connect to an MQTT broker to see its live topic tree as a graph."
          action={
            <ButtonLink to="/brokers" variant="primary">
              Connect a broker
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const coverageOn = coverage?.brokerId === brokerId && !showAll && view === 'graph';
  const panelShown = selected && panelOpen;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Topics"
        subtitle={broker ? `${topicCount.toLocaleString()} topics · ${graph.nodes.length.toLocaleString()} nodes${graph.capped && !showAll ? ' shown' : ''}` : 'Select a broker'}
        actions={
          <Select
            aria-label="Broker"
            value={brokerId || ''}
            onChange={(e) => {
              setBrokerId(e.target.value);
              selectNode(null);
            }}
            className="w-auto max-w-[14rem]"
          >
            {connected.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />

      {/* One toolbar row: view switch, then the controls of the current view. Nothing floats over the top of the canvas. */}
      <div role="toolbar" aria-label="Topics view" className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-4 py-1.5 sm:px-6">
        <SegmentedControl
          label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'graph', label: 'Graph', icon: Share2 },
            { value: '3d', label: '3D', icon: Box },
            { value: 'tree', label: 'Tree', icon: ListTree }
          ]}
        />
        {view === 'graph' && (
          <>
            {!showAll && (
              <GraphSearch
                inline
                nodes={graph.nodes}
                onMatches={setMatchIds}
                onFit={(ids) => graphRef.current?.fitTo(ids)}
                onPick={(n) => {
                  selectNode(n);
                  graphRef.current?.fitTo(new Set([n.id]));
                }}
                className="min-w-[10rem] max-w-xs flex-1"
              />
            )}
            {(graph.capped || showAll) && (
              <ToolToggle
                pressed={showAll}
                onClick={() => setShowAll((v) => !v)}
                icon={Boxes}
                label={showAll ? `All ${graph.nodes.length.toLocaleString()} nodes` : `Show all ${topicCount.toLocaleString()}`}
                title={showAll ? 'Back to the interactive graph' : 'Draw every topic with the GPU renderer'}
                showLabel
              />
            )}
            {showAll ? (
              <>
                <BarDivider />
                <SegmentedControl
                  label="Big graph layout"
                  size="sm"
                  value={forcePositions ? 'force' : 'radial'}
                  onChange={(v) => (v === 'radial' ? setForceState(null) : runForceLayout())}
                  options={[
                    { value: 'radial', label: 'Radial' },
                    { value: 'force', label: forceBusy ? 'Force…' : 'Force' }
                  ]}
                />
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
                  Labels
                  <input type="range" min="0" max="1" step="0.05" value={labelDensity} aria-label="Label density" onChange={(e) => setLabelDensity(Number(e.target.value))} className="h-1 w-20 cursor-pointer accent-accent" />
                  <span className="w-8 tabular-nums text-fg">{labelDensity <= 0.001 ? 'Off' : `${Math.round(labelDensity * 100)} %`}</span>
                </label>
              </>
            ) : (
              <div className="ml-auto flex items-center">
                <GraphToolbar
                  inline
                  showFlow
                  onFit={() => graphRef.current?.fitTo()}
                  onBeautify={() => setGraphLayout(graphLayout === 'radial' ? DEFAULT_LAYOUT : 'radial')}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `topic-graph-${brokerId}.png`)}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `topic-graph-${brokerId}.json`)}
                  onProperties={() => setPanelOpen(true)}
                  hasSelection={Boolean(selected)}
                />
              </div>
            )}
          </>
        )}
        {view === '3d' && (
          <>
            <BarDivider />
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
            <div className="ml-auto flex items-center gap-0.5">
              <IconButton icon={RotateCcw} label="Reset the camera" onClick={() => graph3dRef.current?.resetView()} />
              <IconButton icon={PanelRight} label={selected ? 'Properties of the selected node' : 'Properties (select a node first)'} disabled={!selected} onClick={() => selected && setPanelOpen(true)} />
            </div>
          </>
        )}
        {view === 'tree' && <Input type="search" aria-label="Filter topics" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter topics" className="h-8 min-w-[10rem] max-w-xs flex-1" />}
      </div>

      {(topicsError || showTreeNote || spHosts.length > 0 || deepLinkMiss) && (
        <div className="space-y-2 border-b border-line px-4 py-2 sm:px-6">
          {topicsError && (
            <Banner
              variant="error"
              title="Could not load the topic list. Showing only topics seen live."
              onRetry={() => {
                setTopicsError(null);
                setTopicsTry((v) => v + 1);
              }}
            >
              {topicsError}
            </Banner>
          )}
          {showTreeNote && (
            <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted" data-testid="tree-default-note">
              <span className="min-w-0 flex-1 basis-56" title="Above 200 topics the graph is dense, so the tree opens first. Your choice of view is remembered for this broker.">
                Showing the tree because this broker has {topicCount.toLocaleString()} topics.
              </span>
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setView('graph')}>
                Switch to Graph
              </Button>
              <IconButton
                icon={X}
                size={14}
                label="Dismiss this note"
                className="h-7 w-7"
                onClick={() => {
                  dismissNote(brokerId);
                  setNoteHidden((prev) => ({ ...prev, [brokerId]: true }));
                }}
              />
            </div>
          )}
          {deepLinkMiss && (
            <p role="status" className="text-sm text-muted">
              <span className="text-fg">No topic yet at</span> <code className="break-all font-mono text-xs text-fg">{deepLinkMiss}</code>. It is selected as soon as it publishes.
            </p>
          )}
          {spHosts.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-muted">Sparkplug host applications</span>
              {spHosts.map((h) => (
                <span key={h.id} className="inline-flex items-center gap-2" title={`spBv1.0/STATE/${h.id}`}>
                  <StatusText tone={h.online ? 'good' : h.online === false ? 'bad' : 'neutral'}>
                    <span className="font-mono text-xs">{h.id}</span>
                    <span className="sr-only">{h.online ? ' online' : h.online === false ? ' offline' : ' unknown'}</span>
                  </StatusText>
                  {(h.timestamp || h.lastSeen) && <Timestamp value={h.timestamp || h.lastSeen} className="text-xs text-subtle" />}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden max-md:flex-col">
        {view === 'tree' ? (
          <div className="flex min-h-0 w-full flex-col border-line md:max-w-md md:border-r">
            {brokerTopics.length === 0 ? (
              <EmptyState
                icon={ListTree}
                title="No topics yet"
                hint="Topics appear as soon as the broker publishes. If nothing shows up, check the subscribe filter on the MQTT Brokers page."
                action={
                  <ButtonLink to="/brokers" size="sm">
                    Open MQTT Brokers
                  </ButtonLink>
                }
              />
            ) : (
              <TopicTree topics={brokerTopics} selectedTopic={selected?.meta?.fullTopic} onSelect={selectTopic} filter={treeFilter} />
            )}
          </div>
        ) : view === '3d' ? (
          <div className="relative min-h-0 min-w-0 flex-1">
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
                inset={FIT_INSET}
              />
            </Suspense>
            <p className="pointer-events-none absolute bottom-4 left-4 hidden text-xs text-subtle sm:block">Drag to rotate · scroll to zoom · click a node for details</p>
            <TopicsLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        ) : (
          <div className="relative min-h-0 min-w-0 flex-1">
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
                matchIds={coverageOn ? coverage.matchIds : matchIds}
                minimap={showMinimap}
                fitInset={FIT_INSET}
              />
            )}
            <div className="pointer-events-none absolute inset-x-4 top-3 z-10 flex flex-col items-start gap-2">
              {coverageOn && (
                // Coverage paint handed over from the Flows view: the highlighted
                // trail is exactly what the chosen client receives.
                <FloatingBar role="status" className="max-w-full gap-2 py-0.5 pl-2.5 pr-0.5 text-xs text-fg">
                  <StatusDot tone="info" size={6} />
                  <span className="truncate">{coverage.label}</span>
                  <IconButton icon={X} size={12} label="Clear coverage highlight" className="h-7 w-7" onClick={() => setCoverage(null)} />
                </FloatingBar>
              )}
              {showAll && graph.nodes.length > 60000 && <CanvasNote className="mx-0 text-xs">Very large graph: zoom in for labels and detail.</CanvasNote>}
            </div>
            {topicCount === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-20 z-10">
                <CanvasNote>No topics yet. They appear as soon as the broker publishes. If nothing arrives, check the subscribe filter on the MQTT Brokers page.</CanvasNote>
              </div>
            )}
            {!showAll && (
              <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex items-end sm:right-auto">
                <ReplayScrubber getMessages={getReplayMessages} toNodeId={replayNodeId} graphRef={graphRef} />
              </div>
            )}
            <TopicsLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        )}

        {view === 'tree' && !panelShown && (
          <div className="hidden flex-1 place-items-center p-8 text-center text-sm text-muted md:grid">
            <p className="max-w-xs">Select a topic to inspect its payload and history, or publish a test message.</p>
          </div>
        )}

        {panelShown && (
          <TopicPanel
            node={selected}
            brokerId={brokerId}
            graph={graph}
            onJump={(id) => {
              const n = graph.nodes.find((x) => x.id === id);
              if (!n) return;
              selectNode(n);
              // Like search and deep links: also bring the target into view on the 2D graph.
              setFitTarget(id);
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// Fit-to-view keeps the graph clear of the replay control and legend at the bottom.
const FIT_INSET = { top: 40, right: 40, bottom: 88, left: 40 };

/**
 * Quiet inline key for the node colours of the current style (groups present
 * in this graph only), bottom-right of the canvas; folds to a button on phones.
 */
function TopicsLegend({ styleId, groups }) {
  const tokens = useCanvasTokens();
  const [open, setOpen] = useState(false);
  const style = resolveGraphStyle(styleId, tokens);
  const present = GROUP_ORDER.filter((g) => groups.has(g));
  if (present.length === 0) return null;
  const items = present.map((g) => (
    <span key={g} className="inline-flex items-center gap-1.5">
      <svg width="10" height="10" aria-hidden="true">
        {style.node.square ? <rect x="1" y="1" width="8" height="8" fill={groupColor(g, style.palette)} /> : <circle cx="5" cy="5" r="4" fill={groupColor(g, style.palette)} />}
      </svg>
      {GROUP_LABELS[g] || g}
    </span>
  ));
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-col items-end gap-1">
      <div role="group" aria-label="Node colours" className="pointer-events-auto hidden max-w-md flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-muted shadow-overlay md:flex">
        {items}
      </div>
      <div className="pointer-events-auto flex flex-col items-end gap-1 md:hidden">
        {open && (
          <div id="topics-key" role="group" aria-label="Node colours" className="flex max-w-[16rem] flex-wrap gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-muted shadow-overlay">
            {items}
          </div>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="topics-key"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-8 items-center rounded-md border border-line bg-panel px-2.5 text-xs font-medium text-muted shadow-overlay hover:text-fg"
        >
          Key
        </button>
      </div>
    </div>
  );
}
