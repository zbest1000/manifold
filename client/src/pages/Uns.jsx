import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Network, ListTree, Share2, ShieldCheck, History, Layers, Plug, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import UnsTopology from '@/graph/UnsTopology';
import { DEFAULT_LEVELS, nodeLevel } from '@/graph/unsLevels';
import { buildUnsTheme } from '@/graph/unsTheme';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { buildUnsTree } from '@/graph/unsTree';
import { buildMountRoots } from '@/graph/unsMounts';
import { compareNames, loadPaging, pagingForPath, savePaging } from '@/graph/unsPaging';
import useIngestRate from '@/graph/useIngestRate';
import { formatRate } from '@/graph/rateWindow';
import PageHeader from '@/components/PageHeader';
import GraphTree from '@/components/GraphTree';
import SearchPick from '@/components/SearchPick';
import { Banner, ButtonLink, EmptyState, IconButton, Input, SegmentedControl, Select, StatusDot } from '@/components/ui';
import { BarDivider, CanvasNote, FloatingBar, SidePanel, ToolToggle } from '@/components/CanvasChrome';
import LevelsEditor from './uns/LevelsEditor';
import MountManager from './uns/MountManager';
import LintPanel from './uns/LintPanel';
import EventsPanel from './uns/EventsPanel';
import UnsHelp from './uns/UnsHelp';
import NodeDetails from './uns/NodeDetails';

// Icon picker pulls the full Lucide set: its own chunk, loaded on demand.
const UnsIconPicker = lazy(() => import('@/components/UnsIconPicker'));

const LEVELS_KEY = 'tc.unsLevels';
function loadLevels() {
  try {
    const raw = localStorage.getItem(LEVELS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length >= 2 ? arr.map(String) : [...DEFAULT_LEVELS];
  } catch {
    return [...DEFAULT_LEVELS];
  }
}

/** Normalise a deep-link path: slash separated, no empty segments. */
const cleanPath = (p) => String(p || '').split('/').filter(Boolean).join('/');
const nodeIdOf = (brokerId, path) => (path ? `uns:${brokerId}:${path}` : `uns:${brokerId}`);

const PANELS = [
  { id: 'lint', label: 'Lint', icon: ShieldCheck },
  { id: 'events', label: 'Events', icon: History },
  { id: 'levels', label: 'Levels', icon: Layers },
  { id: 'sources', label: 'Sources', icon: Plug }
];

/**
 * UNS: the Unified Namespace topology. One live map of the whole namespace,
 * organized by level rather than raw topics, with branches lighting up while
 * data flows. The canvas follows the app theme (no separate canvas theme).
 *
 * Deep link: /uns?broker=<brokerId>&path=<a/b/c> (broker optional) expands to,
 * selects and centres that node; selecting another node keeps the URL in sync
 * (replaceState), so a selection is shareable.
 */
export default function Uns() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const setTopics = useStore((s) => s.setTopics);
  const [searchParams, setSearchParams] = useSearchParams();
  // 'all' | brokerId. A link that names only a broker (/uns?broker=ID, no path) opens that namespace;
  // with a path the forest stays whole and the node is selected and centred.
  const [scope, setScope] = useState(() => (searchParams.get('broker') && !cleanPath(searchParams.get('path')) ? searchParams.get('broker') : 'all'));
  const [view, setView] = useState('topology'); // 'topology' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null); // { brokerId, path } to pan the map onto
  const [pickerOpen, setPickerOpen] = useState(false);
  const [iconTick, setIconTick] = useState(0); // bump after a pick so previews refresh
  const [i3xStatus, setI3xStatus] = useState(null);
  // Docked side panel: one of PANELS, or null (then the selected node's details show).
  const [panel, setPanel] = useState(null);
  // Phones: the search box opens on its own row from a Find button, so the toolbar keeps one row and the map its height.
  const [findOpen, setFindOpen] = useState(false);
  const [levels, setLevels] = useState(loadLevels);
  const [mounts, setMounts] = useState([]);
  const [mountRoots, setMountRoots] = useState([]);
  const [loadError, setLoadError] = useState(null); // topics / mounts failures, with Retry
  // Paging of long branches ({ page, filter } per branch node id), shared by the
  // map and the Tree view, kept for the browser session (see graph/unsPaging.js).
  const [paging, setPaging] = useState(loadPaging);
  useEffect(() => savePaging(paging), [paging]);
  const setPage = useCallback((id, state) => {
    setPaging((prev) => {
      const cur = prev.get(id);
      if (cur && cur.page === state.page && (cur.filter || '') === (state.filter || '')) return prev;
      const next = new Map(prev);
      next.set(id, { page: state.page, filter: state.filter || '' });
      return next;
    });
  }, []);
  const [retryTick, setRetryTick] = useState(0);
  // A deep link still waiting for its node: { broker, path } (null once resolved).
  const [pendingLink, setPendingLink] = useState(() => {
    const path = cleanPath(searchParams.get('path'));
    return path ? { broker: searchParams.get('broker') || null, path } : null;
  });

  const connected = useMemo(() => brokers.filter((b) => b.status === 'connected'), [brokers]);
  const connectedKey = connected.map((b) => b.id).join('|');

  // Seed the topic index from the authoritative REST list: the live socket
  // stream only carries topics that publish while the page is open.
  useEffect(() => {
    let alive = true;
    for (const b of connected) {
      api
        .brokerTopics(b.id)
        .then((res) => alive && setTopics(b.id, res.topics))
        .catch((e) => alive && setLoadError(`Could not load topics for ${b.name || b.id}: ${e?.message || 'request failed'}`));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectedKey is the stable string form of the connected broker set
  }, [connectedKey, retryTick]);

  useEffect(() => {
    api.i3xStatus().then(setI3xStatus).catch(() => setI3xStatus(null)); // optional source
  }, []);

  // Mounts: load config, then resolve each into a namespace root.
  const [mountTick, setMountTick] = useState(0);
  const opcuaKey = opcua.map((c) => c.id).join('|');
  useEffect(() => {
    let alive = true;
    api
      .listMounts()
      .then(async ({ mounts: list }) => {
        if (!alive) return;
        setMounts(list);
        const roots = await buildMountRoots(list, { opcuaConnections: opcua });
        if (alive) setMountRoots(roots);
      })
      .catch((e) => alive && setLoadError(`Could not load mounted sources: ${e?.message || 'request failed'}`));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mountTick/opcuaKey/retryTick are the intended triggers
  }, [mountTick, opcuaKey, retryTick]);

  // Mounted structure is a snapshot: refresh it while mounts exist and the tab is visible.
  useEffect(() => {
    if (!mounts.length) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setMountTick((v) => v + 1);
    }, 60_000);
    return () => clearInterval(t);
  }, [mounts.length]);

  const scoped = useMemo(() => (scope === 'all' ? connected : connected.filter((b) => b.id === scope)), [connected, scope]);
  const rate = useIngestRate(scope === 'all' ? null : [scope]);

  // Rebuild namespace trees only when the topic SET changes on a scoped broker.
  const versionKey = scoped.map((b) => `${b.id}:${topicVersionMap[b.id] || 0}`).join('|');
  const brokerRoots = useMemo(
    () => scoped.map((b) => buildUnsTree(b, useStore.getState().getTopics(b.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- versionKey changes exactly when a broker's topic set changes; topics come from the non-reactive index
    [versionKey]
  );
  const roots = useMemo(() => (scope === 'all' ? [...brokerRoots, ...mountRoots] : brokerRoots), [brokerRoots, mountRoots, scope]);

  // Flat {nodes, links} projection of the same forest for the Tree view, plus an
  // id -> UNS-node index so tree selection drives the same detail panel.
  const flat = useMemo(() => {
    const nodes = [];
    const links = [];
    const byId = new Map();
    const walk = (n, parentId) => {
      nodes.push({ id: n.id, label: n.name, group: 'topic', kind: 'uns', meta: { level: nodeLevel(n, levels).name } });
      byId.set(n.id, n);
      if (parentId) links.push({ source: parentId, target: n.id });
      for (const c of n.children.values()) walk(c, n.id);
    };
    for (const r of roots) walk(r, null);
    return { nodes, links, byId };
  }, [roots, levels]);

  const saveLevels = (next) => {
    setLevels(next);
    try {
      localStorage.setItem(LEVELS_KEY, JSON.stringify(next));
    } catch {
      // persistence is best-effort
    }
  };

  // Keep the URL in sync with the selection (replaceState: no history spam), so
  // the address bar always holds a shareable link to what is selected.
  const syncUrl = useCallback(
    (node) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (node) {
            next.set('broker', node.brokerId);
            if (node.path) next.set('path', node.path);
            else next.delete('path');
          } else {
            next.delete('broker');
            next.delete('path');
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const select = useCallback(
    (node) => {
      setSelected(node);
      setPendingLink(null);
      syncUrl(node);
    },
    [syncUrl]
  );

  // Open the page of every long branch on the way to a node, so a deep link,
  // a lint finding or an event lands on the page that holds it.
  const showPageOf = (brokerId, path) => {
    const root = roots.find((r) => r.brokerId === brokerId);
    if (root) setPaging((prev) => pagingForPath(root, path, prev));
  };

  // Jump from a lint finding / event / deep link to the node: select it AND pan
  // the canvas onto it. A fresh object each call so the same target re-focuses.
  const jumpTo = (brokerId, path) => {
    const node = flat.byId.get(nodeIdOf(brokerId, path));
    if (node) select(node);
    showPageOf(brokerId, path);
    setView('topology');
    setFocusTarget({ brokerId, path });
  };

  // Search-and-pick over every node of the shown namespaces: picking one selects it, opens its ancestors
  // and the page of any long branch on the way, and centres it on the map.
  const searchItems = useMemo(() => {
    const multi = roots.length > 1;
    const out = [];
    const rootName = new Map(roots.map((r) => [r.brokerId, r.name]));
    for (const n of flat.byId.values()) {
      out.push({ id: n.id, label: n.name, path: n.path || n.name, hint: multi && n.path ? rootName.get(n.brokerId) : undefined });
    }
    return out;
  }, [flat, roots]);
  const pickSearch = (item) => {
    const node = flat.byId.get(item.id);
    if (!node) return;
    select(node);
    showPageOf(node.brokerId, node.path);
    setView('topology');
    setFocusTarget({ brokerId: node.brokerId, path: node.path });
  };

  // Resolve a pending deep link as soon as its node exists (topics may stream
  // in after the first render). Adjusted during render, not in an effect.
  if (pendingLink) {
    const candidates = pendingLink.broker ? [pendingLink.broker] : roots.map((r) => r.brokerId);
    for (const b of candidates) {
      const node = flat.byId.get(nodeIdOf(b, pendingLink.path));
      if (node) {
        setPendingLink(null);
        setSelected(node);
        showPageOf(b, pendingLink.path);
        setView('topology');
        setFocusTarget({ brokerId: b, path: pendingLink.path });
        break;
      }
    }
  }

  const totalTopics = roots.reduce((n, r) => n + r.topicCount, 0);

  if (!connected.length && !mountRoots.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Unified Namespace" />
        <EmptyState
          icon={Network}
          title="No connected brokers"
          hint="The namespace map shows every connected data source as one live tree. Connect an MQTT broker to begin."
          action={
            <ButtonLink to="/brokers" variant="primary">
              Connect a broker
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const togglePanel = (id) => setPanel((p) => (p === id ? null : id));
  const liveSources = scoped.length + opcua.filter((c) => c.status === 'connected').length + (i3xStatus?.configured && i3xStatus.info ? 1 : 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Unified Namespace"
        subtitle={`${totalTopics.toLocaleString()} topics · ${liveSources} ${liveSources === 1 ? 'source' : 'sources'} live`}
        actions={
          <>
            <UnsHelp />
            <Select aria-label="Namespace" value={scope} onChange={(e) => setScope(e.target.value)} className="w-auto max-w-[14rem]">
              <option value="all">All namespaces</option>
              {connected.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </>
        }
      />

      {/* View switch + panels: one quiet toolbar row under the header, so nothing floats over the map's top edge. */}
      <div role="toolbar" aria-label="Namespace view" className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-4 py-1.5 sm:px-6">
        <SegmentedControl
          label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'topology', label: 'Topology', icon: Share2 },
            { value: 'tree', label: 'Tree', icon: ListTree }
          ]}
        />
        <BarDivider />
        <SearchPick items={searchItems} onPick={pickSearch} label="Find a node in the namespace" placeholder="Find a node or topic/#" className="hidden w-64 sm:block" testId="uns-search" />
        <span className="hidden sm:contents">
          <BarDivider />
        </span>
        {PANELS.map((p) => (
          <ToolToggle key={p.id} pressed={panel === p.id} onClick={() => togglePanel(p.id)} icon={p.icon} label={p.label} showLabel="sm" />
        ))}

      </div>

      {findOpen && (
        <div className="border-b border-line px-4 py-1.5 sm:hidden">
          <SearchPick items={searchItems} onPick={pickSearch} label="Find a node in the namespace" placeholder="Find a node or topic/#" className="w-full" inputClassName="w-full" />
        </div>
      )}

      {loadError && (
        <div className="border-b border-line px-4 py-2 sm:px-6">
          <Banner
            variant="error"
            title={loadError}
            onRetry={() => {
              setLoadError(null);
              setRetryTick((v) => v + 1);
            }}
            onDismiss={() => setLoadError(null)}
          />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        {view === 'tree' ? (
          <div className="flex min-h-0 w-full flex-1 flex-col border-line md:max-w-md md:border-r">
            <div className="border-b border-line p-2">
              <Input type="search" aria-label="Filter namespace" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter namespace" />
            </div>
            <GraphTree
              nodes={flat.nodes}
              links={flat.links}
              selectedId={selected?.id || null}
              onSelect={(n) => {
                const node = flat.byId.get(n.id) || null;
                select(node);
                // Back on the map, the node is opened up to and centred.
                if (node) setFocusTarget({ brokerId: node.brokerId, path: node.path });
              }}
              filter={treeFilter}
              paging={paging}
              onPage={setPage}
              compare={compareNames}
            />
          </div>
        ) : (
          <div className="relative min-h-0 min-w-0 flex-1">
            <UnsTopology
              roots={roots}
              levels={levels}
              selectedId={selected?.id || null}
              onSelect={select}
              focusTarget={focusTarget}
              paging={paging}
              onPage={setPage}
              extraControls={<IconButton icon={Search} label="Find a node" side="left" aria-pressed={findOpen} className="sm:hidden" onClick={() => setFindOpen((v) => !v)} />}
            />
            <SourceStatus rate={rate} brokers={scoped} opcua={opcua} i3xStatus={i3xStatus} />
            <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex flex-col gap-2 px-4">
              {totalTopics === 0 && <CanvasNote>No topics yet. Waiting for traffic on the connected broker. If it stays empty, check the broker&apos;s subscribe filter on the MQTT Brokers page.</CanvasNote>}
              {pendingLink && (
                <CanvasNote>
                  <span className="text-fg">Not in the namespace yet:</span> <code className="break-all font-mono text-xs text-fg">{pendingLink.path}</code>
                  {pendingLink.broker ? <span> on {brokers.find((b) => b.id === pendingLink.broker)?.name || pendingLink.broker}</span> : null}. It is selected as soon as it
                  publishes.
                </CanvasNote>
              )}
            </div>
            <Legend levels={levels} />
          </div>
        )}

        {view === 'tree' && !panel && !selected && (
          <div className="hidden flex-1 place-items-center p-8 text-center text-sm text-muted md:grid">
            <p className="max-w-xs">Select a node in the tree to see its level, activity and latest value.</p>
          </div>
        )}

        {panel === 'lint' && <LintPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
        {panel === 'events' && <EventsPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
        {panel === 'levels' && <LevelsEditor levels={levels} onSave={saveLevels} onClose={() => setPanel(null)} />}
        {panel === 'sources' && (
          <MountManager mounts={mounts} brokers={connected} opcua={opcua} i3xStatus={i3xStatus} onChanged={() => setMountTick((v) => v + 1)} onClose={() => setPanel(null)} />
        )}
        {!panel && selected && <NodeDetails key={selected.id} node={selected} levels={levels} iconTick={iconTick} onChangeIcon={() => setPickerOpen(true)} onClose={() => select(null)} />}
      </div>

      {pickerOpen && selected && (
        <Suspense fallback={null}>
          <UnsIconPicker node={selected} onClose={() => setPickerOpen(false)} onPicked={() => setIconTick((v) => v + 1)} />
        </Suspense>
      )}
    </div>
  );
}

/** Live sources as one quiet status line over the top-left of the map. */
function SourceStatus({ rate, brokers, opcua, i3xStatus }) {
  const items = [
    ...brokers.map((b) => ({ key: b.id, label: b.name, on: true })),
    ...opcua.filter((c) => c.status === 'connected').map((c) => ({ key: c.id, label: c.name || 'OPC UA', on: true })),
    ...(i3xStatus?.configured ? [{ key: 'i3x', label: 'i3X', on: Boolean(i3xStatus.info) }] : [])
  ];
  return (
    <div className="pointer-events-none absolute left-4 right-16 top-3 z-10 flex">
      <FloatingBar data-canvas-overlay role="group" label="Live sources" className="min-w-0 gap-3 px-2.5 py-1 text-xs text-muted">
        <span className="shrink-0 tabular-nums text-fg" data-testid="uns-rate">
          {formatRate(rate)} msg/s
        </span>
        {items.map((s) => (
          <span key={s.key} className="inline-flex min-w-0 items-center gap-1.5">
            <StatusDot tone={s.on ? 'good' : 'neutral'} size={6} />
            <span className="truncate">{s.label}</span>
            <span className="sr-only">{s.on ? 'connected' : 'not connected'}</span>
          </span>
        ))}
      </FloatingBar>
    </div>
  );
}

/**
 * Inline key for the map: level rings, namespaces and leaf states, drawn with
 * the same theme object as the canvas so the swatches are the exact colours.
 * On phones it folds into a "Key" button so it never sits on the map.
 */
function Legend({ levels }) {
  const tokens = useCanvasTokens();
  const theme = buildUnsTheme(tokens);
  const [open, setOpen] = useState(false);
  const ring = (path, depth) => nodeLevel({ path, depth }, levels, tokens).color;
  const items = (
    <>
      {levels.slice(1, 5).map((lvl, i) => (
        <span key={lvl} className="inline-flex items-center gap-1.5">
          <Ring color={ring('x', i + 1)} bg={theme.badgeFill} />
          {lvl}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <Ring color={ring('spBv1.0', 1)} bg={theme.badgeFill} />
        Sparkplug
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-line" />
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="22" y2="4" stroke={theme.statusLive} strokeWidth="1.5" strokeDasharray="5 4" />
        </svg>
        Publishing
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden="true">
          <path d="M5 0.8 L9.4 8.8 L0.6 8.8 Z" fill={theme.statusOverdue} />
        </svg>
        Overdue
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" fill={theme.statusDead} />
        </svg>
        Silent
      </span>
    </>
  );
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 right-20 z-10 flex">
      <div className="pointer-events-auto hidden max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-muted shadow-overlay md:flex" role="group" aria-label="Map key" data-canvas-overlay>
        {items}
      </div>
      <div className="pointer-events-auto flex max-w-full flex-col items-start gap-1 md:hidden">
        {open && (
          <div id="uns-key" data-canvas-overlay className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-muted shadow-overlay" role="group" aria-label="Map key">
            {items}
          </div>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="uns-key"
          data-canvas-overlay
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-panel px-2.5 text-xs font-medium text-muted shadow-overlay hover:text-fg"
        >
          Key {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function Ring({ color, bg }) {
  return (
    <svg width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill={bg} stroke={color} strokeWidth="1.75" />
    </svg>
  );
}

