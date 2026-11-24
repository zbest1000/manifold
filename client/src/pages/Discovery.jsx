import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Play, Square, ListPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { api } from '@/lib/api';
import { Card, Button, Input, Field, EmptyState, PageBody, Banner } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ScanOptions from './discovery/ScanOptions';
import OtNotice from './discovery/OtNotice';
import ResultsTable from './discovery/ResultsTable';
import AddAllDialog from './discovery/AddAllDialog';
import { startDiscoveryScan } from './devices/devicesApi';
import { buildScanOptions, draftFromResult, draftsFromResults, parsePorts, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

export default function Discovery() {
  const discovery = useStore((s) => s.discovery);
  const navigate = useNavigate();
  const [range, setRange] = useState('');
  const [devicePorts, setDevicePorts] = useState({}); // protocol id -> ports text (absent = not scanned)
  const [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [addAll, setAddAll] = useState(false);

  const portProblems = SCAN_PROTOCOLS.some((p) => devicePorts[p.id] !== undefined && parsePorts(devicePorts[p.id]).bad.length > 0);
  const findDevices = Object.keys(devicePorts).length > 0;

  const start = async () => {
    if (portProblems) return toast.error('Fix the port lists first');
    setBusy(true);
    setScanError('');
    try {
      await startDiscoveryScan(buildScanOptions({ range, selected: devicePorts }));
      toast.success('Scan started');
    } catch (e) {
      setScanError(e.message || 'The scan could not start');
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

  // The Devices page opens its device form prefilled; nothing is created here.
  const addDevice = (r) => navigate('/devices', { state: { draft: draftFromResult(r) } });

  const { progress, results, scanning } = discovery;
  const pct = progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const drafts = useMemo(() => draftsFromResults(results), [results]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Network Discovery"
        subtitle="Probe your network for MQTT brokers, OPC UA servers, i3X endpoints and, optionally, PLCs and meters"
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
        <Card className="space-y-4 p-4 sm:p-5">
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

          <ScanOptions value={devicePorts} onChange={setDevicePorts} disabled={scanning} />
          {findDevices && <OtNotice />}
          {!findDevices && <p className="text-xs text-slate-500">PLC and meter probing is off. Tick a protocol to include it; you will see what it sends before you scan.</p>}

          {scanError && <Banner variant="error" title="The scan did not start" onRetry={start} onDismiss={() => setScanError('')}>{scanError}</Banner>}

          {scanning && (
            <div>
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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="discovery-results" className="text-sm font-semibold text-slate-200">
              Results {results.length > 0 && <span className="text-muted">({results.length})</span>}
            </h2>
            {drafts.length > 1 && (
              <Button size="sm" variant="outline" onClick={() => setAddAll(true)}>
                <ListPlus size={14} aria-hidden="true" /> Add all {drafts.length} devices…
              </Button>
            )}
          </div>
          {results.length === 0 ? (
            <Card>
              <EmptyState
                icon={Radar}
                title={scanning ? 'Probing hosts…' : 'Nothing found yet'}
                hint={scanning ? 'Results appear here as hosts answer.' : 'Scan your local network (or a CIDR range) for MQTT brokers, OPC UA servers, i3X endpoints and, if you tick them, Modbus, S7 and EtherNet/IP devices.'}
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
            <ResultsTable results={results} onConnect={connectResult} onAddDevice={addDevice} />
          )}
        </section>
      </PageBody>
      {addAll && <AddAllDialog drafts={drafts} onClose={() => setAddAll(false)} onCreated={() => {}} />}
    </div>
  );
}
