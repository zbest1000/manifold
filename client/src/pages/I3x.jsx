import { useMemo, useRef, useState } from 'react';
import { Boxes, LogOut, ListTree, Search, Box, Share2, X } from 'lucide-react';
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
import { Button, Input, Field, EmptyState, Banner, IconButton, LoadingState, Skeleton, PageBody, Panel, SegmentedControl, StatusText, Table, THead, Th, Tr, Td, Timestamp, useConfirm } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';

const formatValue = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v));

const VIEWS = [
  { value: 'graph', label: 'Graph', icon: Share2 },
  { value: '3d', label: '3D', icon: Box },
  { value: 'tree', label: 'Tree', icon: ListTree }
];

/** A floating hint over a canvas: solid panel, hairline, overlay shadow. */
const Hint = ({ children }) => <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted shadow-overlay">{children}</div>;

export default function I3x() {
  const graphStyle = useStore((s) => s.graphStyle);
  const showMinimap = useStore((s) => s.showMinimap);
  // i3X object graphs are hierarchical (parentId): default to the client
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
  const [attempted, setAttempted] = useState(false);
  const [connectError, setConnectError] = useState(null);
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

  const readOnly = useReadOnly();
  const urlProblem = !form.baseUrl.trim() ? 'Enter the server base URL.' : !/^https?:\/\/[^/\s]+/i.test(form.baseUrl.trim()) ? 'The base URL must start with http:// or https://' : '';
  const connect = async (e) => {
    e?.preventDefault();
    if (busy || readOnly) return;
    setAttempted(true);
    if (urlProblem) return;
    setBusy(true);
    setConnectError(null);
    try {
      const s = await api.i3xConnect({ baseUrl: form.baseUrl.trim(), token: form.token || undefined });
      setStatus(s);
      toast.success(`Connected to i3X (${s.info?.serverName || s.baseUrl})`);
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect from this i3X server?',
      message: 'The server address and the bearer token (if any) held by Manifold are discarded.',
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
        <PageHeader title="i3X" subtitle="Not connected" />
        <PageBody>
          <ReadOnlyNote className="" />
          {statusError && !status && (
            <Banner variant="error" title="Could not read the i3X connection status" onRetry={reloadStatus}>
              {statusError.message}
            </Banner>
          )}
          {statusLoading && !status && !statusError && <LoadingState label="connection status" rows={2} />}
          {(status || statusError) && (
            <div className="max-w-2xl">
              <Panel title="Connect to an i3X server" description="Browse the object graph of a Common Contextual Manufacturing Information server and read its values and history.">
                <form onSubmit={connect} noValidate className="space-y-4">
                  {connectError && (
                    <Banner variant="error" title="Could not connect">
                      {connectError}
                    </Banner>
                  )}
                  <Field label="Base URL" error={attempted ? urlProblem || undefined : undefined} help={<>Checked against the server&apos;s <span className="mono">/info</span> endpoint before any objects are loaded.</>}>
                    <Input className="mono" aria-invalid={attempted && urlProblem ? 'true' : undefined} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.i3x.dev/v1" />
                  </Field>
                  <Field label="Bearer token (optional)" help="Kept on the server and never shown again.">
                    <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="new-password" />
                  </Field>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-subtle">Run a network scan on the Discovery page to find i3X servers on your network.</p>
                    <Button type="submit" loading={busy} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
                      Connect to i3X
                    </Button>
                  </div>
                </form>
              </Panel>
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
        subtitle={`${server.info?.serverName || server.baseUrl} · ${objects.length.toLocaleString()} object${objects.length === 1 ? '' : 's'} · ${namespaces.length.toLocaleString()} namespace${namespaces.length === 1 ? '' : 's'}`}
        actions={
          <>
            <SegmentedControl label="Explorer view" options={VIEWS} value={view} onChange={setView} />
            <StatusText tone="good" className="px-1">
              Connected{server.info?.specVersion ? `, spec ${server.info.specVersion}` : ''}
            </StatusText>
            <Button variant="secondary" onClick={disconnect} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
              <LogOut size={14} aria-hidden="true" /> Disconnect
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
          <div className="flex w-full max-w-md flex-col border-r border-line bg-panel">
            <div className="relative shrink-0 border-b border-line p-2">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
              <Input aria-label="Filter objects" className="pl-8" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter objects…" />
            </div>
            <GraphTree nodes={graph.nodes} links={graph.links} selectedId={selected?.id || null} onSelect={selectNode} filter={treeFilter} />
          </div>
        ) : view === '3d' ? (
          <div className="relative flex-1">
            <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={selectNode} />
            <Hint>Drag to rotate · scroll to zoom · click a node for details</Hint>
            <GraphLegend styleId={graphStyle} groups={groupsPresent} />
          </div>
        ) : (
          <div className="relative flex-1">
            {objects.length === 0 ? (
              <EmptyState icon={Boxes} title="No objects returned" hint={listError ? 'The object list could not be loaded. Retry above.' : 'This i3X server exposed no objects.'} />
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
                <Hint>Object graph · click a node to read its value and history</Hint>
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

const RANGES = [
  { value: 3600e3, label: '1 h' },
  { value: 24 * 3600e3, label: '24 h' },
  { value: 7 * 24 * 3600e3, label: '7 d' }
];

function ObjectPanel({ node, onClose }) {
  const elementId = node.meta?.elementId;
  const [range, setRange] = useState(7 * 24 * 3600e3);
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

  const loadHistory = async (ms = range) => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const now = Date.now();
      const r = await api.i3xHistory({ elementIds: [elementId], startTime: new Date(now - ms).toISOString(), endTime: new Date(now).toISOString() });
      setHistory(r.results?.[0]?.values || []);
    } catch (e) {
      setHistoryError(e);
    } finally {
      setLoadingHistory(false);
    }
  };

  const hasQuality = (history || []).some((v) => v.quality != null);

  return (
    <aside aria-label="Object details" className="absolute inset-y-0 right-0 z-10 flex w-full shrink-0 flex-col border-l border-line bg-panel sm:static sm:w-96">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{node.meta?.isComposition ? 'Composition object' : 'Object'}</p>
          <h2 className="break-all text-sm font-medium text-fg">{node.label}</h2>
          <p className="mono mt-0.5 break-all text-xs text-subtle">{elementId}</p>
        </div>
        <IconButton icon={X} label="Close object details" onClick={onClose} />
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {valueError && (
          <Banner variant="error" title="Could not read the current value" onRetry={loadValue}>
            {valueError.message}
          </Banner>
        )}
        {value && (
          <section aria-label="Current value" className="border-l-2 border-accent pl-3">
            <p className="text-xs text-muted">Current value</p>
            <p className="mono break-all text-lg font-medium tabular-nums text-fg">
              {formatValue(value.value)}
              {value.unit && <span className="ml-1 text-sm font-normal text-subtle">{value.unit}</span>}
            </p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-subtle">
              {value.timestamp && (
                <span title={`${new Date(value.timestamp).toLocaleString()} (local) · ${new Date(value.timestamp).toISOString()}`}>
                  <Timestamp value={value.timestamp} />
                </span>
              )}
              {value.quality != null && <span>quality {String(value.quality)}</span>}
            </p>
          </section>
        )}

        <section aria-labelledby="i3x-history">
          <h3 id="i3x-history" className="mb-2 text-sm font-medium text-fg">
            History
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl label="History range" size="sm" options={RANGES} value={range} onChange={setRange} />
            <Button size="sm" variant="secondary" onClick={() => loadHistory()} loading={loadingHistory}>
              Load history
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-subtle">The last {RANGES.find((r) => r.value === range)?.label}, ending now. Times are shown in your local time zone; hover for UTC.</p>

          {loadingHistory && (
            <div role="status" aria-busy="true" className="mt-3 space-y-2">
              <span className="sr-only">Loading history…</span>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {historyError && (
            <Banner variant="error" title="Could not load history" onRetry={() => loadHistory()} className="mt-3">
              {historyError.message}
            </Banner>
          )}
          {history && !loadingHistory && (
            <div className="mt-3">
              {history.length === 0 ? (
                <p className="text-sm text-muted">No samples in this range.</p>
              ) : (
                <>
                  <p className="mb-1.5 text-xs text-muted">
                    <span className="tabular-nums text-fg">{history.length.toLocaleString()}</span> samples, showing the latest {Math.min(50, history.length)}
                  </p>
                  <Table caption="Most recent history samples" wrapperClassName="max-h-60 overflow-y-auto" className="!min-w-0">
                    <THead>
                      <Th>Time (local)</Th>
                      <Th align="right">Value</Th>
                      {hasQuality && <Th>Quality</Th>}
                    </THead>
                    <tbody>
                      {history
                        .slice(-50)
                        .reverse()
                        .map((v, i) => (
                          <Tr key={i}>
                            <Td className="whitespace-nowrap py-1.5 text-xs tabular-nums text-muted" title={v.timestamp ? new Date(v.timestamp).toISOString() : undefined}>
                              {v.timestamp ? new Date(v.timestamp).toLocaleString() : '—'}
                            </Td>
                            <Td align="right" className="mono py-1.5 text-xs tabular-nums text-fg">
                              {formatValue(v.value)}
                              {v.unit && <span className="ml-1 text-subtle">{v.unit}</span>}
                            </Td>
                            {hasQuality && <Td className="py-1.5 text-xs text-muted">{v.quality != null ? String(v.quality) : ''}</Td>}
                          </Tr>
                        ))}
                    </tbody>
                  </Table>
                </>
              )}
            </div>
          )}
        </section>

        {node.meta && (
          <section aria-labelledby="i3x-meta">
            <h3 id="i3x-meta" className="mb-2 text-sm font-medium text-fg">
              Metadata
            </h3>
            <div className="rounded-md border border-line bg-app p-3">
              <JsonView data={node.meta} />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
