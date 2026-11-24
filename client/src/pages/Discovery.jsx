import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Panel, Button, Input, Field, EmptyState, PageBody, Banner } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ScanOptions from './discovery/ScanOptions';
import OtNotice from './discovery/OtNotice';
import ResultsTable from './discovery/ResultsTable';
import AddAllDialog from './discovery/AddAllDialog';
import { startDiscoveryScan } from './devices/devicesApi';
import { isAlreadyConnected, buildScanOptions, draftFromResult, draftsFromResults, parsePorts, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

/**
 * Discovery: one primary action (Start scan), the scan options as a compact form, the OT-network
 * warning as a banner when devices are ticked, and the results as a table.
 */
export default function Discovery() {
  const discovery = useStore((s) => s.discovery);
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const readOnly = useReadOnly();
  const ro = readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};
  const navigate = useNavigate();
  const [range, setRange] = useState('');
  const [devicePorts, setDevicePorts] = useState({}); // protocol id -> ports text (absent = not scanned)
  const [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [addAll, setAddAll] = useState(false);
  const { progress, results, scanning } = discovery;

  // The devices Manifold already has, so a found PLC at a known address says so. Reloaded when a scan ends.
  const { data: deviceList } = usePolled(() => api.devices(), { deps: [scanning] });
  const knownDevices = useMemo(() => new Set((deviceList?.devices || []).map((d) => `${d.host}:${d.port}`)), [deviceList]);

  const portProblems = SCAN_PROTOCOLS.some((p) => devicePorts[p.id] !== undefined && parsePorts(devicePorts[p.id]).bad.length > 0);
  const findDevices = Object.keys(devicePorts).length > 0;

  const start = async () => {
    if (readOnly || busy || scanning) return;
    if (portProblems) return setScanError('Fix the port lists below first.');
    setBusy(true);
    setScanError('');
    try {
      await startDiscoveryScan(buildScanOptions({ range, selected: devicePorts }));
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

  // A found endpoint that is already connected must not be connected a second time (the server would
  // happily open a duplicate connection and the lists would then show the same broker twice).
  const alreadyConnected = (r) => isAlreadyConnected(r, { brokers, opcua });
  const alreadyDevice = (r) => knownDevices.has(`${r.host}:${r.port}`);

  const pct = progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const drafts = useMemo(() => draftsFromResults(results), [results]);
  const scanned = Boolean(progress) || results.length > 0;

  const subtitle = scanning
    ? `Scanning${progress?.range ? ` ${progress.range}` : ''}: ${pct}% done, ${progress?.found || 0} found`
    : scanned
      ? `Last scan found ${results.length} endpoint${results.length === 1 ? '' : 's'}`
      : 'Find MQTT brokers, OPC UA servers, i3X endpoints and, if you ask, PLCs and meters';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Discovery"
        subtitle={subtitle}
        actions={
          scanning ? (
            <Button variant="secondary" onClick={stop} {...ro}>
              Stop scan
            </Button>
          ) : (
            <Button onClick={start} loading={busy} disabled={readOnly} title={ro.title}>
              Start scan
            </Button>
          )
        }
      />

      <PageBody>
        <ReadOnlyNote className="" />

        <Panel title="Scan options">
          <div className="space-y-4">
            <Field label="Range (CIDR)" help="Leave blank to scan the local subnet." className="max-w-sm">
              <Input className="mono" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && start()} placeholder="192.168.1.0/24" disabled={scanning} />
            </Field>
            <ScanOptions value={devicePorts} onChange={setDevicePorts} disabled={scanning} />
            {!findDevices && <p className="helper">PLC and meter probing is off. Tick a protocol to include it; you will see what it sends before you scan.</p>}
          </div>
        </Panel>

        {findDevices && <OtNotice />}
        {scanError && (
          <Banner variant="error" title="The scan did not start" onRetry={start} onDismiss={() => setScanError('')}>
            {scanError}
          </Banner>
        )}

        {scanning && (
          <div aria-live="polite">
            <div className="mb-1.5 flex justify-between text-xs text-muted">
              <span>Scanning… {progress?.found || 0} found</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <section aria-labelledby="discovery-results" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="discovery-results" className="flex items-baseline gap-2 text-sm font-medium text-fg">
              Results {results.length > 0 && <span className="font-mono text-xs font-normal text-subtle">{results.length}</span>}
            </h2>
            {drafts.length > 1 && (
              <Button size="sm" variant="secondary" onClick={() => setAddAll(true)} {...ro}>
                Add all {drafts.length} devices…
              </Button>
            )}
          </div>
          {results.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel">
              <EmptyState
                title={scanning ? 'Probing hosts…' : scanned ? 'Nothing found' : 'No scan yet'}
                hint={
                  scanning
                    ? 'Results appear here as hosts answer.'
                    : scanned
                      ? 'No endpoint answered. Check the range, or tick a PLC protocol above to look for devices too.'
                      : 'Start a scan to look for MQTT brokers, OPC UA servers and i3X endpoints on your network. Tick Modbus, S7 or EtherNet/IP above to find PLCs and meters as well.'
                }
              />
            </div>
          ) : (
            <ResultsTable results={results} onConnect={connectResult} onAddDevice={addDevice} readOnly={readOnly} alreadyConnected={alreadyConnected} alreadyDevice={alreadyDevice} />
          )}
        </section>
      </PageBody>
      {addAll && <AddAllDialog drafts={drafts} onClose={() => setAddAll(false)} onCreated={() => {}} />}
    </div>
  );
}
