import { useCallback, useMemo, useRef, useState } from 'react';
import { Plus, ListTree, Search, Share2, Box } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useStore, refreshOpcuaSoon } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildOpcuaGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphSearch from '@/components/GraphSearch';
import GraphTree from '@/components/GraphTree';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { Button, EmptyState, Banner, LoadingState, PageBody, SegmentedControl, Input, useConfirm } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import { useConflict } from '@/components/ConflictDialog';
import ConnectionForm from './opcua/ConnectionForm';
import ConnectionsTable from './opcua/ConnectionsTable';
import NodePanel from './opcua/NodePanel';
import MonitoredValues from './opcua/MonitoredValues';
import { formProblem, ROOT, BLANK_FORM, formFromConnection, connectionLabel, connectionState, nodeValueMap, pickConnectionId, activeValues } from './opcua/helpers';

const VIEWS = [
  { value: 'graph', label: 'Graph', icon: Share2 },
  { value: '3d', label: '3D', icon: Box },
  { value: 'tree', label: 'Tree', icon: ListTree }
];

/** A floating hint over a canvas: solid panel, hairline, overlay shadow (docs/design: canvas pages). */
const Hint = ({ children }) => <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted shadow-overlay">{children}</div>;

export default function OpcUa() {
  const opcua = useStore((s) => s.opcua);
  const readOnly = useReadOnly();
  const opcuaValues = useStore((s) => s.opcuaValues);
  const setOpcua = useStore((s) => s.setOpcua);
  const graphStyle = useStore((s) => s.graphStyle);
  const showValues = useStore((s) => s.showValues);
  const showMinimap = useStore((s) => s.showMinimap);

  // OPC UA address spaces are strictly hierarchical: default to the client
  // `tree` layout (kept per-view so it doesn't override the MQTT graph's pref).
  const [graphLayout, setGraphLayout] = useState('tree');
  const [pickedId, setPickedId] = useState(null); // user's choice; falls back to the first connected server
  const [extra, setExtra] = useState({ connectionId: null, map: new Map() }); // nodes expanded beyond the root
  const [sel, setSel] = useState({ connectionId: null, node: null });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [editingId, setEditingId] = useState(null);
  const [editingRev, setEditingRev] = useState(null); // the stored revision the edit is based on (409 stale if someone saved since)
  const [duplicate, setDuplicate] = useState(null); // 409 duplicate: { id, name } of the connection that already exists
  const { resolveConflict, conflictDialog } = useConflict();
  const [attempted, setAttempted] = useState(false); // validation shows only after the first submit
  const [submitError, setSubmitError] = useState(null);
  const [failedAttempts, setFailedAttempts] = useState(0); // refreshes the certificate list after a refused connect
  const [endpoints, setEndpoints] = useState(null); // discovered endpoint list
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matchIds, setMatchIds] = useState(null);
  const [view, setView] = useState('graph');
  const [treeFilter, setTreeFilter] = useState('');
  const graphRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  // Initial load of the connection list; live updates come from the store.
  const { loading, error, reload } = usePolled(async () => {
    const list = await api.listOpcua();
    setOpcua(list.connections);
    return list;
  });

  // Live updates (connect, reconnect, monitor changes, errors) are the store's: it re-reads the list.
  const refreshList = refreshOpcuaSoon;

  const connectionId = pickConnectionId(opcua, pickedId);
  const setConnectionId = setPickedId;

  // The root's children load whenever the active connection changes; deeper
  // levels are added on demand (`extra`), and both reset with the connection.
  const root = usePolled(async () => (connectionId ? api.opcuaBrowse(connectionId, ROOT) : null), { deps: [connectionId] });
  const browseError = root.error;
  const loadRoot = root.reload;
  const expanded = useMemo(() => {
    const m = new Map();
    if (root.data?.references) m.set(ROOT, root.data.references);
    if (extra.connectionId === connectionId) for (const [k, v] of extra.map) m.set(k, v);
    return m;
  }, [root.data, extra, connectionId]);
  const selected = sel.connectionId === connectionId ? sel.node : null;
  const setSelected = (node) => setSel({ connectionId, node });

  const connection = opcua.find((c) => c.id === connectionId);
  // The graph depends on the connection's identity and label only: list refreshes (status, monitored
  // counts) must not rebuild it and restart the layout.
  const graphKey = connection ? `${connection.id}\u0000${connection.name || ''}\u0000${connection.endpointUrl}` : '';
  const graph = useMemo(() => {
    if (!graphKey) return { nodes: [], links: [] };
    const [id, name, endpointUrl] = graphKey.split('\u0000');
    return buildOpcuaGraph({ id, name, endpointUrl }, expanded);
  }, [graphKey, expanded]);
  // Browse names of the nodes seen so far, so monitored values read "Double", not a truncated node id.
  const labels = useMemo(() => Object.fromEntries(graph.nodes.filter((n) => n.meta?.nodeId).map((n) => [n.meta.nodeId, n.label])), [graph]);

  // Latest monitored value per node, for the on-node overlay.
  // Values of nodes no longer monitored stay in the store; show only what the server still samples.
  const monitored = useMemo(() => activeValues(connection, opcuaValues[connectionId]), [connection, opcuaValues, connectionId]);
  const nodeValues = useMemo(() => nodeValueMap(connectionId, monitored), [connectionId, monitored]);

  const problem = attempted ? formProblem(form) : '';

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setEditingRev(null);
    setDuplicate(null);
    setForm({ ...BLANK_FORM });
    setEndpoints(null);
    setAttempted(false);
    setSubmitError(null);
  };

  const openNewForm = () => {
    setEditingId(null);
    setEditingRev(null);
    setDuplicate(null);
    setForm({ ...BLANK_FORM });
    setEndpoints(null);
    setAttempted(false);
    setSubmitError(null);
    setShowForm(true);
  };

  const connect = async (override = null) => {
    if (busy || readOnly) return;
    setAttempted(true);
    setSubmitError(null);
    setDuplicate(null);
    if (formProblem(form)) return;
    setBusy(true);
    const body = editingId ? { ...form, ...(override?.rev !== undefined ? { rev: override.rev } : editingRev ? { rev: editingRev } : {}) } : form;
    try {
      const res = editingId ? await api.updateOpcuaConnection(editingId, body) : await api.connectOpcua(form);
      toast.success(editingId ? 'Connection updated' : 'Connected to OPC UA server');
      closeForm();
      setConnectionId(res.connectionId);
      const list = await api.listOpcua();
      setOpcua(list.connections);
    } catch (e) {
      // The server announces a connection while it is connecting and drops it again when that fails;
      // re-read the list so a failed attempt does not leave a ghost "connecting" row behind.
      api.listOpcua().then((list) => setOpcua(list.connections)).catch(() => {});
      if (e.status === 409 && e.code === 'duplicate') {
        setDuplicate(e.existing || { name: 'an existing connection' });
        return;
      }
      if (e.status === 409 && e.code === 'stale') {
        setBusy(false);
        // compare what a stored connection carries (not form-only switches such as trust-on-connect)
        const choice = await resolveConflict(e, { what: 'OPC UA connection', mine: { name: form.name, endpointUrl: form.endpointUrl, securityMode: form.securityMode, securityPolicy: form.securityPolicy, username: form.username } });
        if (choice === 'mine') return connect({ rev: e.current?.rev ?? 0 });
        if (choice === 'theirs' && e.current) {
          setForm(formFromConnection(e.current));
          setEditingRev(e.current.rev ?? null);
        }
        return;
      }
      setSubmitError(e.message);
      setFailedAttempts((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  // Load a connection's config into the form for editing. Password is never
  // echoed back: leaving it blank keeps the stored one.
  const edit = (c) => {
    setForm(formFromConnection(c));
    setEditingId(c.id);
    setEditingRev(c.rev ?? null);
    setDuplicate(null);
    setEndpoints(null);
    setAttempted(false);
    setSubmitError(null);
    setShowForm(true);
  };

  const discover = async () => {
    if (!form.endpointUrl) return;
    setDiscovering(true);
    setEndpoints(null);
    setSubmitError(null);
    try {
      const res = await api.opcuaDiscover(form.endpointUrl);
      setEndpoints(res.endpoints || []);
    } catch (e) {
      setSubmitError(e.message);
    } finally {
      setDiscovering(false);
    }
  };

  // Memoized so the graph's onExpand prop is a fresh closure over the CURRENT
  // connectionId whenever it changes: the ForceGraph ref fix reads the latest
  // prop, so a stable-but-current identity keeps the two in step (double-click
  // after switching servers browses the right server).
  const expandNode = useCallback(
    async (node) => {
      const nodeId = node.meta?.nodeId;
      if (!nodeId || expanded.has(nodeId)) return;
      try {
        const res = await api.opcuaBrowse(connectionId, nodeId);
        setExtra((prev) => ({ connectionId, map: new Map(prev.connectionId === connectionId ? prev.map : []).set(nodeId, res.references) }));
      } catch (e) {
        toast.error(e.message);
      }
    },
    [connectionId, expanded]
  );

  // Removes the saved connection server-side, so confirm: there is no undo.
  const disconnect = async (conn) => {
    const ok = await confirm({
      title: `Disconnect "${connectionLabel(conn)}"?`,
      message: `This drops the connection, stops its ${conn.monitoredCount || 0} monitored values and deletes the saved connection profile, including its stored password. This cannot be undone.`,
      confirmLabel: 'Disconnect and remove',
      danger: true
    });
    if (!ok) return;
    try {
      await api.disconnectOpcua(conn.id);
      const list = await api.listOpcua();
      setOpcua(list.connections);
      if (conn.id === connectionId) setSelected(null);
      toast.success('Disconnected and removed');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const connectAction = (
    <Button onClick={openNewForm} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined}>
      <Plus size={14} aria-hidden="true" /> Connect a server
    </Button>
  );

  const upCount = opcua.filter((c) => c.status === 'connected').length;
  const showEmpty = opcua.length === 0 && !loading;
  const state = connection ? connectionState(connection) : null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="OPC UA" subtitle={opcua.length ? `${upCount} of ${opcua.length} connected` : undefined} actions={showEmpty && !error ? undefined : connectAction} />

      <PageBody>
        <ReadOnlyNote className="" />

        {error && opcua.length === 0 && (
          <Banner variant="error" title="Could not load OPC UA connections" onRetry={reload}>
            {error.message}
          </Banner>
        )}

        {loading && opcua.length === 0 && !error && <LoadingState label="OPC UA connections" rows={2} />}

        {showEmpty && !error && (
          <div className="rounded-lg border border-line bg-panel">
            <EmptyState
              title="No OPC UA servers yet"
              hint="Connect to an OPC UA endpoint (opc.tcp://…) to browse its address space, watch live values and map nodes to tags. A server that goes away is retried automatically."
              action={connectAction}
            />
          </div>
        )}

        {opcua.length > 0 && <ConnectionsTable connections={opcua} activeId={connectionId} editingId={editingId} onSelect={setConnectionId} onEdit={edit} onRemove={disconnect} readOnly={readOnly} />}

        {browseError && (
          <Banner variant="error" title="Could not browse this server" onRetry={loadRoot}>
            {browseError.message}
          </Banner>
        )}

        {opcua.length > 0 && !connection && (
          <div className="rounded-lg border border-line bg-panel">
            <EmptyState title="No connected server selected" hint="Choose Explore on a connected server in the table to browse its address space." />
          </div>
        )}

        {connection && (
          <section aria-label="Address space explorer" className="flex h-[36rem] min-h-[28rem] flex-col overflow-clip rounded-lg border border-line bg-panel">
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
              <SegmentedControl label="Explorer view" size="sm" options={VIEWS} value={view} onChange={setView} />
              <p className="min-w-0 flex-1 truncate text-xs text-muted">
                <span className="text-fg">{connectionLabel(connection)}</span>
                <span className="tabular-nums"> · {graph.nodes.length.toLocaleString()} nodes</span>
                {state.tone !== 'good' && <span> · {state.label.toLowerCase()}</span>}
                <span className="hidden sm:inline"> · double-click a node to expand it</span>
              </p>
            </div>
            <div className="relative flex min-h-0 flex-1">
              <div className="relative min-w-0 flex-1">
                {view === 'tree' ? (
                  <div className="flex h-full w-full flex-col">
                    <div className="relative shrink-0 border-b border-line p-2">
                      <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
                      <Input aria-label="Filter nodes" className="pl-8" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter nodes…" />
                    </div>
                    <GraphTree nodes={graph.nodes} links={graph.links} selectedId={selected?.id || null} onSelect={setSelected} onExpandNode={expandNode} valueMap={showValues ? nodeValues : null} filter={treeFilter} />
                  </div>
                ) : view === '3d' ? (
                  <>
                    <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} />
                    <Hint>Drag to rotate · scroll to zoom · click a node for details</Hint>
                  </>
                ) : (
                  <>
                    <GraphSearch nodes={graph.nodes} onMatches={setMatchIds} onFit={(ids) => graphRef.current?.fitTo(ids)} />
                    <GraphToolbar
                      onFit={() => graphRef.current?.fitTo()}
                      onExportPng={() => downloadDataUrl(graphRef.current?.exportPng(), `opcua-graph-${connectionId}.png`)}
                      onExportJson={() => downloadJson(graphRef.current?.exportGraph(), `opcua-graph-${connectionId}.json`)}
                      layoutValue={graphLayout}
                      onLayoutChange={setGraphLayout}
                    />
                    <ForceGraph
                      ref={graphRef}
                      data={graph}
                      styleId={graphStyle}
                      layoutId={graphLayout}
                      selectedId={selected?.id || null}
                      onSelect={setSelected}
                      onExpand={expandNode}
                      nodeValues={showValues ? nodeValues : null}
                      matchIds={matchIds}
                      minimap={showMinimap}
                    />
                    <Hint>Double-click a node to browse its children · click to inspect</Hint>
                  </>
                )}
              </div>

              <div className={clsx('flex min-h-0 flex-col border-l border-line bg-panel', selected ? 'absolute inset-y-0 right-0 z-10 w-full sm:static sm:w-96' : 'hidden lg:flex lg:w-96')}>
                {selected ? (
                  <NodePanel key={`${connectionId}:${selected.meta?.nodeId || selected.id}`} readOnly={readOnly} node={selected} connection={connection} values={monitored} onMonitorChange={refreshList} onClose={() => setSelected(null)} />
                ) : (
                  <p className="flex-1 px-4 py-3 text-sm text-muted">Select a node to see its attributes and live value.</p>
                )}
                <div className={clsx('shrink-0', selected && 'hidden sm:block')}>
                  <MonitoredValues values={monitored} labels={labels} stale={state.tone !== 'good'} />
                </div>
              </div>
            </div>
          </section>
        )}
      </PageBody>

      {showForm && (
        <ConnectionForm
          form={form}
          setForm={setForm}
          editing={Boolean(editingId)}
          endpoints={endpoints}
          discovering={discovering}
          busy={busy}
          problem={problem}
          submitError={submitError}
          duplicate={duplicate}
          onEditExisting={duplicate?.id && opcua.some((c) => c.id === duplicate.id) ? () => edit(opcua.find((c) => c.id === duplicate.id)) : null}
          failedAttempts={failedAttempts}
          onDiscover={discover}
          onSubmit={() => connect()}
          onCancel={closeForm}
        />
      )}
      {confirmDialog}
      {conflictDialog}
    </div>
  );
}
