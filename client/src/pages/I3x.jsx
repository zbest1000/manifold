import { useMemo, useRef, useState } from 'react';
import { Boxes, Plug, LogOut, X, Activity, Layers, ListTree, Search, Box } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildI3xGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphLegend from '@/components/GraphLegend';
import GraphSearch from '@/components/GraphSearch';
import GraphTree from '@/components/GraphTree';
import JsonView from '@/components/JsonView';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { useStore } from '@/store/store';
import { Card, Button, Badge, Input, Field, EmptyState, Banner, LoadingState, Skeleton, PageBody, Table, THead, Th, Tr, Td, useConfirm } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';

const formatValue = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function I3x() {
  const graphStyle = useStore((s) => s.graphStyle);
  const showMinimap = useStore((s) => s.showMinimap);
  // i3X object graphs are hierarchical (parentId) — default to the client
  // `tree` layout, kept per-view so it doesn't override the MQTT graph's pref.
  const [graphLayout, setGraphLayout] = useState('tree');
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph');
  const [treeFilter, setTreeFilter] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const graphRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  const { data: loadedStatus, error: statusError, loading: statusLoading, reload: reloadStatus } = usePolled(() => api.i3xStatus());
  const [localStatus, setStatus] = useState(null); // set by connect/disconnect; otherwise the loaded status applies
  const status = localStatus ?? loadedStatus;
  const [form, setForm] = useState({ baseUrl: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);

  // Selecting a node opens its details; the Properties toolbar button reopens it.
  const selectNode = (n) => {
    setSelected(n);
    setPanelOpen(Boolean(n));
  };

  const connected = Boolean(status?.configured && status?.info);

  // Objects and namespaces load once connected (and again on Retry).
  const lists = usePolled(
    async () => {
      if (!connected) return null;
      const [o, n] = await Promise.all([api.i3xObjects(), api.i3xNamespaces()]);
      return { objects: o.objects, namespaces: n.namespaces };
    },
    { deps: [connected] }
  );
  const objects = useMemo(() => (connected ? lists.data?.objects || [] : []), [connected, lists.data]);
  const namespaces = connected ? lists.data?.namespaces || [] : [];
  const listError = connected ? lists.error : null;
  const loadObjects = lists.reload;

  const server = useMemo(() => ({ baseUrl: status?.baseUrl, info: status?.info }), [status]);
  const graph = useMemo(() => {
    if (!connected) return { nodes: [], links: [] };
    return buildI3xGraph(server, objects);
  }, [connected, server, objects]);
  const groupsPresent = useMemo(() => new Set(graph.nodes.map((n) => n.group)), [graph]);

  const connect = async () => {
    setBusy(true);
    try {
      const s = await api.i3xConnect({ baseUrl: form.baseUrl, token: form.token || undefined });
      setStatus(s);
      toast.success(`Connected to i3X (${s.info?.serverName || s.baseUrl})`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect from this i3X server?',
      message: 'The server configuration (and bearer token, if any) held by Manifold is discarded.',
      confirmLabel: 'Disconnect',
      danger: true
    });
    if (!ok) return;
    try {
      setStatus(await api.i3xReset());
      setSelected(null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!connected) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="i3X" subtitle="Discover and visualize a Common Contextual Manufacturing Information (i3X) server" actions={<Badge>not connected</Badge>} />
        <PageBody>
          {statusError && !status && (
            <Banner variant="error" title="Could not read the i3X connection status" onRetry={reloadStatus}>
              {statusError.message}
            </Banner>
          )}
          {statusLoading && !status && !statusError && <LoadingState label="connection status" rows={2} />}
          {(status || statusError) && (
            <div className="mx-auto max-w-2xl">
              <Card className="p-4 sm:p-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-teal-400 to-cyan-600 shadow-lg">
                    <Boxes size={20} className="text-white" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">Connect an i3X server</h2>
                    <p className="helper">
                      The server is verified via its <span className="mono">/info</span> endpoint before objects are loaded.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <Field label="Base URL">
                    <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.i3x.dev/v1" />
                  </Field>
                  <Field label="Bearer token (optional)">
                    <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="new-password" />
                  </Field>
                </div>
                <div className="mt-5 flex justify-end">
                  <Button onClick={connect} disabled={busy || !form.baseUrl}>
                    <Plug size={15} aria-hidden="true" /> {busy ? 'Verifying…' : 'Connect to i3X'}
                  </Button>
                </div>
                <p className="helper mt-4">Tip: run a network scan on the Discovery page to auto-detect i3X servers on your network.</p>
              </Card>
            </div>
          )}
        </PageBody>
        {confirmDialog}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="i3X"
        subtitle={`${server.info?.serverName || server.baseUrl} · ${objects.length} objects · ${namespaces.length} namespaces`}
        actions={
          <>
            <div role="group" aria-label="Explorer view" className="flex overflow-hidden rounded-xl border border-white/10">
              <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Boxes} label="Graph" />
              <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
              <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
            </div>
            <Badge status="connected">i3X {server.info?.specVersion || ''}</Badge>
            <Button variant="outline" onClick={disconnect}>
              <LogOut size={15} aria-hidden="true" /> Disconnect
            </Button>
          </>
        }
      />

      {listError && (
        <div className="px-4 pt-4 sm:px-6">
          <Banner variant="error" title="Could not load objects and namespaces" onRetry={loadObjects}>
            {listError.message}
          </Banner>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {view === 'tree' ? (
          <div className="flex w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
              <Search size={14} className="text-subtle" aria-hidden="true" />
              <input
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                aria-label="Filter objects"
                placeholder="Filter objects…"
                className="w-full bg-transparent text-sm text-slate-200 placeholder:text-faint focus:outline-none"
              />
            </div>
            <GraphTree nodes={graph.nodes} links={graph.links} selectedId={selected?.id || null} onSelect={selectNode} filter={treeFilter} />
          </div>
        ) : view === '3d' ? (
          <div className="relative flex-1">
            <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={selectNode} />
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-muted backdrop-blur">
              Drag to rotate · scroll to zoom · click a node for details
            </div>
            <GraphLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        ) : (
          <div className="relative flex-1">
            {objects.length === 0 ? (
              <EmptyState icon={Layers} title="No objects returned" hint={listError ? 'The object list could not be loaded — retry above.' : 'This i3X server exposed no objects.'} />
            ) : (
              <>
                <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
                <GraphToolbar
                  onFit={() => graphRef.current?.fitTo()}
                  onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), 'i3x-graph.png')}
                  onExportJson={() => downloadJson(graphRef.current?.exportGraph(), 'i3x-graph.json')}
                  layoutValue={graphLayout}
                  onLayoutChange={setGraphLayout}
                  onProperties={() => setPanelOpen(true)}
                  hasSelection={selected?.kind === 'i3x-object'}
                />
                <ForceGraph
                  ref={graphRef}
                  data={graph}
                  styleId={graphStyle}
                  layoutId={graphLayout}
                  selectedId={selected?.id || null}
                  onSelect={selectNode}
                  matchIds={matchIds}
                  minimap={showMinimap}
                />
                <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-muted backdrop-blur">
                  Object graph · click a node to read its value and history
                </div>
                <GraphLegend styleId={graphStyle} groups={groupsPresent} />
              </>
            )}
          </div>
        )}

        {selected && selected.kind === 'i3x-object' && panelOpen && <ObjectPanel key={selected.meta?.elementId || selected.id} node={selected} onClose={() => setPanelOpen(false)} />}
      </div>
      {confirmDialog}
    </div>
  );
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ObjectPanel({ node, onClose }) {
  const elementId = node.meta?.elementId;
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // The panel is remounted per object (see key at the call site), so a fresh
  // value is fetched and the history state starts empty for each selection.
  const valueQ = usePolled(async () => {
    if (!elementId) return null;
    const r = await api.i3xValue([elementId]);
    return r.results?.[0] ?? null;
  });
  const value = valueQ.data;
  const valueError = valueQ.error;
  const loadValue = valueQ.reload;

  const loadHistory = async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const r = await api.i3xHistory({ elementIds: [elementId], startTime: isoDaysAgo(7), endTime: isoDaysAgo(0) });
      setHistory(r.results?.[0]?.values || []);
    } catch (e) {
      setHistoryError(e);
    } finally {
      setLoadingHistory(false);
    }
  };

  return (
    <aside aria-label="Object details" className="absolute inset-y-0 right-0 z-10 flex w-full shrink-0 flex-col border-l border-white/5 bg-surface-900 sm:static sm:w-96 sm:bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="label-xs">{node.meta?.isComposition ? 'Composition object' : 'Object'}</p>
          <h2 className="mt-0.5 break-all text-sm font-medium text-slate-100">{node.label}</h2>
          <p className="mono helper mt-0.5 break-all">{elementId}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close object details" className="rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {valueError && (
          <Banner variant="error" title="Could not read the current value" onRetry={loadValue}>
            {valueError.message}
          </Banner>
        )}
        {value && (
          <Card className="border-accent-500/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-400">
              <Activity size={12} aria-hidden="true" /> Current value
            </p>
            <p className="mono break-all text-lg font-semibold text-slate-100">{formatValue(value.value)}</p>
            {value.timestamp && <p className="helper mt-1">{new Date(value.timestamp).toLocaleString()}</p>}
            {value.quality != null && <p className="helper">quality: {String(value.quality)}</p>}
          </Card>
        )}

        <Button variant="subtle" className="w-full" onClick={loadHistory} disabled={loadingHistory}>
          {loadingHistory ? 'Loading history…' : 'Load 7-day history'}
        </Button>

        {loadingHistory && (
          <div role="status" aria-busy="true" className="space-y-2">
            <span className="sr-only">Loading history…</span>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {historyError && (
          <Banner variant="error" title="Could not load history" onRetry={loadHistory}>
            {historyError.message}
          </Banner>
        )}
        {history && (
          <Card className="p-3">
            <p className="label-xs mb-2">History ({history.length})</p>
            {history.length === 0 ? (
              <p className="helper">No samples in range.</p>
            ) : (
              <Table caption="Most recent history samples" wrapperClassName="max-h-56 overflow-y-auto rounded-xl" className="min-w-0">
                <THead>
                  <Th>Time</Th>
                  <Th align="right">Value</Th>
                </THead>
                <tbody>
                  {history
                    .slice(-50)
                    .reverse()
                    .map((v, i) => (
                      <Tr key={i}>
                        <Td className="py-1.5 text-xs text-muted">{v.timestamp ? new Date(v.timestamp).toLocaleString() : '—'}</Td>
                        <Td align="right" className="mono py-1.5 text-xs text-slate-200">
                          {formatValue(v.value)}
                        </Td>
                      </Tr>
                    ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}

        {node.meta && (
          <Card className="p-3">
            <p className="label-xs mb-2">Metadata</p>
            <JsonView data={node.meta} />
          </Card>
        )}
      </div>
    </aside>
  );
}
