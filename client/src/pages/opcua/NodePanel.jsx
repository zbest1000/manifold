import { useEffect, useState } from 'react';
import { Activity, Eye, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { usePolled } from '@/lib/usePolled';
import JsonView from '@/components/JsonView';
import { Card, Button, Banner, Skeleton } from '@/components/ui';
import { READ_ONLY_REASON } from '@/store/selectors';
import { formatValue } from './helpers';

/** Side panel with a node's attributes, a live value and a "monitor" action. */
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
    <aside aria-label="Node details" className="absolute inset-y-0 right-0 z-10 flex w-full shrink-0 flex-col border-l border-white/5 bg-surface-900 sm:static sm:w-96 sm:bg-surface-900/50">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="label-xs">{node.meta?.nodeClass || 'Node'}</p>
          <h2 className="mt-0.5 break-all text-sm font-medium text-slate-100">{node.label}</h2>
          <p className="mono helper mt-0.5 break-all">{nodeId}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close node details" className="rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-slate-200">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {node.meta?.nodeClass === 'Variable' && (
          <Button onClick={monitor} disabled={monitoring || readOnly} title={readOnly ? READ_ONLY_REASON : undefined} className="w-full">
            <Eye size={14} aria-hidden="true" /> {monitoring ? 'Monitoring live' : 'Monitor value'}
          </Button>
        )}

        {liveValue && (
          <Card className="border-accent-500/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-400">
              <Activity size={12} aria-hidden="true" /> Live value
            </p>
            <p className="mono break-all text-lg font-semibold text-slate-100" aria-live="polite">
              {formatValue(liveValue.value)}
            </p>
            {liveValue.sourceTimestamp && <p className="helper mt-1">{new Date(liveValue.sourceTimestamp).toLocaleString()}</p>}
          </Card>
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
          <Card className="p-3">
            <p className="label-xs mb-2">Attributes</p>
            <JsonView data={details} />
          </Card>
        )}
      </div>
    </aside>
  );
}
