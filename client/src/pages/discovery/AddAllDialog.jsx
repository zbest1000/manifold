import { useCallback, useEffect, useState } from 'react';
import { Dialog, Button, Input, Checkbox, Banner, Table, THead, Th, Tr, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { bulkCreateDevices } from '@/pages/devices/devicesApi';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import RowStatus, { runSummary } from '@/pages/devices/RowStatus';
import { blankDevice, toPayload } from '@/pages/devices/model';
import { isDeviceResult, draftFromResult, SCAN_PROTOCOLS } from '@/lib/discoveryDevices';

const typeOf = (r) => (isDeviceResult(r) ? 'device' : r.kind);
const TYPE_LABEL = { device: 'device', mqtt: 'broker', opcua: 'OPC UA connection' };

/** The results the review list offers: devices, brokers and OPC UA servers (i3X is connected one at a time). */
export const addableResults = (results) => (results || []).filter((r) => isDeviceResult(r) || r.kind === 'mqtt' || r.kind === 'opcua');

/**
 * Review list for "Add all". Nothing is created until the user confirms. Everything the server already
 * knows (`known`) starts unticked and cannot be ticked; an open port that never answered its protocol starts
 * unticked too. Devices are created in one all-or-nothing request that the server validates completely
 * before it stores anything; brokers and OPC UA connections are added one by one, each reporting its own result.
 */
export default function AddAllDialog({ results, onClose, onCreated }) {
  const [info, setInfo] = useState(null); // { protocols }
  const [loadError, setLoadError] = useState('');
  const [rows, setRows] = useState(() =>
    addableResults(results).map((r, i) => ({ id: i, r, type: typeOf(r), name: isDeviceResult(r) ? draftFromResult(r).name : `${r.host}:${r.port}` }))
  );
  const [outcome, setOutcome] = useState({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [failure, setFailure] = useState('');
  const readOnly = useReadOnly();
  const needsDevices = rows.some((r) => r.type === 'device');

  const load = useCallback(
    () =>
      api
        .devices()
        .then((r) => {
          setInfo({ protocols: r.protocols || [] });
          setLoadError('');
        })
        .catch((e) => setLoadError(e.message || 'Could not load the device drivers')),
    []
  );
  useEffect(() => {
    if (needsDevices) load();
  }, [load, needsDevices]);
  const drivers = needsDevices ? info : { protocols: [] };

  const isKnown = (row) => Boolean(row.r.known);
  const isOn = (row) => !isKnown(row) && (row.on ?? row.r.verified !== false);
  const chosen = rows.filter((row) => isOn(row) && outcome[row.id]?.status !== 'created');
  const label = (id) => SCAN_PROTOCOLS.find((p) => p.id === id)?.label || id;
  const patch = (id, p) => setRows((rs) => rs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const run = async () => {
    if (running || chosen.length === 0) return;
    setRunning(true);
    setFinished(false);
    setFailure('');
    const next = {};
    const problems = [];

    // Devices: one all-or-nothing request.
    const devices = chosen.filter((row) => row.type === 'device');
    if (devices.length) {
      const payloads = [];
      const todo = [];
      for (const row of devices) {
        const draft = draftFromResult(row.r);
        const descriptor = drivers.protocols.find((p) => p.id === draft.protocol);
        if (!descriptor) next[row.id] = { status: 'error', message: `the server has no ${draft.protocol} driver` };
        else {
          todo.push(row);
          payloads.push(toPayload({ ...blankDevice(descriptor), ...draft, name: row.name.trim() || draft.name }, descriptor));
        }
      }
      if (Object.keys(next).length) {
        problems.push('Some devices cannot be created. Untick them and try again.');
      } else {
        setOutcome({ ...next, ...Object.fromEntries(todo.map((row) => [row.id, { status: 'running' }])) });
        try {
          const saved = await bulkCreateDevices(payloads);
          todo.forEach((row, i) => {
            next[row.id] = { status: 'created', message: saved.created?.[i]?.name || row.name };
          });
        } catch (err) {
          const rejected = new Map((err.rows || []).map((x) => [x.index, x]));
          todo.forEach((row, i) => {
            const x = rejected.get(i);
            next[row.id] = x ? { status: 'error', message: x.error } : { status: 'ready', message: 'valid, but not created because another row was rejected' };
          });
          problems.push(rejected.size ? `${rejected.size} device row${rejected.size === 1 ? ' was' : 's were'} rejected. Rename or untick ${rejected.size === 1 ? 'it' : 'them'} and try again.` : err.message);
        }
      }
    }

    // Brokers and OPC UA servers: one by one.
    for (const row of chosen.filter((x) => x.type !== 'device')) {
      setOutcome({ ...next, [row.id]: { status: 'running' } });
      try {
        if (row.type === 'mqtt') {
          await api.connectBroker({ host: row.r.host, port: row.r.port, protocol: row.r.identity?.transport === 'tls' || row.r.port === 8883 ? 'mqtts' : 'mqtt' });
        } else {
          await api.connectOpcua({ endpointUrl: row.r.endpointUrl || `opc.tcp://${row.r.host}:${row.r.port}` });
        }
        next[row.id] = { status: 'created', message: 'connecting' };
      } catch (e) {
        next[row.id] = { status: 'error', message: e.message };
        problems.push(`${row.r.host}:${row.r.port}: ${e.message}`);
      }
    }

    setOutcome(next);
    setFailure(problems.join(' '));
    setRunning(false);
    setFinished(true);
    if (Object.values(next).some((x) => x.status === 'created')) onCreated();
  };

  const summary = runSummary(rows.filter((row) => outcome[row.id]).map((row) => outcome[row.id].status));
  const total = rows.length;
  const hasProblem = Boolean(failure);
  return (
    <Dialog
      title={`Add ${total} discovered endpoint${total === 1 ? '' : 's'}`}
      description="Review the list. Nothing is created until you press the button. Devices are added without tags: open one afterwards to test the connection and add tags."
      size="xl"
      onClose={running ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={onClose} disabled={running}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
          <span title={readOnly ? READ_ONLY_REASON : undefined}>
            <Button onClick={run} loading={running} disabled={!drivers || chosen.length === 0 || readOnly}>
              Add {chosen.length} selected
            </Button>
          </span>
        </>
      }
    >
      <div className="space-y-3">
        {loadError && (
          <Banner variant="error" title="Could not load the device drivers" onRetry={load}>
            {loadError}
          </Banner>
        )}
        <Table caption="Discovered endpoints to add" className="min-w-[42rem]">
          <THead>
            <Th srOnly>Add</Th>
            <Th>Name</Th>
            <Th>Kind</Th>
            <Th>Host:port</Th>
            <Th>Result</Th>
          </THead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.id} className="align-top">
                <Td className="w-10">
                  <Checkbox
                    label={<span className="sr-only">{`Add ${row.r.host}:${row.r.port}`}</span>}
                    checked={isOn(row)}
                    disabled={running || isKnown(row) || outcome[row.id]?.status === 'created'}
                    onChange={(on) => patch(row.id, { on })}
                  />
                </Td>
                <Td className="py-1.5">
                  {row.type === 'device' ? (
                    <Input aria-label={`Name for ${row.r.host}:${row.r.port}`} value={row.name} disabled={running} onChange={(e) => patch(row.id, { name: e.target.value })} />
                  ) : (
                    <span className="text-sm text-muted">{row.name}</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-muted">{row.type === 'device' ? label(row.r.protocol) : TYPE_LABEL[row.type]}</Td>
                <Td className="mono whitespace-nowrap text-xs text-fg">
                  {row.r.host}:{row.r.port}
                </Td>
                <Td>
                  {outcome[row.id] ? (
                    <RowStatus status={outcome[row.id].status} message={outcome[row.id].message} />
                  ) : isKnown(row) ? (
                    <span className="text-sm text-warn">Already added ({row.r.known.name})</span>
                  ) : (
                    <span className="text-sm text-subtle">{isOn(row) ? 'Will be added' : row.r.verified === false ? 'Skipped: the port did not answer its protocol' : 'Skipped'}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {finished &&
          (hasProblem ? (
            <Banner variant="warn" title={summary.created ? `Added ${summary.created}, with problems` : 'Nothing was added'}>
              {failure}
            </Banner>
          ) : (
            <Banner variant="success" title={`Added ${summary.created} endpoint${summary.created === 1 ? '' : 's'}`} />
          ))}
      </div>
    </Dialog>
  );
}
