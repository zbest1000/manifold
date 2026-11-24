import { useEffect, useState } from 'react';
import { Eye, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { usePolled } from '@/lib/usePolled';
import JsonView from '@/components/JsonView';
import { Button, Banner, IconButton, Skeleton, StatusText, Timestamp } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { formatValue, qualityOf } from './helpers';

/** Details of the selected node: a live value, a "monitor" action and the node's attributes. */
export default function NodePanel({ node, connectionId, values, onClose, readOnly = false }) {
  const nodeId = node.meta?.nodeId;
  const [monitoring, setMonitoring] = useState(false);

  // Remounted per node (see key at the call site): attributes are fetched and
  // the "monitoring" flag starts fresh for every selection.
  const attrs = usePolled(async () => (nodeId ? api.opcuaRead(connectionId, nodeId) : null));
  const details = attrs.data;
  const error = attrs.error;
  const loading = attrs.loading && !details && !error;
  const load = attrs.reload;

  const liveValue = values[nodeId];

  const monitor = async () => {
    try {
      await api.opcuaMonitor(connectionId, nodeId, 500);
      setMonitoring(true);
      toast.success('Monitoring value');
    } catch (e) {
      toast.error(e.message);
    }
  };

  useEffect(() => {
    return () => {
      if (monitoring) socket.emit('opcua-unmonitor', { connectionId, nodeId });
    };
  }, [monitoring, connectionId, nodeId]);

  return (
    <aside aria-label="Node details" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{node.meta?.nodeClass || 'Node'}</p>
          <h2 className="break-all text-sm font-medium text-fg">{node.label}</h2>
          <p className="mono mt-0.5 break-all text-xs text-subtle">{nodeId}</p>
        </div>
        <IconButton icon={X} label="Close node details" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {node.meta?.nodeClass === 'Variable' && (
          <Button variant={monitoring ? 'secondary' : 'primary'} onClick={monitor} disabled={monitoring || readOnly} title={readOnly ? READ_ONLY_REASON : undefined} className="w-full">
            <Eye size={14} aria-hidden="true" /> {monitoring ? 'Monitoring live' : 'Monitor value'}
          </Button>
        )}

        {liveValue && (
          <section aria-label="Live value" className="border-l-2 border-accent pl-3">
            <p className="text-xs text-muted">Live value</p>
            <p className="mono break-all text-lg font-medium text-fg" aria-live="polite">
              {formatValue(liveValue.value)}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-subtle">
              <StatusText tone={qualityOf(liveValue.status).tone} className="text-xs">
                {qualityOf(liveValue.status).label}
              </StatusText>
              {liveValue.sourceTimestamp && (
                <span title={`${new Date(liveValue.sourceTimestamp).toLocaleString()} (local) · ${new Date(liveValue.sourceTimestamp).toISOString()}`}>
                  source time <Timestamp value={liveValue.sourceTimestamp} />
                </span>
              )}
            </p>
          </section>
        )}

        {error && (
          <Banner variant="error" title="Could not read this node" onRetry={load}>
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
            <div className="rounded-md border border-line bg-app p-3">
              <JsonView data={details} />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
