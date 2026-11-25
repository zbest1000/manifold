import { useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { usePolled } from '@/lib/usePolled';
import JsonView from '@/components/JsonView';
import { Button, Banner, IconButton, Skeleton, StatusText, Timestamp } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { formatValue, qualityOf, statusDetail } from './helpers';

/**
 * Details of the selected node: a live value, monitor / stop monitoring and the node's attributes.
 * Whether the node is monitored comes from the server (`connection.monitorOwners`), so it survives
 * selecting another node, a reload and a reconnect; a node a tag binding maps stays monitored for the
 * binding when it is stopped here.
 */
export default function NodePanel({ node, connection, values, onClose, onMonitorChange, readOnly = false }) {
  const stale = connection?.status !== 'connected';
  const nodeId = node.meta?.nodeId;
  const connectionId = connection?.id;
  const owners = connection?.monitorOwners?.[nodeId] || [];
  const [pending, setPending] = useState(null); // optimistic 'user' ownership until the list catches up
  const byUser = pending ?? owners.includes('user');
  const byBindings = owners.includes('bindings');
  const isVariable = node.meta?.nodeClass === 'Variable';

  // Remounted per node (see key at the call site): attributes are fetched fresh for every selection.
  const attrs = usePolled(async () => (nodeId ? api.opcuaRead(connectionId, nodeId) : null));
  const details = attrs.data;
  const error = attrs.error;
  const loading = attrs.loading && !details && !error;

  const liveValue = values[nodeId];
  const quality = liveValue ? qualityOf(liveValue.status) : null;
  const detail = liveValue ? statusDetail(liveValue.status) : null;

  const monitor = async () => {
    setPending(true);
    try {
      await api.opcuaMonitor(connectionId, nodeId, 500);
      onMonitorChange?.();
    } catch (e) {
      setPending(null);
      toast.error(e.message);
    }
  };

  const stop = () => {
    setPending(false);
    socket.emit('opcua-unmonitor', { connectionId, nodeId });
    onMonitorChange?.();
  };

  return (
    <aside aria-label="Node details" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{node.meta?.nodeClass || 'Server'}</p>
          <h2 className="break-all text-sm font-medium text-fg">{node.label}</h2>
          <p className="mono mt-0.5 break-all text-xs text-subtle">{nodeId}</p>
        </div>
        <IconButton icon={X} label="Close node details" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {isVariable && (
          <div className="space-y-1.5">
            {byUser ? (
              <Button variant="secondary" onClick={stop} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Stop receiving live values for this node'} className="w-full">
                <EyeOff size={14} aria-hidden="true" /> Stop monitoring
              </Button>
            ) : (
              <Button onClick={monitor} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} className="w-full">
                <Eye size={14} aria-hidden="true" /> Monitor value
              </Button>
            )}
            {byBindings && <p className="text-xs text-subtle">A tag binding maps this node, so the server keeps sampling it for the binding.</p>}
          </div>
        )}

        {liveValue && (
          <section aria-label="Live value" className="border-l-2 border-accent pl-3">
            <p className="text-xs text-muted">{stale ? 'Last value received (reconnecting)' : 'Live value'}</p>
            <p className="mono break-all text-lg font-medium text-fg" aria-live="polite">
              {formatValue(liveValue.value)}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
              <StatusText tone={quality.tone} className="text-xs">
                {quality.label}
              </StatusText>
              {detail && <span className="mono break-all">{detail}</span>}
              {liveValue.sourceTimestamp ? (
                <span title={`${new Date(liveValue.sourceTimestamp).toLocaleString()} (local) · ${new Date(liveValue.sourceTimestamp).toISOString()}`}>
                  source time <Timestamp value={liveValue.sourceTimestamp} />
                </span>
              ) : (
                <span>no source time</span>
              )}
            </p>
          </section>
        )}

        {error && (
          <Banner variant="error" title="Could not read this node" onRetry={attrs.reload}>
            {error.message}
          </Banner>
        )}
        {loading && (
          <div role="status" aria-busy="true" className="space-y-2">
            <span className="sr-only">Loading attributes…</span>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {details && (
          <section aria-labelledby="node-attrs">
            <h3 id="node-attrs" className="mb-2 text-sm font-medium text-fg">
              Attributes
            </h3>
            <div className="overflow-x-auto rounded-md border border-line bg-app p-3">
              <JsonView data={details} />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
