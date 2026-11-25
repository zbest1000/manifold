import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Plug } from 'lucide-react';
import { Button, StatusText, Badge, Table, THead, TableSort, Th, Tr, Td } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import { READ_ONLY_REASON } from '@/store/selectors';
import { isDeviceResult, identityText, endpointSortKey, SCAN_PROTOCOLS, KNOWN_PAGE, KNOWN_LABEL } from '@/lib/discoveryDevices';

const KIND_LABEL = { mqtt: 'MQTT broker', opcua: 'OPC UA server', i3x: 'i3X server' };
const TRANSPORT = { ws: 'WebSocket', tls: 'TLS' };

export const kindLabel = (r) => (isDeviceResult(r) ? SCAN_PROTOCOLS.find((p) => p.id === r.protocol)?.label || r.protocol : KIND_LABEL[r.kind] || r.kind);

const ACCESSORS = {
  endpoint: endpointSortKey,
  kind: kindLabel,
  state: (r) => (r.verified ? 1 : 0)
};

const stateOf = (r) => {
  // Unverified: an open MQTT port that did not answer CONNECT, or an OPC UA server that answered the
  // Hello but not GetEndpoints (a port that does not answer the Hello is not a result at all).
  if (!r.verified) return r.method === 'tcp-connect' ? { tone: 'neutral', text: 'Open port' } : { tone: 'warn', text: 'Not confirmed' };
  return { tone: 'good', text: isDeviceResult(r) ? 'Identified' : 'Verified' };
};

/**
 * Discovered endpoints: protocol, how sure we are, what it said it is, whether Manifold already has it
 * (the server decides: `known`) and the one action that fits.
 */
export default function ResultsTable({ results, onConnect, onAddDevice, onOpenBrokers, readOnly = false, busyKey = null }) {
  const [sort, setSort] = useState({ key: 'endpoint', dir: 'asc' });
  const rows = sortRows(results, sort, ACCESSORS);
  const why = readOnly ? READ_ONLY_REASON : undefined;
  return (
    <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
      <Table caption="Discovered endpoints" className="min-w-[46rem]">
        <THead>
          <Th sortKey="endpoint">Endpoint</Th>
          <Th sortKey="kind">Protocol</Th>
          <Th sortKey="state">State</Th>
          <Th>Identity</Th>
          <Th srOnly align="right">
            Actions
          </Th>
        </THead>
        <tbody>
          {rows.map((r) => {
            const device = isDeviceResult(r);
            const detail = identityText(r);
            const known = r.known;
            const state = stateOf(r);
            const key = `${r.host}:${r.port}`;
            const transport = r.identity?.transport && r.identity.transport !== 'tcp' ? TRANSPORT[r.identity.transport] : '';
            const needsLogin = r.kind === 'mqtt' && r.verified && r.identity?.anonymousAccess === false;
            return (
              <Tr key={`${key}:${r.kind}`} data-endpoint={key} data-kind={r.kind}>
                <Td header className="mono whitespace-nowrap text-xs text-fg">
                  {key}
                </Td>
                <Td className="whitespace-nowrap text-muted">
                  {kindLabel(r)}
                  {transport && <span className="ml-1.5 text-xs text-subtle">{transport}</span>}
                </Td>
                <Td className="whitespace-nowrap">
                  <StatusText tone={state.tone}>{state.text}</StatusText>
                </Td>
                <Td className="max-w-[26rem] text-sm text-muted">
                  <span className="block truncate" title={detail}>
                    {detail || '—'}
                  </span>
                  {known && (
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-subtle">
                      <Badge tone="good">Already added</Badge>
                      <Link to={KNOWN_PAGE[known.kind] || '/'} className="truncate underline-offset-2 hover:underline">
                        {KNOWN_LABEL[known.kind] || known.kind}: {known.name}
                      </Link>
                    </span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {device ? (
                    <Button size="sm" variant="secondary" onClick={() => onAddDevice(r)} disabled={readOnly} title={why} aria-label={`Add ${key} as device${known ? ' again' : ''}`}>
                      <Plus size={13} aria-hidden="true" /> {known ? 'Add another' : 'Add as device'}
                    </Button>
                  ) : known ? (
                    <StatusText tone="good" className="text-xs">
                      Already added
                    </StatusText>
                  ) : needsLogin ? (
                    <Button size="sm" variant="secondary" onClick={onOpenBrokers} title="This broker needs a username and password; add it on the Brokers page" aria-label={`Add broker ${key} on the Brokers page`}>
                      <Plug size={13} aria-hidden="true" /> Add on Brokers page
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onConnect(r)} disabled={readOnly} loading={busyKey === key} title={why} aria-label={connectLabel(r, key)}>
                      <Plug size={13} aria-hidden="true" /> {connectText(r)}
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

const connectText = (r) => (r.kind === 'mqtt' ? 'Add broker' : r.kind === 'opcua' ? 'Add OPC UA connection' : 'Connect');
const connectLabel = (r, key) => (r.kind === 'mqtt' ? `Add broker ${key}` : r.kind === 'opcua' ? `Add OPC UA connection ${key}` : `Connect i3X ${key}`);
