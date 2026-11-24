import { useState } from 'react';
import { Radio, Cpu, Plug, Boxes, HardDrive, Plus } from 'lucide-react';
import { Button, Badge, Table, THead, TableSort, Th, Tr, Td } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import { READ_ONLY_REASON } from '@/store/selectors';
import { isDeviceResult, identityText, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

const KIND_META = {
  mqtt: { icon: Radio, cls: 'bg-sky-500/20 text-sky-300', label: 'MQTT broker' },
  opcua: { icon: Cpu, cls: 'bg-violet-500/20 text-violet-300', label: 'OPC UA server' },
  i3x: { icon: Boxes, cls: 'bg-teal-500/20 text-teal-300', label: 'i3X server' },
  device: { icon: HardDrive, cls: 'bg-amber-500/20 text-amber-300', label: 'Device' }
};
const metaFor = (r) => (isDeviceResult(r) ? KIND_META.device : KIND_META[r.kind] || KIND_META.mqtt);
const protocolLabel = (r) => SCAN_PROTOCOLS.find((p) => p.id === r.protocol)?.label || r.protocol;

const ACCESSORS = {
  endpoint: (r) => `${r.host}:${r.port}`,
  kind: (r) => (isDeviceResult(r) ? protocolLabel(r) : r.kind),
  verified: (r) => Boolean(r.verified)
};

function detailFor(r) {
  if (isDeviceResult(r)) return identityText(r);
  if (r.kind === 'mqtt' && r.verified) return r.anonymousAccess ? 'Anonymous access allowed' : 'Authentication required';
  if (r.kind === 'i3x') return `${r.serverName ? `${r.serverName} · ` : ''}${r.baseUrl}`;
  return '';
}

/** Discovered endpoints: brokers, OPC UA, i3X and identified devices (protocol badge, identity, Add as device). */
export default function ResultsTable({ results, onConnect, onAddDevice, readOnly = false, alreadyConnected = () => false }) {
  const [sort, setSort] = useState({ key: 'endpoint', dir: 'asc' });
  const rows = sortRows(results, sort, ACCESSORS);
  return (
    <TableSort sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))}>
      <Table caption="Discovered endpoints">
        <THead>
          <Th sortKey="endpoint">Endpoint</Th>
          <Th sortKey="kind">Type</Th>
          <Th sortKey="verified">Status</Th>
          <Th>Details</Th>
          <Th srOnly align="right">Actions</Th>
        </THead>
        <tbody>
          {rows.map((r) => {
            const meta = metaFor(r);
            const Icon = meta.icon;
            const detail = detailFor(r);
            const device = isDeviceResult(r);
            return (
              <Tr key={`${r.host}:${r.port}:${r.kind}`}>
                <Td header>
                  <span className="flex items-center gap-3">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.cls}`}>
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="mono text-slate-100">{r.host}:{r.port}</span>
                  </span>
                </Td>
                <Td className="text-xs text-muted">
                  {device ? <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-medium text-slate-200">{protocolLabel(r)}</span> : meta.label}
                </Td>
                <Td>{r.verified ? <Badge status="connected">{device ? 'identified' : 'verified'}</Badge> : <Badge>open port</Badge>}</Td>
                <Td className="max-w-[22rem] text-xs text-muted">{detail || '—'}</Td>
                <Td align="right">
                  {device ? (
                    <Button size="sm" variant="subtle" onClick={() => onAddDevice(r)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} aria-label={`Add ${r.host}:${r.port} as device`}>
                      <Plus size={13} aria-hidden="true" /> Add as device
                    </Button>
                  ) : alreadyConnected(r) ? (
                    <span title="This endpoint is already connected (see its page in the sidebar)"><Badge status="connected">already connected</Badge></span>
                  ) : (
                    <Button size="sm" variant="subtle" onClick={() => onConnect(r)} disabled={readOnly} title={readOnly ? READ_ONLY_REASON : undefined} aria-label={`Connect to ${r.host}:${r.port}`}>
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
