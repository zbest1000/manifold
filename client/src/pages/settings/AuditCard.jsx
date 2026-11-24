import { ScrollText } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Card, Banner, LoadingState, Table, THead, Th, Tr, Td } from '@/components/ui';
import { auditStatusClass } from './helpers';

// Audit trail: every mutating action against the control plane, newest first.
export default function AuditCard() {
  const { data, error, loading, reload } = usePolled(() => api.auditRecent(50), { interval: 10_000 });
  const events = data?.events || [];
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <ScrollText size={16} className="text-accent-400" aria-hidden="true" /> Audit trail
      </h2>
      <p className="mb-3 text-sm text-muted">
        Who changed what: every mutating API call and control socket event, with role and outcome. Persisted to
        <span className="mono"> data/audit.jsonl</span>; secrets are redacted before logging.
      </p>
      {error && (
        <Banner variant="error" title="Could not load the audit trail" onRetry={reload} className="mb-3">
          {error.message}
        </Banner>
      )}
      {loading && !data && !error && <LoadingState label="audit trail" rows={2} />}
      {data && events.length === 0 && <p className="helper">No mutating actions recorded yet.</p>}
      {events.length > 0 && (
        <Table caption="Recent mutating actions, newest first" wrapperClassName="max-h-64 overflow-y-auto rounded-xl" className="min-w-[28rem] font-mono text-xs">
          <THead>
            <Th>Time</Th>
            <Th>Status</Th>
            <Th>Role</Th>
            <Th>Action</Th>
          </THead>
          <tbody>
            {events.map((e, i) => (
              <Tr key={i}>
                <Td className="whitespace-nowrap py-1.5 text-muted">{new Date(e.ts).toLocaleTimeString()}</Td>
                <Td className={clsx('py-1.5', auditStatusClass(e))}>{e.status || e.method}</Td>
                <Td className="py-1.5 text-sky-300">{e.role}</Td>
                <Td className="max-w-[18rem] truncate py-1.5 text-slate-300">
                  {e.method} {e.path}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
