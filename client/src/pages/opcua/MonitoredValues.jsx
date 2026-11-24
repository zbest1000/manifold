import { StatusText, Timestamp, Table, THead, Th, Tr, Td } from '@/components/ui';
import { formatValue, qualityOf } from './helpers';

/** Latest value of every node being monitored on the active connection, most recent first. */
export default function MonitoredValues({ values }) {
  const rows = Object.entries(values || {})
    .map(([nodeId, v]) => ({ nodeId, ...v }))
    .sort((a, b) => new Date(b.sourceTimestamp || 0) - new Date(a.sourceTimestamp || 0));
  return (
    <section aria-labelledby="monitored-heading" className="border-t border-line">
      <h3 id="monitored-heading" className="flex items-baseline gap-2 px-4 py-2.5 text-sm font-medium text-fg">
        Monitored values
        <span className="font-mono text-xs font-normal text-subtle">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-subtle">Select a variable node and choose Monitor value. Live values appear here.</p>
      ) : (
        <Table caption="Monitored values" wrapperClassName="max-h-60 overflow-y-auto rounded-none border-0 border-t" className="!min-w-0">
          <THead>
            <Th>Node</Th>
            <Th align="right">Value</Th>
            <Th>Quality</Th>
            <Th align="right">Updated</Th>
          </THead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.nodeId}>
                <Td header className="mono max-w-[8rem] truncate py-1.5 text-xs" title={r.nodeId}>
                  {r.nodeId}
                </Td>
                <Td align="right" className="mono max-w-[8rem] truncate py-1.5 text-xs tabular-nums" title={formatValue(r.value)}>
                  {formatValue(r.value)}
                </Td>
                <Td className="py-1.5">
                  <StatusText tone={qualityOf(r.status).tone} className="text-xs">
                    {qualityOf(r.status).label}
                  </StatusText>
                </Td>
                <Td align="right" className="py-1.5 text-xs text-muted">
                  {r.sourceTimestamp ? <Timestamp value={r.sourceTimestamp} /> : '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
