import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Play, Square, Radio, Cpu, Plug, Boxes } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Badge, Input, Field, EmptyState, PageBody, Table, THead, TableSort, Th, Tr, Td } from '@/components/ui';
import { nextSort, sortRows } from '@/lib/sortRows';
import PageHeader from '@/components/PageHeader';

const KIND_META = {
  mqtt: { icon: Radio, cls: 'bg-sky-500/20 text-sky-300', label: 'MQTT broker' },
  opcua: { icon: Cpu, cls: 'bg-violet-500/20 text-violet-300', label: 'OPC UA server' },
  i3x: { icon: Boxes, cls: 'bg-teal-500/20 text-teal-300', label: 'i3X server' }
};

const ACCESSORS = {
  endpoint: (r) => `${r.host}:${r.port}`,
  kind: (r) => r.kind,
  verified: (r) => Boolean(r.verified)
};

function detailFor(r) {
  if (r.kind === 'mqtt' && r.verified) return r.anonymousAccess ? 'Anonymous access allowed' : 'Authentication required';
  if (r.kind === 'i3x') return `${r.serverName ? `${r.serverName} · ` : ''}${r.baseUrl}`;
  return '';
}

export default function Discovery() {
  const discovery = useStore((s) => s.discovery);
  const navigate = useNavigate();
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState({ key: 'endpoint', dir: 'asc' });

  const start = async () => {
    setBusy(true);
    try {
      await api.startDiscovery(range ? { range } : {});
      toast.success('Scan started');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await api.stopDiscovery();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const connectResult = async (r) => {
    try {
      if (r.kind === 'mqtt') {
        await api.connectBroker({ host: r.host, port: r.port, protocol: r.port === 8883 ? 'mqtts' : 'mqtt' });
        toast.success(`Connecting to ${r.host}:${r.port}`);
      } else if (r.kind === 'opcua') {
        await api.connectOpcua({ endpointUrl: r.endpointUrl || `opc.tcp://${r.host}:${r.port}` });
        toast.success(`Connecting to ${r.host}:${r.port}`);
      } else if (r.kind === 'i3x') {
        await api.i3xConnect({ baseUrl: r.baseUrl });
        toast.success(`Connected to i3X at ${r.baseUrl}`);
        navigate('/i3x');
      }
    } catch (e) {
      toast.error(e.message);
    }
  };

  const { progress, results, scanning } = discovery;
  const pct = progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const rows = sortRows(results, sort, ACCESSORS);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Network Discovery"
        subtitle="Probe your network for MQTT brokers, OPC UA servers, and i3X endpoints"
        actions={
          scanning ? (
            <Button variant="danger" onClick={stop}>
              <Square size={15} aria-hidden="true" /> Stop scan
            </Button>
          ) : (
            <Button onClick={start} disabled={busy}>
              <Play size={15} aria-hidden="true" /> Start scan
            </Button>
          )
        }
      />

      <PageBody>
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="CIDR range (blank = auto-detect local subnet)" className="min-w-0 flex-1 basis-64">
              <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder="192.168.1.0/24" disabled={scanning} />
            </Field>
            {!scanning && (
              <Button onClick={start} disabled={busy}>
                <Radar size={15} aria-hidden="true" /> Scan
              </Button>
            )}
          </div>

          {scanning && (
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-muted" aria-live="polite">
                <span>Scanning… {progress?.found || 0} found</span>
                <span>{pct}%</span>
              </div>
              <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-accent-400 to-accent-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </Card>

        <section aria-labelledby="discovery-results">
          <h2 id="discovery-results" className="mb-3 text-sm font-semibold text-slate-200">
            Results {results.length > 0 && <span className="text-muted">({results.length})</span>}
          </h2>
          {results.length === 0 ? (
            <Card>
              <EmptyState
                icon={Radar}
                title={scanning ? 'Probing hosts…' : 'Nothing found yet'}
                hint={scanning ? 'Results appear here as hosts answer.' : 'Scan your local network (or a CIDR range) for MQTT brokers, OPC UA servers and i3X endpoints, then connect to them in one click.'}
                action={
                  !scanning && (
                    <Button onClick={start} disabled={busy}>
                      <Play size={15} aria-hidden="true" /> Start a network scan
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
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
                    const meta = KIND_META[r.kind] || KIND_META.mqtt;
                    const Icon = meta.icon;
                    const detail = detailFor(r);
                    return (
                      <Tr key={`${r.host}:${r.port}`}>
                        <Td header>
                          <span className="flex items-center gap-3">
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.cls}`}>
                              <Icon size={16} aria-hidden="true" />
                            </span>
                            <span className="mono text-slate-100">
                              {r.host}:{r.port}
                            </span>
                          </span>
                        </Td>
                        <Td className="text-xs text-muted">{meta.label}</Td>
                        <Td>{r.verified ? <Badge status="connected">verified</Badge> : <Badge>open port</Badge>}</Td>
                        <Td className="max-w-[18rem] truncate text-xs text-muted">{detail || '—'}</Td>
                        <Td align="right">
                          <Button size="sm" variant="subtle" onClick={() => connectResult(r)} aria-label={`Connect to ${r.host}:${r.port}`}>
                            <Plug size={13} aria-hidden="true" /> Connect
                          </Button>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableSort>
          )}
        </section>
      </PageBody>
    </div>
  );
}
