import { useState } from 'react';
import { Plus, Plug } from 'lucide-react';
import { Button, StatusText, Table, THead, TableSort, Th, Tr, Td } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import { READ_ONLY_REASON } from '@/store/selectors';
import { isDeviceResult, identityText, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

const KIND_LABEL = { mqtt: 'MQTT broker', opcua: 'OPC UA server', i3x: 'i3X server' };
const kindLabel = (r) => (isDeviceResult(r) ? SCAN_PROTOCOLS.find((p) => p.id === r.protocol)?.label || r.protocol : KIND_LABEL[r.kind] || r.kind);

const ACCESSORS = {
  endpoint: (r) => `${r.host}:${r.port}`,
  kind: (r) => kindLabel(r),
  state: (r) => (r.verified ? 1 : 0)
};

function detailFor(r) {
  if (isDeviceResult(r)) return identityText(r);
  if (r.kind === 'mqtt' && r.verified) return r.anonymousAccess ? 'Anonymous access allowed' : 'Authentication required';
  if (r.kind === 'i3x') return `${r.serverName ? `${r.serverName} · ` : ''}${r.baseUrl}`;
  return '';
}

/**
 * Discovered endpoints: protocol, identity, endpoint, whether it is already known to Manifold, and the one
 * action that fits ("Add as device" for PLCs and meters, "Connect" for brokers and servers).
 */
export default function ResultsTable({ results, onConnect, onAddDevice, readOnly = false, alreadyConnected = () => false, alreadyDevice = () => false }) {
  const [sort, setSort] = useState({ key: 'endpoint', dir: 'asc' });
  const rows = sortRows(results, sort, ACCESSORS);
  const why = readOnly ? READ_ONLY_REASON : undefined;
  return (
    <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
      <Table caption="Discovered endpoints" className="min-w-[44rem]">
        <THead>
          <Th sortKey="endpoint">Endpoint</Th>
          <Th sortKey="kind">Protocol</Th>
          <Th sortKey="state">State</Th>
          <Th>Identity</Th>
          <Th srOnly align="right">Actions</Th>
        </THead>
        <tbody>
          {rows.map((r) => {
            const detail = detailFor(r);
            const device = isDeviceResult(r);
            const known = device ? alreadyDevice(r) : alreadyConnected(r);
            return (
              <Tr key={`${r.host}:${r.port}:${r.kind}`}>
                <Td header className="mono whitespace-nowrap text-xs text-fg">
                  {r.host}:{r.port}
                </Td>
                <Td className="whitespace-nowrap text-muted">{kindLabel(r)}</Td>
                <Td className="whitespace-nowrap">
                  <StatusText tone={r.verified ? 'good' : 'neutral'}>{r.verified ? (device ? 'Identified' : 'Verified') : 'Open port'}</StatusText>
                </Td>
                <Td className="max-w-[24rem] text-sm text-muted">
                  <span className="block truncate" title={detail}>
                    {detail || '—'}
                  </span>
                  {known && <span className="block text-xs text-subtle">{device ? 'A device with this host and port already exists.' : 'Already connected (see its page in the sidebar).'}</span>}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {device ? (
                    <Button size="sm" variant="secondary" onClick={() => onAddDevice(r)} disabled={readOnly} title={why} aria-label={`Add ${r.host}:${r.port} as device`}>
                      <Plus size={13} aria-hidden="true" /> {known ? 'Add another' : 'Add as device'}
                    </Button>
                  ) : known ? (
                    <StatusText tone="good" className="text-xs">
                      Already connected
                    </StatusText>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onConnect(r)} disabled={readOnly} title={why} aria-label={`Connect to ${r.host}:${r.port}`}>
                      <Plug size={13} aria-hidden="true" /> Connect
                    </Button>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableSort>
  );
}
