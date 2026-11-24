import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Network, Radio, Cpu, Boxes, X, Activity, ListTree, Share2, Search, ShieldCheck, History, Layers, Plug, RotateCw } from 'lucide-react';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import UnsTopology from '@/graph/UnsTopology';
import { DEFAULT_LEVELS, nodeLevel } from '@/graph/unsLevels';
import { UNS_THEMES, loadUnsTheme, saveUnsTheme } from '@/graph/unsTheme';
import { buildUnsTree } from '@/graph/unsTree';
import { buildMountRoots } from '@/graph/unsMounts';
import useIngestRate from '@/graph/useIngestRate';
import { formatRate } from '@/graph/rateWindow';
import ResponsiveHeader from '@/components/ResponsiveHeader';
import GraphTree from '@/components/GraphTree';
import ViewTab from '@/components/ViewTab';
import { Button, EmptyState } from '@/components/ui';
import LevelsEditor from './uns/LevelsEditor';
import MountManager from './uns/MountManager';
import LintPanel from './uns/LintPanel';
import EventsPanel from './uns/EventsPanel';
import UnsHelp from './uns/UnsHelp';
import { Chip, Dot } from './uns/Chips';
import { IconRow, LiveRows, Row } from './uns/DetailRows';

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

/**
 * UNS: the Unified Namespace topology. One live map of the whole namespace,
 * organized by level rather than raw topics, with data sources (MQTT brokers,
 * OPC UA, i3X) as header chips and branches lighting up while data flows.
 */
export default function Uns() {
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const topicVersionMap = useStore((s) => s.topicVersion);
  const setTopics = useStore((s) => s.setTopics);
  const [scope, setScope] = useState('all'); // 'all' | brokerId
  const [view, setView] = useState('topology'); // 'topology' | 'tree'
  const [treeFilter, setTreeFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null); // { brokerId, path } to pan the map onto
  const [pickerOpen, setPickerOpen] = useState(false);
  const [iconTick, setIconTick] = useState(0); // bump after a pick so previews refresh
  const [i3xStatus, setI3xStatus] = useState(null);
  const [themeMode, setThemeMode] = useState(loadUnsTheme);
  const theme = UNS_THEMES[themeMode];
  // Side panel (docked): 'lint' | 'events' | null. Node detail shows when none is open.
  const [panel, setPanel] = useState(null);
  const [levels, setLevels] = useState(loadLevels);
  const [levelsOpen, setLevelsOpen] = useState(false);
  const [mounts, setMounts] = useState([]);
  const [mountRoots, setMountRoots] = useState([]);
  const [mountsOpen, setMountsOpen] = useState(false);
  const [loadError, setLoadError] = useState(null); // topics / mounts failures, with Retry
  const [retryTick, setRetryTick] = useState(0);

  const connected = useMemo(() => brokers.filter((b) => b.status === 'connected'), [brokers]);
  const connectedKey = connected.map((b) => b.id).join('|');

  const toggleTheme = () =>
    setThemeMode((m) => {
      const next = m === 'dark' ? 'light' : 'dark';
      saveUnsTheme(next);
      return next;
    });

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedKey, retryTick]);

  useEffect(() => {
    api.i3xStatus().then(setI3xStatus).catch(() => setI3xStatus(null)); // optional chip
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Jump from a lint finding / event to the node: select it AND pan the canvas
  // onto it. A fresh object each call so clicking the same finding re-focuses.
  const jumpTo = (brokerId, path) => {
    const node = flat.byId.get(`uns:${brokerId}:${path}`);
    if (node) setSelected(node);
    setView('topology');
    setFocusTarget({ brokerId, path });
  };

  const totalTopics = roots.reduce((n, r) => n + r.topicCount, 0);

  if (!connected.length && !mountRoots.length) {
    return (
      <div className="flex h-full flex-col">
        <ResponsiveHeader title="Unified Namespace" subtitle="Live topology of the whole namespace, by level" />
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

  const selLevel = selected ? nodeLevel(selected, levels, 'dark') : null;

  return (
    <div className="flex h-full flex-col">
      <ResponsiveHeader
        title="Unified Namespace"
        subtitle={`${totalTopics.toLocaleString()} topics · live topology`}
        actions={
          <>
            <UnsHelp />
            <div className="flex overflow-hidden rounded-xl border border-white/10" role="group" aria-label="View">
              <ViewTab active={view === 'topology'} onClick={() => setView('topology')} icon={Share2} label="Topology" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <HeaderButton icon={ShieldCheck} label="Lint" active={panel === 'lint'} onClick={() => setPanel((p) => (p === 'lint' ? null : 'lint'))} />
            <HeaderButton icon={History} label="Events" active={panel === 'events'} onClick={() => setPanel((p) => (p === 'events' ? null : 'events'))} />
            <HeaderButton icon={Layers} label="Levels" active={levelsOpen} onClick={() => setLevelsOpen((v) => !v)} />
            <HeaderButton icon={Plug} label="Sources" active={mountsOpen} onClick={() => setMountsOpen((v) => !v)} />
            <label className="flex items-center">
              <span className="sr-only">Namespace scope</span>
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
            </label>
          </>
        }
      />

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
          <span>{loadError}</span>
          <span className="flex shrink-0 gap-2">
            <button
              onClick={() => {
                setLoadError(null);
                setRetryTick((v) => v + 1);
              }}
              className="flex items-center gap-1 rounded-lg border border-rose-400/40 px-2.5 py-1 text-xs hover:bg-rose-500/20"
            >
              <RotateCw size={12} /> Retry
            </button>
            <button aria-label="Dismiss error" onClick={() => setLoadError(null)} className="rounded p-1 hover:bg-rose-500/20">
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {view === 'topology' && (
          <div className="pointer-events-none absolute left-4 right-4 top-4 z-10 flex flex-wrap items-center gap-2">
            <Chip tone="live" theme={theme}>
              <Activity size={12} /> <span data-testid="uns-rate">live · {formatRate(rate)}/s</span>
            </Chip>
            {scoped.map((b) => (
              <Chip key={b.id} theme={theme}>
                <Radio size={12} /> {b.name} <Dot on />
              </Chip>
            ))}
            {opcua.filter((c) => c.status === 'connected').map((c) => (
              <Chip key={c.id} theme={theme}>
                <Cpu size={12} /> OPC-UA <Dot on />
              </Chip>
            ))}
            {i3xStatus?.configured && (
              <Chip theme={theme}>
                <Boxes size={12} /> i3X <Dot on={Boolean(i3xStatus.info)} />
              </Chip>
            )}
          </div>
        )}

        {levelsOpen && <LevelsEditor levels={levels} onSave={saveLevels} onClose={() => setLevelsOpen(false)} />}
        {mountsOpen && (
          <MountManager
            mounts={mounts}
            brokers={connected}
            opcua={opcua}
            i3xStatus={i3xStatus}
            onChanged={() => setMountTick((v) => v + 1)}
            onClose={() => setMountsOpen(false)}
          />
        )}

        <div className="flex h-full w-full flex-col md:flex-row">
          {view === 'tree' ? (
            <div className="flex min-h-0 w-full flex-1 flex-col border-r border-white/5 bg-surface-900/30 md:max-w-md md:flex-none">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                <Search size={14} className="text-slate-400" aria-hidden="true" />
                <input
                  aria-label="Filter namespace"
                  value={treeFilter}
                  onChange={(e) => setTreeFilter(e.target.value)}
                  placeholder="Filter namespace…"
                  className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none"
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
            <div className="relative min-h-0 min-w-0 flex-1">
              {totalTopics === 0 && (
                <div className="pointer-events-none absolute inset-x-0 top-20 z-10 mx-auto w-fit max-w-sm rounded-xl border border-white/10 bg-surface-900/90 px-4 py-3 text-center text-sm text-slate-300">
                  No topics yet. Waiting for traffic on the connected broker. If it stays empty, check the broker&apos;s subscribe filter on the MQTT Brokers page.
                </div>
              )}
              <UnsTopology
                roots={roots}
                levels={levels}
                selectedId={selected?.id || null}
                onSelect={setSelected}
                focusTarget={focusTarget}
                theme={themeMode}
                onToggleTheme={toggleTheme}
              />
            </div>
          )}

          {panel === 'lint' && <LintPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
          {panel === 'events' && <EventsPanel brokers={scoped} onJump={jumpTo} onClose={() => setPanel(null)} />}
          {!panel && selected && (
            <aside aria-label="Node details" className="max-h-[45%] w-full shrink-0 overflow-y-auto border-t border-white/5 bg-surface-900/40 p-3 md:max-h-none md:w-72 md:border-l md:border-t-0">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">{selected.name}</div>
                  <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: selLevel.color }}>
                    {selLevel.name}
                  </div>
                </div>
                <button aria-label="Close details" onClick={() => setSelected(null)} className="rounded p-1 text-slate-400 hover:bg-white/10">
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                {selected.path && (
                  <div className="truncate font-mono text-xs text-slate-300" title={selected.path}>
                    {selected.path}
                  </div>
                )}
                <Row k="Topics in branch" v={selected.topicCount.toLocaleString()} />
                <Row k="Direct children" v={selected.children.size.toLocaleString()} />
                <LiveRows node={selected} />
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

        {view === 'topology' && <Legend theme={theme} levels={levels} />}
      </div>
    </div>
  );
}

function Legend({ theme, levels }) {
  const ring = (path, depth) => nodeLevel({ path, depth }, levels, theme.mode).color;
  return (
    <div
      className={`pointer-events-none absolute bottom-4 left-4 z-10 hidden max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs shadow-sm sm:flex md:max-w-[60%] ${theme.legend}`}
    >
      {levels.slice(0, 4).map((lvl, i) => (
        <span key={lvl} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full border-2 ${theme.legendFill}`} style={{ borderColor: ring('x', i) }} />
          {lvl}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-2.5 w-2.5 rounded-full border-2 ${theme.legendFill}`} style={{ borderColor: ring('spBv1.0', 1) }} />
        Sparkplug
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="26" height="6" aria-hidden="true">
          <line x1="0" y1="3" x2="26" y2="3" stroke={theme.statusLive} strokeWidth="1.6" strokeDasharray="6 4" />
        </svg>
        publishing
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: theme.statusOverdue }} /> overdue
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: theme.statusDead }} /> dead
      </span>
      <span className={theme.legendMuted}>double-click / ± to expand</span>
    </div>
  );
}

function HeaderButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 ${
        active ? 'border-accent-500/40 bg-accent-500/15 text-accent-300' : 'border-white/10 bg-surface-950/60 text-slate-300 hover:bg-white/5'
      }`}
    >
      <Icon size={15} aria-hidden="true" /> {label}
    </button>
  );
}
