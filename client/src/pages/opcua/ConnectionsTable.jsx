import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Table, THead, TableSort, Th, Tr, Td, StatusText, Timestamp, Button, IconButton } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import { READ_ONLY_REASON } from '@/store/selectors';
import { connectionLabel, connectionState } from './helpers';

const ACCESSORS = {
  name: (c) => c.name,
  status: (c) => c.status,
  security: (c) => `${c.securityMode || 'None'} ${c.securityPolicy || ''}`,
  monitored: (c) => c.monitoredCount ?? 0
};

/** The OPC UA connections as a sortable table; one row is the connection the explorer below is showing. */
export default function ConnectionsTable({ connections, activeId, editingId, onSelect, onEdit, onRemove, readOnly = false }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const rows = sortRows(connections, sort, ACCESSORS);
  return (
    <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
      <Table caption="OPC UA server connections" className="min-w-[52rem]">
        <THead>
          <Th sortKey="name">Server</Th>
          <Th sortKey="status">State</Th>
          <Th sortKey="security">Security</Th>
          <Th sortKey="monitored" align="right">Monitored</Th>
          <Th align="right">Connected</Th>
          <Th srOnly align="right">Actions</Th>
        </THead>
        <tbody>
          {rows.map((c) => {
            const label = connectionLabel(c);
            const active = c.id === activeId;
            const st = connectionState(c);
            const down = c.status !== 'connected';
            return (
              <Tr key={c.id} highlight={active || editingId === c.id}>
                <Td header className="max-w-[20rem]">
                  <span className="block truncate font-medium text-fg">{c.name}</span>
                  <span className="mono block truncate text-xs text-muted" title={c.endpointUrl}>
                    {c.endpointUrl}
                  </span>
                </Td>
                <Td className="max-w-[22rem]">
                  <StatusText tone={st.tone}>{st.label}</StatusText>
                  {down && c.lastError && (
                    <span className="block truncate text-xs text-subtle" title={c.lastError}>
                      {c.lastError}
                    </span>
                  )}
                  {st.note && (
                    <span className="block truncate text-xs text-subtle" title={st.note}>
                      {st.note}
                    </span>
                  )}
                </Td>
                <Td className="mono text-xs text-muted">
                  {c.securityMode || 'None'}
                  {c.securityPolicy && c.securityPolicy !== 'None' ? ` · ${c.securityPolicy}` : ''}
                </Td>
                <Td align="right" className="mono tabular-nums text-muted">
                  {(c.monitoredCount ?? 0).toLocaleString()}
                </Td>
                <Td align="right" className="text-xs text-muted">
                  {c.status === 'connected' && c.connectedAt ? <Timestamp value={c.connectedAt} /> : <span className="text-subtle">—</span>}
                </Td>
                <Td align="right" className="w-44">
                  <span className="inline-flex items-center gap-1">
                    <Button size="sm" variant={active ? 'subtle' : 'secondary'} onClick={() => onSelect(c.id)} aria-pressed={active} aria-label={`${active ? 'Exploring' : 'Explore'} ${label}`}>
                      {active ? 'Exploring' : 'Explore'}
                    </Button>
                    <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} ${label}`} size={14} onClick={() => onEdit(c)} />
                    <IconButton
                      icon={Trash2}
                      label={`Disconnect and remove ${label}`}
                      size={14}
                      className="hover:bg-bad/10 hover:text-bad"
                      onClick={() => onRemove(c)}
                      disabled={readOnly}
                      title={readOnly ? READ_ONLY_REASON : undefined}
                    />
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableSort>
  );
}
