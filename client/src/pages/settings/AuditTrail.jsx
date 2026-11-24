import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Banner, EmptyState, LoadingState, StatusText, Table, THead, Th, Tr, Td } from '@/components/ui';
import { auditTone } from './helpers';

/** Audit trail: every mutating API call and control-socket event, newest first, with role and outcome. */
export default function AuditTrail() {
  const { data, error, loading, reload } = usePolled(() => api.auditRecent(100), { interval: 10_000 });
  const events = data?.events || [];
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Who changed what. Every call that changes something is logged with the role that made it and whether it succeeded, and persisted to <span className="mono text-xs">data/audit.jsonl</span>. Secrets are
        redacted before logging.
      </p>
      {error && (
        <Banner variant="error" title="Could not load the audit trail" onRetry={reload}>
          {error.message}
        </Banner>
      )}
      {loading && !data && !error && <LoadingState label="audit trail" rows={3} />}
      {data && events.length === 0 && (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState title="No changes recorded yet" hint="Anything that creates, edits or deletes something on this server will appear here." />
        </div>
      )}
      {events.length > 0 && (
        <Table caption="Recent mutating actions, newest first" className="min-w-[36rem]">
          <THead>
            <Th>Time</Th>
            <Th>Result</Th>
            <Th>Role</Th>
            <Th>Action</Th>
          </THead>
          <tbody>
            {events.map((e, i) => (
              <Tr key={i}>
                <Td className="whitespace-nowrap py-1.5 text-xs text-muted">
                  <span className="tabular-nums" title={`${new Date(e.ts).toLocaleString()} (local) · ${new Date(e.ts).toISOString()}`}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                </Td>
                <Td className="py-1.5">
                  <StatusText tone={auditTone(e)} className="mono text-xs">
                    {e.status || e.method}
                  </StatusText>
                </Td>
                <Td className="py-1.5 text-xs text-muted">{e.role}</Td>
                <Td className="mono max-w-[24rem] truncate py-1.5 text-xs text-fg" title={`${e.method} ${e.path}`}>
                  {e.method} {e.path}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
