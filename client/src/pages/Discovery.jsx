import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useStore } from '@/store/store';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import ReadOnlyNote from '@/components/ReadOnlyNote';
import { api } from '@/lib/api';
import { Panel, Button, Input, Field, EmptyState, PageBody, Banner, Code, SegmentedControl } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ScanOptions, { advancedProblems } from './discovery/ScanOptions';
import OtNotice from './discovery/OtNotice';
import ScanProgress from './discovery/ScanProgress';
import ResultsTable from './discovery/ResultsTable';
import AddAllDialog, { addableResults } from './discovery/AddAllDialog';
import { discoveryDefaults, scanState, startScan, stopScan, usePlan, usePersistentFlag } from './discovery/discoveryApi';
import { buildScanRequest, draftFromResult, isDeviceResult, rangeProblem, formatDuration, groupOf, RESULT_GROUPS, SCAN_KINDS, DEVICE_KIND_IDS } from '@/lib/discoveryDevices';

const OT_ACK_KEY = 'manifold.discovery.otAcknowledged';
const FALLBACK_BOUNDS = { concurrency: [1, 512], perHost: [1, 16], timeoutMs: [100, 10000], identifyTimeoutMs: [500, 15000] };
const initialKinds = () => Object.fromEntries(SCAN_KINDS.map((k) => [k.id, Boolean(k.on)]));

/** Put what the server remembers about the last scan into the store (also after a page reload). */
function adoptState(s) {
  const { setDiscovery } = useStore.getState();
  const scan = s.scan;
  setDiscovery({
    scanning: Boolean(s.scanning),
    results: s.results || [],
    scan: scan || null,
    progress: scan ? { scanId: scan.id, completed: scan.completed, total: scan.totalProbes, found: scan.found, etaMs: undefined } : null
  });
}

/**
 * Discovery: choose what to look for and where, see what the scan would do before it starts, watch it run,
 * and add what it found. The scan itself runs on the server (services/discovery.js); this page asks the
 * server's own planner for the numbers it shows and never guesses.
 */
export default function Discovery() {
  const discovery = useStore((s) => s.discovery);
  const readOnly = useReadOnly();
  const ro = readOnly ? { disabled: true, title: READ_ONLY_REASON } : {};
  const navigate = useNavigate();
  const [defaults, setDefaults] = useState(null);
  const [range, setRange] = useState('');
  const [kinds, setKinds] = useState(initialKinds);
  const [ports, setPorts] = useState({});
  const [mqttWs, setMqttWs] = useState('');
  const [advanced, setAdvanced] = useState({});
  const [otAck, setOtAck] = usePersistentFlag(OT_ACK_KEY, false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [startError, setStartError] = useState(null);
  const [group, setGroup] = useState('all');
  const [addAll, setAddAll] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const { progress, results, scanning, scan } = discovery;

  // What the server remembers: the defaults and the last scan (running or finished), also after a reload.
  useEffect(() => {
    let alive = true;
    discoveryDefaults().then((d) => alive && setDefaults(d), () => {});
    scanState().then((s) => alive && adoptState(s), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const refresh = useCallback(() => scanState().then(adoptState, () => {}), []);

  const bounds = defaults?.bounds || FALLBACK_BOUNDS;
  const problems = advancedProblems({ ports, mqttWs, advanced, bounds });
  const rangeError = rangeProblem(range);
  const anyKind = SCAN_KINDS.some((k) => kinds[k.id]);
  const devicesOn = DEVICE_KIND_IDS.some((id) => kinds[id]);
  const request = useMemo(() => buildScanRequest({ range, kinds, ports, mqttWs, advanced }), [range, kinds, ports, mqttWs, advanced]);
  const formOk = !rangeError && Object.keys(problems).length === 0 && anyKind;
  const { plan, error: planError } = usePlan(request, { enabled: formOk && !scanning });
  const refused = formOk && planError && ['RANGE_REFUSED', 'RANGE_TOO_LARGE', 'RANGE_INVALID', 'OPTION_INVALID'].includes(planError.code);
  const needsAck = devicesOn && !otAck;

  const start = async () => {
    if (readOnly || busy || scanning || !formOk || needsAck) return;
    setBusy(true);
    setStartError(null);
    try {
      await startScan(request);
      setGroup('all');
    } catch (e) {
      setStartError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      await stopScan();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setCancelling(false);
    }
  };

  const connectResult = async (r) => {
    const key = `${r.host}:${r.port}`;
    setBusyKey(key);
    try {
      if (r.kind === 'mqtt') {
        await api.connectBroker({ host: r.host, port: r.port, protocol: r.identity?.transport === 'tls' || r.port === 8883 ? 'mqtts' : 'mqtt' });
        toast.success(`Adding broker ${key}`);
      } else if (r.kind === 'opcua') {
        await api.connectOpcua({ endpointUrl: r.endpointUrl || `opc.tcp://${r.host}:${r.port}` });
        toast.success(`Adding OPC UA connection ${key}`);
      } else if (r.kind === 'i3x') {
        await api.i3xConnect({ baseUrl: r.baseUrl });
        toast.success(`Connected to i3X at ${r.baseUrl}`);
        navigate('/i3x');
        return;
      }
      await refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyKey(null);
    }
  };

  // The Devices page opens its device form prefilled; nothing is created here.
  const addDevice = (r) => navigate('/devices', { state: { draft: draftFromResult(r) } });

  const byGroup = group === 'all' ? results : results.filter((r) => groupOf(r) === group);
  const counts = useMemo(() => {
    const c = { all: results.length };
    for (const r of results) c[groupOf(r)] = (c[groupOf(r)] || 0) + 1;
    return c;
  }, [results]);
  const groupOptions = RESULT_GROUPS.filter((g) => g.id === 'all' || counts[g.id]).map((g) => ({ value: g.id, label: `${g.label} ${counts[g.id] || 0}` }));
  const addable = addableResults(results).filter((r) => !r.known && r.verified !== false);

  const status = scan?.status;
  const total = scan?.totalProbes ?? progress?.total ?? 0;
  const pct = total ? Math.round(((scan?.completed ?? progress?.completed ?? 0) / total) * 100) : 0;
  const finished = !scanning && Boolean(scan) && status !== 'running';
  const subtitle = scanning
    ? `Scanning ${scan?.range || ''}: ${pct}% done, ${progress?.found || 0} found`
    : finished
      ? `Last scan of ${scan.range}: ${results.length} found${status === 'cancelled' ? ` (cancelled at ${pct}%)` : status === 'error' ? ' (failed)' : ''}`
      : 'Find MQTT brokers, OPC UA servers, i3X endpoints and, if you ask, PLCs and meters';

  const allowedText = defaults
    ? ['public addresses', defaults.policy?.private && 'private LAN ranges', defaults.policy?.loopback && 'this machine (127.0.0.0/8)'].filter(Boolean).join(', ')
    : '';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Discovery"
        subtitle={subtitle}
        actions={
          scanning ? null : (
            <Button onClick={start} loading={busy} disabled={readOnly || !formOk || needsAck || Boolean(refused)} title={readOnly ? READ_ONLY_REASON : needsAck ? 'Confirm the OT-network notice first' : undefined}>
              Start scan
            </Button>
          )
        }
      />

      <PageBody>
        <ReadOnlyNote className="" />

        <Panel title="Scan options">
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Range: CIDR, IP address or hostname" className="w-full max-w-sm" error={rangeError}>
                  <Input
                    className="mono"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && start()}
                    placeholder={defaults?.localSubnet || '192.168.1.0/24'}
                    aria-invalid={rangeError ? true : undefined}
                    disabled={scanning}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                {defaults?.localSubnet && (
                  <Button variant="secondary" onClick={() => setRange(defaults.localSubnet)} disabled={scanning} aria-label={`Use this subnet, ${defaults.localSubnet}`}>
                    This subnet <span className="mono ml-1 text-xs text-subtle">{defaults.localSubnet}</span>
                  </Button>
                )}
              </div>
              <p className="helper">
                Blank scans the server's own subnet{defaults?.localSubnet ? ` (${defaults.localSubnet})` : ''}.{allowedText ? ` This server may scan: ${allowedText}.` : ''}
              </p>
              <div aria-live="polite" className="text-sm text-muted" data-testid="scan-plan">
                {formOk && plan && !scanning && (
                  <>
                    <span className="text-fg">
                      {plan.hosts.toLocaleString()} host{plan.hosts === 1 ? '' : 's'}, {plan.ports.length} port{plan.ports.length === 1 ? '' : 's'}, {plan.totalProbes.toLocaleString()} probes.
                    </span>{' '}
                    Usually about {formatDuration(plan.estimate.typicalMs)}; at most about {formatDuration(plan.estimate.worstCaseMs)} if nothing answers, plus up to {formatDuration(plan.estimate.perOpenPortMs)} for each open port that never replies.
                    {plan.notes?.map((n) => (
                      <span key={n} className="block text-xs text-subtle">
                        {n}
                      </span>
                    ))}
                  </>
                )}
                {!anyKind && <span className="text-warn">Tick at least one protocol to look for.</span>}
              </div>
            </div>

            <ScanOptions
              kinds={kinds}
              onKinds={setKinds}
              ports={ports}
              onPorts={setPorts}
              mqttWs={mqttWs}
              onMqttWs={setMqttWs}
              advanced={advanced}
              onAdvanced={setAdvanced}
              defaults={defaults?.defaults}
              problems={problems}
              disabled={scanning}
            />
          </div>
        </Panel>

        {devicesOn && <OtNotice acknowledged={otAck} onAcknowledge={() => setOtAck(true)} disabled={readOnly} />}

        {refused && (
          <Banner variant="warn" title={planError.code === 'RANGE_REFUSED' ? 'This server will not scan that range' : planError.code === 'RANGE_TOO_LARGE' ? 'That range is too large for one scan' : 'The scan cannot start'}>
            <p>{planError.message}</p>
            {planError.flag && (
              <p className="mt-1">
                Setting needed: <Code>{planError.flag}=1</Code>
              </p>
            )}
          </Banner>
        )}
        {startError && (
          <Banner variant="error" title={startError.code === 'SCAN_RUNNING' ? 'A scan is already running' : 'The scan did not start'} onDismiss={() => setStartError(null)}>
            {startError.message}
            {startError.flag && (
              <span className="mt-1 block">
                Setting needed: <Code>{startError.flag}=1</Code>
              </span>
            )}
          </Banner>
        )}

        {scanning && <ScanProgress progress={progress} range={scan?.range || progress?.range} onCancel={cancel} cancelling={cancelling} readOnlyProps={ro} />}

        {finished && status === 'cancelled' && (
          <Banner variant="info" title="Scan cancelled">
            It stopped at {pct}% ({(scan.completed ?? 0).toLocaleString()} of {total.toLocaleString()} probes). {results.length} endpoint{results.length === 1 ? ' was' : 's were'} found before it stopped; no connection is left open.
          </Banner>
        )}
        {finished && status === 'error' && (
          <Banner variant="error" title="The scan failed" onRetry={start}>
            {scan.error || 'The server reported an error while scanning.'}
          </Banner>
        )}

        <section aria-labelledby="discovery-results" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="discovery-results" className="flex items-baseline gap-2 text-sm font-medium text-fg">
              Results {results.length > 0 && <span className="font-mono text-xs font-normal text-subtle">{results.length}</span>}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {groupOptions.length > 2 && <SegmentedControl label="Filter results by protocol" size="sm" options={groupOptions} value={group} onChange={setGroup} />}
              {addable.length > 1 && (
                <Button size="sm" variant="secondary" onClick={() => setAddAll(true)} {...ro}>
                  Add all {addable.length} new…
                </Button>
              )}
            </div>
          </div>
          {results.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel">
              <EmptyState
                title={scanning ? 'Probing hosts…' : finished ? 'Nothing found' : 'No scan yet'}
                hint={
                  scanning
                    ? 'Results appear here as hosts answer.'
                    : finished
                      ? `No endpoint answered in ${scan.range}. Check the range and the ports in Advanced options${devicesOn ? '' : ', or tick a PLC protocol to look for devices too'}.`
                      : 'Choose a range and press Start scan. Ticking Modbus, S7 or EtherNet/IP also looks for PLCs and meters.'
                }
              />
            </div>
          ) : (
            <ResultsTable results={byGroup} onConnect={connectResult} onAddDevice={addDevice} onOpenBrokers={() => navigate('/brokers')} readOnly={readOnly} busyKey={busyKey} />
          )}
          {results.some(isDeviceResult) && (
            <p className="helper">
              "Add as device" opens the device form with the address filled in; nothing is created until you save it.
            </p>
          )}
        </section>
      </PageBody>
      {addAll && <AddAllDialog results={results} onClose={() => setAddAll(false)} onCreated={refresh} />}
    </div>
  );
}
