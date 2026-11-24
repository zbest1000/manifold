import { useState } from 'react';
import { Pencil, Trash2, Eye } from 'lucide-react';
import { Table, THead, TableSort, Th, Tr, Td, Badge, Button, IconButton } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import { READ_ONLY_REASON } from '@/store/selectors';
import { connectionLabel } from './helpers';

const ACCESSORS = {
  name: (c) => c.name,
  status: (c) => c.status,
  security: (c) => `${c.securityMode || 'None'} ${c.securityPolicy || ''}`
};

/** The list of OPC UA connections as a sortable table; one row is the "active" explorer target. */
export default function ConnectionsTable({ connections, activeId, editingId, onSelect, onEdit, onRemove, readOnly = false }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const rows = sortRows(connections, sort, ACCESSORS);
  return (
    <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
      <Table caption="OPC UA server connections" wrapperClassName="max-h-56 overflow-y-auto">
        <THead>
          <Th sortKey="name">Server</Th>
          <Th sortKey="status">Status</Th>
          <Th sortKey="security">Security</Th>
          <Th srOnly align="right">Actions</Th>
        </THead>
        <tbody>
          {rows.map((c) => {
            const label = connectionLabel(c);
            const active = c.id === activeId;
            return (
              <Tr key={c.id} highlight={active || editingId === c.id}>
                <Td header>
                  <span className="block text-slate-100">{c.name}</span>
                  <span className="mono block text-xs text-muted">{c.endpointUrl}</span>
                </Td>
                <Td>
                  <Badge status={c.status} />
                </Td>
                <Td className="mono text-xs text-muted">
                  {c.securityMode || 'None'}
                  {c.securityPolicy && c.securityPolicy !== 'None' ? ` · ${c.securityPolicy}` : ''}
                </Td>
                <Td align="right">
                  <span className="inline-flex items-center gap-1">
                    <Button size="sm" variant={active ? 'subtle' : 'outline'} onClick={() => onSelect(c.id)} aria-pressed={active} aria-label={`Explore ${label}`}>
                      <Eye size={13} aria-hidden="true" /> {active ? 'Exploring' : 'Explore'}
                    </Button>
                    <IconButton icon={Pencil} label={`${readOnly ? 'View' : 'Edit'} ${label}`} size={14} onClick={() => onEdit(c)} />
                    <IconButton
                      icon={Trash2}
                      label={`Disconnect and remove ${label}`}
                      size={14}
                      className="hover:bg-rose-500/10 hover:text-rose-300"
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
