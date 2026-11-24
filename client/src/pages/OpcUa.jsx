import { useCallback, useMemo, useRef, useState } from 'react';
import { Cpu, Plus, ListTree, Search, Share2, Box } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import ForceGraph from '@/graph/ForceGraph';
import ForceGraph3D from '@/graph/ForceGraph3D';
import { buildOpcuaGraph } from '@/graph/buildGraph';
import GraphToolbar from '@/components/GraphToolbar';
import GraphSearch from '@/components/GraphSearch';
import GraphTree from '@/components/GraphTree';
import { downloadDataUrl, downloadJson } from '@/lib/download';
import { Card, Button, EmptyState, Banner, LoadingState, useConfirm } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ViewTab from '@/components/ViewTab';
import ConnectionForm from './opcua/ConnectionForm';
import ConnectionsTable from './opcua/ConnectionsTable';
import NodePanel from './opcua/NodePanel';
import { ROOT, BLANK_FORM, formFromConnection, connectionLabel, nodeValueMap, pickConnectionId } from './opcua/helpers';

export default function OpcUa() {
  const opcua = useStore((s) => s.opcua);
  const opcuaValues = useStore((s) => s.opcuaValues);
  const setOpcua = useStore((s) => s.setOpcua);
  const graphStyle = useStore((s) => s.graphStyle);
  const showValues = useStore((s) => s.showValues);
  const showMinimap = useStore((s) => s.showMinimap);

  // OPC UA address spaces are strictly hierarchical — default to the client
  // `tree` layout (kept per-view so it doesn't override the MQTT graph's pref).
  const [graphLayout, setGraphLayout] = useState('tree');
  const [pickedId, setPickedId] = useState(null); // user's choice; falls back to the first connected server
  const [extra, setExtra] = useState({ connectionId: null, map: new Map() }); // nodes expanded beyond the root
  const [sel, setSel] = useState({ connectionId: null, node: null });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [editingId, setEditingId] = useState(null);
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
  const graph = useMemo(() => {
    if (!connection) return { nodes: [], links: [] };
    return buildOpcuaGraph(connection, expanded);
  }, [connection, expanded]);

  // Latest monitored value per node, for the on-node overlay.
  const nodeValues = useMemo(() => nodeValueMap(connectionId, opcuaValues[connectionId]), [connectionId, opcuaValues]);

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...BLANK_FORM });
    setEndpoints(null);
  };

  const openNewForm = () => {
    setEditingId(null);
    setForm({ ...BLANK_FORM });
    setEndpoints(null);
    setShowForm((v) => !v);
  };

  const connect = async () => {
    if (!form.endpointUrl) return toast.error('Endpoint URL is required');
    setBusy(true);
    try {
      const res = editingId ? await api.updateOpcuaConnection(editingId, form) : await api.connectOpcua(form);
      toast.success(editingId ? 'Connection updated' : 'Connected to OPC UA server');
      closeForm();
      setConnectionId(res.connectionId);
      const list = await api.listOpcua();
      setOpcua(list.connections);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Load a connection's config into the form for editing. Password is never
  // echoed back — leaving it blank keeps the stored one.
  const edit = (c) => {
    setForm(formFromConnection(c));
    setEditingId(c.id);
    setEndpoints(null);
    setShowForm(true);
  };

  const discover = async () => {
    if (!form.endpointUrl) return toast.error('Endpoint URL is required');
    setDiscovering(true);
    setEndpoints(null);
    try {
      const res = await api.opcuaDiscover(form.endpointUrl);
      setEndpoints(res.endpoints || []);
      if (!res.endpoints?.length) toast('The server reported no endpoints');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDiscovering(false);
    }
  };

  // Memoized so the graph's onExpand prop is a fresh closure over the CURRENT
  // connectionId whenever it changes — the ForceGraph ref fix reads the latest
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

  // Removes the saved connection server-side, so confirm — there is no undo.
  const disconnect = async (conn) => {
    const ok = await confirm({
      title: `Disconnect "${connectionLabel(conn)}"?`,
      message: 'This drops the connection and deletes the saved connection profile. This cannot be undone.',
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
    <Button onClick={openNewForm} aria-expanded={showForm}>
      <Plus size={15} aria-hidden="true" /> {showForm ? 'Close form' : 'Connect a server'}
    </Button>
  );

  const showEmpty = opcua.length === 0 && !showForm && !loading;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="OPC UA"
        subtitle={connection ? `${connectionLabel(connection)} · ${graph.nodes.length} nodes · double-click a node to expand` : 'Browse an OPC UA address space as a node graph and watch live values'}
        actions={
          <>
            {connection && (
              <div role="group" aria-label="Explorer view" className="flex overflow-hidden rounded-xl border border-white/10">
                <ViewTab active={view === 'graph'} onClick={() => setView('graph')} icon={Share2} label="Graph" />
                <ViewTab active={view === '3d'} onClick={() => setView('3d')} icon={Box} label="3D" />
                <ViewTab active={view === 'tree'} onClick={() => setView('tree')} icon={ListTree} label="Tree" />
              </div>
            )}
            {connectAction}
          </>
        }
      />

      {error && opcua.length === 0 && (
        <div className="px-4 pt-4 sm:px-6">
          <Banner variant="error" title="Could not load OPC UA connections" onRetry={reload}>
            {error.message}
          </Banner>
        </div>
      )}

      {loading && opcua.length === 0 && !error && (
        <div className="p-4 sm:p-6">
          <LoadingState label="OPC UA connections" rows={2} />
        </div>
      )}

      {showEmpty && !error && (
        <EmptyState
          icon={Cpu}
          title="No OPC UA servers connected"
          hint="Connect to an OPC UA endpoint (opc.tcp://…) to explore its address space, watch live values and map nodes to tags."
          action={
            <Button onClick={openNewForm}>
              <Plus size={15} aria-hidden="true" /> Connect a server
            </Button>
          }
        />
      )}

      {(showForm || opcua.length > 0) && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="space-y-4 px-4 pt-4 sm:px-6">
            {showForm && (
              <ConnectionForm
                form={form}
                setForm={setForm}
                editing={Boolean(editingId)}
                endpoints={endpoints}
                discovering={discovering}
                busy={busy}
                onDiscover={discover}
                onSubmit={connect}
                onCancel={closeForm}
              />
            )}
            {opcua.length > 0 && <ConnectionsTable connections={opcua} activeId={connectionId} editingId={editingId} onSelect={setConnectionId} onEdit={edit} onRemove={disconnect} />}
            {browseError && (
              <Banner variant="error" title="Could not browse this server" onRetry={loadRoot}>
                {browseError.message}
              </Banner>
            )}
          </div>

          {opcua.length > 0 && (
            <div className="relative mt-4 flex min-h-[26rem] flex-1 overflow-hidden border-t border-white/5">
              <div className="relative flex-1">
                {connection ? (
                  view === 'tree' ? (
                    <div className="flex h-full w-full max-w-md flex-col border-r border-white/5 bg-surface-900/30">
                      <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                        <Search size={14} className="text-subtle" aria-hidden="true" />
                        <input
                          value={treeFilter}
                          onChange={(e) => setTreeFilter(e.target.value)}
                          aria-label="Filter nodes"
                          placeholder="Filter nodes…"
                          className="w-full bg-transparent text-sm text-slate-200 placeholder:text-faint focus:outline-none"
                        />
                      </div>
                      <GraphTree
                        nodes={graph.nodes}
                        links={graph.links}
                        selectedId={selected?.id || null}
                        onSelect={setSelected}
                        onExpandNode={expandNode}
                        valueMap={showValues ? nodeValues : null}
                        filter={treeFilter}
                      />
                    </div>
                  ) : view === '3d' ? (
                    <>
                      <ForceGraph3D data={graph} styleId={graphStyle} selectedId={selected?.id || null} onSelect={setSelected} />
                      <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-muted backdrop-blur">
                        Drag to rotate · scroll to zoom · click a node for details
                      </div>
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
                      <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/10 bg-surface-900/70 px-3 py-2 text-xs text-muted backdrop-blur">
                        Double-click a node to browse its children · click to inspect
                      </div>
                    </>
                  )
                ) : (
                  <Card className="m-6">
                    <EmptyState icon={Cpu} title="No connected server selected" hint="Choose “Explore” on a connected server in the table above." />
                  </Card>
                )}
              </div>

              {selected && <NodePanel key={`${connectionId}:${selected.meta?.nodeId || selected.id}`} node={selected} connectionId={connectionId} values={opcuaValues[connectionId] || {}} onClose={() => setSelected(null)} />}
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
